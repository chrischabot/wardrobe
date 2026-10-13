/**
 * An INDEPENDENT checker of the owner profile's hard constraints (chris-wardrobe-profile.md, section 8
 * rules 1 to 7, with the colour verdict of section 5, the accessory line of section 9 and the "safe
 * options never lead" expectation of section 11).
 *
 * It is written from the profile text and the owner's inventory sheet alone. It imports nothing from
 * the product: not its validator, not its rule records, not its garment attributes. Its inputs are the
 * garment NAMES an outfit shows, the forecast the journey itself scripted, and the wears the journey
 * itself reported. A violation is a plain sentence.
 */
import { isBenched, isSneaker, isWelted, sheetRowsFor, type SheetRow } from "./inventory.ts";

export interface ShownPiece {
  role: string;
  name: string;
}

export interface ShownOutfit {
  label: string;
  pieces: ShownPiece[];
  footwearAlternatives: ShownPiece[];
  flourish: ShownPiece | null;
}

export interface DayFacts {
  /** Temperature when he leaves the house (the scripted morning). */
  departureC: number;
  /** The day's peak (the scripted daytime maximum). */
  peakC: number;
  /** True while he has not said his feet have healed. */
  sneakersOnly: boolean;
  /** Names of shirts and trousers the journey reported as worn in the seven days before this day. */
  wornInLastSevenDays: string[];
}

/** A board option as the API returns it, reduced to what the owner sees. */
export const shown = (option: any): ShownOutfit => ({
  label: `option ${option.number} (${option.name})`,
  pieces: option.garments.map((g: any) => ({ role: g.role, name: g.name })),
  footwearAlternatives: option.footwearAlternatives.map((g: any) => ({ role: g.role, name: g.name })),
  flourish: option.flourish ? { role: option.flourish.role, name: option.flourish.name } : null,
});

/**
 * The sheet row behind a shown piece. The sheet lists some garments on several lines (two pairs of the
 * same trousers); those lines agree on colour, season and status. A name that matches lines which do
 * NOT agree is ambiguous and is reported as a violation, never silently read from the first line.
 */
const rowsOf = (piece: ShownPiece): SheetRow[] => sheetRowsFor(piece.name);
const agree = (rows: SheetRow[]): boolean => new Set(rows.map((r) => `${r.category}|${r.colour}|${r.season}|${r.status}|${r.fabric}`)).size <= 1;
const rowOf = (piece: ShownPiece): SheetRow | null => {
  const rows = rowsOf(piece);
  return rows.length > 0 && agree(rows) ? rows[0]! : null;
};

/** Season texts of the sheet that state no number; every other season text must parse to a limit (checked in journey 06). */
export const WORDED_SEASONS = ["All-but-coldest", "Year-round", "Cold", "-", "Warm-weather", "Transitional", "Hot", "All-season", "Cool", "Cool/cold", "Warm-leaning", "Winter"];

/** Numeric temperature limits the SHEET states for a garment ("To 22°C", "10-24°C", "Hot (30°C+)"). */
export function sheetLimits(row: SheetRow): { minC: number | null; maxC: number | null } {
  const season = row.season;
  const range = /(\d+)\s*-\s*(\d+)\s*°C/.exec(season);
  if (range) return { minC: Number(range[1]), maxC: Number(range[2]) };
  const upTo = /To\s*(\d+)\s*°C/i.exec(season);
  if (upTo) return { minC: null, maxC: Number(upTo[1]) };
  const from = /(\d+)\s*°C\+/.exec(season);
  if (from) return { minC: Number(from[1]), maxC: null };
  return { minC: null, maxC: null };
}

const isLightweightOxford = (row: SheetRow) => /^lightweight oxford\b/i.test(row.item);
const isBedSock = (row: SheetRow) => /bed sock/i.test(`${row.item} ${row.notes}`);
const isLayeringTier = (row: SheetRow) => /layering/i.test(row.status);

/** Section 5: "never let a single neutral appear three times in one outfit". */
const NEUTRALS = ["navy", "beige", "stone", "cream", "walnut", "white", "grey", "black"];
const neutralOf = (row: SheetRow): string | null => {
  const colour = row.colour.toLowerCase();
  if (/[+/]|stripe|check|plaid|ombre/.test(colour)) return null; // a pattern or two colours is not one neutral
  return NEUTRALS.find((n) => new RegExp(`\\b${n}\\b`).test(colour)) ?? null;
};

export function profileViolations(outfit: ShownOutfit, day: DayFacts): string[] {
  const out: string[] = [];
  const say = (text: string) => out.push(`${outfit.label}: ${text}`);
  const of = (role: string) => outfit.pieces.filter((p) => p.role === role);

  // Rule 7: names must match what he can actually see at the wardrobe.
  const rows = new Map<ShownPiece, SheetRow>();
  for (const piece of [...outfit.pieces, ...outfit.footwearAlternatives, ...(outfit.flourish ? [outfit.flourish] : [])]) {
    const row = rowOf(piece);
    if (!row) say(rowsOf(piece).length > 1 ? `"${piece.name}" matches several different lines of his inventory` : `"${piece.name}" is not a name from his inventory`);
    else rows.set(piece, row);
    if (/\bPCF\d+/i.test(piece.name)) say(`"${piece.name}" shows a maker's fabric code`);
  }
  for (const [piece, row] of rows) if (isBenched(row)) say(`${piece.name} is benched in his sheet (${row.status})`);

  // Rule 1: socks always, wicking merino by default; bed socks are not outdoor socks.
  const socks = of("socks");
  if (socks.length !== 1) say(`${socks.length} sock lines (socks always, no exceptions)`);
  for (const sock of socks) {
    const row = rows.get(sock);
    if (!row) continue;
    if (row.category !== "Sock") say(`${sock.name} is not a sock`);
    if (isBedSock(row)) say(`${sock.name} is a bed sock`);
    // Profile section 8 rule 1: "Socks always, wicking merino by default." "By default" is read here
    // as: on a day that gets above 15 °C nothing but merino is acceptable; on a colder day another
    // outdoor sock he owns may stand in. The 15 °C line is this checker's reading, not the profile's number.
    if (!/merino/i.test(row.fabric) && day.peakC > 15) say(`${sock.name} is not merino on a ${day.peakC} °C day (merino by default)`);
  }

  // Rule 2: sneakers only until he says his feet have healed. Rule 3: afterwards, both are named.
  const shoes = of("footwear");
  if (shoes.length !== 1) say(`${shoes.length} shoe lines`);
  for (const shoe of shoes) {
    const row = rows.get(shoe);
    if (!row) continue;
    if (/990v6/i.test(shoe.name)) say(`${shoe.name} is the 990v6, which is out of play`);
    if (day.sneakersOnly && !isSneaker(row)) say(`${shoe.name} is not a sneaker while the sneakers-only rule holds`);
  }
  for (const alternative of outfit.footwearAlternatives) {
    const row = rows.get(alternative);
    if (row && day.sneakersOnly && isWelted(row)) say(`${alternative.name} is offered as an alternative while the welted fleet is out of play`);
  }
  if (!day.sneakersOnly) {
    const all = [...shoes, ...outfit.footwearAlternatives].map((p) => rows.get(p)).filter((r): r is SheetRow => !!r);
    if (!all.some(isSneaker)) say("names no sneaker");
    if (!all.some(isWelted)) say("names no welted alternative");
  }

  // Rule 4: shirts and trousers against the day's PEAK; only outerwear answers the morning; at roughly
  // 14-16 degrees a jacket goes over a lightweight oxford only.
  const tops = of("top");
  const bottoms = of("bottom");
  if (tops.length !== 1) say(`${tops.length} shirt lines`);
  if (bottoms.length !== 1) say(`${bottoms.length} trouser lines`);
  for (const piece of [...tops, ...bottoms, ...of("mid_layer")]) {
    const row = rows.get(piece);
    if (!row) continue;
    const { minC, maxC } = sheetLimits(row);
    if (maxC !== null && day.peakC > maxC) say(`${piece.name} is "${row.season}" in his sheet but the day peaks at ${day.peakC} °C`);
    if (minC !== null && day.peakC < minC) say(`${piece.name} is "${row.season}" in his sheet but the day peaks at only ${day.peakC} °C`);
    if (piece.role === "top" && isLayeringTier(row)) say(`${piece.name} is a layering piece in his sheet, not a primary shirt`);
  }
  const jackets = of("outer");
  for (const jacket of jackets) {
    const row = rows.get(jacket);
    if (!row) continue;
    const { minC, maxC } = sheetLimits(row);
    if (maxC !== null && day.departureC > maxC) say(`${jacket.name} is "${row.season}" in his sheet but it is ${day.departureC} °C when he leaves`);
    if (minC !== null && day.departureC < minC) say(`${jacket.name} is "${row.season}" in his sheet but it is ${day.departureC} °C when he leaves`);
  }
  if (jackets.length > 0 && day.departureC >= 14 && day.departureC <= 16) {
    for (const under of [...tops, ...of("mid_layer")]) {
      const row = rows.get(under);
      if (row && !isLightweightOxford(row)) say(`${jackets[0]!.name} over ${under.name} at ${day.departureC} °C (a jacket goes over a lightweight oxford only at 14-16 °C)`);
    }
  }

  // Rule 5: the variety horizon is the week; anything worn in the last seven days is a repeat.
  for (const piece of [...tops, ...bottoms]) if (day.wornInLastSevenDays.includes(piece.name)) say(`${piece.name} was worn within the last seven days`);

  // Section 9: watches and jewellery are absent by choice; the flourish is a scarf, tie or square.
  for (const [piece, row] of rows) if (/\b(watch|ring|bracelet|chain|necklace|cufflinks?)\b/i.test(row.item)) say(`${piece.name} is a watch or jewellery`);
  if (outfit.flourish) {
    const row = rows.get(outfit.flourish);
    if (row && !/scarf|tie|bandana|pocket square|polka/i.test(row.item)) say(`the flourish ${outfit.flourish.name} is not a scarf, tie or square`);
  }
  return out;
}

/** Section 5's standing colour verdict: "never let a single neutral appear three times in one outfit". */
export function neutralViolations(outfit: ShownOutfit): string[] {
  const counts = new Map<string, string[]>();
  for (const piece of outfit.pieces) {
    const row = rowOf(piece);
    const neutral = row ? neutralOf(row) : null;
    if (neutral) counts.set(neutral, [...(counts.get(neutral) ?? []), piece.name]);
  }
  return [...counts].filter(([, names]) => names.length >= 3).map(([neutral, names]) => `${outfit.label}: ${neutral} appears ${names.length} times (${names.join(", ")})`);
}

/**
 * Section 11 (and the standing verdict of section 5): safe options never lead. The "safe option" the
 * profile names is the white-or-blue shirt with navy trousers; it may be on a board, never first.
 */
export function safeLeadViolations(board: { options: any[] }): string[] {
  const lead = board.options[0];
  if (!lead) return [];
  const outfit = shown(lead);
  const top = outfit.pieces.find((p) => p.role === "top");
  const bottom = outfit.pieces.find((p) => p.role === "bottom");
  const shirt = top ? rowOf(top) : null;
  const trousers = bottom ? rowOf(bottom) : null;
  if (!shirt || !trousers) return [];
  const safe = /^(white|off-white|blue|light blue)$/i.test(shirt.colour.trim()) && /navy/i.test(trousers.colour);
  return safe ? [`${outfit.label}: the safe option (${top!.name} with ${bottom!.name}) leads the board`] : [];
}

/**
 * Rule 6: "Never fall back to navy when a piece is swapped out." Judged on the piece a swap brought in,
 * by the colour his own sheet gives it. A piece the owner asked for by name is his choice, not a fallback,
 * so callers pass only replacements the product chose.
 */
export function navyFallbackViolations(replacementName: string, swappedOutName: string): string[] {
  const rows = sheetRowsFor(replacementName);
  if (rows.length === 0) return [`"${replacementName}", offered in place of ${swappedOutName}, is not a name from his inventory`];
  return rows.some((r) => /navy/i.test(r.colour)) ? [`${replacementName} (navy) was offered in place of ${swappedOutName}`] : [];
}

/** Violations across a whole board, plus the board-level expectations of the profile. */
export function boardViolations(board: { options: any[] }, day: DayFacts): string[] {
  const out = board.options.flatMap((o) => profileViolations(shown(o), day));
  const names = (role: string) => board.options.map((o) => o.garments.find((g: any) => g.role === role)?.name);
  // He owns thirty-odd shirts and twenty-odd trousers so that nothing repeats: one board offers five different ones.
  for (const role of ["top", "bottom"]) if (new Set(names(role)).size !== board.options.length) out.push(`the board repeats a ${role === "top" ? "shirt" : "pair of trousers"} across its options: ${names(role).join(", ")}`);
  out.push(...safeLeadViolations(board));
  return out;
}
