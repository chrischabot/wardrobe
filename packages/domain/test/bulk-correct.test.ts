import { describe, expect, it } from "vitest";
import { BULK_CORRECT_LIMIT, getGarmentDetail, listInventory, previewGarmentSelection } from "../src/index.ts";
import { createHarness } from "../src/testing/index.ts";
import { balances } from "./helpers.ts";

const STATEMENT = { kind: "owner_statement" as const, note: "synthetic test statement" };

describe("bulk attribute edits across a category or a query (research R12)", () => {
  it("one command corrects every selected garment with per-garment provenance, skips those already as stated, and undoes as one", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const other = await h.createSyntheticOwner({ displayName: "Synthetic owner B" });
    await owner.exec("garment.correct", { garmentId: "shirt-gold", changes: { maker: "Maker A" }, source: STATEMENT });

    const selector = { category: "shirt" as const, search: "lightweight oxford" };
    const preview = await previewGarmentSelection(h.db, owner.principal(), selector);
    expect(preview.garments.map((g) => g.garmentId).sort()).toEqual(["shirt-blue-stripe-a", "shirt-gold", "shirt-moss", "shirt-red-stripe", "shirt-slate"]);

    const stale = await owner.exec("garment.bulk_correct", { selector, changes: { maker: "Maker A" }, expectedCount: 4, source: STATEMENT }).catch((e) => e);
    expect(stale.code).toBe("precondition_failed"); // the set is not the one the owner saw
    expect(stale.details.matched).toHaveLength(5);

    const receipt = await owner.exec("garment.bulk_correct", { selector, changes: { maker: "Maker A", attributes: { collar: "button-down" } }, expectedCount: preview.count, source: STATEMENT });
    expect(receipt.result).toMatchObject({ matchedCount: 5, unchangedGarmentIds: [] });
    expect((receipt.result.changedGarmentIds as string[]).sort()).toEqual(preview.garments.map((g) => g.garmentId).sort());
    expect(receipt.summary).toContain("on 5 of 5 selected garments");

    const moss = await getGarmentDetail(h.db, owner.principal(), "shirt-moss");
    expect(moss.garment).toMatchObject({ maker: "Maker A", version: 2 });
    expect(moss.garment.attributes).toMatchObject({ collar: "button-down", fabricClass: "lightweight_oxford" }); // merged, not replaced
    expect(moss.facts.filter((f) => f.attribute === "maker").map((f) => [f.source.kind, (f.value as { previous: unknown }).previous])).toEqual([["owner_statement", null]]);
    // Gold already had the maker: only its attributes changed, and no second maker fact was written.
    const gold = await getGarmentDetail(h.db, owner.principal(), "shirt-gold");
    expect(gold.facts.filter((f) => f.attribute === "maker")).toHaveLength(1);
    expect(gold.facts.filter((f) => f.attribute === "attributes")).toHaveLength(1);
    // Outside the selection, and in the other owner's wardrobe with the same IDs, nothing moved.
    expect((await getGarmentDetail(h.db, owner.principal(), "shirt-blue-stripe-b")).garment).toMatchObject({ maker: null, version: 1 });
    expect((await getGarmentDetail(h.db, other.principal(), "shirt-moss")).garment).toMatchObject({ maker: null, version: 1 });

    const again = await owner.exec("garment.bulk_correct", { selector, changes: { maker: "Maker A" }, source: STATEMENT });
    expect(again.outcome).toBe("noop");

    // A later change to one of the garments blocks the bulk undo rather than overwriting it.
    await owner.exec("garment.correct", { garmentId: "shirt-slate", changes: { colour: "Slate blue" }, source: STATEMENT });
    expect((await owner.exec("command.undo", { commandId: receipt.commandId }).catch((e) => e)).code).toBe("precondition_failed");
    expect((await getGarmentDetail(h.db, owner.principal(), "shirt-moss")).garment.maker).toBe("Maker A"); // the refused undo wrote nothing
  });

  it("undo restores every garment, including a care-channel change and its stock accounting", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "trouser-navy", quantity: 1 }] });
    const before = await balances(h, owner, "trouser-navy");

    const receipt = await owner.exec("garment.bulk_correct", { selector: { category: "trousers" }, changes: { careChannel: "handwash", fabric: "Synthetic corduroy" }, source: STATEMENT });
    expect(receipt.result.matchedCount).toBe(3);
    const inventory = await listInventory(h.db, owner.principal(), { category: "trousers" }, { nowMs: h.clock.now() });
    expect(inventory.items.map((i) => [i.garment.careChannel, i.garment.fabric])).toEqual(Array(3).fill(["handwash", "Synthetic corduroy"]));
    expect(await balances(h, owner, "trouser-navy")).toMatchObject({ clean: 1, dirty: 1 }); // units are neither created nor lost

    await owner.exec("command.undo", { commandId: receipt.commandId });
    const restored = await listInventory(h.db, owner.principal(), { category: "trousers" }, { nowMs: h.clock.now() });
    expect(restored.items.map((i) => i.garment.careChannel)).toEqual(["service", "service", "service"]);
    expect(restored.items.map((i) => i.garment.fabric)).toEqual(["Cotton twill", "Cotton twill", "Cotton twill"]);
    expect(await balances(h, owner, "trouser-navy")).toEqual(before);
  });

  it("refuses an empty selection, unknown or foreign garment IDs, an assistant acting without the owner, and never renames in bulk", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const lone = await h.createSyntheticOwner({ garments: [{ id: "only-b", name: "synthetic scarf", colour: "Red", category: "accessory", roles: ["accessory"], careChannel: "none" }] });

    expect((await owner.exec("garment.bulk_correct", { selector: { colour: "Chartreuse" }, changes: { condition: "worn" }, source: STATEMENT }).catch((e) => e)).code).toBe("not_found");
    const foreign = await owner.exec("garment.bulk_correct", { selector: { garmentIds: ["shirt-moss", "only-b"] }, changes: { condition: "worn" }, source: STATEMENT }).catch((e) => e);
    expect(foreign.code).toBe("not_found");
    expect(foreign.details.missing).toEqual(["only-b"]);
    expect((await getGarmentDetail(h.db, owner.principal(), "shirt-moss")).garment.condition).toBeNull(); // all or nothing
    expect((await getGarmentDetail(h.db, lone.principal(), "only-b")).garment.condition).toBeNull();

    expect((await owner.exec("garment.bulk_correct", { selector: {}, changes: { condition: "worn" }, source: STATEMENT }).catch((e) => e)).code).toBe("invalid_command");
    expect((await owner.exec("garment.bulk_correct", { selector: { category: "shirt" }, changes: { name: "shirt" }, source: STATEMENT }).catch((e) => e)).code).toBe("invalid_command");
    const scheduled = await owner.exec("garment.bulk_correct", { selector: { category: "shirt" }, changes: { condition: "worn" }, source: STATEMENT }, { actor: "system", channel: "scheduled", authorization: "standing_policy" }).catch((e) => e);
    expect(scheduled.code).toBe("forbidden");
    expect(BULK_CORRECT_LIMIT).toBeGreaterThanOrEqual(144); // the owner's whole wardrobe fits in one edit
  });
});

describe("garment measurements (research R45)", () => {
  it("are stored per item with their source and date, superseded without erasure, and an item without any says so", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    expect((await getGarmentDetail(h.db, owner.principal(), "jacket-academic")).measurements).toEqual([]); // missing stays visible as an empty record

    const missingGarment = await owner.exec("measurement.record", { subject: "garment", key: "half_chest", value: 58, unit: "cm", source: STATEMENT }).catch((e) => e);
    expect(missingGarment.code).toBe("invalid_command");
    const unknown = await owner.exec("measurement.record", { subject: "garment", garmentId: "jacket-nowhere", key: "half_chest", value: 58, unit: "cm", source: STATEMENT }).catch((e) => e);
    expect(unknown.code).toBe("not_found");

    const flat = { subject: "garment", garmentId: "jacket-academic", key: "half_chest", unit: "cm", convention: "flat half-chest" };
    await owner.exec("measurement.record", { ...flat, value: 58, measuredOn: "2026-08-01", source: { kind: "maker_specification", ref: "synthetic size chart" } });
    await owner.exec("measurement.record", { ...flat, value: 57.5, measuredOn: "2026-09-20", source: STATEMENT });
    await owner.exec("measurement.record", { subject: "garment", garmentId: "jacket-academic", key: "sleeve", value: 64, unit: "cm", source: STATEMENT });
    // The same key on another garment and on the body are separate facts.
    await owner.exec("measurement.record", { subject: "garment", garmentId: "jacket-blue-work", key: "half_chest", value: 60, unit: "cm", source: STATEMENT });

    const detail = await getGarmentDetail(h.db, owner.principal(), "jacket-academic");
    expect(detail.measurements!.map((m) => [m.key, m.value, m.unit, m.convention, m.measuredOn, m.source.kind])).toEqual([
      ["half_chest", 57.5, "cm", "flat half-chest", "2026-09-20", "owner_statement"],
      ["sleeve", 64, "cm", null, null, "owner_statement"],
    ]);
    expect((await getGarmentDetail(h.db, owner.principal(), "jacket-blue-work")).measurements!.map((m) => m.value)).toEqual([60]);
    expect((await getGarmentDetail(h.db, owner.principal(), "shirt-moss")).measurements).toEqual([]);
  });
});
