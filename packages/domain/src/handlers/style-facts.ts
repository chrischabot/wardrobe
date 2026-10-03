/**
 * Structured facts and the profile text (specification section 6, "Save in My style").
 *
 * `style.save_document` calls `planFactChanges` to derive, inside the same batch as the new version:
 *   - re-anchoring of every fact whose quoted passages still occur verbatim (their line numbers and
 *     document hash move to the new version; the fact itself is untouched);
 *   - the owner's explicit resolutions for facts whose passage the edit removed or reworded;
 *   - an open conflict for every such fact the owner did not decide. The fact stays in force.
 * No step reads meaning out of the prose, so no step can invent a fact, a value or a resolution.
 */
import type { EntityVersion, PassageRef, SourceRef, StyleFactConflict, StyleFactDiff, StyleFactRef, StyleFactResolution } from "@garderobe/contracts";
import { FOUNDATION_COMMANDS as C } from "@garderobe/contracts";
import { all, first, json, stmt, type Db, type Stmt } from "../db.ts";
import { CommandError } from "../errors.ts";
import { assertPrincipal, requireScope, type Principal } from "../principal.ts";
import { localDateOf, sha256Hex } from "../util.ts";
import type { CommandContext, CommandPlan, Precondition } from "../commands/types.ts";
import { deriveFactDiff, locateQuote, type AffectedFact, type AnchoredFact } from "../style/fact-diff.ts";
import { define } from "./garments.ts";

interface RuleRow {
  rule_id: string;
  version: number;
  key: string;
  kind: string;
  status: string;
  params_json: string;
  interpretation: string;
  passages_json: string;
  origin: string;
}
interface MeasurementRow {
  measurement_id: string;
  subject: string;
  garment_id: string | null;
  key: string;
  value: number;
  unit: string;
  convention: string | null;
  qualifier: string | null;
  measured_on: string | null;
  passage_json: string | null;
}
interface SizeRow {
  size_experience_id: string;
  maker: string;
  product_family: string | null;
  size_label: string;
  note: string | null;
  passage_json: string | null;
}

export interface StyleFactSet {
  facts: AnchoredFact[];
  rules: Map<string, RuleRow>;
  measurements: Map<string, MeasurementRow>;
  sizes: Map<string, SizeRow>;
  activeRestrictionIds: Set<string>;
}

const factKey = (ref: StyleFactRef) => `${ref.kind}:${ref.id}`;
const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Every current structured fact of this owner, with the passages it quotes. */
export async function loadStyleFacts(db: Db, userId: string): Promise<StyleFactSet> {
  const [rules, measurements, sizes, restrictions] = await Promise.all([
    all<RuleRow>(db, "SELECT rule_id, version, key, kind, status, params_json, interpretation, passages_json, origin FROM style_rules WHERE user_id = ? AND is_current = 1 AND status != 'retired' ORDER BY key", userId),
    all<MeasurementRow>(db, "SELECT measurement_id, subject, garment_id, key, value, unit, convention, qualifier, measured_on, passage_json FROM measurements WHERE user_id = ? AND superseded_by IS NULL ORDER BY subject, key, measurement_id", userId),
    all<SizeRow>(db, "SELECT size_experience_id, maker, product_family, size_label, note, passage_json FROM size_experiences WHERE user_id = ? AND retired_at IS NULL ORDER BY maker, julianday(created_at), size_experience_id", userId),
    all<{ restriction_id: string }>(db, "SELECT restriction_id FROM restrictions WHERE user_id = ? AND status = 'active'", userId),
  ]);
  const set: StyleFactSet = { facts: [], rules: new Map(), measurements: new Map(), sizes: new Map(), activeRestrictionIds: new Set(restrictions.map((r) => r.restriction_id)) };
  for (const r of rules) {
    set.rules.set(r.key, r);
    set.facts.push({ ref: { kind: "rule", id: r.key }, label: clip(`rule ${r.key} (${r.kind}, ${r.status}): ${r.interpretation}`), passages: json<PassageRef[]>(r.passages_json, []) });
  }
  for (const m of measurements) {
    set.measurements.set(m.measurement_id, m);
    const passage = json<PassageRef | null>(m.passage_json, null);
    set.facts.push({ ref: { kind: "measurement", id: m.measurement_id }, label: clip(`${m.subject} ${m.key}: ${m.qualifier ? `${m.qualifier} ` : ""}${m.value} ${m.unit}`), passages: passage ? [passage] : [] });
  }
  for (const s of sizes) {
    set.sizes.set(s.size_experience_id, s);
    const passage = json<PassageRef | null>(s.passage_json, null);
    set.facts.push({ ref: { kind: "size_experience", id: s.size_experience_id }, label: clip(`size at ${s.maker}${s.product_family ? ` (${s.product_family})` : ""}: ${s.size_label}`), passages: passage ? [passage] : [] });
  }
  return set;
}

/** Passage references to rewrite in place, by record ID; values are the JSON text to store. */
interface PassageMaps {
  rules: Record<string, string>;
  measurements: Record<string, string>;
  sizes: Record<string, string>;
}
const emptyMaps = (): PassageMaps => ({ rules: {}, measurements: {}, sizes: {} });

function passageStatements(userId: string, maps: PassageMaps): Stmt[] {
  const out: Stmt[] = [];
  const one = (table: string, column: string, idColumn: string, extra: string, map: Record<string, string>) => {
    if (Object.keys(map).length === 0) return;
    const text = JSON.stringify(map);
    out.push(
      stmt(
        `UPDATE ${table} SET ${column} = (SELECT j.value FROM json_each(?) AS j WHERE j.key = ${table}.${idColumn}) WHERE user_id = ?${extra} AND ${idColumn} IN (SELECT k.key FROM json_each(?) AS k)`,
        text, userId, text,
      ),
    );
  };
  one("style_rules", "passages_json", "rule_id", " AND is_current = 1", maps.rules);
  one("measurements", "passage_json", "measurement_id", "", maps.measurements);
  one("size_experiences", "passage_json", "size_experience_id", "", maps.sizes);
  return out;
}

/** What a set of fact changes needs to be compensated. Stored in the command's undo data. */
export interface FactUndo {
  passagesPrevious: PassageMaps;
  ruleVersions: { ruleId: string; key: string; version: number; previousVersion: number }[];
  measurementsReplaced: { oldId: string; newId: string }[];
  sizesReplaced: { oldId: string; newId: string }[];
  sizesRetired: string[];
  conflictsOpened: string[];
  conflictsClosed: { conflictId: string; status: "resolved" | "withdrawn" }[];
}
const emptyUndo = (): FactUndo => ({ passagesPrevious: emptyMaps(), ruleVersions: [], measurementsReplaced: [], sizesReplaced: [], sizesRetired: [], conflictsOpened: [], conflictsClosed: [] });

interface Writes {
  statements: Stmt[];
  affected: EntityVersion[];
  passagesNext: PassageMaps;
  undo: FactUndo;
}

interface ActiveText {
  content: string;
  sha256: string;
}

/** Record that a fact's passage reference moves; remembers the stored value for undo. */
function moveAnchor(set: StyleFactSet, w: Writes, ref: StyleFactRef, passages: PassageRef[]): boolean {
  if (ref.kind === "rule") {
    const row = set.rules.get(ref.id)!;
    const next = JSON.stringify(passages);
    if (next === row.passages_json) return false;
    w.passagesNext.rules[row.rule_id] = next;
    w.undo.passagesPrevious.rules[row.rule_id] = row.passages_json;
    return true;
  }
  const row = ref.kind === "measurement" ? set.measurements.get(ref.id)! : set.sizes.get(ref.id)!;
  const next = JSON.stringify(passages[0]);
  if (next === row.passage_json) return false;
  const bucket = ref.kind === "measurement" ? "measurements" : "sizes";
  w.passagesNext[bucket][ref.id] = next;
  w.undo.passagesPrevious[bucket][ref.id] = row.passage_json!;
  return true;
}

/** Plan the owner's decision about one fact. Throws without writing when the decision is not permitted. */
function planResolution(ctx: CommandContext, set: StyleFactSet, ref: StyleFactRef, res: StyleFactResolution, text: ActiveText, source: SourceRef, w: Writes): void {
  const anchor = res.quote ? locateQuote(text.content, text.sha256, res.quote) : null;
  if (res.quote && !anchor) throw new CommandError("precondition_failed", "the quoted passage does not occur verbatim in the saved text", { fact: ref, quote: res.quote.slice(0, 120) });
  const bodies = { rule: res.rule, measurement: res.measurement, size_experience: res.sizeExperience };
  for (const [kind, body] of Object.entries(bodies)) {
    if (body === undefined) continue;
    if (res.action !== "replace") throw new CommandError("invalid_command", `'${res.action}' does not take new values; use 'replace' to change the fact`, { fact: ref });
    if (kind !== ref.kind) throw new CommandError("invalid_command", `a ${ref.kind.replace("_", " ")} cannot be replaced with a ${kind.replace("_", " ")}`, { fact: ref });
  }
  if (res.action === "replace" && bodies[ref.kind] === undefined) throw new CommandError("invalid_command", `replacing a ${ref.kind.replace("_", " ")} needs its new values`, { fact: ref });

  if (ref.kind === "rule") {
    const row = set.rules.get(ref.id);
    if (!row) throw new CommandError("not_found", `no current rule '${ref.id}'`, { fact: ref });
    const params = json<Record<string, unknown>>(row.params_json, {});
    const next = {
      kind: res.rule?.kind ?? row.kind,
      status: res.action === "retire" ? "retired" : (res.rule?.status ?? row.status),
      params: res.rule?.params ?? params,
      interpretation: res.rule?.interpretation ?? row.interpretation,
    };
    // Editing prose never lifts a restriction: while it is active, the rule that carries it stays as it is.
    const restrictionId = typeof params.restrictionId === "string" ? params.restrictionId : null;
    if (restrictionId && set.activeRestrictionIds.has(restrictionId) && (next.status !== row.status || next.params.restrictionId !== restrictionId)) {
      throw new CommandError("forbidden", "this rule carries an active restriction; only the owner's explicit statement resolves it (restriction.resolve), not an edit of the profile text", { fact: ref, restrictionId });
    }
    const kept = json<PassageRef[]>(row.passages_json, [])
      .map((p) => locateQuote(text.content, text.sha256, p.quote, p.section))
      .filter((p): p is PassageRef => p !== null && p.quote !== anchor?.quote);
    const passages = anchor ? [anchor, ...kept] : kept;
    // A profile-derived rule must quote the active text; one the owner keeps without a passage stands on his confirmation.
    const origin = row.origin === "profile" && passages.length === 0 ? "owner_amendment" : row.origin;
    const version = row.version + 1;
    w.statements.push(
      stmt("UPDATE style_rules SET is_current = 0 WHERE user_id = ? AND rule_id = ? AND version = ?", ctx.userId, row.rule_id, row.version),
      stmt(
        "INSERT INTO style_rules (user_id, rule_id, version, key, kind, status, params_json, interpretation, passages_json, origin, is_current, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        ctx.userId, row.rule_id, version, row.key, next.kind, next.status, JSON.stringify(next.params), next.interpretation, JSON.stringify(passages), origin, ctx.commandId, ctx.now,
      ),
    );
    w.affected.push({ kind: "style_rule", id: row.rule_id, version });
    w.undo.ruleVersions.push({ ruleId: row.rule_id, key: row.key, version, previousVersion: row.version });
    return;
  }

  if (ref.kind === "measurement") {
    const row = set.measurements.get(ref.id);
    if (!row) throw new CommandError("not_found", `no current measurement '${ref.id}'`, { fact: ref });
    if (res.action === "retire") throw new CommandError("invalid_command", "a measurement stays a dated fact; keep it, or replace it with the newer value", { fact: ref });
    if (res.action === "keep") {
      if (anchor) moveAnchor(set, w, ref, [anchor]);
      return;
    }
    if (source.kind === "model_inference" || source.kind === "photograph") {
      throw new CommandError("forbidden", "measurements are dated facts from the owner, a tailor or a maker; they are never inferred from a photograph or by a model", { fact: ref });
    }
    const m = res.measurement!;
    const newId = ctx.newId("msr");
    w.statements.push(
      stmt("UPDATE measurements SET superseded_by = ? WHERE user_id = ? AND measurement_id = ? AND superseded_by IS NULL", newId, ctx.userId, row.measurement_id),
      stmt(
        "INSERT INTO measurements (user_id, measurement_id, subject, garment_id, key, value, unit, convention, qualifier, measured_on, source_json, passage_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ctx.userId, newId, row.subject, row.garment_id, row.key, m.value, m.unit, m.convention === undefined ? row.convention : m.convention, m.qualifier ?? null, m.measuredOn ?? null, JSON.stringify(source), anchor ? JSON.stringify(anchor) : null, ctx.commandId, ctx.now,
      ),
    );
    w.affected.push({ kind: "measurement", id: newId, version: 1 });
    w.undo.measurementsReplaced.push({ oldId: row.measurement_id, newId });
    return;
  }

  const row = set.sizes.get(ref.id);
  if (!row) throw new CommandError("not_found", `no current size experience '${ref.id}'`, { fact: ref });
  if (res.action === "keep") {
    if (anchor) moveAnchor(set, w, ref, [anchor]);
    return;
  }
  w.statements.push(stmt("UPDATE size_experiences SET retired_at = ?, retired_by_command_id = ? WHERE user_id = ? AND size_experience_id = ? AND retired_at IS NULL", ctx.now, ctx.commandId, ctx.userId, row.size_experience_id));
  if (res.action === "retire") {
    w.undo.sizesRetired.push(row.size_experience_id);
    return;
  }
  const s = res.sizeExperience!;
  const newId = ctx.newId("szx");
  w.statements.push(
    stmt(
      "INSERT INTO size_experiences (user_id, size_experience_id, maker, product_family, size_label, note, noted_on, passage_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ctx.userId, newId, row.maker, row.product_family, s.sizeLabel, s.note === undefined ? row.note : s.note, localDateOf(ctx.occurredAtMs, ctx.settings.timezone), anchor ? JSON.stringify(anchor) : null, ctx.commandId, ctx.now,
    ),
  );
  w.affected.push({ kind: "size_experience", id: newId, version: 1 });
  w.undo.sizesReplaced.push({ oldId: row.size_experience_id, newId });
}

function restrictionNote(set: StyleFactSet, ref: StyleFactRef): string | null {
  if (ref.kind !== "rule") return null;
  const restrictionId = json<Record<string, unknown>>(set.rules.get(ref.id)?.params_json ?? "{}", {}).restrictionId;
  if (typeof restrictionId !== "string" || !set.activeRestrictionIds.has(restrictionId)) return null;
  return `The restriction '${restrictionId}' stays active: only the owner's explicit statement resolves it, never an edit of the text.`;
}

function toDiff(documentId: string, fromVersion: number, contentChanged: boolean, set: StyleFactSet, derived: ReturnType<typeof deriveFactDiff>, reanchored: StyleFactDiff["reanchored"], applied: StyleFactDiff["applied"], undecided: AffectedFact[]): StyleFactDiff {
  return {
    documentId,
    fromVersion,
    contentChanged,
    anchoredFacts: derived.anchored.length,
    unchanged: derived.unchanged.length,
    reanchored,
    applied,
    conflicts: undecided.map((a) => ({ fact: a.fact.ref, label: a.fact.label, reason: a.reason, previousPassages: a.fact.passages, missingQuotes: a.missingQuotes, candidateText: a.candidateText, note: restrictionNote(set, a.fact.ref) })),
    addedText: derived.addedText,
  };
}

export interface FactChangePlan {
  statements: Stmt[];
  affected: EntityVersion[];
  undo: FactUndo;
  diff: StyleFactDiff;
  conflictIds: string[];
}

/**
 * Everything a save does to the structured facts, to run in the same batch as the new document version.
 * `previous` is the active version being replaced; `next` is the text being saved.
 */
export async function planFactChanges(
  ctx: CommandContext,
  input: { documentId: string; fromVersion: number; toVersion: number; previous: ActiveText; next: ActiveText; resolutions: { fact: StyleFactRef; resolution: StyleFactResolution }[]; source: SourceRef },
): Promise<FactChangePlan> {
  const set = await loadStyleFacts(ctx.db, ctx.userId);
  const derived = deriveFactDiff(input.previous.content, input.next.content, input.next.sha256, set.facts);
  const w: Writes = { statements: [], affected: [], passagesNext: emptyMaps(), undo: emptyUndo() };

  const resolutions = new Map<string, StyleFactResolution>();
  for (const r of input.resolutions) {
    if (resolutions.has(factKey(r.fact))) throw new CommandError("invalid_command", "a fact has two resolutions in this save", { fact: r.fact });
    resolutions.set(factKey(r.fact), r.resolution);
  }
  const affectedKeys = new Set(derived.affected.map((a) => factKey(a.fact.ref)));
  const stray = input.resolutions.filter((r) => !affectedKeys.has(factKey(r.fact))).map((r) => r.fact);
  if (stray.length > 0) {
    throw new CommandError("invalid_command", "a resolution names a fact this edit does not affect; change that fact with its own command", { facts: stray, affected: derived.affected.map((a) => a.fact.ref) });
  }

  // 1. Facts whose passages all still occur: their references move to the new version.
  const reanchored: StyleFactDiff["reanchored"] = [];
  for (const u of derived.unchanged) if (moveAnchor(set, w, u.fact.ref, u.passages)) reanchored.push({ fact: u.fact.ref, label: u.fact.label, passages: u.passages });

  // 2. A passage the owner put back: the fact is anchored again and its open conflict is withdrawn.
  const open = await all<{ conflict_id: string; fact_kind: StyleFactRef["kind"]; fact_id: string }>(ctx.db, "SELECT conflict_id, fact_kind, fact_id FROM style_fact_conflicts WHERE user_id = ? AND status = 'open'", ctx.userId);
  const openByFact = new Map(open.map((c) => [`${c.fact_kind}:${c.fact_id}`, c.conflict_id]));
  const anchoredKeys = new Set(derived.anchored.map((f) => factKey(f.ref)));
  for (const fact of set.facts) {
    if (fact.passages.length === 0 || anchoredKeys.has(factKey(fact.ref))) continue;
    const located = fact.passages.map((p) => locateQuote(input.next.content, input.next.sha256, p.quote, p.section));
    if (!located.every((p) => p !== null)) continue;
    if (moveAnchor(set, w, fact.ref, located as PassageRef[])) reanchored.push({ fact: fact.ref, label: fact.label, passages: located as PassageRef[] });
    const conflictId = openByFact.get(factKey(fact.ref));
    if (conflictId) {
      w.statements.push(stmt("UPDATE style_fact_conflicts SET status = 'withdrawn', resolved_at = ?, resolved_command_id = ? WHERE user_id = ? AND conflict_id = ? AND status = 'open'", ctx.now, ctx.commandId, ctx.userId, conflictId));
      w.undo.conflictsClosed.push({ conflictId, status: "withdrawn" });
    }
  }

  // 3. Facts whose passage is gone or reworded: the owner's decision where he gave one, otherwise a visible conflict.
  const applied: StyleFactDiff["applied"] = [];
  const undecided: AffectedFact[] = [];
  const conflictIds: string[] = [];
  for (const a of derived.affected) {
    const resolution = resolutions.get(factKey(a.fact.ref));
    if (resolution) {
      planResolution(ctx, set, a.fact.ref, resolution, input.next, input.source, w);
      applied.push({ fact: a.fact.ref, label: a.fact.label, action: resolution.action });
      continue;
    }
    undecided.push(a);
    if (openByFact.has(factKey(a.fact.ref))) continue;
    const conflictId = ctx.newId("sfc");
    conflictIds.push(conflictId);
    w.statements.push(
      stmt(
        "INSERT INTO style_fact_conflicts (user_id, conflict_id, document_id, from_version, to_version, fact_kind, fact_id, fact_label, reason, previous_passages_json, missing_quotes_json, candidate_text, status, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
        ctx.userId, conflictId, input.documentId, input.fromVersion, input.toVersion, a.fact.ref.kind, a.fact.ref.id, a.fact.label, a.reason, JSON.stringify(a.fact.passages), JSON.stringify(a.missingQuotes), a.candidateText, ctx.commandId, ctx.now,
      ),
    );
    w.affected.push({ kind: "style_fact_conflict", id: conflictId, version: 1 });
    w.undo.conflictsOpened.push(conflictId);
  }

  return {
    statements: [...passageStatements(ctx.userId, w.passagesNext), ...w.statements],
    affected: w.affected,
    undo: w.undo,
    diff: toDiff(input.documentId, input.fromVersion, input.previous.sha256 !== input.next.sha256, set, derived, reanchored, applied, undecided),
    conflictIds,
  };
}

/** Statements and guards that compensate a set of fact changes. */
export function planFactUndo(ctx: CommandContext, undo: FactUndo): { statements: Stmt[]; preconditions: Precondition[] } {
  const statements: Stmt[] = [];
  const preconditions: Precondition[] = [];
  for (const r of undo.ruleVersions) {
    statements.push(
      stmt("UPDATE style_rules SET is_current = 0 WHERE user_id = ? AND rule_id = ? AND version = ?", ctx.userId, r.ruleId, r.version),
      stmt("UPDATE style_rules SET is_current = 1 WHERE user_id = ? AND rule_id = ? AND version = ?", ctx.userId, r.ruleId, r.previousVersion),
    );
  }
  if (undo.ruleVersions.length > 0) {
    preconditions.push({
      label: "rules not changed since",
      sql: "(SELECT COUNT(*) FROM style_rules WHERE user_id = ? AND is_current = 1 AND (rule_id || ':' || version) IN (SELECT j.value FROM json_each(?) AS j)) = ?",
      params: [ctx.userId, JSON.stringify(undo.ruleVersions.map((r) => `${r.ruleId}:${r.version}`)), undo.ruleVersions.length],
      class: "state",
    });
  }
  statements.push(...passageStatements(ctx.userId, undo.passagesPrevious));
  for (const m of undo.measurementsReplaced) {
    statements.push(
      stmt("UPDATE measurements SET superseded_by = ? WHERE user_id = ? AND measurement_id = ?", `withdrawn:${ctx.commandId}`, ctx.userId, m.newId),
      stmt("UPDATE measurements SET superseded_by = NULL WHERE user_id = ? AND measurement_id = ?", ctx.userId, m.oldId),
    );
  }
  if (undo.measurementsReplaced.length > 0) {
    preconditions.push({
      label: "measurements not changed since",
      sql: "(SELECT COUNT(*) FROM measurements WHERE user_id = ? AND superseded_by IS NULL AND measurement_id IN (SELECT j.value FROM json_each(?) AS j)) = ?",
      params: [ctx.userId, JSON.stringify(undo.measurementsReplaced.map((m) => m.newId)), undo.measurementsReplaced.length],
      class: "state",
    });
  }
  for (const s of undo.sizesReplaced) {
    statements.push(
      stmt("UPDATE size_experiences SET retired_at = ?, retired_by_command_id = ? WHERE user_id = ? AND size_experience_id = ?", ctx.now, ctx.commandId, ctx.userId, s.newId),
      stmt("UPDATE size_experiences SET retired_at = NULL, retired_by_command_id = NULL WHERE user_id = ? AND size_experience_id = ?", ctx.userId, s.oldId),
    );
  }
  for (const id of undo.sizesRetired) statements.push(stmt("UPDATE size_experiences SET retired_at = NULL, retired_by_command_id = NULL WHERE user_id = ? AND size_experience_id = ?", ctx.userId, id));
  for (const id of undo.conflictsOpened) {
    statements.push(stmt("UPDATE style_fact_conflicts SET status = 'withdrawn', resolved_at = ?, resolved_command_id = ? WHERE user_id = ? AND conflict_id = ?", ctx.now, ctx.commandId, ctx.userId, id));
  }
  if (undo.conflictsOpened.length > 0) {
    preconditions.push({
      label: "conflicts not decided since",
      sql: "(SELECT COUNT(*) FROM style_fact_conflicts WHERE user_id = ? AND status = 'open' AND conflict_id IN (SELECT j.value FROM json_each(?) AS j)) = ?",
      params: [ctx.userId, JSON.stringify(undo.conflictsOpened), undo.conflictsOpened.length],
      class: "state",
    });
  }
  for (const c of undo.conflictsClosed) {
    statements.push(stmt("UPDATE style_fact_conflicts SET status = 'open', resolved_at = NULL, resolved_command_id = NULL, resolution_json = NULL WHERE user_id = ? AND conflict_id = ? AND status = ?", ctx.userId, c.conflictId, c.status));
  }
  return { statements, preconditions };
}

function rowToConflict(r: any): StyleFactConflict {
  return {
    conflictId: r.conflict_id,
    documentId: r.document_id,
    fromVersion: r.from_version,
    toVersion: r.to_version,
    fact: { kind: r.fact_kind, id: r.fact_id },
    label: r.fact_label,
    reason: r.reason,
    previousPassages: json(r.previous_passages_json, []),
    missingQuotes: json(r.missing_quotes_json, []),
    candidateText: r.candidate_text,
    status: r.status,
    resolution: json(r.resolution_json, null),
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/** Conflicts between the saved profile text and structured facts; open ones by default, oldest first. */
export async function listStyleFactConflicts(db: Db, principal: Principal, opts: { status?: "open" | "resolved" | "withdrawn" | "all"; documentId?: string } = {}): Promise<StyleFactConflict[]> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const status = opts.status ?? "open";
  const rows = await all<any>(
    db,
    `SELECT * FROM style_fact_conflicts WHERE user_id = ? AND document_id = ?${status === "all" ? "" : " AND status = ?"} ORDER BY julianday(created_at), rowid`,
    ...[principal.userId, opts.documentId ?? "owner-profile", ...(status === "all" ? [] : [status])],
  );
  return rows.map(rowToConflict);
}

/**
 * What saving `content` would do to the structured facts, without writing anything. My style shows this
 * before Save so the owner can decide the affected facts in the same save. Every affected fact is listed
 * under `conflicts`; `applied` is empty because no decision has been given yet.
 */
export async function previewStyleSave(db: Db, principal: Principal, input: { content: string; documentId?: string }): Promise<StyleFactDiff> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const documentId = input.documentId ?? "owner-profile";
  const active = await first<{ version: number; content: string; content_sha256: string }>(db, "SELECT version, content, content_sha256 FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active'", principal.userId, documentId);
  if (!active) throw new CommandError("not_found", "there is no active style document to edit");
  const sha = await sha256Hex(new TextEncoder().encode(input.content));
  const set = await loadStyleFacts(db, principal.userId);
  const derived = deriveFactDiff(active.content, input.content, sha, set.facts);
  const reanchored = sha === active.content_sha256 ? [] : derived.unchanged.map((u) => ({ fact: u.fact.ref, label: u.fact.label, passages: u.passages }));
  return toDiff(documentId, active.version, sha !== active.content_sha256, set, derived, reanchored, [], derived.affected);
}

/** Decide a conflict an earlier save left open. The quote, when given, must occur in the active text. */
export const styleResolveFactConflict = define({
  type: "style.resolve_fact_conflict",
  schema: C["style.resolve_fact_conflict"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const c = await first<any>(ctx.db, "SELECT * FROM style_fact_conflicts WHERE user_id = ? AND conflict_id = ?", ctx.userId, p.conflictId);
    if (!c) throw new CommandError("not_found", `no profile conflict '${p.conflictId}'`);
    if (c.status !== "open") return { outcome: "noop", summary: `That conflict was already ${c.status}`, undo: { unavailableReason: "nothing changed" } };
    const active = await first<{ version: number; content: string; content_sha256: string }>(ctx.db, "SELECT version, content, content_sha256 FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active'", ctx.userId, c.document_id);
    if (!active) throw new CommandError("not_found", "there is no active style document");
    const set = await loadStyleFacts(ctx.db, ctx.userId);
    const ref: StyleFactRef = { kind: c.fact_kind, id: c.fact_id };
    const w: Writes = { statements: [], affected: [], passagesNext: emptyMaps(), undo: emptyUndo() };
    const source: SourceRef = { kind: "owner_statement", ref: `conflict:${p.conflictId}`, ...(p.resolution.note ? { note: p.resolution.note } : {}) };
    const current = ref.kind === "rule" ? set.rules.has(ref.id) : ref.kind === "measurement" ? set.measurements.has(ref.id) : set.sizes.has(ref.id);
    // The fact was superseded or retired by its own command since: there is nothing left to decide.
    if (current) planResolution(ctx, set, ref, p.resolution, { content: active.content, sha256: active.content_sha256 }, source, w);
    w.undo.conflictsClosed.push({ conflictId: p.conflictId, status: "resolved" });
    const closing = stmt(
      "UPDATE style_fact_conflicts SET status = 'resolved', resolution_json = ?, resolved_at = ?, resolved_command_id = ? WHERE user_id = ? AND conflict_id = ? AND status = 'open'",
      JSON.stringify(p.resolution), ctx.now, ctx.commandId, ctx.userId, p.conflictId,
    );
    const done = { keep: "kept as it was", replace: "replaced with the new values", retire: "retired" }[p.resolution.action];
    return {
      summary: current ? `Profile conflict resolved: ${c.fact_label} - ${done}` : `Profile conflict closed: ${c.fact_label} had already been superseded`,
      statements: [...passageStatements(ctx.userId, w.passagesNext), ...w.statements, closing],
      preconditions: [
        { label: "conflict still open", sql: "(SELECT status FROM style_fact_conflicts WHERE user_id = ? AND conflict_id = ?) = 'open'", params: [ctx.userId, p.conflictId], class: "internal" },
        { label: "style document unchanged since read", sql: "(SELECT version FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active') = ?", params: [ctx.userId, c.document_id, active.version], class: "internal" },
      ],
      affected: [{ kind: "style_fact_conflict", id: p.conflictId, version: 2 }, ...w.affected],
      outbox: [{ topic: "style", entityKind: "style", entityId: c.document_id, revision: ctx.styleRevision + 1 }],
      result: { conflictId: p.conflictId, fact: ref, action: p.resolution.action, factChanged: current },
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { data: { facts: w.undo } },
    };
  },
  async planUndo(ctx, _original, data) {
    const undo = planFactUndo(ctx, data.facts as FactUndo);
    return {
      summary: "Profile conflict reopened; the fact is as it was before the decision",
      statements: undo.statements,
      preconditions: undo.preconditions,
      changes: { styleChanged: true },
      bumpStyle: true,
      undo: { unavailableReason: "this is already an undo" },
    };
  },
});
