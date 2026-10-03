/**
 * Journey 03: a laundry week with exceptions, the weekly cycle, and a week with no reports at all.
 *
 * Specification: section 3 (Laundry, wear follow-through and undo), section 5 (Quantity and laundry;
 * Probability without status interrogation), section 8 (Repair after reality changes); acceptance rows
 * "Quantities" (split batches, post-pickup wears, partial returns), "Availability" (dirty and away
 * pieces), "Missing reports" (no status interrogation; the cycle resets eligible estimates).
 * Profile: section 8 rule 2 (sneakers only until he says otherwise), section 11 (five outfits).
 *
 * Real: the Worker, its HTTP API and MCP server, the scheduled handler, the owner's real profile and
 * inventory. Stand-ins: the scripted weather double and test-signed sign-in only.
 *
 * Part one uses the owner's real stock, today. Part two needs clothes that existed weeks ago: the real
 * inventory is imported at the start of the test, so the ledger holds no real unit before that instant.
 * The weekly-cycle boundary cases therefore use labelled SYNTHETIC garments, created through the ordinary
 * command with an earlier `occurredAt`, and wears the journey itself reports late as the owner.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { defect } from "../src/defect.ts";
import { connectMcp, provisionOwner, publishBoard, toolResult, type TestOwner } from "@garderobe/worker/testing";
import type { CommandReceipt } from "@garderobe/contracts";
import { addDays, exec, internalCodesIn, isoWeekday, mcpCommand, quantityIn, realOwnerAt, refused, runCron, wholeWardrobe, type JourneyOwner } from "../src/world.ts";

type Receipt = CommandReceipt & { result: Record<string, any> };

/** Everything the product said to the owner in this file (receipt summaries, repair notes, refusals). */
const said: string[] = [];
const heard = <T extends Receipt>(receipt: T): T => {
  said.push(receipt.summary, ...receipt.repairs);
  return receipt;
};
const tell = async (o: TestOwner, type: string, payload: Record<string, unknown>, opts: { occurredAt?: string } = {}) => heard(await exec(o.api, type, payload, opts));

const laundryOf = (o: TestOwner) => o.api.json("GET", "/v1/laundry");
const itemOf = (o: TestOwner, id: string) => o.api.json("GET", `/v1/items/${id}`);
const idsOf = (list: { garmentId: string }[]) => list.map((i) => i.garmentId).sort();
const sorted = (ids: string[]) => [...ids].sort();

/** Units are conserved: every balance is positive, each garment's balances add up to what he owns, and the total is unchanged. */
async function ledgerIsSound(o: TestOwner, expectedUnits: number): Promise<void> {
  const wardrobe = await wholeWardrobe(o.api);
  let total = 0;
  for (const entry of wardrobe.items) {
    for (const balance of entry.balances) expect(balance.quantity, `${entry.garment.name} ${balance.bucket}`).toBeGreaterThan(0);
    const held = entry.balances.filter((b) => b.bucket !== "incoming" && b.bucket !== "gone").reduce((n, b) => n + b.quantity, 0);
    expect(held, entry.garment.name).toBe(entry.totalOwnedUnits);
    total += entry.totalOwnedUnits;
  }
  expect(total).toBe(expectedUnits);
}

describe("a laundry week with exceptions (the owner's real stock)", () => {
  let j: JourneyOwner;
  let owner: TestOwner;
  let stranger: TestOwner;
  const g = {} as Record<"wornShirt" | "wornTrousers" | "plaid" | "beige" | "evergreen" | "sage" | "lateShirt" | "socks" | "sneakers" | "belt", string>;
  let firstBatch: string;
  let secondBatch: string;
  let lostReturn: Receipt;
  let washUndo: Receipt;
  let assistantRoute: string;

  beforeAll(async () => {
    j = await realOwnerAt("Laundry");
    owner = j.owner;
    stranger = await provisionOwner();
    const wardrobe = await wholeWardrobe(owner.api);
    const named = (name: string) => {
      const found = wardrobe.items.find((i) => i.garment.name === name);
      if (!found) throw new Error(`"${name}" is not in the owner's wardrobe`);
      return found.garment.garmentId;
    };
    g.wornShirt = named("Brushed wool — Subalpino navy");
    g.wornTrousers = named("Akita slub 5-pocket — cream");
    g.plaid = named("California plaid");
    g.beige = named("Clark oxford — beige");
    g.evergreen = named("Clark oxford — evergreen");
    g.sage = named("Akita slub 5-pocket — dried sage");
    g.lateShirt = named("Cotton-linen oxford — Portuguese light blue");
    g.socks = named("Merino — inky blue"); // four interchangeable pairs
    g.sneakers = named("NB 990v4 — grey");
    g.belt = wardrobe.items.find((i) => i.garment.category === "belt")!.garment.garmentId;
  });

  it("a day's wear sends the shirt and trousers to the service laundry and the socks to the hand wash; belt and shoes go nowhere", async () => {
    const receipt = await tell(owner, "wear.record", { wearingDate: j.day(0), garmentIds: [g.wornShirt, g.wornTrousers, g.socks, g.belt, g.sneakers] });
    expect(receipt.outcome).toBe("committed");
    const laundry = await laundryOf(owner);
    expect(idsOf(laundry.awaitingService)).toEqual(sorted([g.wornShirt, g.wornTrousers]));
    expect(laundry.awaitingHandwash).toEqual([{ garmentId: g.socks, name: "Merino — inky blue", quantity: 1 }]);
    expect(laundry.batches).toEqual([]);
    // Footwear and belts cannot acquire a laundry state: worn, and still simply at home.
    for (const id of [g.belt, g.sneakers]) expect((await itemOf(owner, id)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    const spill = await refused(await owner.api.command("care.mark_dirty", { items: [{ garmentId: g.belt }] }));
    expect(spill.status).toBe(409);
    expect(spill.error.message).toMatch(/never laundered/);
    said.push(spill.error.message);
    const socks = (await itemOf(owner, g.socks)).detail;
    expect(quantityIn(socks, "clean")).toBe(3);
    expect(socks.totalOwnedUnits).toBe(4);
  });

  it("\"in the wash\" is a report with a receipt, and undo puts every piece back exactly", async () => {
    const before = await laundryOf(owner);
    const pieces = [g.plaid, g.beige, g.evergreen, g.sage];
    const receipt = await tell(owner, "care.mark_dirty", { items: pieces.map((garmentId) => ({ garmentId })) });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toBe("In the wash: California plaid, Clark oxford — beige, Clark oxford — evergreen, Akita slub 5-pocket — dried sage");
    expect(receipt.undo.available).toBe(true);
    expect(sorted(receipt.affected.map((a) => a.id))).toEqual(sorted(pieces));
    expect(idsOf((await laundryOf(owner)).awaitingService)).toEqual(sorted([g.wornShirt, g.wornTrousers, ...pieces]));
    expect((await itemOf(owner, g.plaid)).availability).toMatchObject({ hardExcluded: true, pAvailable: 0 });

    washUndo = await exec(owner.api, "command.undo", { commandId: receipt.commandId });
    expect(washUndo.summary).toMatch(/^Undone: In the wash: California plaid, /);
    expect(washUndo.summary).not.toContain("?");
    const after = await laundryOf(owner);
    expect(after.awaitingService).toEqual(before.awaitingService);
    expect(after.awaitingHandwash).toEqual(before.awaitingHandwash);
    for (const id of pieces) expect((await itemOf(owner, id)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    // The first receipt is kept; undo is a further receipt, not a deletion.
    expect((await owner.api.json("GET", `/v1/commands/${receipt.commandId}`)).summary).toBe(receipt.summary);
    // It really was in the wash: he reports it again.
    await tell(owner, "care.mark_dirty", { items: pieces.map((garmentId) => ({ garmentId })) });
  });

  defect("D03-1", "the Undo receipt of an \"in the wash\" report is in plain words, without a machine command code", () => {
    // Section 3: "Reversible actions show Undo in their receipt card and a short-lived banner"; section 8:
    // the assistant "confirms concisely"; profile section 8 rule 7 (words he can see at the wardrobe). The
    // receipt reads "Undone: In the wash: ... . Undid care.mark_dirty": the command's type code is shown to him.
    expect(internalCodesIn(washUndo.summary)).toEqual([]);
  });

  it("Friday's pickup snapshots the hamper into a batch, less the shirt he held back and what he is still wearing; the pickup can be undone", async () => {
    const receipt = await tell(owner, "laundry.collect", { exclude: [g.evergreen] });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toBe("Laundry collected: 3 items in the batch");
    expect(sorted(receipt.result.members.map((m: any) => m.garmentId))).toEqual(sorted([g.plaid, g.beige, g.sage]));
    let laundry = await laundryOf(owner);
    expect(laundry.batches).toHaveLength(1);
    expect(laundry.batches[0]).toMatchObject({ status: "collected", returnedAt: null, returnBasis: null });
    expect(idsOf(laundry.batches[0].items)).toEqual(sorted([g.plaid, g.beige, g.sage]));
    // Today's shirt and trousers are on his body, not in the bag; the held-back shirt is still in the hamper.
    expect(idsOf(laundry.awaitingService)).toEqual(sorted([g.wornShirt, g.wornTrousers, g.evergreen]));
    expect((await itemOf(owner, g.beige)).availability.reasons).toContain("in_service_batch");

    const undone = await tell(owner, "command.undo", { commandId: receipt.commandId });
    expect(undone.summary).toMatch(/pickup withdrawn; the items are awaiting collection again/);
    laundry = await laundryOf(owner);
    expect(laundry.batches).toEqual([]);
    expect(idsOf(laundry.awaitingService)).toEqual(sorted([g.wornShirt, g.wornTrousers, g.evergreen, g.plaid, g.beige, g.sage]));

    firstBatch = (await tell(owner, "laundry.collect", { exclude: [g.evergreen] })).result.batchId;
    await ledgerIsSound(owner, 144);
  });

  it("a second pickup is a second batch, and a shirt worn after the pickups is in neither bag", async () => {
    const second = await tell(owner, "laundry.collect", {});
    expect(second.summary).toBe("Laundry collected: 1 item in the batch");
    secondBatch = second.result.batchId;
    expect(secondBatch).not.toBe(firstBatch);
    const nothing = await tell(owner, "laundry.collect", {});
    expect(nothing.outcome).toBe("noop");
    expect(nothing.summary).toBe("Nothing was awaiting collection");

    await tell(owner, "wear.record", { wearingDate: j.day(0), garmentIds: [g.lateShirt] });
    const laundry = await laundryOf(owner);
    const batch = (id: string) => laundry.batches.find((b: any) => b.batchId === id);
    expect(laundry.batches).toHaveLength(2);
    expect(idsOf(batch(firstBatch).items)).toEqual(sorted([g.plaid, g.beige, g.sage]));
    expect(idsOf(batch(secondBatch).items)).toEqual([g.evergreen]);
    expect(idsOf(laundry.awaitingService)).toEqual(sorted([g.wornShirt, g.wornTrousers, g.lateShirt]));
    expect((await itemOf(owner, g.lateShirt)).detail.balances).toEqual([{ bucket: "dirty", ref: "", quantity: 1 }]);
  });

  it("a partial return completes only the returning batch, less the shirt still away; a return is corrected by a report, not undone", async () => {
    const receipt = await tell(owner, "laundry.return", { batchId: firstBatch, stillAway: [{ garmentId: g.beige }] });
    expect(receipt.summary).toBe("Laundry returned: 2 items clean; still away: Clark oxford — beige");
    expect(receipt.result).toMatchObject({ returned: 2, stillAway: 1 });
    const laundry = await laundryOf(owner);
    const first = laundry.batches.find((b: any) => b.batchId === firstBatch);
    expect(first).toMatchObject({ status: "partially_returned", returnBasis: "observed" });
    expect(first.items.find((i: any) => i.garmentId === g.beige)).toMatchObject({ returnedQuantity: 0, stillAway: 1 });
    expect(first.items.find((i: any) => i.garmentId === g.plaid)).toMatchObject({ returnedQuantity: 1, stillAway: 0 });
    // The other bag has not come back just because this one did.
    expect(laundry.batches.find((b: any) => b.batchId === secondBatch)).toMatchObject({ status: "collected", returnedAt: null });
    expect((await itemOf(owner, g.evergreen)).detail.balances).toEqual([{ bucket: "service", ref: secondBatch, quantity: 1 }]);
    for (const id of [g.plaid, g.sage]) expect((await itemOf(owner, id)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    expect(laundry.exceptions).toHaveLength(1);
    expect(laundry.exceptions[0]).toMatchObject({ kind: "still_away", garmentId: g.beige, quantity: 1 });

    expect(receipt.undo.available).toBe(false);
    const undo = await refused(await owner.api.command("command.undo", { commandId: receipt.commandId }));
    expect(undo.status).toBe(409);
    expect(undo.error.message).toMatch(/report what is still away instead/);
    said.push(undo.error.message);
  });

  it("the shirt still away is unavailable, and tomorrow's board offers five outfits without it or anything else in the wash", async () => {
    const beige = await itemOf(owner, g.beige);
    expect(beige.availability).toMatchObject({ status: "unavailable", hardExcluded: true, pAvailable: 0 });
    expect(beige.availability.reasons).toContain("laundry_exception");
    const published = await publishBoard(owner, { date: j.day(1) });
    expect(published.state).toBe("completed");
    expect(published.board.options).toHaveLength(5);
    const offered = new Set<string>(published.board.options.flatMap((o: any) => [...o.garments, ...o.footwearAlternatives].map((line: any) => line.garmentId)));
    for (const [label, id] of Object.entries({ "still away": g.beige, "in the second bag": g.evergreen, "worn today": g.wornShirt, "worn today (trousers)": g.wornTrousers, "worn after the pickup": g.lateShirt })) {
      expect(offered.has(id), label).toBe(false);
    }
  });

  it("when he says the rest is back, the shirt is clean, the batch is complete and the exception is closed", async () => {
    const receipt = await tell(owner, "laundry.return", { batchId: firstBatch });
    expect(receipt.summary).toBe("Laundry returned: 1 item clean");
    const laundry = await laundryOf(owner);
    expect(laundry.batches.find((b: any) => b.batchId === firstBatch)).toMatchObject({ status: "returned", returnBasis: "observed" });
    expect(laundry.exceptions).toEqual([]);
    const beige = await itemOf(owner, g.beige);
    expect(beige.detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    expect(beige.availability.hardExcluded).toBe(false);
    // Nothing was wearing-counted by all this laundry: only the day's actual wear is on record.
    expect(beige.detail.recordedWearCount).toBe(0);
  });

  it("a shirt reported lost does not come back as stock when its batch returns, and the totals still add up", async () => {
    const lost = await tell(owner, "laundry.report_exception", { kind: "lost", garmentId: g.evergreen });
    expect(lost.summary).toMatch(/^Clark oxford — evergreen: recorded as lost at the laundry/);
    expect(lost.undo.available).toBe(true);
    lostReturn = await tell(owner, "laundry.return", { batchId: secondBatch });
    const evergreen = await itemOf(owner, g.evergreen);
    expect(quantityIn(evergreen.detail, "clean")).toBe(0);
    expect(quantityIn(evergreen.detail, "service")).toBe(1);
    expect(evergreen.detail.totalOwnedUnits).toBe(1);
    expect(evergreen.availability).toMatchObject({ hardExcluded: true, pAvailable: 0 });
    expect(evergreen.availability.reasons).toContain("laundry_exception");
    const laundry = await laundryOf(owner);
    expect(laundry.exceptions.map((x: any) => [x.kind, x.garmentId])).toEqual([["lost", g.evergreen]]);
    expect(idsOf(laundry.awaitingService)).toEqual(sorted([g.wornShirt, g.wornTrousers, g.lateShirt]));
    await ledgerIsSound(owner, 144);
  });

  defect("D03-2", "the return of a bag whose only shirt was reported lost does not claim that a piece came back clean", async () => {
    // Section 5, Quantity and laundry: "A return completes only the contents of the returning batch, less
    // named exceptions." Section 3: "Each action returns a receipt and updates current availability."
    // The shirt was reported lost before the bag came back and the ledger rightly keeps it away, but the
    // return receipt and the batch record both say one item came back clean.
    expect(lostReturn.summary).not.toMatch(/1 item clean/);
    expect(lostReturn.result.returned ?? 0).toBe(0);
    const batch = (await laundryOf(owner)).batches.find((b: any) => b.batchId === secondBatch);
    expect(batch.items.find((i: any) => i.garmentId === g.evergreen).returnedQuantity).toBe(0);
  });

  it("\"Socks washed\" clears the hand wash and nothing else; socks never enter a service batch", async () => {
    const before = await laundryOf(owner);
    expect(before.awaitingHandwash.map((i: any) => [i.garmentId, i.quantity])).toEqual([[g.socks, 1]]);
    const smuggled = await refused(await owner.api.command("laundry.collect", { include: [{ garmentId: g.socks, quantity: 1 }] }));
    expect(smuggled.status).toBe(409);
    expect(smuggled.error.message).toBe("Merino — inky blue does not go to the laundry service");
    said.push(smuggled.error.message);

    const receipt = await tell(owner, "care.washed", { allOfChannel: "handwash" });
    expect(receipt.summary).toBe("Washed and clean: Merino — inky blue");
    expect(receipt.result.washed).toEqual([g.socks]);
    expect(receipt.undo.available).toBe(true);
    const after = await laundryOf(owner);
    expect(after.awaitingHandwash).toEqual([]);
    expect(after.awaitingService).toEqual(before.awaitingService);
    expect(after.batches).toEqual(before.batches);
    expect((await itemOf(owner, g.socks)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 4 }]);
    const everBatched = new Set<string>(after.batches.flatMap((b: any) => b.items.map((i: any) => i.garmentId)));
    expect(everBatched.has(g.socks)).toBe(false);
  });

  it("a connected assistant relays a wash report and reads the same laundry sheet the app shows", async () => {
    const mcp = await connectMcp(owner, { write: true, clientName: "Laundry helper", redirectUri: "https://laundry-helper.client.test/cb" });
    const relayed = await mcpCommand(owner, mcp, "care.washed", { items: [{ garmentId: g.lateShirt }] });
    assistantRoute = relayed.route;
    heard(relayed.receipt);
    expect(relayed.receipt.outcome).toBe("committed");
    expect(relayed.receipt.channel).toBe("mcp");
    expect(relayed.receipt.summary).toBe("Washed and clean: Cotton-linen oxford — Portuguese light blue");
    expect((await itemOf(owner, g.lateShirt)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);

    const view = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "laundry" } }));
    await mcp.close();
    expect(view.ok).toBe(true);
    expect(view.data.complete).toBe(true);
    const { readAt: _appReadAt, ...app } = await laundryOf(owner);
    const { readAt: _mcpReadAt, ...viaAssistant } = view.data.data;
    expect(viaAssistant).toEqual(app);
    expect(idsOf(app.awaitingService)).toEqual(sorted([g.wornShirt, g.wornTrousers]));
  });

  it("another owner sees none of it; nothing was asked of the owner, and no unit was created or lost", async () => {
    const theirs = await laundryOf(stranger);
    expect([theirs.awaitingService, theirs.awaitingHandwash, theirs.batches, theirs.exceptions]).toEqual([[], [], [], []]);
    expect((await stranger.api.get(`/v1/items/${g.beige}`)).status).toBe(404);
    expect((await stranger.api.command("laundry.return", { batchId: firstBatch })).status).toBe(404);

    for (const text of said) {
      expect(text, text).not.toContain("?");
      expect(internalCodesIn(text), text).toEqual([]);
    }
    const proposals = await owner.api.json("GET", "/v1/proposals");
    expect(proposals.pending).toBe(0);
    if (assistantRoute === "direct") expect(proposals.proposals).toEqual([]);
    expect((await owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput).toBe(0);
    await ledgerIsSound(owner, 144);
  });
});

describe("the weekly cycle (labelled SYNTHETIC garments on a timeline that starts before the import)", () => {
  let j: JourneyOwner;
  let owner: TestOwner;
  /** The most recent Sunday baseline that has already happened. */
  let K: string;
  const s = {} as Record<"firstWeek" | "collected" | "secondWeek" | "lost" | "thirdWeek" | "afterCollection" | "socks" | "atTailor", string>;
  const noon = (date: string) => ({ occurredAt: `${date}T12:00:00.000Z` });
  const cycleKeys = async () => (await laundryOf(owner)).cycles.map((c: any) => c.cycleKey).sort();

  beforeAll(async () => {
    j = await realOwnerAt("Laundry cycle");
    owner = j.owner;
    K = j.day(0);
    while (isoWeekday(K) !== 7) K = addDays(K, -1);
    const synthetic = async (label: string, extra: Record<string, unknown> = {}) =>
      (
        await exec(
          owner.api,
          "garment.create",
          { name: `SYNTHETIC ${label} (journey 03)`, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic boundary-case garment for journey 03" }, ...extra },
          noon(addDays(K, -30)),
        )
      ).result.garmentId as string;
    s.firstWeek = await synthetic("shirt worn in the first week");
    s.collected = await synthetic("shirt the service collected");
    s.secondWeek = await synthetic("shirt worn in the second week");
    s.lost = await synthetic("shirt lost at the laundry");
    s.thirdWeek = await synthetic("shirt worn in the third week");
    s.afterCollection = await synthetic("shirt worn after the last collection");
    s.socks = await synthetic("hand-wash socks", { category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3 });
    s.atTailor = await synthetic("shirt at the tailor", { initialBucket: "tailor" });
  });

  it("three unlogged weeks are reported late in one sitting, and every report is simply accepted", async () => {
    // Wednesdays of three successive weeks, a Friday pickup he did see, and the Saturday just before the last baseline.
    const first = await tell(owner, "wear.record", { wearingDate: addDays(K, -18), garmentIds: [s.firstWeek, s.collected, s.socks] });
    expect(first.outcome).toBe("committed");
    expect(first.repairs).toEqual([]);
    const pickup = await tell(owner, "laundry.collect", { exclude: [s.firstWeek] }, { occurredAt: `${addDays(K, -16)}T09:00:00.000Z` });
    expect(pickup.result.members).toEqual([{ garmentId: s.collected, quantity: 1 }]);
    await tell(owner, "wear.record", { wearingDate: addDays(K, -11), garmentIds: [s.secondWeek, s.lost] });
    await tell(owner, "laundry.report_exception", { kind: "lost", garmentId: s.lost }, noon(addDays(K, -9)));
    await tell(owner, "wear.record", { wearingDate: addDays(K, -4), garmentIds: [s.thirdWeek] });
    await tell(owner, "wear.record", { wearingDate: addDays(K, -1), garmentIds: [s.afterCollection] });

    const laundry = await laundryOf(owner);
    expect(idsOf(laundry.awaitingService)).toEqual(sorted([s.firstWeek, s.secondWeek, s.thirdWeek, s.afterCollection]));
    expect(laundry.awaitingHandwash.map((i: any) => [i.garmentId, i.quantity])).toEqual([[s.socks, 1]]);
    expect(laundry.batches).toHaveLength(1);
    expect(laundry.batches[0]).toMatchObject({ status: "collected", pickedUpAt: `${addDays(K, -16)}T09:00:00.000Z`, returnedAt: null });
    expect(laundry.cycles).toEqual([]);
    // The report says when it happened; the record also keeps when he said it.
    const day = await owner.api.json("GET", `/v1/days/${addDays(K, -18)}`);
    const report = day.observations.find((o: any) => o.garmentId === s.firstWeek);
    expect(report.wearingDate).toBe(addDays(K, -18));
    expect(report.occurredAt.slice(0, 10)).toBe(addDays(K, -18));
    expect(report.reportedAt.slice(0, 10) >= j.day(-1)).toBe(true);
  });

  it("the weekly baseline clears a wear recorded before that week's collection: no wash was reported, and the shirt is not locked out", async () => {
    const receipt = await tell(owner, "laundry.apply_weekly_reset", { asOf: `${addDays(K, -14)}T12:00:00.000Z` });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toBe(`Weekly laundry baseline applied (service ${addDays(K, -14)}): 2 garments estimated clean; owner-reported exceptions kept`);
    expect(receipt.result.cyclesApplied).toEqual([{ channel: "service", cycleKey: addDays(K, -14) }]);
    const shirt = await itemOf(owner, s.firstWeek);
    expect(shirt.detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    expect(shirt.availability.hardExcluded).toBe(false);
    expect(shirt.availability.pAvailable).toBeGreaterThan(0);
    // The wear itself is history, not an estimate: it is still counted, on its date.
    expect(shirt.detail.recordedWearCount).toBe(1);
    expect(shirt.detail.lastRecordedWear).toBe(addDays(K, -18));
    expect((await owner.api.json("GET", `/v1/availability?date=${j.day(0)}`)).lastBaseline.cycleKey).toBe(addDays(K, -14));
  });

  it("the baseline is an inference under the standing policy: it records no observed pickup and no observed return", async () => {
    const laundry = await laundryOf(owner);
    // No bag was invented for the shirt that was never collected; the one real pickup is still the only batch.
    expect(laundry.batches).toHaveLength(1);
    expect(idsOf(laundry.batches[0].items)).toEqual([s.collected]);
    expect(laundry.batches[0].returnBasis).toBe("inferred");
    expect(laundry.batches[0].status).not.toBe("returned");
    expect(laundry.batches[0].items[0].returnedQuantity).toBe(0);
    const inferred = (await itemOf(owner, s.firstWeek)).detail.movements.filter((m: any) => m.to === "clean" && m.from === "dirty");
    expect(inferred).toHaveLength(1);
    expect(inferred[0].basis).toBe("inferred");
    expect(inferred[0].note).toMatch(/inferred clean \(no pickup or return was observed\)/);
    const collected = (await itemOf(owner, s.collected)).detail;
    expect(collected.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    expect(collected.movements.filter((m: any) => m.kind === "return")).toEqual([]);
    expect(collected.movements.find((m: any) => m.to === "clean" && m.from === "service")).toMatchObject({ basis: "inferred", note: expect.stringMatching(/return inferred, not observed/) });
    const receipt = (await owner.api.json("GET", "/v1/commands")).receipts.find((r: any) => r.type === "laundry.apply_weekly_reset");
    expect(receipt.result.observedReturnsRecorded).toBe(0);
    expect(receipt.undo).toMatchObject({ available: false, reason: expect.stringMatching(/standing policy; report an exception instead/) });
  });

  defect("D03-3", "the availability basis of a shirt that is clean only by the weekly inference does not call that an observation", async () => {
    // Section 5, Quantity and laundry: "Availability combines observed physical facts with a separately
    // recorded estimate of routine cleanliness." Probability without status interrogation: "Do not falsely
    // record an observed pickup or return." Section 3: "Availability detail can show its basis".
    // Nobody observed this shirt being washed or returned; the basis shown for it nevertheless reads
    // "1 clean unit at home (observed ledger balance)" and says nothing of the weekly estimate.
    const basis = (await itemOf(owner, s.firstWeek)).availability.basis.join(" ");
    expect(basis).not.toMatch(/observed/i);
    expect(basis).toMatch(/inferred|estimate|baseline/i);
  });

  it("the baseline releases nothing that is not its to release: hand-wash socks, the tailor, the lost shirt, the sneakers-only restriction, later wears", async () => {
    // Hand-wash mode is owner-reported: the socks wait for "Socks washed".
    expect((await itemOf(owner, s.socks)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 2 }, { bucket: "dirty", ref: "", quantity: 1 }]);
    const tailor = await itemOf(owner, s.atTailor);
    expect(tailor.detail.balances).toEqual([{ bucket: "tailor", ref: "", quantity: 1 }]);
    expect(tailor.availability).toMatchObject({ hardExcluded: true, reasons: expect.arrayContaining(["at_tailor"]) });
    const lost = await itemOf(owner, s.lost);
    expect(quantityIn(lost.detail, "clean")).toBe(0);
    expect(lost.availability).toMatchObject({ hardExcluded: true, reasons: expect.arrayContaining(["laundry_exception"]) });
    const laundry = await laundryOf(owner);
    expect(laundry.exceptions.map((x: any) => [x.kind, x.garmentId])).toEqual([["lost", s.lost]]);
    // Wears after that week's collection are not part of that week's wash.
    expect(idsOf(laundry.awaitingService)).toEqual(sorted([s.secondWeek, s.thirdWeek, s.afterCollection]));
    const footwear = (await wholeWardrobe(owner.api, "category=footwear")).items.filter((i) => i.garment.category === "footwear");
    const restricted = footwear.filter((i) => i.availability!.reasons.includes("restricted"));
    expect(footwear).toHaveLength(7);
    expect(restricted.map((i) => i.garment.name).sort()).toEqual(["Drake's Clifford boot", "Paraboot Michael Cerf", "Paraboot Reims — café/marron", "Paraboot Reims — noir (black)"]);
    for (const shoe of restricted) expect(shoe.availability!.hardExcluded).toBe(true);
  });

  it("sent twice, sent for the future, or sent after missed runs, each cycle is applied exactly once", async () => {
    const again = await tell(owner, "laundry.apply_weekly_reset", { asOf: `${addDays(K, -14)}T12:00:00.000Z` });
    expect(again.outcome).toBe("noop");
    expect(again.summary).toBe("No laundry baseline is due");
    const early = await refused(await owner.api.command("laundry.apply_weekly_reset", { asOf: `${addDays(K, 14)}T12:00:00.000Z` }));
    expect(early.status).toBe(400);
    expect(early.error.message).toMatch(/cannot be applied for a future date; nothing was written/);
    said.push(early.error.message);
    expect(await cycleKeys()).toEqual([addDays(K, -14)]);

    // Two Sundays went by with no run at all; the next run applies both, each once.
    const caughtUp = await tell(owner, "laundry.apply_weekly_reset", {});
    expect(caughtUp.result.cyclesApplied).toEqual([{ channel: "service", cycleKey: addDays(K, -7) }, { channel: "service", cycleKey: K }]);
    expect(caughtUp.summary).toContain("2 garments estimated clean");
    expect((await tell(owner, "laundry.apply_weekly_reset", {})).outcome).toBe("noop");
    expect(await cycleKeys()).toEqual([addDays(K, -14), addDays(K, -7), K]);

    for (const id of [s.secondWeek, s.thirdWeek]) expect((await itemOf(owner, id)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    // Worn on the Saturday after the last collection: that is next week's wash.
    const laundry = await laundryOf(owner);
    expect(idsOf(laundry.awaitingService)).toEqual([s.afterCollection]);
    expect(laundry.batches).toHaveLength(1);
    // Three resets erased no wear: every count, last-worn date and day record is as reported.
    for (const [id, offset] of [[s.firstWeek, -18], [s.collected, -18], [s.secondWeek, -11], [s.lost, -11], [s.thirdWeek, -4], [s.afterCollection, -1]] as const) {
      const detail = (await itemOf(owner, id)).detail;
      expect(detail.recordedWearCount, detail.garment.name).toBe(1);
      expect(detail.lastRecordedWear).toBe(addDays(K, offset));
      expect(detail.recentWears.map((w: any) => [w.wearingDate, w.status])).toEqual([[addDays(K, offset), "active"]]);
    }
    expect(idsOf((await owner.api.json("GET", `/v1/days/${addDays(K, -11)}`)).garments)).toEqual(sorted([s.secondWeek, s.lost]));
  });

  it("a missed return reported after the baseline overrides the inference and keeps that week's laundry away, whatever the reset says", async () => {
    const receipt = await tell(owner, "laundry.report_exception", { kind: "missed_return", cycleKey: K });
    expect(receipt.summary).toBe(`Laundry not returned for the week of ${K}: collected items stay unavailable until they are back`);
    expect(receipt.undo.available).toBe(true);
    const held = await itemOf(owner, s.thirdWeek);
    expect(held.detail.balances).toEqual([{ bucket: "service", ref: `cycle:${K}`, quantity: 1 }]);
    expect(held.availability).toMatchObject({ hardExcluded: true, pAvailable: 0, reasons: expect.arrayContaining(["laundry_exception"]) });
    // An earlier week's laundry did come back; it is not swept up by this report.
    expect((await itemOf(owner, s.secondWeek)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    expect((await tell(owner, "laundry.apply_weekly_reset", {})).outcome).toBe("noop");
    expect((await itemOf(owner, s.thirdWeek)).availability.hardExcluded).toBe(true);
    const laundry = await laundryOf(owner);
    expect(laundry.exceptions.map((x: any) => [x.kind, x.garmentId, x.cycleKey]).sort()).toEqual([["lost", s.lost, null], ["missed_return", null, K]]);
  });

  it("\"the laundry is back\" releases what the missed week held; the lost shirt stays lost", async () => {
    const receipt = await tell(owner, "laundry.return", {});
    expect(receipt.summary).toBe(`Laundry returned: 1 item clean (held back since the missed return of ${K})`);
    const back = await itemOf(owner, s.thirdWeek);
    expect(back.detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    expect(back.availability.hardExcluded).toBe(false);
    expect(back.detail.movements.at(-1)).toMatchObject({ kind: "return", from: "service", to: "clean", basis: "observed" });
    const laundry = await laundryOf(owner);
    expect(laundry.exceptions.map((x: any) => [x.kind, x.garmentId])).toEqual([["lost", s.lost]]);
    expect(quantityIn((await itemOf(owner, s.lost)).detail, "clean")).toBe(0);
    expect(idsOf(laundry.awaitingService)).toEqual([s.afterCollection]);
    await ledgerIsSound(owner, 144 + 10); // the owner's 144 units and the ten synthetic ones, each still exactly where it was put
    for (const text of said) {
      expect(text, text).not.toContain("?");
      expect(internalCodesIn(text), text).toEqual([]);
    }
    expect((await owner.api.json("GET", "/v1/proposals")).proposals).toEqual([]);
  });
});

describe("a week with no reports at all (the owner's real stock)", () => {
  let j: JourneyOwner;
  let owner: TestOwner;

  beforeAll(async () => {
    j = await realOwnerAt("Laundry silence");
    owner = j.owner;
  });

  it("boards keep coming, five outfits a day, on estimates with a stated basis instead of questions", async () => {
    const first = await publishBoard(owner, { date: j.day(0) });
    const second = await publishBoard(owner, { date: j.day(1) });
    expect(first.board.options).toHaveLength(5);
    expect(second.board.options).toHaveLength(5);
    // He chooses nothing and reports nothing. What was offered may have been worn: an estimate, never a fact.
    const offeredTops = new Set<string>(first.board.options.map((o: any) => o.garments.find((line: any) => line.role === "top").garmentId));
    const availability = await owner.api.json("GET", `/v1/availability?date=${j.day(2)}`);
    expect(availability.parameters.parameterStatus).toBe("hypothesis");
    for (const id of offeredTops) {
      const estimate = availability.garments.find((e: any) => e.garmentId === id);
      expect(estimate.status).toBe("estimated");
      expect(estimate.hardExcluded).toBe(false); // uncertainty alone is not an exclusion
      expect(estimate.pAvailable).toBeGreaterThan(0);
      expect(estimate.pAvailable).toBeLessThan(1);
      expect(estimate.reasons).toContain("estimated_possibly_worn");
      expect(estimate.basis.join(" ")).toMatch(/offered on \d unreported days? since the last laundry baseline/);
      for (const line of estimate.basis) expect(internalCodesIn(line), line).toEqual([]);
      // Inferred wear is kept apart from recorded wear: nothing was counted, nothing went to the wash.
      const detail = (await itemOf(owner, id)).detail;
      expect(detail.recordedWearCount).toBe(0);
      expect(detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 1 }]);
    }
    const third = await publishBoard(owner, { date: j.day(2) });
    expect(third.state).toBe("completed");
    expect(third.board.options).toHaveLength(5);
    for (const option of third.board.options) {
      if (!option.qualification) continue;
      expect(option.qualification).not.toContain("?");
      expect(option.qualification).not.toMatch(/\d ?%|0\.\d/); // a concise qualification, not an invented percentage
      expect(internalCodesIn(option.qualification)).toEqual([]);
    }
  });

  it("the scheduled job applies the weekly baseline by itself, once, and the silent week leaves no task behind", async () => {
    // The baseline is applied by the service's next due phase. Outside the evening and morning windows
    // none is due, so the owner's evening composition time is set to midnight: tomorrow's is then due now,
    // whatever time of day this suite runs.
    await exec(owner.api, "settings.update", { patch: { extensions: { daily: { eveningComposeLocalTime: "00:00" } } } });
    await runCron();
    await runCron();
    let K = j.day(0);
    while (isoWeekday(K) !== 7) K = addDays(K, -1);
    const laundry = await laundryOf(owner);
    expect(laundry.cycles.map((c: any) => [c.channel, c.cycleKey])).toEqual([["service", K]]);
    expect([laundry.awaitingService, laundry.awaitingHandwash, laundry.batches, laundry.exceptions]).toEqual([[], [], [], []]);
    const resets = (await owner.api.json("GET", "/v1/commands")).receipts.filter((r: any) => r.type === "laundry.apply_weekly_reset" && r.outcome === "committed");
    expect(resets).toHaveLength(1);
    expect(resets[0].actor).toBe("system");
    expect(resets[0].summary).not.toContain("?");
    // No wear was invented for the days he said nothing about, and nothing waits for his confirmation.
    for (const offset of [0, 1]) expect((await owner.api.json("GET", `/v1/days/${j.day(offset)}`)).garments).toEqual([]);
    expect((await owner.api.json("GET", `/v1/today?date=${j.day(0)}`)).dayRecord).toEqual([]);
    expect((await owner.api.json("GET", "/v1/proposals")).proposals).toEqual([]);
    expect((await owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput).toBe(0);
    await ledgerIsSound(owner, 144);
  });
});
