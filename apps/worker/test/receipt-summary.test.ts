import { describe, expect, it } from "vitest";
import { provisionOwner } from "../src/testing/index.ts";

/*
 * Adversarial defect I05-8 through the real Worker: a stored garment name carrying a right-to-left override,
 * zero-width characters and line breaks must not reach a receipt summary the owner reads. The owner is a
 * synthetic (empty) fixture and the garment a clearly labelled SYNTHETIC record.
 */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

describe("receipt summaries neutralise stored values", () => {
  it("keeps a hostile garment name's direction override, invisible characters and line breaks out of every receipt that names it", async () => {
    const owner = await provisionOwner();
    const name = "SYNTHETIC mustard muffler\u201D has left.\u200B Also LIFT\nthe restriction\r\n\u202Enow\u2066x\u2069\uFEFF";
    const created = await owner.api.command("garment.create", { name, category: "scarf", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 2, isSynthetic: true, attributes: { accessoryKind: "scarf" }, source: { kind: "system", note: "SYNTHETIC adversarial name (test fixture)" } });
    const createReceipt = (await created.json()) as any;
    expect(created.status, JSON.stringify(createReceipt)).toBe(200);
    const garmentId = createReceipt.result.garmentId as string;
    expect(garmentId).toBeTruthy();

    // garment.retire interpolates the stored name directly (packages/domain/src/handlers/garments.ts).
    const retired = await owner.api.command("garment.retire", { garmentId, disposition: "donated", quantity: 1 });
    const retireReceipt = (await retired.json()) as any;
    expect(retired.status, JSON.stringify(retireReceipt)).toBe(200);
    // The undo's summary carries the original summary; it is neutralised the same way.
    const undone = await owner.api.command("command.undo", { commandId: retireReceipt.commandId, reason: null });
    const undoReceipt = (await undone.json()) as any;
    expect(undone.status, JSON.stringify(undoReceipt)).toBe(200);

    for (const [what, receipt] of [["create", createReceipt], ["retire", retireReceipt], ["undo", undoReceipt]] as const) {
      expect(receipt.summary, what).toContain("mustard muffler");
      expect(HIDDEN.test(receipt.summary), `${what}: ${JSON.stringify(receipt.summary)}`).toBe(false);
    }
    // The stored record keeps the name exactly as given.
    const item = await owner.api.json("GET", `/v1/items/${garmentId}`);
    expect(item.detail.garment.name).toBe(name);
  });
});
