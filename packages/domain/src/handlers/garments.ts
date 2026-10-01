import type { z } from "zod";
import { FOUNDATION_COMMANDS as C } from "@garderobe/contracts";
import { all, first, json, stmt, type Stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import { normalizePhrase } from "../util.ts";
import { explainGarmentStock, type GarmentRow } from "../stock/planner.ts";
import { ownedUnits } from "../stock/replay.ts";
import type { CommandDefinition, CommandPlan } from "../commands/types.ts";
import { bumpGarment, loadGarment, simpleStockUndo, stockParts } from "./common.ts";

export function define<S extends z.ZodType>(def: CommandDefinition<S>): CommandDefinition<S> {
  return def;
}

const basisFor = (authorization: string) => (authorization === "data_import" ? ("import" as const) : ("observed" as const));

function aliasInsert(ctx: { userId: string; now: string; newId(p: string): string }, garmentId: string, phrase: string, kind: string): Stmt {
  return stmt(
    "INSERT INTO garment_aliases (user_id, alias_id, garment_id, phrase, normalized, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ctx.userId,
    ctx.newId("als"),
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
      summary: `Added ${p.name} (${p.quantity} ${p.acquisition === "incoming" ? "on order, not yet arrived" : "owned"})`,
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

export const garmentCorrect = define({
  type: "garment.correct",
  schema: C["garment.correct"],
  class: "observation",
  requiredScope: "write",
  async plan(ctx, p) {
    const g = await loadGarment(ctx, p.garmentId);
    const full = (await first<Record<string, any>>(ctx.db, "SELECT * FROM garments WHERE user_id = ? AND garment_id = ?", ctx.userId, g.garment_id))!;
    const sets: string[] = [];
    const params: unknown[] = [];
    const previous: Record<string, unknown> = {};
    const statements: Stmt[] = [];
    const changed: string[] = [];
    for (const [key, value] of Object.entries(p.changes)) {
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
      // The correction supersedes the earlier assertion without erasing why it existed.
      statements.push(stmt("UPDATE garment_facts SET superseded_by = ? WHERE user_id = ? AND garment_id = ? AND attribute = ? AND superseded_by IS NULL", factId, ctx.userId, g.garment_id, key));
      statements.push(
        stmt(
          "INSERT INTO garment_facts (user_id, fact_id, garment_id, attribute, value_json, source_json, scope, command_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
          ctx.userId,
          factId,
          g.garment_id,
          key,
          JSON.stringify({ value, previous: full[column] }),
          JSON.stringify(p.source),
          ctx.commandId,
          ctx.now,
        ),
      );
    }
    if (sets.length === 0) return { outcome: "noop", summary: `${g.name}: already as stated`, undo: { unavailableReason: "nothing changed" } };
    const planner = ctx.stock();
    if (p.changes.careChannel && p.changes.careChannel !== g.care_channel) planner.setCareChannel(g.garment_id, p.changes.careChannel);
    else planner.touch(g.garment_id);
    const parts = stockParts(await planner.build());
    statements.unshift(stmt(`UPDATE garments SET ${sets.join(", ")} WHERE user_id = ? AND garment_id = ?`, ...params, ctx.userId, g.garment_id));
    if (p.changes.name && p.changes.name !== g.name) {
      // The owner's name governs what he dresses from; the earlier name stays findable as an alias.
      statements.push(aliasInsert(ctx, g.garment_id, p.changes.name, "owner_name"));
    }
    return {
      summary: `${p.changes.name ?? g.name}: corrected ${changed.join(", ")}`,
      statements: [...statements, ...parts.statements],
      preconditions: parts.preconditions,
      affected: parts.affected,
      outbox: [{ topic: "garment", entityKind: "garment", entityId: g.garment_id, revision: g.version + 1 }],
      result: { garmentId: g.garment_id, changed },
      changes: { availabilityChanged: [g.garment_id] },
      bumpWardrobe: true,
      undo: { data: { garmentId: g.garment_id, previous, versionAfter: g.version + 1 } },
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
      statements: [stmt(`UPDATE garments SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE user_id = ? AND garment_id = ?`, ...cols.map((c) => data.previous[c]), ctx.userId, g.garment_id), ...parts.statements],
      preconditions: [...parts.preconditions, { label: "garment not changed since the correction", sql: "(SELECT version FROM garments WHERE user_id = ? AND garment_id = ?) = ?", params: [ctx.userId, g.garment_id, data.versionAfter], class: "state" }],
      affected: parts.affected,
      changes: { availabilityChanged: [g.garment_id] },
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
    if (existing) return { outcome: "noop", summary: `${g.name} already answers to "${p.phrase}"`, undo: { unavailableReason: "nothing changed" } };
    const b = bumpGarment(ctx, g.garment_id, g.version);
    return {
      summary: `${g.name} now also answers to "${p.phrase}"`,
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
    if (rows.length === 0) return { outcome: "noop", summary: `${g.name} had no alias "${p.phrase}"`, undo: { unavailableReason: "nothing changed" } };
    return {
      summary: `${g.name} no longer answers to "${p.phrase}"`,
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
      summary: `${g.name}: planning policy set to ${p.policy}${p.reason ? ` (${p.reason})` : ""}`,
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
    const dstDates = new Set((await all<{ wearing_date: string }>(ctx.db, "SELECT wearing_date FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", u, T)).map((r) => r.wearing_date));
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
      const newEventId = planner.add(T, "wear", ev ? json(ev.payload_json, {}) : { wearingDate: w.wearing_date }, "observed", ev?.occurred_at ?? ctx.occurredAt);
      statements.push(stmt("UPDATE daily_wears SET stock_event_id = ? WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", newEventId, u, S, w.wearing_date));
      carried++;
    }
    const srcStock = await explainGarmentStock(ctx.db, u, S, src.care_channel);
    const srcUnits = ownedUnits(srcStock.state);
    if (p.quantityMode === "add_units" && srcUnits > 0) {
      planner.add(T, "receive", { quantity: srcUnits, to: "clean", mergedFrom: S }, "reconciliation", ctx.occurredAt);
      if (srcStock.state.dirty.length > 0 && dst.care_channel !== "none") planner.add(T, "mark_dirty", { quantity: srcStock.state.dirty.length }, "reconciliation", ctx.occurredAt);
    }
    planner.add(S, "merged_out", { mergedInto: T }, "reconciliation", ctx.occurredAt);
    planner.touch(T);

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
      summary: `Removed ${g.name}: it was never a real garment (${p.reason})`,
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
      summary: `Packed ${names.length} item${names.length === 1 ? "" : "s"} for trip ${p.tripId}`,
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
    if (eventIds.length === 0) return { outcome: "noop", summary: `Nothing was packed for trip ${p.tripId}`, undo: { unavailableReason: "nothing changed" } };
    const parts = stockParts(await planner.build());
    return {
      summary: `Unpacked ${items.length} item${items.length === 1 ? "" : "s"} from trip ${p.tripId}; laundered pieces are awaiting care, not marked clean`,
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
