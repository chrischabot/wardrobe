import { BOARD_DOCUMENT_VERSION, type BoardDocument, type BoardLine, type BoardOptionDocument, type GarmentRole } from '@garderobe/contracts';
import { dayOfWeek } from '../domain/time.js';
import type { ScoredOption } from './compose.js';
import { occasionPhrase } from './compose.js';
import type { MandatoryContext } from './context.js';
import { colourWord, isScarf, isTie, nounOf, type WardrobeGarment } from './garments.js';
import type { OutfitParts } from './validate.js';

/**
 * The board document (owner profile section 11): a day line closing on the shape of the day, then the
 * outfits, each opening with a sentence on why it works and what makes it interesting, followed by
 * jacket, shirt or jumper, trousers, belt with its optional flourish, and socks with shoes. Whitespace
 * between everything. Prose is deterministic and built only from record facts; an injected
 * `ProseWriter` (a model) may improve wording, and its text is checked before use.
 */

export interface ProseWriterInput {
  dayLine: string;
  /** The complete active profile text (a model giving style prose always receives it in full). */
  profile: string;
  options: { optionId: string; why: string; garments: { name: string; role: GarmentRole; colour: string | null; fabric: string | null }[]; devices: string[] }[];
}

export interface ProseWriter {
  readonly name: string;
  write(input: ProseWriterInput): Promise<{ dayLine?: string; why?: Record<string, string> }>;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function article(phrase: string): string {
  return /^[aeiou]/i.test(phrase) ? `an ${phrase}` : `a ${phrase}`;
}

function desc(g: WardrobeGarment): string {
  const colour = colourWord(g);
  const noun = nounOf(g);
  return colour && !noun.includes(colour) ? `${colour} ${noun}` : noun;
}

/** One sentence on why it works and what makes it interesting; facts come only from the records. */
export function whySentence(o: ScoredOption, ctx: MandatoryContext): string {
  const p = o.validation.parts;
  const top = p.top!;
  const bottom = p.bottom!;
  const cond = ctx.weather.summary.conditions;
  let opening: string;
  switch (o.validation.register) {
    case 'academic_blazer':
      opening = `The ${desc(p.outer!)} brings texture to the ${desc(top)}, so it reads lecture hall rather than office`;
      break;
    case 'field_workwear':
      opening = cond.includes('warming') ? `The ${desc(p.outer!)} covers the cool start and comes off once the day warms, leaving the ${desc(top)}` : `${cap(article(desc(p.outer!)))} made for real work sits over the ${desc(top)}`;
      break;
    case 'sprezzatura':
      opening = `${cap(article(colourWord(p.flourish!)))} silk knit tie against the washed ${desc(top)} is formal on top and relaxed everywhere else`;
      break;
    case 'rl_ivy':
      opening = `Workcloth admitted on merit: the ${desc(top)} with the ${desc(bottom)}`;
      break;
    case 'fun_lane':
      opening = `The ${desc(top)} is the one loud voice, with the ${desc(bottom)} kept quiet underneath`;
      break;
    case 'home_key':
      opening = `The plain home key, ${desc(top)} and ${desc(bottom)}`;
      break;
    default:
      opening = `The ${desc(top)} over ${desc(bottom)}`;
  }
  const clauses: string[] = [];
  if (o.devices.includes('echo') && p.socks) {
    const source = [p.flourish, p.outer, top].find((g) => g && g.families.some((f) => p.socks!.families.includes(f)));
    clauses.push(`the ${colourWord(p.socks)} socks pick up the ${source ? nounOf(source) === 'tie' || isTie(source) ? 'tie' : isScarf(source) ? 'scarf' : nounOf(source) : 'colour above'} rather than the trousers`);
  }
  if (o.devices.includes('warm_cool') && clauses.length < 1) {
    const warmPiece = [p.outer, top].find((g) => g && g.families.some((f) => ['rust', 'burgundy', 'red', 'pink', 'gold', 'brown', 'beige', 'cream', 'walnut'].includes(f)));
    clauses.push(warmPiece ? `warm ${colourWord(warmPiece)} against the cooler ${colourWord(bottom)}` : `cool above, warm ${colourWord(bottom)} below`);
  }
  if (o.devices.includes('texture') && clauses.length < 2) {
    const a = [p.outer, top, bottom].filter((g): g is WardrobeGarment => Boolean(g)).map(fabricPhrase).filter(Boolean);
    if (a.length >= 2 && a[0] !== a[1]) clauses.push(`${a[0]} against ${a[a.length - 1]} gives the eye something to read`);
  }
  if (o.devices.includes('rain_layer')) clauses.push('the waxed cotton earns its place once the rain arrives');
  if (!clauses.length && o.devices.includes('one_voice')) clauses.push('one saturated voice in an otherwise calm frame');
  // The fallback obeys the same code rule as model prose: a phrase quoted from the records (a fabric, a
  // colour or noun) that holds any registered maker code as a standalone word, outside the outfit's own
  // display or short names, is dropped; an opening that would do so names the pieces by display name.
  if (standaloneCodeIn(opening, o, ctx)) opening = `The ${top.name} with the ${bottom.name}`;
  const safeClauses = clauses.filter((c) => !standaloneCodeIn(c, o, ctx));
  const s = cap((safeClauses.length ? `${opening}; ${safeClauses.slice(0, 2).join(', and ')}.` : `${opening}.`).replace(/\s+/g, ' '));
  // Final guard on the assembled text: template words ("The", "with", "and") are words too. If the
  // sentence still holds a code standing alone, it names the pieces by display name only (names are the
  // one place a code may appear), joined by punctuation.
  if (!standaloneCodeIn(s, o, ctx)) return s;
  return cap(`${[p.outer, top, bottom].filter((g): g is WardrobeGarment => Boolean(g)).map((g) => g.name).join(', ')}.`);
}

export function linesOf(p: OutfitParts): BoardLine[] {
  const lines: BoardLine[] = [];
  lines.push({ kind: 'jacket', label: 'Jacket', text: p.outer ? p.outer.name : 'None needed', garmentIds: p.outer ? [p.outer.garmentId] : [], flourish: null });
  if (p.mid) lines.push({ kind: 'jumper', label: 'Jumper', text: p.mid.name, garmentIds: [p.mid.garmentId], flourish: null });
  lines.push({ kind: 'shirt', label: p.top?.category === 'knitwear' ? 'Jumper' : 'Shirt', text: p.top?.name ?? '', garmentIds: p.top ? [p.top.garmentId] : [], flourish: null });
  lines.push({ kind: 'trousers', label: 'Trousers', text: p.bottom?.name ?? '', garmentIds: p.bottom ? [p.bottom.garmentId] : [], flourish: null });
  const f = p.flourish && (isTie(p.flourish) || isScarf(p.flourish)) ? { garmentId: p.flourish.garmentId, kind: (isTie(p.flourish) ? 'tie' : 'scarf') as 'tie' | 'scarf', text: p.flourish.name } : null;
  lines.push({ kind: 'belt', label: 'Belt', text: p.belt ? p.belt.name : 'No belt (drawstring)', garmentIds: p.belt ? [p.belt.garmentId] : [], flourish: f });
  const shoes = p.footwear.map((g) => g.name);
  lines.push({
    kind: 'socks_and_shoes',
    label: 'Socks and shoes',
    text: `${p.socks?.name ?? ''} with ${shoes.length > 1 ? `${shoes[0]}, or ${shoes.slice(1).join(', or ')}` : (shoes[0] ?? '')}`,
    garmentIds: [...(p.socks ? [p.socks.garmentId] : []), ...p.footwear.map((g) => g.garmentId)],
    flourish: null,
  });
  return lines;
}

export function dayLineOf(ctx: MandatoryContext): string {
  const weekday = WEEKDAYS[dayOfWeek(ctx.day.date)]!;
  const w = ctx.weather.summary;
  const weather = w.status === 'unavailable' || w.status === 'missing' ? `${w.line}; dressed for the season, not a forecast` : w.line;
  return `${weekday}: ${weather}. ${ctx.calendar.brief.shapeOfDay}`;
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

export function suitabilityNoteOf(ctx: MandatoryContext, suitable: number, total: number): string | null {
  const occ = ctx.calendar.brief.occasion;
  if (!occ || !total) return null;
  const phrase = occasionPhrase(occ, ctx.calendar.brief.relevantEvent?.title ?? null);
  if (suitable === total) return `${total === 1 ? 'The option' : `All ${NUMBER_WORDS[total]?.toLowerCase() ?? total} options`} work${total === 1 ? 's' : ''} for your ${phrase}.`;
  return `${NUMBER_WORDS[suitable] ?? suitable} option${suitable === 1 ? '' : 's'} work${suitable === 1 ? 's' : ''} for your ${phrase} today.`;
}

/** Checks model prose against the records: no invented garments, codes, percentages or claims. */
/** Phrases that tell the owner to go without socks, however they are worded (profile section 8, rule 1). */
const SOCK_NEGATION = [
  /\b(skip|skipping|ditch|ditching|drop|dropping|lose|losing|forgo|forget|without|no|leave off|leave out|go without|do without|take off|lose the)\b[^.,;:!?]{0,24}\bsocks?\b/i,
  /\bsocks?\b[^.,;:!?]{0,16}\b(off|optional|unnecessary|not needed|can go|stay in the drawer)\b/i,
  /\bsock[- ]?(less|free)\b/i,
  /\bbare[- ]?(ankles?|feet|foot|legged|skin)\b/i,
  /\bbarefoot(ed)?\b/i,
  /\bno[- ]show\b/i,
];

/** Words that name footwear the healing restriction excludes (profile section 8, rule 2). */
const RESTRICTED_FOOTWEAR_WORDS = /\b(paraboots?|loafers?|boots?|brogues?|derby|derbies|welted|welt|chelsea|monk ?straps?|dress shoes?|990 ?v6)\b/i;

/** The name a person would say for a garment: the part before " — " ("Paraboot Reims — café" → "Paraboot Reims"). */
const shortName = (name: string) => name.split(/\s+[—–-]\s+/)[0]!.trim().toLowerCase();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Start/end spans of every whole-token, case-insensitive occurrence of `phrase` in `text` (boundaries: any non-letter/digit). */
function tokenSpans(text: string, phrase: string): [number, number][] {
  const p = phrase.trim();
  if (!p) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'giu');
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** Spans of every case-insensitive occurrence of `phrase` in `text`, token boundaries or not. */
function substringSpans(text: string, phrase: string): [number, number][] {
  const t = text.toLowerCase();
  const p = phrase.trim().toLowerCase();
  const out: [number, number][] = [];
  if (!p) return out;
  for (let i = t.indexOf(p); i >= 0; i = t.indexOf(p, i + 1)) out.push([i, i + p.length]);
  return out;
}

/** The fabric as the deterministic sentence quotes it ("texture" clause). */
const fabricPhrase = (g: WardrobeGarment) => (g.fabric ?? '').toLowerCase().replace(/\(.*?\)/g, '').trim();

/**
 * Spans of `text` that are the display name or short name of one of the outfit's own pieces. The only
 * place a maker code may appear: inside the name the owner actually sees.
 */
function ownNameSpans(text: string, option: ScoredOption | null): [number, number][] {
  const out: [number, number][] = [];
  for (const g of outfitPieces(option)) for (const phrase of new Set([g.name, shortName(g.name)])) out.push(...substringSpans(text, phrase));
  return out;
}

const outfitPieces = (option: ScoredOption | null) =>
  new Set(Object.values(option?.validation.parts ?? {}).flat().filter((x): x is WardrobeGarment => Boolean(x && typeof x === 'object' && 'garmentId' in x)));

/**
 * Spans of `text` that name or describe one of the outfit's own pieces from its records: its display
 * name, its short name, and its fabric as recorded (the deterministic sentence quotes it). An occurrence
 * inside such a span is that piece's own wording, not a search name or another garment's name. Used for
 * search aliases and garment names only, never for maker codes.
 */
function ownPieceSpans(text: string, option: ScoredOption | null): [number, number][] {
  const out = ownNameSpans(text, option);
  for (const g of outfitPieces(option)) for (const phrase of new Set([g.fabric ?? '', fabricPhrase(g)])) out.push(...substringSpans(text, phrase));
  return out;
}

const outside = (spans: [number, number][], allowed: [number, number][]) => spans.some(([a, b]) => !allowed.some(([x, y]) => x <= a && b <= y));

/** True when `text` holds a registered maker code of any garment as a standalone word outside the outfit's own display or short names. */
export function standaloneCodeIn(text: string, option: ScoredOption | null, ctx: MandatoryContext): boolean {
  const names = ownNameSpans(text, option);
  return ctx.wardrobe.some((g) => (g.makerCodes ?? []).some((code) => outside(tokenSpans(text, code), names)));
}

/**
 * Search names and maker codes are for finding a garment, never for board or Calendar copy (spec: no
 * item codes in Calendar text). Returns why the text is refused, or null. The rule is strict:
 *
 * - every registered maker code of every wardrobe garment (its product code and maker-code aliases),
 *   of any length or form, matched as a whole token regardless of case;
 * - every search-only alias of every wardrobe garment (any alias that is not that garment's display
 *   name or short name), matched as a whole phrase regardless of case.
 *
 * Two deliberate exceptions, narrower for codes than for aliases:
 *
 * - a maker code is allowed only where it lies entirely inside the display name or short name of one of
 *   the outfit's own pieces (the name the owner sees). No other wording exempts a code: a code that
 *   happens to equal a word of a piece's recorded fabric ("CASHMERE" registered while a piece records
 *   "cashmere") is still refused as a standalone word;
 * - a search-only alias is also allowed where it lies entirely inside the outfit's own wording for one
 *   of its pieces: its display name, its short name, or its recorded fabric, which the deterministic
 *   sentence quotes. Without
 * it the deterministic copy itself would be refused on the owner's wardrobe: "PWVC Cashmere Cord Bark"
 * contains the alias "Cashmere cord", and its fabric "6-wale cotton/cashmere cord" contains the scarf's
 * alias "Cashmere". An alias that merely contains a display name ("Proper Cloth Lightweight oxford —
 * blue") still counts, because its match reaches beyond the name. A false positive only costs the
 * model's sentence: refused prose falls back to the deterministic text.
 */
export function searchOnlyPhraseIn(text: string, option: ScoredOption | null, ctx: MandatoryContext): string | null {
  const allowed = ownPieceSpans(text, option);
  if (standaloneCodeIn(text, option, ctx)) return 'item code or internal ID';
  for (const g of ctx.wardrobe) {
    const own = new Set([g.name.trim().toLowerCase(), shortName(g.name)]);
    for (const alias of g.aliases) {
      if (own.has(alias.trim().toLowerCase())) continue;
      if (outside(tokenSpans(text, alias), allowed)) return `uses a search name rather than the display name (${g.name})`;
    }
  }
  return null;
}

/**
 * Checks model prose against the day's facts and the owner's hard rules. It is rule-aware rather than a
 * keyword list: any wording that drops the socks, any restricted footwear while sneakers-only stands,
 * watches or jewellery, and any garment that is not in the outfit (by full or short name) is refused.
 * A refused text is replaced by the deterministic sentence; garments are never affected by prose.
 */
export function checkProse(text: string, option: ScoredOption | null, ctx: MandatoryContext): string | null {
  if (typeof text !== 'string' || text.trim().length < 12 || text.length > 320) return 'length';
  if (/\bPCF\d+\b|\b(g|opt|brd)_[A-Za-z0-9]{6,}/.test(text)) return 'item code or internal ID';
  const found = searchOnlyPhraseIn(text, option, ctx);
  if (found) return found;
  if (/%|\bpercent\b|\bprobability\b/i.test(text)) return 'invented percentage';
  if (/\bwaterproof\b/i.test(text)) return 'unsupported waterproofing claim';
  if (/\b(watch|watches|jewellery|jewelry|bracelet|necklace|ring|rings|cufflinks?)\b/i.test(text)) return 'contradicts a hard rule (no watches or jewellery)';
  if (ctx.policy.socks.required && SOCK_NEGATION.some((re) => re.test(text))) return 'contradicts a hard rule (socks always)';
  if (option) {
    // A foreign garment's name inside the outfit's own wording (e.g. "cotton-linen twill" quoted from an
    // outfit piece's fabric, which is also another garment's short name) describes that piece, not the other garment.
    const own = ownPieceSpans(text, option);
    const inOutfit = new Set(option.slots.map((s) => s.garmentId));
    const outfitShort = new Set(option.slots.map((s) => ctx.byId.get(s.garmentId)?.name).filter((n): n is string => Boolean(n)).map(shortName));
    const foreign = ctx.wardrobe.find((g) => !inOutfit.has(g.garmentId) && g.name.length > 8 && outside(substringSpans(text, g.name), own));
    if (foreign) return `names a garment not in the outfit (${foreign.name})`;
    const foreignShort = ctx.wardrobe.find((g) => {
      if (inOutfit.has(g.garmentId)) return false;
      const s = shortName(g.name);
      return s.length > 8 && !outfitShort.has(s) && outside(tokenSpans(text, s), own);
    });
    if (foreignShort) return `names a garment not in the outfit (${foreignShort.name})`;
  }
  if (ctx.policy.sneakersOnly.active && RESTRICTED_FOOTWEAR_WORDS.test(text)) return 'contradicts a hard rule (sneakers only until healed)';
  return null;
}

export function renderBoardText(doc: Pick<BoardDocument, 'dayLine' | 'suitabilityNote' | 'shortfall' | 'options'>): string {
  const blocks: string[] = [doc.dayLine];
  if (doc.suitabilityNote) blocks.push(doc.suitabilityNote);
  if (doc.shortfall) blocks.push(doc.shortfall);
  for (const o of doc.options.filter((x) => x.status === 'offerable')) {
    const lines = o.lines.map((l) => {
      if (l.kind === 'belt' && l.flourish) return `${l.label}: ${l.text}\n    optional ${l.flourish.kind}: ${l.flourish.text}`;
      return `${l.label}: ${l.text}`;
    });
    blocks.push(`${o.position}. ${o.why}\n\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n') + '\n';
}

export interface DocumentOption {
  optionId: string;
  position: number;
  status: 'offerable' | 'reserve';
  scored: ScoredOption;
  why: string;
  lineage?: BoardOptionDocument['lineage'];
}

export function buildDocument(ctx: MandatoryContext, input: { options: DocumentOption[]; shortfall: string | null; suitableCount: number; prose: 'deterministic' | 'model'; dayLine?: string }): BoardDocument {
  const offerable = input.options.filter((o) => o.status === 'offerable');
  const options: BoardOptionDocument[] = input.options.map((o) => {
    const p = o.scored.validation.parts;
    const qualification = o.scored.joint < 0.6 ? 'One of these pieces may not be clean yet; the reserve covers it.' : null;
    return {
      optionId: o.optionId,
      position: o.position,
      status: o.status,
      register: o.scored.validation.register,
      registers: o.scored.validation.registers,
      why: o.why,
      lines: linesOf(p),
      garments: o.scored.slots.map((s) => {
        const g = ctx.byId.get(s.garmentId)!;
        return {
          garmentId: g.garmentId,
          name: g.name,
          role: s.role,
          category: g.category,
          colour: g.color,
          colorFamily: g.colorFamily,
          aliases: g.aliases,
          images: g.images,
          optional: s.role === 'accessory',
          alternativeGroup: s.alternativeGroup ?? null,
        };
      }),
      footwear: p.footwear.map((f) => ({ garmentId: f.garmentId, kind: f.footwearKind ?? 'other' })),
      suitability: ctx.calendar.brief.occasion ? { occasion: ctx.calendar.brief.occasion, suitable: Boolean(o.scored.suitable) } : null,
      jointAvailability: Math.round(o.scored.joint * 1000) / 1000,
      qualification,
      lineage: o.lineage ?? { previousOptionId: null, changedRoles: [] },
    };
  });
  const cal = ctx.calendar.brief;
  const doc: BoardDocument = {
    documentVersion: BOARD_DOCUMENT_VERSION,
    boardDate: ctx.day.date,
    timezone: ctx.day.timezone,
    purpose: ctx.day.purpose,
    dayLine: input.dayLine ?? dayLineOf(ctx),
    shapeOfDay: cal.shapeOfDay,
    suitabilityNote: suitabilityNoteOf(ctx, offerable.filter((o) => o.scored.suitable).length, offerable.length),
    weather: ctx.weather.summary,
    calendar: { status: cal.status, fetchedAt: cal.fetchedAt, occasion: cal.occasion, relevantEventTitle: cal.relevantEvent?.title ?? null, suitableCount: offerable.filter((o) => o.scored.suitable).length },
    requestedCount: ctx.day.requestedCount,
    options,
    reserves: input.options.filter((o) => o.status === 'reserve').length,
    shortfall: input.shortfall,
    prose: input.prose,
    text: '',
  };
  doc.text = renderBoardText(doc);
  return guardPublishedCopy(doc, ctx.wardrobe.flatMap((g) => g.makerCodes ?? []));
}

/** Words the copy may lose to a same-named code, with the neutral sign that replaces them. */
const CODE_WORD_SUBSTITUTES: Record<string, string> = { and: '&', with: '+', or: '/', the: '', a: '', an: '' };

/**
 * Final guard on published copy (spec: no item codes in board or Calendar text). Removes every
 * registered maker code standing alone in `text`, in any case, outside the given piece names (a code
 * may appear only inside a piece's display or short name) and outside URLs (links are not copy). A
 * template word that is also a code ("and", "with", "the") becomes a neutral sign or is dropped; any
 * other word becomes a middle dot. Runs on the finished text, so fixed labels ("Socks and shoes:",
 * "Open the board:") and the day line are covered as well as sentences.
 */
export function maskStandaloneCodes(text: string, codes: string[], names: string[]): string {
  const usable = [...new Set(codes.map((c) => c.trim()).filter((c) => /[\p{L}\p{N}]/u.test(c)))];
  if (!usable.length || !text) return text;
  const nameList = [...new Set(names.flatMap((n) => [n, shortName(n)]).filter((n) => n.trim()))];
  let out = text;
  for (let guard = 0; guard < 500; guard++) {
    const allowed = [...nameList.flatMap((n) => substringSpans(out, n)), ...[...out.matchAll(/https?:\/\/\S+/g)].map((m) => [m.index!, m.index! + m[0].length] as [number, number])];
    let hit: [number, number] | null = null;
    for (const code of usable) {
      hit = tokenSpans(out, code).find(([a, b]) => !allowed.some(([x, y]) => x <= a && b <= y)) ?? null;
      if (hit) break;
    }
    if (!hit) break;
    const word = out.slice(hit[0], hit[1]).toLowerCase();
    const sub = CODE_WORD_SUBSTITUTES[word] ?? '·';
    let before = out.slice(0, hit[0]);
    let after = out.slice(hit[1]);
    if (sub === '') {
      // A dropped word takes one adjoining space with it; at the start of a line or sentence the next word is capitalised.
      if (after.startsWith(' ')) after = after.slice(1);
      else if (before.endsWith(' ')) before = before.slice(0, -1);
      if (/(^|\n|[.!?:]\s)\s*$/.test(before)) after = after.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
    }
    out = before + sub + after;
  }
  return out;
}

/** Applies `maskStandaloneCodes` to every piece of copy in a board document, then re-renders the text. */
export function guardPublishedCopy(doc: BoardDocument, codes: string[]): BoardDocument {
  if (!codes.some((c) => /[\p{L}\p{N}]/u.test(c))) return doc;
  const names = [...new Set(doc.options.flatMap((o) => o.garments.map((g) => g.name)))];
  const m = (t: string) => maskStandaloneCodes(t, codes, names);
  const mn = (t: string | null) => (t === null ? null : m(t));
  const guarded: BoardDocument = {
    ...doc,
    dayLine: m(doc.dayLine),
    shapeOfDay: m(doc.shapeOfDay),
    suitabilityNote: mn(doc.suitabilityNote),
    shortfall: mn(doc.shortfall),
    weather: { ...doc.weather, line: m(doc.weather.line) },
    options: doc.options.map((o) => ({
      ...o,
      why: m(o.why),
      qualification: mn(o.qualification),
      lines: o.lines.map((l) => ({ ...l, label: m(l.label), text: m(l.text), flourish: l.flourish ? { ...l.flourish, text: m(l.flourish.text) } : null })),
    })),
  };
  guarded.text = m(renderBoardText(guarded));
  return guarded;
}
