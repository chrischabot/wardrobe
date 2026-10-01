import { describe, expect, it } from "vitest";
import { all, exposureOutcomes, getAvailability, getJointAvailability, jointAvailability, learnedBoardUsePrior, listInventory, selectionProbability, type EstimatorInput } from "../src/index.ts";
import { createHarness, type Harness, type TestOwner } from "../src/testing/index.ts";
import { balances, SCHEDULED } from "./helpers.ts";

const find = (snapshot: Awaited<ReturnType<typeof getAvailability>>, id: string) => snapshot.garments.find((g) => g.garmentId === id)!;

async function publishBoard(h: Harness, owner: TestOwner, date: string, options: { optionId: string; garmentIds: string[]; alternativeGroups?: string[][] }[], pUse?: number) {
  return owner.exec("exposure.publish", { localDate: date, sourceKind: "board", sourceRef: `board:${date}:r1`, options, ...(pUse !== undefined ? { pUse } : {}) }, SCHEDULED);
}

describe("availability: hard facts versus estimates", () => {
  it("dirty, incoming, restricted, excluded, stored and disposed pieces are hard exclusions; occasional is conditional", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] });
    await owner.exec("restriction.add", { kind: "healing", scope: { anyOf: [{ category: "footwear", footwearKinds: ["welted", "boot", "other"] }, { models: ["990v6"] }] }, reason: "sneakers only until healed", source: { kind: "owner_statement" } });
    await owner.exec("garment.set_planning_policy", { garmentId: "shirt-slate", policy: "excluded", reason: "benched" });
    await owner.exec("garment.set_planning_policy", { garmentId: "jacket-academic", policy: "occasional" });
    await owner.exec("garment.move", { garmentId: "trouser-beige", to: "storage" });
    await owner.exec("garment.retire", { garmentId: "shirt-blue-stripe-b", disposition: "sold" });

    const s = await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() });
    expect(find(s, "shirt-moss")).toMatchObject({ status: "unavailable", hardExcluded: true, pAvailable: 0 });
    expect(find(s, "shirt-moss").reasons).toEqual(expect.arrayContaining(["no_units_at_home", "observed_dirty"]));
    expect(find(s, "shirt-ordered").reasons).toContain("not_owned_yet"); // an order is not an arrival
    expect(find(s, "shoe-welted").reasons).toContain("restricted");
    expect(find(s, "shoe-990v6").reasons).toContain("restricted");
    expect(find(s, "shoe-navy")).toMatchObject({ status: "available", hardExcluded: false, pAvailable: 1 });
    expect(find(s, "shirt-slate").reasons).toContain("planning_excluded");
    expect(find(s, "trouser-beige").reasons).toContain("in_storage");
    expect(find(s, "shirt-blue-stripe-b").reasons).toContain("disposed");
    expect(find(s, "jacket-academic")).toMatchObject({ status: "conditional", hardExcluded: false });
    expect(s.parameters.parameterStatus).toBe("hypothesis");

    const page = await listInventory(h.db, owner.principal(), {}, { nowMs: h.clock.now() });
    expect(page.complete).toBe(true);
    expect(page.counts).toMatchObject({ incoming: 1, retired: 1 });
    expect(page.items.some((i) => i.garment.garmentId === "shirt-blue-stripe-b")).toBe(false); // retired items are counted, not listed by default

    // Arrival is a separate observed fact.
    await owner.exec("garment.receive", { garmentId: "shirt-ordered" });
    const after = await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() });
    expect(find(after, "shirt-ordered")).toMatchObject({ status: "available", acquisition: "owned" });
  });

  it("pagination states total and completeness explicitly", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const first = await listInventory(h.db, owner.principal(), { limit: 5 }, { nowMs: h.clock.now() });
    expect(first.items).toHaveLength(5);
    expect(first.complete).toBe(false);
    expect(first.total).toBe(19);
    const ids = new Set<string>();
    let cursor: string | null = "0";
    while (cursor !== null) {
      const page = await listInventory(h.db, owner.principal(), { limit: 5, cursor }, { nowMs: h.clock.now() });
      page.items.forEach((i) => ids.add(i.garment.garmentId));
      cursor = page.nextCursor;
    }
    expect(ids.size).toBe(19);
  });
});

describe("availability: probability without status interrogation", () => {
  it("shared trousers on a five-option board: mutually exclusive options are summed, not charged per option", async () => {
    const h = await createHarness({ startAt: "2026-09-15T20:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await publishBoard(
      h,
      owner,
      "2026-09-15",
      [
        { optionId: "o1", garmentIds: ["shirt-moss", "trouser-navy"] },
        { optionId: "o2", garmentIds: ["shirt-gold", "trouser-navy"] },
        { optionId: "o3", garmentIds: ["shirt-slate", "trouser-navy"] },
        { optionId: "o4", garmentIds: ["shirt-red-stripe", "trouser-olive"] },
        { optionId: "o5", garmentIds: ["shirt-blue-stripe-a", "trouser-beige"] },
      ],
      1.0,
    );
    const s = await getAvailability(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now() });
    const navy = find(s, "trouser-navy");
    expect(navy.inferredWear).toHaveLength(1);
    expect(navy.inferredWear[0]!.probability).toBeCloseTo(0.6, 10);
    expect(navy.pAvailable).toBe(1); // two pairs: one possible unreported wear cannot exhaust them
    expect(navy.hardExcluded).toBe(false);
    expect(find(s, "shirt-moss").pAvailable).toBeCloseTo(0.8, 10);
    expect(find(s, "shirt-moss").status).toBe("estimated");
    // Nothing was recorded as worn, reserved or moved.
    expect(await all(h.db, "SELECT 1 FROM wear_observations WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect(await all(h.db, "SELECT 1 FROM daily_wears WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect((await balances(h, owner, "trouser-navy")).clean).toBe(2);
  });

  it("a week without any confirmation leaves every piece offerable, and the weekly baseline clears the uncertainty", async () => {
    const h = await createHarness({ startAt: "2026-09-13T20:00:00Z" });
    const owner = await h.createSyntheticOwner();
    const board = [
      { optionId: "a", garmentIds: ["shirt-moss", "trouser-olive", "sock-navy"] },
      { optionId: "b", garmentIds: ["shirt-gold", "trouser-beige", "sock-grey"] },
      { optionId: "c", garmentIds: ["shirt-slate", "trouser-navy", "sock-grey"] },
    ];
    for (const date of ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17"]) {
      h.clock.set(`${date}T05:50:00Z`);
      await publishBoard(h, owner, date, board);
    }
    h.clock.set("2026-09-17T21:00:00Z");
    const thursdayNight = await getAvailability(h.db, owner.principal(), { forDate: "2026-09-18", nowMs: h.clock.now() });
    const moss = find(thursdayNight, "shirt-moss");
    // Four unreported days at 0.85 / 3 each: P(never worn) = (1 - 0.85/3)^4.
    expect(moss.pAvailable).toBeCloseTo(Math.pow(1 - 0.85 / 3, 4), 10);
    expect(moss.status).toBe("estimated");
    expect(thursdayNight.garments.filter((g) => board.some((o) => o.garmentIds.includes(g.garmentId))).every((g) => !g.hardExcluded)).toBe(true);
    // No task, question or confirmed wear exists anywhere in the ledger.
    expect(await all(h.db, "SELECT 1 FROM wear_observations WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect(await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type NOT IN ('garment.create', 'exposure.publish')", owner.userId)).toHaveLength(0);

    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    const sunday = await getAvailability(h.db, owner.principal(), { forDate: "2026-09-21", nowMs: h.clock.now() });
    expect(sunday.lastBaseline).toMatchObject({ cycleKey: "2026-09-20" });
    expect(find(sunday, "shirt-moss")).toMatchObject({ pAvailable: 1, status: "available" });
  });

  it("a selection raises the chosen option's probability; an explicit wear replaces the uncertainty with an observation", async () => {
    const h = await createHarness({ startAt: "2026-09-15T06:00:00Z" });
    const owner = await h.createSyntheticOwner();
    const published = await publishBoard(h, owner, "2026-09-15", [
      { optionId: "a", garmentIds: ["shirt-moss", "trouser-olive"], alternativeGroups: [["shoe-navy", "shoe-olive"]] },
      { optionId: "b", garmentIds: ["shirt-gold", "trouser-beige"] },
    ]);
    const exposureId = published.result.exposureId as string;
    const before = await getAvailability(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now() });
    expect(find(before, "shirt-moss").inferredWear[0]!.probability).toBeCloseTo(0.425, 10);

    const chosen = await owner.exec("exposure.select", { exposureId, optionId: "a", chosenAlternatives: ["shoe-olive"] });
    expect(chosen.summary).toContain("not a recorded wear");
    const selected = await getAvailability(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now() });
    expect(find(selected, "shirt-moss").inferredWear[0]!.probability).toBeCloseTo(0.9, 10);
    expect(find(selected, "shirt-gold").inferredWear).toEqual([]);
    expect(await all(h.db, "SELECT 1 FROM daily_wears WHERE user_id = ?", owner.userId)).toHaveLength(0); // Choose is not a wear

    // He actually wore the other outfit: the observation settles the day.
    await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-gold", "trouser-beige"] });
    const observed = await getAvailability(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now() });
    expect(find(observed, "shirt-moss")).toMatchObject({ pAvailable: 1, inferredWear: [] });
    expect(find(observed, "shirt-gold")).toMatchObject({ hardExcluded: true, pAvailable: 0 });
    // Undoing the selection before/after has its own receipt; selecting from a resolved set is refused.
    const late = await owner.exec("exposure.select", { exposureId, optionId: "b" }).catch((e) => e);
    expect(late.code).toBe("precondition_failed");
  });

  it("joint availability accounts for garments offered together instead of multiplying them as independent", async () => {
    const h = await createHarness({ startAt: "2026-09-15T06:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await publishBoard(h, owner, "2026-09-15", [
      { optionId: "a", garmentIds: ["shirt-moss", "trouser-olive"] },
      { optionId: "b", garmentIds: ["shirt-gold", "trouser-beige"] },
    ], 1.0);
    const opts = { forDate: "2026-09-16", nowMs: h.clock.now() };
    const same = await getJointAvailability(h.db, owner.principal(), ["shirt-moss", "trouser-olive"], opts);
    expect(same.pAllAvailable).toBeCloseTo(0.5, 10); // worn together or not at all (independent would be 0.25)
    const across = await getJointAvailability(h.db, owner.principal(), ["shirt-moss", "trouser-beige"], opts);
    expect(across.pAllAvailable).toBeCloseTo(0, 10); // exactly one of the two options was worn
    const withRestricted = await getJointAvailability(h.db, owner.principal(), ["shirt-moss", "shirt-ordered"], opts);
    expect(withRestricted).toMatchObject({ pAllAvailable: 0, hardExcluded: ["shirt-ordered"] });
  });
});

describe("estimator (pure)", () => {
  const params = { pUseBoard: 0.9, pFollowSelection: 0.9, importCleanPrior: 0.8 };
  const set = {
    exposureId: "e",
    localDate: "2026-09-15",
    pUse: null,
    selectedOptionId: null,
    chosenAlternatives: [],
    options: [
      { optionId: "a", garmentIds: ["s1", "t1"], alternativeGroups: [["f1", "f2"]] },
      { optionId: "b", garmentIds: ["s2", "t1"], alternativeGroups: [] },
      { optionId: "c", garmentIds: ["s3", "t2"], alternativeGroups: [] },
    ],
  };

  it("option priors are pUse/N, footwear alternatives share their option's probability, and outcomes never exceed pUse", () => {
    expect(selectionProbability(set, "s1", params)).toBeCloseTo(0.3, 10);
    expect(selectionProbability(set, "t1", params)).toBeCloseTo(0.6, 10);
    expect(selectionProbability(set, "f1", params)).toBeCloseTo(0.15, 10);
    expect(exposureOutcomes(set, params).reduce((n, o) => n + o.probability, 0)).toBeCloseTo(0.9, 10);
  });

  it("uses quantities: P(a clean unit remains) is P(unreported wears < clean units), and imported cleanliness is a prior", () => {
    const garment = (id: string, clean: number, unverified = false) => ({
      garmentId: id, category: "shirt", careChannel: "service" as const, acquisition: "owned" as const, planningPolicy: "normal" as const, merged: false, attributes: {},
      balances: [{ bucket: "clean" as const, ref: "", quantity: clean, held: false }], importCleanlinessUnverified: unverified,
    });
    const input: EstimatorInput = {
      forDate: "2026-09-17",
      params,
      garments: [garment("t1", 2), garment("s1", 1), garment("s9", 1, true)],
      restrictions: [],
      exposures: [set, { ...set, exposureId: "e2", localDate: "2026-09-16" }],
    };
    // t1 has two units and a 0.6 chance on each of two days: unavailable only if worn both days.
    expect(jointAvailability(input, ["t1"]).pAllAvailable).toBeCloseTo(1 - 0.36, 10);
    expect(jointAvailability(input, ["s1"]).pAllAvailable).toBeCloseTo(0.49, 10);
    expect(jointAvailability(input, ["s9"]).pAllAvailable).toBeCloseTo(0.8, 10);
    // A cutoff (the last laundry baseline) drops earlier days.
    expect(jointAvailability({ ...input, cutoffDateByChannel: { service: "2026-09-16" } }, ["s1"]).pAllAvailable).toBeCloseTo(0.7, 10);
  });

  it("selection priors are learned only from observed choices", () => {
    expect(learnedBoardUsePrior(0.85, { boardsOffered: 0, boardsChosenFrom: 0 })).toBeCloseTo(0.85, 10);
    expect(learnedBoardUsePrior(0.85, { boardsOffered: 10, boardsChosenFrom: 2 })).toBeCloseTo((8.5 + 2) / 20, 10);
  });
});

describe("imported cleanliness is an estimate until a baseline or an owner report", () => {
  it("real imported shirts start estimated (not confidently clean) and become plain available after the weekly reset", async () => {
    const h = await createHarness({ startAt: "2026-09-16T09:00:00Z" });
    const { owner } = await h.createRealOwner();
    const before = await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() });
    const shirts = before.garments.filter((g) => g.reasons.includes("import_cleanliness_unverified"));
    expect(shirts.length).toBeGreaterThan(60);
    expect(shirts.every((g) => g.status !== "unavailable" || g.hardExcluded)).toBe(true);
    const oneShirt = shirts.find((g) => g.status === "estimated")!;
    expect(oneShirt.pAvailable).toBeCloseTo(0.8, 10);

    h.clock.set("2026-09-20T06:30:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, SCHEDULED);
    const after = await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() });
    expect(after.garments.find((g) => g.garmentId === oneShirt.garmentId)).toMatchObject({ status: "available", pAvailable: 1 });
    // Hand-wash socks are not touched by the service baseline: still an estimate until the owner reports a wash.
    const sock = after.garments.find((g) => g.reasons.includes("import_cleanliness_unverified"));
    expect(sock).toBeDefined();
  });
});
