/**
 * Step handlers, part 3: circumstances and the remaining tools. A trip with a packing proposal, a
 * suitcase and an unpacking; a pause and a resume; an order that arrives and is returned or exchanged;
 * requests to Garderobe's own assistant, research runs and run control; an attempt to lift the profile's
 * restriction; an undone and an amended wear report.
 */
import { addDays } from "./dates.mjs";
import { byDraw } from "./rng.mjs";
import { balanceDifferences, garmentChanges, moveBalance, newReceipts, quantityIn, wardrobeStateChanges } from "./sim.mjs";

const RUN_STATES = ["queued", "running", "needs_input", "completed", "failed", "cancelled"];
const waits = (sim, type, outcome) => sim.expectContractRoute(type, outcome);
const trips = async (sim) => (await sim.inventory({ view: "trips" })).data.trips ?? [];

/* ------------------------------ the trip ------------------------------ */

export async function tripCreate(sim) {
  const { trip } = sim.plan;
  const departsOn = sim.dateOf(trip.firstDay);
  const returnsOn = sim.dateOf(trip.lastDay);
  const place = trip.place;
  const outcome = await sim.command(
    "trip.create",
    {
      name: `SIMULATED trip to ${place.label.split(" (")[0]}`,
      departsOn,
      returnsOn,
      destinations: [{ label: place.label, latitude: place.latitude, longitude: place.longitude, timezone: place.timezone, from: departsOn, to: returnsOn }],
      occasions: [{ localDate: sim.dateOf(trip.dinnerDay), label: "Dinner (SIMULATED)", register: "smart", segment: "evening" }],
      luggage: { label: "carry-on only", maxPieces: trip.carryOnPieces },
      source: { kind: "owner_statement", note: "SIMULATED circumstance" },
    },
    { label: "a trip is planned" },
  );
  waits(sim, "trip.create", outcome);
  const id = "trip.planned_trip_is_listed";
  if (!outcome.receipt) return sim.check(id, false, `the trip was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  const listed = (await trips(sim)).find((t) => t.departsOn === departsOn && t.returnsOn === returnsOn && t.status === "planned");
  sim.check(id, Boolean(listed), "the trip the owner confirmed is not in the trips view", { commandId: outcome.receipt.commandId });
  sim.trip.tripId = listed?.tripId ?? outcome.receipt.affected.find((a) => a.kind === "trip")?.id ?? null;
  sim.trip.departsOn = departsOn;
  sim.count("trips planned (SIMULATED circumstance)");
  sim.trace.push(["trip", "create"]);
}

export async function tripProposal(sim) {
  const id = "trip.proposal_offers_only_wearable_pieces";
  if (!sim.trip.tripId) return sim.notApplicable(id, "no trip exists");
  const before = await sim.snapshot();
  // Asking for a packing proposal is the owner's own request in the app; there is no MCP tool for it.
  const asked = await sim.target.api("primary", "POST", `/v1/trips/${sim.trip.tripId}/packing-proposal`, { clientRequestId: sim.key("packing") });
  if (!asked.ok) return sim.check(id, false, `the packing proposal answered ${asked.status}: ${asked.text.slice(0, 300)}`, { status: asked.status });
  const trip = (await trips(sim)).find((t) => t.tripId === sim.trip.tripId);
  const proposal = trip?.proposal ?? null;
  if (!proposal) return sim.check(id, false, "the trips view shows no proposal after one was asked for", { tripId: sim.trip.tripId });
  sim.trip.proposal = proposal;
  const bad = proposal.items.filter((i) => {
    const item = before.byId.get(i.garmentId);
    return !item || item.garment.acquisition !== "owned" || item.availability?.hardExcluded || (item.availability?.restrictionIds ?? []).length > 0 || sim.unavailable.has(i.garmentId);
  });
  sim.check(id, bad.length === 0, `the proposal lists pieces that cannot be worn: ${bad.map((i) => i.name).join(", ")}`, { tripId: sim.trip.tripId, revision: proposal.revision });
  // Pieces in the bag, computed here from the proposal: one unit of each garment worn on the departure day
  // (its day segment) is worn for the journey, not packed (coordinator decision on journey finding D07-5;
  // packages/daily/test/trips-luggage.test.ts counts the same way).
  const departsOn = sim.dateOf(sim.plan.trip.firstDay);
  const travel = (proposal.days ?? []).find((d) => d.localDate === departsOn && (d.segment ?? "day") === "day");
  const wornForJourney = new Set((travel?.slots ?? []).map((s) => s.garmentId));
  const listedPieces = proposal.items.reduce((n, i) => n + i.quantity, 0);
  const pieces = proposal.items.reduce((n, i) => n + i.quantity - (wornForJourney.has(i.garmentId) ? 1 : 0), 0);
  sim.check("trip.proposal_fits_the_luggage", pieces <= sim.plan.trip.carryOnPieces, `the proposal packs ${pieces} pieces (${listedPieces} listed, ${listedPieces - pieces} worn for the journey on ${departsOn}) for a bag of ${sim.plan.trip.carryOnPieces}`, { tripId: sim.trip.tripId, notes: proposal.notes, listedPieces, packedPieces: pieces });
  const tripDates = [];
  for (let d = sim.plan.trip.firstDay; d <= sim.plan.trip.lastDay; d++) tripDates.push(sim.dateOf(d));
  const plannedDates = new Set(proposal.days.map((d) => d.localDate));
  const unplanned = tripDates.filter((date) => !plannedDates.has(date));
  sim.check("trip.proposal_covers_every_day_of_the_trip", unplanned.length === 0, `the proposal plans ${plannedDates.size} days of the ${tripDates.length}-day trip ${tripDates[0]}..${tripDates.at(-1)}; missing: ${unplanned.join(", ")}`, { tripId: sim.trip.tripId, unplanned, planned: [...plannedDates].sort() });
  const after = await sim.snapshot();
  const moved = proposal.items.filter((i) => quantityIn(after.byId.get(i.garmentId), "trip") > 0).map((i) => i.name);
  sim.check("trip.proposed_is_not_packed", (trip.packed ?? []).length === 0 && moved.length === 0, `a proposal alone moved pieces into the suitcase: ${moved.join(", ")}`, { tripId: sim.trip.tripId });
  sim.count("packing proposals (from the destination's SIMULATED forecast)");
  sim.trace.push(["trip", "proposal", proposal.items.length]);
}

export async function tripPack(sim) {
  const id = "trip.packed_is_what_the_suitcase_holds";
  if (!sim.trip.tripId || !sim.trip.proposal) return sim.notApplicable(id, "no proposal to pack from");
  const snapshot = await sim.snapshot();
  // He packs what was proposed and is still clean at home that evening.
  const items = sim.trip.proposal.items.filter((i) => quantityIn(snapshot.byId.get(i.garmentId), "clean") >= i.quantity && !sim.unavailable.has(i.garmentId)).map((i) => ({ garmentId: i.garmentId, quantity: i.quantity }));
  if (items.length === 0) return sim.notApplicable(id, "nothing of the proposal was still clean at home");
  const outcome = await sim.command("stock.pack", { tripId: sim.trip.tripId, items }, { label: "packed" });
  if (!outcome.receipt) return sim.check(id, false, `packing was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.check("trip.packing_runs_without_a_tap", outcome.route === "direct", `stock.pack took the route ${outcome.route}`, { commandId: outcome.receipt.commandId });
  const trip = (await trips(sim)).find((t) => t.tripId === sim.trip.tripId);
  const packed = new Map((trip?.packed ?? []).map((p) => [p.garmentId, p.clean + p.worn]));
  sim.check(id, items.every((i) => packed.get(i.garmentId) === i.quantity) && packed.size === items.length, `packed ${items.length} lines; the suitcase holds ${packed.size}`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  sim.trip.packed = new Map(items.map((i) => [i.garmentId, i.quantity]));
  // What the proposal asked for that he could not pack (not clean at home that evening, or made unavailable).
  sim.trip.leftBehind = sim.trip.proposal.items.filter((i) => !items.some((p) => p.garmentId === i.garmentId)).map((i) => ({ garmentId: i.garmentId, name: i.name, role: i.role, quantity: i.quantity }));
  const after = await sim.snapshot();
  const offered = items.filter((i) => after.byId.get(i.garmentId)?.totalOwnedUnits === i.quantity && after.byId.get(i.garmentId)?.availability?.hardExcluded !== true).map((i) => after.byId.get(i.garmentId)?.garment.name);
  sim.check("trip.what_is_in_the_suitcase_is_not_offered_at_home", offered.length === 0, `packed, yet not excluded at home: ${offered.join(", ")}`, { commandId: outcome.receipt.commandId });
  sim.count("suitcases packed");
  sim.trace.push(["trip", "pack", items.length]);
}

export async function tripUnpack(sim) {
  const id = "trip.unpacked_is_not_clean";
  if (!sim.trip.tripId || sim.trip.packed.size === 0) return sim.notApplicable(id, "nothing was packed");
  const before = await sim.snapshot();
  const outcome = await sim.command("stock.unpack", { tripId: sim.trip.tripId }, { label: "unpacked" });
  if (!outcome.receipt) return sim.check(id, false, `unpacking was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  const after = await sim.snapshot();
  const madeClean = [];
  const stillAway = [];
  const missing = [];
  const notConserved = [];
  const wrongBucket = [];
  const held = (item) => (item?.balances ?? []).filter((b) => b.bucket !== "gone").reduce((n, b) => n + b.quantity, 0);
  for (const [garmentId, quantity] of sim.trip.packed) {
    const was = before.byId.get(garmentId);
    const now = after.byId.get(garmentId);
    if (!was || !now) {
      missing.push(`${was?.garment.name ?? now?.garment.name ?? garmentId} (${!was ? "absent before" : "absent after"})`);
      continue;
    }
    const name = now.garment.name;
    if (quantityIn(now, "trip") > 0) stillAway.push(name);
    // Unpacking moves units between buckets; it neither creates nor loses an owned unit.
    if (now.totalOwnedUnits !== was.totalOwnedUnits || held(now) !== held(was)) notConserved.push(`${name}: owned ${was.totalOwnedUnits} -> ${now.totalOwnedUnits}, held ${held(was)} -> ${held(now)}`);
    // A washable piece that travelled comes home awaiting care, worn or not; unpacking declares nothing clean.
    // A piece with no care channel (shoes) comes home clean.
    const travelled = quantityIn(was, "trip");
    const laundered = now.garment.careChannel !== "none";
    if (laundered && quantityIn(now, "clean") > quantityIn(was, "clean")) madeClean.push(`${name} (${quantity})`);
    const expected = laundered ? { clean: quantityIn(was, "clean"), dirty: quantityIn(was, "dirty") + travelled } : { clean: quantityIn(was, "clean") + travelled, dirty: quantityIn(was, "dirty") };
    if (quantityIn(now, "clean") !== expected.clean || quantityIn(now, "dirty") !== expected.dirty) wrongBucket.push(`${name}: clean ${quantityIn(now, "clean")} (expected ${expected.clean}), dirty ${quantityIn(now, "dirty")} (expected ${expected.dirty})`);
  }
  const evidence = { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary };
  sim.check("trip.unpacked_garments_are_still_in_the_wardrobe", missing.length === 0, `packed garments missing from the snapshot around unpacking: ${missing.join(", ")}`, evidence);
  sim.check(id, madeClean.length === 0, `unpacking made these clean: ${madeClean.join(", ")}`, evidence);
  sim.check("trip.unpacking_empties_the_suitcase", stillAway.length === 0, `still in the suitcase after unpacking: ${stillAway.join(", ")}`, evidence);
  sim.check("trip.unpacking_conserves_owned_units", notConserved.length === 0, `unpacking changed the owned units of: ${notConserved.join("; ")}`, evidence);
  sim.check("trip.unpacked_units_come_home_to_the_expected_bucket", wrongBucket.length === 0, `after unpacking: ${wrongBucket.join("; ")}`, evidence);
  // Every garment, balance by balance: only this trip's suitcase units move home (to dirty for a washable
  // piece, to clean for one with no care channel); every other balance and every other garment is unchanged.
  const unchangedOtherwise = balanceDifferences(before, after, (garmentId, map, was) => {
    // The suitcase holds `trip|<tripId>` (packed, unworn) and `trip|<tripId>#dirty` (worn while away;
    // packages/domain/src/stock/replay.ts); both come home.
    const suitcaseKeys = [`trip|${sim.trip.tripId}`, `trip|${sim.trip.tripId}#dirty`];
    const inSuitcase = suitcaseKeys.reduce((n, key) => n + (map.get(key) ?? 0), 0);
    if (inSuitcase === 0) return;
    for (const key of suitcaseKeys) map.delete(key);
    moveBalance(map, was.garment.careChannel !== "none" ? "dirty|*" : "clean|*", inSuitcase);
  }, ["dirty", "clean"]);
  sim.check("trip.unpacking_moves_only_the_suitcase", unchangedOtherwise.length === 0, `after unpacking: ${unchangedOtherwise.slice(0, 6).join("; ")}${unchangedOtherwise.length > 6 ? ` (+${unchangedOtherwise.length - 6} more)` : ""}`, { ...evidence, wrong: unchangedOtherwise.slice(0, 20) });
  sim.trip.packed = new Map();
  sim.trip.unpacked = true;
  sim.count("suitcases unpacked");
  sim.trace.push(["trip", "unpack"]);
}

/* ------------------------------ pause and resume ------------------------------ */

export async function pause(sim) {
  const p = sim.plan.pause;
  const from = sim.dateOf(p.firstDay);
  const resumeOn = p.withResumeDate ? sim.dateOf(p.resumeDay) : null;
  const outcome = await sim.command("service.pause", { from, resumeOn }, { label: resumeOn ? "paused until a date" : "paused until further notice" });
  waits(sim, "service.pause", outcome);
  const id = "pause.recorded";
  if (!outcome.receipt) return sim.check(id, false, `the pause was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.check(id, true);
  sim.pause = { active: true, from, until: sim.dateOf(p.lastDay), resumeOn };
  sim.count(`pauses (${resumeOn ? "with a resume date" : "until the owner resumes"}) (SIMULATED circumstance)`);
  sim.trace.push(["pause", Boolean(resumeOn)]);
}

export async function resume(sim) {
  const outcome = await sim.command("service.resume", {}, { label: "resumed" });
  waits(sim, "service.resume", outcome);
  const id = "pause.resume_recorded";
  if (!outcome.receipt) return sim.check(id, false, `the resume was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.check(id, true);
  sim.pause.active = false;
  const view = await sim.todayBoard(sim.today());
  sim.check("pause.today_is_no_longer_paused_after_the_resume", view.status !== "paused" && !view.paused, `today still reads as ${view.status}`, { commandId: outcome.receipt.commandId });
  sim.count("resumes by the owner");
  sim.trace.push(["resume"]);
}

/* ------------------------------ an order, its arrival, its return or exchange ------------------------------ */

const ORDER_NUMBER = (sim, n) => `SIM-${sim.plan.seed}-${n}`;

async function importOrder(sim, n, productName, replaces = null) {
  const lineKey = `simulated-shirt-${n}`;
  return sim.command(
    "purchase.import_order",
    {
      merchant: "SIMULATED Shirtmaker",
      merchantKey: "simulated-shirtmaker",
      orderNumber: ORDER_NUMBER(sim, n),
      orderedOn: sim.today(),
      currency: "GBP",
      totalMinor: 12900,
      channel: "owner_statement",
      lines: [{ lineKey, productName, size: n === 1 ? "M" : "L", colour: "Moss", priceMinor: 12900, currency: "GBP" }],
      events: [{ kind: "confirmation", dedupeKey: `simulated-confirmation-${sim.plan.seed}-${n}`, occurredAt: new Date(sim.now()).toISOString().replace(/\.\d{3}Z$/, "Z"), sourceRef: "SIMULATED owner statement", lineKeys: [lineKey] }],
      incoming: [{ lineKey, category: "shirt", roles: ["top"], careChannel: "service", maker: "SIMULATED Shirtmaker" }],
      ...(replaces ? { replaces } : {}),
    },
    { label: n === 1 ? "an order is logged" : "the replacement of an exchange is logged" },
  );
}

const findOrder = async (sim, n) => ((await sim.inventory({ view: "orders" })).data.orders ?? []).find((o) => o.orderNumber === ORDER_NUMBER(sim, n)) ?? null;
const findCase = async (sim) => ((await sim.inventory({ view: "returns" })).data.returns ?? []).find((c) => c.caseId === sim.purchase.caseId || (sim.purchase.orderId && c.orderId === sim.purchase.orderId)) ?? null;

export async function purchaseOrder(sim) {
  const ownedBefore = (await sim.snapshot()).counts?.owned ?? null;
  const outcome = await importOrder(sim, 1, "SYNTHETIC ordered shirt, moss (simulated order)");
  waits(sim, "purchase.import_order", outcome);
  const id = "purchase.an_order_is_not_an_arrival";
  if (!outcome.receipt) return sim.check(id, false, `the order was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  const order = await findOrder(sim, 1);
  const line = order?.lines?.[0] ?? null;
  sim.purchase = { orderId: order?.orderId ?? null, lineId: line?.lineId ?? null, garmentId: line?.garmentId ?? null, ownedBefore };
  const snapshot = await sim.snapshot();
  const item = sim.purchase.garmentId ? snapshot.byId.get(sim.purchase.garmentId) : null;
  sim.check(id, Boolean(order) && Boolean(item) && item.garment.acquisition === "incoming" && item.availability?.hardExcluded === true && (ownedBefore === null || snapshot.counts.owned === ownedBefore), `after the order: order ${order ? "listed" : "missing"}, garment ${item ? item.garment.acquisition : "missing"}, owned ${snapshot.counts?.owned} (was ${ownedBefore})`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  sim.count("orders logged (SYNTHETIC order)");
  sim.trace.push(["purchase", "order"]);
}

export async function purchaseArrival(sim) {
  const id = "purchase.arrival_is_the_owner_s_observation";
  if (!sim.purchase.garmentId) return sim.notApplicable(id, "the order created no incoming garment");
  // A connection records an arrival as the domain observation `garment.receive` and then marks the order line
  // delivered (`purchase.mark_delivered`); `assistant.report_arrival` is the app and conversation composite,
  // not available to a connection (apps/worker/test/mcp-command-classes.test.ts, INTERNAL).
  const outcome = await sim.command("garment.receive", { garmentId: sim.purchase.garmentId }, { label: "the order arrived" });
  waits(sim, "garment.receive", outcome);
  if (!outcome.receipt) return sim.check(id, false, `the arrival was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  if (sim.purchase.orderId && sim.purchase.lineId) {
    const delivered = await sim.command("purchase.mark_delivered", { orderId: sim.purchase.orderId, lineId: sim.purchase.lineId, deliveredOn: sim.today() }, { label: "the order line is delivered" });
    waits(sim, "purchase.mark_delivered", delivered);
    if (!delivered.receipt) return sim.check(id, false, `marking the order line delivered was refused: ${delivered.error?.code} ${delivered.error?.message}`, { error: delivered.error });
  }
  sim.purchase.deliveredOn = sim.today();
  const item = (await sim.snapshot()).byId.get(sim.purchase.garmentId);
  const line = (await findOrder(sim, 1))?.lines?.find((l) => l.lineId === sim.purchase.lineId);
  sim.check(id, item?.garment.acquisition === "owned" && quantityIn(item, "clean") >= 1 && line?.state === "delivered", `after the arrival: garment ${item?.garment.acquisition}, clean ${quantityIn(item, "clean")}, order line ${line?.state}`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  sim.count("arrivals reported");
  sim.trace.push(["purchase", "arrival"]);
}

export async function returnOpen(sim) {
  const id = "return.deadline_comes_from_sourced_terms_and_the_real_delivery";
  if (!sim.purchase.orderId || !sim.purchase.deliveredOn) return sim.notApplicable(id, "nothing arrived that could be returned");
  const kind = sim.plan.purchase.kind;
  const stockBefore = (await sim.wardrobeState()).garments;
  const outcome = await sim.command(
    "return.open_case",
    {
      kind,
      orderId: sim.purchase.orderId,
      lineId: sim.purchase.lineId,
      garmentId: sim.purchase.garmentId,
      terms: { windowDays: 30, concerns: "post", triggerEvent: "delivery", sourceRef: "https://simulated-shirtmaker.invalid/returns (SIMULATED terms)", checkedOn: sim.today(), text: "SIMULATED terms: post within 30 days of delivery." },
      triggerDate: sim.purchase.deliveredOn,
      refundExpectedMinor: 12900,
      currency: "GBP",
      reason: kind === "return" ? "SIMULATED: the collar is too tight" : "SIMULATED: one size up, please",
    },
    { label: `a ${kind} is opened` },
  );
  waits(sim, "return.open_case", outcome);
  if (!outcome.receipt) return sim.check(id, false, `the ${kind} was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  const opened = await findCase(sim);
  sim.purchase.caseId = opened?.caseId ?? null;
  sim.check(id, opened?.deadline?.status === "established" && opened.deadline.localDate === addDays(sim.purchase.deliveredOn, 30), `the deadline reads ${opened?.deadline?.status} ${opened?.deadline?.localDate}; delivery was ${sim.purchase.deliveredOn} with a 30-day window`, { commandId: outcome.receipt.commandId, deadline: opened?.deadline });
  const item = (await sim.snapshot()).byId.get(sim.purchase.garmentId);
  sim.check("return.opening_a_return_removes_no_stock", opened?.stockDeparted === false && item?.garment.acquisition === "owned", `after opening the ${kind}: stock departed ${opened?.stockDeparted}, garment ${item?.garment.acquisition}`, { commandId: outcome.receipt.commandId });
  await expectStockUnchanged(sim, "return.bookkeeping_moves_no_stock", stockBefore, `opening the ${kind}`);
  sim.count(`${kind}s opened (SYNTHETIC order)`);
  sim.trace.push(["return", "open", kind]);
}

async function updateCase(sim, changes, label) {
  const stockBefore = (await sim.wardrobeState()).garments;
  const outcome = await sim.command("return.update_case", { caseId: sim.purchase.caseId, ...changes }, { label });
  waits(sim, "return.update_case", outcome);
  sim.check("return.step_recorded", Boolean(outcome.receipt), `${label} was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  await expectStockUnchanged(sim, "return.bookkeeping_moves_no_stock", stockBefore, label);
  return outcome;
}

export async function returnLabel(sim) {
  if (!sim.purchase.caseId) return sim.notApplicable("return.step_recorded", "no case is open");
  await updateCase(sim, { state: "label_ready", labelRef: "SIMULATED-LABEL-1", nextAction: "post the parcel" }, "the label is ready");
  const item = (await sim.snapshot()).byId.get(sim.purchase.garmentId);
  sim.check("return.stock_leaves_only_on_physical_departure", item?.garment.acquisition === "owned", `a label alone changed the garment to ${item?.garment.acquisition}`);
}

export async function returnPost(sim) {
  const id = "return.stock_leaves_only_on_physical_departure";
  if (!sim.purchase.caseId) return sim.notApplicable(id, "no case is open");
  await updateCase(sim, { state: "posted", shipmentRef: "SIMULATED-PARCEL-1" }, "the parcel is posted");
  const stillOwned = (await sim.snapshot()).byId.get(sim.purchase.garmentId);
  sim.check(id, stillOwned?.garment.acquisition === "owned", `marking the case as posted changed the garment to ${stillOwned?.garment.acquisition}`);
  // The physical departure is its own fact: it changes the departed piece and nothing else.
  const stockBeforeDeparture = (await sim.wardrobeState()).garments;
  const gone = await sim.command("garment.retire", { garmentId: sim.purchase.garmentId, disposition: "returned_to_seller", note: "SIMULATED: posted back" }, { label: "the piece has physically left" });
  waits(sim, "garment.retire", gone);
  if (!gone.receipt) return sim.check(id, false, `the departure was refused: ${gone.error?.code} ${gone.error?.message}`, { error: gone.error });
  const stockAfterDeparture = await expectStockUnchanged(sim, "return.departure_changes_only_the_departed_piece", stockBeforeDeparture, "the departure", new Set([sim.purchase.garmentId]));
  const after = await sim.snapshot();
  const item = after.byId.get(sim.purchase.garmentId);
  const posted = await findCase(sim);
  // The departed units must have left ownership: the garment is gone or holds no owned unit (a changed
  // acquisition alone is not a departure).
  const ownedBefore = stockBeforeDeparture.get?.(sim.purchase.garmentId)?.totalOwnedUnits ?? null;
  const unitsLeft = !item || item.totalOwnedUnits === 0;
  sim.check("return.departure_is_shown_on_the_case", posted?.stockDeparted === true && unitsLeft, `after the departure: case says departed ${posted?.stockDeparted}, garment ${item?.garment.acquisition ?? "gone"} with ${item?.totalOwnedUnits ?? 0} owned unit(s)${ownedBefore === null ? "" : ` (was ${ownedBefore})`}`, { commandId: gone.receipt.commandId, summary: gone.receipt.summary });
  if (sim.plan.purchase.kind === "exchange") {
    const replacement = await importOrder(sim, 2, "SYNTHETIC replacement shirt, moss, one size up (simulated exchange)", { merchantKey: "simulated-shirtmaker", orderNumber: ORDER_NUMBER(sim, 1) });
    waits(sim, "purchase.import_order", replacement);
    const incoming = await findOrder(sim, 2);
    if (replacement.receipt && incoming && sim.purchase.caseId) {
      // The replacement order adds one incoming garment and moves nothing already in the wardrobe.
      const newIds = new Set((incoming.lines ?? []).map((l) => l.garmentId).filter(Boolean));
      const stockBeforeLink = await expectStockUnchanged(sim, "return.bookkeeping_moves_no_stock", stockAfterDeparture, "logging the replacement order", newIds);
      const linked = await sim.command("return.link_exchange", { caseId: sim.purchase.caseId, incomingOrderId: incoming.orderId, incomingLineId: incoming.lines[0].lineId }, { label: "the replacement is linked to the exchange" });
      sim.check("return.step_recorded", Boolean(linked.receipt), `linking the replacement was refused: ${linked.error?.code} ${linked.error?.message}`, { error: linked.error });
      await expectStockUnchanged(sim, "return.bookkeeping_moves_no_stock", stockBeforeLink, "linking the replacement");
      const now = await sim.snapshot();
      // Logging and linking the replacement adds an incoming garment, never an owned one. Measured from the count
      // right after the departure: other simulated events (a lost piece) may retire garments between the order
      // and the posting, so the count before the order is not the baseline.
      const ownedAfterDeparture = after.counts?.owned ?? null;
      const incomingAfterDeparture = after.counts?.incoming ?? null;
      sim.check("return.an_exchange_never_duplicates_ownership", ownedAfterDeparture === null || (now.counts.owned === ownedAfterDeparture && (incomingAfterDeparture === null || now.counts.incoming === incomingAfterDeparture + newIds.size)), `after the replacement was logged and linked: owned ${now.counts.owned} (was ${ownedAfterDeparture}), incoming ${now.counts.incoming} (was ${incomingAfterDeparture}, ${newIds.size} replacement line(s))`, { ownedBeforeOrder: sim.purchase.ownedBefore });
      sim.purchase.replacementGarmentId = incoming.lines[0].garmentId ?? null;
    } else sim.check("return.step_recorded", false, `the replacement order was not recorded: ${replacement.error?.code ?? "not listed"}`, { error: replacement.error });
  }
  sim.count("parcels posted back (physical departure recorded separately)");
  sim.trace.push(["return", "post"]);
}

export async function returnSettle(sim) {
  if (!sim.purchase.caseId) return sim.notApplicable("return.step_recorded", "no case is open");
  if (sim.plan.purchase.kind === "return") {
    await updateCase(sim, { state: "refunded", refundReceivedMinor: 12900, refundSourceRef: "SIMULATED bank statement", currency: "GBP" }, "the refund arrived");
    const settled = await findCase(sim);
    sim.check("return.refund_is_what_was_received", settled?.refund?.receivedMinor === 12900 && settled.refund.state === "full", `the refund reads ${settled?.refund?.receivedMinor} (${settled?.refund?.state})`, { caseId: sim.purchase.caseId });
  } else await updateCase(sim, { state: "exchanged" }, "the exchange is complete");
  sim.count(`${sim.plan.purchase.kind}s settled`);
  sim.trace.push(["return", "settle", sim.plan.purchase.kind]);
}

/* ------------------------------ ask, research, run ------------------------------ */

const revision = async (sim) => (await sim.inventory({ view: "receipts", limit: 1 })).wardrobeRevision;

/**
 * After the undo of one wear report (the simulator's record already reduced by `forgetWear`): garments this
 * report alone supported must have left the day's record, and garments another report still supports must
 * still be on it. Where no garment of the report has other support, the second half cannot apply and is
 * recorded as not applicable rather than as a pass. Returns the names that wrongly stayed.
 */
export function checkUndoAgainstSupport(sim, report, record, commandId) {
  const supported = sim.wears.get(report.date) ?? new Map();
  const onRecord = new Set(record.map((g) => g.garmentId));
  const still = record.filter((g) => report.ids.includes(g.garmentId) && !supported.has(g.garmentId)).map((g) => g.name);
  const backed = report.ids.filter((garmentId) => supported.has(garmentId));
  if (backed.length === 0) sim.notApplicable("undo.keeps_what_another_report_still_supports", `no garment of the undone report of ${report.date} has another report behind it`);
  else {
    const lost = backed.filter((garmentId) => !onRecord.has(garmentId));
    sim.check("undo.keeps_what_another_report_still_supports", lost.length === 0, `after undoing one report of ${report.date}, ${lost.length} of the ${backed.length} garment(s) another report still supports left the record: ${lost.join(", ")}`, { commandId, lost, backed });
  }
  return still;
}

/**
 * Return bookkeeping (opening a case, a label, posting, settling, linking an exchange) is paperwork: it must
 * not move stock. Compare every garment's stock before and after the step; `allowed` names garments the step
 * may legitimately change (the piece that physically left, a newly ordered replacement).
 */
export async function expectStockUnchanged(sim, id, before, label, allowed = new Set()) {
  const after = (await sim.wardrobeState()).garments;
  const changes = garmentChanges(before, after, allowed);
  sim.check(id, changes.length === 0, `${label} changed stock: ${changes.slice(0, 5).join("; ")}`, { changes: changes.slice(0, 20) });
  return after;
}

async function runStatus(sim, runId, session = sim.sessions.writer) {
  let run = null;
  for (let i = 0; i < 40; i++) {
    const status = await session.callTool("garderobe_run", { runId });
    if (!status.ok) return { error: status.error };
    run = status.data.run;
    if (!["queued", "running"].includes(run.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // A run still queued or running after the polling budget is not a settled run: a worker that never
  // executes runs must fail here, not pass as "a known state".
  const settled = Boolean(run) && !["queued", "running"].includes(run.state);
  sim.check("run.settles_within_the_polling_budget", settled, `run ${runId} is still ${run?.state} after 40 reads 0.5 s apart`, { runId, state: run?.state ?? null });
  return { run, settled };
}

/**
 * What a run says about itself must be consistent: a failure is reported as one, a failed run changes
 * nothing at all (ledger revision, latest receipts and every garment's state, receipts listed or not), and
 * a run that changed the wardrobe lists the receipts for it. `changes` is the list `wardrobeStateChanges`
 * gives for readings taken before and after the run; `appeared` (from `newReceipts`) names the command
 * identifier and type of every receipt new in the latest 20, recorded as evidence so a failure can be told
 * apart: an assistant turn that committed, or background, daily or maintenance work during the run.
 */
export function checkRunHonesty(sim, what, run, changes, appeared = []) {
  const changed = changes.length > 0;
  const newReceiptEvidence = appeared.map((r) => ({ commandId: r.commandId, type: r.type, outcome: r.outcome, actor: r.actor, channel: r.channel, ...(r.committedAt ? { committedAt: r.committedAt } : {}) }));
  sim.check("run.state_is_a_known_state", RUN_STATES.includes(run.state), `${what}: state ${run.state}`, { runId: run.runId });
  if (run.state === "failed") {
    sim.check("run.a_failure_is_reported_as_a_failure", Boolean(run.error?.message) && !run.result?.reply?.text, `${what} failed but carries ${run.error ? "an answer" : "no error"}`, { runId: run.runId, error: run.error });
    sim.check("run.a_failed_run_changes_nothing", !changed, `${what} failed, yet during it: ${changes.slice(0, 5).join("; ")}`, { runId: run.runId, errorCode: run.error?.code, receipts: (run.receipts ?? []).length, changes: changes.slice(0, 20), newReceipts: newReceiptEvidence });
  }
  if (run.state === "completed") sim.check("run.a_completed_run_has_its_result", Boolean(run.result), `${what} completed without a result`, { runId: run.runId });
  sim.check("run.nothing_changes_without_a_receipt", !changed || (run.receipts ?? []).length > 0, `${what}: the wardrobe changed although the run lists no receipt: ${changes.slice(0, 5).join("; ")}`, { runId: run.runId, state: run.state, changes: changes.slice(0, 20), newReceipts: newReceiptEvidence });
  sim.count(`${what}: ${run.state}${run.error?.code ? ` (${run.error.code})` : ""}`);
}

export async function ask(sim, step) {
  const before = await sim.wardrobeState();
  const mode = step.variant === 0 ? "wait" : "start";
  const message = step.variant === 0 ? "(SIMULATED request) What did I wear yesterday, and is anything of it still clean?" : "(SIMULATED request) Which of my shirts have I not worn in the last two weeks?";
  const args = { message, clientTurnId: sim.key("turn"), mode };
  const asked = await sim.sessions.writer.callTool("garderobe_ask", args);
  const id = "ask.returns_a_durable_run";
  if (!asked.ok) return sim.check(id, false, `garderobe_ask was refused: ${asked.error.code} ${asked.error.message}`, { error: asked.error });
  sim.check(id, typeof asked.data.runId === "string" && RUN_STATES.includes(asked.data.state), `garderobe_ask answered ${JSON.stringify({ runId: asked.data.runId, state: asked.data.state })}`);
  if (mode === "start") {
    const cancelled = await sim.sessions.writer.callTool("garderobe_run", { runId: asked.data.runId, action: "cancel" });
    sim.check("run.cancel_answers_with_the_run", cancelled.ok ? RUN_STATES.includes(cancelled.data.run.state) && Array.isArray(cancelled.data.stopped) : ["precondition_failed", "conflict"].includes(cancelled.error.code), `cancel answered ${cancelled.ok ? cancelled.data.run.state : cancelled.error.code}`, { runId: asked.data.runId });
  }
  const { run, error } = await runStatus(sim, asked.data.runId);
  if (!run) return sim.check("run.readable_by_its_id", false, `garderobe_run for the ask was refused: ${error.code} ${error.message}`, { runId: asked.data.runId });
  sim.check("run.readable_by_its_id", run.runId === asked.data.runId, `asked for run ${asked.data.runId}, got ${run.runId}`);
  const afterAsk = await sim.wardrobeState();
  checkRunHonesty(sim, `garderobe_ask (${mode})`, run, wardrobeStateChanges(before, afterAsk), newReceipts(before, afterAsk));
  // The same turn ID again is the same turn, not a second one.
  const again = await sim.sessions.writer.callTool("garderobe_ask", args);
  sim.check("ask.same_turn_id_is_the_same_turn", again.ok && again.data.runId === asked.data.runId, `the same turn ID answered run ${again.ok ? again.data.runId : again.error.code}`, { runId: asked.data.runId });
  // The second owner cannot read this run.
  const foreign = await sim.sessions.second.callTool("garderobe_run", { runId: asked.data.runId });
  sim.check("isolation.second_owner_cannot_read_a_run_of_the_first", !foreign.ok, "the second owner read a run of the first owner", { runId: asked.data.runId });
  sim.trace.push(["ask", mode, run.state]);
}

export async function research(sim, step) {
  const before = await sim.wardrobeState();
  const args = step.variant === 0 ? { topic: "(SIMULATED request) Does the Paraboot Michael run true to size?", kind: "product", clientRequestId: sim.key("research") } : { topic: "(SIMULATED request) When did I last buy an oxford shirt?", kind: "history", clientRequestId: sim.key("research") };
  const started = await sim.sessions.reader.callTool("garderobe_research", args);
  const id = "research.returns_a_durable_run";
  if (!started.ok) return sim.check(id, false, `garderobe_research was refused: ${started.error.code} ${started.error.message}`, { error: started.error });
  sim.check(id, typeof started.data.runId === "string" && RUN_STATES.includes(started.data.state), `garderobe_research answered ${JSON.stringify({ runId: started.data.runId, state: started.data.state })}`);
  const { run, error } = await runStatus(sim, started.data.runId, sim.sessions.reader);
  if (!run) return sim.check("run.readable_by_its_id", false, `garderobe_run for the research was refused: ${error.code} ${error.message}`, { runId: started.data.runId });
  sim.check("run.readable_by_its_id", run.runId === started.data.runId, `asked for run ${started.data.runId}, got ${run.runId}`);
  const afterResearch = await sim.wardrobeState();
  checkRunHonesty(sim, `garderobe_research (${args.kind})`, run, wardrobeStateChanges(before, afterResearch), newReceipts(before, afterResearch));
  if (run.state === "completed" && run.result?.research) sim.check("research.a_verdict_names_its_sources", !run.result.research.verdict || (run.result.research.sources ?? []).length > 0, "a research verdict without a source", { runId: run.runId });
  // Run control on a run that is over: each action answers with the run or a typed refusal, never with an invented state.
  const resumed = await sim.sessions.reader.callTool("garderobe_run", { runId: run.runId, action: "resume" });
  sim.check("run.resume_answers_with_the_run_or_a_typed_refusal", resumed.ok ? RUN_STATES.includes(resumed.data.run.state) : typeof resumed.error.code === "string" && resumed.error.code !== "internal", `resume answered ${resumed.ok ? resumed.data.run.state : resumed.error.code}`, { runId: run.runId });
  const respond = await sim.sessions.reader.callTool("garderobe_run", { runId: run.runId, action: "respond", inputId: "no-such-question", text: "(SIMULATED) an answer to a question nobody asked" });
  sim.check("run.answer_to_a_question_nobody_asked_is_refused", !respond.ok && respond.error.code !== "internal", `respond answered ${respond.ok ? respond.data.run.state : respond.error.code}`, { runId: run.runId });
  const unknown = await sim.sessions.reader.callTool("garderobe_run", { runId: "run_does_not_exist_0000" });
  sim.check("run.unknown_run_is_not_found", !unknown.ok && unknown.error.code === "not_found", `an unknown run answered ${unknown.ok ? "with a run" : unknown.error.code}`);
  sim.trace.push(["research", args.kind, run.state]);
}

/* ------------------------------ the profile's restriction stays ------------------------------ */

export async function liftAttempt(sim, step) {
  const restrictionId = [...sim.healingRestrictionIds][0];
  const id = "restriction.connected_assistant_cannot_lift";
  if (!restrictionId) return sim.notApplicable(id, "no restriction was in force at the start");
  const pendingBefore = (await sim.target.apiOk("primary", "GET", "/v1/proposals")).pending;
  const attempt = await sim.command("restriction.resolve", { restrictionId, evidence: { kind: "owner_statement", note: "SIMULATED probe: the connected assistant claims his feet have healed. The owner never said so." } }, { label: "the assistant tries to lift the profile's restriction" });
  const pendingAfter = (await sim.target.apiOk("primary", "GET", "/v1/proposals")).pending;
  sim.check(id, attempt.route === "refused" && attempt.error?.code === "forbidden" && pendingAfter === pendingBefore, `the attempt took the route ${attempt.route} (${attempt.error?.code ?? attempt.receipt?.outcome}); requests waiting for the owner went from ${pendingBefore} to ${pendingAfter}`, { error: attempt.error });
  if (step.variant === 1) {
    // Contract of 2026-10-05, section 1 and 7: a wear report is an observation and is recorded at once, even
    // for a restricted piece; undo is the remedy. The restriction itself must stay in force, and the
    // simulated owner, who did not wear it, takes the report back with undo.
    const restricted = [...sim.restrictedAtStart.keys()][0];
    const date = sim.today();
    const report = await sim.command("wear.record", { wearingDate: date, garmentIds: [restricted] }, { label: "a wear report naming the restricted piece", verify: false, decision: "reject" });
    sim.check("contract.a_wear_report_on_a_restricted_piece_is_recorded_at_once", report.route === "direct" && Boolean(report.receipt), `the report took the route ${report.route}${report.error ? ` (${report.error.code})` : ""}`, { error: report.error ?? null });
    // He did not wear it: a report that was recorded is taken back with undo; one kept for the owner was rejected above.
    if (report.route === "direct" && report.receipt) {
      // A receipt is not enough: the wear must be on the day's record before it is taken back.
      const recorded = new Set(((await sim.inventory({ view: "history", date })).data.garments ?? []).map((g) => g.garmentId));
      sim.check("contract.a_wear_report_on_a_restricted_piece_is_on_the_record", recorded.has(restricted), `the report on the restricted piece returned a receipt, but the piece is not on the record of ${date}`, { commandId: report.receipt.commandId });
      const undone = await sim.command("command.undo", { commandId: report.receipt.commandId, reason: "SIMULATED: he did not wear it" }, { label: "the report on the restricted piece is undone", verify: false });
      const record = new Set(((await sim.inventory({ view: "history", date })).data.garments ?? []).map((g) => g.garmentId));
      sim.check("contract.undo_takes_the_report_back", undone.route === "direct" && Boolean(undone.receipt) && !record.has(restricted), `undo took the route ${undone.route}; the piece is ${record.has(restricted) ? "still" : "no longer"} on the record of ${date}`, { commandId: undone.receipt?.commandId ?? null });
    }
    const still = (await sim.snapshot()).byId.get(restricted);
    sim.check("restriction.still_in_force_after_a_report_naming_the_piece", (still?.availability?.restrictionIds ?? []).includes(restrictionId) || (still?.availability?.restrictionIds ?? []).length > 0, `${still?.garment.name}: the restriction no longer applies after the report`, { restrictionId });
  }
  sim.count("attempts by the connected assistant to lift the profile's restriction (all must be refused)");
  sim.trace.push(["lift_attempt", attempt.route]);
}

/* ------------------------------ undo and amend ------------------------------ */

function lastSimpleReport(sim) {
  const today = sim.today();
  // Only a report that stands alone: one report of garments nothing else was said about that day.
  return [...sim.lastDirect].reverse().find((r) => !r.undone && !r.amended && r.date >= addDays(today, -6) && r.ids.every((id) => (sim.wears.get(r.date)?.get(id) ?? 0) === 1) && sim.plan.days.find((d) => d.date === r.date && !d.reportedTwice && !d.alsoReportedInApp));
}

export async function undoReport(sim) {
  const id = "undo.an_undone_report_is_no_longer_counted";
  const report = lastSimpleReport(sim);
  if (!report) return sim.notApplicable(id, "no single, unrepeated wear report of the last days to undo");
  const outcome = await sim.command("command.undo", { commandId: report.commandId, reason: "SIMULATED: that report was a mistake" }, { label: "a wear report is undone" });
  if (!outcome.receipt) return sim.check(id, false, `the undo was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error, undone: report.commandId });
  sim.check("undo.of_a_report_runs_without_a_tap", outcome.route === "direct", `command.undo of a wear report took the route ${outcome.route}`, { commandId: outcome.receipt.commandId });
  report.undone = true;
  sim.forgetWear(report.date, report.ids);
  const record = (await sim.inventory({ view: "history", date: report.date })).data.garments ?? [];
  const still = checkUndoAgainstSupport(sim, report, record, outcome.receipt.commandId);
  sim.check(id, still.length === 0, `still on the record of ${report.date} after the undo: ${still.join(", ")}`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary });
  const again = await sim.sessions.writer.callTool("garderobe_command", { type: "command.undo", payload: { commandId: report.commandId }, idempotencyKey: sim.key("undo-twice") });
  sim.check("undo.cannot_be_done_twice", !again.ok || again.data.receipt.outcome === "noop", `undoing the same report a second time answered ${again.ok ? again.data.receipt.outcome : again.error.code}`, { undone: report.commandId });
  sim.count("wear reports undone");
  sim.trace.push(["undo", report.date]);
}

export async function amendReport(sim, step) {
  const id = "amend.replaces_only_what_it_corrects";
  const report = lastSimpleReport(sim);
  if (!report) return sim.notApplicable(id, "no single, unrepeated wear report of the last days to amend");
  const snapshot = await sim.snapshot();
  const day = sim.plan.days[step.day];
  const wrong = report.ids.map((garmentId) => snapshot.byId.get(garmentId)).find((i) => i && i.garment.roles.includes("top"));
  const right = byDraw(snapshot.items.filter((i) => i.garment.roles.includes("top") && i.garment.acquisition === "owned" && i.totalOwnedUnits === 1 && quantityIn(i, "clean") === 1 && !i.availability?.hardExcluded && !sim.unavailable.has(i.garment.garmentId) && !report.ids.includes(i.garment.garmentId) && !(sim.wears.get(report.date)?.has(i.garment.garmentId))).sort((a, b) => a.garment.name.localeCompare(b.garment.name)), day.replacementDraw);
  if (!wrong || !right) return sim.notApplicable(id, "the report has no shirt to correct, or no other shirt was free");
  const outcome = await sim.command("wear.amend", { wearingDate: report.date, remove: [wrong.garment.garmentId], add: [right.garment.garmentId], reason: "SIMULATED: I named the wrong shirt" }, { label: "a wear report is corrected" });
  if (!outcome.receipt) return sim.check(id, false, `the correction was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  report.amended = true;
  sim.forgetWear(report.date, [wrong.garment.garmentId], { all: true });
  sim.recordWear(report.date, [right.garment.garmentId]);
  report.ids = report.ids.filter((garmentId) => garmentId !== wrong.garment.garmentId).concat(right.garment.garmentId);
  const record = new Set(((await sim.inventory({ view: "history", date: report.date })).data.garments ?? []).map((g) => g.garmentId));
  const expected = new Set((sim.wears.get(report.date) ?? new Map()).keys());
  sim.check(id, record.size === expected.size && [...expected].every((garmentId) => record.has(garmentId)), `after the correction the record of ${report.date} has ${record.size} garments; the simulation expects ${expected.size} (${wrong.garment.name} out, ${right.garment.name} in)`, { commandId: outcome.receipt.commandId, summary: outcome.receipt.summary, route: outcome.route });
  sim.count(`wear reports corrected (route: ${outcome.route.replace("_", " ")})`);
  sim.trace.push(["amend", report.date]);
}
