/**
 * Journey 02: Wardrobe and item detail, with the owner's real inventory and profile.
 *
 * Specification: section 3 (Wardrobe), section 5 (records, garment identity, evidence and corrections,
 * quantity), section 6 (apply the supplied profile faithfully), section 16 (import only data);
 * acceptance rows "Availability" and "Quantities" (count corrections). Owner rules: every inventory row
 * accounted for, the profile preserved byte for byte, no invented garments, wears or lifted restrictions.
 * Profile: section 7 (measurements), section 8 rules 2 and 7, section 11 (zero wears means unlogged).
 *
 * The expectations come from an independent reading of the supplied sheet (src/inventory.ts), not from
 * the product's importer. Stand-ins: test-signed sign-in only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { connectMcp, provisionOwner, toolResult, type TestOwner } from "@garderobe/worker/testing";
import profileText from "../../../requirements/chris-wardrobe-profile.md?raw";
import { isBenched, isWelted, SHEET_LINE_COUNT, SHEET_ROWS, sheetRowsFor, unitsOf } from "../src/inventory.ts";
import { exec, internalCodesIn, quantityIn, realOwnerAt, refused, wholeWardrobe, type JourneyOwner, type WardrobeItem } from "../src/world.ts";

let j: JourneyOwner;
let owner: TestOwner;
let stranger: TestOwner;
let items: WardrobeItem[];

const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const byName = (name: string) => items.find((i) => i.garment.name === name)!;
const item = (id: string) => owner.api.json("GET", `/v1/items/${id}`);

beforeAll(async () => {
  j = await realOwnerAt("Wardrobe");
  owner = j.owner;
  stranger = await provisionOwner();
  items = (await wholeWardrobe(owner.api)).items;
});

describe("the owner's real wardrobe, as imported", () => {
  it("accounts for every line of the supplied sheet: 132 lines, 130 garment rows, 127 garments, 144 units", async () => {
    expect(SHEET_LINE_COUNT).toBe(132);
    expect(SHEET_ROWS).toHaveLength(130);
    const page = await owner.api.json("GET", "/v1/wardrobe");
    expect(page.total).toBe(127);
    expect(page.complete).toBe(true);
    expect(items).toHaveLength(127);
    // Every garment shown traces to the sheet, and every sheet row is behind exactly one garment.
    const covered = new Set<number>();
    for (const entry of items) {
      const rows = sheetRowsFor(entry.garment.name);
      expect(rows.length, `"${entry.garment.name}" is in the sheet`).toBeGreaterThan(0);
      for (const row of rows) {
        expect(covered.has(row.line), `sheet line ${row.line} is used once`).toBe(false);
        covered.add(row.line);
      }
      // Units: a second identical pair of trousers and "2x" pairs of socks are quantities, not extra garments.
      expect(entry.totalOwnedUnits, entry.garment.name).toBe(rows.reduce((n, r) => n + unitsOf(r), 0));
      expect(entry.garment.isSynthetic).toBe(false);
    }
    expect(covered.size).toBe(130);
    expect(items.reduce((n, i) => n + i.totalOwnedUnits, 0)).toBe(144);
  });

  it("created no wear history, no laundry history and no garment the owner does not own", async () => {
    for (const entry of items) {
      expect(entry.recordedWearCount, entry.garment.name).toBe(0);
      expect(entry.lastRecordedWear).toBeNull();
      expect(entry.garment.acquisition).toBe("owned");
    }
    const laundry = await owner.api.json("GET", "/v1/laundry");
    expect(laundry.batches).toEqual([]);
    expect(laundry.awaitingService).toEqual([]);
    expect(laundry.awaitingHandwash).toEqual([]);
    expect(laundry.exceptions).toEqual([]);
    const page = await owner.api.json("GET", "/v1/wardrobe");
    expect(page.counts.incoming).toBe(0);
    expect(page.counts.retired).toBe(0);
  });

  it("treats imported cleanliness as an estimate with a stated basis, never as an observation", () => {
    const shirt = byName("Lightweight oxford — pink");
    expect(shirt.availability!.status).toBe("estimated");
    expect(shirt.availability!.hardExcluded).toBe(false);
    expect(shirt.availability!.pAvailable).toBeGreaterThan(0);
    expect(shirt.availability!.pAvailable).toBeLessThan(1);
    expect(shirt.availability!.basis.join(" ")).toMatch(/estimate/i);
    for (const line of shirt.availability!.basis) expect(internalCodesIn(line), line).toEqual([]);
  });

  it("keeps the sneakers-only restriction active on every welted shoe and boot, with nothing lifted", async () => {
    const footwear = items.filter((i) => i.garment.category === "footwear");
    expect(footwear).toHaveLength(7);
    for (const shoe of footwear) {
      const welted = isWelted(sheetRowsFor(shoe.garment.name)[0]!);
      expect(shoe.availability!.hardExcluded, shoe.garment.name).toBe(welted);
      if (welted) {
        expect(shoe.availability!.pAvailable).toBe(0);
        expect(shoe.availability!.restrictionIds.length).toBe(1);
        // Restricted is not retired: the shoes are still owned and still listed.
        expect(shoe.totalOwnedUnits).toBe(1);
        const detail = await item(shoe.garment.garmentId);
        expect(detail.detail.restrictions).toHaveLength(1);
        expect(JSON.stringify(detail.detail.restrictions[0])).toMatch(/heal|nerve|sneaker/i);
      }
    }
    expect(footwear.filter((s) => !s.availability!.hardExcluded).map((s) => s.garment.name).sort()).toEqual(["NB 990v4 — grey", "NB 990v4 — navy", "NB 990v4 — olive/cream"]);
  });

  it("keeps benched pieces owned and visible but out of planning, with the sheet's own reason", () => {
    const benched = SHEET_ROWS.filter(isBenched);
    expect(benched.length).toBe(13);
    for (const row of benched) {
      const entry = items.find((i) => sheetRowsFor(i.garment.name).some((r) => r.line === row.line))!;
      expect(entry.availability!.hardExcluded, row.item).toBe(true);
      expect(entry.garment.planningReason, row.item).toMatch(/benched/i);
      expect(entry.totalOwnedUnits).toBe(1);
    }
  });

  it("holds the profile word for word, with its hash, and the body facts it states", async () => {
    const style = await owner.api.json("GET", "/v1/style");
    expect(style.document.content).toBe(profileText);
    expect(style.document.contentSha256).toBe(await sha256(profileText as string));
    expect(style.amendments).toEqual([]);
    expect(style.factConflicts).toEqual([]);
    const measurement = (key: string) => style.measurements.find((m: any) => m.key === key);
    // Profile section 7: chest and waist 44 in, neck 17 in, UK 8.5, a little over 1.85 m.
    expect(measurement("chest")).toMatchObject({ value: 44, unit: "in" });
    expect(measurement("waist")).toMatchObject({ value: 44, unit: "in" });
    expect(measurement("neck")).toMatchObject({ value: 17, unit: "in" });
    expect(measurement("shoe_size")).toMatchObject({ value: 8.5, unit: "uk_shoe" });
    // Each structured fact points at the passage of the profile it was read from.
    for (const m of style.measurements) {
      expect(m.passage.quote.length, m.key).toBeGreaterThan(0);
      expect(profileText as string).toContain(m.passage.quote);
    }
    for (const rule of style.rules) for (const passage of rule.passages) expect(profileText as string, rule.key).toContain(passage.quote);
  });
});

describe("browsing and item detail", () => {
  it("pages the wardrobe with an explicit total and completeness, so a client never undercounts", async () => {
    const first = await owner.api.json("GET", "/v1/wardrobe?limit=50");
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(127);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBeTruthy();
    const paged = await wholeWardrobe(owner.api, "limit=50");
    expect(paged.pages).toBe(3);
    expect(new Set(paged.items.map((i) => i.garment.garmentId)).size).toBe(127);
  });

  it("finds garments by the words the owner uses and asks only when a phrase is genuinely ambiguous", async () => {
    const pink = await owner.api.json("GET", `/v1/wardrobe/resolve?phrase=${encodeURIComponent("pink oxford")}`);
    expect(pink.ambiguous).toBe(false);
    expect(pink.matches.map((m: any) => m.name)).toEqual(["Lightweight oxford — pink"]);
    const trainers = await owner.api.json("GET", `/v1/wardrobe/resolve?phrase=${encodeURIComponent("NB 990v4")}`);
    expect(trainers.ambiguous).toBe(true);
    expect(trainers.matches).toHaveLength(3);
    // The distinction offered is one he can see at the wardrobe: the colour.
    expect(trainers.matches.map((m: any) => m.distinguishing).join(" ")).toMatch(/Grey[\s\S]*Navy|Navy[\s\S]*Grey/);
    const nothing = await owner.api.json("GET", `/v1/wardrobe/resolve?phrase=${encodeURIComponent("tuxedo")}`);
    expect(nothing.matches).toEqual([]);
    const search = await owner.api.json("GET", "/v1/wardrobe?search=flannel");
    expect(search.items.map((i: any) => i.garment.name).sort()).toEqual(SHEET_ROWS.filter((r) => /flannel/i.test(`${r.item} ${r.fabric}`)).map((r) => r.item).sort());
  });

  it("shows an item with its facts and where each came from, and says zero wears means unlogged", async () => {
    const coat = byName("DBF Grandfather Coat");
    const detail = await item(coat.garment.garmentId);
    expect(detail.detail.garment.maker).toBe("De Bonne Facture");
    expect(detail.detail.garment.fabric).toBe("Herringbone wool");
    expect(detail.detail.recordedWearCount).toBe(0);
    // Profile section 11: a zero wear count means unlogged, never unworn; condition is not inferred.
    expect(detail.detail.wearCountCaveat).toMatch(/not logged|unlogged/i);
    expect(detail.detail.wearCountCaveat).toMatch(/never unworn/i);
    expect(detail.detail.garment.condition).toBeNull();
    // Imported facts are historical evidence with their sheet line, not live observations.
    expect(detail.detail.facts.length).toBeGreaterThan(0);
    const imported = detail.detail.facts.filter((f: any) => f.source.kind === "import");
    expect(imported.length).toBeGreaterThan(0);
    for (const fact of imported) expect(fact.source.ref).toMatch(/^wardrobe_inventory_clean\.csv#line:\d+$/);
    // No fact claims to be something the owner said or saw: nothing was observed at import.
    for (const fact of detail.detail.facts) expect(["import", "system"], fact.attribute).toContain(fact.source.kind);
    expect(detail.detail.facts.find((f: any) => f.attribute === "import_notes").value).toBe("Beloved; winter only");
    // No photograph exists: the item says so rather than showing an invented picture.
    expect(detail.media.image.hasRealImage).toBe(false);
    expect(detail.media.image.missingImageNote).toBeTruthy();
    expect((await owner.api.get(`/v1/items/${coat.garment.garmentId}/image`)).status).toBe(404);
    expect((await stranger.api.get(`/v1/items/${coat.garment.garmentId}`)).status).toBe(404);
  });

  it("previews what a temperature would make wearable as a simulation that changes nothing", async () => {
    const before = (await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision;
    const hot = await owner.api.json("GET", "/v1/wardrobe/temperature-preview?temperatureC=31");
    const mild = await owner.api.json("GET", "/v1/wardrobe/temperature-preview?temperatureC=18");
    expect(hot.simulation).toBe(true);
    expect(hot.label).toMatch(/simulat|preview/i);
    const wearable = (preview: any) => preview.wearable.map((g: any) => g.name);
    // The sheet: the Palermo linen trousers are "30 C+ only"; the Pima oxfords are "To 22 C".
    expect(wearable(hot)).toContain("Palermo linen drawstring — tobacco");
    expect(wearable(mild)).not.toContain("Palermo linen drawstring — tobacco");
    expect(wearable(mild)).toContain("Pima oxford — navy");
    expect(wearable(hot)).not.toContain("Pima oxford — navy");
    for (const entry of [...hot.notWearable, ...mild.notWearable]) expect(internalCodesIn(entry.why), entry.why).toEqual([]);
    expect((await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision).toBe(before);
  });

  it("gives a connected assistant the same complete inventory, with the same total", async () => {
    const mcp = await connectMcp(owner, { write: false, clientName: "Inventory reader" });
    const snapshot = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot" } }));
    expect(snapshot.ok).toBe(true);
    expect(snapshot.data.complete).toBe(true);
    expect(snapshot.data.total).toBe(127);
    expect(snapshot.data.data.items.map((i: any) => i.garment.garmentId).sort()).toEqual(items.map((i) => i.garment.garmentId).sort());
    await mcp.close();
  });
});

describe("the owner corrects the record", () => {
  it("a colour correction replaces the imported fact, keeps where it came from, and can be undone", async () => {
    const shirt = byName("Cotton-linen oxford — dark navy stripe");
    const id = shirt.garment.garmentId;
    expect(shirt.garment.colour).toBe("Dark navy (reads black)");
    const receipt = await exec(owner.api, "garment.correct", { garmentId: id, changes: { colour: "Black stripe" }, source: { kind: "owner_statement" } }, { expectedVersions: { [`garment:${id}`]: shirt.garment.version } });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toContain("Cotton-linen oxford — dark navy stripe");
    expect(receipt.summary).toMatch(/colour/);
    expect(internalCodesIn(receipt.summary)).toEqual([]);
    expect(receipt.undo.available).toBe(true);
    const corrected = await item(id);
    expect(corrected.detail.garment.colour).toBe("Black stripe");
    expect(corrected.detail.garment.version).toBe(shirt.garment.version + 1);
    // The item's history lists the correction as an ordinary receipt.
    const history = await owner.api.json("GET", `/v1/commands?entity=garment:${id}`);
    expect(history.receipts.map((r: any) => r.commandId)).toContain(receipt.commandId);

    const undone = await exec(owner.api, "command.undo", { commandId: receipt.commandId });
    expect(undone.summary).toMatch(/^Undone/);
    expect((await item(id)).detail.garment.colour).toBe("Dark navy (reads black)");
    // An undo is a new receipt; neither earlier receipt is deleted.
    const after = await owner.api.json("GET", `/v1/commands?entity=garment:${id}`);
    expect(after.receipts.map((r: any) => r.commandId)).toEqual(expect.arrayContaining([receipt.commandId, undone.commandId]));
  });

  it("refuses a correction made from a stale screen instead of overwriting a newer one", async () => {
    const shirt = byName("Selvedge twill — camel");
    const id = shirt.garment.garmentId;
    await exec(owner.api, "garment.correct", { garmentId: id, changes: { condition: "collar slightly frayed" }, source: { kind: "owner_statement" } }, { expectedVersions: { [`garment:${id}`]: shirt.garment.version } });
    const stale = await refused(await owner.api.command("garment.correct", { garmentId: id, changes: { condition: "as new" }, source: { kind: "owner_statement" } }, { expectedVersions: { [`garment:${id}`]: shirt.garment.version } }));
    expect(stale.status).toBe(409);
    expect(stale.error.code).toBe("conflict");
    expect(stale.error.message).toMatch(/nothing was written/i);
    expect((await item(id)).detail.garment.condition).toBe("collar slightly frayed");
  });

  it("\"five pairs are clean\" is an aggregate count correction: no per-pair identity, no fictional stock", async () => {
    const sock = byName("Merino — correct grey");
    const id = sock.garment.garmentId;
    expect(sock.totalOwnedUnits).toBe(3);
    const receipt = await exec(owner.api, "stock.reconcile", { garmentId: id, counts: { clean: 2, dirty: 1 } });
    expect(receipt.summary).toContain("Merino — correct grey");
    expect(receipt.summary).toMatch(/2 clean/);
    const counted = await item(id);
    expect(quantityIn(counted.detail, "clean")).toBe(2);
    expect(quantityIn(counted.detail, "dirty")).toBe(1);
    expect(counted.detail.totalOwnedUnits).toBe(3);
    // The owner's count is now an observation, not the import's estimate.
    expect(counted.availability.status).not.toBe("estimated");
    // Asking for more pairs in the wash than exist never creates pairs or a negative balance.
    const tooMany = await owner.api.command("care.mark_dirty", { items: [{ garmentId: id, quantity: 9 }] });
    const after = await item(id);
    expect(after.detail.totalOwnedUnits).toBe(3);
    for (const balance of after.detail.balances) expect(balance.quantity).toBeGreaterThanOrEqual(0);
    expect(after.detail.balances.reduce((n: number, b: any) => n + b.quantity, 0)).toBe(3);
    expect([200, 409]).toContain(tooMany.status);
  });

  it("one correction across a whole group is one command, one receipt and one undo, guarded by the count he saw", async () => {
    const selection = await owner.api.json("POST", "/v1/wardrobe/selection", { category: "socks", fabric: "Alpaca" });
    expect(selection.garments.map((g: any) => g.name).sort()).toEqual(["Alpaca bed sock — clotted cream", "Alpaca — inky blue", "Alpaca — true black"]);
    const wrong = await refused(await owner.api.command("garment.bulk_correct", { selector: { category: "socks", fabric: "Alpaca" }, changes: { condition: "hand wash cold" }, expectedCount: 2, source: { kind: "owner_statement" } }));
    expect(wrong.status).toBe(409);
    const receipt = await exec(owner.api, "garment.bulk_correct", { selector: { category: "socks", fabric: "Alpaca" }, changes: { condition: "hand wash cold" }, expectedCount: 3, source: { kind: "owner_statement" } });
    expect(receipt.affected.filter((a: any) => a.kind === "garment")).toHaveLength(3);
    for (const g of selection.garments) expect((await item(g.garmentId)).detail.garment.condition).toBe("hand wash cold");
    await exec(owner.api, "command.undo", { commandId: receipt.commandId });
    for (const g of selection.garments) expect((await item(g.garmentId)).detail.garment.condition).toBeNull();
  });

  it("a name the owner uses becomes an alias that resolves, and can be removed again", async () => {
    const jacket = byName("Drake's Olive Jungle Jacket");
    await exec(owner.api, "garment.add_alias", { garmentId: jacket.garment.garmentId, phrase: "the expedition jacket" });
    const resolved = await owner.api.json("GET", `/v1/wardrobe/resolve?phrase=${encodeURIComponent("the expedition jacket")}`);
    expect(resolved.matches.map((m: any) => m.garmentId)).toEqual([jacket.garment.garmentId]);
    await exec(owner.api, "garment.remove_alias", { garmentId: jacket.garment.garmentId, phrase: "the expedition jacket" });
    expect((await owner.api.json("GET", `/v1/wardrobe/resolve?phrase=${encodeURIComponent("the expedition jacket")}`)).matches).toEqual([]);
  });

  it("a piece sent to the tailor leaves planning until it is back, and no schedule releases it", async () => {
    const blazer = byName("Drake's Camel Field Games"); // the sheet: "Tailoring planned"
    const id = blazer.garment.garmentId;
    const sent = await exec(owner.api, "garment.move", { garmentId: id, to: "tailor", note: "taking in the waist" }, { expectedVersions: { [`garment:${id}`]: blazer.garment.version } });
    expect(sent.summary).toMatch(/tailor/i);
    let detail = await item(id);
    expect(quantityIn(detail.detail, "tailor")).toBe(1);
    expect(detail.availability.hardExcluded).toBe(true);
    // The weekly laundry baseline is a scheduled assumption: it cannot bring a jacket back from the tailor.
    await owner.api.command("laundry.apply_weekly_reset", { asOf: new Date(Date.now() + 9 * 86_400_000).toISOString() });
    detail = await item(id);
    expect(quantityIn(detail.detail, "tailor")).toBe(1);
    expect(detail.availability.hardExcluded).toBe(true);
    const back = await exec(owner.api, "garment.move", { garmentId: id, to: "clean" });
    expect(back.outcome).toBe("committed");
    detail = await item(id);
    expect(quantityIn(detail.detail, "clean")).toBe(1);
    expect(detail.availability.hardExcluded).toBe(false);
    expect(detail.detail.totalOwnedUnits).toBe(1);
  });

  it("a wrong or reused request is refused cleanly and changes nothing", async () => {
    const revision = (await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision;
    const unknown = await refused(await owner.api.command("garment.vanish", { garmentId: items[0]!.garment.garmentId }));
    expect(unknown.error.code).toBe("unknown_command");
    const missing = await refused(await owner.api.command("care.mark_dirty", { items: [{ garmentId: "gmt_does_not_exist", quantity: 1 }] }));
    expect(missing.status).toBe(404);
    const key = `reuse-${crypto.randomUUID()}`;
    const sock = byName("Merino — fire red");
    const first = await exec(owner.api, "care.mark_dirty", { items: [{ garmentId: sock.garment.garmentId, quantity: 1 }] }, { idempotencyKey: key });
    const replay = await exec(owner.api, "care.mark_dirty", { items: [{ garmentId: sock.garment.garmentId, quantity: 1 }] }, { idempotencyKey: key });
    expect(replay.commandId).toBe(first.commandId);
    expect(replay.replayed).toBe(true);
    const reused = await refused(await owner.api.command("care.washed", { items: [{ garmentId: sock.garment.garmentId }] }, { idempotencyKey: key }));
    expect(reused.error.code).toBe("idempotency_key_reuse");
    expect((await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision).toBe(revision + 1);
  });
});
