import { DEFAULT_OWNER_SETTINGS, FOUNDATION_COMMANDS as C, OwnerSettings } from "@garderobe/contracts";
import { all, allIn, first, json, stmt, type Stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import { deepMerge, sha256Hex } from "../util.ts";
import type { CommandPlan } from "../commands/types.ts";
import { restrictionCovers } from "../availability/estimator.ts";
import { attrs, GARMENT_COLS, loadGarments } from "./common.ts";
import { define } from "./garments.ts";
import { planFactChanges, planFactUndo, styleResolveFactConflict, type FactUndo } from "./style-facts.ts";
import type { GarmentRow } from "../stock/planner.ts";

const ALREADY_UNDO = { unavailableReason: "this is already an undo" } as const;

/* ------------------------------------------------------------------ */
/* Restrictions                                                         */
/* ------------------------------------------------------------------ */

async function coveredGarmentIds(ctx: { db: any; userId: string }, scope: unknown): Promise<string[]> {
  const rows = await all<GarmentRow>(ctx.db, `SELECT ${GARMENT_COLS} FROM garments WHERE user_id = ? AND merged_into IS NULL AND removed_reason IS NULL`, ctx.userId);
  return rows.filter((g) => restrictionCovers(scope as any, { garmentId: g.garment_id, category: g.category, attributes: attrs(g) })).map((g) => g.garment_id);
}

export const restrictionAdd = define({
  type: "restriction.add",
  schema: C["restriction.add"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "data_import"],
  async plan(ctx, p) {
    if (p.scope.garmentIds?.length) await loadGarments(ctx, p.scope.garmentIds);
    if (!p.scope.garmentIds?.length && !p.scope.anyOf?.length) throw new CommandError("invalid_command", "a restriction needs named garments or a selector");
    const restrictionId = p.restrictionId ?? ctx.newId("rst");
    const covered = await coveredGarmentIds(ctx, p.scope);
    return {
      summary: `Restriction recorded (${p.kind}): ${p.reason}. ${covered.length} garment${covered.length === 1 ? "" : "s"} excluded until it is explicitly resolved`,
      statements: [
        stmt(
          "INSERT INTO restrictions (user_id, restriction_id, kind, scope_json, reason, starts_at, expected_end, required_evidence, status, source_json, command_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
          ctx.userId, restrictionId, p.kind, JSON.stringify(p.scope), p.reason, ctx.occurredAt, p.expectedEnd, p.requiredEvidence, JSON.stringify(p.source), ctx.commandId,
        ),
      ],
      preconditions: [{ label: "restriction id is new", sql: "NOT EXISTS (SELECT 1 FROM restrictions WHERE user_id = ? AND restriction_id = ?)", params: [ctx.userId, restrictionId], class: "state" }],
      affected: [{ kind: "restriction", id: restrictionId, version: 1 }],
      result: { restrictionId, coveredGarmentIds: covered },
      changes: { availabilityChanged: covered, restrictionsChanged: true },
      bumpWardrobe: true,
      undo: { data: { restrictionId } },
    };
  },
  async planUndo(ctx, _o, data) {
    const r = await first<{ scope_json: string; status: string }>(ctx.db, "SELECT scope_json, status FROM restrictions WHERE user_id = ? AND restriction_id = ?", ctx.userId, data.restrictionId);
    if (!r || r.status !== "active") throw new CommandError("not_undoable", "that restriction is no longer active");
    const covered = await coveredGarmentIds(ctx, json(r.scope_json, {}));
    return {
      summary: "Restriction withdrawn (it was added by mistake)",
      statements: [stmt("UPDATE restrictions SET status = 'resolved', resolved_at = ?, resolution_json = ?, resolved_command_id = ? WHERE user_id = ? AND restriction_id = ?", ctx.now, JSON.stringify({ undone: true }), ctx.commandId, ctx.userId, data.restrictionId)],
      affected: [{ kind: "restriction", id: data.restrictionId, version: 2 }],
      changes: { availabilityChanged: covered, restrictionsChanged: true },
      bumpWardrobe: true,
      undo: ALREADY_UNDO,
    };
  },
});

const EVIDENCE_ACCEPTED: Record<string, string[]> = {
  owner_statement: ["owner_statement"],
  owner_observation: ["owner_statement", "photograph"],
  receipt: ["receipt", "owner_statement"],
};

export const restrictionResolve = define({
  type: "restriction.resolve",
  schema: C["restriction.resolve"],
  class: "edit",
  requiredScope: "write",
  // Only the owner's own tap or explicit statement lifts a restriction. Schedules, standing policies,
  // imports and elapsed time never do.
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const r = await first<{ kind: string; scope_json: string; status: string; required_evidence: string; reason: string }>(
      ctx.db,
      "SELECT kind, scope_json, status, required_evidence, reason FROM restrictions WHERE user_id = ? AND restriction_id = ?",
      ctx.userId,
      p.restrictionId,
    );
    if (!r) throw new CommandError("not_found", `no restriction '${p.restrictionId}'`);
    if (r.status !== "active") return { outcome: "noop", summary: "That restriction was already resolved", undo: { unavailableReason: "nothing changed" } };
    if (!(EVIDENCE_ACCEPTED[r.required_evidence] ?? []).includes(p.evidence.kind)) {
      throw new CommandError("forbidden", `this restriction is only lifted by ${r.required_evidence.replace(/_/g, " ")}; '${p.evidence.kind}' does not resolve it`, { requiredEvidence: r.required_evidence });
    }
    const covered = await coveredGarmentIds(ctx, json(r.scope_json, {}));
    return {
      summary: `Restriction resolved (${r.kind}): ${r.reason}. ${covered.length} garment${covered.length === 1 ? " is" : "s are"} no longer excluded by it`,
      statements: [
        stmt(
          "UPDATE restrictions SET status = 'resolved', resolved_at = ?, resolution_json = ?, resolved_command_id = ? WHERE user_id = ? AND restriction_id = ? AND status = 'active'",
          ctx.occurredAt, JSON.stringify({ evidence: p.evidence, note: p.note }), ctx.commandId, ctx.userId, p.restrictionId,
        ),
      ],
      preconditions: [{ label: "restriction still active", sql: "(SELECT status FROM restrictions WHERE user_id = ? AND restriction_id = ?) = 'active'", params: [ctx.userId, p.restrictionId], class: "internal" }],
      affected: [{ kind: "restriction", id: p.restrictionId, version: 2 }],
      result: { restrictionId: p.restrictionId, releasedGarmentIds: covered },
      changes: { availabilityChanged: covered, restrictionsChanged: true },
      bumpWardrobe: true,
      undo: { data: { restrictionId: p.restrictionId } },
    };
  },
  async planUndo(ctx, _o, data) {
    const r = await first<{ scope_json: string }>(ctx.db, "SELECT scope_json FROM restrictions WHERE user_id = ? AND restriction_id = ?", ctx.userId, data.restrictionId);
    const covered = r ? await coveredGarmentIds(ctx, json(r.scope_json, {})) : [];
    return {
      summary: "Restriction reinstated",
      statements: [stmt("UPDATE restrictions SET status = 'active', resolved_at = NULL, resolution_json = NULL, resolved_command_id = NULL WHERE user_id = ? AND restriction_id = ?", ctx.userId, data.restrictionId)],
      affected: [{ kind: "restriction", id: data.restrictionId, version: 3 }],
      changes: { availabilityChanged: covered, restrictionsChanged: true },
      bumpWardrobe: true,
      undo: ALREADY_UNDO,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Style documents, amendments, rules, directions, briefs               */
/* ------------------------------------------------------------------ */

const styleOutbox = (revision: number) => [{ topic: "style", entityKind: "style", entityId: "owner-profile", revision }];

/** Close open profile conflicts on facts that their own command now replaces. */
function supersedeOpenConflicts(ctx: { userId: string; now: string; commandId: string }, factKind: "rule" | "measurement", where: string, params: unknown[]): Stmt {
  return stmt(
    `UPDATE style_fact_conflicts SET status = 'resolved', resolution_json = ?, resolved_at = ?, resolved_command_id = ? WHERE user_id = ? AND status = 'open' AND fact_kind = ? AND ${where}`,
    JSON.stringify({ action: "replace", note: "superseded by a newer statement of this fact" }), ctx.now, ctx.commandId, ctx.userId, factKind, ...params,
  );
}

export const styleImportDocument = define({
  type: "style.import_document",
  schema: C["style.import_document"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["data_import", "owner_tap"],
  async plan(ctx, p) {
    const bytes = new TextEncoder().encode(p.content);
    const sha = await sha256Hex(bytes);
    if (sha !== p.expectedSha256) {
      throw new CommandError("precondition_failed", "the document does not match its expected SHA-256; it was not imported", { expected: p.expectedSha256, actual: sha });
    }
    const active = await first<{ version: number; content_sha256: string }>(ctx.db, "SELECT version, content_sha256 FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active'", ctx.userId, p.documentId);
    if (active && active.content_sha256 === sha) return { outcome: "noop", summary: `"${p.title}" is already the active style document`, result: { documentId: p.documentId, version: active.version, contentSha256: sha }, undo: { unavailableReason: "nothing changed" } };
    if (active) throw new CommandError("precondition_failed", "a different style document is already active; save a new version instead of importing over it");
    return {
      summary: `Imported "${p.title}" verbatim (${bytes.byteLength} bytes, SHA-256 ${sha.slice(0, 12)}...) as style document version 1`,
      statements: [
        stmt(
          "INSERT INTO style_documents (user_id, document_id, version, title, content, content_sha256, byte_length, status, source_json, command_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, 'active', ?, ?, ?)",
          ctx.userId, p.documentId, p.title, p.content, sha, bytes.byteLength, JSON.stringify(p.source), ctx.commandId, ctx.now,
        ),
      ],
      preconditions: [{ label: "no active style document yet", sql: "NOT EXISTS (SELECT 1 FROM style_documents WHERE user_id = ? AND document_id = ?)", params: [ctx.userId, p.documentId], class: "state" }],
      affected: [{ kind: "style_document", id: p.documentId, version: 1 }],
      outbox: styleOutbox(ctx.styleRevision + 1),
      result: { documentId: p.documentId, version: 1, contentSha256: sha, byteLength: bytes.byteLength },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { unavailableReason: "the imported profile is the preserved original; edit it in My style instead" },
    };
  },
});

export const styleSaveDocument = define({
  type: "style.save_document",
  schema: C["style.save_document"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    // A model-written compaction or extraction can never rewrite the owner's profile.
    if (p.source.kind === "model_inference") throw new CommandError("forbidden", "the profile is the owner's own text; a model inference cannot save a new version of it");
    const active = await first<{ version: number; title: string; content: string; content_sha256: string }>(ctx.db, "SELECT version, title, content, content_sha256 FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active'", ctx.userId, p.documentId);
    if (!active) throw new CommandError("not_found", "there is no active style document to edit");
    const bytes = new TextEncoder().encode(p.content);
    const sha = await sha256Hex(bytes);
    if (sha === active.content_sha256 && p.incorporateAmendmentIds.length === 0) return { outcome: "noop", summary: "My style is unchanged", undo: { unavailableReason: "nothing changed" } };
    if (p.incorporateAmendmentIds.length > 0) {
      const known = await allIn<{ amendment_id: string }>(ctx.db, "SELECT amendment_id FROM style_amendments WHERE user_id = ? AND document_id = ? AND amendment_id IN (:ids)", [ctx.userId, p.documentId], p.incorporateAmendmentIds);
      const missing = p.incorporateAmendmentIds.filter((id) => !known.some((k) => k.amendment_id === id));
      if (missing.length > 0) throw new CommandError("not_found", `unknown amendment${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}; nothing was saved`, { missing });
    }
    const version = active.version + 1;
    // The diff of structured facts against the version this save replaces (same batch, same expected version).
    const facts = await planFactChanges(ctx, {
      documentId: p.documentId,
      fromVersion: active.version,
      toVersion: version,
      previous: { content: active.content, sha256: active.content_sha256 },
      next: { content: p.content, sha256: sha },
      resolutions: p.factResolutions,
      source: p.source,
    });
    const incorporated = (await allIn<{ amendment_id: string }>(ctx.db, "SELECT amendment_id FROM style_amendments WHERE user_id = ? AND status = 'active' AND amendment_id IN (:ids)", [ctx.userId], p.incorporateAmendmentIds)).map((a) => a.amendment_id);
    const statements: Stmt[] = [
      stmt("UPDATE style_documents SET status = 'superseded' WHERE user_id = ? AND document_id = ? AND version = ?", ctx.userId, p.documentId, active.version),
      stmt(
        "INSERT INTO style_documents (user_id, document_id, version, title, content, content_sha256, byte_length, status, source_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
        ctx.userId, p.documentId, version, active.title, p.content, sha, bytes.byteLength, JSON.stringify(p.source), ctx.commandId, ctx.now,
      ),
    ];
    // Amendments are marked incorporated individually; the others stay active on top of the new version.
    for (const id of incorporated) {
      statements.push(stmt("UPDATE style_amendments SET status = 'incorporated', updated_at = ? WHERE user_id = ? AND amendment_id = ? AND status = 'active'", ctx.now, ctx.userId, id));
    }
    statements.push(...facts.statements);
    const parts = [
      incorporated.length ? `${incorporated.length} amendment(s) incorporated` : "",
      facts.diff.applied.length ? `${facts.diff.applied.length} structured fact(s) changed as decided` : "",
      facts.diff.conflicts.length ? `${facts.diff.conflicts.length} structured fact(s) no longer match the text and stay in force until decided` : "",
    ].filter(Boolean);
    return {
      summary: `My style saved as version ${version}` + (parts.length ? `; ${parts.join("; ")}` : ""),
      statements,
      preconditions: [{ label: "style document unchanged since read", sql: "(SELECT version FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active') = ?", params: [ctx.userId, p.documentId, active.version], class: "internal" }],
      affected: [{ kind: "style_document", id: p.documentId, version }, ...facts.affected],
      outbox: styleOutbox(ctx.styleRevision + 1),
      result: { documentId: p.documentId, version, contentSha256: sha, previousVersion: active.version, factDiff: facts.diff, conflictIds: facts.conflictIds },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { data: { documentId: p.documentId, version, previousVersion: active.version, incorporated, facts: facts.undo } },
    };
  },
  async planUndo(ctx, _o, data) {
    const prev = await first<{ title: string; content: string; content_sha256: string; byte_length: number; source_json: string }>(
      ctx.db,
      "SELECT title, content, content_sha256, byte_length, source_json FROM style_documents WHERE user_id = ? AND document_id = ? AND version = ?",
      ctx.userId, data.documentId, data.previousVersion,
    );
    if (!prev) throw new CommandError("not_undoable", "the earlier version is no longer available");
    const version = data.version + 1;
    const statements: Stmt[] = [
      stmt("UPDATE style_documents SET status = 'superseded' WHERE user_id = ? AND document_id = ? AND version = ?", ctx.userId, data.documentId, data.version),
      stmt(
        "INSERT INTO style_documents (user_id, document_id, version, title, content, content_sha256, byte_length, status, source_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
        ctx.userId, data.documentId, version, prev.title, prev.content, prev.content_sha256, prev.byte_length, prev.source_json, ctx.commandId, ctx.now,
      ),
    ];
    for (const id of data.incorporated as string[]) statements.push(stmt("UPDATE style_amendments SET status = 'active', updated_at = ? WHERE user_id = ? AND amendment_id = ?", ctx.now, ctx.userId, id));
    // Structured facts go back with the text: re-anchored passages, the owner's decisions and the conflicts this save opened.
    const facts = data.facts ? planFactUndo(ctx, data.facts as FactUndo) : { statements: [], preconditions: [] };
    statements.push(...facts.statements);
    return {
      summary: `My style restored to the text of version ${data.previousVersion} (saved as version ${version})`,
      statements,
      preconditions: [{ label: "no later edit of My style", sql: "(SELECT version FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active') = ?", params: [ctx.userId, data.documentId, data.version], class: "state" }, ...facts.preconditions],
      affected: [{ kind: "style_document", id: data.documentId, version }],
      outbox: styleOutbox(ctx.styleRevision + 1),
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: ALREADY_UNDO,
    };
  },
});

export const styleAddAmendment = define({
  type: "style.add_amendment",
  schema: C["style.add_amendment"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "data_import"],
  async plan(ctx, p) {
    // An unconfirmed model extraction cannot overrule an owner-authored passage.
    if (p.source.kind === "model_inference") throw new CommandError("forbidden", "a profile amendment needs an owner-confirmed source, not a model inference");
    const active = await first<{ version: number }>(ctx.db, "SELECT version FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active'", ctx.userId, p.documentId);
    if (!active) throw new CommandError("not_found", "there is no active style document to amend");
    const amendmentId = p.amendmentId ?? ctx.newId("amd");
    return {
      summary: `Profile amendment recorded (${p.kind}): ${p.text}`,
      statements: [
        stmt(
          "INSERT INTO style_amendments (user_id, amendment_id, document_id, based_on_version, text, kind, status, source_json, command_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
          ctx.userId, amendmentId, p.documentId, active.version, p.text, p.kind, JSON.stringify(p.source), ctx.commandId, ctx.now, ctx.now,
        ),
      ],
      affected: [{ kind: "style_amendment", id: amendmentId, version: 1 }],
      outbox: styleOutbox(ctx.styleRevision + 1),
      result: { amendmentId, basedOnVersion: active.version },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { data: { amendmentId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Profile amendment withdrawn",
      statements: [stmt("UPDATE style_amendments SET status = 'retired', updated_at = ? WHERE user_id = ? AND amendment_id = ?", ctx.now, ctx.userId, data.amendmentId)],
      affected: [{ kind: "style_amendment", id: data.amendmentId, version: 2 }],
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: ALREADY_UNDO,
    };
  },
});

export const styleSetAmendmentStatus = define({
  type: "style.set_amendment_status",
  schema: C["style.set_amendment_status"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const a = await first<{ status: string }>(ctx.db, "SELECT status FROM style_amendments WHERE user_id = ? AND amendment_id = ?", ctx.userId, p.amendmentId);
    if (!a) throw new CommandError("not_found", `no amendment '${p.amendmentId}'`);
    if (a.status === p.status) return { outcome: "noop", summary: `Amendment already ${p.status}`, undo: { unavailableReason: "nothing changed" } };
    return {
      summary: `Amendment marked ${p.status}`,
      statements: [stmt("UPDATE style_amendments SET status = ?, updated_at = ? WHERE user_id = ? AND amendment_id = ?", p.status, ctx.now, ctx.userId, p.amendmentId)],
      affected: [{ kind: "style_amendment", id: p.amendmentId, version: 2 }],
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { unavailableReason: "set the status again to change it back" },
    };
  },
});

export const styleUpsertRule = define({
  type: "style.upsert_rule",
  schema: C["style.upsert_rule"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "data_import"],
  async plan(ctx, p) {
    const current = await first<{ rule_id: string; version: number }>(ctx.db, "SELECT rule_id, version FROM style_rules WHERE user_id = ? AND key = ? AND is_current = 1", ctx.userId, p.key);
    // A machine rule derived from the profile must quote the passage it interprets, verbatim.
    if (p.origin === "profile") {
      if (p.passages.length === 0) throw new CommandError("invalid_command", "a profile-derived rule must reference the passage it interprets");
      const doc = await first<{ content: string; content_sha256: string }>(ctx.db, "SELECT content, content_sha256 FROM style_documents WHERE user_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1", ctx.userId);
      for (const passage of p.passages) {
        if (!doc || doc.content_sha256 !== passage.documentSha256 || !doc.content.includes(passage.quote)) {
          throw new CommandError("precondition_failed", "a quoted passage does not occur verbatim in the active style document", { quote: passage.quote.slice(0, 80) });
        }
      }
    }
    const ruleId = current?.rule_id ?? p.ruleId ?? ctx.newId("rul");
    const version = (current?.version ?? 0) + 1;
    const statements: Stmt[] = [];
    if (current) {
      statements.push(stmt("UPDATE style_rules SET is_current = 0 WHERE user_id = ? AND rule_id = ? AND version = ?", ctx.userId, current.rule_id, current.version));
      // The owner's newer statement of this rule settles any conflict a profile edit left open on it.
      statements.push(supersedeOpenConflicts(ctx, "rule", "fact_id = ?", [p.key]));
    }
    statements.push(
      stmt(
        "INSERT INTO style_rules (user_id, rule_id, version, key, kind, status, params_json, interpretation, passages_json, origin, is_current, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        ctx.userId, ruleId, version, p.key, p.kind, p.status, JSON.stringify(p.params), p.interpretation, JSON.stringify(p.passages), p.origin, ctx.commandId, ctx.now,
      ),
    );
    return {
      summary: `Rule '${p.key}' ${current ? `updated to version ${version}` : "recorded"} (${p.kind}, ${p.status})`,
      statements,
      preconditions: [
        current
          ? { label: "rule unchanged since read", sql: "(SELECT version FROM style_rules WHERE user_id = ? AND key = ? AND is_current = 1) = ?", params: [ctx.userId, p.key, current.version], class: "internal" as const }
          : { label: "rule key is new", sql: "NOT EXISTS (SELECT 1 FROM style_rules WHERE user_id = ? AND key = ? AND is_current = 1)", params: [ctx.userId, p.key], class: "internal" as const },
      ],
      affected: [{ kind: "style_rule", id: ruleId, version }],
      result: { ruleId, version, key: p.key },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: current ? { data: { ruleId, key: p.key, version, previousVersion: current.version } } : { data: { ruleId, key: p.key, version, previousVersion: null } },
    };
  },
  async planUndo(ctx, _o, data) {
    const statements: Stmt[] = [stmt("UPDATE style_rules SET is_current = 0, status = 'retired' WHERE user_id = ? AND rule_id = ? AND version = ?", ctx.userId, data.ruleId, data.version)];
    if (data.previousVersion !== null) statements.push(stmt("UPDATE style_rules SET is_current = 1 WHERE user_id = ? AND rule_id = ? AND version = ?", ctx.userId, data.ruleId, data.previousVersion));
    return {
      summary: `Rule '${data.key}' change undone`,
      statements,
      preconditions: [{ label: "rule not changed since", sql: "(SELECT version FROM style_rules WHERE user_id = ? AND key = ? AND is_current = 1) = ?", params: [ctx.userId, data.key, data.version], class: "state" }],
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: ALREADY_UNDO,
    };
  },
});

export const styleAddDirection = define({
  type: "style.add_direction",
  schema: C["style.add_direction"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "data_import"],
  async plan(ctx, p) {
    if (p.source.kind === "model_inference") throw new CommandError("forbidden", "a standing direction needs an owner source; a fleeting reaction is feedback, not a rule");
    const directionId = p.directionId ?? ctx.newId("dir");
    return {
      summary: `Standing direction in effect: ${p.text}`,
      statements: [
        stmt(
          "INSERT INTO standing_directions (user_id, direction_id, version, text, scope, check_key, status, source_json, command_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, 'active', ?, ?, ?, ?)",
          ctx.userId, directionId, p.text, p.scope, p.checkKey, JSON.stringify(p.source), ctx.commandId, ctx.now, ctx.now,
        ),
      ],
      affected: [{ kind: "standing_direction", id: directionId, version: 1 }],
      result: { directionId },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { data: { directionId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Standing direction withdrawn",
      statements: [stmt("UPDATE standing_directions SET status = 'retired', version = version + 1, updated_at = ? WHERE user_id = ? AND direction_id = ?", ctx.now, ctx.userId, data.directionId)],
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: ALREADY_UNDO,
    };
  },
});

export const styleRetireDirection = define({
  type: "style.retire_direction",
  schema: C["style.retire_direction"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const d = await first<{ status: string; text: string }>(ctx.db, "SELECT status, text FROM standing_directions WHERE user_id = ? AND direction_id = ?", ctx.userId, p.directionId);
    if (!d) throw new CommandError("not_found", `no standing direction '${p.directionId}'`);
    if (d.status !== "active") return { outcome: "noop", summary: "That direction was already retired", undo: { unavailableReason: "nothing changed" } };
    return {
      summary: `Standing direction retired: ${d.text}`,
      statements: [stmt("UPDATE standing_directions SET status = 'retired', version = version + 1, updated_at = ? WHERE user_id = ? AND direction_id = ?", ctx.now, ctx.userId, p.directionId)],
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { data: { directionId: p.directionId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Standing direction reinstated",
      statements: [stmt("UPDATE standing_directions SET status = 'active', version = version + 1, updated_at = ? WHERE user_id = ? AND direction_id = ?", ctx.now, ctx.userId, data.directionId)],
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: ALREADY_UNDO,
    };
  },
});

export const styleSetBrief = define({
  type: "style.set_brief",
  schema: C["style.set_brief"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const briefId = p.briefId ?? ctx.newId("brf");
    return {
      summary: `Brief for ${p.localDate}: ${p.text}`,
      statements: [
        stmt(
          "INSERT INTO temporary_briefs (user_id, brief_id, local_date, text, status, source_json, command_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)",
          ctx.userId, briefId, p.localDate, p.text, JSON.stringify(p.source), ctx.commandId, ctx.now, ctx.now,
        ),
      ],
      affected: [{ kind: "temporary_brief", id: briefId, version: 1 }],
      result: { briefId, localDate: p.localDate },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { data: { briefId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Day brief withdrawn",
      statements: [stmt("UPDATE temporary_briefs SET status = 'retired', updated_at = ? WHERE user_id = ? AND brief_id = ?", ctx.now, ctx.userId, data.briefId)],
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: ALREADY_UNDO,
    };
  },
});

export const styleRetireBrief = define({
  type: "style.retire_brief",
  schema: C["style.retire_brief"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const b = await first<{ status: string }>(ctx.db, "SELECT status FROM temporary_briefs WHERE user_id = ? AND brief_id = ?", ctx.userId, p.briefId);
    if (!b) throw new CommandError("not_found", `no brief '${p.briefId}'`);
    if (b.status !== "active") return { outcome: "noop", summary: "That brief was already retired", undo: { unavailableReason: "nothing changed" } };
    return {
      summary: "Day brief retired",
      statements: [stmt("UPDATE temporary_briefs SET status = 'retired', updated_at = ? WHERE user_id = ? AND brief_id = ?", ctx.now, ctx.userId, p.briefId)],
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { unavailableReason: "set the brief again to restore it" },
    };
  },
});

export const measurementRecord = define({
  type: "measurement.record",
  schema: C["measurement.record"],
  class: "observation",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "data_import"],
  async plan(ctx, p) {
    if (p.source.kind === "model_inference" || p.source.kind === "photograph") {
      throw new CommandError("forbidden", "measurements are dated facts from the owner, a tailor or a maker; they are never inferred from a photograph or by a model");
    }
    if (p.subject === "garment") {
      if (!p.garmentId) throw new CommandError("invalid_command", "a garment measurement needs its garment");
      await loadGarments(ctx, [p.garmentId]);
    }
    const measurementId = ctx.newId("msr");
    return {
      summary: `Recorded ${p.subject} ${p.key}: ${p.qualifier ? `${p.qualifier} ` : ""}${p.value} ${p.unit}${p.measuredOn ? ` (${p.measuredOn})` : ""}`,
      statements: [
        // A newer dated value settles any conflict a profile edit left open on the value it supersedes.
        supersedeOpenConflicts(
          ctx,
          "measurement",
          "fact_id IN (SELECT measurement_id FROM measurements WHERE user_id = ? AND subject = ? AND key = ? AND COALESCE(garment_id, '') = COALESCE(?, '') AND superseded_by IS NULL)",
          [ctx.userId, p.subject, p.key, p.garmentId],
        ),
        // The newer dated value supersedes the earlier one without erasing it.
        stmt(
          "UPDATE measurements SET superseded_by = ? WHERE user_id = ? AND subject = ? AND key = ? AND COALESCE(garment_id, '') = COALESCE(?, '') AND superseded_by IS NULL",
          measurementId, ctx.userId, p.subject, p.key, p.garmentId,
        ),
        stmt(
          "INSERT INTO measurements (user_id, measurement_id, subject, garment_id, key, value, unit, convention, qualifier, measured_on, source_json, passage_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, measurementId, p.subject, p.garmentId, p.key, p.value, p.unit, p.convention, p.qualifier, p.measuredOn, JSON.stringify(p.source), p.passage ? JSON.stringify(p.passage) : null, ctx.commandId, ctx.now,
        ),
      ],
      affected: [{ kind: "measurement", id: measurementId, version: 1 }],
      result: { measurementId },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { unavailableReason: "record the corrected measurement; earlier values stay in the history" },
    };
  },
});

export const sizeExperienceRecord = define({
  type: "size_experience.record",
  schema: C["size_experience.record"],
  class: "observation",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "data_import"],
  async plan(ctx, p) {
    const id = ctx.newId("szx");
    return {
      summary: `Size experience recorded: ${p.maker}${p.productFamily ? ` ${p.productFamily}` : ""} - ${p.sizeLabel}`,
      statements: [
        stmt(
          "INSERT INTO size_experiences (user_id, size_experience_id, maker, product_family, size_label, note, noted_on, passage_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, id, p.maker, p.productFamily, p.sizeLabel, p.note, p.notedOn, p.passage ? JSON.stringify(p.passage) : null, ctx.commandId, ctx.now,
        ),
      ],
      affected: [{ kind: "size_experience", id, version: 1 }],
      result: { sizeExperienceId: id },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { unavailableReason: "record a newer experience; earlier ones stay in the history" },
    };
  },
});

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

function settingsWrite(ctx: { userId: string; now: string; commandId: string }, version: number, settings: OwnerSettings): Stmt[] {
  const text = JSON.stringify(settings);
  return [
    stmt("UPDATE owner_settings SET version = ?, settings_json = ?, updated_at = ? WHERE user_id = ?", version, text, ctx.now, ctx.userId),
    stmt("INSERT INTO owner_settings_versions (user_id, version, settings_json, command_id, created_at) VALUES (?, ?, ?, ?, ?)", ctx.userId, version, text, ctx.commandId, ctx.now),
  ];
}

export const settingsUpdate = define({
  type: "settings.update",
  schema: C["settings.update"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const merged = OwnerSettings.safeParse(deepMerge(ctx.settings, p.patch));
    if (!merged.success) throw new CommandError("invalid_command", "those settings are not valid", { issues: merged.error.issues });
    if (JSON.stringify(merged.data) === JSON.stringify(ctx.settings)) return { outcome: "noop", summary: "Settings unchanged", undo: { unavailableReason: "nothing changed" } };
    const version = ctx.settingsVersion + 1;
    return {
      summary: `Settings updated (version ${version}): ${Object.keys(p.patch).join(", ")}`,
      statements: settingsWrite(ctx, version, merged.data),
      preconditions: [{ label: "settings unchanged since read", sql: "(SELECT version FROM owner_settings WHERE user_id = ?) = ?", params: [ctx.userId, ctx.settingsVersion], class: "internal" }],
      affected: [{ kind: "settings", id: ctx.userId, version }],
      result: { version },
      changes: { settingsChanged: true },
      undo: { data: { version, previous: ctx.settings } },
    };
  },
  async planUndo(ctx, _o, data) {
    const version = ctx.settingsVersion + 1;
    const previous = OwnerSettings.parse(deepMerge(DEFAULT_OWNER_SETTINGS, data.previous));
    return {
      summary: `Settings restored (version ${version})`,
      statements: settingsWrite(ctx, version, previous),
      preconditions: [{ label: "settings not changed since", sql: "(SELECT version FROM owner_settings WHERE user_id = ?) = ?", params: [ctx.userId, data.version], class: "state" }],
      affected: [{ kind: "settings", id: ctx.userId, version }],
      changes: { settingsChanged: true },
      undo: ALREADY_UNDO,
    };
  },
});

/* ------------------------------------------------------------------ */
/* Selection-probability exposures                                      */
/* ------------------------------------------------------------------ */

export const exposurePublish = define({
  type: "exposure.publish",
  schema: C["exposure.publish"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const exposureId = p.exposureId ?? ctx.newId("exp");
    const ids = [...new Set(p.options.flatMap((o) => [...o.garmentIds, ...o.alternativeGroups.flat()]))];
    await loadGarments(ctx, ids); // an option can only reference real garments of this owner
    const optionIds = new Set(p.options.map((o) => o.optionId));
    if (optionIds.size !== p.options.length) throw new CommandError("invalid_command", "option IDs must be unique within a set");
    const statements: Stmt[] = [
      stmt(
        "INSERT INTO exposure_sets (user_id, exposure_id, local_date, source_kind, source_ref, option_count, p_use, status, command_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)",
        ctx.userId, exposureId, p.localDate, p.sourceKind, p.sourceRef, p.options.length, p.pUse ?? null, ctx.commandId, ctx.now, ctx.now,
      ),
    ];
    for (const o of p.options) {
      const seen = new Set<string>();
      for (const g of o.garmentIds) {
        if (seen.has(g)) continue;
        seen.add(g);
        statements.push(stmt("INSERT INTO exposure_items (user_id, exposure_id, option_id, garment_id, alt_group) VALUES (?, ?, ?, ?, 0)", ctx.userId, exposureId, o.optionId, g));
      }
      o.alternativeGroups.forEach((group, i) => {
        for (const g of group) {
          if (seen.has(g)) continue;
          seen.add(g);
          statements.push(stmt("INSERT INTO exposure_items (user_id, exposure_id, option_id, garment_id, alt_group) VALUES (?, ?, ?, ?, ?)", ctx.userId, exposureId, o.optionId, g, i + 1));
        }
      });
    }
    for (const old of p.supersedes) {
      statements.push(stmt("UPDATE exposure_sets SET status = 'superseded', updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status IN ('open', 'selected')", ctx.now, ctx.userId, old));
    }
    return {
      summary: `Registered ${p.options.length} offered option${p.options.length === 1 ? "" : "s"} for ${p.localDate} (estimates only; nothing is reserved or worn)`,
      statements,
      affected: [{ kind: "exposure_set", id: exposureId, version: 1 }],
      result: { exposureId },
      bumpWardrobe: true,
      undo: { unavailableReason: "supersede the option set instead" },
    };
  },
});

export const exposureSelect = define({
  type: "exposure.select",
  schema: C["exposure.select"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const set = await first<{ status: string; selected_option_id: string | null; chosen_alternatives_json: string; local_date: string }>(
      ctx.db,
      "SELECT status, selected_option_id, chosen_alternatives_json, local_date FROM exposure_sets WHERE user_id = ? AND exposure_id = ?",
      ctx.userId, p.exposureId,
    );
    if (!set) throw new CommandError("not_found", `no option set '${p.exposureId}'`);
    if (set.status === "superseded" || set.status === "resolved_worn") throw new CommandError("precondition_failed", `this option set is ${set.status.replace("_", " ")}; choose from the current board`);
    if (p.optionId !== null) {
      const items = await all<{ garment_id: string; alt_group: number }>(ctx.db, "SELECT garment_id, alt_group FROM exposure_items WHERE user_id = ? AND exposure_id = ? AND option_id = ?", ctx.userId, p.exposureId, p.optionId);
      if (items.length === 0) throw new CommandError("not_found", `no option '${p.optionId}' in that set`);
      for (const g of p.chosenAlternatives) {
        if (!items.some((i) => i.garment_id === g && i.alt_group > 0)) throw new CommandError("invalid_command", "a chosen alternative is not one of that option's alternatives", { garmentId: g });
      }
    }
    return {
      summary: p.optionId === null ? `Selection cleared for ${set.local_date}` : `Chosen for ${set.local_date} (an intention, not a recorded wear)`,
      statements: [
        stmt(
          "UPDATE exposure_sets SET selected_option_id = ?, chosen_alternatives_json = ?, status = ?, updated_at = ? WHERE user_id = ? AND exposure_id = ?",
          p.optionId, JSON.stringify(p.chosenAlternatives), p.optionId === null ? "open" : "selected", ctx.now, ctx.userId, p.exposureId,
        ),
      ],
      preconditions: [{ label: "option set still open", sql: "(SELECT status FROM exposure_sets WHERE user_id = ? AND exposure_id = ?) IN ('open', 'selected')", params: [ctx.userId, p.exposureId], class: "state" }],
      affected: [{ kind: "exposure_set", id: p.exposureId, version: 2 }],
      result: { exposureId: p.exposureId, selectedOptionId: p.optionId },
      bumpWardrobe: true,
      undo: { data: { exposureId: p.exposureId, previousOptionId: set.selected_option_id, previousAlternatives: json(set.chosen_alternatives_json, []) } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Selection restored to what it was",
      statements: [
        stmt(
          "UPDATE exposure_sets SET selected_option_id = ?, chosen_alternatives_json = ?, status = ?, updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status IN ('open', 'selected')",
          data.previousOptionId, JSON.stringify(data.previousAlternatives), data.previousOptionId ? "selected" : "open", ctx.now, ctx.userId, data.exposureId,
        ),
      ],
      bumpWardrobe: true,
      undo: ALREADY_UNDO,
    };
  },
});

export const exposureSupersede = define({
  type: "exposure.supersede",
  schema: C["exposure.supersede"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const rows = await allIn<{ exposure_id: string }>(ctx.db, "SELECT exposure_id FROM exposure_sets WHERE user_id = ? AND status IN ('open', 'selected') AND exposure_id IN (:ids)", [ctx.userId], p.exposureIds);
    if (rows.length === 0) return { outcome: "noop", summary: "No open option sets to supersede", undo: { unavailableReason: "nothing changed" } };
    return {
      summary: `Superseded ${rows.length} option set${rows.length === 1 ? "" : "s"}`,
      statements: rows.map((r) => stmt("UPDATE exposure_sets SET status = 'superseded', updated_at = ? WHERE user_id = ? AND exposure_id = ?", ctx.now, ctx.userId, r.exposure_id)),
      bumpWardrobe: true,
      undo: { unavailableReason: "publish the option set again instead" },
    };
  },
});

export const styleHandlers = [
  restrictionAdd,
  restrictionResolve,
  styleImportDocument,
  styleSaveDocument,
  styleResolveFactConflict,
  styleAddAmendment,
  styleSetAmendmentStatus,
  styleUpsertRule,
  styleAddDirection,
  styleRetireDirection,
  styleSetBrief,
  styleRetireBrief,
  measurementRecord,
  sizeExperienceRecord,
  settingsUpdate,
  exposurePublish,
  exposureSelect,
  exposureSupersede,
];
