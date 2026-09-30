import type { AvailabilityEstimate, GarmentRole } from '@garderobe/contracts';
import type { Eligibility } from '../domain/availability.js';

/**
 * The composer's view of one garment: record facts plus derived, labelled classifications. Nothing
 * here invents a fact; derived values (colour families, thermal band) cite their basis.
 */
export interface WardrobeGarment {
  garmentId: string;
  name: string;
  category: string;
  roles: GarmentRole[];
  maker: string | null;
  color: string | null;
  colorFamily: string | null;
  /** Colour families perceptible in the piece, from the colour text (e.g. "Rust+grey" → rust, grey). */
  families: string[];
  pattern: string | null;
  fabric: string | null;
  fabricClass: string | null;
  weight: string | null;
  notes: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  acquisition: string;
  planningPolicy: string;
  location: string;
  laundryPolicy: string;
  careChannel: string;
  tracking: string;
  eligibility: Eligibility;
  estimate: AvailabilityEstimate | null;
  /** Latest local date with an active counted wear (null = none recorded since logging began). */
  lastWornOn: string | null;
  wornDates: string[];
  thermal: ThermalBand;
  footwearKind: 'sneaker' | 'welted' | 'other' | null;
  statement: boolean;
  indoorOnly: boolean;
  aliases: string[];
  /** Maker product codes (the garment's product code and maker-code aliases). Search only: never shown in board or Calendar copy. */
  makerCodes: string[];
  images: { assetId: string; kind: string; role: 'catalogue' | 'supporting'; verified: boolean }[];
}

export interface ThermalBand {
  minC: number;
  maxC: number;
  basis: string;
}

const FAMILY_WORDS: [RegExp, string][] = [
  [/\bink(y)?\b|\bnavy\b/, 'navy'],
  [/\bblack\b|\bnoir\b/, 'black'],
  [/\bwhite\b|off-white/, 'white'],
  [/\bcream\b/, 'cream'],
  [/\bbeige\b|\bsand\b|\bbiscuit\b|milky tea|\bcamel\b|\bnatural\b|\bstone\b/, 'beige'],
  [/\bwalnut\b/, 'walnut'],
  [/\bbrown\b|\btobacco\b|\bmocha\b|\bmarron\b|\bcafé\b|\bcafe\b|\bbark\b|\bearth\b/, 'brown'],
  [/\bgrey\b|\bgray\b|\bcharcoal\b|pow check|prince of wales/, 'grey'],
  [/\bslate\b/, 'slate'],
  [/\bsage\b/, 'sage'],
  [/\bolive\b|\bfatigue\b|\bkhaki\b/, 'olive'],
  [/\bmoss\b/, 'moss'],
  [/\bgreen\b|\bevergreen\b|\blaurel\b|\bpine\b|\bforest\b|\bemerald\b/, 'green'],
  [/\brust\b|\bclay\b|\bbrick\b/, 'rust'],
  [/\bburgundy\b|\bwine\b|\bmaroon\b/, 'burgundy'],
  [/\bpink\b|\brose\b/, 'pink'],
  [/\bred\b|\bcherry\b/, 'red'],
  [/\bgold\b|\bgolden\b|\byellow\b|\bochre\b/, 'gold'],
  [/\bblue\b|\bdenim\b|\bindigo\b|\bairforce\b/, 'blue'],
];

/** Colour families named in a colour description; "inky blue" is navy, not blue. */
export function familiesOf(color: string | null, fallbackFamily: string | null = null): string[] {
  const c = (color ?? '').toLowerCase();
  const out: string[] = [];
  for (const [re, fam] of FAMILY_WORDS) if (re.test(c) && !out.includes(fam)) out.push(fam);
  if (out.includes('navy')) {
    const i = out.indexOf('blue');
    if (i >= 0 && /\bink(y)?\b/.test(c)) out.splice(i, 1);
  }
  if (!out.length && fallbackFamily && fallbackFamily !== 'multi') out.push(fallbackFamily);
  return out;
}

export const WARM_FAMILIES = ['rust', 'burgundy', 'red', 'pink', 'gold', 'brown', 'beige', 'cream', 'walnut'];
export const COOL_FAMILIES = ['navy', 'blue', 'grey', 'slate', 'sage', 'olive', 'green', 'moss', 'black'];
const LOUD_FAMILIES = ['red', 'pink', 'gold', 'rust', 'burgundy'];
const MAJOR_ROLES: GarmentRole[] = ['base_top', 'mid_layer', 'outer_layer', 'bottom'];

export function isStatementPiece(g: { roles: GarmentRole[]; families: string[]; color: string | null; name: string }): boolean {
  if (!g.roles.some((r) => MAJOR_ROLES.includes(r))) return false;
  if (/rugby/i.test(g.name)) return true;
  if (g.families.some((f) => LOUD_FAMILIES.includes(f))) return true;
  return /laurel|evergreen|emerald|cherry/i.test(g.color ?? '');
}

/**
 * Thermal band of a garment for the role that uses it. Recorded min/max temperatures win; otherwise
 * the inventory season label is mapped to a band (a documented implementation reading of the owner's
 * own labels, not a universal fabric fact).
 */
export function thermalBand(attrs: Record<string, unknown>, fabricClass: string | null, category: string): ThermalBand {
  const min = typeof attrs.minTempC === 'number' ? attrs.minTempC : null;
  const max = typeof attrs.maxTempC === 'number' ? attrs.maxTempC : null;
  const label = typeof attrs.seasonLabel === 'string' ? attrs.seasonLabel : '';
  const outer = ['jacket', 'coat', 'blazer'].includes(category);
  if (category === 'socks') {
    // Socks are worn in every weather (hard.socks_always); merino is the all-weather default.
    if (fabricClass === 'alpaca') return { minC: -30, maxC: 12, basis: 'alpaca socks at 12 °C or colder (spec section 7 table)' };
    return { minC: -30, maxC: 45, basis: 'socks are worn in every weather (profile section 8, rule 1)' };
  }
  if (min !== null || max !== null) {
    // An outer layer rated only "to X °C" is not a cold-weather coat: bound it 16 °C below its ceiling.
    const lower = min ?? (outer && max !== null ? max - 16 : -20);
    return { minC: lower, maxC: max ?? 40, basis: `recorded temperature range${label ? ` ("${label}")` : ''}${min === null && outer ? '; lower bound derived' : ''}` };
  }
  const l = label.toLowerCase();
  const band = (minC: number, maxC: number) => ({ minC, maxC, basis: `season label "${label}"` });
  if (fabricClass === 'lightweight_oxford' && (l === 'all-but-coldest' || !l)) return { minC: 10, maxC: 32, basis: 'lightweight oxford: lower bound 10 °C (spec section 7 table)' };
  if (/30\s*°c\+/.test(l)) return band(30, 45);
  if (l.startsWith('hot')) return band(24, 45);
  if (l === 'warm-weather') return band(20, 40);
  if (l === 'warm-leaning') return band(16, 32);
  if (l === 'warm') return band(18, 40);
  if (l === 'transitional') return band(12, 26);
  if (l === 'all-but-coldest') return band(10, 32);
  if (l === 'all-season' || l === 'year-round' || l.startsWith('all-season')) return outer ? band(4, 20) : band(-10, 30);
  if (l === 'cool') return outer ? band(4, 16) : band(4, 20);
  if (l === 'cool/cold') return outer ? band(-5, 15) : band(-10, 17);
  if (l === 'cold') return outer ? band(-15, 12) : band(-15, 15);
  if (l === 'winter') return band(-20, outer ? 9 : 12);
  return outer ? { minC: 4, maxC: 18, basis: 'no temperature data (default outer band)' } : { minC: -10, maxC: 30, basis: 'no temperature data (default band)' };
}

export const isSneaker = (g: WardrobeGarment) => g.category === 'sneakers';
export const isWelted = (g: WardrobeGarment) => g.attributes.construction === 'welted';
export const isOxfordButtonDown = (g: WardrobeGarment) =>
  ['lightweight_oxford', 'heavy_oxford', 'oxford'].includes(g.fabricClass ?? '') || /\boxford\b/i.test(g.name) || /ivy bd/i.test(g.notes ?? '');
export const isChino = (g: WardrobeGarment) => /chino/i.test(g.name);
export const isJeans = (g: WardrobeGarment) => g.category === 'jeans';
export const isNewBalance = (g: WardrobeGarment) => /new balance/i.test(g.maker ?? '') || /^NB\b/.test(g.name);
export const isBlazer = (g: WardrobeGarment) => g.category === 'blazer';
export const isFieldPiece = (g: WardrobeGarment) =>
  ['jacket', 'coat', 'overshirt'].includes(g.category) && /chore|jungle|work|field|chasseur|safari|overlord|craftsman|revere|observer|traveler|heavy wool/i.test(g.name);
export const isWashed = (g: WardrobeGarment) => /washed|slub|linen|sunwashed/i.test(`${g.fabric ?? ''} ${g.name}`);
export const isStripe = (g: WardrobeGarment) => /stripe/i.test(g.pattern ?? g.name);
export const isDenim = (g: WardrobeGarment) => g.fabricClass === 'denim' || /denim/i.test(g.name);
export const isTie = (g: WardrobeGarment) => g.category === 'tie';
export const isScarf = (g: WardrobeGarment) => g.category === 'scarf';
export const isTextured = (g: WardrobeGarment) =>
  ['corduroy', 'flannel', 'denim', 'linen', 'cotton_linen', 'wool', 'waxed_cotton', 'cashmere'].includes(g.fabricClass ?? '') || /herringbone|tweed|cord|slub|rustic/i.test(`${g.fabric ?? ''} ${g.pattern ?? ''} ${g.name}`);
export const isLightTrouser = (g: WardrobeGarment) => g.families.includes('white') || g.families.includes('cream') || /bone white/i.test(g.color ?? '');
export const isDrawstring = (g: WardrobeGarment) => /drawstring/i.test(g.name);

/** Indigo jeans must carry a perceptible shade word (profile section 8, rule 7). */
export function jeansNameProblem(g: WardrobeGarment, shades: string[]): string | null {
  if (!isJeans(g)) return null;
  const indigo = g.families.includes('blue') || g.families.includes('navy') || /indigo/i.test(`${g.color ?? ''} ${g.name}`);
  if (!indigo) return null;
  return shades.some((s) => new RegExp(`\\b${s}\\b`, 'i').test(g.name)) ? null : `Indigo jeans "${g.name}" need a light, mid or dark name before they can be offered`;
}

/** Short perceptible noun for prose ("oxford", "chinos", "cords"). */
export function nounOf(g: WardrobeGarment): string {
  const n = g.name.toLowerCase();
  if (g.category === 'sneakers') return 'trainers';
  if (g.category === 'jeans') return 'jeans';
  if (/chore/.test(n)) return 'chore coat';
  if (/jungle/.test(n)) return 'jungle jacket';
  if (/work coat/.test(n)) return 'work coat';
  if (/games|blazer/.test(n)) return 'blazer';
  if (/cord|corduroy/.test(n) && g.roles.includes('bottom')) return 'cords';
  if (/cord/.test(n) && g.category === 'blazer') return 'cord jacket';
  if (/flannel/.test(n) && g.roles.includes('bottom')) return 'flannels';
  if (/flannel/.test(n)) return 'flannel shirt';
  if (/chino/.test(n)) return 'chinos';
  if (/fatigue/.test(n)) return 'fatigues';
  if (/5-pocket/.test(n)) return 'five-pockets';
  if (/drawstring/.test(n)) return 'linen trousers';
  if (/oxford/.test(n)) return 'oxford';
  if (/linen/.test(n) && g.roles.includes('base_top')) return 'linen shirt';
  if (/twill/.test(n) && g.roles.includes('base_top')) return 'twill shirt';
  if (/plaid/.test(n)) return 'plaid shirt';
  if (/denim shirt/.test(n)) return 'denim shirt';
  if (/coat/.test(n)) return 'coat';
  if (/jacket|chasseur|revere|safari/.test(n)) return 'jacket';
  if (g.category === 'trousers') return 'trousers';
  if (g.category === 'shirt') return 'shirt';
  return g.category;
}

/** Perceptible colour word for prose, taken from the record's colour text. */
export function colourWord(g: WardrobeGarment): string {
  const raw = (g.color ?? g.colorFamily ?? '').replace(/\(.*?\)/g, '').replace(/[+/]/g, ' and ').trim().toLowerCase();
  return raw || (g.families[0] ?? '');
}
