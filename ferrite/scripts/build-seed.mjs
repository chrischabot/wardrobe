// Writes src/seed/owner-inventory.json: the owner's garments exactly as the existing TypeScript importer
// (packages/domain/src/import/inventory.ts) plans them from requirements/wardrobe_inventory_clean.csv.
// Also writes src/seed/owner-style.json: the owner's profile verbatim (hash-checked) with the machine
// rules, dated measurements and size experiences the importer (packages/domain/src/import/apply.ts)
// records from it, each quoting its passage as `locatePassage` finds it.
// The Rust app embeds both files, so the Ferrite port never re-implements the import rules and cannot
// drift from them silently.
//
//   node --experimental-strip-types ferrite/scripts/build-seed.mjs          # write
//   node --experimental-strip-types ferrite/scripts/build-seed.mjs --check  # exit 1 when stale
//
// Run from the wardrobe repository root (Node 22.6 or later).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const { buildInventoryImportPlan } = await import(path.join(repo, "packages/domain/src/import/inventory.ts"));
const {
  PROFILE_RULES,
  PROFILE_MEASUREMENTS,
  PROFILE_SIZE_EXPERIENCES,
  HEALING_RESTRICTION_ID,
  OWNER_PROFILE_SHA256,
  OWNER_PROFILE_TITLE,
  OWNER_PROFILE_DATE,
  locatePassage,
} = await import(path.join(repo, "packages/domain/src/import/profile.ts"));

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
    roles: p.roles,
    colour: p.colour ?? null,
    attributes: p.attributes ?? {},
    // The sheet's season text and the temperature bounds the importer reads from it (basis unsettled);
    // the temperature preview checks them.
    seasonNote: p.seasonNote ?? null,
    thermal: p.thermal ?? null,
    sourceRows: g.sourceRows,
  };
});

// The profile's rules as the importer records them (key, kind, status, params): the board validator reads the
// ones it enforces from here, so their parameters are never retyped in Rust.
const rules = PROFILE_RULES.map((r) => ({ key: r.key, kind: r.kind, status: r.status, params: r.params }));

const header = {
  generatedBy: "ferrite/scripts/build-seed.mjs from packages/domain/src/import/inventory.ts",
  sourceName: plan.sourceName,
  sourceSha256: plan.sourceSha256,
  sourceBytes: plan.sourceBytes,
  importRunId: plan.importRunId,
  garmentCount: plan.totals.garments,
  unitCount: plan.totals.units,
  healingRestrictionId: HEALING_RESTRICTION_ID,
};
// One garment per line keeps reviews of a changed inventory readable.
const text =
  "{\n" +
  Object.entries(header).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join("") +
  '  "rules": [\n' +
  rules.map((r) => `    ${JSON.stringify(r)}`).join(",\n") +
  "\n  ],\n" +
  '  "garments": [\n' +
  garments.map((g) => `    ${JSON.stringify(g)}`).join(",\n") +
  "\n  ]\n}\n";

const inventoryPath = path.join(repo, "ferrite/src/seed/owner-inventory.json");

// The profile, verbatim: the importer refuses any other text, and so does this script.
const profileText = readFileSync(path.join(repo, "requirements/chris-wardrobe-profile.md"), "utf8");
const profileBytes = Buffer.byteLength(profileText, "utf8");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const profileSha = sha256(profileText);
if (profileSha !== OWNER_PROFILE_SHA256) {
  console.error(`requirements/chris-wardrobe-profile.md does not match the owner's profile: expected sha256 ${OWNER_PROFILE_SHA256}, got ${profileSha}`);
  process.exit(1);
}
// The importer runs every command at one import time this port does not have; the records carry the
// profile's own date instead.
const importedAt = `${OWNER_PROFILE_DATE}T00:00:00Z`;
const profileSource = { kind: "profile_passage", ref: `chris-wardrobe-profile.md@sha256:${profileSha}`, observedAt: importedAt };
// Record IDs derive from the importer's idempotency keys (`import:<sha16>:rule:<key>` and so on); the
// TypeScript service draws them at random, so they are this port's own.
const p16 = profileSha.slice(0, 16);
const idOf = (prefix, key) => `${prefix}_${sha256(`import:${p16}:${key}`).slice(0, 24)}`;
// SQLite's default collation compares UTF-8 bytes; the style query orders by it.
const byBytes = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

// `ORDER BY key`.
const styleRules = [...PROFILE_RULES]
  .sort((a, b) => byBytes(a.key, b.key))
  .map((r) => ({
    ruleId: idOf("rul", `rule:${r.key}`),
    version: 1,
    key: r.key,
    kind: r.kind,
    status: r.status,
    params: r.params,
    interpretation: r.interpretation,
    passages: r.quotes.map((q) => locatePassage(profileText, profileSha, q, r.section)),
    origin: r.origin,
    createdAt: importedAt,
  }));
// `ORDER BY subject, key` (every one is a body measurement).
const measurements = [...PROFILE_MEASUREMENTS]
  .sort((a, b) => byBytes(a.key, b.key))
  .map((m) => ({
    measurementId: idOf("msr", `measurement:${m.key}`),
    subject: "body",
    garmentId: null,
    key: m.key,
    value: m.value,
    unit: m.unit,
    convention: m.convention,
    qualifier: m.qualifier,
    measuredOn: null,
    source: profileSource,
    passage: locatePassage(profileText, profileSha, m.quote, "7"),
    supersededBy: null,
  }));
// `ORDER BY maker, created_at, rowid`: by maker, then in the order the importer records them.
const sizeExperiences = PROFILE_SIZE_EXPERIENCES.map((s, i) => ({
  sizeExperienceId: idOf("szx", `size:${i}`),
  maker: s.maker,
  productFamily: s.productFamily,
  sizeLabel: s.sizeLabel,
  note: s.note,
  notedOn: OWNER_PROFILE_DATE,
  passage: locatePassage(profileText, profileSha, s.quote, "7"),
})).sort((a, b) => byBytes(a.maker, b.maker));

const styleHeader = {
  generatedBy: "ferrite/scripts/build-seed.mjs from packages/domain/src/import/profile.ts and requirements/chris-wardrobe-profile.md",
  documentId: "owner-profile",
  version: 1,
  title: OWNER_PROFILE_TITLE,
  contentSha256: profileSha,
  byteLength: profileBytes,
  createdAt: importedAt,
};
const list = (name, items, last) => `  ${JSON.stringify(name)}: [\n` + items.map((x) => `    ${JSON.stringify(x)}`).join(",\n") + `\n  ]${last ? "" : ","}\n`;
const styleText =
  "{\n" +
  Object.entries(styleHeader).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`).join("") +
  `  "content": ${JSON.stringify(profileText)},\n` +
  list("rules", styleRules) +
  list("measurements", measurements) +
  list("sizeExperiences", sizeExperiences, true) +
  "}\n";
const stylePath = path.join(repo, "ferrite/src/seed/owner-style.json");

const outputs = [
  { file: inventoryPath, text },
  { file: stylePath, text: styleText },
];
if (process.argv.includes("--check")) {
  for (const { file, text: want } of outputs) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = "";
    }
    if (current !== want) {
      console.error(`${path.relative(repo, file)} is stale; run node --experimental-strip-types ferrite/scripts/build-seed.mjs`);
      process.exit(1);
    }
  }
  console.log(`seed is up to date: ${garments.length} garments, ${header.unitCount} units, source sha256 ${header.sourceSha256}; profile ${profileBytes} bytes, ${styleRules.length} rules, ${measurements.length} measurements, ${sizeExperiences.length} size experiences, sha256 ${profileSha}`);
} else {
  for (const { file, text: want } of outputs) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, want);
  }
  console.log(`wrote ${path.relative(repo, inventoryPath)}: ${garments.length} garments, ${header.unitCount} units, source sha256 ${header.sourceSha256}`);
  console.log(`wrote ${path.relative(repo, stylePath)}: profile ${profileBytes} bytes, ${styleRules.length} rules, ${measurements.length} measurements, ${sizeExperiences.length} size experiences, sha256 ${profileSha}`);
}
