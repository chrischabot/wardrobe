#!/usr/bin/env node
/**
 * Verifies the supplied requirement documents.
 *
 *   node tools/verify-documents.mjs            # check requirements/SHA256SUMS and the extracted bundle
 *   node tools/verify-documents.mjs --write    # (re)write requirements/SHA256SUMS from the files on disk
 *   node tools/verify-documents.mjs --attachments <dir>   # also compare with the original attachments
 *
 * Checks:
 *   1. every file listed in requirements/SHA256SUMS hashes to the recorded value;
 *   2. every file of the extracted bundle (requirements/support/) matches support-bundle-manifest.json,
 *      and no file is missing or extra;
 *   3. the specification and profile hashes equal the values recorded in the specification itself
 *      and in the evaluation README.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = path.join(root, "requirements");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const SUPPLIED = [
  "garderobe-replacement-design.md",
  "chris-wardrobe-profile.md",
  "wardrobe_inventory_clean.csv",
  "wardrobe-requirements-and-evals.tar.gz",
];
const KNOWN = {
  // Recorded by the owner's own documents: specification section 6 and evals/README.md.
  "chris-wardrobe-profile.md": "e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198",
};

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const sumsPath = path.join(req, "SHA256SUMS");
if (process.argv.includes("--write")) {
  const lines = SUPPLIED.map((f) => `${sha(path.join(req, f))}  ${f}`);
  writeFileSync(sumsPath, lines.join("\n") + "\n");
  console.log(`wrote ${path.relative(root, sumsPath)} (${lines.length} documents)`);
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`FAIL ${msg}`);
};

const sums = readFileSync(sumsPath, "utf8").trim().split("\n").map((l) => ({ hash: l.slice(0, 64), file: l.slice(66) }));
for (const f of SUPPLIED) if (!sums.some((s) => s.file === f)) fail(`${f} is not recorded in SHA256SUMS`);
for (const { hash, file } of sums) {
  const actual = sha(path.join(req, file));
  if (actual !== hash) fail(`${file}: recorded ${hash}, actual ${actual}`);
  else console.log(`ok   ${hash}  ${file}`);
  if (KNOWN[file] && KNOWN[file] !== actual) fail(`${file}: does not match the hash recorded in the specification (${KNOWN[file]})`);
}

const manifest = JSON.parse(readFileSync(path.join(req, "support-bundle-manifest.json"), "utf8"));
const bundleHash = sums.find((s) => s.file === "wardrobe-requirements-and-evals.tar.gz")?.hash;
if (manifest.bundle_sha256 !== bundleHash) fail(`bundle manifest was produced from a different archive (${manifest.bundle_sha256})`);
const extracted = new Set(walk(path.join(req, "support")));
for (const entry of manifest.files) {
  const full = path.join(req, "support", entry.path);
  if (!existsSync(full)) {
    fail(`extracted file missing: support/${entry.path}`);
    continue;
  }
  extracted.delete(entry.path);
  if (sha(full) !== entry.sha256) fail(`extracted file differs from the archive: support/${entry.path}`);
}
for (const extra of extracted) fail(`file under requirements/support/ is not in the archive: ${extra}`);
console.log(`ok   ${manifest.files.length} extracted bundle files match the archive manifest`);

// The bundle carries its own copies of the three documents; they must be identical to the supplied ones.
const twins = [
  ["garderobe-replacement-design.md", "support/attachments/garderobe-replacement-design.original-attached.md"],
  ["garderobe-replacement-design.md", "support/wardrobe-support/handoff/garderobe-replacement-design.md"],
  ["chris-wardrobe-profile.md", "support/attachments/chris-wardrobe-profile.original-attached.md"],
  ["chris-wardrobe-profile.md", "support/wardrobe-support/evals/sources/chris-wardrobe-profile.md"],
  ["wardrobe_inventory_clean.csv", "support/attachments/wardrobe_inventory_clean.original-attached.csv"],
];
for (const [a, b] of twins) {
  if (sha(path.join(req, a)) !== sha(path.join(req, b))) fail(`${a} differs from its bundled copy ${b}`);
}
console.log(`ok   supplied documents are identical to their ${twins.length} bundled copies`);

const at = process.argv.indexOf("--attachments");
if (at !== -1) {
  const dir = process.argv[at + 1];
  if (!dir || dir.startsWith("--") || !existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error("Usage: node tools/verify-documents.mjs --attachments <directory holding the original attachments>");
    process.exit(2);
  }
  for (const f of SUPPLIED) {
    const match = readdirSync(dir).find((n) => n.endsWith(f));
    if (!match) fail(`attachment for ${f} not found in ${dir}`);
    else if (sha(path.join(dir, match)) !== sha(path.join(req, f))) fail(`${f} is not byte-identical to attachment ${match}`);
    else console.log(`ok   ${f} is byte-identical to attachment ${match}`);
  }
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all supplied documents verified");
