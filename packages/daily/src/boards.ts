/**
 * Boards: composed, validated, published and revised through the shared command service.
 *
 * A board has immutable revisions. Every published option is a complete outfit that passed validation
 * against the state the SAME command read; nothing is ever a pending placeholder. The revision, its
 * probability exposure and its Calendar projection effect commit in one D1 batch with the receipt.
 */
import type { Role } from "@garderobe/contracts";
import { DAILY_COMMANDS, DayBrief } from "@garderobe/contracts/ext/daily";
import type { BoardDocument, DayConditions, OptionEvidence, OutfitSlot, OutfitValidation } from "@garderobe/contracts/ext/daily";
import {
  CommandError, define, exposurePublish, exposureSelect, first, localDateOf, stmt,
  type CommandContext, type CommandPlan, type CommandRegistry, type PlannedEffect, type PlannedOutbox, type Precondition, type Stmt,
} from "@garderobe/domain";
import type { EntityVersion } from "@garderobe/contracts";
import { assembleContext, calendarSnapshotById, weatherSnapshotById } from "./context.ts";
import { factualReason, findReplacement } from "./compose.ts";
import { dayLineFor, loadBoard, loadOptions, loadRevision, pauseCovering, type BoardRow, type StoredOption } from "./document.ts";
import { parseScope, type RecommendationContext } from "./model.ts";
import { validateCandidate } from "./validate.ts";
import { AVAILABILITY_MODEL_VERSION_OR_DEFAULT, COMPOSER_VERSION } from "./version.ts";

export const CALENDAR_EFFECT_KIND = "calendar.project_board";
export const projectionTarget = (scope: string, localDate: string): string => `outfit-event:${scope}:${localDate}`;

export interface DraftOption {
  optionId?: string;
  slots: OutfitSlot[];
  footwearAlternatives: string[];
  reason: string;
  suitsEventIds: string[];
  evidence: OptionEvidence;
  changed: boolean;
}

export interface RevisionDraft {
  existing: BoardRow | null;
  scope: string;
  localDate: string;
  timezone: string;
  reason: BoardDocument["reason"];
  requestedCount: number;
  brief: DayBrief;
  conditions: DayConditions;
  context: Record<string, unknown>;
  weatherLine: string | null;
  suitabilityLine: string | null;
  notice: string | null;
  changes: string[];
  weatherSnapshotId: string | null;
  calendarSnapshotId: string | null;
  offered: DraftOption[];
  reserves: DraftOption[];
  projectToCalendar: boolean;
  writeExposure: boolean;
  needsReplenishment: boolean;
}

export interface RevisionWrite {
  boardId: string;
  revision: number;
  statements: Stmt[];
  preconditions: Precondition[];
  effects: PlannedEffect[];
  affected: EntityVersion[];
  outbox: PlannedOutbox[];
  exposureId: string | null;
  optionIds: string[];
  selectionKept: boolean;
}

/** Slim, storable evidence: what was checked, against which weather basis, with which probabilities. */
export function optionEvidence(validation: OutfitValidation, jointAvailability: number, extra: Pick<OptionEvidence, "source" | "explanationSource" | "removedClaims">): OptionEvidence {
  const e = validation.evidence as Record<string, unknown>;
  return {
    validation: {
      valid: validation.valid,
      violations: validation.violations,
      evidence: { forDate: e.forDate, scope: e.scope, mode: e.mode, wearableToday: e.wearableToday, conditions: e.conditions, weatherBasis: e.weatherBasis, availability: e.availability },
    },
    jointAvailability,
    availabilityModelVersion: AVAILABILITY_MODEL_VERSION_OR_DEFAULT,
    ...extra,
  };
}

export function revisionContext(rc: RecommendationContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revisions: rc.revisions,
    sources: rc.sources,
    rules: rc.rules.versions,
    rulesNotEnforced: rc.rules.notEnforced.map((r) => ({ key: r.key, status: r.status })),
    availabilityModel: AVAILABILITY_MODEL_VERSION_OR_DEFAULT,
    estimatorParameters: { ...rc.settings.estimator, parameterStatus: "hypothesis" },
    composer: COMPOSER_VERSION,
    ...extra,
  };
}

/** One brief explanation outside the outfit copy: source limitations first, then any shortage. */
export function boardNotice(rc: RecommendationContext, shortage: string | null): string | null {
  const parts: string[] = [];
  if (rc.conditions.freshness === "unavailable") parts.push("The forecast is unavailable, so temperature rules could not be checked.");
  else if (rc.conditions.freshness === "stale") parts.push(rc.weather?.limitation ?? "The forecast is older than usual.");
  if (rc.calendar?.status === "not_connected") parts.push("Calendar is not connected, so the day's events were not considered.");
  else if (rc.calendar?.status === "error") parts.push("Calendar could not be read, so the day's events were not considered.");
  else if (rc.calendar?.status === "stale") parts.push(rc.calendar.limitation ?? "The calendar read is older than usual.");
  if (shortage) parts.push(shortage);
  return parts.length > 0 ? parts.join(" ") : null;
}

const slotOf = (o: { slots: OutfitSlot[] }, role: Role) => o.slots.find((s) => s.role === role)?.garmentId ?? null;

/** Changed-item receipt lines between two offered sets, in ledger names. */
export function describeChanges(rc: RecommendationContext, before: StoredOption[], after: DraftOption[], why: Map<string, string> = new Map()): string[] {
  const name = (id: string) => rc.garments.get(id)?.name ?? "a removed garment";
  const out: string[] = [];
  const beforeById = new Map(before.map((o, i) => [o.optionId, { o, n: i + 1 }]));
  after.forEach((o, i) => {
    const prev = o.optionId ? beforeById.get(o.optionId) : undefined;
    if (!prev) {
      if (before.length > 0) out.push(`Option ${i + 1} is new: ${[slotOf(o, "top"), slotOf(o, "bottom")].filter(Boolean).map((id) => name(id!)).join(" with ")}`);
      return;
    }
    for (const s of o.slots) {
      const old = slotOf(prev.o, s.role);
      if (old && old !== s.garmentId) out.push(`Option ${i + 1}: ${name(old)} replaced by ${name(s.garmentId)}${why.get(old) ? ` (${why.get(old)})` : ""}`);
      else if (!old) out.push(`Option ${i + 1}: ${name(s.garmentId)} added`);
    }
    for (const s of prev.o.slots) if (!slotOf(o, s.role)) out.push(`Option ${i + 1}: ${name(s.garmentId)} removed${why.get(s.garmentId) ? ` (${why.get(s.garmentId)})` : ""}`);
  });
  const kept = new Set(after.map((o) => o.optionId).filter(Boolean));
  for (const { o, n } of beforeById.values()) {
    if (kept.has(o.optionId)) continue;
    const blamed = o.slots.map((s) => s.garmentId).find((id) => why.has(id));
    out.push(`Option ${n} (${[slotOf(o, "top"), slotOf(o, "bottom")].filter(Boolean).map((id) => name(id!)).join(" with ")}) was withdrawn${blamed ? `: ${name(blamed)} ${why.get(blamed)}` : ""}`);
  }
  return out;
}

/** Build the statements of one new board revision with its exposure set and Calendar effect. */
export async function planRevisionWrite(ctx: CommandContext, draft: RevisionDraft): Promise<RevisionWrite> {
  const { existing } = draft;
  const boardId = existing?.board_id ?? ctx.newId("brd");
  const revision = (existing?.current_revision ?? 0) + 1;
  const statements: Stmt[] = [];
  const preconditions: Precondition[] = [];
  const offered = draft.offered.map((o) => ({ ...o, optionId: o.optionId ?? ctx.newId("opt") }));
  const reserves = draft.reserves.map((o) => ({ ...o, optionId: o.optionId ?? ctx.newId("opt") }));

  // A selection is an intention tied to an option ID; it survives while that option is still offered.
  const selected = existing?.selected_option_id ? offered.find((o) => o.optionId === existing.selected_option_id) : undefined;
  const selectedFootwear = selected && existing?.selected_footwear_id && (slotOf(selected, "footwear") === existing.selected_footwear_id || selected.footwearAlternatives.includes(existing.selected_footwear_id)) ? existing.selected_footwear_id : null;

  let exposureId: string | null = null;
  const exposureStatements: Stmt[] = [];
  if (draft.writeExposure && offered.length > 0) {
    exposureId = ctx.newId("exp");
    const plan = await exposurePublish.plan(ctx, {
      exposureId,
      localDate: draft.localDate,
      sourceKind: "board",
      sourceRef: `${boardId}:r${revision}`,
      options: offered.map((o) => {
        const footwear = slotOf(o, "footwear");
        const alternatives = footwear && o.footwearAlternatives.length > 0 ? [[footwear, ...o.footwearAlternatives]] : [];
        return { optionId: o.optionId, garmentIds: o.slots.filter((s) => s.role !== "neckwear" && !(alternatives.length > 0 && s.role === "footwear")).map((s) => s.garmentId), alternativeGroups: alternatives };
      }),
      supersedes: existing?.exposure_id ? [existing.exposure_id] : [],
    });
    exposureStatements.push(...(plan.statements ?? []));
    if (selected) {
      exposureStatements.push(stmt("UPDATE exposure_sets SET selected_option_id = ?, chosen_alternatives_json = ?, status = 'selected' WHERE user_id = ? AND exposure_id = ?", selected.optionId, JSON.stringify(selectedFootwear && selected.footwearAlternatives.length > 0 ? [selectedFootwear] : []), ctx.userId, exposureId));
    }
  } else if (existing?.exposure_id) {
    exposureStatements.push(stmt("UPDATE exposure_sets SET status = 'superseded', updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status IN ('open', 'selected')", ctx.now, ctx.userId, existing.exposure_id));
  }

  if (existing) {
    preconditions.push({ label: `board ${boardId} unchanged since read`, sql: "(SELECT current_revision FROM boards WHERE user_id = ? AND board_id = ?) = ?", params: [ctx.userId, boardId, existing.current_revision], class: "internal" });
    statements.push(
      stmt(
        "UPDATE boards SET current_revision = ?, selected_option_id = ?, selected_footwear_id = ?, selected_at = ?, exposure_id = ?, needs_replenishment = ?, updated_at = ? WHERE user_id = ? AND board_id = ?",
        revision, selected ? selected.optionId : null, selectedFootwear, selected ? existing.selected_at : null, exposureId, draft.needsReplenishment, ctx.now, ctx.userId, boardId,
      ),
    );
  } else {
    preconditions.push({ label: "no board exists yet for this day", sql: "NOT EXISTS (SELECT 1 FROM boards WHERE user_id = ? AND scope = ? AND local_date = ?)", params: [ctx.userId, draft.scope, draft.localDate], class: "internal" });
    statements.push(
      stmt(
        "INSERT INTO boards (user_id, board_id, scope, local_date, timezone, current_revision, status, exposure_id, needs_replenishment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)",
        ctx.userId, boardId, draft.scope, draft.localDate, draft.timezone, revision, exposureId, draft.needsReplenishment, ctx.now, ctx.now,
      ),
    );
  }
  const dayLine = await dayLineFor(ctx.db, ctx.userId, draft.localDate, draft.timezone, draft.weatherLine, draft.calendarSnapshotId);
  statements.push(
    stmt(
      `INSERT INTO board_revisions (user_id, board_id, revision, reason, requested_count, brief_json, conditions_json, context_json, day_line, weather_line, suitability_line, notice, changes_json,
                                    weather_snapshot_id, calendar_snapshot_id, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.userId, boardId, revision, draft.reason, draft.requestedCount, JSON.stringify(draft.brief), JSON.stringify(draft.conditions), JSON.stringify(draft.context), dayLine, draft.weatherLine, draft.suitabilityLine,
      draft.notice, JSON.stringify(draft.changes), draft.weatherSnapshotId, draft.calendarSnapshotId, ctx.commandId, ctx.now,
    ),
  );
  const writeOption = (o: DraftOption & { optionId: string }, state: "offered" | "reserve", position: number) => {
    statements.push(
      stmt(
        "INSERT INTO board_options (user_id, board_id, revision, option_id, state, position, slots_json, footwear_alternatives_json, reason, suits_event_ids_json, evidence_json, changed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ctx.userId, boardId, revision, o.optionId, state, position, JSON.stringify(o.slots), JSON.stringify(o.footwearAlternatives), o.reason, JSON.stringify(o.suitsEventIds), JSON.stringify(o.evidence), o.changed,
      ),
    );
    for (const s of o.slots) statements.push(stmt("INSERT INTO board_option_garments (user_id, board_id, revision, option_id, garment_id, role, alternative) VALUES (?, ?, ?, ?, ?, ?, 0)", ctx.userId, boardId, revision, o.optionId, s.garmentId, s.role));
    for (const id of o.footwearAlternatives) statements.push(stmt("INSERT INTO board_option_garments (user_id, board_id, revision, option_id, garment_id, role, alternative) VALUES (?, ?, ?, ?, ?, 'footwear', 1)", ctx.userId, boardId, revision, o.optionId, id));
  };
  offered.forEach((o, i) => writeOption(o, "offered", i + 1));
  reserves.forEach((o, i) => writeOption(o, "reserve", i + 1));
  statements.push(...exposureStatements);

  const effects: PlannedEffect[] = [];
  if (draft.projectToCalendar) {
    const targetKey = projectionTarget(draft.scope, draft.localDate);
    effects.push({ kind: CALENDAR_EFFECT_KIND, targetKey, operationKey: `${CALENDAR_EFFECT_KIND}:${targetKey}:${ctx.commandId}`, desiredRevision: ctx.nowMs, payload: { boardId, revision, localDate: draft.localDate, scope: draft.scope } });
  }
  return {
    boardId,
    revision,
    statements,
    preconditions,
    effects,
    affected: [{ kind: "board", id: boardId, version: revision }],
    outbox: [{ topic: "board.revision", entityKind: "board", entityId: boardId, revision, payload: { localDate: draft.localDate, scope: draft.scope, reason: draft.reason } }],
    exposureId,
    optionIds: offered.map((o) => o.optionId),
    selectionKept: !!selected,
  };
}

/** A day whose wear is already recorded keeps no open exposure: the observation replaced the uncertainty. */
async function wearRecordedOn(ctx: CommandContext, localDate: string): Promise<boolean> {
  const row = await first<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND wearing_date = ? AND status = 'active'", ctx.userId, localDate);
  return (row?.n ?? 0) > 0;
}

function safeReason(rc: RecommendationContext, text: string, slots: OutfitSlot[]): { reason: string; replaced: boolean } {
  const prose = text.replace(/\s+/g, " ").trim();
  if (prose.length === 0 || prose.length > 400 || /(gmt_[0-9a-f]{6,}|\d\s?%|https?:|[<>{}])/i.test(prose)) return { reason: factualReason(rc, slots), replaced: true };
  return { reason: prose, replaced: false };
}

const ALREADY = { unavailableReason: "publish a new revision instead; earlier revisions stay in history" };

export const boardPublish = define({
  type: "board.publish",
  schema: DAILY_COMMANDS["board.publish"],
  class: "system",
  requiredScope: "write",
  allowedAuthorizations: ["standing_policy", "system_schedule", "owner_tap", "owner_statement"],
  async plan(ctx, p): Promise<CommandPlan> {
    let scope: ReturnType<typeof parseScope>;
    try {
      scope = parseScope(p.scope);
    } catch {
      throw new CommandError("invalid_command", `invalid board scope '${p.scope}'`);
    }
    const automatic = ctx.envelope.authorization === "system_schedule" || ctx.envelope.authorization === "standing_policy";
    const existing = await loadBoard(ctx.db, ctx.userId, { date: p.localDate, scope: p.scope });
    if (existing?.status === "worn") throw new CommandError("precondition_failed", "the day's outfit is already recorded; the board is history and is not restyled", { boardId: existing.board_id });
    const suppression = await first<{ reason: string }>(ctx.db, "SELECT reason FROM board_suppressions WHERE user_id = ? AND scope = ? AND local_date = ? AND status = 'active'", ctx.userId, p.scope, p.localDate);
    if (suppression || existing?.status === "suppressed") throw new CommandError("precondition_failed", "this day's board was removed; restore it before publishing again", { localDate: p.localDate });
    const paused = await pauseCovering(ctx.db, ctx.userId, p.localDate);
    if (paused && automatic) throw new CommandError("precondition_failed", "recommendations are paused for this day; nothing was published", { pauseId: paused.pauseId });
    if (scope.tripId) {
      const trip = await first<{ status: string; departs_on: string; returns_on: string }>(ctx.db, "SELECT status, departs_on, returns_on FROM trips WHERE user_id = ? AND trip_id = ?", ctx.userId, scope.tripId);
      if (!trip || trip.status !== "planned") throw new CommandError("not_found", `no active trip '${scope.tripId}'`);
      if (p.localDate < trip.departs_on || p.localDate > trip.returns_on) throw new CommandError("invalid_command", "that date is outside the trip");
    }

    const weather = p.weatherSnapshotId ? await weatherSnapshotById(ctx.db, ctx.userId, p.weatherSnapshotId) : undefined;
    if (p.weatherSnapshotId && !weather) throw new CommandError("not_found", "unknown weather snapshot");
    const calendar = p.calendarSnapshotId ? await calendarSnapshotById(ctx.db, ctx.userId, p.calendarSnapshotId) : undefined;
    if (p.calendarSnapshotId && !calendar) throw new CommandError("not_found", "unknown calendar snapshot");
    const rc = await assembleContext(ctx.db, ctx.principal, { localDate: p.localDate, nowMs: ctx.nowMs, scope: p.scope, brief: p.brief, weather, calendar, withoutProfileText: true });
    if (p.localDate < rc.today) throw new CommandError("invalid_command", "a board cannot be published for a past day", { localDate: p.localDate, today: rc.today });

    // Recheck every candidate against the state this command read: a stale candidate cannot commit.
    const previous = existing ? await loadOptions(ctx.db, ctx.userId, existing.board_id, existing.current_revision) : [];
    const previousById = new Map(previous.map((o) => [o.optionId, o]));
    const dropped: { position: string; violations: string[] }[] = [];
    const usedTops = new Set<string>();
    const usedKeys = new Set<string>();
    const accept = (input: (typeof p.options)[number], label: string): DraftOption | null => {
      const validation = validateCandidate(rc, input, { requirePairedFootwear: true });
      if (!validation.valid) {
        dropped.push({ position: label, violations: validation.violations.filter((x) => x.severity === "blocking").map((x) => `${x.code}: ${x.message}`) });
        return null;
      }
      const top = slotOf(input, "top") ?? slotOf(input, "one_piece");
      const key = input.slots.map((s) => `${s.role}:${s.garmentId}`).sort().join("|");
      if ((top && usedTops.has(top) && !p.brief.include.includes(top)) || usedKeys.has(key)) {
        dropped.push({ position: label, violations: ["duplicate: the same shirt is already offered on this board"] });
        return null;
      }
      if (top) usedTops.add(top);
      usedKeys.add(key);
      const text = safeReason(rc, input.reason, input.slots);
      const prev = input.optionId ? previousById.get(input.optionId) : undefined;
      const same = prev && JSON.stringify(prev.slots) === JSON.stringify(input.slots) && JSON.stringify(prev.footwearAlternatives) === JSON.stringify(input.footwearAlternatives);
      return {
        ...(prev ? { optionId: prev.optionId } : {}),
        slots: input.slots,
        footwearAlternatives: input.footwearAlternatives,
        reason: text.reason,
        suitsEventIds: input.suitsEventIds,
        evidence: optionEvidence(validation, Number((validation.evidence as any).availability.jointAvailability), { source: input.source, explanationSource: text.replaced ? "factual" : input.explanationSource, removedClaims: input.removedClaims }),
        changed: existing !== null && !same,
      };
    };
    const offered: DraftOption[] = [];
    p.options.forEach((o, i) => {
      const d = accept(o, `option ${i + 1}`);
      if (d) offered.push(d);
    });
    const reservePool: DraftOption[] = [];
    p.reserves.forEach((o, i) => {
      const d = accept(o, `reserve ${i + 1}`);
      if (d) reservePool.push(d);
    });
    // A dropped option is replaced from the complete reserves; the count is never padded.
    while (offered.length < Math.min(p.requestedCount, p.options.length) && reservePool.length > 0) offered.push({ ...reservePool.shift()!, changed: existing !== null });
    if (offered.length === 0) {
      throw new CommandError("precondition_failed", "no candidate is a valid outfit against the current wardrobe; nothing was published", { dropped });
    }
    const reserves = reservePool.slice(0, rc.daily.reserveCount);

    const shortage = offered.length < p.requestedCount ? (p.notice ?? `${offered.length} valid ${offered.length === 1 ? "outfit" : "outfits"} instead of ${p.requestedCount}.`) : null;
    const previousOffered = previous.filter((o) => o.state === "offered");
    const changes = existing ? (p.reason === "compose" || p.reason === "rebuild" || p.reason === "resume" ? ["The board was recomposed."] : describeChanges(rc, previousOffered, offered)) : [];
    const suitable = offered.filter((o) => o.suitsEventIds.length > 0).length;
    const event = rc.calendar?.events.find((e) => offered.some((o) => o.suitsEventIds.includes(e.eventId)));
    const numberWords = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
    const title = event ? event.title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) : null;
    const suitabilityLine = event && suitable > 0 ? `${suitable === offered.length && suitable > 1 ? "All" : numberWords[suitable]} ${suitable === 1 ? "option works" : "options work"} for “${title}”.` : null;

    const dayScope = !scope.evening;
    const write = await planRevisionWrite(ctx, {
      existing,
      scope: p.scope,
      localDate: p.localDate,
      timezone: rc.timezone,
      reason: p.reason,
      requestedCount: p.requestedCount,
      brief: rc.brief,
      conditions: rc.conditions,
      context: revisionContext(rc, { composedAgainst: p.composedAgainst ?? null, droppedAtPublish: dropped }),
      weatherLine: rc.weather && rc.weather.freshness !== "unavailable" ? rc.weather.line : null,
      suitabilityLine,
      notice: boardNotice(rc, shortage),
      changes,
      weatherSnapshotId: rc.weather?.snapshotId ?? null,
      calendarSnapshotId: rc.calendar?.snapshotId ?? null,
      offered,
      reserves,
      projectToCalendar: dayScope && !paused,
      writeExposure: dayScope && !(await wearRecordedOn(ctx, p.localDate)),
      needsReplenishment: offered.length < p.requestedCount,
    });
    const preconditions = [...write.preconditions];
    if (automatic) {
      // Pause and suppression are rechecked inside the batch, so a queued job cannot publish across them.
      preconditions.push(
        { label: "recommendations are not paused for this day", sql: "NOT EXISTS (SELECT 1 FROM service_pauses WHERE user_id = ? AND status = 'active' AND starts_on <= ? AND (resume_on IS NULL OR resume_on > ?))", params: [ctx.userId, p.localDate, p.localDate], class: "state" },
        { label: "this day's board was not removed", sql: "NOT EXISTS (SELECT 1 FROM board_suppressions WHERE user_id = ? AND scope = ? AND local_date = ? AND status = 'active')", params: [ctx.userId, p.scope, p.localDate], class: "state" },
      );
    }
    return {
      summary: `Board for ${p.localDate} published (revision ${write.revision}): ${offered.length} ${offered.length === 1 ? "outfit" : "outfits"}${offered.length < p.requestedCount ? ` of ${p.requestedCount} requested` : ""}${dropped.length ? `; ${dropped.length} stale or invalid candidate${dropped.length === 1 ? "" : "s"} not published` : ""}`,
      statements: write.statements,
      preconditions,
      affected: write.affected,
      effects: write.effects,
      outbox: write.outbox,
      result: { boardId: write.boardId, revision: write.revision, localDate: p.localDate, scope: p.scope, offered: offered.length, reserves: reserves.length, requestedCount: p.requestedCount, dropped, optionIds: write.optionIds, exposureId: write.exposureId },
      bumpWardrobe: write.exposureId !== null || !!existing?.exposure_id,
      undo: ALREADY,
    };
  },
});

async function requireBoard(ctx: CommandContext, boardId: string): Promise<BoardRow> {
  const board = await loadBoard(ctx.db, ctx.userId, { boardId });
  if (!board) throw new CommandError("not_found", `no board '${boardId}'`);
  return board;
}

export const boardSelect = define({
  type: "board.select",
  schema: DAILY_COMMANDS["board.select"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const board = await requireBoard(ctx, p.boardId);
    if (board.status !== "active") throw new CommandError("precondition_failed", board.status === "worn" ? "the day's outfit is already recorded" : "this day's board was removed");
    const options = (await loadOptions(ctx.db, ctx.userId, board.board_id, board.current_revision)).filter((o) => o.state === "offered");
    const option = p.optionId === null ? null : options.find((o) => o.optionId === p.optionId);
    if (p.optionId !== null && !option) throw new CommandError("not_found", "that option is not on the current board revision; choose from the current board", { revision: board.current_revision });
    let footwear: string | null = null;
    if (option) {
      const main = slotOf(option, "footwear");
      footwear = p.footwearGarmentId ?? (option.footwearAlternatives.length === 0 ? main : null);
      if (footwear && footwear !== main && !option.footwearAlternatives.includes(footwear)) throw new CommandError("invalid_command", "that shoe is not one of this option's footwear choices");
    }
    const statements: Stmt[] = [
      stmt("UPDATE boards SET selected_option_id = ?, selected_footwear_id = ?, selected_at = ?, updated_at = ? WHERE user_id = ? AND board_id = ?", option?.optionId ?? null, footwear, option ? ctx.now : null, ctx.now, ctx.userId, board.board_id),
    ];
    const preconditions: Precondition[] = [{ label: `board ${board.board_id} unchanged since read`, sql: "(SELECT current_revision FROM boards WHERE user_id = ? AND board_id = ?) = ?", params: [ctx.userId, board.board_id, board.current_revision], class: "internal" }];
    let bump = false;
    if (board.exposure_id) {
      const exposure = await first<{ status: string }>(ctx.db, "SELECT status FROM exposure_sets WHERE user_id = ? AND exposure_id = ?", ctx.userId, board.exposure_id);
      if (exposure && (exposure.status === "open" || exposure.status === "selected")) {
        const chosen = option && footwear && option.footwearAlternatives.length > 0 ? [footwear] : [];
        const sub = await exposureSelect.plan(ctx, { exposureId: board.exposure_id, optionId: option?.optionId ?? null, chosenAlternatives: chosen });
        statements.push(...(sub.statements ?? []));
        bump = true;
      }
    }
    const name = option ? `option ${options.indexOf(option) + 1}` : null;
    return {
      summary: option ? `Chosen for ${board.local_date}: ${name} (an intention, not a recorded wear)` : `Selection cleared for ${board.local_date}`,
      statements,
      preconditions,
      affected: [{ kind: "board", id: board.board_id, version: board.current_revision }],
      outbox: [{ topic: "board.selection", entityKind: "board", entityId: board.board_id, revision: board.current_revision }],
      result: { boardId: board.board_id, revision: board.current_revision, selectedOptionId: option?.optionId ?? null, footwearGarmentId: footwear },
      bumpWardrobe: bump,
      undo: { data: { boardId: board.board_id, previousOptionId: board.selected_option_id, previousFootwearId: board.selected_footwear_id, previousAt: board.selected_at } },
    };
  },
  async planUndo(ctx, _original, data): Promise<CommandPlan> {
    const board = await requireBoard(ctx, data.boardId);
    const options = (await loadOptions(ctx.db, ctx.userId, board.board_id, board.current_revision)).filter((o) => o.state === "offered");
    const restorable = data.previousOptionId === null || options.some((o) => o.optionId === data.previousOptionId);
    const optionId = restorable ? data.previousOptionId : null;
    const statements: Stmt[] = [stmt("UPDATE boards SET selected_option_id = ?, selected_footwear_id = ?, selected_at = ?, updated_at = ? WHERE user_id = ? AND board_id = ?", optionId, restorable ? data.previousFootwearId : null, restorable ? data.previousAt : null, ctx.now, ctx.userId, board.board_id)];
    if (board.exposure_id) {
      statements.push(stmt("UPDATE exposure_sets SET selected_option_id = ?, chosen_alternatives_json = '[]', status = ?, updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status IN ('open', 'selected')", optionId, optionId ? "selected" : "open", ctx.now, ctx.userId, board.exposure_id));
    }
    return { summary: "Selection restored to what it was", statements, affected: [{ kind: "board", id: board.board_id, version: board.current_revision }], bumpWardrobe: !!board.exposure_id, undo: { unavailableReason: "this is already an undo" } };
  },
});

/** Rebuild the recommendation context a board revision was validated in (its stored weather basis and brief). */
export async function contextForBoard(ctx: CommandContext, board: BoardRow): Promise<{ rc: RecommendationContext; options: StoredOption[]; requestedCount: number; suitabilityLine: string | null }> {
  const revision = await loadRevision(ctx.db, ctx.userId, board.board_id, board.current_revision);
  if (!revision) throw new CommandError("internal", "the board's current revision is missing");
  const weather = revision.weather_snapshot_id ? await weatherSnapshotById(ctx.db, ctx.userId, revision.weather_snapshot_id) : null;
  const calendar = revision.calendar_snapshot_id ? await calendarSnapshotById(ctx.db, ctx.userId, revision.calendar_snapshot_id) : null;
  const rc = await assembleContext(ctx.db, ctx.principal, { localDate: board.local_date, nowMs: ctx.nowMs, scope: board.scope, brief: revision.brief, conditions: revision.conditions, weather, calendar, withoutProfileText: true });
  return { rc, options: await loadOptions(ctx.db, ctx.userId, board.board_id, board.current_revision), requestedCount: revision.requested_count, suitabilityLine: revision.suitability_line };
}

export function storedToDraft(o: StoredOption, changed = false): DraftOption {
  return { optionId: o.optionId, slots: o.slots, footwearAlternatives: o.footwearAlternatives, reason: o.reason, suitsEventIds: o.suitsEventIds, evidence: o.evidence, changed };
}

export const boardSwapSlot = define({
  type: "board.swap_slot",
  schema: DAILY_COMMANDS["board.swap_slot"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const board = await requireBoard(ctx, p.boardId);
    if (board.status !== "active") throw new CommandError("precondition_failed", board.status === "worn" ? "the day's outfit is already recorded; amend the wear instead" : "this day's board was removed");
    const { rc, options, requestedCount, suitabilityLine } = await contextForBoard(ctx, board);
    const offered = options.filter((o) => o.state === "offered");
    const option = offered.find((o) => o.optionId === p.optionId);
    if (!option) throw new CommandError("not_found", "that option is not on the current board revision", { revision: board.current_revision });
    const others = offered.filter((o) => o.optionId !== option.optionId);
    const avoid = new Set<string>();
    if (p.role === "top" || p.role === "bottom") for (const o of others) { const id = slotOf(o, p.role); if (id) avoid.add(id); }

    let slots: OutfitSlot[];
    let validation: OutfitValidation;
    const previousId = slotOf(option, p.role);
    if (p.garmentId) {
      // The owner's own pick: validated as given. It is an explicit request, which admits an occasional
      // piece - and never makes absent, restricted or too-warm stock acceptable.
      slots = previousId ? option.slots.map((s) => (s.role === p.role ? { role: p.role, garmentId: p.garmentId! } : s)) : [...option.slots, { role: p.role, garmentId: p.garmentId }];
      validation = validateCandidate(rc, { slots, footwearAlternatives: option.footwearAlternatives.filter((id) => id !== p.garmentId) }, { requirePairedFootwear: true, explicitGarmentIds: [p.garmentId], ignoreBriefInclusions: true });
      if (!validation.valid) {
        const blockers = validation.violations.filter((x) => x.severity === "blocking");
        throw new CommandError("precondition_failed", `that swap does not make a valid outfit: ${blockers.map((x) => x.message).join("; ")}; nothing was changed`, { violations: blockers });
      }
    } else {
      const found = findReplacement(rc, option, p.role, { avoidGarmentIds: avoid, validate: { ignoreBriefInclusions: true } });
      if (!found) throw new CommandError("precondition_failed", `nothing else eligible can take that ${p.role.replace("_", " ")} slot today; the option is unchanged`);
      slots = found.slots;
      validation = found.validation;
    }
    const alternatives = option.footwearAlternatives.filter((id) => !slots.some((s) => s.garmentId === id));
    const swapped: DraftOption = {
      optionId: option.optionId,
      slots,
      footwearAlternatives: alternatives,
      reason: factualReason(rc, slots),
      suitsEventIds: option.suitsEventIds,
      evidence: optionEvidence(validation, Number((validation.evidence as any).availability.jointAvailability), { source: "owner_swap", explanationSource: "factual", removedClaims: [] }),
      changed: true,
    };
    const nextOffered = offered.map((o) => (o.optionId === option.optionId ? swapped : storedToDraft(o)));
    const revision = (await loadRevision(ctx.db, ctx.userId, board.board_id, board.current_revision))!;
    const write = await planRevisionWrite(ctx, {
      existing: board,
      scope: board.scope,
      localDate: board.local_date,
      timezone: board.timezone,
      reason: "swap",
      requestedCount,
      brief: revision.brief,
      conditions: revision.conditions,
      context: revisionContext(rc),
      weatherLine: revision.weather_line,
      suitabilityLine,
      notice: revision.notice,
      changes: describeChanges(rc, offered, nextOffered),
      weatherSnapshotId: revision.weather_snapshot_id,
      calendarSnapshotId: revision.calendar_snapshot_id,
      offered: nextOffered,
      reserves: options.filter((o) => o.state === "reserve" && !o.slots.some((s) => slots.some((n) => n.garmentId === s.garmentId && (s.role === "top" || s.role === "bottom")))).map((o) => storedToDraft(o)),
      projectToCalendar: !parseScope(board.scope).evening && !(await pauseCovering(ctx.db, ctx.userId, board.local_date)),
      writeExposure: !parseScope(board.scope).evening && !(await wearRecordedOn(ctx, board.local_date)),
      needsReplenishment: board.needs_replenishment === 1,
    });
    const newId = slotOf({ slots }, p.role)!;
    return {
      summary: `Option ${offered.indexOf(option) + 1} for ${board.local_date}: ${previousId ? `${rc.garments.get(previousId)?.name ?? "a piece"} swapped for ` : "added "}${rc.garments.get(newId)?.name ?? "a piece"}; the rest of the outfit is unchanged`,
      statements: write.statements,
      preconditions: write.preconditions,
      affected: write.affected,
      effects: write.effects,
      outbox: write.outbox,
      result: { boardId: board.board_id, revision: write.revision, optionId: option.optionId, role: p.role, garmentId: newId, replacedGarmentId: previousId },
      bumpWardrobe: write.exposureId !== null || !!board.exposure_id,
      undo: { unavailableReason: "swap the piece back instead; the earlier revision stays in history" },
    };
  },
});

export const boardSuppress = define({
  type: "board.suppress",
  schema: DAILY_COMMANDS["board.suppress"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "system_schedule"],
  async plan(ctx, p): Promise<CommandPlan> {
    try {
      parseScope(p.scope);
    } catch {
      throw new CommandError("invalid_command", `invalid board scope '${p.scope}'`);
    }
    const board = await loadBoard(ctx.db, ctx.userId, { date: p.localDate, scope: p.scope });
    const current = await first<{ status: string }>(ctx.db, "SELECT status FROM board_suppressions WHERE user_id = ? AND scope = ? AND local_date = ?", ctx.userId, p.scope, p.localDate);
    if (current?.status === "active" && (!board || board.status === "suppressed")) return { outcome: "noop", summary: `The board for ${p.localDate} was already removed`, undo: { unavailableReason: "nothing changed" } };
    if (board?.status === "worn") throw new CommandError("precondition_failed", "the day's outfit is already recorded; its board is history");
    // The projector detecting an externally deleted event records the same suppression under the system's authority.
    const reason = ctx.principal.actor === "system" ? "calendar_event_deleted" : "owner_request";
    const statements: Stmt[] = [
      stmt(
        `INSERT INTO board_suppressions (user_id, scope, local_date, reason, note, status, command_id, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT (user_id, scope, local_date) DO UPDATE SET reason = excluded.reason, note = excluded.note, status = 'active', command_id = excluded.command_id, created_at = excluded.created_at, lifted_at = NULL`,
        ctx.userId, p.scope, p.localDate, reason, p.reason, ctx.commandId, ctx.now,
      ),
    ];
    const affected: EntityVersion[] = [];
    if (board) {
      statements.push(stmt("UPDATE boards SET status = 'suppressed', suppression_reason = ?, updated_at = ? WHERE user_id = ? AND board_id = ?", reason, ctx.now, ctx.userId, board.board_id));
      if (board.exposure_id) statements.push(stmt("UPDATE exposure_sets SET status = 'superseded', updated_at = ? WHERE user_id = ? AND exposure_id = ? AND status IN ('open', 'selected')", ctx.now, ctx.userId, board.exposure_id));
      affected.push({ kind: "board", id: board.board_id, version: board.current_revision });
    }
    const targetKey = projectionTarget(p.scope, p.localDate);
    return {
      summary: `The board for ${p.localDate} was removed; it will not be recreated until it is restored`,
      statements,
      affected,
      effects: reason === "owner_request" ? [{ kind: CALENDAR_EFFECT_KIND, targetKey, operationKey: `${CALENDAR_EFFECT_KIND}:${targetKey}:${ctx.commandId}`, desiredRevision: ctx.nowMs, payload: { boardId: board?.board_id ?? null, localDate: p.localDate, scope: p.scope } }] : [],
      outbox: board ? [{ topic: "board.revision", entityKind: "board", entityId: board.board_id, revision: board.current_revision, payload: { suppressed: true } }] : [],
      result: { localDate: p.localDate, scope: p.scope, boardId: board?.board_id ?? null },
      bumpWardrobe: !!board?.exposure_id,
      undo: { unavailableReason: "restore the board instead" },
    };
  },
});

export const boardRestore = define({
  type: "board.restore",
  schema: DAILY_COMMANDS["board.restore"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p): Promise<CommandPlan> {
    const board = await loadBoard(ctx.db, ctx.userId, { date: p.localDate, scope: p.scope });
    const suppression = await first<{ status: string }>(ctx.db, "SELECT status FROM board_suppressions WHERE user_id = ? AND scope = ? AND local_date = ? AND status = 'active'", ctx.userId, p.scope, p.localDate);
    const today = localDateOf(ctx.nowMs, board?.timezone ?? ctx.settings.timezone);
    const statements: Stmt[] = [];
    if (suppression) statements.push(stmt("UPDATE board_suppressions SET status = 'lifted', lifted_at = ? WHERE user_id = ? AND scope = ? AND local_date = ?", ctx.now, ctx.userId, p.scope, p.localDate));
    const affected: EntityVersion[] = [];
    if (board?.status === "suppressed") {
      // The board returns as it was; the next sweep revalidates it and re-registers its exposure.
      statements.push(stmt("UPDATE boards SET status = 'active', suppression_reason = NULL, needs_replenishment = 1, updated_at = ? WHERE user_id = ? AND board_id = ?", ctx.now, ctx.userId, board.board_id));
      affected.push({ kind: "board", id: board.board_id, version: board.current_revision });
    }
    const project = !!board && board.status !== "worn" && board.local_date >= today && !(await pauseCovering(ctx.db, ctx.userId, p.localDate));
    if (statements.length === 0 && !project) return { outcome: "noop", summary: `Nothing to restore for ${p.localDate}`, undo: { unavailableReason: "nothing changed" } };
    const targetKey = projectionTarget(p.scope, p.localDate);
    return {
      summary: statements.length > 0 ? `The board for ${p.localDate} was restored` : `Calendar delivery for ${p.localDate} was requested again`,
      statements,
      affected,
      // An explicit restore also lifts a delivery that was suppressed because the event was deleted in Calendar.
      effects: project ? [{ kind: CALENDAR_EFFECT_KIND, targetKey, operationKey: `${CALENDAR_EFFECT_KIND}:${targetKey}:${ctx.commandId}`, desiredRevision: ctx.nowMs, payload: { boardId: board!.board_id, localDate: p.localDate, scope: p.scope, restore: true } }] : [],
      result: { localDate: p.localDate, scope: p.scope, boardId: board?.board_id ?? null },
      undo: { unavailableReason: "remove the board again instead" },
    };
  },
});

export function registerBoardCommands(registry: CommandRegistry): void {
  for (const def of [boardPublish, boardSelect, boardSwapSlot, boardSuppress, boardRestore]) registry.register(def);
  registry.registerVersionResolver("board", (userId, id) => ({ sql: "SELECT current_revision FROM boards WHERE user_id = ? AND board_id = ?", params: [userId, id] }));
}
