// Tests of `node tools/composite-example.mjs --check` itself: it must reject a missing example, files that do
// not match their checksums, and stale or edited files whose checksums and recorded hashes were recomputed to
// look consistent, and it must accept an unchanged copy. Each case runs the real tool on a temporary copy of
// examples/real-owner-outfit/; the committed files are never touched.
//
//   node --test tools/composite-example.test.mjs     (in packages/media)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committed = path.join(pkg, "examples/real-owner-outfit");
const FILES = ["example.json", "preview.png", "preview.svg"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function copy() {
  const root = mkdtempSync(path.join(tmpdir(), "composite-example-check-"));
  const dir = path.join(root, "real-owner-outfit");
  cpSync(committed, dir, { recursive: true });
  return { root, dir };
}

function resum(dir) {
  writeFileSync(path.join(dir, "SHA256SUMS"), FILES.map((name) => `${sha256(readFileSync(path.join(dir, name)))}  ${name}`).join("\n") + "\n");
}

function check(dir) {
  const run = spawnSync(process.execPath, ["tools/composite-example.mjs", "--check", "--dir", dir], { cwd: pkg, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { status: run.status, output: `${run.stdout ?? ""}\n${run.stderr ?? ""}` };
}

function withCopy(fn) {
  const { root, dir } = copy();
  try {
    return fn(dir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a missing example directory fails the check", () => {
  withCopy((dir) => {
    rmSync(dir, { recursive: true, force: true });
    const r = check(dir);
    assert.equal(r.status, 1);
    assert.match(r.output, /FAIL composite example missing/);
  });
});

test("an edited file whose checksum was not updated fails the check", () => {
  withCopy((dir) => {
    writeFileSync(path.join(dir, "preview.svg"), readFileSync(path.join(dir, "preview.svg"), "utf8").replace("NO PHOTO YET", "NO PHOTO"));
    const r = check(dir);
    assert.equal(r.status, 1);
    assert.match(r.output, /FAIL preview\.svg does not match SHA256SUMS/);
  });
});

test("a picture of the wrong size fails the check even with its checksum recomputed", () => {
  withCopy((dir) => {
    const png = Buffer.from(readFileSync(path.join(dir, "preview.png")));
    png.writeUInt32BE(png.readUInt32BE(16) + 1, 16);
    writeFileSync(path.join(dir, "preview.png"), png);
    resum(dir);
    const r = check(dir);
    assert.equal(r.status, 1);
    assert.match(r.output, /FAIL preview\.png is not the size of the manifest's canvas/);
  });
});

test("an edited garment name and scene, with every checksum and recorded hash recomputed, fails the redrawn comparison", () => {
  withCopy((dir) => {
    // A consistent forgery: the scene and the manifest caption name a different garment, example.json records
    // the new scene's hash and SHA256SUMS is rewritten, so every file-integrity test passes. Only drawing the
    // preview again from the owner's real garments can show that the files are not what the code draws.
    const svg = readFileSync(path.join(dir, "preview.svg"), "utf8");
    const example = JSON.parse(readFileSync(path.join(dir, "example.json"), "utf8"));
    const name = example.slots[0].name;
    const forgedName = `${name} (forged)`;
    assert.ok(svg.includes(name), "the scene names the first garment");
    const forgedSvg = svg.split(name).join(forgedName);
    example.slots[0].name = forgedName;
    example.manifest.caption = example.manifest.caption.split(name).join(forgedName);
    example.preview.svgSha256 = sha256(forgedSvg);
    writeFileSync(path.join(dir, "preview.svg"), forgedSvg);
    writeFileSync(path.join(dir, "example.json"), JSON.stringify(example, null, 2) + "\n");
    resum(dir);
    const r = check(dir);
    assert.equal(r.status, 1, r.output.slice(-2000));
    assert.match(r.output, /composite example files agree/, "the forgery passes the integrity part");
    assert.match(r.output, /FAIL example\.json is not what the code draws now/);
    assert.match(r.output, /FAIL preview\.svg is not what the code draws now/);
    assert.doesNotMatch(r.output, /FAIL preview\.png/);
  });
});

test("an unchanged copy passes: every file equals the preview drawn now", () => {
  withCopy((dir) => {
    const r = check(dir);
    assert.equal(r.status, 0, r.output.slice(-2000));
    assert.match(r.output, /composite example ok: example\.json, preview\.png, preview\.svg equal, byte for byte, the preview drawn now/);
  });
});
