/**
 * Regressions for defects the adversarial suite found in the ledger and the profile rules
 * (tests/adversarial/defects/ledger.md and profile.md: L03-3, L04-1, L04-2, L04-3, L04-6, L13-1, L13-2,
 * P07-1 to P07-6). Real command service, local D1. The what-if edits on the owner's real data are made on
 * a throwaway copy inside the test database; none is the owner's statement.
 * September 2026: Mon 14, Tue 15, Wed 16, Thu 17.
 */
import { describe, expect, it } from "vitest";
import { all, first, getAvailability, getLaundryState, getStyleContext, listRestrictions } from "../src/index.ts";
import { HEALING_RESTRICTION_ID } from "../src/import/index.ts";
import { createHarness, ownerDocuments, type Harness, type TestOwner } from "../src/testing/index.ts";
import { balances, countedWears } from "./helpers.ts";

async function start(): Promise<{ h: Harness; owner: TestOwner }> {
  const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
  return { h, owner: await h.createSyntheticOwner() };
}

const refusal = (p: Promise<unknown>) => p.then(() => ({ code: "committed", message: "", details: {} as Record<string, unknown> }), (e) => e as { code: string; message: string; details: Record<string, unknown> });

const TRIP = "trp_0123456789abcdef0123";
const tripUnits = async (h: Harness, owner: TestOwner, garmentId: string) => {
  const rows = await all<{ ref: string; quantity: number }>(h.db, "SELECT ref, quantity FROM stock_balances WHERE user_id = ? AND garment_id = ? AND bucket = 'trip'", owner.userId, garmentId);
  return { clean: rows.filter((r) => !r.ref.endsWith("#dirty")).reduce((n, r) => n + r.quantity, 0), worn: rows.filter((r) => r.ref.endsWith("#dirty")).reduce((n, r) => n + r.quantity, 0) };
};

describe("L13-1 / L13-2: packing", () => {
  it("a trip its workstream does not vouch for is refused and nothing leaves home; a vouched trip packs", async () => {
    const { h, owner } = await start();
    const asked: string[] = [];
    h.registry.registerEntityCheck("trip", async (_db, userId, id) => (asked.push(`${userId}:${id}`), id === TRIP ? { ok: true } : { ok: false, reason: "that trip is not one of your planned trips" }));
    const refused = await refusal(owner.exec("stock.pack", { tripId: "trp_synthetic_no_such_trip", items: [{ garmentId: "shirt-moss" }] }));
    expect(refused.code).toBe("precondition_failed");
    expect(refused.message).toContain("that trip is not one of your planned trips");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, trip: 0 });
    expect((await owner.exec("stock.pack", { tripId: TRIP, items: [{ garmentId: "shirt-moss" }] })).outcome).toBe("committed");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, trip: 1 });
    // Only this owner's trip is asked about.
    expect(asked).toEqual([`${owner.userId}:trp_synthetic_no_such_trip`, `${owner.userId}:${TRIP}`]);
  });

  it("a check that fails to answer refuses the packing instead of letting it through", async () => {
    const { h, owner } = await start();
    h.registry.registerEntityCheck("trip", async () => {
      throw new Error("synthetic lookup failure");
    });
    const refused = await refusal(owner.exec("stock.pack", { tripId: TRIP, items: [{ garmentId: "shirt-moss" }] }));
    expect(refused.code).toBe("precondition_failed");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 1, trip: 0 });
  });

  it("saying 'packed' again about a piece already worn in the suitcase leaves it worn", async () => {
    const { h, owner } = await start();
    await owner.exec("stock.pack", { tripId: TRIP, items: [{ garmentId: "trouser-olive" }] });
    await owner.exec("wear.record", { wearingDate: "2026-09-14", garmentIds: ["trouser-olive"], tripId: TRIP });
    expect(await tripUnits(h, owner, "trouser-olive")).toEqual({ clean: 0, worn: 1 });
    await owner.exec("stock.pack", { tripId: TRIP, items: [{ garmentId: "trouser-olive" }] }, { idempotencyKey: "synthetic-packed-again" });
    expect(await tripUnits(h, owner, "trouser-olive")).toEqual({ clean: 0, worn: 1 });
  });
});

describe("P07-1 / P07-2: a correction does not take a piece out of an active restriction", () => {
  const SCOPE = { anyOf: [{ category: "footwear", footwearKinds: ["welted", "boot", "other"] }, { models: ["990v6"] }] };
  const restricted = async (h: Harness, owner: TestOwner) =>
    (await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() })).garments.filter((g) => g.reasons.includes("restricted")).map((g) => g.garmentId).sort();

  it("changing the footwear kind or the model of a covered shoe is refused, alone or in bulk, and its undo cannot release one either", async () => {
    const { h, owner } = await start();
    // Recorded as a sneaker before any restriction; corrected to welted, which the restriction then covers.
    const toWelted = await owner.exec("garment.correct", { garmentId: "shoe-olive", changes: { attributes: { footwearKind: "welted" } }, source: { kind: "owner_statement" } });
    const added = await owner.exec("restriction.add", { kind: "healing", scope: SCOPE, reason: "SYNTHETIC healing restriction (test fixture)", source: { kind: "owner_statement" } });
    const restrictionId = added.result.restrictionId as string;
    expect(await restricted(h, owner)).toEqual(["shoe-990v6", "shoe-olive", "shoe-welted"]);

    const attempts: [string, Record<string, unknown>][] = [
      ["garment.correct", { garmentId: "shoe-welted", changes: { attributes: { footwearKind: "sneaker" } }, source: { kind: "owner_statement" } }],
      ["garment.correct", { garmentId: "shoe-990v6", changes: { attributes: { model: "990v4" } }, source: { kind: "owner_statement" } }],
      ["garment.bulk_correct", { selector: { category: "footwear" }, changes: { attributes: { footwearKind: "sneaker", model: "990v4" } }, source: { kind: "owner_statement" } }],
      ["command.undo", { commandId: toWelted.commandId }],
    ];
    for (const [type, payload] of attempts) {
      const refused = await refusal(owner.exec(type, payload));
      expect(refused.code, type).toBe("forbidden");
      expect(refused.details, type).toMatchObject({ reason: "correction_would_release_restriction", restrictionId });
    }
    expect(await restricted(h, owner)).toEqual(["shoe-990v6", "shoe-olive", "shoe-welted"]);

    // A correction that leaves the shoe covered goes through, and once the owner has ended the restriction
    // in the app the same correction is an ordinary one.
    expect((await owner.exec("garment.correct", { garmentId: "shoe-welted", changes: { colour: "Dark brown" }, source: { kind: "owner_statement" } })).outcome).toBe("committed");
    await owner.exec("restriction.resolve", { restrictionId, evidence: { kind: "owner_statement" } });
    expect((await owner.exec("garment.correct", { garmentId: "shoe-welted", changes: { attributes: { footwearKind: "sneaker" } }, source: { kind: "owner_statement" } })).outcome).toBe("committed");
  });
});

describe("P07-3 / P07-4 / P07-5 / P07-6: the rule that carries the active restriction, and quoted passages", () => {
  const KEY = "footwear.sneakers_only_until_healed";
  const ruleOf = async (h: Harness, owner: TestOwner) => (await getStyleContext(h.db, owner.principal())).rules.find((r) => r.key === KEY)!;

  it("is not widened, softened or retired by style.upsert_rule, by a profile-save decision, or by undoing its import", async () => {
    const h = await createHarness();
    const { owner } = await h.createRealOwner();
    const rule = await ruleOf(h, owner);
    const widened = { ...rule.params, allowedFootwearKinds: ["sneaker", "welted", "boot", "other", ""], excludedModels: [] };
    expect(widened).not.toEqual(rule.params);

    // P07-4: same status and restriction, but soft, or with wider parameters.
    for (const change of [{ kind: "soft", params: rule.params }, { kind: "hard", params: widened }]) {
      const refused = await refusal(owner.exec("style.upsert_rule", { key: KEY, status: "active", interpretation: "synthetic attempt", origin: "owner_direction", ...change }));
      expect(refused.code).toBe("forbidden");
      expect(refused.details).toMatchObject({ reason: "rule_carries_active_restriction", restrictionId: HEALING_RESTRICTION_ID });
    }

    // P07-3: the passage reworded in the profile text, with a decision that replaces the rule's parameters.
    const profile = ownerDocuments().profileText;
    const marker = "**Sneakers only, until he says his feet have healed.**";
    const edited = profile.replace(marker, "**Sneakers only, until he says his feet have healed (synthetic rewording).**");
    expect(edited).not.toBe(profile);
    const version = (await getStyleContext(h.db, owner.principal())).document.version;
    const save = await refusal(
      owner.exec(
        "style.save_document",
        { content: edited, source: { kind: "owner_statement" }, factResolutions: [{ fact: { kind: "rule", id: KEY }, resolution: { action: "replace", rule: { params: widened } } }] },
        { expectedVersions: { "style_document:owner-profile": version } },
      ),
    );
    expect(save.code).toBe("forbidden");
    expect(save.details).toMatchObject({ reason: "rule_carries_active_restriction", restrictionId: HEALING_RESTRICTION_ID });
    expect((await getStyleContext(h.db, owner.principal())).document.version).toBe(version);

    // P07-5: undoing the command that recorded the rule.
    const imported = await first<{ command_id: string }>(h.db, "SELECT command_id FROM commands WHERE user_id = ? AND type = 'style.upsert_rule' AND payload_json LIKE ?", owner.userId, `%${KEY}%`);
    const undo = await refusal(owner.exec("command.undo", { commandId: imported!.command_id }));
    expect(undo.code).toBe("forbidden");
    expect(undo.details).toMatchObject({ reason: "rule_carries_active_restriction", restrictionId: HEALING_RESTRICTION_ID });

    expect(await ruleOf(h, owner)).toMatchObject({ status: "active", kind: "hard", version: 1, params: rule.params });
    expect((await listRestrictions(h.db, owner.principal(), { status: "active" })).map((r) => r.restrictionId)).toEqual([HEALING_RESTRICTION_ID]);
  });

  it("a measurement or a size note that cites the profile must quote it: an invented quotation is refused", async () => {
    const h = await createHarness();
    const { owner } = await h.createRealOwner();
    const before = await getStyleContext(h.db, owner.principal());
    const chest = before.measurements.find((m) => m.key === "chest")!;
    const invented = { documentSha256: before.document.contentSha256, lineStart: 1, lineEnd: 1, quote: "SYNTHETIC sentence that the profile does not contain (test fixture)." };
    const measurement = await refusal(owner.exec("measurement.record", { subject: "body", key: "chest", value: chest.value + 1, unit: chest.unit, source: { kind: "profile_passage" }, passage: invented }));
    expect(measurement.code).toBe("precondition_failed");
    expect(measurement.details).toMatchObject({ reason: "passage_not_in_document" });
    const size = await refusal(owner.exec("size_experience.record", { maker: "SYNTHETIC maker", sizeLabel: "46", passage: invented }));
    expect(size.code).toBe("precondition_failed");
    const after = await getStyleContext(h.db, owner.principal());
    expect(after.measurements.find((m) => m.key === "chest")).toMatchObject({ value: chest.value });
    expect(after.sizeExperiences.length).toBe(before.sizeExperiences.length);
  });
});

describe("L03-3: the same laundry return said twice", () => {
  it("the second report changes nothing: a piece put in the hamper after the pickup stays there", async () => {
    const { h, owner } = await start();
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-gold" }] });
    h.clock.set("2026-09-15T09:00:00Z");
    await owner.exec("laundry.collect", {});
    h.clock.set("2026-09-16T09:00:00Z");
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] });
    h.clock.set("2026-09-17T17:00:00Z");
    const back = await owner.exec("laundry.return", {});
    expect(back.result).toMatchObject({ returned: 1 });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, dirty: 1 });
    // Another device, another key, the same statement.
    const again = await owner.exec("laundry.return", {}, { idempotencyKey: "synthetic-second-device-return" });
    expect(again.outcome).toBe("noop");
    expect(again.summary).toBe("That laundry is already recorded as back; anything put in the hamper since the pickup is still awaiting the service");
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, dirty: 0, service: 0 });
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ clean: 0, dirty: 1 });
  });
});

describe("L04-1 / L04-6: a wear and its date", () => {
  it("a wear whose stated time lies long before its wearing date is refused and nothing is recorded", async () => {
    const { h, owner } = await start();
    const refused = await refusal(owner.exec("wear.record", { wearingDate: "2026-09-14", garmentIds: ["shirt-gold"] }, { occurredAt: "1970-01-01T00:00:00Z" }));
    expect(refused.code).toBe("invalid_command");
    expect(await countedWears(h, owner, "shirt-gold")).toEqual([]);
    // A report made late the same evening, or the next morning, is still accepted.
    h.clock.set("2026-09-15T07:00:00Z");
    const late = await owner.exec("wear.record", { wearingDate: "2026-09-14", garmentIds: ["shirt-gold"] }, { occurredAt: "2026-09-14T21:00:00Z" });
    expect(late.outcome).toBe("committed");
  });

  it("wear.amend adds no wear for a day that has not come, and a far-future date is refused as invalid input", async () => {
    const { h, owner } = await start();
    for (const wearingDate of ["2026-09-15", "9999-12-31"]) {
      const refused = await refusal(owner.exec("wear.amend", { wearingDate, remove: [], add: ["shirt-gold"], reason: "synthetic correction" }));
      expect(refused.code, wearingDate).toBe("invalid_command");
    }
    expect(await countedWears(h, owner, "shirt-gold")).toEqual([]);
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, dirty: 0 });
  });
});

describe("L04-2 / L04-3: a laundry return and its time", () => {
  it("a return dated before the bag was collected is refused: the batch stays out with its piece", async () => {
    const { h, owner } = await start();
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-gold" }] });
    h.clock.set("2026-09-15T09:00:00Z");
    await owner.exec("laundry.collect", {});
    const refused = await refusal(owner.exec("laundry.return", {}, { occurredAt: "2026-09-14T12:00:00Z" }));
    expect(refused.code).toBe("invalid_command");
    expect((await getLaundryState(h.db, owner.principal())).batches[0]!.status).toBe("collected");
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, service: 1 });
  });

  it("with no bag out, a return dated before the piece went into the hamper claims nothing", async () => {
    const { h, owner } = await start();
    h.clock.set("2026-09-14T12:00:00Z");
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-gold" }] });
    const early = await owner.exec("laundry.return", {}, { occurredAt: "2026-09-14T10:00:00Z" });
    expect(early.outcome).toBe("noop");
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 0, dirty: 1 });
    // Said for now, it is the owner's word: the piece is clean and the receipt counts exactly that.
    const now = await owner.exec("laundry.return", {}, { idempotencyKey: "synthetic-return-now" });
    expect(now.result).toMatchObject({ returned: 1 });
    expect(await balances(h, owner, "shirt-gold")).toMatchObject({ clean: 1, dirty: 0 });
  });
});
