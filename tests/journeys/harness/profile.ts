import type { BoardGarment, BoardOptionDocument, OutfitOption, TodayResponse } from '@garderobe/contracts';

/**
 * Independent checks of the owner's section 8 hard constraints (data/owner-profile.md) against a
 * published board, computed from the garments' own records as the API returns them. They do not
 * read the validator's evidence, so a validator bug cannot hide a violation. Each checker returns
 * human-readable violations; a journey asserts the list is empty.
 */

export interface OfferedOption {
  option: OutfitOption;
  doc: BoardOptionDocument | undefined;
  garments: BoardGarment[];
  byRole: (role: string) => BoardGarment[];
}

export function offered(today: TodayResponse): OfferedOption[] {
  const byId = new Map((today.garments ?? []).map((g) => [g.garmentId, g]));
  const docs = new Map((today.board?.document?.options ?? []).map((o) => [o.optionId, o]));
  return (today.board?.options ?? [])
    .filter((o) => o.status === 'offerable')
    .map((option) => {
      const garments = option.slots.map((s) => byId.get(s.garmentId)).filter((g): g is BoardGarment => Boolean(g));
      const roleOf = new Map(option.slots.map((s) => [s.garmentId, s.role]));
      return { option, doc: docs.get(option.optionId), garments, byRole: (role: string) => garments.filter((g) => roleOf.get(g.garmentId) === role) };
    });
}

const label = (o: OfferedOption) => `option ${o.option.position}`;
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

export const isRestrictedFootwear = (g: BoardGarment): boolean =>
  g.category !== 'sneakers' || g.attributes.construction === 'welted' || String(g.attributes.model ?? '').toLowerCase() === '990v6' || /990v6/i.test(g.name);
export const isWeltedAlternative = (g: BoardGarment): boolean => g.attributes.construction === 'welted' || g.category === 'shoes' || g.category === 'boots';

/** Rule 1: socks always, in every option. */
export function socksAlways(today: TodayResponse): string[] {
  return offered(today).flatMap((o) => (o.byRole('socks').some((g) => g.category === 'socks') ? [] : [`${label(o)} has no socks`]));
}

/** Rule 2: sneakers only while the healing restriction stands (no welted, boots, shoes or 990v6). */
export function sneakersOnly(today: TodayResponse): string[] {
  return offered(today).flatMap((o) => o.byRole('footwear').filter(isRestrictedFootwear).map((g) => `${label(o)} offers ${g.name} (${g.category}${g.attributes.construction ? `, ${g.attributes.construction}` : ''}) while sneakers-only stands`));
}

/** Rule 3 (once lifted): every outfit names both a sneaker and a welted alternative. */
export function sneakerAndWelted(today: TodayResponse): string[] {
  return offered(today).flatMap((o) => {
    const shoes = o.byRole('footwear');
    const sneaker = shoes.some((g) => g.category === 'sneakers');
    const welted = shoes.some(isWeltedAlternative);
    return sneaker && welted ? [] : [`${label(o)} footwear is ${shoes.map((g) => g.name).join(' / ') || 'none'}: needs a sneaker and a welted alternative`];
  });
}

/** Rule 4: shirts, knits and trousers against the day's peak, via each garment's recorded temperature range. */
export function baseLayersFitPeak(today: TodayResponse, peakC: number): string[] {
  return offered(today).flatMap((o) =>
    [...o.byRole('base_top'), ...o.byRole('mid_layer'), ...o.byRole('bottom')].flatMap((g) => {
      const min = num(g.attributes.minTempC);
      const max = num(g.attributes.maxTempC);
      if (max !== null && peakC > max) return [`${label(o)}: ${g.name} is rated to ${max} °C but the peak is ${peakC} °C`];
      if (min !== null && peakC < min) return [`${label(o)}: ${g.name} is rated from ${min} °C but the peak is ${peakC} °C`];
      return [];
    }),
  );
}

/** Rule 4: only outerwear answers the morning, via its recorded range against the departure temperature. */
export function outerwearFitsDeparture(today: TodayResponse, departureC: number): string[] {
  return offered(today).flatMap((o) =>
    o.byRole('outer_layer').flatMap((g) => {
      const min = num(g.attributes.minTempC);
      const max = num(g.attributes.maxTempC);
      if (max !== null && departureC > max) return [`${label(o)}: jacket ${g.name} is rated to ${max} °C; departure is ${departureC} °C`];
      if (min !== null && departureC < min) return [`${label(o)}: jacket ${g.name} is rated from ${min} °C; departure is ${departureC} °C`];
      return [];
    }),
  );
}

/** Rule 4: at roughly 14–16 °C a jacket goes over a lightweight oxford only. */
export function jacketBandLightOxford(today: TodayResponse, departureC: number): string[] {
  const t = Math.round(departureC);
  if (t < 14 || t > 16) return [];
  return offered(today).flatMap((o) => {
    if (!o.byRole('outer_layer').length) return [];
    const tops = [...o.byRole('base_top'), ...o.byRole('mid_layer')];
    return tops.filter((g) => g.attributes.fabricClass !== 'lightweight_oxford').map((g) => `${label(o)}: jacket at ${departureC} °C over ${g.name} (${g.attributes.fabricClass ?? 'not lightweight oxford'})`);
  });
}

/** Rule 5: no shirt or trousers worn in the last seven days. */
export function noRepeatWithinWeek(today: TodayResponse, wornLastSevenDays: Set<string>): string[] {
  return offered(today).flatMap((o) =>
    [...o.byRole('base_top'), ...o.byRole('bottom')].filter((g) => wornLastSevenDays.has(g.garmentId)).map((g) => `${label(o)} repeats ${g.name}, worn in the last seven days`),
  );
}

/** Indigo/blue jeans hang as a narrow side profile: those are the ones named light, mid or dark (coloured denim keeps its colour). */
export const isIndigoDenim = (g: { color?: string | null; colorFamily?: string | null }): boolean =>
  /indigo|blue|denim/i.test(`${g.color ?? ''} ${g.colorFamily ?? ''}`) && !/white|olive|black|ecru|grey|stone|cream/i.test(g.color ?? '');

/** Rule 7: names are what he sees at the wardrobe; jeans are light, mid or dark; no maker codes. */
export function perceptibleNames(today: TodayResponse): string[] {
  return offered(today).flatMap((o) =>
    o.garments.flatMap((g) => {
      const out: string[] = [];
      if (g.category === 'jeans' && isIndigoDenim(g) && !/\b(light|mid|dark)\b/i.test(g.name)) out.push(`${label(o)}: jeans named "${g.name}" without light/mid/dark`);
      if (/\bPCF\s?\d+/i.test(g.name) || /^g_[a-z0-9]+$/i.test(g.name)) out.push(`${label(o)}: "${g.name}" is a code, not a perceptible name`);
      const lines = (o.doc?.lines ?? []).filter((l) => l.garmentIds.includes(g.garmentId));
      for (const l of lines) if (/\bPCF\s?\d+/i.test(l.text)) out.push(`${label(o)}: line "${l.text}" contains a maker code`);
      return out;
    }),
  );
}

/** Benched (planning excluded), incoming, disposed and away pieces are never offered. */
export function onlyEligiblePieces(today: TodayResponse): string[] {
  return offered(today).flatMap((o) =>
    o.garments.flatMap((g) => {
      const out: string[] = [];
      if (g.planningPolicy === 'excluded') out.push(`${label(o)} offers benched ${g.name}`);
      if (g.acquisition !== 'owned') out.push(`${label(o)} offers ${g.acquisition} ${g.name}`);
      if (g.location !== 'home') out.push(`${label(o)} offers ${g.name}, which is at ${g.location}`);
      return out;
    }),
  );
}

/** Every hard constraint that applies to an ordinary day while sneakers-only stands. */
export function hardConstraintViolations(today: TodayResponse, ctx: { peakC: number; departureC: number; wornLastSevenDays?: Set<string>; sneakersOnly?: boolean }): string[] {
  return [
    ...socksAlways(today),
    ...(ctx.sneakersOnly === false ? sneakerAndWelted(today) : sneakersOnly(today)),
    ...baseLayersFitPeak(today, ctx.peakC),
    ...outerwearFitsDeparture(today, ctx.departureC),
    ...jacketBandLightOxford(today, ctx.departureC),
    ...noRepeatWithinWeek(today, ctx.wornLastSevenDays ?? new Set()),
    ...perceptibleNames(today),
    ...onlyEligiblePieces(today),
  ];
}

export const isNavy = (g: { colorFamily?: string | null; color?: string | null; name: string }): boolean => g.colorFamily === 'navy' || /\bnavy\b/i.test(g.color ?? '') || /\bnavy\b/i.test(g.name);
