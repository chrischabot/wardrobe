/**
 * Inventory import plan: a pure, deterministic mapping from the owner's inventory CSV to explicit
 * `garment.create` commands, with an accounting entry for EVERY source row.
 *
 * Rules of this importer (specification section 16, "Import only data"):
 *   - nothing is invented: a garment exists only because a row says so; no wear history is created;
 *     no restriction is lifted; unknown values stay unknown ("-" and blanks become null);
 *   - the sheet's single Status value is decomposed into acquisition, planning policy, condition and
 *     attributes, and the original text is preserved as a fact;
 *   - cleanliness was never observed by the new system, so stock is journaled with basis `import` and
 *     treated as an estimate until a laundry baseline or an owner report;
 *   - season text is preserved verbatim; a numeric temperature is only recorded when the sheet states
 *     one, and its basis (morning or peak) stays `unsettled`;
 *   - rows that describe interchangeable units of one product ("pair 1" / "pair 2") become one garment
 *     with a quantity, and the merged row records its explicit mapping.
 */
import type { FoundationPayload } from "@garderobe/contracts";
import { parseCsv } from "./csv.ts";
import { sha256Hex, stableId } from "../util.ts";

export type GarmentCreatePayload = FoundationPayload<"garment.create">;

export const EXPECTED_COLUMNS = [
  "Category", "Item", "Colour / Pattern", "Fabric / Material", "Brand", "Size", "Season", "Status", "Notes",
  "Source detail (fabric / construction)", "Price (£)", "Acquired", "Link", "Ref / PCF",
] as const;

export type RowDisposition = "imported" | "merged" | "held" | "not_a_data_row";

export interface RowAccount {
  /** 1-based line number in the CSV file. */
  sourceRow: number;
  sourceKey: string;
  disposition: RowDisposition;
  garmentId: string | null;
  garmentName: string | null;
  reason: string;
  raw: Record<string, string> | { text: string };
}

export interface ImportIssue {
  issueId: string;
  kind: string;
  severity: "info" | "conflict" | "needs_owner";
  detail: string;
  garmentId: string | null;
  sourceRows: number[];
}

export interface PlannedGarment {
  garmentId: string;
  sourceRows: number[];
  payload: GarmentCreatePayload;
  /** Original Status text from the sheet. */
  statusText: string;
}

export interface InventoryImportPlan {
  sourceName: string;
  sourceSha256: string;
  sourceBytes: number;
  importRunId: string;
  title: string | null;
  rows: RowAccount[];
  garments: PlannedGarment[];
  issues: ImportIssue[];
  totals: {
    physicalLines: number;
    dataRows: number;
    imported: number;
    merged: number;
    held: number;
    notDataRows: number;
    garments: number;
    units: number;
    byCategory: Record<string, { rows: number; garments: number; units: number }>;
    byPlanningPolicy: Record<string, number>;
  };
}

const blank = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" || t === "-" ? null : t;
};

interface CategoryMapping {
  category: GarmentCreatePayload["category"];
  roles: GarmentCreatePayload["roles"];
  careChannel: GarmentCreatePayload["careChannel"];
}

function mapCategory(category: string, item: string): CategoryMapping | null {
  const lower = item.toLowerCase();
  switch (category) {
    case "Footwear":
      return { category: "footwear", roles: ["footwear"], careChannel: "none" };
    case "Shirt":
      return { category: "shirt", roles: ["top"], careChannel: "service" };
    case "Trouser":
      return { category: "trousers", roles: ["bottom"], careChannel: "service" };
    case "Outerwear":
      return { category: "outerwear", roles: ["outer"], careChannel: "none" };
    case "Sock":
      return { category: "socks", roles: ["socks"], careChannel: "handwash" };
    case "Accessory":
      if (lower.includes("belt")) return { category: "belt", roles: ["belt"], careChannel: "none" };
      if (lower.includes("tie")) return { category: "tie", roles: ["neckwear"], careChannel: "none" };
      if (lower.includes("pocket square")) return { category: "pocket_square", roles: ["accessory"], careChannel: "none" };
      if (lower.includes("scarf") || lower.includes("bandana") || lower.includes("polka-dot")) return { category: "scarf", roles: ["neckwear"], careChannel: "none" };
      return { category: "accessory", roles: ["accessory"], careChannel: "none" };
    default:
      return null;
  }
}

function fabricClass(category: string, item: string, fabric: string | null): string | undefined {
  const f = `${item} ${fabric ?? ""}`.toLowerCase();
  if (category === "Sock") return f.includes("alpaca") ? "alpaca" : f.includes("merino") ? "merino" : undefined;
  if (category !== "Shirt" && category !== "Trouser" && category !== "Outerwear") return undefined;
  if (f.includes("wool") && f.includes("linen")) return undefined; // a blend: no single class claimed
  if (f.includes("cotton-linen") || f.includes("cotton sunwashed + linen") || f.includes("cotton and linen")) return "cotton_linen";
  if (f.includes("linen")) return "pure_linen";
  if (f.includes("lightweight oxford") || f.includes("washed cotton oxford")) return "lightweight_oxford";
  if (f.includes("pima oxford") || f.includes("(heavier)") && f.includes("oxford")) return "heavy_oxford";
  if (f.includes("flannel") && !f.includes("wool")) return "flannel";
  if (f.includes("wool")) return "wool";
  if (f.includes("denim")) return "denim";
  if (f.includes("cord")) return "corduroy";
  if (f.includes("twill")) return "twill";
  return undefined; // unknown stays unknown (e.g. "Oxford" with no stated weight)
}

/** Numeric temperature bounds exactly as the sheet states them; the basis is not stated, so it stays unsettled. */
function thermalFrom(season: string | null, notes: string | null): GarmentCreatePayload["thermal"] {
  const text = `${season ?? ""} | ${notes ?? ""}`;
  let m = /(\d+)\s*-\s*(\d+)\s*°C/.exec(text);
  if (m) return { minC: Number(m[1]), maxC: Number(m[2]), basis: "unsettled", source: `inventory CSV Season: "${season}"` };
  m = /To\s+(\d+)\s*°C/i.exec(text);
  if (m) return { maxC: Number(m[1]), basis: "unsettled", source: `inventory CSV Season: "${season}"` };
  m = /(\d+)\s*°C\+/.exec(text);
  if (m) return { minC: Number(m[1]), basis: "unsettled", source: `inventory CSV Season/Notes: "${season}"${notes ? ` / "${notes}"` : ""}` };
  return null;
}

interface StatusDecomposition {
  planningPolicy: "normal" | "occasional" | "excluded";
  planningReason: string | null;
  condition: string | null;
  attributes: Record<string, unknown>;
  recognised: boolean;
}

/** Decompose the sheet's overloaded Status into separate facts. Unrecognised text is held for the owner. */
function decomposeStatus(status: string, notes: string | null): StatusDecomposition {
  const s = status.trim();
  const base = { planningPolicy: "normal" as const, planningReason: null, condition: null, attributes: {}, recognised: true };
  if (s === "Active") return base;
  if (s === "Breaking in") return { ...base, condition: "breaking in", attributes: { breakingIn: true } };
  if (s === "Active (layering tier)") return { ...base, planningReason: "layering tier", attributes: { layeringOnly: true } };
  if (s === "Secondary/layering") return { ...base, planningReason: "secondary; layering", attributes: { layeringOnly: true } };
  if (s === "Active (a bit large)") return { ...base, condition: "a bit large", attributes: { fitNote: `a bit large${notes ? `; ${notes.toLowerCase()}` : ""}` } };
  if (s === "Occasional") return { ...base, planningPolicy: "occasional", planningReason: "marked Occasional in the inventory sheet" };
  if (s.startsWith("Benched")) {
    const why = s.replace(/^Benched\s*/, "").replace(/^\(|\)$/g, "");
    const reason = [why, notes].filter(Boolean).join("; ");
    return { ...base, planningPolicy: "excluded", planningReason: `benched${reason ? `: ${reason}` : ""}`, attributes: why.includes("too large") ? { fitNote: why } : {} };
  }
  return { ...base, recognised: false };
}

function footwearAttributes(item: string, brand: string | null, notes: string | null): Record<string, unknown> {
  const lower = item.toLowerCase();
  if (brand === "New Balance") {
    const model = /(\d{3}v\d)/i.exec(item)?.[1]?.toLowerCase();
    return { footwearKind: "sneaker", ...(model ? { model } : {}) };
  }
  // The profile places Paraboot in "the welted half of the fleet"; the sheet calls the Reims a "Welted derby".
  if (brand === "Paraboot" || (notes ?? "").toLowerCase().includes("welted")) return { footwearKind: "welted", model: item.replace(/^Paraboot\s+/, "") };
  if (/\bboot\b/.test(lower)) return { footwearKind: "boot", model: item.replace(/^Drake's\s+/, "") };
  return { footwearKind: "other" };
}

export async function buildInventoryImportPlan(csvText: string, sourceName = "wardrobe_inventory_clean.csv"): Promise<InventoryImportPlan> {
  const bytes = new TextEncoder().encode(csvText);
  const sourceSha256 = await sha256Hex(bytes);
  const importRunId = `imp_${sourceSha256.slice(0, 16)}`;
  const parsed = parseCsv(csvText);
  const rows: RowAccount[] = [];
  const issues: ImportIssue[] = [];
  const garments: PlannedGarment[] = [];
  let title: string | null = null;
  const issue = (kind: string, severity: ImportIssue["severity"], detail: string, garmentId: string | null, sourceRows: number[]) =>
    issues.push({ issueId: `${importRunId}_${String(issues.length + 1).padStart(3, "0")}`, kind, severity, detail, garmentId, sourceRows });

  // Locate the header: the first row whose cells equal the expected column names.
  const headerIndex = parsed.findIndex((r) => r.fields[0]?.trim() === "Category" && r.fields[1]?.trim() === "Item");
  if (headerIndex === -1) throw new Error("inventory CSV: header row (Category, Item, ...) not found");
  const header = parsed[headerIndex]!.fields.map((f) => f.trim());
  for (const [i, col] of EXPECTED_COLUMNS.entries()) {
    if (header[i] !== col) throw new Error(`inventory CSV: expected column ${i + 1} to be "${col}" but found "${header[i] ?? ""}"`);
  }
  for (const r of parsed.slice(0, headerIndex)) {
    const text = r.fields.filter((f) => f.trim() !== "").join(" ");
    title ??= text;
    rows.push({ sourceRow: r.line, sourceKey: `line:${r.line}`, disposition: "not_a_data_row", garmentId: null, garmentName: null, reason: "sheet title row", raw: { text } });
  }
  rows.push({ sourceRow: parsed[headerIndex]!.line, sourceKey: `line:${parsed[headerIndex]!.line}`, disposition: "not_a_data_row", garmentId: null, garmentName: null, reason: "column header row", raw: { text: header.join(" | ") } });

  const data = parsed.slice(headerIndex + 1).map((r) => {
    const record: Record<string, string> = {};
    EXPECTED_COLUMNS.forEach((col, i) => (record[col] = r.fields[i] ?? ""));
    return { line: r.line, record, extraCells: r.fields.length > EXPECTED_COLUMNS.length ? r.fields.slice(EXPECTED_COLUMNS.length).filter((f) => f.trim() !== "") : [] };
  });

  // Names must be distinguishable at the wardrobe: when several rows share an Item text, add the colour.
  const itemCounts = new Map<string, number>();
  const lotKey = (rec: Record<string, string>) => `${rec.Category}|${rec.Item!.replace(/\s*\(pair \d+\)\s*$/i, "").trim()}`;
  for (const d of data) {
    const k = `${d.record.Category}|${d.record.Item!.trim()}`;
    itemCounts.set(k, (itemCounts.get(k) ?? 0) + 1);
  }

  const lots = new Map<string, PlannedGarment>();
  for (const d of data) {
    const rec = d.record;
    const category = rec.Category!.trim();
    const item = rec.Item!.trim();
    const sourceKey = `line:${d.line}`;
    const hold = (reason: string) => {
      rows.push({ sourceRow: d.line, sourceKey, disposition: "held", garmentId: null, garmentName: item || null, reason, raw: rec });
      issue("row_held", "needs_owner", `Line ${d.line} ("${item}") was not imported: ${reason}`, null, [d.line]);
    };
    if (!category && !item) {
      rows.push({ sourceRow: d.line, sourceKey, disposition: "not_a_data_row", garmentId: null, garmentName: null, reason: "empty row", raw: rec });
      continue;
    }
    const mapping = mapCategory(category, item);
    if (!mapping) {
      hold(`unrecognised category "${category}"`);
      continue;
    }
    if (!item) {
      hold("the row has no item name");
      continue;
    }
    const notes = blank(rec.Notes);
    const status = decomposeStatus(rec.Status ?? "", notes);
    if (!status.recognised) {
      hold(`status "${rec.Status}" cannot be interpreted without supporting facts`);
      continue;
    }
    if (d.extraCells.length > 0) issue("extra_cells", "info", `Line ${d.line} has ${d.extraCells.length} cell(s) beyond the 14 named columns; they are preserved in the raw row only.`, null, [d.line]);

    const colour = blank(rec["Colour / Pattern"]);
    const fabric = blank(rec["Fabric / Material"]);
    const brandRaw = blank(rec.Brand);
    const maker = brandRaw === "(pre-sheet)" ? null : brandRaw;
    const size = blank(rec.Size);
    const season = blank(rec.Season);
    const sourceDetail = blank(rec["Source detail (fabric / construction)"]);
    const ref = blank(rec["Ref / PCF"]);
    const pairMatch = /\(pair (\d+)\)\s*$/i.exec(item);
    const baseItem = item.replace(/\s*\(pair \d+\)\s*$/i, "").trim();
    const key = lotKey(rec);
    const garmentId = await stableId("gmt", "inventory-csv", key, pairMatch ? "" : `${colour ?? ""}|${size ?? ""}`);

    // Interchangeable units of one product: later "pair N" rows add a unit to the first row's garment.
    const existingLot = pairMatch ? lots.get(key) : undefined;
    if (existingLot) {
      const p = existingLot.payload;
      const same = p.colour === colour && p.fabric === fabric && p.size === size && p.maker === maker && existingLot.statusText === (rec.Status ?? "").trim();
      if (!same) {
        hold(`"${item}" looks like another unit of "${p.name}" but its colour, fabric, size, brand or status differs`);
        continue;
      }
      p.quantity = (p.quantity ?? 1) + 1;
      existingLot.sourceRows.push(d.line);
      rows.push({
        sourceRow: d.line,
        sourceKey,
        disposition: "merged",
        garmentId: existingLot.garmentId,
        garmentName: p.name,
        reason: `interchangeable unit of "${p.name}" (same product, colour, fabric, size and status as line ${existingLot.sourceRows[0]}); merged as quantity ${p.quantity}`,
        raw: rec,
      });
      continue;
    }

    const duplicateItem = (itemCounts.get(`${category}|${item}`) ?? 0) > 1;
    const name = duplicateItem && colour ? `${baseItem} — ${colour.toLowerCase()}` : baseItem;
    const attributes: Record<string, unknown> = { ...status.attributes };
    const fc = fabricClass(category, item, fabric);
    if (fc) attributes.fabricClass = fc;
    if (category === "Footwear") Object.assign(attributes, footwearAttributes(item, maker, notes));
    if (category === "Outerwear") attributes.jacketLike = true;
    if (category === "Sock" && (notes ?? "").toLowerCase().includes("bed sock")) attributes.indoorOnly = true;

    let quantity = 1;
    if (category === "Sock") {
      const q = /^(\d+)x$/i.exec(notes ?? "");
      if (q) quantity = Number(q[1]);
      else issue("quantity_not_stated", "needs_owner", `Line ${d.line} ("${item}") gives no pair count; imported as 1 pair, the minimum the row establishes. Correct the count with a reconciliation if more are owned.`, garmentId, [d.line]);
    }

    const source = { kind: "import" as const, ref: `${sourceName}#line:${d.line}`, note: "inventory sheet (clean master, May 2026); historical evidence, not a live observation" };
    const facts: NonNullable<GarmentCreatePayload["facts"]> = [{ attribute: "import_status", value: rec.Status ?? "", source, scope: "inventory sheet, May 2026" }];
    if (notes) facts.push({ attribute: "import_notes", value: notes, source, scope: null });
    if (season) facts.push({ attribute: "import_season", value: season, source, scope: null });
    const price = blank(rec["Price (£)"]);
    if (price) facts.push({ attribute: "purchase_price", value: { amount: price, currency: "GBP" }, source, scope: null });
    const acquired = blank(rec.Acquired);
    if (acquired) facts.push({ attribute: "acquired_on", value: acquired, source, scope: null });
    if (brandRaw === "(pre-sheet)") facts.push({ attribute: "maker", value: null, source: { ...source, note: 'Brand recorded as "(pre-sheet)": acquired before the sheet existed; maker unknown' }, scope: null });
    const link = blank(rec.Link);
    if (link) {
      if (/^https?:\/\//i.test(link)) facts.push({ attribute: "purchase_link", value: link, source, scope: null });
      else issue("link_without_url", "info", `Line ${d.line} ("${item}") has the Link cell "${link}" but no URL survived the export; no purchase link was recorded.`, garmentId, [d.line]);
    }
    if (category === "Outerwear") facts.push({ attribute: "jacket_like", value: true, source: { kind: "system", note: "importer interpretation: every outer layer counts as a jacket for the 14-16 C layering rule" }, scope: null });

    const aliases: NonNullable<GarmentCreatePayload["aliases"]> = [];
    if (name !== item) aliases.push({ phrase: item, kind: "import" });
    if (ref) aliases.push({ phrase: ref, kind: "code" });
    if (sourceDetail) aliases.push({ phrase: sourceDetail.split(" · ")[0]!.split(" | ")[0]!.trim(), kind: "maker_name" });
    const sheetName = /(?:Sheet mislabels as|a\.k\.a\.)\s*'?([^')]+)'?/i.exec(notes ?? "")?.[1];
    if (sheetName) aliases.push({ phrase: sheetName.trim(), kind: "import" });

    const payload: GarmentCreatePayload = {
      garmentId,
      name,
      category: mapping.category,
      roles: mapping.roles,
      maker,
      product: sourceDetail,
      fabric,
      colour,
      pattern: null,
      size,
      careChannel: mapping.careChannel,
      planningPolicy: status.planningPolicy,
      planningReason: status.planningReason,
      condition: status.condition,
      seasonNote: season,
      thermal: thermalFrom(season, notes),
      attributes,
      aliases,
      acquisition: "owned",
      quantity,
      initialBucket: "clean",
      wearLoggingSince: null,
      isSynthetic: false,
      source,
      facts,
    };
    const planned: PlannedGarment = { garmentId, sourceRows: [d.line], payload, statusText: (rec.Status ?? "").trim() };
    garments.push(planned);
    if (pairMatch) lots.set(key, planned);
    rows.push({ sourceRow: d.line, sourceKey, disposition: "imported", garmentId, garmentName: name, reason: `imported as ${mapping.category}, quantity ${quantity}, planning policy ${status.planningPolicy}`, raw: rec });
  }

  // Final reasons carry the merged quantity for the canonical row.
  for (const g of garments) {
    const account = rows.find((r) => r.sourceRow === g.sourceRows[0])!;
    account.reason = `imported as ${g.payload.category}, quantity ${g.payload.quantity}, planning policy ${g.payload.planningPolicy}` + (g.sourceRows.length > 1 ? ` (units from lines ${g.sourceRows.join(", ")})` : "");
  }
  const ids = new Set<string>();
  for (const g of garments) {
    if (ids.has(g.garmentId)) throw new Error(`inventory CSV: two rows map to the same garment identity (${g.payload.name}); refine the identity key`);
    ids.add(g.garmentId);
  }

  const byCategory: InventoryImportPlan["totals"]["byCategory"] = {};
  const byPlanningPolicy: Record<string, number> = {};
  for (const g of garments) {
    const c = (byCategory[g.payload.category] ??= { rows: 0, garments: 0, units: 0 });
    c.rows += g.sourceRows.length;
    c.garments += 1;
    c.units += g.payload.quantity ?? 1;
    const policy = g.payload.planningPolicy ?? "normal";
    byPlanningPolicy[policy] = (byPlanningPolicy[policy] ?? 0) + 1;
  }
  const count = (d: RowDisposition) => rows.filter((r) => r.disposition === d).length;
  rows.sort((a, b) => a.sourceRow - b.sourceRow);
  return {
    sourceName,
    sourceSha256,
    sourceBytes: bytes.byteLength,
    importRunId,
    title,
    rows,
    garments,
    issues,
    totals: {
      physicalLines: rows.length,
      dataRows: count("imported") + count("merged") + count("held"),
      imported: count("imported"),
      merged: count("merged"),
      held: count("held"),
      notDataRows: count("not_a_data_row"),
      garments: garments.length,
      units: garments.reduce((n, g) => n + (g.payload.quantity ?? 1), 0),
      byCategory,
      byPlanningPolicy,
    },
  };
}
