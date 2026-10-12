#!/usr/bin/env node
/**
 * The committed example of an outfit preview (examples/real-owner-outfit/).
 *
 *   node tools/composite-example.mjs            draw the preview again and write the files
 *   node tools/composite-example.mjs --check    check the committed files against each other AND against what the code draws now
 *   node tools/composite-example.mjs --from-log <file>   write the files from the saved output of a test run
 *
 * Writing runs test/composite-example.test.ts with GARDEROBE_EMIT_COMPOSITE_EXAMPLE=1: the preview is drawn by
 * the real path (the owner's real inventory imported through the command service, the preview command, the
 * local queue, the compositor, private local R2) and the test prints the three files, which are stored here
 * unchanged. Nothing is drawn by this script itself.
 *
 * The check has two parts, and fails if either does. First, without a test run: SHA256SUMS matches the files,
 * the picture is a PNG of the manifest's canvas size, and the SVG's hash is the one example.json records; a
 * missing example directory fails it. Second, it runs the comparison test in test/composite-example.test.ts with
 * file writing switched off (GARDEROBE_EMIT_COMPOSITE_EXAMPLE=0): the preview is drawn again through the real
 * path and the committed manifest, manifest hash, SVG text and decoded picture pixels must equal it. Stale or
 * swapped files with recomputed checksums therefore fail the check; a comparison that was skipped or did not
 * run also fails it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(pkg, "examples/real-owner-outfit");
const FILES = ["example.json", "preview.png", "preview.svg"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function check() {
  const problems = [];
  if (!existsSync(dir)) {
    // The example is part of the package: its absence is a failure, not "nothing to check".
    console.error("FAIL composite example missing: examples/real-owner-outfit/ does not exist (write it with node tools/composite-example.mjs)");
    process.exit(1);
  }
  for (const name of [...FILES, "SHA256SUMS"]) if (!existsSync(path.join(dir, name))) problems.push(`missing ${name}`);
  if (problems.length === 0) {
    const sums = new Map(readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => line.split(/\s+/).reverse()));
    for (const name of FILES) if (sums.get(name) !== sha256(readFileSync(path.join(dir, name)))) problems.push(`${name} does not match SHA256SUMS`);
    const example = JSON.parse(readFileSync(path.join(dir, "example.json"), "utf8"));
    const png = readFileSync(path.join(dir, "preview.png"));
    if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") problems.push("preview.png is not a PNG");
    else if (png.readUInt32BE(16) !== example.manifest.canvas.width || png.readUInt32BE(20) !== example.manifest.canvas.height) problems.push("preview.png is not the size of the manifest's canvas");
    if (sha256(readFileSync(path.join(dir, "preview.svg"))) !== example.preview.svgSha256) problems.push("preview.svg is not the scene example.json records");
    if (!/^[0-9a-f]{64}$/.test(example.manifestHash)) problems.push("example.json has no manifest hash");
    if (problems.length === 0) console.log(`composite example files agree: manifest ${example.manifestHash}, ${example.manifest.layers.length} layers, labels ${JSON.stringify(example.labels)}`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  compareWithDrawn();
}

const COMPARISON = "equals the committed files";

/** Runs the test's comparison of the committed files with a fresh drawing, with file writing switched off. */
function compareWithDrawn() {
  const run = spawnSync("npx", ["vitest", "run", "test/composite-example.test.ts", "--reporter=verbose"], {
    cwd: pkg,
    env: { ...process.env, GARDEROBE_EMIT_COMPOSITE_EXAMPLE: "0", NO_COLOR: "1", FORCE_COLOR: "0" },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  // The comparison must have run and passed: a passing exit with the comparison skipped is a failure too.
  const ran = output.split("\n").some((line) => line.includes(COMPARISON) && /[✓√]/.test(line));
  if (run.status !== 0 || !ran) {
    console.error(output.slice(-4000));
    console.error(`FAIL the committed example does not equal what the code draws now (test exit ${run.status}${ran ? "" : ", comparison not run"}); write it again with node tools/composite-example.mjs after an intended change`);
    process.exit(1);
  }
  console.log("composite example ok: the committed files equal the preview drawn now");
}

function write() {
  const fromLog = process.argv.indexOf("--from-log");
  let output;
  if (fromLog !== -1) {
    // The saved output of a test run that printed the files (the markers must be intact, one per line).
    output = readFileSync(process.argv[fromLog + 1], "utf8");
  } else {
    const run = spawnSync("npx", ["vitest", "run", "test/composite-example.test.ts"], { cwd: pkg, env: { ...process.env, GARDEROBE_EMIT_COMPOSITE_EXAMPLE: "1" }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    if (run.status !== 0) {
      console.error(output.slice(-4000));
      console.error(`the example test exited ${run.status}; nothing was written`);
      process.exit(1);
    }
  }
  const found = new Map();
  for (const m of output.matchAll(/@@GARDEROBE-EXAMPLE-FILE:([a-z.]+):([A-Za-z0-9+/=]+)@@/g)) found.set(m[1], Buffer.from(m[2], "base64"));
  for (const name of FILES) {
    if (!found.has(name)) {
      console.error(`the test run did not print ${name}; nothing was written`);
      process.exit(1);
    }
  }
  mkdirSync(dir, { recursive: true });
  for (const name of FILES) writeFileSync(path.join(dir, name), found.get(name));
  writeFileSync(path.join(dir, "SHA256SUMS"), FILES.map((name) => `${sha256(found.get(name))}  ${name}`).join("\n") + "\n");
  console.log(`wrote ${FILES.join(", ")} and SHA256SUMS to ${path.relative(process.cwd(), dir)}`);
  check();
}

if (process.argv.includes("--check")) check();
else write();
