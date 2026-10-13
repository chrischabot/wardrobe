// Pure spreadsheet import/export policy. Previews never apply anything; they
// describe what an import WOULD do. Cell text is data only: instruction-like
// text is flagged for the owner and otherwise handled like any other value.

export interface LedgerGarment { garmentId: string; name: string; quantity: number }
export interface SheetMapping { garmentId: string | null; name: string | null; quantity: string | null; unmapped: string[] }

export interface SheetRowChange {
  rowIndex: number;
  /** Row identity independent of row position: `id:<garment id>` or `name:<normalized name>`. */
  rowKey: string;
  kind: "create" | "reconcile" | "unchanged" | "skip";
  garmentId: string | null;
  name: string;
  quantity: number | null;
  ledgerQuantity: number | null;
  /** True when the quantity cell was blank or absent and one piece per row was assumed. */
  quantityAssumed: boolean;
  duplicate: boolean;
  instructionLikeText: boolean;
  reason: string | null;
}
export interface SheetDuplicate { rowKey: string; rowIndexes: number[] }
export interface SheetConflict { rowIndex: number; rowKey: string; garmentId: string; sheetQuantity: number; ledgerQuantity: number }
export interface SheetImportPreview { mapping: SheetMapping; changes: SheetRowChange[]; duplicates: SheetDuplicate[]; conflicts: SheetConflict[] }

const norm = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
const headerNorm = (value: string): string => norm(value).replace(/[^a-z0-9]/g, "");
const ID_HEADERS = ["garmentid", "itemid", "id"];
const NAME_HEADERS = ["name", "garment", "item", "description"];
const QUANTITY_HEADERS = ["quantity", "qty", "count", "units"];

const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)/i,
  /\bdelete\s+(all|everything)\b/i,
  /\byou\s+must\b/i,
  /\bsystem\s+prompt\b/i,
];

/** True when text reads like an instruction to the assistant rather than inventory data. */
export function isInstructionLike(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((p) => p.test(text));
}

function detectMapping(rows: Record<string, string>[]): SheetMapping {
  const headers: string[] = [];
  for (const row of rows) for (const h of Object.keys(row)) if (!headers.includes(h)) headers.push(h);
  const pick = (wanted: string[]): string | null => {
    for (const w of wanted) {
      const found = headers.find((h) => headerNorm(h) === w);
      if (found !== undefined) return found;
    }
    return null;
  };
  const mapping = { garmentId: pick(ID_HEADERS), name: pick(NAME_HEADERS), quantity: pick(QUANTITY_HEADERS) };
  const used = new Set([mapping.garmentId, mapping.name, mapping.quantity]);
  return { ...mapping, unmapped: headers.filter((h) => !used.has(h)) };
}

/** Describes what importing `rows` would change against `existing`, WITHOUT applying anything. */
export function previewSheetImport(rows: Record<string, string>[], existing: LedgerGarment[]): SheetImportPreview {
  const mapping = detectMapping(rows);
  const cell = (row: Record<string, string>, column: string | null): string => (column === null ? "" : (row[column] ?? "").trim());
  const changes: SheetRowChange[] = rows.map((row, rowIndex) => {
    const id = cell(row, mapping.garmentId);
    const name = cell(row, mapping.name);
    const rawQuantity = cell(row, mapping.quantity);
    const change: SheetRowChange = {
      rowIndex, rowKey: id ? `id:${id}` : `name:${norm(name)}`, kind: "skip", garmentId: null, name,
      quantity: null, ledgerQuantity: null, quantityAssumed: false, duplicate: false,
      instructionLikeText: Object.values(row).some((v) => isInstructionLike(v)), reason: null,
    };
    if (!id && !name) return { ...change, rowKey: `blank:${rowIndex}`, reason: "Row has neither an id nor a name." };
    if (rawQuantity === "") {
      change.quantity = 1;
      change.quantityAssumed = true;
    } else if (/^\d+$/.test(rawQuantity)) {
      change.quantity = Number.parseInt(rawQuantity, 10);
    } else {
      return { ...change, reason: `Quantity "${rawQuantity}" is not a whole number.` };
    }
    const matches = id ? existing.filter((g) => g.garmentId === id) : existing.filter((g) => norm(g.name) === norm(name));
    if (id && matches.length === 0) return { ...change, reason: `Garment id "${id}" is not in the ledger.` };
    if (matches.length > 1) return { ...change, reason: "More than one ledger garment has this name; the row cannot be matched." };
    const match = matches[0];
    if (!match) return { ...change, kind: "create" };
    change.garmentId = match.garmentId;
    change.ledgerQuantity = match.quantity;
    change.kind = match.quantity === change.quantity ? "unchanged" : "reconcile";
    return change;
  });

  const byKey = new Map<string, number[]>();
  for (const c of changes) {
    if (c.rowKey.startsWith("blank:")) continue;
    byKey.set(c.rowKey, [...(byKey.get(c.rowKey) ?? []), c.rowIndex]);
  }
  const duplicates: SheetDuplicate[] = [...byKey].filter(([, idx]) => idx.length > 1).map(([rowKey, rowIndexes]) => ({ rowKey, rowIndexes }));
  const duplicateKeys = new Set(duplicates.map((d) => d.rowKey));
  for (const c of changes) {
    if (!duplicateKeys.has(c.rowKey)) continue;
    c.duplicate = true;
    c.reason ??= "The same item appears in more than one row of the sheet.";
  }
  const conflicts: SheetConflict[] = [];
  for (const c of changes) {
    if (c.kind === "reconcile" && c.garmentId !== null && c.quantity !== null && c.ledgerQuantity !== null) {
      conflicts.push({ rowIndex: c.rowIndex, rowKey: c.rowKey, garmentId: c.garmentId, sheetQuantity: c.quantity, ledgerQuantity: c.ledgerQuantity });
    }
  }
  return { mapping, changes, duplicates, conflicts };
}

export interface SheetCommand { type: "garment.create" | "stock.reconcile"; payload: Record<string, unknown>; idempotencyKey: string }

/**
 * Commands an authorized import would issue. Duplicate, skipped and unchanged
 * rows issue none. Keys come from sheet identity + row identity (not row
 * position); a reconcile key also carries the target count, so repeating the
 * same import is a no-op while a later corrected count is a new command.
 */
export function commandsForPreview(preview: SheetImportPreview, sheetId: string): SheetCommand[] {
  const commands: SheetCommand[] = [];
  for (const c of preview.changes) {
    if (c.duplicate || c.quantity === null) continue;
    const source = { sheetId, rowKey: c.rowKey };
    if (c.kind === "create") {
      commands.push({
        type: "garment.create",
        payload: { name: c.name, quantity: c.quantity, quantityAssumed: c.quantityAssumed, instructionLikeText: c.instructionLikeText, source },
        idempotencyKey: `sheet:${sheetId}:${c.rowKey}:garment.create`,
      });
    } else if (c.kind === "reconcile" && c.garmentId !== null) {
      commands.push({
        type: "stock.reconcile",
        payload: { garmentId: c.garmentId, quantity: c.quantity, ledgerQuantity: c.ledgerQuantity, instructionLikeText: c.instructionLikeText, source },
        idempotencyKey: `sheet:${sheetId}:${c.rowKey}:stock.reconcile:${c.quantity}`,
      });
    }
  }
  return commands;
}

export interface InventoryExportItem { itemId: string; name: string; quantity: number; unit?: string; status?: string | null }
// A type alias (not an interface) so rows are assignable to the loose row type `diffReimport` accepts.
export type InventoryExportRow = { itemId: string; name: string; quantity: number; unit: string; status: string; revision: string; exportedAt: string };

/** One row per item, sorted by item id. A missing status is exported as the explicit value "unknown". */
export function buildInventoryExport(items: InventoryExportItem[], meta: { revision: string | number; exportedAt: string }): InventoryExportRow[] {
  return [...items]
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))
    .map((item) => ({
      itemId: item.itemId, name: item.name, quantity: item.quantity, unit: item.unit?.trim() || "pieces",
      status: item.status?.trim() || "unknown", revision: String(meta.revision), exportedAt: meta.exportedAt,
    }));
}

export interface ReimportCellChange { itemId: string; column: string; from: string; to: string }
export interface ReimportDiff {
  /** True when the ledger moved on after the export: the edits were made against old data. */
  stale: boolean;
  changedCells: ReimportCellChange[];
  addedRowIndexes: number[];
  removedItemIds: string[];
}

type LooseRow = Record<string, string | number>;

/** Reports what an edited export differs in. It never applies the edits; applying is a separate, authorized import. */
export function diffReimport(
  exportedRows: LooseRow[],
  editedRows: LooseRow[],
  revisions: { exportedRevision: string | number; currentRevision: string | number },
): ReimportDiff {
  const idOf = (row: LooseRow): string => String(row["itemId"] ?? "").trim();
  const exported = new Map(exportedRows.map((r) => [idOf(r), r]));
  const changedCells: ReimportCellChange[] = [];
  const addedRowIndexes: number[] = [];
  const seen = new Set<string>();
  editedRows.forEach((row, index) => {
    const itemId = idOf(row);
    const original = itemId ? exported.get(itemId) : undefined;
    if (!original || seen.has(itemId)) { addedRowIndexes.push(index); return; }
    seen.add(itemId);
    for (const column of [...new Set([...Object.keys(original), ...Object.keys(row)])].sort()) {
      const [from, to] = [String(original[column] ?? ""), String(row[column] ?? "")];
      if (from !== to) changedCells.push({ itemId, column, from, to });
    }
  });
  const removedItemIds = [...exported.keys()].filter((id) => id !== "" && !seen.has(id));
  return { stale: String(revisions.exportedRevision) !== String(revisions.currentRevision), changedCells, addedRowIndexes, removedItemIds };
}
