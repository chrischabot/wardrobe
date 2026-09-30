/**
 * Independent checks of what the MCP server returned. They reuse the journey suite's section 8 hard
 * constraint checkers (tests/journeys/harness/profile.ts), which compute from the garments' own
 * records and never read the validator's evidence, plus the simulation's own availability oracle:
 * garments the simulated owner declared away (tailor, repair, storage, laundry exception, a spill not
 * yet laundered, packed for the trip) and the product's own unavailable list at that moment.
 */
import type { BoardGarment, TodayResponse, WardrobeItem } from '@garderobe/contracts';
import { hardConstraintViolations, isRestrictedFootwear, offered } from '../../journeys/harness/profile.js';

export interface DayContextForChecks {
  date: string;
  peakC: number | null;
  departureC: number | null;
  wornLastSevenDays: Set<string>;
  sneakersOnly: boolean;
  /** Garments the owner declared away at this moment (reason per id). */
  declaredAway: Map<string, string>;
  /** The product's own unavailable list (garderobe_inventory availability=unavailable) at this moment, with its label. */
  productUnavailable: Map<string, string>;
  /** Trip days allow deliberate repeats (the trip's allowRepeats). */
  allowRepeats: boolean;
}

export interface SlotLike {
  garmentId: string;
  role: string;
  alternativeGroup?: string | null;
}

export function asToday(date: string, options: { optionId: string; slots: SlotLike[] }[], wardrobe: Map<string, WardrobeItem>): TodayResponse {
  const ids = new Set(options.flatMap((o) => o.slots.map((s) => s.garmentId)));
  const garments: BoardGarment[] = [...ids].filter((id) => wardrobe.has(id)).map((id) => ({ ...wardrobe.get(id)!.garment, aliases: [], media: null }) as unknown as BoardGarment);
  return {
    date,
    board: { options: options.map((o, i) => ({ optionId: o.optionId, position: i + 1, slots: o.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup ?? null })), status: 'offerable', explanation: '', validation: {} })), document: null },
    garments,
  } as unknown as TodayResponse;
}

/** Every section 8 hard constraint plus availability, for any set of offered outfits. */
export function outfitViolations(today: TodayResponse, ctx: DayContextForChecks): string[] {
  const out: string[] = [];
  if (ctx.peakC !== null && ctx.departureC !== null) {
    out.push(...hardConstraintViolations(today, { peakC: ctx.peakC, departureC: ctx.departureC, wornLastSevenDays: ctx.allowRepeats ? new Set() : ctx.wornLastSevenDays, sneakersOnly: ctx.sneakersOnly }));
  } else {
    // Without a thermal basis only the non-thermal rules can be checked independently.
    out.push(...hardConstraintViolations(today, { peakC: 15, departureC: 15, wornLastSevenDays: ctx.allowRepeats ? new Set() : ctx.wornLastSevenDays, sneakersOnly: ctx.sneakersOnly }).filter((v) => !/rated|jacket at/.test(v)));
  }
  for (const o of offered(today)) {
    for (const g of o.garments) {
      const away = ctx.declaredAway.get(g.garmentId);
      if (away) out.push(`option ${o.option.position} offers ${g.name}, which the owner declared away (${away})`);
      else if (ctx.productUnavailable.has(g.garmentId)) out.push(`option ${o.option.position} offers ${g.name}, which the inventory lists as unavailable ("${ctx.productUnavailable.get(g.garmentId)}")`);
    }
    if (o.option.slots.some((s) => !today.garments?.some((g) => g.garmentId === s.garmentId))) out.push(`option ${o.option.position} names a garment id that is not in the owner's wardrobe`);
  }
  return out;
}

export interface OutfitCardLike {
  actionable: boolean;
  date: string;
  slots: { garmentId: string; role: string; name: string | null; alternativeGroup: string | null }[];
  failedRules: { ruleKey: string; detail: string }[];
}

export interface CardFinding {
  card: number;
  actionable: boolean;
  failedRules: string[];
  violations: string[];
}

/**
 * An actionable card must satisfy every hard constraint and reference only available garments; a
 * rejected card must name the rule it failed.
 */
export function cardFindings(cards: OutfitCardLike[], ctx: DayContextForChecks, wardrobe: Map<string, WardrobeItem>, available: Set<string>): CardFinding[] {
  return cards.map((card, i) => {
    const violations: string[] = [];
    if (card.actionable) {
      const today = asToday(card.date, [{ optionId: `card-${i}`, slots: card.slots }], wardrobe);
      violations.push(...outfitViolations(today, card.date === ctx.date ? ctx : { ...ctx, peakC: null, departureC: null }));
      for (const s of card.slots) if (!available.has(s.garmentId) && !ctx.declaredAway.has(s.garmentId) && !ctx.productUnavailable.has(s.garmentId)) violations.push(`card slot ${s.name ?? s.garmentId} was not in the available list when the question was asked`);
    } else {
      if (!card.failedRules.length) violations.push('rejected card names no failed rule');
      for (const f of card.failedRules) if (!f.ruleKey || !/^[a-z_]+(\.[a-z0-9_]+)+$/i.test(f.ruleKey)) violations.push(`rejected card rule key "${f.ruleKey}" is not a rule identifier`);
    }
    return { card: i, actionable: card.actionable, failedRules: card.failedRules.map((f) => f.ruleKey), violations };
  });
}

/** Answer text checks: no maker codes (profile section 7) and no internal garment ids. */
export function answerTextFindings(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  if (/\bPCF\s?\d{3,}/i.test(text)) out.push(`answer contains a maker code (${/\bPCF\s?\d{3,}/i.exec(text)![0]})`);
  if (/\bg_[A-Za-z0-9]{8,}\b/.test(text)) out.push(`answer exposes an internal garment id (${/\bg_[A-Za-z0-9]{8,}\b/.exec(text)![0]})`);
  return out;
}

export { isRestrictedFootwear };
