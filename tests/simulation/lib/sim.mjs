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

/**
 * The owner's decision of 2026-10-05, "Follow the specification everywhere" (library document "Contract:
 * changes apply at once with undo on every surface"), section 3: the only command types a connected
 * assistant's typed command still leaves waiting for the signed-in owner. Everything else the owner asks
 * for (observations, bookkeeping and every `direction`) applies at once with a receipt and is taken back
 * with undo. Lifting a restriction is refused outright for a connected assistant (section 3, Restrictions).
 */
export const CONTRACT_CONFIRM_TYPES = new Set(["conversation.forget_source", "media.delete_asset", "garment.merge", "garment.remove_fabricated", "lifecycle.authorize_action", "connection.register", "connection.set_tool_groups", "connection.set_status", "inference.set_routing", "style.save_document"]);
export const CONTRACT_LIFT_TYPES = new Set(["restriction.resolve", "assistant.lift_restriction"]);

/**
 * Refusals for a domain reason (packages/contracts CommandErrorCode and ApiErrorCode): the command was
 * understood and routed, but its payload, target or state did not allow it. Any other refusal decides no route.
 */
export const DOMAIN_REFUSAL_CODES = new Set(["invalid_command", "not_found", "ambiguous_target", "conflict", "idempotency_key_reuse", "precondition_failed", "not_undoable", "expired"]);

/**
 * What a garment's state is, for "nothing changed" checks: its whole garment record (name, roles, planning
 * policy, care channel, acquisition and every other property, in stable key order), its balances (bucket,
 * reference, quantity), its owned units and wear count, and the restrictions in force on it.
 */
export const garmentFingerprint = (item) =>
  JSON.stringify({
    garment: stableJson(item?.garment ?? null),
    balances: [...(item?.balances ?? [])].map((b) => [b.bucket, b.ref ?? "", b.quantity]).sort(),
    wears: item?.recordedWearCount ?? null,
    owned: item?.totalOwnedUnits ?? null,
    acquisition: item?.garment?.acquisition ?? null,
    restrictions: [...(item?.availability?.restrictionIds ?? []), ...((item?.restrictions ?? []).map((r) => r?.restrictionId ?? r))].map(String).sort(),
  });

/** Differences between two garment-fingerprint maps, in words, ignoring the garments in `allowed`. */
export function garmentChanges(before, after, allowed = new Set()) {
  const out = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (allowed.has(id)) continue;
    if (before.get(id) !== after.get(id)) out.push(`garment ${id}: ${before.get(id) ?? "absent"} -> ${after.get(id) ?? "absent"}`);
  }
  return out;
}

/** JSON with object keys sorted at every level, so two equal values always serialise identically. */
export function stableJson(value) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(value ?? null));
}

/**
 * A garment's balances as a map `bucket|ref` to quantity (zero entries dropped). Buckets named in `loose` are
 * summed under `bucket|*`, for buckets whose reference the simulator cannot predict.
 */
export function balanceMap(item, loose = []) {
  const map = new Map();
  for (const b of item?.balances ?? []) {
    const key = loose.includes(b.bucket) ? `${b.bucket}|*` : `${b.bucket}|${b.ref ?? ""}`;
    map.set(key, (map.get(key) ?? 0) + b.quantity);
  }
  for (const [key, quantity] of map) if (quantity === 0) map.delete(key);
  return map;
}

export const showBalances = (map) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, q]) => `${key.replace(/\|$/, "")}=${q}`).join(", ") || "nothing";

/** Add `delta` to `key` of a balance map, dropping the entry at zero. */
export function moveBalance(map, key, delta) {
  const next = (map.get(key) ?? 0) + delta;
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

/**
 * Compare every garment of two snapshots balance by balance. `expect(garmentId, map)` adjusts a copy of the
 * garment's earlier map to what the step should have produced; garments it leaves alone must be unchanged.
 * Owned units must not change. Returns the differences in words.
 */
export function balanceDifferences(before, after, expect = () => undefined, loose = []) {
  const wrong = [];
  for (const garmentId of new Set([...before.byId.keys(), ...after.byId.keys()])) {
    const was = before.byId.get(garmentId);
    const now = after.byId.get(garmentId);
    const name = now?.garment.name ?? was?.garment.name ?? garmentId;
    if (!was || !now) {
      wrong.push(`${name}: ${!was ? "appeared" : "disappeared"}`);
      continue;
    }
    const expected = balanceMap(was, loose);
    expect(garmentId, expected, was);
    const actual = balanceMap(now, loose);
    if (showBalances(expected) !== showBalances(actual)) wrong.push(`${name}: expected ${showBalances(expected)}, found ${showBalances(actual)}`);
    if (now.totalOwnedUnits !== was.totalOwnedUnits) wrong.push(`${name}: owned units ${was.totalOwnedUnits} -> ${now.totalOwnedUnits}`);
  }
  return wrong;
}

/** The receipts in `after`'s latest 20 that `before`'s did not hold: each command's identifier, type, outcome and time. */
export function newReceipts(before, after) {
  const seen = new Set((before.receiptList ?? []).map((r) => r.commandId));
  return (after.receiptList ?? []).filter((r) => !seen.has(r.commandId));
}

/**
 * A receipt of background work: recorded by the `system` actor (media jobs, scheduled maintenance), never by
 * the owner or a connected assistant, so no owner or assistant request in flight wrote it.
 */
export const isBackgroundReceipt = (r) => r?.actor === "system";

/** How many of the latest receipts `wardrobeState` reads (the receipts view lists them newest first). */
export const RECEIPT_WINDOW = 20;

/**
 * Every difference between two `wardrobeState` readings, in words; empty when nothing moved. Background
 * receipts (`isBackgroundReceipt`) that appeared meanwhile, with the revision moves they account for, are not
 * counted as a change; they stay visible through `newReceipts`. Any other new receipt, a reordering not
 * explained by new receipts, and any garment change are changes.
 */
export function wardrobeStateChanges(before, after, { window = RECEIPT_WINDOW } = {}) {
  const out = [];
  const appeared = newReceipts(before, after);
  const attributable = appeared.filter((r) => !isBackgroundReceipt(r));
  // Background receipts explain only additions. The receipts view is newest first and holds the latest
  // `window` receipts: the new ones must sit at the front, every receipt already listed must keep its order,
  // and only the oldest end may be pushed out, by exactly as many as the full window forces.
  const beforeIds = (before.receiptList ?? []).map((r) => r.commandId);
  const afterIds = (after.receiptList ?? []).map((r) => r.commandId);
  const appearedIds = appeared.map((r) => r.commandId);
  const mustDrop = Math.max(0, beforeIds.length + appearedIds.length - window);
  const expectedAfter = [...appearedIds, ...beforeIds.slice(0, beforeIds.length - mustDrop)];
  const orderKept = afterIds.join(",") === expectedAfter.join(",");
  const onlyBackground = appeared.length > 0 && attributable.length === 0 && orderKept;
  if (before.revision !== after.revision && !(onlyBackground && after.revision - before.revision <= appeared.length && after.revision > before.revision)) out.push(`ledger revision ${before.revision} -> ${after.revision}`);
  if (before.receipts !== after.receipts && !onlyBackground) out.push(`new receipts in the latest 20: ${attributable.map((r) => `${r.type} ${r.commandId}`).join(", ") || "none (order changed)"}`);
  out.push(...garmentChanges(before.garments, after.garments));
  return out;
}

/** The route the contract expects for a connected assistant's typed command of this type. */
export function contractRoute(type) {
  if (CONTRACT_LIFT_TYPES.has(type)) return "refused";
  if (CONTRACT_CONFIRM_TYPES.has(type)) return "owner_confirmed";
  return "direct";
}

/**
 * An option's composition by stable identities: role and garment name, sorted. Garment identifiers are
 * generated per database, so the reproducibility digest uses the names, which come from the owner's
 * inventory (or a labelled synthetic name) and are the same for every run of one seed.
 */
export const composition = (option) => (option?.garments ?? []).map((g) => `${g.role}:${g.name}`).sort().join(" + ");

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
    this.trip = { tripId: null, packed: new Map(), proposal: null, unpacked: false, departsOn: null, dirtyAfterPack: new Set() };
    this.pause = { active: false, pauseId: null };
    this.purchase = {};
    this.synthetic = { second: [] };
    this.calendar = { outfitCalendarId: null, connectionId: null };
    this.lastDirect = []; // receipts of direct wear reports, candidates for undo
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

  /**
   * The complete wardrobe with availability for a date, read fresh every time: background work (queues,
   * alarms, daily maintenance) can change the wardrobe without any request the simulator counts, so a
   * cached reading could be stale.
   */
  async snapshot(date = this.today()) {
    const envelope = await this.inventory({ view: "snapshot", date });
    const items = envelope.data.items ?? [];
    return { date, wardrobeRevision: envelope.wardrobeRevision, complete: envelope.complete, total: envelope.total, items, byId: new Map(items.map((i) => [i.garment.garmentId, i])), counts: envelope.data.counts };
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

  /**
   * Take back ONE report of these garments on that date (an undo of one receipt). A garment another report
   * still supports stays on the day's record; only when its last report is gone does the date drop it.
   * `all` removes the garment from the date whatever supports it (a correction that takes it off the day).
   */
  forgetWear(date, garmentIds, { all = false } = {}) {
    const day = this.wears.get(date);
    if (!day) return;
    for (const id of garmentIds) {
      const left = all ? 0 : (day.get(id) ?? 0) - 1;
      if (left > 0) day.set(id, left);
      else day.delete(id);
    }
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
   * Every command's route is checked against the 2026-10-05 contract here (`expectContractRoute`), once
   * its outcome is known, that is after the simulated owner has decided a request that waited: the route
   * recorded is the server's first answer (`direct`, or waiting and then `owner_confirmed` or
   * `owner_rejected`), so a direct type that waited fails `contract.*` even though the owner's decision let
   * the run go on. `expectRoute` names a different expected route for a deliberate
   * probe; `skipContract` leaves the route unchecked (only for a probe that is not a connected assistant's
   * request at all).
   *
   * Returns `{ route, receipt, error, proposal }` with route `direct`, `owner_confirmed`,
   * `owner_rejected` or `refused`.
   */
  async command(type, payload, { session = this.sessions.writer, ownerKey = "primary", key, expectedVersions, occurredAt, decision = "confirm", verify = true, label, expectRoute, skipContract = false } = {}) {
    const args = { type, payload, idempotencyKey: key ?? this.key(type), ...(expectedVersions ? { expectedVersions } : {}), ...(occurredAt ? { occurredAt } : {}) };
    // The ledger and the wardrobe as they stood before the call: a request that waits for the owner, or one
    // the owner rejects, must leave the ledger (revision, latest receipts) and every garment's state untouched.
    const ledgerOf = () => this.wardrobeState(session);
    const ledgerBefore = await ledgerOf();
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
      // Nothing may have changed while it waits: a repeat of the same call is still waiting, and the ledger
      // (revision and latest receipts) is exactly as it was before the first call.
      const waiting = await session.callTool("garderobe_command", args);
      const ledgerWaiting = await ledgerOf();
      const waitingChanges = wardrobeStateChanges(ledgerBefore, ledgerWaiting);
      const untouched = waitingChanges.length === 0;
      this.check("proposal.not_executed_before_owner_decides", !waiting.ok && waiting.error.code === "confirmation_required" && String(waiting.error.details?.proposalId) === proposalId && untouched, `${type}: before the owner's decision a repeat answered ${waiting.ok ? "with a receipt" : waiting.error.code}${untouched ? "" : `; meanwhile: ${waitingChanges.slice(0, 5).join("; ")}`}`, { proposalId, revisionBefore: ledgerBefore.revision, revisionWaiting: ledgerWaiting.revision, changes: waitingChanges.slice(0, 20) });
      const decided = await this.target.api(ownerKey, "POST", `/v1/proposals/${proposalId}/decision`, { decision });
      if (!decided.ok) outcome = { route: "refused", receipt: null, error: decided.json?.error ?? { code: `http_${decided.status}`, message: decided.text.slice(0, 300), details: {} }, proposal: listed ?? null, refusedAtConfirmation: true };
      else if (decision === "reject") {
        // The rejection itself must run nothing: the ledger right after it, and again after the repeated
        // call, is exactly the ledger from before the first call.
        const ledgerRejected = await ledgerOf();
        const after = await session.callTool("garderobe_command", args);
        const ledgerAfter = await ledgerOf();
        const rejectedChanges = wardrobeStateChanges(ledgerBefore, ledgerRejected);
        const afterChanges = wardrobeStateChanges(ledgerBefore, ledgerAfter);
        this.check("proposal.rejected_stays_unexecuted", !after.ok && after.error.code === "forbidden" && rejectedChanges.length === 0 && afterChanges.length === 0, `${type}: after the owner's rejection the repeat answered ${after.ok ? "with a receipt" : after.error.code}; at the rejection: ${rejectedChanges.slice(0, 3).join("; ") || "nothing changed"}; after the repeat: ${afterChanges.slice(0, 3).join("; ") || "nothing changed"}`, { proposalId, revisionBefore: ledgerBefore.revision, revisionRejected: ledgerRejected.revision, revisionAfter: ledgerAfter.revision, rejectedChanges: rejectedChanges.slice(0, 20), afterChanges: afterChanges.slice(0, 20) });
        outcome = { route: "owner_rejected", receipt: null, error: null, proposal: listed ?? null };
      } else outcome = { route: "owner_confirmed", receipt: decided.json.receipt, error: null, proposal: listed ?? null };
    }
    this.commandLog.push({ step: this.stepIndex, day: this.step?.day ?? null, type, label: label ?? null, route: outcome.route, outcome: outcome.receipt?.outcome ?? null, code: outcome.error?.code ?? null, reason: outcome.error?.details?.reason ?? null, commandId: outcome.receipt?.commandId ?? null, summary: outcome.receipt?.summary ?? outcome.error?.message ?? null });
    this.trace.push(["command", type, outcome.route, outcome.receipt?.outcome ?? outcome.error?.code ?? null]);
    this.count(`route.${outcome.route}`);
    // An accepted command (applied at once, or confirmed by the owner) must answer with its receipt.
    if (outcome.route === "direct" || outcome.route === "owner_confirmed") {
      const hasReceipt = typeof outcome.receipt === "object" && outcome.receipt !== null && typeof outcome.receipt.commandId === "string" && outcome.receipt.commandId.length > 0;
      this.check("receipt.an_accepted_command_returns_one", hasReceipt, `${type}: accepted (${outcome.route}) without a receipt`, { route: outcome.route, receipt: outcome.receipt ?? null });
    }
    // A piece the owner reports dirty after packing has spent its trip reuse (packages/daily/src/context.ts).
    if (type === "care.mark_dirty" && outcome.receipt && this.trip.packed.size > 0) for (const i of payload?.items ?? []) if (i?.garmentId) this.trip.dirtyAfterPack.add(i.garmentId);
    if (!skipContract) this.expectContractRoute(type, outcome, expectRoute);
    if (outcome.receipt && verify) await this.verifyReceipt(session, args, outcome);
    if (outcome.receipt && session !== this.sessions.second) this.primaryCommandIds.push(outcome.receipt.commandId);
    return outcome;
  }

  /**
   * Check that a connected assistant's typed command took the route the 2026-10-05 contract gives its type:
   * a change the owner asks for applies at once (`direct`), a section 3 type waits for the owner, a lift is
   * refused. A direct receipt must also say whether it can be undone (contract section 4).
   *
   * A refusal for a domain reason (an invalid payload, a stale version, an unknown garment) is not a routing
   * decision and passes here; whether the change had to be accepted is the caller's check. Each outcome is
   * checked once: `command` checks every outcome, and a handler's own call returns the recorded result.
   */
  expectContractRoute(type, outcome, expectRoute = undefined) {
    if (outcome.contractChecked !== undefined) return outcome.contractChecked;
    const expected = expectRoute ?? contractRoute(type);
    const id = expected === "direct" ? "contract.a_change_the_owner_asks_for_applies_at_once" : expected === "refused" ? "contract.a_connected_assistant_cannot_lift_a_restriction" : "contract.only_section_3_changes_wait_for_the_owner";
    const code = outcome.error?.code ?? null;
    const domainRefusal = outcome.route === "refused" && !outcome.refusedAtConfirmation && DOMAIN_REFUSAL_CODES.has(code);
    // A refusal that is neither a routing answer nor a recognised domain refusal (internal, unavailable,
    // unparsed or unknown) establishes no route at all: it fails here rather than passing as "domain".
    if (outcome.route === "refused" && !outcome.refusedAtConfirmation && code !== "forbidden" && code !== "confirmation_required" && !domainRefusal) {
      outcome.contractChecked = false;
      this.check("contract.route_is_decided", false, `${type}: refused with ${code ?? "no code"} (${outcome.error?.message ?? "no message"}), which decides no route`, { type, error: outcome.error ?? null });
      return false;
    }
    let ok;
    if (expected === "refused") ok = outcome.route === "refused" && code === "forbidden";
    else if (expected === "direct") ok = outcome.route === "direct" || domainRefusal;
    else ok = outcome.route === "owner_confirmed" || outcome.route === "owner_rejected" || (outcome.route === "refused" && (outcome.refusedAtConfirmation || domainRefusal));
    outcome.contractChecked = ok;
    this.check(id, ok, `${type} from the connected assistant took the route ${outcome.route}${outcome.error ? ` (${outcome.error.code})` : ""}; the contract expects ${expected}`, { type, route: outcome.route, error: outcome.error ?? null, commandId: outcome.receipt?.commandId ?? null });
    if (expected === "direct" && outcome.route === "direct" && outcome.receipt) this.check("contract.receipt_states_whether_undo_is_available", typeof outcome.receipt.undo?.available === "boolean", `${type}: the receipt does not say whether it can be undone`, { commandId: outcome.receipt.commandId, undo: outcome.receipt.undo ?? null });
    return ok;
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
    // Read back: the stored receipt is the one that was returned, field for field (only the replay flag,
    // which describes the response rather than the receipt, is left out).
    const before = await this.inventory({ view: "receipts", limit: 20 }, session);
    const stored = (before.data.receipts ?? []).find((r) => r.commandId === receipt.commandId);
    const comparable = (r) => {
      const { replayed: _replayed, ...rest } = r ?? {};
      return stableJson(rest);
    };
    this.check("receipt.reads_back_as_returned", Boolean(stored) && comparable(stored) === comparable(receipt), `${type}: the stored receipt differs from the returned one or is missing`, { commandId: receipt.commandId, returned: receipt, stored: stored ?? null });
    this.check("receipt.revision_not_ahead_of_ledger", receipt.wardrobeRevision <= before.wardrobeRevision, `${type}: receipt says wardrobe revision ${receipt.wardrobeRevision}, the ledger is at ${before.wardrobeRevision}`, { commandId: receipt.commandId });
    // Idempotent: the same call again returns the stored receipt, field for field, and writes nothing: the
    // ledger (revision, latest receipts) and every garment's state are as they were before the repeat.
    const stateBeforeRepeat = await this.wardrobeState(session);
    const again = await session.callTool("garderobe_command", args);
    this.check("receipt.idempotent_repeat", again.ok && again.data.receipt.replayed === true && comparable(again.data.receipt) === comparable(receipt), `${type}: a repeat of the same call answered ${again.ok ? `command ${again.data.receipt.commandId}, replayed ${again.data.receipt.replayed}${comparable(again.data.receipt) === comparable(receipt) ? "" : ", with a receipt that differs from the original"}` : again.error.code}`, { commandId: receipt.commandId, original: receipt, replay: again.ok ? again.data.receipt : null });
    const stateAfterRepeat = await this.wardrobeState(session);
    const repeatChanges = wardrobeStateChanges(stateBeforeRepeat, stateAfterRepeat);
    this.check("receipt.repeat_writes_nothing", repeatChanges.length === 0, `${type}: after the repeat: ${repeatChanges.slice(0, 5).join("; ")}`, { commandId: receipt.commandId, changes: repeatChanges.slice(0, 20), newReceipts: newReceipts(stateBeforeRepeat, stateAfterRepeat) });
  }

  /** The same key with a different request must be refused, never run: nothing in the ledger or the wardrobe moves. */
  async probeKeyReuse(type, payload, otherPayload) {
    const key = this.key(`reuse-${type}`);
    const first = await this.command(type, payload, { key, verify: false, label: "key-reuse probe" });
    if (!first.receipt || first.route !== "direct") return first;
    const before = await this.wardrobeState();
    const reused = await this.sessions.writer.callTool("garderobe_command", { type, payload: otherPayload, idempotencyKey: key });
    const after = await this.wardrobeState();
    const changed = wardrobeStateChanges(before, after);
    this.check("receipt.key_reuse_refused", !reused.ok && reused.error.code === "idempotency_key_reuse", `${type}: the same key with a different request answered ${reused.ok ? "with a receipt" : reused.error.code}`, { commandId: first.receipt.commandId });
    this.check("receipt.key_reuse_runs_nothing", changed.length === 0, `${type}: after the same key was reused with a different request: ${changed.slice(0, 5).join("; ")}`, { commandId: first.receipt.commandId, changed: changed.slice(0, 20) });
    return first;
  }

  /** The ledger (revision, latest receipts) and every garment's balances and wear count, read fresh through MCP. */
  async wardrobeState(session = this.sessions.reader) {
    const receipts = await this.inventory({ view: "receipts", limit: RECEIPT_WINDOW }, session);
    const snapshot = await this.inventory({ view: "snapshot" }, session);
    const list = receipts.data.receipts ?? [];
    return {
      revision: receipts.wardrobeRevision,
      receipts: list.map((r) => r.commandId).join(","),
      // Kept so a check can say which commands appeared (an assistant turn's, or background, daily or maintenance work).
      receiptList: list.map((r) => ({ commandId: r.commandId, type: r.type, outcome: r.outcome, actor: r.actor, channel: r.channel, at: r.committedAt ?? r.recordedAt ?? r.occurredAt ?? null })),
      garments: new Map((snapshot.data.items ?? []).map((i) => [i.garment.garmentId, garmentFingerprint(i)])),
    };
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

  /**
   * A digest of what happened, without identifiers or clock readings. It identifies a run; it is not equal
   * across fresh databases, because the product's board jitter is keyed by the generated owner and garment IDs.
   */
  outcomeDigest() {
    return digest(this.trace);
  }
}
