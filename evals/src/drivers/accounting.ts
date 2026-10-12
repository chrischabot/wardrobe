/**
 * Behavioural drivers of the accounting cases (B001 to B010). Each one puts the application into the
 * scenario's starting state with ordinary commands, lets the owner's sentence happen, and reads the outcome
 * back from application state (item pages, day records, the laundry sheet, availability, receipts, the
 * owner's list of requests). Nothing here is a judgement: `observe` reports what the application holds.
 *
 * One seeding step uses the owner's system principal instead of an owner route, because the product has no
 * owner route for it: registering a set of offered options for a date (`exposure.publish`, the command the
 * daily service itself uses when it publishes a board). Marking one as chosen (`exposure.select`) is the
 * owner's own command and is sent as the owner. Both are labelled where they occur.
 */
import { connectMcp, publishBoard, testApp } from "@garderobe/worker/testing";
import { addDays, exec, isoWeekday, mcpCommand, quantityIn, wholeWardrobe } from "../../../tests/journeys/src/world.ts";
import { fixtureGarmentPayload, receiptsSince, unrebase, type BehaviourDriver, type DriverContext, type World } from "../kit.ts";
import { garmentsCreated, garmentsCreatedByReceipts, ownerQuestions } from "../rules.mjs";

const noon = (date: string) => `${date}T12:00:00.000Z`;

function garment(world: World, fixtureId: string): string {
  const found = world.fixture.get(fixtureId);
  if (!found) throw new Error(`fixture garment ${fixtureId} is not in this world`);
  return found.garmentId;
}
const nameOf = (world: World, fixtureId: string): string => world.fixture.get(fixtureId)?.name ?? fixtureId;
const item = (world: World, garmentId: string): Promise<any> => world.owner.api.json("GET", `/v1/items/${garmentId}`);
const dayRecord = (world: World, date: string): Promise<any> => world.owner.api.json("GET", `/v1/days/${date}`);
const tell = (world: World, type: string, payload: Record<string, unknown>, opts: { occurredAt?: string } = {}) => exec(world.owner.api, type, payload, opts);

async function wearCount(world: World, garmentId: string): Promise<number> {
  return Number((await item(world, garmentId)).detail.recordedWearCount);
}

/**
 * Wears newly counted by any command recorded since `since`, read from the receipts themselves, so a wear that
 * was created and then undone, or offset by removing another, is still counted. A merged report creates no
 * new wear entry. Returns the count and the receipts that created them.
 */
async function wearsCreatedSince(world: World, since: string): Promise<{ count: number; receipts: { commandId: string; type: string; summary: string; counted: string[] }[] }> {
  const receipts = await receiptsSince(world, since);
  const created: { commandId: string; type: string; summary: string; counted: string[] }[] = [];
  for (const r of receipts) {
    const fromChanges = ((r.changes?.wears ?? []) as { garmentId: string; change: string }[]).filter((w) => w.change === "counted").map((w) => String(w.garmentId));
    const counted = fromChanges.length > 0 ? fromChanges : ((r.result?.counted ?? []) as unknown[]).map(String);
    if (counted.length > 0) created.push({ commandId: String(r.commandId), type: String(r.type), summary: String(r.summary ?? ""), counted });
  }
  return { count: created.reduce((n, r) => n + r.counted.length, 0), receipts: created };
}

/** Every counted wear the application holds for this owner. */
async function totalWears(world: World): Promise<number> {
  const { items } = await wholeWardrobe(world.owner.api);
  return items.reduce((n, i) => n + Number(i.recordedWearCount ?? 0), 0);
}

/** What is waiting for the owner: requests to confirm, and runs that stopped to ask a question. */
async function waiting(world: World): Promise<{ proposals: number; runsNeedingInput: number; total: number }> {
  const proposals = ((await world.owner.api.json("GET", "/v1/proposals")).proposals as unknown[]).length;
  const runsNeedingInput = Number((await world.owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput);
  return { proposals, runsNeedingInput, total: proposals + runsNeedingInput };
}

/**
 * What was asked of the owner during the evaluated interval, counted as records created, not as the change in
 * an outstanding queue (a request raised and then resolved is still counted; resolving an older one cannot
 * offset a new one). Requests to confirm: every proposal of this owner, in any state, proposed at or after
 * `since`. Questions: the evaluated turn stopping to ask (its run is left waiting for input; nothing in the
 * harness answers it), plus any other run of this owner that is waiting for input and was not before, plus the
 * questions the assistant's completed reply asks (counted with the turn's own question, not on top of it, since a
 * turn that stops to ask states that question in its reply).
 */
async function askedSince(world: World, since: string, turn: { state: string; replyText?: string } | null, runsWaitingBefore: number): Promise<{ requests: number; questions: number; total: number | null; questions_in_reply: string[]; runs_count_uncertain: boolean; proposals: { proposalId: string; type: string; state: string; proposedAt: string }[] }> {
  const all = (await world.owner.api.json("GET", "/v1/proposals?state=all")).proposals as { proposalId: string; type: string; state: string; proposedAt: string }[];
  const created = all.filter((p) => Date.parse(p.proposedAt) >= Date.parse(since));
  const waitingNow = Number((await world.owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput);
  const turnAsked = turn?.state === "needs_input" ? 1 : 0;
  const otherRunsWaiting = Math.max(0, waitingNow - runsWaitingBefore - turnAsked);
  // The API reports waiting runs only as a count (no route lists them), so with runs already waiting at the seed
  // a new one could be offset by an older one resolving: "none" is then not established.
  const runsUncertain = runsWaitingBefore > 0 && otherRunsWaiting === 0;
  const counted = ownerQuestions({ proposals: created.length, turnAsked, otherRunsWaiting, replyText: turn?.replyText ?? null, runsUncertain });
  return { requests: created.length, questions: counted.questions, total: counted.total, questions_in_reply: counted.replyQuestions, runs_count_uncertain: runsUncertain, proposals: created.map((p) => ({ proposalId: p.proposalId, type: p.type, state: p.state, proposedAt: p.proposedAt })) };
}

const runsWaiting = async (world: World): Promise<number> => Number((await world.owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput);
const nowInstant = (): string => new Date().toISOString();

/** The newest stored receipts of this owner (one page), optionally of one command type. */
async function receipts(world: World, type?: string): Promise<Record<string, any>[]> {
  const body: any = await world.owner.api.json("GET", "/v1/commands?limit=100");
  return (body.receipts as Record<string, any>[]).filter((r) => !type || r.type === type);
}

/** A command with the owner's system authority, for the seeding step that has no owner route. */
async function asSystem(world: World, type: string, payload: Record<string, unknown>): Promise<any> {
  const app = await testApp();
  return app.service.execute(world.owner.systemPrincipal, { type, payload, idempotencyKey: `eval-seed-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "system_schedule", source: { channel: "system" } } as never);
}

const lastSunday = (today: string): string => {
  let day = today;
  while (isoWeekday(day) !== 7) day = addDays(day, -1);
  return day;
};

/** Where the application holds a garment's units, in the corpus's words. */
function locationOf(detail: { balances: { bucket: string; quantity: number }[] }): string {
  const held = detail.balances.filter((b) => b.quantity > 0).map((b) => b.bucket);
  if (held.length > 0 && held.every((b) => b === "clean" || b === "dirty")) return "with_owner";
  return held.length === 0 ? "nowhere" : [...new Set(held)].sort().join("+");
}

const B001: BehaviourDriver = {
  // Six days of offered and chosen outfits, none of them ever reported as worn.
  async seed({ world, memo }) {
    const shirts = ["shirt-moss", "shirt-slate", "shirt-pink", "shirt-gold", "shirt-laurel", "shirt-blue"];
    const trousers = ["trouser-navy", "trouser-walnut", "trouser-beige", "trouser-olive", "trouser-grey"];
    const socks = ["sock-navy", "sock-brown", "sock-forest", "sock-teal", "sock-mustard"];
    const shoes = ["shoe-navy", "shoe-grey", "shoe-olive"];
    const seeded: { exposureId: string; localDate: string; selected: string }[] = [];
    for (let back = 6; back >= 1; back--) {
      const localDate = world.day(-back);
      const options = [0, 1, 2, 3, 4].map((k) => ({
        optionId: `option-${k + 1}`,
        garmentIds: [garment(world, shirts[(k + back) % shirts.length]!), garment(world, trousers[(k + back) % trousers.length]!), garment(world, socks[(k + back) % socks.length]!), garment(world, shoes[(k + back) % shoes.length]!)],
        alternativeGroups: [],
      }));
      const exposureId = `eval-b001-${localDate}-${crypto.randomUUID().slice(0, 8)}`;
      // System-principal seeding (see the head of this file): a published set of options; then the owner's
      // choice, which only the owner may record.
      await asSystem(world, "exposure.publish", { exposureId, localDate, sourceKind: "board", sourceRef: `evals:B001:${localDate}`, options });
      await tell(world, "exposure.select", { exposureId, optionId: "option-1", chosenAlternatives: [] });
      seeded.push({ exposureId, localDate, selected: "option-1" });
    }
    memo.seeded = seeded;
    memo.wearsBefore = await totalWears(world);
    memo.waitingBefore = await waiting(world);
    memo.runsWaitingBefore = await runsWaiting(world);
    memo.since = nowInstant();
  },
  message: ({ c }) => c.request,
  async scripted({ world, memo }) {
    memo.published = await publishBoard(world.owner, { date: world.day(1), count: 5 });
  },
  async observe({ world, memo, turn, actStartedAt }) {
    const asked = await askedSince(world, memo.since, turn, memo.runsWaitingBefore);
    const after = await waiting(world);
    const wearsAfter = await totalWears(world);
    const createdWears = await wearsCreatedSince(world, actStartedAt);
    const tomorrow = await world.owner.api.json("GET", `/v1/today?date=${world.day(1)}`);
    const availability = await world.owner.api.json("GET", `/v1/availability?date=${world.day(1)}`);
    const estimated = (availability.garments as any[]).filter((g) => g.status === "estimated");
    return {
      observed: { status_requests_created: asked.total, confirmed_wear_entries_created: createdWears.count },
      evidence: {
        wear_entries_created_by_receipts: createdWears.receipts,
        unresolved_selections_seeded: memo.seeded,
        asked_during_interval: asked,
        waiting_before: memo.waitingBefore,
        waiting_after: after,
        counted_wears_before: memo.wearsBefore,
        counted_wears_after: wearsAfter,
        board_for_tomorrow: tomorrow.board ? { boardId: tomorrow.board.boardId, revision: tomorrow.board.revision, options: tomorrow.board.options?.length ?? null } : null,
        garments_offered_on_estimates: estimated.length,
        example_basis: estimated[0]?.basis ?? null,
      },
    };
  },
};

const B002: BehaviourDriver = {
  // A Wednesday wear before that week's collection, hand-wash socks worn with it.
  async seed({ world, memo }) {
    const cycle = lastSunday(world.today);
    const worn = addDays(cycle, -4);
    await tell(world, "wear.record", { wearingDate: worn, garmentIds: [garment(world, "shirt-slate"), garment(world, "trouser-navy"), garment(world, "sock-navy")] });
    memo.cycle = cycle;
    memo.worn = worn;
    memo.socksBefore = (await item(world, garment(world, "sock-navy"))).detail.balances;
    memo.shirtBefore = (await item(world, garment(world, "shirt-slate"))).detail.balances;
  },
  message: ({ c, world }) => `${c.request} The ${nameOf(world, "shirt-moss")} is still at the tailor.`,
  // What the owner says: the moss shirt is at the tailor; then the board is asked for.
  async scripted({ world, memo }) {
    memo.moved = await tell(world, "garment.move", { garmentId: garment(world, "shirt-moss"), to: "tailor", note: "still at the tailor" });
    memo.published = await publishBoard(world.owner, { date: world.today, count: 5 });
  },
  // Not said to the assistant: the weekly baseline falls due. It is sent twice, as a job that ran again would.
  async act({ world, memo }) {
    memo.first = await tell(world, "laundry.apply_weekly_reset", {});
    memo.second = await tell(world, "laundry.apply_weekly_reset", {});
  },
  async observe({ world, memo }) {
    const resets = await receipts(world, "laundry.apply_weekly_reset");
    const committed = resets.filter((r) => r.outcome === "committed");
    // Applications are the laundry cycles the application says it applied (each `cyclesApplied` entry is one
    // channel's cycle), so a reset applying two cycles counts two and a no-op counts none.
    const cyclesApplied = committed.flatMap((r) => (Array.isArray(r.result?.cyclesApplied) ? (r.result.cyclesApplied as { channel: string; cycleKey: string }[]) : []));
    const moss = await item(world, garment(world, "shirt-moss"));
    const socks = (await item(world, garment(world, "sock-navy"))).detail.balances;
    const shirt = (await item(world, garment(world, "shirt-slate"))).detail;
    const laundry = await world.owner.api.json("GET", "/v1/laundry");
    const observedReturns = committed.reduce((n, r) => n + Number(r.result?.observedReturnsRecorded ?? 0), 0) + (laundry.batches as any[]).filter((b) => b.status === "returned" || b.returnBasis === "observed").length;
    return {
      observed: {
        routine_reset_applications: cyclesApplied.length,
        moss_tailor_restriction_active: quantityIn(moss.detail, "tailor") > 0 && moss.availability.hardExcluded === true && (moss.availability.reasons as string[]).includes("at_tailor"),
        handwash_changed_by_service_reset: JSON.stringify(socks) !== JSON.stringify(memo.socksBefore),
        observed_returns_fabricated: observedReturns,
      },
      evidence: {
        cycle_key: memo.cycle,
        cycles_applied: cyclesApplied,
        wear_before_collection_on: memo.worn,
        reset_receipts: resets.map((r) => ({ commandId: r.commandId, outcome: r.outcome, summary: r.summary, cyclesApplied: r.result?.cyclesApplied ?? null, observedReturnsRecorded: r.result?.observedReturnsRecorded ?? null })),
        second_send_outcome: memo.second?.outcome ?? null,
        cycles: laundry.cycles,
        batches: laundry.batches,
        moss: { balances: moss.detail.balances, availability: { hardExcluded: moss.availability.hardExcluded, reasons: moss.availability.reasons } },
        moss_in_published_board: memo.published?.board ? (memo.published.board.options as any[]).some((o) => (o.garments as any[]).some((line) => line.garmentId === garment(world, "shirt-moss"))) : null,
        handwash_socks_before: memo.socksBefore,
        handwash_socks_after: socks,
        service_shirt_before: memo.shirtBefore,
        service_shirt_after: shirt.balances,
        service_shirt_counted_wears: shirt.recordedWearCount,
      },
    };
  },
};

const B003: BehaviourDriver = {
  // The controlled set of the scenario: five options for tomorrow, the navy chinos in three, one of the five certain to be worn.
  async seed({ world, c, memo }) {
    const navy = garment(world, "trouser-navy");
    const tops = ["shirt-moss", "shirt-slate", "shirt-pink", "shirt-gold", "shirt-blue"].map((id) => garment(world, id));
    const count = Number(c.scenario.options);
    const withNavy = Number(c.scenario.navy_occurs_in_options);
    const others = [garment(world, "trouser-beige"), garment(world, "trouser-olive"), garment(world, "trouser-grey"), garment(world, "trouser-walnut")];
    const options = Array.from({ length: count }, (_, k) => ({ optionId: `option-${k + 1}`, garmentIds: [tops[k % tops.length]!, k < withNavy ? navy : others[(k - withNavy) % others.length]!], alternativeGroups: [] }));
    const exposureId = `eval-b003-${crypto.randomUUID().slice(0, 8)}`;
    // System-principal seeding (see the head of this file).
    memo.publish = await asSystem(world, "exposure.publish", { exposureId, localDate: world.day(1), sourceKind: "test", sourceRef: "evals:B003:controlled-fixture", options, pUse: Number(c.scenario.board_choice_probability) });
    memo.exposureId = exposureId;
    memo.options = options;
    memo.wearsBefore = await totalWears(world);
  },
  message: ({ c, world }) => `${c.request.replace("these two pairs of navy chinos", `my two pairs of ${nameOf(world, "trouser-navy")}`)}`,
  // The sentence states no ledger command: the plan is the controlled set already registered for tomorrow.
  async scripted() {},
  async observe({ world, memo, actStartedAt }) {
    const navy = garment(world, "trouser-navy");
    const availability = await world.owner.api.json("GET", `/v1/availability?date=${world.day(2)}`);
    const estimate = (availability.garments as any[]).find((g) => g.garmentId === navy);
    if (!estimate) throw new Error("the availability snapshot has no entry for the navy chinos");
    const forTomorrow = (estimate.inferredWear as { localDate: string; probability: number }[]).find((w) => w.localDate === world.day(1));
    const wearsAfter = await totalWears(world);
    const createdWears = await wearsCreatedSince(world, actStartedAt);
    return {
      observed: { navy_selection_probability: forTomorrow ? Number(forTomorrow.probability.toFixed(12)) : 0, confirmed_wear_entries_created: createdWears.count },
      evidence: { wear_entries_created_by_receipts: createdWears.receipts, exposure_id: memo.exposureId, options: memo.options, availability_for: world.day(2), model_version: availability.modelVersion, parameters: availability.parameters, navy_estimate: { status: estimate.status, pAvailable: estimate.pAvailable, inferredWear: estimate.inferredWear, balances: estimate.balances, basis: estimate.basis }, counted_wears_before: memo.wearsBefore, counted_wears_after: wearsAfter },
    };
  },
};

const B004_PIECES = ["shirt-red-stripe", "shirt-moss", "trouser-olive", "sock-navy", "shoe-navy"];
const B004: BehaviourDriver = {
  async seed({ world, c, memo }) {
    await tell(world, "wear.record", { wearingDate: world.today, garmentIds: (c.scenario.already_worn as string[]).map((id) => garment(world, id)), segment: "morning" });
    memo.before = {} as Record<string, number>;
    for (const id of B004_PIECES) memo.before[id] = await wearCount(world, garment(world, id));
    memo.socksBefore = (await item(world, garment(world, "sock-navy"))).detail.balances;
  },
  message: ({ world }) => `I changed from the ${nameOf(world, "shirt-moss")} to the ${nameOf(world, "shirt-red-stripe")}, kept everything else.`,
  async scripted({ world, c, memo }) {
    const kept = (c.scenario.already_worn as string[]).filter((id) => id !== "shirt-moss");
    memo.receipt = await tell(world, "wear.record", { wearingDate: world.today, garmentIds: [...(c.scenario.new as string[]), ...kept].map((id) => garment(world, id)), segment: "evening" });
  },
  async observe({ world, memo }) {
    const deltas: Record<string, number> = {};
    for (const id of B004_PIECES) deltas[id] = (await wearCount(world, garment(world, id))) - memo.before[id];
    const socks = (await item(world, garment(world, "sock-navy"))).detail;
    const today = await dayRecord(world, world.today);
    return {
      observed: { wear_deltas: deltas, additional_sock_pairs_consumed: quantityIn(socks, "dirty") - quantityIn({ balances: memo.socksBefore }, "dirty") },
      evidence: { counted_before: memo.before, socks_before: memo.socksBefore, socks_after: socks.balances, day_record: today.garments, receipt: memo.receipt ? { commandId: memo.receipt.commandId, outcome: memo.receipt.outcome, summary: memo.receipt.summary, result: memo.receipt.result } : null },
    };
  },
};

const B005: BehaviourDriver = {
  async seed({ world, memo }) {
    memo.before = await wearCount(world, garment(world, "trouser-olive"));
  },
  message: ({ world }) => `I wore the ${nameOf(world, "trouser-olive")} yesterday and today.`,
  async scripted({ world, memo }) {
    const id = garment(world, "trouser-olive");
    memo.receipts = [await tell(world, "wear.record", { wearingDate: world.day(-1), garmentIds: [id] }), await tell(world, "wear.record", { wearingDate: world.today, garmentIds: [id] })];
  },
  async observe({ world, memo }) {
    const detail = (await item(world, garment(world, "trouser-olive"))).detail;
    const active = (detail.recentWears as { wearingDate: string; status: string }[]).filter((w) => w.status === "active");
    return {
      observed: { counted_wears: Number(detail.recordedWearCount) - memo.before, wearing_dates: active.map((w) => unrebase(world, w.wearingDate)).sort() },
      evidence: { run_dates: active.map((w) => w.wearingDate).sort(), counted_before: memo.before, counted_after: detail.recordedWearCount, balances: detail.balances, receipts: (memo.receipts ?? []).map((r: any) => ({ commandId: r.commandId, outcome: r.outcome, summary: r.summary })) },
    };
  },
};

const B006: BehaviourDriver = {
  async seed({ world, memo }) {
    memo.waitingBefore = await waiting(world);
    memo.runsWaitingBefore = await runsWaiting(world);
    memo.since = nowInstant();
  },
  // The reports come from two clients, not from this sentence; it is sent without the scenario's listing.
  message: ({ c }) => c.request,
  async scripted() {},
  // The same wear, reported by the phone and by a connected assistant over the MCP server.
  async act({ world, memo }) {
    const moss = garment(world, "shirt-moss");
    const phone = await tell(world, "wear.record", { wearingDate: world.today, garmentIds: [moss] });
    const mcp = await connectMcp(world.owner, { write: true, clientName: "Evaluation wear relay", redirectUri: "https://eval-wear-relay.client.test/cb" });
    try {
      const relayed = await mcpCommand(world.owner, mcp, "wear.record", { wearingDate: world.today, garmentIds: [moss] });
      memo.reports = { phone: { commandId: phone.commandId, outcome: phone.outcome, channel: phone.channel }, mcp: { commandId: relayed.receipt.commandId, outcome: relayed.receipt.outcome, channel: relayed.receipt.channel, route: relayed.route } };
    } finally {
      await mcp.close();
    }
  },
  async observe({ world, memo, turn }) {
    const moss = garment(world, "shirt-moss");
    const detail = (await item(world, moss)).detail;
    const today = await dayRecord(world, world.today);
    const sources = (today.observations as any[]).filter((o) => o.garmentId === moss && o.status === "active");
    const asked = await askedSince(world, memo.since, turn, memo.runsWaitingBefore);
    const after = await waiting(world);
    return {
      observed: { counted_wears: Number(detail.recordedWearCount), source_observations_retained: sources.length, status_questions: asked.total },
      evidence: { reports: memo.reports, sources: sources.map((o) => ({ channel: o.channel, commandId: o.commandId, status: o.status })), balances: detail.balances, asked_during_interval: asked, waiting_before: memo.waitingBefore, waiting_after: after },
    };
  },
};

const B007: BehaviourDriver = {
  // The known event: the moss shirt was washed this morning (10 AM, or just now when the run is earlier than that).
  async seed({ world, memo }) {
    const tenLocal = `${world.today}T09:00:00.000Z`;
    const washedAt = Date.parse(tenLocal) < Date.now() - 60_000 ? tenLocal : new Date(Date.now() - 60_000).toISOString();
    memo.wash = await tell(world, "care.washed", { items: [{ garmentId: garment(world, "shirt-moss") }] }, { occurredAt: washedAt });
    memo.washedAt = washedAt;
    memo.waitingBefore = await waiting(world);
    memo.runsWaitingBefore = await runsWaiting(world);
    memo.since = nowInstant();
  },
  message: ({ world }) => `I forgot to log it, but I wore the ${nameOf(world, "shirt-moss")} yesterday.`,
  async scripted({ world, memo }) {
    memo.receipt = await tell(world, "wear.record", { wearingDate: world.day(-1), garmentIds: [garment(world, "shirt-moss")] });
  },
  async observe({ world, memo, turn }) {
    const moss = garment(world, "shirt-moss");
    const shirt = await item(world, moss);
    const yesterday = await dayRecord(world, world.day(-1));
    const asked = await askedSince(world, memo.since, turn, memo.runsWaitingBefore);
    const after = await waiting(world);
    return {
      observed: {
        yesterday_wear_recorded: (yesterday.garments as any[]).some((line) => line.garmentId === moss) && shirt.detail.lastRecordedWear === world.day(-1),
        current_clean_state: quantityIn(shirt.detail, "clean") === shirt.detail.totalOwnedUnits && shirt.availability.hardExcluded === false,
        conflict_questions: asked.total,
      },
      evidence: { washed_at: memo.washedAt, wash_receipt: { commandId: memo.wash.commandId, summary: memo.wash.summary }, balances: shirt.detail.balances, movements: (shirt.detail.movements as any[]).map((m) => ({ kind: m.kind, from: m.from, to: m.to, basis: m.basis })), counted_wears: shirt.detail.recordedWearCount, last_recorded_wear: shirt.detail.lastRecordedWear, receipt: memo.receipt ? { commandId: memo.receipt.commandId, outcome: memo.receipt.outcome, summary: memo.receipt.summary, repairs: memo.receipt.repairs } : null, asked_during_interval: asked, waiting_before: memo.waitingBefore, waiting_after: after },
    };
  },
};

const B008: BehaviourDriver = {
  // The trousers are dirty from yesterday's wear; no pickup exists and no wash was expected.
  async seed({ world, memo }) {
    const olive = garment(world, "trouser-olive");
    await tell(world, "wear.record", { wearingDate: world.day(-1), garmentIds: [olive] });
    const detail = (await item(world, olive)).detail;
    memo.before = { count: Number(detail.recordedWearCount), wears: detail.recentWears, balances: detail.balances, movements: (detail.movements as unknown[]).length, movementIds: (detail.movements as any[]).map((m) => String(m.eventId)) };
  },
  message: ({ world }) => `I just washed the ${nameOf(world, "trouser-olive")}.`,
  async scripted({ world, memo }) {
    memo.receipt = await tell(world, "care.washed", { items: [{ garmentId: garment(world, "trouser-olive") }] });
  },
  async observe({ world, memo }) {
    const trousers = await item(world, garment(world, "trouser-olive"));
    const movements = trousers.detail.movements as any[];
    const laundry = await world.owner.api.json("GET", "/v1/laundry");
    const active = (list: any[]) => list.filter((w) => w.status === "active").map((w) => w.wearingDate).sort();
    return {
      observed: {
        // A wash movement that did not exist at the seed, by its event identifier (the list may be newest first or capped).
        wash_recorded: movements.some((m) => m.kind === "wash" && !(memo.before.movementIds as string[]).includes(String(m.eventId))),
        current_clean_state: quantityIn(trousers.detail, "clean") === trousers.detail.totalOwnedUnits && trousers.availability.hardExcluded === false,
        prior_wear_history_preserved: Number(trousers.detail.recordedWearCount) === memo.before.count && JSON.stringify(active(trousers.detail.recentWears)) === JSON.stringify(active(memo.before.wears)),
      },
      evidence: { before: memo.before, balances: trousers.detail.balances, movements: movements.map((m) => ({ kind: m.kind, from: m.from, to: m.to, basis: m.basis })), counted_wears: trousers.detail.recordedWearCount, batches: laundry.batches, receipt: memo.receipt ? { commandId: memo.receipt.commandId, outcome: memo.receipt.outcome, summary: memo.receipt.summary } : null },
    };
  },
};

const B009: BehaviourDriver = {
  async seed({ world, memo }) {
    const coat = garment(world, "jacket-blue-work");
    await tell(world, "garment.move", { garmentId: coat, to: "tailor", note: "at the tailor" });
    const before = await item(world, coat);
    memo.before = { balances: before.detail.balances, location: locationOf(before.detail), hardExcluded: before.availability.hardExcluded, reasons: before.availability.reasons };
    memo.garmentIdsBefore = (await wholeWardrobe(world.owner.api)).items.map((i: any) => String(i.garment.garmentId));
    memo.garmentsBefore = (memo.garmentIdsBefore as string[]).length;
    memo.waitingBefore = await waiting(world);
  },
  message: ({ world }) => `I have the ${nameOf(world, "jacket-blue-work")} on right now.`,
  async scripted({ world, memo }) {
    memo.receipt = await tell(world, "wear.record", { wearingDate: world.today, garmentIds: [garment(world, "jacket-blue-work")] });
  },
  async observe({ world, memo, actStartedAt }) {
    const coat = garment(world, "jacket-blue-work");
    const after = await item(world, coat);
    const today = await dayRecord(world, world.today);
    const idsAfter = (await wholeWardrobe(world.owner.api)).items.map((i: any) => String(i.garment.garmentId));
    const garmentsAfter = idsAfter.length;
    // Garments that exist now and did not before: a duplicate is counted even if another garment was removed or merged meanwhile.
    const surviving = garmentsCreated(memo.garmentIdsBefore as string[] | undefined, idsAfter);
    // Creations recorded in the interval's receipts: a duplicate created and then removed or merged away still counts.
    const byReceipt = garmentsCreatedByReceipts(await receiptsSince(world, actStartedAt));
    const created = surviving === null || byReceipt === null ? null : [...new Set([...surviving, ...byReceipt])];
    return {
      observed: {
        current_location: locationOf(after.detail),
        current_wear_recorded: (today.garments as any[]).some((line) => line.garmentId === coat) && after.detail.lastRecordedWear === world.today,
        duplicate_garments_created: created === null ? null : created.length,
      },
      evidence: { before: memo.before, balances: after.detail.balances, total_owned_units: after.detail.totalOwnedUnits, garments_before: memo.garmentsBefore, garments_after: garmentsAfter, garments_created: created, garments_created_still_present: surviving, garments_created_by_receipt: byReceipt, receipt: memo.receipt ? { commandId: memo.receipt.commandId, outcome: memo.receipt.outcome, summary: memo.receipt.summary, repairs: memo.receipt.repairs } : null, waiting_before: memo.waitingBefore, waiting_after: await waiting(world), location_rule: "with_owner when every unit the application holds is in the clean or dirty bucket at home; otherwise the bucket names" },
    };
  },
};

const B010: BehaviourDriver = {
  // Two records of one coat, each with its own report of today's wear.
  async seed({ world, memo }) {
    const work = garment(world, "jacket-blue-work");
    const created = await tell(
      world,
      "garment.create",
      fixtureGarmentPayload({ id: "old-chore", name: "Cotton-linen chore coat", role: "outerwear", owned: true, quantity: 1, availability: "observed_available", fabric: "Cotton and linen outerwear" }),
      { occurredAt: noon(addDays(world.today, -30)) },
    );
    const chore = String(created.result.garmentId);
    await tell(world, "wear.record", { wearingDate: world.today, garmentIds: [work] });
    await tell(world, "wear.record", { wearingDate: world.today, garmentIds: [chore] });
    memo.work = work;
    memo.chore = chore;
    memo.runsWaitingBefore = await runsWaiting(world);
    memo.mergesBefore = (await receipts(world, "garment.merge")).map((r) => r.commandId);
    memo.since = nowInstant();
  },
  message: () => "Blue work coat and Cotton-linen chore coat mean the same coat.",
  async scripted({ world, memo }) {
    memo.receipt = await tell(world, "garment.merge", { sourceGarmentId: memo.chore, targetGarmentId: memo.work, quantityMode: "same_units" });
  },
  // No confirmation step: under the owner's decision of 2026-10-05 a merge the owner asks for applies at once
  // with a receipt and undo. Whether the sentence itself produced the merge is what is observed; a request to
  // confirm raised instead is reported as evidence and leaves the merge undone.
  async observe({ world, memo, turn }) {
    const both = [memo.work, memo.chore] as string[];
    const listed = (await wholeWardrobe(world.owner.api)).items.filter((i) => both.includes(i.garment.garmentId) && !(i.availability?.reasons ?? []).includes("merged"));
    const today = await dayRecord(world, world.today);
    const lines = (today.garments as any[]).filter((line) => both.includes(line.garmentId));
    const sources = (today.observations as any[]).filter((o) => both.includes(o.garmentId) && o.status === "active");
    const survivor = listed.length === 1 ? (await item(world, listed[0]!.garment.garmentId)).detail : null;
    const merges = (await receipts(world, "garment.merge")).filter((r) => r.outcome === "committed" && !(memo.mergesBefore as string[]).includes(r.commandId));
    const asked = await askedSince(world, memo.since, turn, memo.runsWaitingBefore);
    return {
      // Counted wears are the surviving garment's own counter, so a merge that summed both records' wears fails
      // even when the day record shows one line; with no single survivor there is nothing to count.
      observed: { canonical_garments: listed.length, counted_wears: survivor ? Number(survivor.recordedWearCount) : null, source_observations_retained: sources.length },
      evidence: {
        records: { work: memo.work, chore: memo.chore },
        listed_after: listed.map((i) => ({ garmentId: i.garment.garmentId, name: i.garment.name })),
        survivor: survivor ? { name: survivor.garment.name, aliases: survivor.aliases ?? survivor.garment.aliases ?? null, counted_wears: survivor.recordedWearCount, total_owned_units: survivor.totalOwnedUnits, balances: survivor.balances } : null,
        day_lines: lines,
        day_lines_deduplicated: lines.length === 1,
        sources: sources.map((o) => ({ garmentId: o.garmentId, channel: o.channel, commandId: o.commandId, status: o.status })),
        merge_receipts: merges.map((r) => ({ commandId: r.commandId, outcome: r.outcome, summary: r.summary, channel: r.channel ?? null })),
        receipt: memo.receipt ? { commandId: memo.receipt.commandId, outcome: memo.receipt.outcome, summary: memo.receipt.summary } : null,
        requests_raised_instead: asked.proposals,
      },
    };
  },
};

export const accountingDrivers: Record<string, BehaviourDriver> = { B001, B002, B003, B004, B005, B006, B007, B008, B009, B010 };

export type { DriverContext };
