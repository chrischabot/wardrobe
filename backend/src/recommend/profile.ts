import type { StyleRule } from '@garderobe/contracts';
import type { StyleContext } from '../domain/style.js';

/**
 * The owner profile compiled into checks (profile sections 3, 5, 6, 8, 9 and 11; foundation rule
 * catalogue data/owner-profile-rules.json). Every parameter comes from the owner's stored rules, so an
 * owner edit of a rule changes the check. Each check reports its ruleKey and passage.
 *
 * Hard (the validator rejects; never traded against a better-looking outfit):
 *   hard.socks_always, hard.sneakers_only_until_healed, hard.sneaker_and_welted_alternative,
 *   hard.thermal_peak_for_base, hard.thermal_morning_for_outerwear,
 *   hard.thermal_jacket_14_16_lightweight_oxford, hard.variety_seven_days, hard.never_fall_back_to_navy
 *   (swap path), hard.perceptible_names, colour.no_neutral_three_times, register.home_key_never_only
 *   (board level), accessories.no_watches_or_jewellery, filter.* (excluded tags), fabric.merino_socks_exception.
 * Soft (ranking and board variety):
 *   colour.foot_echoes_higher_up, colour.palette, register.safe_never_leads, register.avoid_clown,
 *   accessories.belt_line_optional_flourish, fabric.sings, fabric.repels, board_format.daily_entry,
 *   advice.morning_swap_not_rebuild.
 */

export interface RuleRef {
  ruleKey: string;
  strength: 'hard' | 'soft';
  section: string | null;
  quote: string | null;
  /** Set when a dated owner exception relaxes the rule for this date. */
  relaxedBy: string | null;
}

export interface ProfilePolicy {
  policyVersion: 'profile-policy/1';
  documentSha256: string | null;
  documentVersion: number | null;
  rules: Record<string, RuleRef>;
  socks: { required: boolean; defaultFabricClass: string };
  sneakersOnly: { active: boolean; restrictionIds: string[] };
  sneakerAndWelted: { active: boolean; dormant: boolean };
  thermal: { peakForBase: boolean; morningForOuterwear: boolean };
  jacketBand: { active: boolean; minC: number; maxC: number; requiredBaseFabricClass: string };
  repeat: { active: boolean; horizonDays: number; roles: string[]; broaderPatternDays: number };
  navyFallback: { active: boolean; colorFamily: string };
  names: { active: boolean; jeansShades: string[] };
  neutrals: { active: boolean; max: number; families: string[] };
  footEcho: boolean;
  palette: { core: string[]; accents: string[] };
  homeKeyNeverOnly: boolean;
  safeNeverLeads: boolean;
  maxStatementPieces: number;
  excludedTags: string[];
  forbiddenAccessoryTypes: string[];
  beltFlourish: boolean;
  fabricSings: string[];
  fabricRepels: string[];
  defaultOptionCount: number;
  /** Dated owner briefs active for the date (text is preserved; relaxations are listed per rule). */
  briefs: { ruleKey: string; text: string; overridesRuleKey: string | null; validFrom: string | null; validTo: string | null }[];
  precedence: string;
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strs = (v: unknown, d: string[]): string[] => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : d);

export function compileProfilePolicy(style: StyleContext, activeRestrictions: { restrictionId: string; ruleKey: string | null }[]): ProfilePolicy {
  const byKey = new Map<string, StyleRule>(style.rules.map((r) => [r.ruleKey, r]));
  const relaxed = new Map<string, StyleRule>();
  for (const b of style.temporaryBriefs) if (b.overridesRuleKey) relaxed.set(b.overridesRuleKey, b);
  const refs: Record<string, RuleRef> = {};
  for (const r of style.rules) {
    refs[r.ruleKey] = { ruleKey: r.ruleKey, strength: r.strength, section: r.passage?.section ?? null, quote: r.passage?.quote ?? null, relaxedBy: relaxed.get(r.ruleKey)?.ruleKey ?? null };
  }
  const m = (key: string): Record<string, unknown> | null => (byKey.has(key) ? byKey.get(key)!.machine : null);
  // An owner exception applies only to rules whose policy allows it (the foundation rejects others at write time).
  const on = (key: string) => byKey.has(key) && !(relaxed.has(key) && byKey.get(key)!.exceptionPolicy === 'owner_scoped');

  const socks = m('hard.socks_always');
  const sneakers = m('hard.sneakers_only_until_healed');
  const restrictionIds = sneakers ? activeRestrictions.filter((r) => r.ruleKey === 'hard.sneakers_only_until_healed').map((r) => r.restrictionId) : [];
  const jacket = m('hard.thermal_jacket_14_16_lightweight_oxford');
  const band = (jacket?.jacketTemperatureRangeC as number[] | undefined) ?? [14, 16];
  const repeat = m('hard.variety_seven_days');
  const neutrals = m('colour.no_neutral_three_times');
  const palette = m('colour.palette');
  const clown = m('register.avoid_clown');
  const board = m('board_format.daily_entry');
  const excludedTags = [
    ...strs(m('filter.categories_out')?.excludeTags, []),
    ...strs(m('filter.no_logos_or_insignia')?.excludeTags, []),
    ...strs(m('filter.no_city_blazer')?.excludeTags, []),
  ];
  const dormant = style.dormantRuleKeys.includes('hard.sneaker_and_welted_alternative');
  return {
    policyVersion: 'profile-policy/1',
    documentSha256: style.documents[0]?.contentSha256 ?? null,
    documentVersion: style.documents[0]?.version ?? null,
    rules: refs,
    socks: { required: byKey.has('hard.socks_always'), defaultFabricClass: String(socks?.defaultSockFabricClass ?? 'merino') },
    sneakersOnly: { active: Boolean(sneakers) && restrictionIds.length > 0, restrictionIds },
    sneakerAndWelted: { active: byKey.has('hard.sneaker_and_welted_alternative') && !dormant && !(Boolean(sneakers) && restrictionIds.length > 0) && on('hard.sneaker_and_welted_alternative'), dormant },
    thermal: { peakForBase: byKey.has('hard.thermal_peak_for_base'), morningForOuterwear: byKey.has('hard.thermal_morning_for_outerwear') },
    jacketBand: { active: on('hard.thermal_jacket_14_16_lightweight_oxford'), minC: num(band[0], 14), maxC: num(band[1], 16), requiredBaseFabricClass: String(jacket?.requiredBaseTopFabricClass ?? 'lightweight_oxford') },
    repeat: { active: on('hard.variety_seven_days'), horizonDays: num(repeat?.horizonDays, 7), roles: strs(repeat?.roles, ['base_top', 'bottom']), broaderPatternDays: num(repeat?.broaderPatternDays, 14) },
    navyFallback: { active: on('hard.never_fall_back_to_navy'), colorFamily: String((m('hard.never_fall_back_to_navy')?.onSwap as Record<string, unknown> | undefined)?.forbidFallbackColorFamily ?? 'navy') },
    names: { active: byKey.has('hard.perceptible_names'), jeansShades: strs(m('hard.perceptible_names')?.jeansShadeVocabulary, ['light', 'mid', 'dark']) },
    neutrals: {
      active: on('colour.no_neutral_three_times'),
      max: num(neutrals?.maxOccurrencesPerNeutral, 2),
      families: strs(neutrals?.neutralFamilies, ['beige', 'stone', 'cream', 'walnut', 'grey', 'white', 'black', 'navy', 'brown']),
    },
    footEcho: byKey.has('colour.foot_echoes_higher_up'),
    palette: { core: strs(palette?.core, []), accents: strs(palette?.accents, []) },
    homeKeyNeverOnly: on('register.home_key_never_only'),
    safeNeverLeads: byKey.has('register.safe_never_leads'),
    maxStatementPieces: num(clown?.maxStatementPieces, 1),
    excludedTags,
    forbiddenAccessoryTypes: strs(m('accessories.no_watches_or_jewellery')?.forbidAccessoryTypes, ['watch', 'jewellery']),
    beltFlourish: byKey.has('accessories.belt_line_optional_flourish'),
    fabricSings: strs(m('fabric.sings')?.prefer, []),
    fabricRepels: strs(m('fabric.repels')?.purchaseGateExclude, []),
    defaultOptionCount: num(board?.defaultOptionCount, 5),
    briefs: style.temporaryBriefs.map((b) => ({ ruleKey: b.ruleKey, text: b.statement, overridesRuleKey: b.overridesRuleKey, validFrom: b.validFrom, validTo: b.validTo })),
    precedence: style.precedence,
  };
}

export function ruleRef(policy: ProfilePolicy, key: string): RuleRef {
  return policy.rules[key] ?? { ruleKey: key, strength: 'hard', section: null, quote: null, relaxedBy: null };
}
