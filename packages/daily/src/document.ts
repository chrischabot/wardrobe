/**
 * Board storage reads and the one semantic board document (specification section 9): the native app,
 * the private web board and the Calendar text are all renderings of `BoardDocument`. Names and
 * descriptors always come from garment records, never from model output.
 */
import type { Role } from "@garderobe/contracts";
import { DayBrief } from "@garderobe/contracts/ext/daily";
import type { BoardDocument, BoardGarmentLine, BoardOption, DayConditions, OptionEvidence, OutfitSlot, PauseState, TodayView } from "@garderobe/contracts/ext/daily";
import { all, allIn, assertPrincipal, first, json, localDateOf, requireScope, toInstant, type Db, type Principal } from "@garderobe/domain";
import { latestCalendarSnapshot, loadOwner, weatherSnapshotById, calendarSnapshotById } from "./context.ts";

/** Beyond these ages a source no longer counts as the day's forecast or calendar, whatever its label said when it was read. */
export const FORECAST_OUTDATED_MINUTES = 12 * 60;
export const CALENDAR_OUTDATED_MINUTES = 24 * 60;
const MAX_PHASE_ATTEMPTS_FOR_NOTICE = 5;

export interface BoardRow {
  user_id: string;
  board_id: string;
  scope: string;
  local_date: string;
  timezone: string;
  current_revision: number;
  status: "active" | "worn" | "suppressed";
  suppression_reason: string | null;
  selected_option_id: string | null;
  selected_footwear_id: string | null;
  selected_at: string | null;
  exposure_id: string | null;
  needs_replenishment: number;
  created_at: string;
  updated_at: string;
}

export interface RevisionRow {
  board_id: string;
  revision: number;
  reason: BoardDocument["reason"];
  requested_count: number;
  brief: DayBrief;
  conditions: DayConditions;
  context: Record<string, unknown>;
  day_line: string;
  weather_line: string | null;
  suitability_line: string | null;
  notice: string | null;
  changes: string[];
  weather_snapshot_id: string | null;
  calendar_snapshot_id: string | null;
  created_at: string;
}

export interface StoredOption {
  optionId: string;
  state: "offered" | "reserve";
  position: number;
  slots: OutfitSlot[];
  footwearAlternatives: string[];
  reason: string;
  suitsEventIds: string[];
  evidence: OptionEvidence;
  changed: boolean;
}

export type BoardRef = { boardId: string } | { date: string; scope?: string };

export async function loadBoard(db: Db, userId: string, ref: BoardRef): Promise<BoardRow | null> {
  if ("boardId" in ref) return first<BoardRow>(db, "SELECT * FROM boards WHERE user_id = ? AND board_id = ?", userId, ref.boardId);
  return first<BoardRow>(db, "SELECT * FROM boards WHERE user_id = ? AND scope = ? AND local_date = ?", userId, ref.scope ?? "home", ref.date);
}

export async function loadRevision(db: Db, userId: string, boardId: string, revision: number): Promise<RevisionRow | null> {
  const r = await first<any>(db, "SELECT * FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = ?", userId, boardId, revision);
  if (!r) return null;
  return {
    board_id: r.board_id,
    revision: r.revision,
    reason: r.reason,
    requested_count: r.requested_count,
    brief: DayBrief.parse(json(r.brief_json, {})),
    conditions: json(r.conditions_json, null as never),
    context: json(r.context_json, {}),
    day_line: r.day_line,
    weather_line: r.weather_line,
    suitability_line: r.suitability_line,
    notice: r.notice,
    changes: json(r.changes_json, []),
    weather_snapshot_id: r.weather_snapshot_id,
    calendar_snapshot_id: r.calendar_snapshot_id,
    created_at: r.created_at,
  };
}

export async function loadOptions(db: Db, userId: string, boardId: string, revision: number): Promise<StoredOption[]> {
  const rows = await all<any>(db, "SELECT * FROM board_options WHERE user_id = ? AND board_id = ? AND revision = ? ORDER BY state, position", userId, boardId, revision);
  return rows
    .map((r) => ({
      optionId: r.option_id as string,
      state: r.state as "offered" | "reserve",
      position: r.position as number,
      slots: json<OutfitSlot[]>(r.slots_json, []),
      footwearAlternatives: json<string[]>(r.footwear_alternatives_json, []),
      reason: r.reason as string,
      suitsEventIds: json<string[]>(r.suits_event_ids_json, []),
      evidence: json<OptionEvidence>(r.evidence_json, null as never),
      changed: r.changed === 1,
    }))
    .sort((a, b) => (a.state === b.state ? a.position - b.position : a.state === "offered" ? -1 : 1));
}

/** The active pause covering a local date, if any. */
export async function pauseCovering(db: Db, userId: string, localDate: string): Promise<PauseState | null> {
  const r = await first<any>(db, "SELECT * FROM service_pauses WHERE user_id = ? AND status = 'active' AND starts_on <= ? AND (resume_on IS NULL OR resume_on > ?)", userId, localDate, localDate);
  return r ? { pauseId: r.pause_id, from: r.starts_on, resumeOn: r.resume_on, status: r.status, createdAt: r.created_at, endedAt: r.ended_at } : null;
}

export async function getPauseState(db: Db, principal: Principal): Promise<PauseState | null> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const r = await first<any>(db, "SELECT * FROM service_pauses WHERE user_id = ? AND status = 'active'", principal.userId);
  return r ? { pauseId: r.pause_id, from: r.starts_on, resumeOn: r.resume_on, status: r.status, createdAt: r.created_at, endedAt: r.ended_at } : null;
}

const LINE_ORDER: Role[] = ["outer", "mid_layer", "top", "one_piece", "bottom", "belt", "socks", "footwear", "accessory"];

function qualificationFor(evidence: OptionEvidence, names: Map<string, { name: string }>): string | null {
  // Shown only when uncertainty materially affects the choice; never a percentage.
  if (evidence.jointAvailability >= 0.5) return null;
  const garments = ((evidence.validation.evidence as any)?.availability?.garments ?? []) as { garmentId: string; pAvailable: number; status: string }[];
  const weakest = garments.filter((g) => g.status === "estimated").sort((a, b) => a.pAvailable - b.pAvailable)[0];
  const name = weakest ? names.get(weakest.garmentId)?.name : null;
  return name ? `${name} may already have been worn this week.` : "A piece here may already have been worn this week.";
}

export async function buildBoardDocument(db: Db, userId: string, board: BoardRow, revisionNumber?: number, opts: { nowMs?: number } = {}): Promise<BoardDocument> {
  const revisionNo = revisionNumber ?? board.current_revision;
  const revision = await loadRevision(db, userId, board.board_id, revisionNo);
  if (!revision) throw new Error(`board revision ${revisionNo} not found`);
  const stored = await loadOptions(db, userId, board.board_id, revisionNo);
  const offered = stored.filter((o) => o.state === "offered");
  const ids = [...new Set(offered.flatMap((o) => [...o.slots.map((s) => s.garmentId), ...o.footwearAlternatives]))];
  const rows = ids.length ? await allIn<{ garment_id: string; name: string; colour: string | null }>(db, "SELECT garment_id, name, colour FROM garments WHERE user_id = ? AND garment_id IN (:ids)", [userId], ids) : [];
  const names = new Map(rows.map((r) => [r.garment_id, { name: r.name, colour: r.colour }]));
  const line = (garmentId: string, role: Role): BoardGarmentLine => ({ garmentId, role, name: names.get(garmentId)?.name ?? "Unknown garment", colour: names.get(garmentId)?.colour ?? null });

  const isCurrent = revisionNo === board.current_revision;
  const options: BoardOption[] = offered.map((o, i) => {
    const garments = [...o.slots].filter((s) => s.role !== "neckwear").sort((a, b) => LINE_ORDER.indexOf(a.role) - LINE_ORDER.indexOf(b.role)).map((s) => line(s.garmentId, s.role));
    const top = o.slots.find((s) => s.role === "top" || s.role === "one_piece");
    const bottom = o.slots.find((s) => s.role === "bottom");
    const flourish = o.slots.find((s) => s.role === "neckwear");
    const title = [top, bottom].filter(Boolean).map((s) => names.get(s!.garmentId)?.name ?? "Unknown garment").join(" with ");
    return {
      optionId: o.optionId,
      number: i + 1,
      name: title || `Option ${i + 1}`,
      reason: o.reason,
      garments,
      footwearAlternatives: o.footwearAlternatives.map((id) => line(id, "footwear")),
      flourish: flourish ? line(flourish.garmentId, "neckwear") : null,
      suitsEventIds: o.suitsEventIds,
      qualification: qualificationFor(o.evidence, names),
      changedInRevision: o.changed,
    };
  });

  const weather = revision.weather_snapshot_id ? await weatherSnapshotById(db, userId, revision.weather_snapshot_id) : null;
  const calendar = revision.calendar_snapshot_id ? await calendarSnapshotById(db, userId, revision.calendar_snapshot_id) : null;
  let weatherFreshness: BoardDocument["freshness"]["weather"] = weather?.freshness ?? "unavailable";
  let calendarStatus: BoardDocument["freshness"]["calendar"] = calendar?.status ?? "not_read";
  // Freshness is a fact about NOW, not about the moment of the fetch: a label recorded as "fresh" does
  // not stay fresh for a board whose refresh never ran. The ages come from the stored fetch and read times.
  if (opts.nowMs !== undefined && isCurrent && board.status === "active") {
    const ageMinutes = (iso: string | null | undefined) => (iso ? (opts.nowMs! - Date.parse(iso)) / 60_000 : null);
    const weatherAge = ageMinutes(weather?.fetchedAt);
    const calendarAge = ageMinutes(calendar?.readAt);
    if (weatherFreshness === "fresh" && weatherAge !== null && weatherAge > FORECAST_OUTDATED_MINUTES) weatherFreshness = "stale";
    if (calendarStatus === "ok" && calendarAge !== null && calendarAge > CALENDAR_OUTDATED_MINUTES) calendarStatus = "stale";
  }

  let validity: BoardDocument["validity"] = "current";
  if (board.status === "worn") validity = "worn";
  else if (board.status === "suppressed") validity = "suppressed";
  else if (options.length < revision.requested_count) validity = "degraded";
  else if (weatherFreshness !== "fresh" || calendarStatus === "error" || calendarStatus === "stale") validity = "limited";
  // Flagged: something changed (a rule, a setting, a brief, an undo, a swap made on an old forecast)
  // that has not been checked against this board yet. Until the sweep has done so it is not "current".
  else if (isCurrent && board.needs_replenishment === 1) validity = "limited";

  const targetKey = `outfit-event:${board.scope}:${board.local_date}`;
  const projection = await first<{ state: string; projected_revision: number | null }>(db, "SELECT state, projected_revision FROM calendar_projections WHERE user_id = ? AND target_key = ?", userId, targetKey);
  const pendingEffect = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND kind = 'calendar.project_board' AND target_key = ? AND state IN ('pending', 'in_progress')", userId, targetKey);
  let projectionState: BoardDocument["calendarProjection"]["state"] = "not_requested";
  const hasPendingEffect = (pendingEffect?.n ?? 0) > 0;
  if (projection?.state === "suppressed" || projection?.state === "not_connected") projectionState = projection.state;
  else if (hasPendingEffect) projectionState = "pending";
  else if (projection?.state === "projected") projectionState = projection.projected_revision === board.current_revision ? "projected" : "pending";
  else if (projection?.state === "failed") projectionState = "failed";
  else if (projection) projectionState = "pending";

  const selected = isCurrent && board.selected_option_id && offered.some((o) => o.optionId === board.selected_option_id);
  return {
    boardId: board.board_id,
    scope: board.scope,
    localDate: board.local_date,
    timezone: board.timezone,
    revision: revisionNo,
    publishedAt: revision.created_at,
    reason: revision.reason,
    validity,
    dayLine: revision.day_line,
    weatherLine: revision.weather_line,
    suitabilityLine: revision.suitability_line,
    notice: revision.notice,
    requestedCount: revision.requested_count,
    options,
    selection: selected ? { optionId: board.selected_option_id!, footwearGarmentId: board.selected_footwear_id, selectedAt: board.selected_at ?? revision.created_at } : null,
    changes: revision.changes,
    brief: revision.brief,
    freshness: {
      weather: weatherFreshness,
      weatherSnapshotId: revision.weather_snapshot_id,
      weatherFetchedAt: weather?.fetchedAt ?? null,
      calendar: calendarStatus,
      calendarSnapshotId: revision.calendar_snapshot_id,
      calendarReadAt: calendar?.readAt ?? null,
      wardrobeRevision: Number((revision.context as any)?.revisions?.wardrobeRevision ?? 0),
      styleRevision: Number((revision.context as any)?.revisions?.styleRevision ?? 0),
    },
    calendarProjection: {
      state: projectionState,
      projectedRevision: projection?.projected_revision ?? null,
      action: projectionState === "not_connected" ? "Connect Google Calendar and choose the outfit calendar to see the board there." : null,
    },
  };
}

export async function getBoard(db: Db, principal: Principal, ref: BoardRef, opts: { revision?: number; nowMs?: number } = {}): Promise<BoardDocument | null> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const board = await loadBoard(db, principal.userId, ref);
  if (!board) return null;
  return buildBoardDocument(db, principal.userId, board, opts.revision, { nowMs: opts.nowMs });
}

/** Today: the prepared board, the day's record and the service state. No inference call is made. */
export async function getToday(db: Db, principal: Principal, opts: { date?: string; scope?: string; nowMs?: number } = {}): Promise<TodayView> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const userId = principal.userId;
  const owner = await loadOwner(db, userId);
  const nowMs = opts.nowMs ?? Date.now();
  const localDate = opts.date ?? localDateOf(nowMs, owner.settings.timezone);
  const scope = opts.scope ?? "home";
  const board = await loadBoard(db, userId, { date: localDate, scope });
  const document = board ? await buildBoardDocument(db, userId, board, undefined, { nowMs }) : null;
  const worn = await all<{ garment_id: string; name: string; colour: string | null; roles_json: string }>(
    db,
    "SELECT g.garment_id, g.name, g.colour, g.roles_json FROM daily_wears w JOIN garments g ON g.user_id = w.user_id AND g.garment_id = w.garment_id WHERE w.user_id = ? AND w.wearing_date = ? AND w.status = 'active' ORDER BY g.category, g.name",
    userId, localDate,
  );
  const paused = await pauseCovering(db, userId, localDate);
  let emptyReason: string | null = null;
  if (!document || document.options.length === 0 || document.validity === "suppressed") {
    if (paused) emptyReason = paused.resumeOn ? `Recommendations are paused until ${paused.resumeOn}.` : "Recommendations are paused.";
    else if (document?.validity === "suppressed") emptyReason = "This day's board was removed.";
    else if (document) emptyReason = document.notice ?? "No complete outfit is available for this day.";
    else {
      // A scheduled run that gave up is said plainly, with what the owner can do about it.
      const gaveUp = scope === "home" ? await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM day_runs WHERE user_id = ? AND local_date = ? AND status = 'failed' AND attempts >= ? AND phase IN ('evening_compose', 'morning_refresh', 'morning_publish')", userId, localDate, MAX_PHASE_ATTEMPTS_FOR_NOTICE) : null;
      emptyReason = (gaveUp?.n ?? 0) > 0 ? "The board for this day could not be prepared: the scheduled run failed repeatedly and has stopped trying. Ask for outfits to compose it now." : "No board has been prepared for this day yet.";
    }
  }
  return {
    localDate,
    timezone: owner.settings.timezone,
    board: document,
    dayRecord: worn.map((w) => ({ garmentId: w.garment_id, role: (json<Role[]>(w.roles_json, ["accessory"])[0] ?? "accessory") as Role, name: w.name, colour: w.colour })),
    paused: paused ? { pauseId: paused.pauseId, from: paused.from, resumeOn: paused.resumeOn } : null,
    emptyReason,
    readAt: toInstant(nowMs),
  };
}

/* ------------------------------------------------------------------ */
/* Day line                                                             */
/* ------------------------------------------------------------------ */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function formatLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
  return `${weekday} ${d} ${MONTHS[m - 1]}`;
}

/** The day line: the date, the weather line and the shape of the day from the calendar. */
export async function dayLineFor(db: Db, userId: string, localDate: string, timezone: string, weatherLine: string | null, calendarSnapshotId: string | null): Promise<string> {
  const calendar = calendarSnapshotId ? await calendarSnapshotById(db, userId, calendarSnapshotId) : await latestCalendarSnapshot(db, userId, localDate);
  const parts = [formatLocalDate(localDate)];
  if (weatherLine) parts.push(weatherLine.replace(/\.$/, ""));
  if (calendar && (calendar.status === "ok" || calendar.status === "stale")) {
    const weighted = calendar.events.filter((e) => e.weight !== "none" && !e.allDay && e.startsAt);
    if (weighted.length === 0) parts.push("Nothing fixed in the calendar");
    else {
      const firstStart = weighted.map((e) => e.startsAt!).sort()[0]!;
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(firstStart));
      parts.push(weighted.length === 1 ? `One commitment, at ${time}` : `${weighted.length} commitments, the first at ${time}`);
    }
  }
  return `${parts.join(". ")}.`;
}

/* ------------------------------------------------------------------ */
/* Renderers of the same document                                       */
/* ------------------------------------------------------------------ */

function label(role: Role): string {
  switch (role) {
    case "outer": return "Jacket";
    case "mid_layer": return "Layer";
    case "top": return "Shirt";
    case "one_piece": return "One piece";
    case "bottom": return "Trousers";
    case "belt": return "Belt";
    default: return "Also";
  }
}

/** Garment lines of one option in the profile's order: jacket, shirt, trousers, belt (+flourish), socks with shoes. */
export function optionLines(option: BoardOption): { label: string; text: string }[] {
  const lines: { label: string; text: string }[] = [];
  for (const g of option.garments) {
    if (g.role === "socks" || g.role === "footwear") continue;
    const text = g.role === "belt" && option.flourish ? `${g.name}; optional: ${option.flourish.name}` : g.name;
    lines.push({ label: label(g.role), text });
  }
  if (option.flourish && !option.garments.some((g) => g.role === "belt")) lines.push({ label: "Optional", text: option.flourish.name });
  const socks = option.garments.find((g) => g.role === "socks");
  const shoes = option.garments.find((g) => g.role === "footwear");
  const shoeText = [shoes?.name, ...option.footwearAlternatives.map((a) => a.name)].filter(Boolean).join(" or ");
  if (socks || shoes) lines.push({ label: "Socks and shoes", text: [socks?.name, shoeText].filter(Boolean).join(" with ") });
  return lines;
}

/**
 * Plain Calendar text of the board. It carries the day line, the valid options with a teaching
 * sentence and perceptible garment lines - and no item codes, job traces, diagnostics or status
 * headings inside the outfit copy. It stays useful without images.
 */
export function renderBoardCalendarText(doc: BoardDocument, opts: { boardUrl?: string | null } = {}): string {
  const out: string[] = [doc.dayLine];
  if (doc.suitabilityLine) out.push(doc.suitabilityLine);
  for (const o of doc.options) {
    out.push("", `${o.number}. ${o.name}`, o.reason);
    for (const l of optionLines(o)) out.push(`${l.label}: ${l.text}`);
    if (o.qualification) out.push(o.qualification);
  }
  if (doc.notice) out.push("", doc.notice);
  if (opts.boardUrl) out.push("", `Open the board: ${opts.boardUrl}`);
  return out.join("\n");
}

export function boardSummary(doc: BoardDocument): string {
  return `Outfits for ${formatLocalDate(doc.localDate)}`;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The private web board: the same document as semantic HTML. Every value is escaped. */
export function renderBoardDocumentHtml(doc: BoardDocument | null, opts: { baseUrl: string; emptyReason?: string | null }): string {
  const e = escapeHtml;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(doc ? boardSummary(doc) : "Garderobe")}</title><style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1c1c1e;background:#fbfaf7}h1{font-size:1.25rem}h2{font-size:1.05rem;margin:2rem 0 .25rem}dl{margin:.5rem 0}dt{float:left;clear:left;width:9rem;color:#6b6b70}dd{margin-left:9.5rem}.note{color:#6b6b70}.chosen{border-left:3px solid #1c1c1e;padding-left:.75rem}</style></head><body>`;
  if (!doc) return `${head}<main><h1>Garderobe</h1><p class="note">${e(opts.emptyReason ?? "No board has been prepared for this day yet.")}</p></main></body></html>`;
  const parts: string[] = [head, `<main><h1>${e(doc.dayLine)}</h1>`];
  if (doc.suitabilityLine) parts.push(`<p>${e(doc.suitabilityLine)}</p>`);
  if (doc.validity === "suppressed") parts.push(`<p class="note">This day's board was removed.</p>`);
  for (const o of doc.validity === "suppressed" ? [] : doc.options) {
    const chosen = doc.selection?.optionId === o.optionId;
    parts.push(`<section id="option-${e(o.optionId)}"${chosen ? ' class="chosen"' : ""}><h2><a href="${e(`${base}/board/${doc.localDate}#option-${o.optionId}`)}">${o.number}. ${e(o.name)}</a>${chosen ? " (chosen)" : ""}</h2><p>${e(o.reason)}</p><dl>`);
    for (const l of optionLines(o)) parts.push(`<dt>${e(l.label)}</dt><dd>${e(l.text)}</dd>`);
    parts.push("</dl>");
    if (o.qualification) parts.push(`<p class="note">${e(o.qualification)}</p>`);
    parts.push("</section>");
  }
  if (doc.notice) parts.push(`<p class="note">${e(doc.notice)}</p>`);
  parts.push(`<p class="note">Revision ${doc.revision}, published ${e(doc.publishedAt)}.</p></main></body></html>`);
  return parts.join("");
}

export async function renderBoardHtml(db: Db, principal: Principal, opts: { date?: string; scope?: string; baseUrl: string; nowMs?: number }): Promise<string> {
  const today = await getToday(db, principal, { date: opts.date, scope: opts.scope, nowMs: opts.nowMs });
  return renderBoardDocumentHtml(today.board, { baseUrl: opts.baseUrl, emptyReason: today.emptyReason });
}
