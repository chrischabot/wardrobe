import { describe, expect, it } from "vitest";
import { all, first, getAvailability, getGarmentDetail, getStyleContext, listInventory, listRestrictions, resolveAlias, sha256Hex } from "../src/index.ts";
import { buildInventoryImportPlan, detectConflicts, HEALING_RESTRICTION_ID, importOwnerData, OWNER_PROFILE_SHA256, parseCsv, PROFILE_RULES, renderImportReport } from "../src/import/index.ts";
import { createHarness, ownerDocuments } from "../src/testing/index.ts";

const SPEC_SHA256 = "7f47ffd7aa5a7bcd92738c4eaa48d2ec0af79486440f490790007a8678558238";
const CSV_SHA256 = "ca9a5e06edbb2646ad91f102cb242a81b1776bd39e86e99300c0eb387254c946";

describe("supplied documents", () => {
  it("the profile is byte-identical to the edition the specification names (SHA-256) and the CSV matches its recorded hash", async () => {
    const docs = ownerDocuments();
    expect(await sha256Hex(new TextEncoder().encode(docs.profileText))).toBe(OWNER_PROFILE_SHA256);
    expect(OWNER_PROFILE_SHA256).toBe("e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198");
    expect(await sha256Hex(new TextEncoder().encode(docs.inventoryCsv))).toBe(CSV_SHA256);
    const recorded = Object.fromEntries(docs.sha256sums.trim().split("\n").map((l) => [l.slice(66), l.slice(0, 64)]));
    expect(recorded).toMatchObject({
      "chris-wardrobe-profile.md": OWNER_PROFILE_SHA256,
      "wardrobe_inventory_clean.csv": CSV_SHA256,
      "garderobe-replacement-design.md": SPEC_SHA256,
    });
    expect(Object.keys(recorded)).toContain("wardrobe-requirements-and-evals.tar.gz");
  });
});

describe("inventory import plan (pure)", () => {
  it("accounts for every line of the CSV exactly once", async () => {
    const { inventoryCsv } = ownerDocuments();
    const plan = await buildInventoryImportPlan(inventoryCsv);
    const physicalLines = inventoryCsv.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")).length;
    expect(parseCsv(inventoryCsv)).toHaveLength(physicalLines); // no record spans lines, so lines and records agree
    expect(plan.rows.map((r) => r.sourceRow)).toEqual(Array.from({ length: physicalLines }, (_, i) => i + 1));
    expect(plan.totals).toMatchObject({ physicalLines: 132, dataRows: 130, imported: 127, merged: 3, held: 0, notDataRows: 2, garments: 127, units: 144 });
    expect(plan.totals.byCategory).toMatchObject({
      footwear: { rows: 7, garments: 7, units: 7 },
      shirt: { rows: 43, garments: 43, units: 43 },
      trousers: { rows: 25, garments: 22, units: 25 },
      outerwear: { rows: 25, garments: 25, units: 25 },
      socks: { rows: 15, garments: 15, units: 29 },
    });
    expect(plan.rows.every((r) => r.reason.length > 0)).toBe(true);
    // Every imported or merged line maps to a planned garment; every planned garment comes from at least one line.
    const ids = new Set(plan.garments.map((g) => g.garmentId));
    expect(plan.rows.filter((r) => r.disposition === "imported" || r.disposition === "merged").every((r) => r.garmentId !== null && ids.has(r.garmentId))).toBe(true);
    expect(plan.garments.flatMap((g) => g.sourceRows).sort((a, b) => a - b)).toEqual(plan.rows.filter((r) => r.garmentId).map((r) => r.sourceRow));
  });

  it("merges only declared interchangeable pairs, with an explicit mapping, and decomposes the Status column", async () => {
    const plan = await buildInventoryImportPlan(ownerDocuments().inventoryCsv);
    const merged = plan.rows.filter((r) => r.disposition === "merged");
    expect(merged.map((r) => r.sourceRow)).toEqual([63, 66, 75]);
    expect(merged[0]!.reason).toContain("line 62");
    const walnut = plan.garments.find((g) => g.payload.name === "Di Sondrio walnut chino")!;
    expect(walnut).toMatchObject({ sourceRows: [65, 66], payload: { quantity: 2, category: "trousers", careChannel: "service" } });

    const by = (name: string) => plan.garments.find((g) => g.payload.name === name)!.payload;
    expect(by("PWVC General's Overcoat")).toMatchObject({ planningPolicy: "excluded", acquisition: "owned" });
    expect(by("PWVC General's Overcoat").planningReason).toContain("too large");
    expect(by("Anglo-Italian pocket square")).toMatchObject({ planningPolicy: "occasional", category: "pocket_square" });
    expect(by("Paraboot Michael Cerf")).toMatchObject({ planningPolicy: "normal", condition: "breaking in", attributes: { footwearKind: "welted", breakingIn: true } });
    expect(by("NB 990v4 — navy")).toMatchObject({ attributes: { footwearKind: "sneaker", model: "990v4" }, careChannel: "none" });
    expect(by("Drake's Clifford boot")).toMatchObject({ size: "UK 9", attributes: { footwearKind: "boot" } });
    expect(by("Merino — inky blue")).toMatchObject({ quantity: 4, careChannel: "handwash", attributes: { fabricClass: "merino" } });
    expect(by("Alpaca bed sock — clotted cream")).toMatchObject({ quantity: 1, attributes: { indoorOnly: true } });
    // Unknown stays unknown; a stated number keeps an explicitly unsettled basis.
    expect(by("Cord — beige")).toMatchObject({ maker: null, size: null, thermal: null });
    expect(by("Pima oxford — navy").thermal).toMatchObject({ maxC: 22, basis: "unsettled" });
    expect(by("Palermo linen drawstring — tobacco").thermal).toMatchObject({ minC: 30, basis: "unsettled" });
    expect(by("Drake's Olive Jungle Jacket").thermal).toMatchObject({ minC: 10, maxC: 22 });
    expect(by("Clark oxford — beige").attributes).not.toHaveProperty("fabricClass"); // weight not stated in the sheet
    expect(by("Lightweight oxford — moss").aliases).toEqual(expect.arrayContaining([{ phrase: "PCF4922", kind: "code" }]));
    // The three alpaca rows give no count: recorded as issues for the owner, not guessed upward.
    expect(plan.issues.filter((i) => i.kind === "quantity_not_stated").map((i) => i.sourceRows[0])).toEqual([118, 119, 120]);
  });

  it("holds a row it cannot interpret instead of guessing, and still accounts for it", async () => {
    const csv = [
      "Category,Item,Colour / Pattern,Fabric / Material,Brand,Size,Season,Status,Notes,Source detail (fabric / construction),Price (£),Acquired,Link,Ref / PCF",
      "Shirt,[synthetic] test oxford,Blue,Oxford,Test,MTM,All-season,Active,,,,,,",
      "Hat,[synthetic] test cap,Blue,Wool,Test,-,-,Active,,,,,,",
      "Shirt,[synthetic] odd status shirt,Blue,Oxford,Test,MTM,All-season,Somewhere,,,,,,",
      "Trouser,[synthetic] chino (pair 1),Navy,Cotton,Test,MTM,-,Active,,,,,,",
      "Trouser,[synthetic] chino (pair 2),Black,Cotton,Test,MTM,-,Active,,,,,,",
    ].join("\n");
    const plan = await buildInventoryImportPlan(csv, "synthetic.csv");
    expect(plan.rows.map((r) => r.disposition)).toEqual(["not_a_data_row", "imported", "held", "held", "imported", "held"]);
    expect(plan.rows[2]!.reason).toContain('unrecognised category "Hat"');
    expect(plan.rows[3]!.reason).toContain('status "Somewhere"');
    expect(plan.rows[5]!.reason).toContain("differs");
    expect(plan.totals).toMatchObject({ garments: 2, held: 3 });
    await expect(buildInventoryImportPlan("Item,Category\nx,y\n")).rejects.toThrow(/header/);
  });

  it("the committed import report is exactly what the importer produces from the supplied documents", async () => {
    const docs = ownerDocuments();
    const plan = await buildInventoryImportPlan(docs.inventoryCsv);
    const conflicts = detectConflicts(plan, docs.profileText);
    expect(docs.importReportMd).toBe(renderImportReport(plan, conflicts));
    expect(conflicts.map((c) => c.id)).toEqual(["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "C11", "C12", "C13"]);
    // Each conflict quotes the profile verbatim (or states that it is sheet-internal) and says what was done.
    for (const c of conflicts) {
      if (c.profileQuote !== null) expect(docs.profileText).toContain(c.profileQuote);
      expect(c.importerAction.length).toBeGreaterThan(20);
    }
  });
});

describe("owner import through the command service (real D1)", () => {
  it("imports the profile verbatim and every inventory row, invents nothing, and is idempotent", async () => {
    const h = await createHarness({ startAt: "2026-09-30T09:00:00Z" });
    const { owner, result } = await h.createRealOwner();
    const docs = ownerDocuments();
    const p = owner.principal();

    // Profile: stored unchanged, hash verified, full text returned to every consumer.
    const ctx = await getStyleContext(h.db, p);
    expect(ctx.document.content).toBe(docs.profileText);
    expect(ctx.document).toMatchObject({ version: 1, contentSha256: OWNER_PROFILE_SHA256, byteLength: 14960 });
    expect(ctx.rules).toHaveLength(PROFILE_RULES.length);
    for (const rule of ctx.rules) {
      if (rule.origin === "profile") expect(rule.passages.length).toBeGreaterThan(0);
      for (const passage of rule.passages) {
        expect(docs.profileText).toContain(passage.quote);
        // The recorded line range really contains the quote.
        const lines = docs.profileText.split("\n").slice(passage.lineStart - 1, passage.lineEnd).join("\n");
        expect(lines).toContain(passage.quote);
        expect(passage.documentSha256).toBe(OWNER_PROFILE_SHA256);
      }
    }
    const rule = (key: string) => ctx.rules.find((r) => r.key === key)!;
    expect(rule("socks.required")).toMatchObject({ kind: "hard", status: "active" });
    expect(rule("thermal.jacket_14_16_lightweight_oxford_only").params).toMatchObject({ minC: 14, maxC: 16, basis: "outdoor_interval" });
    expect(rule("footwear.name_sneaker_and_welted_alternative").status).toBe("dormant");
    expect(rule("variety.repeat_horizon").params).toMatchObject({ days: 7 });
    // Research thresholds that are not in the profile are kept with their source but not enforced.
    expect(rule("thermal.cotton_linen_from")).toMatchObject({ status: "pending_reconciliation", origin: "specification" });
    expect(rule("thermal.outerwear_ceiling").params).toMatchObject({ basis: "unsettled" });
    expect(ctx.measurements.map((m) => [m.key, m.value, m.unit]).sort()).toEqual([["chest", 44, "in"], ["height", 1.85, "m"], ["neck", 17, "in"], ["shoe_size", 8.5, "uk_shoe"], ["waist", 44, "in"]]);
    expect(ctx.measurements.find((m) => m.key === "height")!.qualifier).toBe("a little over");
    expect(ctx.sizeExperiences.find((s) => s.maker === "Drake's")!.sizeLabel).toBe("46");

    // Inventory: every row accounted for in the ledger, exactly the planned garments and units.
    const refs = await all<{ source_row: number; disposition: string }>(h.db, "SELECT source_row, disposition FROM import_refs WHERE user_id = ? ORDER BY source_row", owner.userId);
    expect(refs).toHaveLength(132);
    expect(refs.map((r) => r.source_row)).toEqual(Array.from({ length: 132 }, (_, i) => i + 1));
    const inventory = await listInventory(h.db, p, {}, { nowMs: h.clock.now() });
    expect(inventory).toMatchObject({ total: 127, complete: true, counts: { owned: 127, incoming: 0, retired: 0 } });
    expect(inventory.items.reduce((n, i) => n + i.totalOwnedUnits, 0)).toBe(144);
    expect(inventory.items.every((i) => !i.garment.isSynthetic)).toBe(true);
    const names = inventory.items.map((i) => i.garment.name.toLowerCase());
    for (const invented of ["990v6", "993", "rugby", "jeans", "cardigan", "loafer"]) expect(names.some((n) => n.includes(invented)), invented).toBe(false);

    // No wear history, no laundry history and no lifted restriction were invented.
    for (const table of ["wear_observations", "daily_wears", "laundry_batches", "laundry_cycles", "exposure_sets"]) {
      expect((await first<{ n: number }>(h.db, `SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, owner.userId))!.n, table).toBe(0);
    }
    expect(inventory.items.every((i) => i.recordedWearCount === 0 && i.lastRecordedWear === null)).toBe(true);
    const events = await all<{ kind: string; basis: string }>(h.db, "SELECT DISTINCT kind, basis FROM stock_events WHERE user_id = ?", owner.userId);
    expect(events).toEqual([{ kind: "receive", basis: "import" }]);
    const restrictions = await listRestrictions(h.db, p);
    expect(restrictions).toHaveLength(1);
    expect(restrictions[0]).toMatchObject({ restrictionId: HEALING_RESTRICTION_ID, kind: "healing", status: "active", expectedEnd: null, requiredEvidence: "owner_statement" });

    // The restriction is applied to the real shoes: sneakers only.
    const availability = await getAvailability(h.db, p, { nowMs: h.clock.now() });
    const footwear = inventory.items.filter((i) => i.garment.category === "footwear").map((i) => ({ name: i.garment.name, a: availability.garments.find((g) => g.garmentId === i.garment.garmentId)! }));
    expect(footwear.filter((f) => !f.a.hardExcluded).map((f) => f.name).sort()).toEqual(["NB 990v4 — grey", "NB 990v4 — navy", "NB 990v4 — olive/cream"]);
    expect(footwear.filter((f) => f.a.hardExcluded).every((f) => f.a.reasons.includes("restricted"))).toBe(true);
    expect(footwear.filter((f) => f.a.hardExcluded)).toHaveLength(4);
    // Benched pieces are owned but excluded; the bed sock is conditional (indoor only).
    const benched = inventory.items.filter((i) => i.garment.planningPolicy === "excluded");
    expect(benched).toHaveLength(13);
    expect(benched.every((i) => i.availability!.hardExcluded && i.garment.acquisition === "owned")).toBe(true);
    expect(inventory.items.find((i) => i.garment.name.startsWith("Alpaca bed sock"))!.availability!.status).toBe("conditional");

    // Names and codes the owner or a maker would use resolve; an ambiguous phrase stays ambiguous.
    expect((await resolveAlias(h.db, p, "PCF4340")).matches.map((m) => m.name)).toEqual(["Lightweight oxford — light blue wide stripe"]);
    expect((await resolveAlias(h.db, p, "Cotton-Twill Chore Jacket Green")).matches.map((m) => m.name)).toEqual(["Drake's Waxed Chasseur"]);
    expect((await resolveAlias(h.db, p, "Paraboot Reims")).ambiguous).toBe(true);
    const moss = (await resolveAlias(h.db, p, "Lightweight oxford — moss")).matches[0]!;
    const detail = await getGarmentDetail(h.db, p, moss.garmentId);
    expect(detail.facts.find((f) => f.attribute === "purchase_price")!.value).toEqual({ amount: "129.63", currency: "GBP" });
    expect(detail.facts.find((f) => f.attribute === "import_status")!.value).toBe("Active");
    expect(detail.garment.product).toBe("Washed Moss Lightweight Oxford PCF4922");

    // Conflicts and issues are stored for the owner.
    const issues = await all<{ kind: string; severity: string }>(h.db, "SELECT kind, severity FROM migration_issues WHERE user_id = ?", owner.userId);
    expect(issues.filter((i) => i.kind === "profile_inventory_conflict")).toHaveLength(result.conflicts.length);
    expect(issues.filter((i) => i.kind === "quantity_not_stated")).toHaveLength(3);

    // Idempotent: running the import again returns stored receipts and changes nothing.
    const commandsBefore = (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n;
    const again = await importOwnerData(h.service, owner.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] }), docs);
    expect(again.replayed).toBe(again.receipts);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n).toBe(commandsBefore);
    expect((await listInventory(h.db, p, {}, { nowMs: h.clock.now() })).total).toBe(127);
  });

  it("refuses a profile that is not the supplied edition, and the import channel needs the admin scope", async () => {
    const h = await createHarness();
    const owner = await h.createOwner({ synthetic: true });
    const docs = ownerDocuments();
    const admin = owner.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] });
    await expect(importOwnerData(h.service, admin, { ...docs, profileText: docs.profileText.replace("Rotterdam", "Amsterdam") })).rejects.toThrow(/hash mismatch/);
    const notAdmin = owner.principal({ channel: "import", actor: "system", scopes: ["read", "write"] });
    expect((await importOwnerData(h.service, notAdmin, docs).catch((e) => e)).code).toBe("forbidden");
    expect(await all(h.db, "SELECT 1 FROM garments WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect(await all(h.db, "SELECT 1 FROM style_documents WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });
});
