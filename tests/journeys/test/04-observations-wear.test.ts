/**
 * Journey 04: what the owner says he wore is recorded as said, and counted once.
 *
 * Specification: section 5 (One counted wear per garment and wearing date; Owner observations and
 * accounting repair; Quantity and laundry), section 8 (Repair after reality changes: "Historical wear
 * observations always commit through the observation path", and the Amendment paragraph), section 3
 * (undo); acceptance rows "Wear correction", "Quantities" (duplicate socks) and "Concurrency" (parallel
 * clients). Profile: section 8 rule 2 (sneakers only until the owner says his feet have healed).
 *
 * Real: the Worker, its HTTP API (phone and web sessions, offline batch replay) and MCP server, the
 * owner's real profile and inventory. Stand-ins: the scripted weather double and test-signed sign-in.
 *
 * The real inventory is imported at the start of the test, so the ledger holds no real unit before that
 * instant. Two boundary cases need clothes that existed days ago (a late report set against a later wash,
 * and an amendment after a laundry pickup): they use labelled SYNTHETIC shirts created through the
 * ordinary command with an earlier `occurredAt`. Every wear in this file is reported by the journey as
 * the owner.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { connectMcp, provisionOwner, type TestOwner } from "@garderobe/worker/testing";
import type { CommandReceipt } from "@garderobe/contracts";
import { exec, internalCodesIn, mcpCommand, quantityIn, realOwnerAt, refused, wholeWardrobe, type JourneyOwner } from "../src/world.ts";

type Receipt = CommandReceipt & { result: Record<string, any> };

let j: JourneyOwner;
let owner: TestOwner;
let stranger: TestOwner;
const g = {} as Record<"morningShirt" | "eveningShirt" | "washedShirt" | "wrongShirt" | "rightShirt" | "undoneShirt" | "trousers" | "lateTrousers" | "racedTrousers" | "socks" | "singleSocks" | "undoneSocks" | "sneakers" | "welted", string>;
const s = {} as Record<"washedToday" | "notWashed" | "neverWorn" | "inTheBag" | "actuallyWorn", string>;
let startedAt: number;
let lateReport: Receipt;
let pickedUpBatch: string;

/** Everything the product said to the owner in this file (receipt summaries, repair notes, refusals). */
const said: string[] = [];
const heard = <T extends Receipt>(receipt: T): T => {
  said.push(receipt.summary, ...receipt.repairs);
  return receipt;
};
const tell = async (type: string, payload: Record<string, unknown>, opts: { occurredAt?: string; expectedVersions?: Record<string, number> } = {}) => heard(await exec(owner.api, type, payload, opts));

const item = (id: string) => owner.api.json("GET", `/v1/items/${id}`);
const dayRecord = (date: string) => owner.api.json("GET", `/v1/days/${date}`);
const laundry = () => owner.api.json("GET", "/v1/laundry");
const sorted = (ids: string[]) => [...ids].sort();
const CLEAN = (quantity = 1) => [{ bucket: "clean", ref: "", quantity }];
const DIRTY = (quantity = 1) => [{ bucket: "dirty", ref: "", quantity }];

/** Units are conserved: every balance is positive, each garment's balances add up to what he owns, and the total is unchanged. */
async function ledgerIsSound(expectedUnits: number): Promise<void> {
  const wardrobe = await wholeWardrobe(owner.api);
  let total = 0;
  for (const entry of wardrobe.items) {
    for (const balance of entry.balances) expect(balance.quantity, `${entry.garment.name} ${balance.bucket}`).toBeGreaterThan(0);
    const held = entry.balances.filter((b) => b.bucket !== "incoming" && b.bucket !== "gone").reduce((n, b) => n + b.quantity, 0);
    expect(held, entry.garment.name).toBe(entry.totalOwnedUnits);
    total += entry.totalOwnedUnits;
  }
  expect(total).toBe(expectedUnits);
}

beforeAll(async () => {
  startedAt = Date.now();
  j = await realOwnerAt("Observations");
  owner = j.owner;
  stranger = await provisionOwner();
  const wardrobe = await wholeWardrobe(owner.api);
  const named = (name: string) => {
    const found = wardrobe.items.find((i) => i.garment.name === name);
    if (!found) throw new Error(`"${name}" is not in the owner's wardrobe`);
    return found.garment.garmentId;
  };
  g.morningShirt = named("Brushed wool — Subalpino navy");
  g.eveningShirt = named("California plaid");
  g.washedShirt = named("Clark oxford — beige");
  g.wrongShirt = named("Clark oxford — evergreen");
  g.rightShirt = named("Cotton-linen oxford — Portuguese light blue");
  g.undoneShirt = named("Cotton-linen oxford — blue stripe");
  g.trousers = named("Akita slub 5-pocket — cream");
  g.lateTrousers = named("Akita slub 5-pocket — dried sage");
  g.racedTrousers = named("Cord — navy");
  g.socks = named("Merino — inky blue"); // four interchangeable pairs
  g.singleSocks = named("Alpaca — inky blue"); // one pair
  g.undoneSocks = named("Merino — correct grey"); // three pairs
  g.sneakers = named("NB 990v4 — grey");
  g.welted = named("Paraboot Michael Cerf");

  const synthetic = async (label: string) =>
    (
      await exec(
        owner.api,
        "garment.create",
        { name: `SYNTHETIC ${label} (journey 04)`, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic boundary-case garment for journey 04" } },
        { occurredAt: `${j.day(-10)}T12:00:00.000Z` },
      )
    ).result.garmentId as string;
  s.washedToday = await synthetic("shirt washed today");
  s.notWashed = await synthetic("shirt not washed since");
  s.neverWorn = await synthetic("shirt logged by mistake");
  s.inTheBag = await synthetic("shirt that went in the bag");
  s.actuallyWorn = await synthetic("shirt he actually wore");
});

describe("what the owner says he wore is recorded as said", () => {
  it("\"I am wearing it\" commits although the ledger had the shirt in the wash and the trousers away at the laundry; the receipt explains the repair and asks nothing", async () => {
    await tell("care.mark_dirty", { items: [{ garmentId: g.morningShirt }, { garmentId: g.trousers }] });
    const pickup = await tell("laundry.collect", { exclude: [g.morningShirt] });
    expect((await item(g.trousers)).detail.balances).toEqual([{ bucket: "service", ref: pickup.result.batchId, quantity: 1 }]);
    expect((await item(g.trousers)).availability.hardExcluded).toBe(true);

    // The phone last saw both pieces at version 1; they have changed since. The observation is rebased, not refused.
    const pieces = [g.morningShirt, g.trousers, g.socks, g.sneakers];
    const response = await owner.api.command("wear.record", { wearingDate: j.day(0), garmentIds: pieces, segment: "morning" }, { expectedVersions: { [`garment:${g.morningShirt}`]: 1, [`garment:${g.trousers}`]: 1 } });
    expect(response.status).toBe(200);
    const receipt = heard((await response.json()) as Receipt);
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toBe("Recorded for today: Brushed wool — Subalpino navy, Akita slub 5-pocket — cream, Merino — inky blue, NB 990v4 — grey");
    expect(sorted(receipt.result.counted)).toEqual(sorted(pieces));
    expect(receipt.repairs).toHaveLength(2);
    expect(receipt.repairs.find((r) => r.startsWith("Akita slub 5-pocket — cream"))).toMatch(/the recorded wear establishes it is with the owner/);
    expect(receipt.repairs.find((r) => r.startsWith("Brushed wool — Subalpino navy"))).toMatch(/the wear is recorded/);
    expect(receipt.undo.available).toBe(true);

    // The trousers are with him, not at the laundry; no unit was conjured to make the wear fit.
    for (const id of [g.morningShirt, g.trousers]) {
      const { detail } = await item(id);
      expect(detail.balances, detail.garment.name).toEqual(DIRTY());
      expect(detail.totalOwnedUnits).toBe(1);
      expect(detail.recordedWearCount).toBe(1);
      expect(detail.lastRecordedWear).toBe(j.day(0));
    }
    expect((await dayRecord(j.day(0))).garments.map((line: any) => line.garmentId).sort()).toEqual(sorted(pieces));
    await ledgerIsSound(149);
  });

  it("a stale version on \"I washed it\" is rebased too, while the same stale version on an edit of the record is refused and writes nothing", async () => {
    const stale = { [`garment:${g.washedShirt}`]: 99 };
    const washed = await tell("care.washed", { items: [{ garmentId: g.washedShirt }] }, { expectedVersions: stale });
    expect(washed.outcome).toBe("committed");
    expect(washed.summary).toBe("Washed and clean: Clark oxford — beige");
    const before = (await item(g.washedShirt)).detail.garment;
    const edit = await refused(await owner.api.command("garment.correct", { garmentId: g.washedShirt, changes: { colour: "navy" }, source: { kind: "owner_statement", note: "a correction made on a screen that was out of date" } }, { expectedVersions: stale }));
    expect(edit.status).toBe(409);
    expect(edit.error.code).toBe("conflict");
    expect(edit.error.message).toMatch(/changed elsewhere since you last saw it; nothing was written/);
    said.push(edit.error.message);
    const after = (await item(g.washedShirt)).detail.garment;
    expect(after.colour).toBe(before.colour);
    expect(after.version).toBe(before.version);
  });

  it("\"I wore it yesterday\" keeps when it happened apart from when he said it, and does not undo today's wash", async () => {
    lateReport = await tell("wear.record", { wearingDate: j.day(-1), garmentIds: [g.washedShirt, g.lateTrousers] });
    expect(lateReport.outcome).toBe("committed");
    expect(lateReport.summary).toBe("Recorded for yesterday: Clark oxford — beige, Akita slub 5-pocket — dried sage");
    const yesterday = await dayRecord(j.day(-1));
    expect(yesterday.garments.map((line: any) => line.garmentId).sort()).toEqual(sorted([g.washedShirt, g.lateTrousers]));
    for (const report of yesterday.observations) {
      expect(report.wearingDate).toBe(j.day(-1));
      expect(report.timezone).toBe("Europe/London");
      expect(report.occurredAt.slice(0, 10)).toBe(j.day(-1)); // it happened yesterday
      expect(Date.parse(report.reportedAt)).toBeGreaterThanOrEqual(startedAt - 1000); // and was said just now
      expect(Date.parse(report.occurredAt)).toBeLessThan(Date.parse(report.reportedAt));
    }
    expect((await dayRecord(j.day(0))).garments.map((line: any) => line.garmentId)).not.toContain(g.washedShirt);
    const shirt = await item(g.washedShirt);
    expect(shirt.detail.recordedWearCount).toBe(1);
    expect(shirt.detail.lastRecordedWear).toBe(j.day(-1));
    // He washed it this morning: yesterday's wear, told afterwards, leaves it clean today.
    expect(shirt.detail.balances).toEqual(CLEAN());
    expect(shirt.availability.hardExcluded).toBe(false);
  });

  it("late reports are replayed in the order things happened: the wash after the wear wins, the unwashed shirt is still dirty, and two dates are two wears", async () => {
    // Two shirts worn the day before yesterday, both reported now; one of them washed this morning.
    await tell("wear.record", { wearingDate: j.day(-2), garmentIds: [s.washedToday, s.notWashed] });
    for (const id of [s.washedToday, s.notWashed]) expect((await item(id)).detail.balances).toEqual(DIRTY());
    await tell("care.washed", { items: [{ garmentId: s.washedToday }] });
    expect((await item(s.washedToday)).detail.balances).toEqual(CLEAN());

    const late = await tell("wear.record", { wearingDate: j.day(-1), garmentIds: [s.washedToday, s.notWashed] });
    expect(late.outcome).toBe("committed");
    expect(sorted(late.result.counted)).toEqual(sorted([s.washedToday, s.notWashed]));
    for (const text of late.repairs) expect(text).not.toContain("?");
    const washed = (await item(s.washedToday)).detail;
    expect(washed.balances).toEqual(CLEAN()); // today's known wash stands
    expect(washed.movements.map((m: any) => m.kind)).toEqual(["receive", "wear", "wash"]);
    expect((await item(s.notWashed)).detail.balances).toEqual(DIRTY());
    // The key is the wearing date, not a rolling 24 hours: consecutive days are two counted wears.
    for (const id of [s.washedToday, s.notWashed]) {
      const { detail } = await item(id);
      expect(detail.recordedWearCount).toBe(2);
      expect(detail.lastRecordedWear).toBe(j.day(-1));
      expect(detail.recentWears.map((w: any) => w.wearingDate).sort()).toEqual([j.day(-2), j.day(-1)]);
    }
    // Tomorrow cannot be counted in advance; the refusal says what to do instead.
    const early = await refused(await owner.api.command("wear.record", { wearingDate: j.day(1), garmentIds: [g.sneakers] }));
    expect(early.status).toBe(400);
    expect(early.error.message).toBe("a wear cannot be recorded for a future date; choose an outfit instead");
    said.push(early.error.message);
  });

  it("trousers he says he wore yesterday, not washed since, are not offered as clean today", async () => {
    // Section 5, Owner observations and accounting repair: "'I am wearing it,' 'I washed it,' and 'I wore
    // it yesterday' are authoritative physical observations. ... Recompute the affected daily records, stock
    // estimates, and future plans in event order". Quantity and laundry: "Trousers have a single-wear-day
    // care policy. ... it makes them unavailable to a later fresh outfit after that wear".
    // Was defect D04-1 (a wear dated before the instant the inventory was imported found no stock to move,
    // and the receipt said "no owned units on record"); fixed by the foundation in a5e6c8fa.
    expect(lateReport.repairs.join(" ")).not.toMatch(/no owned units on record/);
    const trousers = await item(g.lateTrousers);
    expect(quantityIn(trousers.detail, "clean")).toBe(0);
    expect(trousers.availability.hardExcluded).toBe(true);
  });

  it("morning and evening are one wear of the trousers; changing shirts counts the new shirt only and keeps the first shirt's wear", async () => {
    const pieces = [g.eveningShirt, g.trousers, g.socks, g.sneakers];
    const receipt = await tell("wear.record", { wearingDate: j.day(0), garmentIds: pieces, segment: "evening" });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toBe("Recorded for today: California plaid, Akita slub 5-pocket — cream, Merino — inky blue, NB 990v4 — grey (3 already recorded that day, counted once)");
    expect(receipt.result.counted).toEqual([g.eveningShirt]);
    expect(sorted(receipt.result.merged)).toEqual(sorted([g.trousers, g.socks, g.sneakers]));
    expect(receipt.repairs).toEqual([]);

    const today = await dayRecord(j.day(0));
    const line = (id: string) => today.garments.find((entry: any) => entry.garmentId === id);
    for (const id of [g.trousers, g.socks, g.sneakers]) {
      expect(line(id).segments).toEqual(["morning", "evening"]); // both outfit segments are kept
      expect(line(id).observationCount).toBe(2);
      expect((await item(id)).detail.recordedWearCount).toBe(1);
    }
    expect(line(g.morningShirt).segments).toEqual(["morning"]);
    expect(line(g.eveningShirt).segments).toEqual(["evening"]);
    expect((await item(g.morningShirt)).detail.recordedWearCount).toBe(1);
    expect((await item(g.eveningShirt)).detail.recordedWearCount).toBe(1);
    expect((await item(g.eveningShirt)).detail.balances).toEqual(DIRTY());
    // The trousers were not consumed again, and no second pair of socks was used up.
    expect((await item(g.trousers)).detail.balances).toEqual(DIRTY());
    expect((await item(g.socks)).detail.balances).toEqual([{ bucket: "clean", ref: "", quantity: 3 }, { bucket: "dirty", ref: "", quantity: 1 }]);
  });

  it("the same wear from the phone, the web, an offline replay and a connected assistant is one counted wear with every source kept", async () => {
    const web = owner.api.with({ client: "web" });
    const fromWeb = heard(await exec(web, "wear.record", { wearingDate: j.day(0), garmentIds: [g.trousers] }));
    expect(fromWeb.outcome).toBe("merged");
    expect(fromWeb.channel).toBe("web");
    expect(fromWeb.summary).toBe("Already recorded for today: Akita slub 5-pocket — cream. The report was merged; nothing was counted twice");

    // The phone was offline when he tapped; it replays its queue, and then replays it again after a dropped response.
    const queued = { type: "wear.record", payload: { wearingDate: j.day(0), garmentIds: [g.trousers] }, idempotencyKey: `offline-${crypto.randomUUID()}`, expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios", clientSubmissionId: "offline-queue-1" } };
    const replay = await owner.api.json("POST", "/v1/commands/batch", { commands: [queued] });
    expect(replay.results).toHaveLength(1);
    expect(replay.results[0]).toMatchObject({ status: "receipt", receipt: { outcome: "merged", replayed: false } });
    heard(replay.results[0].receipt);
    const again = await owner.api.json("POST", "/v1/commands/batch", { commands: [queued] });
    expect(again.results[0]).toMatchObject({ status: "receipt", receipt: { replayed: true, commandId: replay.results[0].receipt.commandId } });

    const mcp = await connectMcp(owner, { write: true, clientName: "Wear helper", redirectUri: "https://wear-helper.client.test/cb" });
    const relayed = await mcpCommand(owner, mcp, "wear.record", { wearingDate: j.day(0), garmentIds: [g.trousers] }, { expectRoute: "direct" });
    await mcp.close();
    heard(relayed.receipt);
    expect(relayed.receipt.outcome).toBe("merged");
    expect(relayed.receipt.channel).toBe("mcp");

    const trousers = (await item(g.trousers)).detail;
    expect(trousers.recordedWearCount).toBe(1);
    expect(trousers.balances).toEqual(DIRTY());
    const today = await dayRecord(j.day(0));
    const reports = today.observations.filter((o: any) => o.garmentId === g.trousers);
    // Morning, evening, web, the offline replay (once, not twice) and the assistant: five sources, one wear.
    expect(reports).toHaveLength(5);
    expect(reports.every((o: any) => o.status === "active")).toBe(true);
    expect(reports.map((o: any) => o.channel).sort()).toEqual(["ios", "ios", "ios", "mcp", "web"]);
    expect(new Set(reports.map((o: any) => o.commandId)).size).toBe(5);
    expect(today.garments.find((entry: any) => entry.garmentId === g.trousers)).toMatchObject({ observationCount: 5, segments: ["morning", "evening"] });
  });

  it("the phone and the web reporting at the same moment are both accepted, and the wear is still counted once", async () => {
    const web = owner.api.with({ client: "web" });
    const report = { wearingDate: j.day(0), garmentIds: [g.racedTrousers] };
    const responses = await Promise.all([owner.api.command("wear.record", report), web.command("wear.record", report), owner.api.command("wear.record", report)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const receipts = (await Promise.all(responses.map((r) => r.json()))) as Receipt[];
    receipts.forEach(heard);
    expect(receipts.map((r) => r.outcome).sort()).toEqual(["committed", "merged", "merged"]);
    const trousers = (await item(g.racedTrousers)).detail;
    expect(trousers.recordedWearCount).toBe(1);
    expect(trousers.balances).toEqual(DIRTY());
    expect((await dayRecord(j.day(0))).garments.find((entry: any) => entry.garmentId === g.racedTrousers).observationCount).toBe(3);
  });

  it("anonymous sock pairs: a duplicate uses no pair, changing into a second clean pair moves one pair without a second wear, and stock never goes negative", async () => {
    const pairs = async (id: string) => {
      const { detail } = await item(id);
      return { clean: quantityIn(detail, "clean"), dirty: quantityIn(detail, "dirty"), owned: detail.totalOwnedUnits, wears: detail.recordedWearCount };
    };
    expect(await pairs(g.socks)).toEqual({ clean: 3, dirty: 1, owned: 4, wears: 1 });
    const changed = await tell("wear.record", { wearingDate: j.day(0), garmentIds: [g.socks], additionalUnits: [{ garmentId: g.socks, quantity: 1 }] });
    expect(changed.outcome).toBe("committed");
    expect(changed.result).toMatchObject({ counted: [], merged: [g.socks], additionalUnitEvents: 1 });
    expect(await pairs(g.socks)).toEqual({ clean: 2, dirty: 2, owned: 4, wears: 1 });
    // The same change of socks, reported again, is the same change.
    const repeated = await tell("wear.record", { wearingDate: j.day(0), garmentIds: [g.socks], additionalUnits: [{ garmentId: g.socks, quantity: 1 }] });
    expect(repeated.outcome).toBe("merged");
    expect(repeated.result).toMatchObject({ additionalUnitEvents: 0, additionalUnitsAlreadyRecorded: 1 });
    expect(await pairs(g.socks)).toEqual({ clean: 2, dirty: 2, owned: 4, wears: 1 });

    // He owns one pair of these; a report that claims three pairs were used cannot invent two.
    const impossible = await tell("wear.record", { wearingDate: j.day(0), garmentIds: [g.singleSocks], additionalUnits: [{ garmentId: g.singleSocks, quantity: 2 }] });
    expect(impossible.outcome).toBe("committed");
    expect(await pairs(g.singleSocks)).toEqual({ clean: 0, dirty: 1, owned: 1, wears: 1 });
    // And wearing a piece with no clean unit left never drives the count below zero.
    const worn = await tell("wear.record", { wearingDate: j.day(-1), garmentIds: [g.morningShirt] }, { occurredAt: new Date().toISOString() });
    expect(worn.outcome).toBe("committed");
    expect((await item(g.morningShirt)).detail.balances).toEqual(DIRTY());
    await ledgerIsSound(149);
  });

  it("an amendment replaces only the fact it corrects: the wrong shirt is uncounted and clean again, the right one is counted, the rest of the day stands, and every revision is kept", async () => {
    const logged = await tell("wear.record", { wearingDate: j.day(0), garmentIds: [g.wrongShirt] });
    expect((await item(g.wrongShirt)).detail.balances).toEqual(DIRTY());
    const before = await dayRecord(j.day(0));
    const others = (record: any) => record.garments.filter((entry: any) => ![g.wrongShirt, g.rightShirt].includes(entry.garmentId));

    const receipt = await tell("wear.amend", { wearingDate: j.day(0), remove: [g.wrongShirt], add: [g.rightShirt], reason: "it was the light blue one" });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toBe(`Corrected ${j.day(0)}: removed Clark oxford — evergreen; added Cotton-linen oxford — Portuguese light blue`);
    expect(receipt.result).toMatchObject({ removed: [g.wrongShirt], counted: [g.rightShirt], merged: [] });

    const wrong = (await item(g.wrongShirt)).detail;
    expect(wrong.balances).toEqual(CLEAN());
    expect(wrong.recordedWearCount).toBe(0);
    expect(wrong.lastRecordedWear).toBeNull();
    const right = (await item(g.rightShirt)).detail;
    expect(right.balances).toEqual(DIRTY());
    expect(right.recordedWearCount).toBe(1);
    expect(right.lastRecordedWear).toBe(j.day(0));
    const after = await dayRecord(j.day(0));
    expect(others(after)).toEqual(others(before));
    expect(after.garments.map((entry: any) => entry.garmentId)).not.toContain(g.wrongShirt);
    // The earlier shirts' genuine wears are not erased by correcting a third.
    for (const id of [g.morningShirt, g.eveningShirt]) expect(after.garments.map((entry: any) => entry.garmentId)).toContain(id);

    // Nothing was deleted: the withdrawn report, the first receipt and the correction are all still on record.
    expect(after.observations.filter((o: any) => o.garmentId === g.wrongShirt).map((o: any) => o.status)).toEqual(["retracted"]);
    expect(after.observations.filter((o: any) => o.garmentId === g.rightShirt).map((o: any) => o.status)).toEqual(["active"]);
    expect((await owner.api.json("GET", `/v1/commands/${logged.commandId}`)).summary).toBe(logged.summary);
    const history = (await owner.api.json("GET", `/v1/commands?garmentId=${g.wrongShirt}`)).receipts.map((r: any) => r.type);
    expect(history).toEqual(expect.arrayContaining(["wear.record", "wear.amend"]));
    expect(receipt.undo).toMatchObject({ available: false, reason: expect.stringMatching(/amend again to restore the earlier record; every revision is kept/) });
  });

  it("an amendment after a laundry pickup keeps the pickup on record and does not put the shirt he actually wore into a bag it never entered", async () => {
    await tell("wear.record", { wearingDate: j.day(-3), garmentIds: [s.neverWorn, s.inTheBag] });
    const pickup = await tell("laundry.collect", { exclude: [s.notWashed, g.lateTrousers, g.washedShirt] }, { occurredAt: `${j.day(-2)}T09:00:00.000Z` });
    pickedUpBatch = pickup.result.batchId;
    expect(sorted(pickup.result.members.map((m: any) => m.garmentId))).toEqual(sorted([s.neverWorn, s.inTheBag]));

    const receipt = await tell("wear.amend", { wearingDate: j.day(-3), remove: [s.neverWorn], add: [s.actuallyWorn], reason: "it was the other shirt" });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.repairs).toHaveLength(1);
    expect(receipt.repairs[0]).toMatch(/a later laundry pickup is preserved/);
    expect(receipt.repairs[0]).toMatch(/it was not in the bag/);

    // The historical pickup is still there, with its time and the shirt that really went.
    const batch = (await laundry()).batches.find((b: any) => b.batchId === pickedUpBatch);
    expect(batch).toMatchObject({ status: "collected", pickedUpAt: `${j.day(-2)}T09:00:00.000Z`, returnedAt: null });
    expect(batch.items.map((i: any) => i.garmentId)).toContain(s.inTheBag);
    expect(batch.items.map((i: any) => i.garmentId)).not.toContain(s.actuallyWorn);
    expect((await item(s.inTheBag)).detail.balances).toEqual([{ bucket: "service", ref: pickedUpBatch, quantity: 1 }]);
    // The shirt he actually wore was at home when the bag left: it is awaiting the laundry, not away.
    const actual = (await item(s.actuallyWorn)).detail;
    expect(actual.balances).toEqual(DIRTY());
    expect(actual.recordedWearCount).toBe(1);
    expect(actual.lastRecordedWear).toBe(j.day(-3));
    expect((await laundry()).awaitingService.map((i: any) => i.garmentId)).toContain(s.actuallyWorn);
    // The shirt logged by mistake was never worn, so it is clean at home and uncounted.
    const mistaken = (await item(s.neverWorn)).detail;
    expect(mistaken.balances).toEqual(CLEAN());
    expect(mistaken.recordedWearCount).toBe(0);
    await ledgerIsSound(149);
  });

  it("when that bag comes back, the return counts the one shirt that was in it, not the shirt the amendment took out", async () => {
    // Section 8, Repair after reality changes: "If a later laundry pickup has already happened, correction
    // preserves that historical pickup and computes an explicit adjustment". Section 5: "A return completes
    // only the contents of the returning batch". The amendment's own receipt says the batch is adjusted
    // because the shirt "was not in the bag". Was defect D04-2 (the return counted two); fixed by the
    // foundation in a5e6c8fa.
    const receipt = await tell("laundry.return", { batchId: pickedUpBatch });
    expect((await item(s.inTheBag)).detail.balances).toEqual(CLEAN());
    expect(receipt.result.returned).toBe(1);
    expect(receipt.summary).toBe("Laundry returned: 1 item clean");
  });

  it("a wear of a welted shoe under the sneakers-only restriction is recorded as said, and the restriction stays exactly as it was", async () => {
    const before = await item(g.welted);
    expect(before.availability).toMatchObject({ hardExcluded: true, reasons: ["restricted"] });
    const response = await owner.api.command("wear.record", { wearingDate: j.day(0), garmentIds: [g.welted] });
    expect(response.status).toBe(200);
    const receipt = heard((await response.json()) as Receipt);
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toBe("Recorded for today: Paraboot Michael Cerf");
    expect(receipt.repairs).toHaveLength(1);
    expect(receipt.repairs[0]).toMatch(/^Paraboot Michael Cerf: worn while restricted \(Sneakers only until the owner says his feet have healed/);
    expect(receipt.repairs[0]).toMatch(/the wear is recorded and the restriction is unchanged$/);

    const after = await item(g.welted);
    expect(after.detail.recordedWearCount).toBe(1);
    expect(after.detail.lastRecordedWear).toBe(j.day(0));
    // Recording what happened lifts nothing: only the owner saying his feet have healed does.
    expect(after.availability).toMatchObject({ status: "unavailable", hardExcluded: true, reasons: ["restricted"] });
    expect(after.detail.restrictions).toHaveLength(1);
    expect(after.detail.restrictions[0]).toMatchObject({ status: "active", resolvedAt: null, requiredEvidence: "owner_statement" });
    expect(after.detail.restrictions[0]).toEqual(before.detail.restrictions[0]);
    const footwear = (await wholeWardrobe(owner.api)).items.filter((i) => i.garment.category === "footwear");
    expect(footwear.filter((i) => i.availability!.reasons.includes("restricted"))).toHaveLength(4);
  });

  it("undoing a wear report restores the stock, the count and the day's record exactly", async () => {
    const pieces = [g.undoneShirt, g.undoneSocks];
    const snapshot = async () => {
      const out: Record<string, unknown> = {};
      for (const id of pieces) {
        const { detail, availability } = await item(id);
        out[id] = { balances: detail.balances, count: detail.recordedWearCount, last: detail.lastRecordedWear, activeWears: detail.recentWears.filter((w: any) => w.status === "active"), status: availability.status, pAvailable: availability.pAvailable };
      }
      const record = await dayRecord(j.day(0));
      const handwash = (await laundry()).awaitingHandwash;
      return { out, garments: record.garments, handwash };
    };
    const before = await snapshot();
    const receipt = await tell("wear.record", { wearingDate: j.day(0), garmentIds: pieces });
    expect((await item(g.undoneShirt)).detail.balances).toEqual(DIRTY());
    expect(quantityIn((await item(g.undoneSocks)).detail, "clean")).toBe(2);

    const undone = await tell("command.undo", { commandId: receipt.commandId });
    expect(undone.outcome).toBe("committed");
    expect(undone.summary).toMatch(/^Undone: Recorded for today: Cotton-linen oxford — blue stripe, Merino — correct grey\./);
    expect(undone.summary).toMatch(/2 counted wears withdrawn/);
    expect(await snapshot()).toEqual(before);
    // The report itself is kept as a withdrawn source, and its receipt is still readable.
    const reports = (await dayRecord(j.day(0))).observations.filter((o: any) => pieces.includes(o.garmentId));
    expect(reports.map((o: any) => o.status)).toEqual(["retracted", "retracted"]);
    expect((await owner.api.json("GET", `/v1/commands/${receipt.commandId}`)).commandId).toBe(receipt.commandId);
  });

  it("wear counts and last-worn dates follow what he said; nothing was asked, nothing leaked to another owner, and every unit is accounted for", async () => {
    const expected: [string, number, string | null][] = [
      [g.morningShirt, 2, j.day(0)], // this morning, and yesterday as reported later
      [g.eveningShirt, 1, j.day(0)],
      [g.trousers, 1, j.day(0)],
      [g.racedTrousers, 1, j.day(0)],
      [g.socks, 1, j.day(0)],
      [g.sneakers, 1, j.day(0)],
      [g.washedShirt, 1, j.day(-1)],
      [g.lateTrousers, 1, j.day(-1)],
      [g.wrongShirt, 0, null],
      [g.rightShirt, 1, j.day(0)],
      [g.undoneShirt, 0, null],
      [g.welted, 1, j.day(0)],
    ];
    const listed = (await wholeWardrobe(owner.api)).items;
    for (const [id, count, last] of expected) {
      const { detail } = await item(id);
      expect(detail.recordedWearCount, detail.garment.name).toBe(count);
      expect(detail.lastRecordedWear, detail.garment.name).toBe(last);
      const row = listed.find((i) => i.garment.garmentId === id)!;
      expect(row.recordedWearCount).toBe(count);
      expect(row.lastRecordedWear).toBe(last);
    }

    for (const text of said) {
      expect(text, text).not.toContain("?");
      expect(internalCodesIn(text), text).toEqual([]);
    }
    const proposals = await owner.api.json("GET", "/v1/proposals");
    expect(proposals.pending).toBe(0);
    expect(proposals.proposals).toEqual([]);
    expect((await owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput).toBe(0);

    expect((await stranger.api.json("GET", `/v1/days/${j.day(0)}`)).garments).toEqual([]);
    expect((await stranger.api.get(`/v1/items/${g.trousers}`)).status).toBe(404);
    expect((await stranger.api.command("wear.record", { wearingDate: j.day(0), garmentIds: [g.trousers] })).status).toBe(404);
    await ledgerIsSound(149); // the owner's 144 units and the five synthetic shirts
  });
});
