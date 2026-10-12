// Writes src/seed/owner-inventory.json: the owner's garments exactly as the existing TypeScript importer
// (packages/domain/src/import/inventory.ts) plans them from requirements/wardrobe_inventory_clean.csv.
// The Rust app embeds that file, so the Ferrite port never re-implements the import rules and cannot
// drift from them silently.
//
//   node --experimental-strip-types ferrite/scripts/build-seed.mjs          # write
//   node --experimental-strip-types ferrite/scripts/build-seed.mjs --check  # exit 1 when stale
//
// Run from the wardrobe repository root (Node 22.6 or later).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const { buildInventoryImportPlan } = await import(path.join(repo, "packages/domain/src/import/inventory.ts"));

const csvPath = path.join(repo, "requirements/wardrobe_inventory_clean.csv");
const csvText = readFileSync(csvPath, "utf8");
const plan = await buildInventoryImportPlan(csvText);

const garments = plan.garments.map((g) => {
  const p = g.payload;
  return {
    garmentId: g.garmentId,
    name: p.name,
    category: p.category,
    careChannel: p.careChannel,
    planningPolicy: p.planningPolicy,
    acquisition: p.acquisition,
    quantity: p.quantity,
    initialBucket: p.initialBucket,
    sourceRows: g.sourceRows,
  };
});

const header = {
  generatedBy: "ferrite/scripts/build-seed.mjs from packages/domain/src/import/inventory.ts",
  sourceName: plan.sourceName,
  sourceSha256: plan.sourceSha256,
  sourceBytes: plan.sourceBytes,
  importRunId: plan.importRunId,
  garmentCount: plan.totals.garments,
  unitCount: plan.totals.units,
};
// One garment per line keeps reviews of a changed inventory readable.
const text =
  "{\n" +
  Object.entries(header).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join("") +
  '  "garments": [\n' +
  garments.map((g) => `    ${JSON.stringify(g)}`).join(",\n") +
  "\n  ]\n}\n";

const outPath = path.join(repo, "ferrite/src/seed/owner-inventory.json");
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    current = "";
  }
  if (current !== text) {
    console.error("ferrite/src/seed/owner-inventory.json is stale; run node --experimental-strip-types ferrite/scripts/build-seed.mjs");
    process.exit(1);
  }
  console.log(`seed is up to date: ${garments.length} garments, ${header.unitCount} units, source sha256 ${header.sourceSha256}`);
} else {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  console.log(`wrote ${path.relative(repo, outPath)}: ${garments.length} garments, ${header.unitCount} units, source sha256 ${header.sourceSha256}`);
}
