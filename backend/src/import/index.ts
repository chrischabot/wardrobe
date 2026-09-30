/** Public interface of the import boundary (spec section 16). */
export { parseCsv, type CsvRow } from './csv.js';
export { importDataset, type ImportOptions, type ImportResult } from './importer.js';
export { mapInventory, readInventoryCsv, mapStatus, categoryOf, colourFamily, temperatureRange, PROFILE_CLAIMS, INVENTORY_SOURCE_SYSTEM, INVENTORY_FILE, type InventoryMapping } from './owner-inventory.js';
export { buildOwnerDataset, importOwnerData, SPEC_PROFILE_SHA256, PROFILE_SOURCE_ID, type OwnerSources, type OwnerDataset } from './owner.js';
export { buildInventoryReconciliation, renderReconciliationMarkdown, type ReconciliationReport } from './reconciliation.js';
export { applyOwnerAssertedAdditions, parseOwnerAdditions, additionIdempotencyKey, additionRestricted, OwnerAdditionsFile, OWNER_ANSWER_SOURCE_SYSTEM, type OwnerAdditionsResult } from './owner-additions.js';
