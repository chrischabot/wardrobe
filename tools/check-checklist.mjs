#!/usr/bin/env node
/**
 * Structural check of requirements/CHECKLIST.md:
 *   - every row has 7 cells, a unique ID and workstream keys from the fixed list;
 *   - all 21 specification sections and the amendment/profile/evaluation/research/kickoff groups have rows;
 *   - every repository path cited in a Code or Tests cell exists;
 *   - a row marked `implemented` cites both code and a test; no foundation row is left without a decision.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(path.join(root, "requirements/CHECKLIST.md"), "utf8");
const WORKSTREAMS = new Set(["foundation", "daily-service", "assistant", "api-mcp-identity", "visual-wardrobe", "ios", "journey-tests", "adversarial-tests", "deployment", "simulation"]);
const STATUSES = new Set(["open", "implemented", "partial", "blocked", "superseded"]);
const failures = [];
const ids = new Set();
const prefixes = new Map();
let rows = 0;
for (const [n, line] of text.split("\n").entries()) {
  if (!line.startsWith("| ") || line.startsWith("| ID ") || line.startsWith("| ---")) continue;
  const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  if (!/^(S\d{2}-\d{3}|AM-\d{3}|PR-\d{3}|EV-\d{3}|KO-\d{3}|R\d{2})$/.test(cells[0])) continue; // other tables (workstream list)
  rows++;
  const at = `line ${n + 1} (${cells[0]})`;
  if (cells.length !== 7) { failures.push(`${at}: expected 7 cells, found ${cells.length}`); continue; }
  const [id, , requirement, workstream, code, tests, status] = cells;
  if (ids.has(id)) failures.push(`${at}: duplicate ID`);
  ids.add(id);
  const prefix = id.startsWith("S") ? id.slice(0, 3) : id.replace(/[-\d]/g, "");
  prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  if (!requirement) failures.push(`${at}: empty requirement`);
  for (const w of workstream.split("+")) if (!WORKSTREAMS.has(w)) failures.push(`${at}: unknown workstream '${w}'`);
  if (!STATUSES.has(status)) failures.push(`${at}: unknown status '${status}'`);
  if (status === "implemented" && (code === "—" || tests === "—")) failures.push(`${at}: implemented rows must cite code and tests`);
  if (workstream.split("+")[0] === "foundation" && status === "open" && !/\(.+\)$/.test(requirement)) failures.push(`${at}: foundation row left open without a note`);
  for (const cell of [code, tests]) {
    if (cell === "—") continue;
    for (const ref of cell.split(";")) {
      const p = ref.trim().split(/[\s(:#]/)[0].replace(/`/g, "");
      if (p && /[/.]/.test(p) && !p.startsWith("http") && !existsSync(path.join(root, p))) failures.push(`${at}: cited path does not exist: ${p}`);
    }
  }
}
for (let s = 1; s <= 21; s++) if (!prefixes.get(`S${String(s).padStart(2, "0")}`)) failures.push(`specification section ${s} has no rows`);
for (const g of ["AM", "PR", "EV", "KO", "R"]) if (!prefixes.get(g)) failures.push(`group ${g} has no rows`);
if ((prefixes.get("R") ?? 0) !== 59) failures.push(`expected research rows R01-R59, found ${prefixes.get("R") ?? 0}`);
if (failures.length > 0) {
  for (const f of failures.slice(0, 60)) console.error(`FAIL ${f}`);
  console.error(`${failures.length} problem(s) in requirements/CHECKLIST.md`);
  process.exit(1);
}
const count = (status) => [...text.matchAll(new RegExp(`\\| ${status} \\|$`, "gm"))].length;
console.log(`checklist ok: ${rows} rows; implemented ${count("implemented")}, partial ${count("partial")}, blocked ${count("blocked")}, open ${count("open")}`);
