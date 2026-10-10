/**
 * An INDEPENDENT check of the owner profile's hard constraints (requirements/chris-wardrobe-profile.md,
 * section 8) against the owner's inventory sheet (requirements/wardrobe_inventory_clean.csv).
 *
 * It is written from those two documents alone and imports nothing from the product: not its validator,
 * not its rule records, not its garment attributes. Its inputs are the garment NAMES an outfit shows,
 * the forecast the simulator itself scripted and the wears the simulator itself reported.
 *
 * What it checks, and where each comes from:
 *   rule 1  socks always: exactly one sock line, and it is a sock from the sheet (not a bed sock);
 *   rule 2  sneakers only until he says his feet have healed: the shoe is a New Balance that is not the
 *           990v6, and no welted alternative is offered (the simulation never says the feet have healed);
 *   rule 4  the thermal rule, only where the sheet states a number ("To 22°C", "10-24°C", "Hot (30°C+)"):
 *           shirts, layers and trousers against the day's peak, outerwear against the departure
 *           temperature, and at 14 to 16 degrees a jacket only over a lightweight oxford;
 *   rule 5  nothing the simulator reported as worn in the seven days before is offered again as the
 *           shirt or the trousers (compared by garment, not by name);
 *   rule 7  every shown name is a name from his sheet and carries no maker fabric code;
 *   and a piece his sheet marks as benched is never offered.
 * A garment the simulation created itself carries the word SYNTHETIC in its name and is checked only
 * for being labelled.
 *
 * Not checked, stated so nobody reads more into it: worded seasons ("Cold", "Warm-weather") carry no
 * number in his documents and get no thermal check; "wicking merino by default" (rule 1) and "never
 * fall back to navy" (rule 6, a swap rule) are not judged here; the colour verdict of section 5 is a
 * preference and is counted as an advisory, not as a failure.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
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
export const SHEET_ROWS = parseCsv(readFileSync(path.join(REPO_ROOT, "requirements/wardrobe_inventory_clean.csv"), "utf8"))
  .map((cells, index) => ({ cells, line: index + 1 }))
  .filter(({ cells }) => CATEGORIES.has(cells[0] ?? ""))
  .map(({ cells, line }) => ({ line, category: cells[0], item: cells[1] ?? "", colour: cells[2] ?? "", fabric: cells[3] ?? "", brand: cells[4] ?? "", size: cells[5] ?? "", season: cells[6] ?? "", status: cells[7] ?? "", notes: cells[8] ?? "" }));

const norm = (s) => s.toLowerCase().replace(/\s*\(pair \d\)\s*/g, "").replace(/\s+/g, " ").trim();

/**
 * The sheet rows behind a shown name. The sheet repeats some item names across colours ("NB 990v4"
 * three times), so a shown name is matched as the item, or as `item — colour`.
 */
export function sheetRowsFor(shownName) {
  const wanted = norm(shownName);
  const exact = SHEET_ROWS.filter((r) => norm(r.item) === wanted);
  if (exact.length > 0) return exact;
  return SHEET_ROWS.filter((r) => wanted.startsWith(`${norm(r.item)} — `) && norm(r.colour).startsWith(wanted.slice(norm(r.item).length + 3).split(/[ (/]/)[0]));
}

export const isSynthetic = (name) => /\bSYNTHETIC\b/.test(name);
const isBenched = (row) => /benched/i.test(row.status);
const isSneaker = (row) => row.category === "Footwear" && /new balance/i.test(row.brand);
const isWelted = (row) => row.category === "Footwear" && !isSneaker(row);
const isLightweightOxford = (row) => /^lightweight oxford\b/i.test(row.item);
const isBedSock = (row) => /bed sock/i.test(`${row.item} ${row.notes}`);

/** The numeric temperature limits the SHEET states for a garment; null where it states none. */
export function sheetLimits(row) {
  const range = /(\d+)\s*-\s*(\d+)\s*°C/.exec(row.season);
  if (range) return { minC: Number(range[1]), maxC: Number(range[2]) };
  const upTo = /To\s*(\d+)\s*°C/i.exec(row.season);
  if (upTo) return { minC: null, maxC: Number(upTo[1]) };
  const from = /(\d+)\s*°C\+/.exec(row.season);
  if (from) return { minC: Number(from[1]), maxC: null };
  return { minC: null, maxC: null };
}

const rowOf = (name) => {
  const rows = sheetRowsFor(name);
  if (rows.length === 0) return { row: null, problem: `"${name}" is not a name from his inventory` };
  const agree = new Set(rows.map((r) => `${r.category}|${r.colour}|${r.season}|${r.status}|${r.fabric}`)).size <= 1;
  return agree ? { row: rows[0], problem: null } : { row: null, problem: `"${name}" matches several different lines of his inventory` };
};

const NEUTRALS = ["navy", "beige", "stone", "cream", "walnut", "white", "grey", "black"];

/**
 * Violations of the hard constraints in one offered outfit.
 *
 * `option` is a board or recommendation option as the MCP tools return it. `day` is what the simulator
 * knows about that day: `{ thermal: { departureC, peakC } | null, wornLastSevenDays: Set<garmentId>,
 * namedByRequest: Set<garmentId>, onTrip: boolean }`. `thermal` is null when the forecast the option was
 * validated against is not the one the simulator scripted (an outage, or a change not yet read).
 */
export function hardConstraintViolations(option, day) {
  const out = [];
  const label = `option ${option.number ?? "?"} (${option.name})`;
  const say = (text) => out.push(`${label}: ${text}`);
  const pieces = option.garments ?? [];
  const alternatives = option.footwearAlternatives ?? [];
  const flourish = option.flourish ? [option.flourish] : [];
  const rows = new Map();
  for (const piece of [...pieces, ...alternatives, ...flourish]) {
    if (/\bPCF\d+/i.test(piece.name)) say(`"${piece.name}" shows a maker's fabric code (rule 7)`);
    if (isSynthetic(piece.name)) continue;
    const { row, problem } = rowOf(piece.name);
    if (problem) say(`${problem} (rule 7)`);
    else {
      rows.set(piece, row);
      if (isBenched(row)) say(`${piece.name} is benched in his sheet (${row.status})`);
    }
  }
  const of = (role) => pieces.filter((p) => p.role === role);

  const socks = of("socks");
  if (socks.length !== 1) say(`${socks.length} sock lines (rule 1: socks always)`);
  for (const sock of socks) {
    const row = rows.get(sock);
    if (!row) continue;
    if (row.category !== "Sock") say(`${sock.name} is not a sock (rule 1)`);
    if (isBedSock(row)) say(`${sock.name} is a bed sock (rule 1)`);
  }

  const shoes = of("footwear");
  if (shoes.length !== 1) say(`${shoes.length} shoe lines`);
  for (const shoe of shoes) {
    const row = rows.get(shoe);
    if (/990v6/i.test(shoe.name)) say(`${shoe.name} is the 990v6, which is out of play (rule 2)`);
    if (row && !isSneaker(row)) say(`${shoe.name} is not a sneaker while the sneakers-only rule holds (rule 2)`);
  }
  for (const alternative of alternatives) {
    const row = rows.get(alternative);
    if (row && isWelted(row)) say(`${alternative.name} is offered as an alternative while the welted fleet is out of play (rule 2)`);
    if (/990v6/i.test(alternative.name)) say(`${alternative.name} is the 990v6, which is out of play (rule 2)`);
  }

  const tops = of("top");
  const bottoms = of("bottom");
  const mids = of("mid_layer");
  const jackets = of("outer");
  if (day.thermal) {
    const { departureC, peakC } = day.thermal;
    for (const piece of [...tops, ...bottoms, ...mids]) {
      const row = rows.get(piece);
      if (!row) continue;
      const { minC, maxC } = sheetLimits(row);
      if (maxC !== null && peakC > maxC) say(`${piece.name} is "${row.season}" in his sheet but the day peaks at ${peakC} °C (rule 4)`);
      if (minC !== null && peakC < minC) say(`${piece.name} is "${row.season}" in his sheet but the day peaks at only ${peakC} °C (rule 4)`);
    }
    for (const jacket of jackets) {
      const row = rows.get(jacket);
      if (!row) continue;
      const { minC, maxC } = sheetLimits(row);
      if (maxC !== null && departureC > maxC) say(`${jacket.name} is "${row.season}" in his sheet but it is ${departureC} °C when he leaves (rule 4)`);
      if (minC !== null && departureC < minC) say(`${jacket.name} is "${row.season}" in his sheet but it is ${departureC} °C when he leaves (rule 4)`);
    }
    if (jackets.length > 0 && departureC >= 14 && departureC <= 16) {
      for (const under of [...tops, ...mids]) {
        const row = rows.get(under);
        if (row && !isLightweightOxford(row)) say(`${jackets[0].name} over ${under.name} at ${departureC} °C (rule 4: a jacket goes over a lightweight oxford only at 14 to 16 °C)`);
      }
    }
  }

  if (!day.onTrip) {
    for (const piece of [...tops, ...bottoms]) {
      if (day.wornLastSevenDays.has(piece.garmentId) && !day.namedByRequest.has(piece.garmentId)) say(`${piece.name} was reported worn within the last seven days (rule 5)`);
    }
  }
  return out;
}

/** Section 5's colour verdict ("never let a single neutral appear three times"): counted as an advisory only. */
export function neutralAdvisories(option) {
  const counts = new Map();
  for (const piece of option.garments ?? []) {
    if (isSynthetic(piece.name)) continue;
    const { row } = rowOf(piece.name);
    if (!row) continue;
    const colour = row.colour.toLowerCase();
    if (/[+/]|stripe|check|plaid|ombre/.test(colour)) continue;
    const neutral = NEUTRALS.find((n) => new RegExp(`\\b${n}\\b`).test(colour));
    if (neutral) counts.set(neutral, [...(counts.get(neutral) ?? []), piece.name]);
  }
  return [...counts].filter(([, names]) => names.length >= 3).map(([neutral, names]) => `${neutral} appears ${names.length} times (${names.join(", ")})`);
}
