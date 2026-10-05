/**
 * The state of one simulation run: the connected sessions, the simulator's own record of what it did
 * (the "model"), the registry of invariant checks, and the plumbing every step uses.
 *
 * The model holds only what the simulator itself said or scripted: which garments it reported as worn on
 * which day, what it made unavailable and why, what it observed, the forecast it scripted. Invariants
 * compare the application's state, read back through MCP, with that record; nothing is read from the
 * application's internals.
 */
import { addDays, localDateOf, toInstant, zonedToUtcMs } from "./dates.mjs";
import { digest } from "./rng.mjs";

/** Text the owner reads must not show internal identifiers or serialisation debris. */
export function internalCodesIn(text) {
  const patterns = [/\b[a-z]{2,4}_[0-9a-f]{12,}\b/g, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, /\[object Object\]|\bundefined\b|\bNaN\b/g, /\b(?:boardId|optionId|garmentId|tripId|batchId|caseId|orderId)\b/g];
  const found = new Set();
  for (const pattern of patterns) for (const match of String(text).matchAll(pattern)) found.add(match[0]);
  return [...found];
}

const HARD_REASONS = new Set(["not_owned_yet", "disposed", "merged", "no_units_at_home", "restricted", "in_storage", "at_tailor", "on_trip", "planning_excluded", "observed_dirty", "in_service_batch", "laundry_exception"]);
export const isHardReason = (reason) => HARD_REASONS.has(reason);

export const quantityIn = (item, bucket) => (item?.balances ?? []).filter((b) => b.bucket === bucket).reduce((n, b) => n + b.quantity, 0);

export class Sim {
  constructor({ target, plan, log = () => undefined }) {
    this.target = target;
    this.plan = plan;
    this.log = log;
    this.timezone = plan.timezone;
    this.sessions = { writer: null, reader: null, second: null };
    this.keyCounter = 0;
    this.step = null; // the step being executed (set by the runner)
    this.stepIndex = 0;

    /* ---- registry of checks ---- */
    this.checks = new Map(); // id -> { passed, failed, notApplicable }
    this.failures = []; // every failed check, with its step and evidence
    this.stepErrors = [];
    this.conditions = new Map(); // observed condition -> count
    this.notes = [];
    this.commandLog = []; // compact trace of every command: type, route, outcome, summary
    this.trace = []; // normalised trace for the reproducibility digest

    /* ---- the simulator's own model ---- */
    this.wears = new Map(); // local date -> Map(garmentId -> number of reports the simulator made)
    this.unavailable = new Map(); // garmentId -> { kind, reason, since }
    this.restrictedAtStart = new Map(); // garmentId -> restrictionIds
    this.ownRestrictions = new Map(); // garmentId -> restrictionId (lent)
    this.weatherChangedAt = new Map(); // local date -> target time of the last scripted change of that day's forecast
    this.weatherDown = false;
    this.weatherDownSince = null;
    this.scriptedWeather = new Map(); // local date -> the script currently in force at home
    this.chosen = new Map(); // local date -> the option the simulated owner settled on
    this.namedByRequest = new Map(); // local date -> Set(garmentId) the simulator asked for by name
    this.knownBoardDates = new Set();
    this.boardRevisions = new Map(); // boardId -> highest revision seen
    this.trip = { tripId: null, packed: new Map(), proposal: null, unpacked: false };
    this.pause = { active: false, pauseId: null };
    this.purchase = {};
    this.synthetic = { second: [] };
    this.calendar = { outfitCalendarId: null, connectionId: null };
    this.lastDirect = []; // receipts of direct wear reports, candidates for undo
    this.snapshotCache = null;
    this.primaryCommandIds = [];
    this.healingRestrictionIds = new Set();
  }

  /* ------------------------------ time ------------------------------ */

  now() {
    return this.target.now();
  }
  today() {
    return localDateOf(this.now(), this.timezone);
  }
  dateOf(dayIndex) {
    return addDays(this.plan.startDate, dayIndex);
  }
  instantOf(dayIndex, time) {
    return zonedToUtcMs(this.dateOf(dayIndex), time, this.timezone);
  }

  /* ------------------------------ checks ------------------------------ */

  entry(id) {
    let entry = this.checks.get(id);
    if (!entry) {
      entry = { passed: 0, failed: 0, notApplicable: 0 };
      this.checks.set(id, entry);
    }
    return entry;
  }

  /** Record one check. A failure keeps the step, the time on the target and the evidence (receipt, state). */
  check(id, ok, message = "", evidence = undefined) {
    const entry = this.entry(id);
    if (ok) {
      entry.passed++;
      return true;
    }
    entry.failed++;
    const failure = { check: id, seed: this.plan.seed, step: this.stepIndex, stepKind: this.step?.kind ?? "setup", day: this.step?.day ?? null, date: this.step ? this.dateOf(this.step.day) : null, at: toInstant(this.now()), message, evidence: evidence ?? null };
    if (this.failures.length < 400) this.failures.push(failure);
    this.log(`  FAIL ${id}: ${message}`);
    return false;
  }

  /** A check that could not apply to this state (for example a repair probe whose piece still has a clean unit). */
  notApplicable(id, why) {
    this.entry(id).notApplicable++;
    if (this.notes.length < 400) this.notes.push({ check: id, step: this.stepIndex, why });
  }

  count(condition, n = 1) {
    this.conditions.set(condition, (this.conditions.get(condition) ?? 0) + n);
  }

  /* ------------------------------ reads (all through MCP) ------------------------------ */

  key(prefix) {
    return `sim-${this.plan.seed}-${prefix}-${++this.keyCounter}`;
  }

  async inventory(args, session = this.sessions.reader) {
    const result = await session.callTool("garderobe_inventory", args);
    if (!result.ok) throw new Error(`garderobe_inventory ${JSON.stringify(args).slice(0, 120)} was refused: ${result.error.code} ${result.error.message}`);
    return result.data;
  }

  /** The complete wardrobe with availability for a date; one read per target instant and date. */
  async snapshot(date = this.today()) {
    const stamp = `${this.stepIndex}:${this.target.calls.filter((c) => c.tool === "garderobe_command").length}:${this.target.ownerRequests}:${this.target.doorRequests}:${date}`;
    if (this.snapshotCache?.stamp === stamp) return this.snapshotCache.value;
    const envelope = await this.inventory({ view: "snapshot", date });
    const items = envelope.data.items ?? [];
    const value = { date, wardrobeRevision: envelope.wardrobeRevision, complete: envelope.complete, total: envelope.total, items, byId: new Map(items.map((i) => [i.garment.garmentId, i])), counts: envelope.data.counts };
    this.snapshotCache = { stamp, value };
    return value;
  }

  async todayBoard(date) {
    const result = await this.sessions.reader.callTool("garderobe_today", date ? { date } : {});
    if (!result.ok) throw new Error(`garderobe_today ${date ?? ""} was refused: ${result.error.code} ${result.error.message}`);
    const board = result.data.board;
    if (board) {
      this.knownBoardDates.add(board.localDate);
      const seen = this.boardRevisions.get(board.boardId) ?? 0;
      this.check("board.revision_never_goes_back", board.revision >= seen, `board for ${board.localDate} went from revision ${seen} to ${board.revision}`, { boardId: board.boardId });
      this.boardRevisions.set(board.boardId, Math.max(seen, board.revision));
    }
    return result.data;
  }

  /* ------------------------------ the simulator's record of wears ------------------------------ */

  recordWear(date, garmentIds) {
    const day = this.wears.get(date) ?? new Map();
    for (const id of garmentIds) day.set(id, (day.get(id) ?? 0) + 1);
    this.wears.set(date, day);
  }

  forgetWear(date, garmentIds) {
    const day = this.wears.get(date);
    if (!day) return;
    for (const id of garmentIds) day.delete(id);
    if (day.size === 0) this.wears.delete(date);
  }

  /** Garments the simulator reported as worn in the seven days before `date`. */
  wornInSevenDaysBefore(date) {
    const out = new Set();
    for (let back = 1; back <= 7; back++) for (const id of (this.wears.get(addDays(date, -back)) ?? new Map()).keys()) out.add(id);
    return out;
  }

  wearCountOf(garmentId) {
    let n = 0;
    for (const day of this.wears.values()) if (day.has(garmentId)) n++;
    return n;
  }

  /* ------------------------------ commands ------------------------------ */

  /**
   * One typed command from the connected assistant, driven by the server's answer: when the server says
   * the owner must confirm, the owner reads the request in the app and decides it there. Every accepted
   * command is then checked: the receipt reads back as stored, a repeat of the same call returns that
   * receipt and writes nothing, and the owner-facing text shows no internal code.
   *
   * Returns `{ route, receipt, error, proposal }` with route `direct`, `owner_confirmed`,
   * `owner_rejected` or `refused`.
   */
  async command(type, payload, { session = this.sessions.writer, ownerKey = "primary", key, expectedVersions, occurredAt, decision = "confirm", verify = true, label } = {}) {
    const args = { type, payload, idempotencyKey: key ?? this.key(type), ...(expectedVersions ? { expectedVersions } : {}), ...(occurredAt ? { occurredAt } : {}) };
    const first = await session.callTool("garderobe_command", args);
    let outcome;
    if (first.ok) outcome = { route: "direct", receipt: first.data.receipt, error: null, proposal: null };
    else if (first.error.code !== "confirmation_required") outcome = { route: "refused", receipt: null, error: first.error, proposal: null };
    else {
      const proposalId = String(first.error.details?.proposalId ?? "");
      this.check("proposal.answer_names_the_request", Boolean(proposalId) && typeof first.error.details?.summary === "string" && first.error.details.summary.length > 0, `${type}: the confirmation_required answer carries no proposal identifier or summary`, { error: first.error });
      const listed = ((await this.target.apiOk(ownerKey, "GET", "/v1/proposals")).proposals ?? []).find((p) => p.proposalId === proposalId);
      this.check("proposal.shown_to_owner_as_sent", Boolean(listed) && listed.type === type && listed.state === "pending" && listed.source?.channel === "mcp", `${type}: the request is not in the owner's list as a pending request of this assistant`, { proposalId });
      if (listed) this.check("owner_text.no_internal_codes", internalCodesIn(listed.summary).length === 0, `proposal summary shows ${internalCodesIn(listed.summary).join(", ")}`, { proposalId, summary: listed.summary });
      // Nothing may have changed while it waits: a repeat of the same call is still waiting.
      const waiting = await session.callTool("garderobe_command", args);
      this.check("proposal.not_executed_before_owner_decides", !waiting.ok && waiting.error.code === "confirmation_required" && String(waiting.error.details?.proposalId) === proposalId, `${type}: a repeat before the owner's decision answered ${waiting.ok ? "with a receipt" : waiting.error.code}`, { proposalId });
      const decided = await this.target.api(ownerKey, "POST", `/v1/proposals/${proposalId}/decision`, { decision });
      if (!decided.ok) outcome = { route: "refused", receipt: null, error: decided.json?.error ?? { code: `http_${decided.status}`, message: decided.text.slice(0, 300), details: {} }, proposal: listed ?? null, refusedAtConfirmation: true };
      else if (decision === "reject") {
        const after = await session.callTool("garderobe_command", args);
        this.check("proposal.rejected_stays_unexecuted", !after.ok && after.error.code === "forbidden", `${type}: after the owner's rejection the repeat answered ${after.ok ? "with a receipt" : after.error.code}`, { proposalId });
        outcome = { route: "owner_rejected", receipt: null, error: null, proposal: listed ?? null };
      } else outcome = { route: "owner_confirmed", receipt: decided.json.receipt, error: null, proposal: listed ?? null };
    }
    this.commandLog.push({ step: this.stepIndex, day: this.step?.day ?? null, type, label: label ?? null, route: outcome.route, outcome: outcome.receipt?.outcome ?? null, code: outcome.error?.code ?? null, reason: outcome.error?.details?.reason ?? null, commandId: outcome.receipt?.commandId ?? null, summary: outcome.receipt?.summary ?? outcome.error?.message ?? null });
    this.trace.push(["command", type, outcome.route, outcome.receipt?.outcome ?? outcome.error?.code ?? null]);
    this.count(`route.${outcome.route}`);
    if (outcome.receipt && verify) await this.verifyReceipt(session, args, outcome);
    if (outcome.receipt && session !== this.sessions.second) this.primaryCommandIds.push(outcome.receipt.commandId);
    return outcome;
  }

  /** `command`, for a change that must be accepted; a refusal is recorded as a failed check and thrown. */
  async mustCommit(type, payload, options = {}) {
    const outcome = await this.command(type, payload, options);
    if (!outcome.receipt) {
      this.check("command.accepted", false, `${type} was refused: ${outcome.error?.code} ${outcome.error?.message}`, { type, payload, error: outcome.error });
      throw new Error(`${type} was refused: ${outcome.error?.code} ${outcome.error?.message}`);
    }
    this.check("command.accepted", true);
    return outcome;
  }

  async verifyReceipt(session, args, outcome) {
    const receipt = outcome.receipt;
    const type = args.type;
    this.check("receipt.well_formed", receipt.type === type && ["committed", "merged", "noop"].includes(receipt.outcome) && typeof receipt.summary === "string" && receipt.summary.length > 0 && typeof receipt.commandId === "string" && Array.isArray(receipt.affected), `${type}: malformed receipt`, { receipt });
    this.check("owner_text.no_internal_codes", internalCodesIn(receipt.summary).length === 0, `${type} receipt summary shows ${internalCodesIn(receipt.summary).join(", ")}`, { commandId: receipt.commandId, summary: receipt.summary });
    this.check("receipt.names_who_acted", outcome.route === "direct" ? receipt.actor === "assistant" && receipt.channel === "mcp" : receipt.actor === "owner", `${type} (${outcome.route}) is recorded as actor ${receipt.actor} on channel ${receipt.channel}`, { commandId: receipt.commandId });
    // Read back: the stored receipt is the one that was returned.
    const before = await this.inventory({ view: "receipts", limit: 20 }, session);
    const stored = (before.data.receipts ?? []).find((r) => r.commandId === receipt.commandId);
    this.check("receipt.reads_back_as_returned", Boolean(stored) && stored.type === receipt.type && stored.outcome === receipt.outcome && stored.summary === receipt.summary && stored.occurredAt === receipt.occurredAt && stored.recordedAt === receipt.recordedAt && stored.wardrobeRevision === receipt.wardrobeRevision, `${type}: the stored receipt differs from the returned one or is missing`, { commandId: receipt.commandId, returned: { outcome: receipt.outcome, summary: receipt.summary }, stored: stored ? { outcome: stored.outcome, summary: stored.summary } : null });
    this.check("receipt.revision_not_ahead_of_ledger", receipt.wardrobeRevision <= before.wardrobeRevision, `${type}: receipt says wardrobe revision ${receipt.wardrobeRevision}, the ledger is at ${before.wardrobeRevision}`, { commandId: receipt.commandId });
    // Idempotent: the same call again returns the stored receipt and writes nothing.
    const again = await session.callTool("garderobe_command", args);
    this.check("receipt.idempotent_repeat", again.ok && again.data.receipt.commandId === receipt.commandId && again.data.receipt.replayed === true, `${type}: a repeat of the same call answered ${again.ok ? `command ${again.data.receipt.commandId}, replayed ${again.data.receipt.replayed}` : again.error.code}`, { commandId: receipt.commandId });
    const after = await this.inventory({ view: "receipts", limit: 20 }, session);
    const ids = (list) => (list.data.receipts ?? []).map((r) => r.commandId).join(",");
    this.check("receipt.repeat_writes_nothing", after.wardrobeRevision === before.wardrobeRevision && ids(after) === ids(before), `${type}: after the repeat the ledger moved from revision ${before.wardrobeRevision} to ${after.wardrobeRevision} or gained a receipt`, { commandId: receipt.commandId });
  }

  /** The same key with a different request must be refused, never run. */
  async probeKeyReuse(type, payload, otherPayload) {
    const key = this.key(`reuse-${type}`);
    const first = await this.command(type, payload, { key, verify: false, label: "key-reuse probe" });
    if (!first.receipt || first.route !== "direct") return first;
    const reused = await this.sessions.writer.callTool("garderobe_command", { type, payload: otherPayload, idempotencyKey: key });
    this.check("receipt.key_reuse_refused", !reused.ok && reused.error.code === "idempotency_key_reuse", `${type}: the same key with a different request answered ${reused.ok ? "with a receipt" : reused.error.code}`, { commandId: first.receipt.commandId });
    return first;
  }

  /** A command sent by the signed-in owner in the app (only for what a connected assistant cannot do). */
  async ownerCommand(type, payload, { ownerKey = "primary", key, expectedVersions } = {}) {
    const response = await this.target.api(ownerKey, "POST", "/v1/commands", { type, payload, idempotencyKey: key ?? this.key(`owner-${type}`), ...(expectedVersions ? { expectedVersions } : {}), authorization: "owner_tap", source: { channel: "ios" } });
    this.commandLog.push({ step: this.stepIndex, day: this.step?.day ?? null, type, label: "sent by the owner in the app", route: response.ok ? "owner_app" : "refused", outcome: response.json?.outcome ?? null, code: response.json?.error?.code ?? null, reason: response.json?.error?.details?.reason ?? null, commandId: response.json?.commandId ?? null, summary: response.json?.summary ?? response.json?.error?.message ?? null });
    this.trace.push(["owner_command", type, response.ok ? response.json.outcome : (response.json?.error?.code ?? response.status)]);
    if (response.ok) this.primaryCommandIds.push(response.json.commandId);
    return response.ok ? { receipt: response.json, error: null } : { receipt: null, error: response.json?.error ?? { code: `http_${response.status}`, message: response.text.slice(0, 300), details: {} } };
  }

  /* ------------------------------ results ------------------------------ */

  /** A digest of what happened, without identifiers or clock readings: equal for two runs of one seed on one build. */
  outcomeDigest() {
    return digest(this.trace);
  }
}
