import type { z } from "zod";
import { FOUNDATION_COMMANDS as C } from "@garderobe/contracts";
import { all, first, json, stmt, type Stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import { normalizePhrase } from "../util.ts";
import { explainGarmentStock, type GarmentRow } from "../stock/planner.ts";
import { ownedUnits } from "../stock/replay.ts";
import type { CommandDefinition, CommandPlan } from "../commands/types.ts";
import { bumpGarment, loadGarment, nameList, quoted, simpleStockUndo, stockParts } from "./common.ts";
import { selectGarments } from "./selection.ts";
import type { CommandContext } from "../commands/types.ts";

export function define<S extends z.ZodType>(def: CommandDefinition<S>): CommandDefinition<S> {
  return def;
}

const basisFor = (authorization: string) => (authorization === "data_import" ? ("import" as const) : ("observed" as const));

function aliasInsert(ctx: { userId: string; now: string; newId(p: string): string }, garmentId: string, phrase: string, kind: string, aliasId?: string): Stmt {
  return stmt(
    "INSERT INTO garment_aliases (user_id, alias_id, garment_id, phrase, normalized, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ctx.userId,
    aliasId ?? ctx.newId("als"),
    garmentId,
    phrase,
    normalizePhrase(phrase),
    kind,
    ctx.now,
  );
}

export const garmentCreate = define({
  type: "garment.create",
  schema: C["garment.create"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "data_import"],
  async plan(ctx, p) {
    const garmentId = p.garmentId ?? ctx.newId("gmt");
    const row: GarmentRow = {
      garment_id: garmentId,
      version: 1,
      name: p.name,
      category: p.category,
      care_channel: p.careChannel,
      acquisition: p.acquisition,
      planning_policy: p.planningPolicy,
      merged_into: null,
      removed_reason: null,
      attributes_json: JSON.stringify(p.attributes),
    };
    const statements: Stmt[] = [
      stmt(
        `INSERT INTO garments (user_id, garment_id, version, name, category, roles_json, maker, product, fabric, colour, pattern, size, care_channel, acquisition,
                               planning_policy, planning_reason, condition, season_note, thermal_json, attributes_json, is_synthetic, wear_logging_since, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.userId,
        garmentId,
        p.name,
        p.category,
        JSON.stringify(p.roles),
        p.maker,
        p.product,
        p.fabric,
        p.colour,
        p.pattern,
        p.size,
        p.careChannel,
        p.acquisition,
        p.planningPolicy,
        p.planningReason,
        p.condition,
        p.seasonNote,
        p.thermal ? JSON.stringify(p.thermal) : null,
        JSON.stringify(p.attributes),
        p.isSynthetic,
        p.wearLoggingSince,
        ctx.now,
        ctx.now,
      ),
    ];
    const seen = new Set<string>();
    for (const a of [{ phrase: p.name, kind: "owner_name" as const }, ...p.aliases]) {
      const n = normalizePhrase(a.phrase);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      statements.push(aliasInsert(ctx, garmentId, a.phrase, a.kind));
    }
    for (const f of p.facts) {
      statements.push(
        stmt(
          "INSERT INTO garment_facts (user_id, fact_id, garment_id, attribute, value_json, source_json, scope, command_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId,
          ctx.newId("fct"),
          garmentId,
          f.attribute,
          JSON.stringify(f.value ?? null),
          JSON.stringify(f.source),
          f.scope,
          ctx.commandId,
          ctx.now,
        ),
      );
    }
    const planner = ctx.stock();
    planner.declare(row);
    const eventId = planner.add(garmentId, "receive", { quantity: p.quantity, to: p.acquisition === "incoming" ? "incoming" : p.initialBucket }, basisFor(ctx.envelope.authorization), ctx.occurredAt);
    const parts = stockParts(await planner.build());
    return {
      summary: `Added ${quoted(p.name)} (${p.quantity} ${p.acquisition === "incoming" ? "on order, not yet arrived" : "owned"})`,
      statements: [...statements, ...parts.statements],
      preconditions: [
        { label: `garment ${garmentId} does not exist yet`, sql: "NOT EXISTS (SELECT 1 FROM garments WHERE user_id = ? AND garment_id = ?)", params: [ctx.userId, garmentId], class: "state" },
      ],
      affected: [{ kind: "garment", id: garmentId, version: 1 }],
      outbox: [{ topic: "garment", entityKind: "garment", entityId: garmentId, revision: 1 }],
      result: { garmentId, quantity: p.quantity, acquisition: p.acquisition },
      changes: { availabilityChanged: [garmentId] },
      bumpWardrobe: true,
      undo: { data: { garmentId, stockEventIds: [eventId] } },
    };
  },
  async planUndo(ctx, original, data) {
    const g = await loadGarment(ctx, data.garmentId, { followMerges: false });
    const plan = await simpleStockUndo(ctx, original, data, [
      stmt("UPDATE garments SET removed_reason = 'creation undone', acquisition = 'disposed' WHERE user_id = ? AND garment_id = ?", ctx.userId, g.garment_id),
      stmt("UPDATE garment_aliases SET removed_at = ? WHERE user_id = ? AND garment_id = ? AND removed_at IS NULL", ctx.now, ctx.userId, g.garment_id),
    ]);
    plan.preconditions = [
      ...(plan.preconditions ?? []),
      { label: "no wear has been recorded for this garment", sql: "NOT EXISTS (SELECT 1 FROM wear_observations WHERE user_id = ? AND garment_id = ? AND status = 'active')", params: [ctx.userId, g.garment_id], class: "state" },
    ];
    plan.summary = `Removed ${g.name} (creation undone)`;
    return plan;
  },
});

export const garmentReceive = define({
  type: "garment.receive",
  schema: C["garment.receive"],
  class: "observation",
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const planner = ctx.stock();
    const eventId = planner.add(g.garment_id, "arrive", p.quantity ? { quantity: p.quantity } : {}, "observed", ctx.occurredAt);
    const build = await planner.build();
    const planned = build.garments.get(g.garment_id)!;
    const arrived = planned.after.state.clean - planned.before.state.clean;
    if (arrived <= 0) {
      return { outcome: "noop", summary: `${g.name}: nothing was awaiting arrival`, result: { garmentId: g.garment_id, arrived: 0 }, undo: { unavailableReason: "nothing changed" } };
    }
    const parts = stockParts(build);
    return {
      summary: `${g.name}: ${arrived} arrived and ${arrived === 1 ? "is" : "are"} now in the wardrobe`,
      ...parts,
      result: { garmentId: g.garment_id, arrived },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: [eventId] } },
    };
  },
  planUndo: (ctx, original, data) => simpleStockUndo(ctx, original, data),
});

const COLUMN_OF: Record<string, string> = {
  name: "name",
  maker: "maker",
  product: "product",
  fabric: "fabric",
  colour: "colour",
  pattern: "pattern",
  size: "size",
  condition: "condition",
  careChannel: "care_channel",
  roles: "roles_json",
  thermal: "thermal_json",
  attributes: "attributes_json",
};

/**
 * The writes that correct one garment's descriptive facts: the column update and, per changed attribute,
 * a fact that supersedes the earlier assertion without erasing why it existed. Returns no statements when
 * the garment is already as stated.
 */
function planCorrection(ctx: CommandContext, full: Record<string, any>, changes: Record<string, unknown>, source: unknown): { statements: Stmt[]; previous: Record<string, unknown>; changed: string[]; factIds: string[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  const previous: Record<string, unknown> = {};
  const statements: Stmt[] = [];
  const changed: string[] = [];
  const factIds: string[] = [];
  for (const [key, value] of Object.entries(changes)) {
    const column = COLUMN_OF[key]!;
    let stored: unknown = value;
    if (key === "roles" || key === "thermal") stored = value === null ? null : JSON.stringify(value);
    if (key === "attributes") stored = JSON.stringify({ ...json(full.attributes_json, {}), ...(value as object) });
    if (full[column] === stored) continue;
    previous[column] = full[column];
    sets.push(`${column} = ?`);
    params.push(stored);
    changed.push(key);
    const factId = ctx.newId("fct");
    factIds.push(factId);
    statements.push(stmt("UPDATE garment_facts SET superseded_by = ? WHERE user_id = ? AND garment_id = ? AND attribute = ? AND superseded_by IS NULL", factId, ctx.userId, full.garment_id, key));
    statements.push(
      stmt(
        "INSERT INTO garment_facts (user_id, fact_id, garment_id, attribute, value_json, source_json, scope, command_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
        ctx.userId,
        factId,
        full.garment_id,
        key,
        JSON.stringify({ value, previous: full[column] }),
        JSON.stringify(source),
        ctx.commandId,
        ctx.now,
      ),
    );
  }
  if (sets.length > 0) statements.unshift(stmt(`UPDATE garments SET ${sets.join(", ")} WHERE user_id = ? AND garment_id = ?`, ...params, ctx.userId, full.garment_id));
  return { statements, previous, changed, factIds };
}

/**
 * Undoing a correction withdraws the facts it asserted and makes the facts they superseded current again,
 * so the fact ledger says what the garment row says. The withdrawn facts stay on record, marked as undone.
 */
function factUndoStatements(ctx: CommandContext, factIds: string[] | undefined, aliasId?: string | null): Stmt[] {
  const out: Stmt[] = [];
  for (const factId of factIds ?? []) {
    out.push(
      stmt("UPDATE garment_facts SET superseded_by = NULL WHERE user_id = ? AND superseded_by = ?", ctx.userId, factId),
      stmt("UPDATE garment_facts SET superseded_by = ? WHERE user_id = ? AND fact_id = ? AND superseded_by IS NULL", `undone:${ctx.commandId}`, ctx.userId, factId),
    );
  }
  // The name the correction introduced is no longer the garment's name, so it stops resolving to it.
  if (aliasId) out.push(stmt("UPDATE garment_aliases SET removed_at = ? WHERE user_id = ? AND alias_id = ? AND removed_at IS NULL", ctx.now, ctx.userId, aliasId));
  return out;
}

export const garmentCorrect = define({
  type: "garment.correct",
  schema: C["garment.correct"],
  class: "observation",
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const full = (await first<Record<string, any>>(ctx.db, "SELECT * FROM garments WHERE user_id = ? AND garment_id = ?", ctx.userId, g.garment_id))!;
    const { statements, previous, changed, factIds } = planCorrection(ctx, full, p.changes, p.source);
    if (changed.length === 0) return { outcome: "noop", summary: `${g.name}: already as stated`, undo: { unavailableReason: "nothing changed" } };
    const planner = ctx.stock();
    if (p.changes.careChannel && p.changes.careChannel !== g.care_channel) planner.setCareChannel(g.garment_id, p.changes.careChannel);
    else planner.touch(g.garment_id);
    const parts = stockParts(await planner.build());
    let aliasId: string | null = null;
    if (p.changes.name && p.changes.name !== g.name) {
      // The owner's name governs what he dresses from; the earlier name stays findable as an alias.
      aliasId = ctx.newId("als");
      statements.push(aliasInsert(ctx, g.garment_id, p.changes.name, "owner_name", aliasId));
    }
    return {
      summary: `${g.name}: corrected ${changed.join(", ")}${p.changes.name !== undefined && p.changes.name !== g.name ? `; now named ${quoted(p.changes.name)}` : ""}`,
      statements: [...statements, ...parts.statements],
      preconditions: parts.preconditions,
      affected: parts.affected,
      outbox: [{ topic: "garment", entityKind: "garment", entityId: g.garment_id, revision: g.version + 1 }],
      result: { garmentId: g.garment_id, changed },
      changes: { availabilityChanged: [g.garment_id] },
      bumpWardrobe: true,
      undo: { data: { garmentId: g.garment_id, previous, versionAfter: g.version + 1, factIds, aliasId } },
    };
  },
  async planUndo(ctx, _original, data) {
    const g = await loadGarment(ctx, data.garmentId, { followMerges: false });
    const cols = Object.keys(data.previous as Record<string, unknown>);
    const planner = ctx.stock();
    if ("care_channel" in data.previous) planner.setCareChannel(g.garment_id, data.previous.care_channel);
    else planner.touch(g.garment_id);
    const parts = stockParts(await planner.build());
    return {
      summary: `${g.name}: correction undone`,
      statements: [
        stmt(`UPDATE garments SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE user_id = ? AND garment_id = ?`, ...cols.map((c) => data.previous[c]), ctx.userId, g.garment_id),
        ...factUndoStatements(ctx, data.factIds as string[] | undefined, data.aliasId as string | null | undefined),
        ...parts.statements,
      ],
      preconditions: [...parts.preconditions, { label: "garment not changed since the correction", sql: "(SELECT version FROM garments WHERE user_id = ? AND garment_id = ?) = ?", params: [ctx.userId, g.garment_id, data.versionAfter], class: "state" }],
      affected: parts.affected,
      changes: { availabilityChanged: [g.garment_id] },
      bumpWardrobe: true,
      undo: { unavailableReason: "this is already an undo" },
    };
  },
});

/** The most garments one bulk edit may change; a larger selection is refused rather than silently cut. */
export const BULK_CORRECT_LIMIT = 200;

/**
 * One correction across every garment a category or query selects (research requirement R12): a single
 * command, receipt and undo. The selection is evaluated when the command runs; `expectedCount` refuses a
 * set that differs from the one the owner saw. Garments already as stated are left untouched.
 */
export const garmentBulkCorrect = define({
  type: "garment.bulk_correct",
  schema: C["garment.bulk_correct"],
  class: "observation",
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const rows = await selectGarments(ctx.db, ctx.userId, p.selector);
    const matched = rows.map((r) => ({ garmentId: r.garment_id as string, name: r.name as string }));
    if (rows.length === 0) throw new CommandError("not_found", "no garment matches that selection; nothing was written", { selector: p.selector });
    if (p.expectedCount !== undefined && p.expectedCount !== rows.length) {
      throw new CommandError("precondition_failed", `the selection now matches ${rows.length} garment${rows.length === 1 ? "" : "s"}, not ${p.expectedCount}; nothing was written`, { expectedCount: p.expectedCount, matched });
    }
    if (rows.length > BULK_CORRECT_LIMIT) {
      throw new CommandError("precondition_failed", `the selection matches ${rows.length} garments; one bulk edit changes at most ${BULK_CORRECT_LIMIT}. Narrow the selection; nothing was written`, { matchedCount: rows.length, limit: BULK_CORRECT_LIMIT });
    }
    const planner = ctx.stock();
    const statements: Stmt[] = [];
    const undo: { garmentId: string; previous: Record<string, unknown>; factIds: string[] }[] = [];
    const changedNames: string[] = [];
    const changedKeys = new Set<string>();
    for (const full of rows) {
      const one = planCorrection(ctx, full, p.changes, p.source);
      if (one.changed.length === 0) continue;
      statements.push(...one.statements);
      undo.push({ garmentId: full.garment_id, previous: one.previous, factIds: one.factIds });
      changedNames.push(full.name);
      for (const key of one.changed) changedKeys.add(key);
      if (p.changes.careChannel && p.changes.careChannel !== full.care_channel) planner.setCareChannel(full.garment_id, p.changes.careChannel);
      else planner.touch(full.garment_id);
    }
    if (undo.length === 0) {
      return { outcome: "noop", summary: `All ${rows.length} selected garment${rows.length === 1 ? " is" : "s are"} already as stated`, result: { matchedCount: rows.length, changedGarmentIds: [], unchangedGarmentIds: matched.map((m) => m.garmentId) }, undo: { unavailableReason: "nothing changed" } };
    }
    const parts = stockParts(await planner.build());
    const versionAfter = new Map(parts.affected.map((a) => [a.id, a.version]));
    const changedIds = undo.map((u) => u.garmentId);
    return {
      summary: `Corrected ${[...changedKeys].join(", ")} on ${undo.length} of ${rows.length} selected garment${rows.length === 1 ? "" : "s"}: ${nameList(changedNames)}`,
      statements: [...statements, ...parts.statements],
      preconditions: parts.preconditions,
      affected: parts.affected,
      outbox: changedIds.map((id) => ({ topic: "garment", entityKind: "garment", entityId: id, revision: versionAfter.get(id)! })),
      result: { matchedCount: rows.length, changedGarmentIds: changedIds, unchangedGarmentIds: matched.map((m) => m.garmentId).filter((id) => !changedIds.includes(id)), changed: [...changedKeys] },
      changes: { availabilityChanged: changedIds },
      bumpWardrobe: true,
      undo: { data: { garments: undo.map((u) => ({ ...u, versionAfter: versionAfter.get(u.garmentId)! })) } },
    };
  },
  async planUndo(ctx, _original, data) {
    const garments = data.garments as { garmentId: string; previous: Record<string, unknown>; versionAfter: number }[];
    const planner = ctx.stock();
    const statements: Stmt[] = [];
    for (const g of garments) {
      const cols = Object.keys(g.previous);
      statements.push(stmt(`UPDATE garments SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE user_id = ? AND garment_id = ?`, ...cols.map((c) => g.previous[c]), ctx.userId, g.garmentId));
      statements.push(...factUndoStatements(ctx, (g as { factIds?: string[] }).factIds));
      if ("care_channel" in g.previous) planner.setCareChannel(g.garmentId, g.previous.care_channel as any);
      else planner.touch(g.garmentId);
    }
    const parts = stockParts(await planner.build());
    return {
      summary: `Bulk correction undone on ${garments.length} garment${garments.length === 1 ? "" : "s"}`,
      statements: [...statements, ...parts.statements],
      preconditions: [
        ...parts.preconditions,
        {
          label: "no selected garment changed since the bulk correction",
          sql: "(SELECT COUNT(*) FROM garments WHERE user_id = ? AND (garment_id || ':' || version) IN (SELECT j.value FROM json_each(?) AS j)) = ?",
          params: [ctx.userId, JSON.stringify(garments.map((g) => `${g.garmentId}:${g.versionAfter}`)), garments.length],
          class: "state",
        },
      ],
      affected: parts.affected,
      changes: { availabilityChanged: garments.map((g) => g.garmentId) },
      bumpWardrobe: true,
      undo: { unavailableReason: "this is already an undo" },
    };
  },
});

export const garmentAddAlias = define({
  type: "garment.add_alias",
  schema: C["garment.add_alias"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const normalized = normalizePhrase(p.phrase);
    const existing = await first(ctx.db, "SELECT 1 AS x FROM garment_aliases WHERE user_id = ? AND garment_id = ? AND normalized = ? AND removed_at IS NULL", ctx.userId, g.garment_id, normalized);
    if (existing) return { outcome: "noop", summary: `${g.name} already answers to ${quoted(p.phrase)}`, undo: { unavailableReason: "nothing changed" } };
    const b = bumpGarment(ctx, g.garment_id, g.version);
    return {
      summary: `${g.name} now also answers to ${quoted(p.phrase)}`,
      statements: [aliasInsert(ctx, g.garment_id, p.phrase, p.kind), b.statement],
      preconditions: [b.precondition],
      affected: [{ kind: "garment", id: g.garment_id, version: g.version + 1 }],
      outbox: [{ topic: "garment", entityKind: "garment", entityId: g.garment_id, revision: g.version + 1 }],
      undo: { data: { garmentId: g.garment_id, normalized } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Alias removed",
      statements: [stmt("UPDATE garment_aliases SET removed_at = ? WHERE user_id = ? AND garment_id = ? AND normalized = ? AND removed_at IS NULL", ctx.now, ctx.userId, data.garmentId, data.normalized)],
      undo: { unavailableReason: "this is already an undo" },
    };
  },
});

export const garmentRemoveAlias = define({
  type: "garment.remove_alias",
  schema: C["garment.remove_alias"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const normalized = normalizePhrase(p.phrase);
    const rows = await all<{ alias_id: string }>(ctx.db, "SELECT alias_id FROM garment_aliases WHERE user_id = ? AND garment_id = ? AND normalized = ? AND removed_at IS NULL", ctx.userId, g.garment_id, normalized);
    if (rows.length === 0) return { outcome: "noop", summary: `${g.name} had no alias ${quoted(p.phrase)}`, undo: { unavailableReason: "nothing changed" } };
    return {
      summary: `${g.name} no longer answers to ${quoted(p.phrase)}`,
      statements: rows.map((r) => stmt("UPDATE garment_aliases SET removed_at = ? WHERE user_id = ? AND alias_id = ?", ctx.now, ctx.userId, r.alias_id)),
      affected: [{ kind: "garment", id: g.garment_id, version: g.version }],
      undo: { data: { aliasIds: rows.map((r) => r.alias_id) } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Alias restored",
      statements: (data.aliasIds as string[]).map((id) => stmt("UPDATE garment_aliases SET removed_at = NULL WHERE user_id = ? AND alias_id = ?", ctx.userId, id)),
      undo: { unavailableReason: "this is already an undo" },
    };
  },
});

export const garmentSetPlanningPolicy = define({
  type: "garment.set_planning_policy",
  schema: C["garment.set_planning_policy"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const prev = await first<{ planning_policy: string; planning_reason: string | null }>(ctx.db, "SELECT planning_policy, planning_reason FROM garments WHERE user_id = ? AND garment_id = ?", ctx.userId, g.garment_id);
    if (prev!.planning_policy === p.policy && prev!.planning_reason === p.reason) return { outcome: "noop", summary: `${g.name}: planning policy already ${p.policy}`, undo: { unavailableReason: "nothing changed" } };
    const b = bumpGarment(ctx, g.garment_id, g.version);
    return {
      summary: `${g.name}: planning policy set to ${p.policy}${p.reason ? `; reason given: ${quoted(p.reason)}` : ""}`,
      statements: [stmt("UPDATE garments SET planning_policy = ?, planning_reason = ? WHERE user_id = ? AND garment_id = ?", p.policy, p.reason, ctx.userId, g.garment_id), b.statement],
      preconditions: [b.precondition],
      affected: [{ kind: "garment", id: g.garment_id, version: g.version + 1 }],
      changes: { availabilityChanged: [g.garment_id] },
      bumpWardrobe: true,
      undo: { data: { garmentId: g.garment_id, policy: prev!.planning_policy, reason: prev!.planning_reason } },
    };
  },
  async planUndo(ctx, _o, data) {
    const g = await loadGarment(ctx, data.garmentId, { followMerges: false });
    const b = bumpGarment(ctx, g.garment_id, g.version);
    return {
      summary: `${g.name}: planning policy restored to ${data.policy}`,
      statements: [stmt("UPDATE garments SET planning_policy = ?, planning_reason = ? WHERE user_id = ? AND garment_id = ?", data.policy, data.reason, ctx.userId, g.garment_id), b.statement],
      preconditions: [b.precondition],
      affected: [{ kind: "garment", id: g.garment_id, version: g.version + 1 }],
      changes: { availabilityChanged: [g.garment_id] },
      bumpWardrobe: true,
      undo: { unavailableReason: "this is already an undo" },
    };
  },
});

const PLACE: Record<string, string> = { clean: "back in the wardrobe", storage: "in storage", tailor: "at the tailor" };

export const garmentMove = define({
  type: "garment.move",
  schema: C["garment.move"],
  class: "observation",
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const planner = ctx.stock();
    const payload: Record<string, unknown> = { to: p.to };
    if (p.from) payload.from = p.from;
    if (p.quantity) payload.quantity = p.quantity;
    if (p.expectedReturn) payload.expectedReturn = p.expectedReturn; // a prediction only; never proof of return
    if (p.note) payload.note = p.note;
    const eventId = planner.add(g.garment_id, "move", payload, "observed", ctx.occurredAt);
    const build = await planner.build();
    const planned = build.garments.get(g.garment_id)!;
    const moved = planned.after.movements.filter((m) => m.eventId === eventId).reduce((n, m) => n + m.quantity, 0);
    if (moved === 0) return { outcome: "noop", summary: `${g.name}: already ${PLACE[p.to]}`, undo: { unavailableReason: "nothing changed" } };
    const parts = stockParts(build);
    return {
      summary: `${g.name}: ${moved === 1 ? "now" : `${moved} now`} ${PLACE[p.to]}`,
      ...parts,
      result: { garmentId: g.garment_id, moved, to: p.to },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: [eventId] } },
    };
  },
  planUndo: (ctx, original, data) => simpleStockUndo(ctx, original, data),
});

export const garmentRetire = define({
  type: "garment.retire",
  schema: C["garment.retire"],
  class: "observation",
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const planner = ctx.stock();
    const payload: Record<string, unknown> = { disposition: p.disposition };
    if (p.quantity) payload.quantity = p.quantity;
    if (p.note) payload.note = p.note;
    const eventId = planner.add(g.garment_id, "retire", payload, "observed", ctx.occurredAt);
    const build = await planner.build();
    const planned = build.garments.get(g.garment_id)!;
    const gone = planned.after.state.gone - planned.before.state.gone;
    if (gone === 0) return { outcome: "noop", summary: `${g.name}: no units left to retire`, undo: { unavailableReason: "nothing changed" } };
    const parts = stockParts(build);
    return {
      summary: `${g.name}: ${gone} ${p.disposition.replace(/_/g, " ")}; ${ownedUnits(planned.after.state)} still owned`,
      ...parts,
      result: { garmentId: g.garment_id, retired: gone, remaining: ownedUnits(planned.after.state) },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: [eventId] } },
    };
  },
  planUndo: (ctx, original, data) => simpleStockUndo(ctx, original, data),
});

export const garmentMerge = define({
  type: "garment.merge",
  schema: C["garment.merge"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    if (p.sourceGarmentId === p.targetGarmentId) throw new CommandError("invalid_command", "a garment cannot be merged into itself");
    const src = await loadGarment(ctx, p.sourceGarmentId, { followMerges: false });
    const dst = await loadGarment(ctx, p.targetGarmentId, { followMerges: false });
    if (src.merged_into) throw new CommandError("precondition_failed", `${src.name} is already merged into another garment`);
    if (dst.merged_into) throw new CommandError("precondition_failed", `${dst.name} is itself merged; merge into its canonical garment`);
    const u = ctx.userId;
    const S = src.garment_id;
    const T = dst.garment_id;
    const planner = ctx.stock();

    // Counted-wear keys reconcile: one counted wear per garment and date survives, all observations are kept.
    const srcWears = await all<{ wearing_date: string; status: string; stock_event_id: string | null }>(ctx.db, "SELECT wearing_date, status, stock_event_id FROM daily_wears WHERE user_id = ? AND garment_id = ?", u, S);
    const dstRows = await all<{ wearing_date: string; status: string }>(ctx.db, "SELECT wearing_date, status FROM daily_wears WHERE user_id = ? AND garment_id = ?", u, T);
    const dstDates = new Set(dstRows.filter((r) => r.status === "active").map((r) => r.wearing_date));
    const dstAnyDates = new Set(dstRows.map((r) => r.wearing_date));
    const srcEvents = await all<{ event_id: string; payload_json: string; occurred_at: string; basis: string }>(
      ctx.db,
      "SELECT event_id, payload_json, occurred_at, basis FROM stock_events WHERE user_id = ? AND garment_id = ? AND kind = 'wear' AND voided_by_command_id IS NULL",
      u,
      S,
    );
    const statements: Stmt[] = [];
    let carried = 0;
    for (const w of srcWears) {
      if (w.status !== "active" || dstDates.has(w.wearing_date)) continue;
      const ev = srcEvents.find((e) => e.event_id === w.stock_event_id);
      // The journal is append-only: the target gets its own wear event at the original time.
      const carriedPayload = ev ? json<Record<string, unknown>>(ev.payload_json, {}) : { wearingDate: w.wearing_date };
      const newEventId = planner.add(T, "wear", p.quantityMode === "add_units" ? { ...carriedPayload, statisticOnly: true } : carriedPayload, "observed", ev?.occurred_at ?? ctx.occurredAt);
      // The surviving row for that date must point at the live event: the source's row when the target has
      // none, the target's own (retracted, about to become active again) row when it has one.
      statements.push(stmt("UPDATE daily_wears SET stock_event_id = ? WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", newEventId, u, dstAnyDates.has(w.wearing_date) ? T : S, w.wearing_date));
      carried++;
    }
    const srcStock = await explainGarmentStock(ctx.db, u, S, src.care_channel);
    const srcUnits = ownedUnits(srcStock.state);
    if (p.quantityMode === "add_units" && srcUnits > 0) {
      // Further units of the same garment: each arrives on the canonical record where the ledger had it -
      // at home, in the hamper, in storage, at the tailor, at the laundry (with its batch or exception) or
      // in a suitcase. Nothing is brought home or declared clean by merging two records.
      const st = srcStock.state;
      const receive = (payload: Record<string, unknown>) => planner.add(T, "receive", { ...payload, mergedFrom: S }, "reconciliation", ctx.occurredAt);
      if (st.clean > 0) receive({ quantity: st.clean, to: "clean" });
      if (st.dirty.length > 0) {
        receive({ quantity: st.dirty.length, to: "clean" });
        if (dst.care_channel !== "none") planner.add(T, "mark_dirty", { quantity: st.dirty.length }, "reconciliation", ctx.occurredAt);
      }
      if (st.storage > 0) receive({ quantity: st.storage, to: "storage" });
      if (st.tailor > 0) receive({ quantity: st.tailor, to: "tailor" });
      for (const [ref, h] of st.service) receive({ quantity: h.quantity, to: "service", ref, held: h.held, lost: h.lost === true, pickedUpAtMs: h.pickedUpAtMs });
      for (const [tripId, t] of st.trip) {
        if (t.clean > 0) receive({ quantity: t.clean, to: "trip", tripId });
        if (t.dirty > 0) receive({ quantity: t.dirty, to: "trip", tripId, dirty: true });
      }
    }
    planner.add(S, "merged_out", { mergedInto: T }, "reconciliation", ctx.occurredAt);
    planner.touch(T);

    // Records kept per garment follow it to the canonical record: measurements (the canonical garment's own
    // current value wins for the same key; the other stays as superseded history), laundry batch membership
    // and laundry exceptions.
    statements.push(
      stmt(
        `UPDATE measurements SET superseded_by = (SELECT t.measurement_id FROM measurements t WHERE t.user_id = measurements.user_id AND t.subject = 'garment' AND t.garment_id = ? AND t.key = measurements.key AND t.superseded_by IS NULL)
          WHERE user_id = ? AND subject = 'garment' AND garment_id = ? AND superseded_by IS NULL
            AND EXISTS (SELECT 1 FROM measurements t WHERE t.user_id = measurements.user_id AND t.subject = 'garment' AND t.garment_id = ? AND t.key = measurements.key AND t.superseded_by IS NULL)`,
        T, u, S, T,
      ),
      stmt("UPDATE measurements SET garment_id = ? WHERE user_id = ? AND subject = 'garment' AND garment_id = ?", T, u, S),
      stmt("UPDATE laundry_exceptions SET garment_id = ? WHERE user_id = ? AND garment_id = ?", T, u, S),
    );
    const srcItems = await all<{ batch_id: string; quantity: number; returned_quantity: number; still_away: number }>(ctx.db, "SELECT batch_id, quantity, returned_quantity, still_away FROM laundry_batch_items WHERE user_id = ? AND garment_id = ?", u, S);
    const dstBatches = new Set((await all<{ batch_id: string }>(ctx.db, "SELECT batch_id FROM laundry_batch_items WHERE user_id = ? AND garment_id = ?", u, T)).map((r) => r.batch_id));
    for (const item of srcItems) {
      if (dstBatches.has(item.batch_id)) {
        // Both records were in the same bag: one membership row for the one garment, with the quantities added.
        statements.push(
          stmt("UPDATE laundry_batch_items SET quantity = quantity + ?, returned_quantity = returned_quantity + ?, still_away = still_away + ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", item.quantity, item.returned_quantity, item.still_away, u, item.batch_id, T),
          stmt("DELETE FROM laundry_batch_items WHERE user_id = ? AND batch_id = ? AND garment_id = ?", u, item.batch_id, S),
        );
      } else {
        statements.push(stmt("UPDATE laundry_batch_items SET garment_id = ? WHERE user_id = ? AND batch_id = ? AND garment_id = ?", T, u, item.batch_id, S));
      }
    }

    statements.push(
      stmt(
        `UPDATE daily_wears SET observation_count = observation_count + (SELECT s.observation_count FROM daily_wears s WHERE s.user_id = ? AND s.garment_id = ? AND s.wearing_date = daily_wears.wearing_date),
                status = CASE WHEN status = 'active' OR (SELECT s.status FROM daily_wears s WHERE s.user_id = ? AND s.garment_id = ? AND s.wearing_date = daily_wears.wearing_date) = 'active' THEN 'active' ELSE 'retracted' END,
                updated_at = ?
          WHERE user_id = ? AND garment_id = ? AND wearing_date IN (SELECT wearing_date FROM daily_wears WHERE user_id = ? AND garment_id = ?)`,
        u, S, u, S, ctx.now, u, T, u, S,
      ),
      stmt("DELETE FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date IN (SELECT wearing_date FROM daily_wears WHERE user_id = ? AND garment_id = ?)", u, S, u, T),
      stmt("UPDATE daily_wears SET garment_id = ?, updated_at = ? WHERE user_id = ? AND garment_id = ?", T, ctx.now, u, S),
      stmt("UPDATE wear_observations SET original_garment_id = COALESCE(original_garment_id, garment_id), garment_id = ? WHERE user_id = ? AND garment_id = ?", T, u, S),
      stmt("UPDATE garment_aliases SET garment_id = ?, kind = CASE WHEN kind = 'owner_name' THEN 'merged' ELSE kind END WHERE user_id = ? AND garment_id = ?", T, u, S),
      stmt("UPDATE garment_facts SET garment_id = ? WHERE user_id = ? AND garment_id = ?", T, u, S),
      stmt("UPDATE OR IGNORE exposure_items SET garment_id = ? WHERE user_id = ? AND garment_id = ?", T, u, S),
      stmt("DELETE FROM exposure_items WHERE user_id = ? AND garment_id = ?", u, S),
      stmt("UPDATE garments SET merged_into = ? WHERE user_id = ? AND garment_id = ?", T, u, S),
    );
    const restrictions = await all<{ restriction_id: string; scope_json: string }>(ctx.db, "SELECT restriction_id, scope_json FROM restrictions WHERE user_id = ? AND status = 'active'", u);
    for (const r of restrictions) {
      const scope = json<{ garmentIds?: string[] }>(r.scope_json, {});
      if (scope.garmentIds?.includes(S)) {
        scope.garmentIds = [...new Set(scope.garmentIds.map((id) => (id === S ? T : id)))];
        statements.push(stmt("UPDATE restrictions SET scope_json = ? WHERE user_id = ? AND restriction_id = ?", JSON.stringify(scope), u, r.restriction_id));
      }
    }
    const parts = stockParts(await planner.build());
    return {
      summary: `Merged ${src.name} into ${dst.name}; aliases, history and ${srcWears.length} wear date${srcWears.length === 1 ? "" : "s"} reconciled`,
      statements: [...parts.statements, ...statements],
      preconditions: parts.preconditions,
      affected: parts.affected,
      outbox: [{ topic: "garment", entityKind: "garment", entityId: T, revision: dst.version + 1 }],
      result: { canonicalGarmentId: T, mergedGarmentId: S, wearDatesCarried: carried, wearDatesMerged: srcWears.length - carried },
      changes: { availabilityChanged: [S, T] },
      bumpWardrobe: true,
      undo: { unavailableReason: "a merge is an explicit identity decision; correct it with another explicit command" },
    };
  },
});

export const garmentRemoveFabricated = define({
  type: "garment.remove_fabricated",
  schema: C["garment.remove_fabricated"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId, { followMerges: false });
    const planner = ctx.stock();
    planner.add(g.garment_id, "merged_out", { removed: p.reason }, "reconciliation", ctx.occurredAt);
    const parts = stockParts(await planner.build());
    return {
      summary: `Removed ${g.name}: it was never a real garment; reason given: ${quoted(p.reason)}`,
      statements: [
        ...parts.statements,
        stmt("UPDATE garments SET removed_reason = ?, acquisition = 'disposed' WHERE user_id = ? AND garment_id = ?", p.reason, ctx.userId, g.garment_id),
        stmt("UPDATE garment_aliases SET removed_at = ? WHERE user_id = ? AND garment_id = ? AND removed_at IS NULL", ctx.now, ctx.userId, g.garment_id),
        stmt("UPDATE daily_wears SET status = 'retracted', updated_at = ? WHERE user_id = ? AND garment_id = ?", ctx.now, ctx.userId, g.garment_id),
        stmt("UPDATE wear_observations SET status = 'retracted', retracted_by_command_id = ? WHERE user_id = ? AND garment_id = ? AND status = 'active'", ctx.commandId, ctx.userId, g.garment_id),
      ],
      preconditions: parts.preconditions,
      affected: parts.affected,
      changes: { availabilityChanged: [g.garment_id] },
      bumpWardrobe: true,
      undo: { unavailableReason: "removing a fabricated entry is explicit; recreate the garment explicitly if it was real" },
    };
  },
});

export const stockReconcile = define({
  type: "stock.reconcile",
  schema: C["stock.reconcile"],
  class: "observation",
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const planner = ctx.stock();
    const eventId = planner.add(g.garment_id, "reconcile", { counts: p.counts, note: p.note }, "reconciliation", ctx.occurredAt);
    const build = await planner.build();
    const after = build.garments.get(g.garment_id)!.after.state;
    const parts = stockParts(build);
    return {
      summary: `${g.name}: counts corrected to ${after.clean} clean, ${after.dirty.length} awaiting care, ${ownedUnits(after)} owned`,
      ...parts,
      result: { garmentId: g.garment_id, clean: after.clean, dirty: after.dirty.length, owned: ownedUnits(after) },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: [eventId] } },
    };
  },
  planUndo: (ctx, original, data) => simpleStockUndo(ctx, original, data),
});

export const stockPack = define({
  type: "stock.pack",
  schema: C["stock.pack"],
  class: "observation",
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const planner = ctx.stock();
    const eventIds: string[] = [];
    const names: string[] = [];
    for (const item of p.items) {
      const g = await loadGarment(ctx, item.garmentId);
      names.push(g.name);
      eventIds.push(planner.add(g.garment_id, "pack", { tripId: p.tripId, quantity: item.quantity }, "observed", ctx.occurredAt));
    }
    const parts = stockParts(await planner.build());
    return {
      summary: `Packed ${names.length} item${names.length === 1 ? "" : "s"} for trip ${quoted(p.tripId, 64)}`,
      ...parts,
      result: { tripId: p.tripId, packed: p.items.length },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: eventIds } },
    };
  },
  planUndo: (ctx, original, data) => simpleStockUndo(ctx, original, data),
});

export const stockUnpack = define({
  type: "stock.unpack",
  schema: C["stock.unpack"],
  class: "observation",
  staleVersions: "conflict",
  requiredScope: "write",
  async plan(ctx, p) {
    const planner = ctx.stock();
    const eventIds: string[] = [];
    let items = p.items;
    if (!items) {
      const rows = await all<{ garment_id: string }>(ctx.db, "SELECT DISTINCT garment_id FROM stock_balances WHERE user_id = ? AND bucket = 'trip' AND (ref = ? OR ref = ?) AND quantity > 0", ctx.userId, p.tripId, `${p.tripId}#dirty`);
      items = rows.map((r) => ({ garmentId: r.garment_id }));
    }
    for (const item of items) {
      const g = await loadGarment(ctx, item.garmentId);
      eventIds.push(planner.add(g.garment_id, "unpack", item.quantity ? { tripId: p.tripId, quantity: item.quantity } : { tripId: p.tripId }, "observed", ctx.occurredAt));
    }
    if (eventIds.length === 0) return { outcome: "noop", summary: `Nothing was packed for trip ${quoted(p.tripId, 64)}`, undo: { unavailableReason: "nothing changed" } };
    const parts = stockParts(await planner.build());
    return {
      summary: `Unpacked ${items.length} item${items.length === 1 ? "" : "s"} from trip ${quoted(p.tripId, 64)}; laundered pieces are awaiting care, not marked clean`,
      ...parts,
      result: { tripId: p.tripId, unpacked: items.length },
      changes: { availabilityChanged: parts.availabilityChanged },
      bumpWardrobe: true,
      undo: { data: { stockEventIds: eventIds } },
    };
  },
  planUndo: (ctx, original, data) => simpleStockUndo(ctx, original, data),
});

export const garmentHandlers = [
  garmentCreate,
  garmentReceive,
  garmentCorrect,
  garmentBulkCorrect,
  garmentAddAlias,
  garmentRemoveAlias,
  garmentSetPlanningPolicy,
  garmentMove,
  garmentRetire,
  garmentMerge,
  garmentRemoveFabricated,
  stockReconcile,
  stockPack,
  stockUnpack,
];
