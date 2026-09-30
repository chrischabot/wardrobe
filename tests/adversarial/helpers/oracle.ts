import type { MandatoryContext } from '../../../backend/src/recommend/context.js';
import type { WardrobeGarment } from '../../../backend/src/recommend/garments.js';

/**
 * An independent oracle for the owner's section 8 hard constraints, written from the profile text
 * rather than from the validator's code, so a validator bug is not also a test bug. It only reads the
 * mandatory context (garment facts, weather, recent wears) that the product assembled.
 */

export interface OracleSlot {
  garmentId: string;
  role: string;
  alternativeGroup?: string | null;
}

const WELTED_OR_BOOT = (g: WardrobeGarment) => g.category !== 'sneakers' || g.attributes.construction === 'welted' || g.attributes.model === '990v6';

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Returns the list of broken hard constraints (empty = compliant). */
export function hardConstraintBreaks(slots: OracleSlot[], ctx: MandatoryContext, opts: { sneakersOnly?: boolean; allowRepeats?: boolean } = {}): string[] {
  const out: string[] = [];
  const g = (s: OracleSlot) => ctx.byId.get(s.garmentId);
  const unknown = slots.filter((s) => !g(s));
  if (unknown.length) out.push(`unknown garment ${unknown.map((s) => s.garmentId).join(',')}`);
  const by = (role: string) => slots.filter((s) => s.role === role).map(g).filter((x): x is WardrobeGarment => Boolean(x));
  const tops = by('base_top');
  const bottoms = by('bottom');
  const socks = by('socks');
  const shoes = by('footwear');
  const outer = by('outer_layer')[0] ?? null;
  const mid = by('mid_layer')[0] ?? null;
  if (tops.length !== 1) out.push('not exactly one shirt');
  if (bottoms.length !== 1) out.push('not exactly one pair of trousers');
  if (shoes.length < 1) out.push('no footwear');
  if (new Set(slots.map((s) => s.garmentId)).size !== slots.length) out.push('garment twice');
  for (const s of slots) {
    const x = g(s);
    if (x && !x.roles.includes(s.role as never)) out.push(`${x.name} cannot be ${s.role}`);
  }
  // Socks always, in any weather; bed socks are indoor only; alpaca only at 12 °C or colder.
  const peak = ctx.thermal.peakTempC;
  if (socks.length !== 1) out.push('socks missing (socks always)');
  for (const s of socks) {
    if (s.indoorOnly) out.push(`${s.name} is indoor-only`);
    if (s.fabricClass === 'alpaca' && peak > 12) out.push(`${s.name}: alpaca above 12 °C`);
  }
  // Sneakers only until healed: no shoes/boots, no welted construction, no 990v6.
  if (opts.sneakersOnly ?? true) for (const f of shoes) if (WELTED_OR_BOOT(f)) out.push(`${f.name} breaks sneakers-only`);
  // Thermal: base for the peak, jacket for the departure.
  for (const b of [...tops, ...bottoms, ...(mid ? [mid] : [])]) if (!(b.thermal.minC <= peak && peak <= b.thermal.maxC)) out.push(`${b.name} not for a ${peak} °C peak`);
  const dep = ctx.thermal.departureTempC;
  if (outer && !(outer.thermal.minC <= dep && dep <= outer.thermal.maxC)) out.push(`${outer.name} not for a ${dep} °C departure`);
  const band = Math.round(dep);
  if (outer && band >= 14 && band <= 16) {
    if (tops[0] && tops[0].fabricClass !== 'lightweight_oxford') out.push(`jacket at ${dep} °C over ${tops[0].name} (needs a lightweight oxford)`);
    if (mid) out.push(`jacket and knit at ${dep} °C`);
  }
  // Variety: no shirt or trousers worn in the last seven days.
  if (!opts.allowRepeats) {
    const from = addDays(ctx.day.date, -7);
    for (const x of [...tops, ...bottoms]) if (x.wornDates.some((d) => d >= from && d < ctx.day.date)) out.push(`${x.name} worn within seven days`);
  }
  // Availability: benched/excluded, away, restricted, occasional-not-requested, dirty.
  for (const s of slots) {
    const x = g(s);
    if (!x) continue;
    if (x.planningPolicy === 'excluded') out.push(`${x.name} is benched`);
    if (x.planningPolicy === 'occasional' && !ctx.request.include.includes(x.garmentId)) out.push(`${x.name} occasional, not requested`);
    if (!x.eligibility.available) out.push(`${x.name} unavailable (${x.eligibility.label})`);
    if (['per_wear', 'single_wear_day'].includes(x.laundryPolicy) && (!x.estimate || x.estimate.estimatedCleanUnits <= 0)) out.push(`${x.name} has no clean unit`);
  }
  // No maker codes or watches/jewellery.
  for (const s of slots) {
    const x = g(s);
    if (x && /\bPCF\d+\b/.test(x.name)) out.push(`${x.name} carries a maker code`);
    if (x && /watch|\bring\b|bracelet|necklace|jewel|cufflink/i.test(x.name)) out.push(`${x.name} is jewellery`);
  }
  return out;
}

export function isNavy(g: WardrobeGarment | undefined): boolean {
  return Boolean(g && (g.families.includes('navy') || g.colorFamily === 'navy'));
}
