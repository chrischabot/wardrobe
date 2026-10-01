/**
 * Builds the inventory import report from the supplied documents (Node script; no database).
 *
 *   npm run import:report          # write data/import/inventory-import-report.{md,json}
 *   npm run import:report -- --check   # exit 1 if the committed report is stale
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventoryImportPlan } from "../src/import/inventory.ts";
import { detectConflicts } from "../src/import/conflicts.ts";
import { importReportJson, renderImportReport } from "../src/import/report.ts";
import { OWNER_PROFILE_SHA256 } from "../src/import/profile.ts";
import { sha256Hex } from "../src/util.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const profileText = readFileSync(path.join(root, "requirements/chris-wardrobe-profile.md"), "utf8");
const csvText = readFileSync(path.join(root, "requirements/wardrobe_inventory_clean.csv"), "utf8");

const profileSha = await sha256Hex(new TextEncoder().encode(profileText));
if (profileSha !== OWNER_PROFILE_SHA256) throw new Error(`profile hash mismatch: ${profileSha}`);

const plan = await buildInventoryImportPlan(csvText);
const conflicts = detectConflicts(plan, profileText);
const md = renderImportReport(plan, conflicts);
const json = JSON.stringify(importReportJson(plan, conflicts), null, 2) + "\n";
const outDir = path.join(root, "data/import");
const mdPath = path.join(outDir, "inventory-import-report.md");
const jsonPath = path.join(outDir, "inventory-import-report.json");

if (process.argv.includes("--check")) {
  const stale = readFileSync(mdPath, "utf8") !== md || readFileSync(jsonPath, "utf8") !== json;
  if (stale) {
    console.error("data/import/inventory-import-report.* is stale; run `npm run import:report`");
    process.exit(1);
  }
  console.log("import report is up to date");
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(mdPath, md);
  writeFileSync(jsonPath, json);
  const t = plan.totals;
  console.log(`lines ${t.physicalLines}: imported ${t.imported}, merged ${t.merged}, held ${t.held}, not data ${t.notDataRows}; garments ${t.garments}, units ${t.units}; conflicts ${conflicts.length}; issues ${plan.issues.length}`);
}
