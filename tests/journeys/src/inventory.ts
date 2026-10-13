/**
 * An INDEPENDENT reading of the owner's supplied inventory sheet, used by the journeys' own checks.
 *
 * It is written from the sheet's columns alone and shares no code with the product's importer or
 * validator: the journeys compare what the Worker offers against what the owner's own document says.
 * The sheet text is imported verbatim (`?raw`), so nothing here reads the product's parsed records.
 */
import sheet from "../../../requirements/wardrobe_inventory_clean.csv?raw";

export interface SheetRow {
  line: number;
  category: "Footwear" | "Shirt" | "Trouser" | "Outerwear" | "Accessory" | "Sock";
  item: string;
  colour: string;
  fabric: string;
  brand: string;
  size: string;
  season: string;
  status: string;
  notes: string;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

const CATEGORIES = new Set(["Footwear", "Shirt", "Trouser", "Outerwear", "Accessory", "Sock"]);

/** Every data row of the sheet (the title line and the header line are not data). */
export const SHEET_ROWS: SheetRow[] = parseCsv(sheet as string)
  .map((cells, index) => ({ cells, line: index + 1 }))
  .filter(({ cells }) => CATEGORIES.has(cells[0] ?? ""))
  .map(({ cells, line }) => ({ line, category: cells[0] as SheetRow["category"], item: cells[1]!, colour: cells[2]!, fabric: cells[3]!, brand: cells[4]!, size: cells[5]!, season: cells[6]!, status: cells[7]!, notes: cells[8]! }));

/** Total lines in the sheet, including the title and header. */
export const SHEET_LINE_COUNT = parseCsv(sheet as string).length;

/** Pairs of socks a sheet row stands for ("2x" in the notes); every other row is one unit. */
export const unitsOf = (row: SheetRow): number => (row.category === "Sock" ? Number(/^(\d+)x$/.exec(row.notes.trim())?.[1] ?? 1) : 1);

const norm = (s: string) => s.toLowerCase().replace(/\s*\(pair \d\)\s*/g, "").replace(/\s+/g, " ").trim();

/**
 * The sheet rows behind a garment name the Worker shows. The sheet repeats some item names across
 * colours ("NB 990v4" three times), so a displayed name is matched as the item, or as `item — colour`.
 */
export function sheetRowsFor(displayName: string): SheetRow[] {
  const wanted = norm(displayName);
  const exact = SHEET_ROWS.filter((r) => norm(r.item) === wanted);
  if (exact.length > 0) return exact;
  return SHEET_ROWS.filter((r) => wanted.startsWith(`${norm(r.item)} — `) && norm(r.colour).startsWith(wanted.slice(norm(r.item).length + 3).split(/[ (/]/)[0]!));
}

export const isBenched = (row: SheetRow): boolean => /benched/i.test(row.status);
export const isSneaker = (row: SheetRow): boolean => row.category === "Footwear" && /new balance/i.test(row.brand);
export const isWelted = (row: SheetRow): boolean => row.category === "Footwear" && !isSneaker(row);
