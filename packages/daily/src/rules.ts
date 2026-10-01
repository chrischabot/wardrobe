/**
 * The owner's machine rules as the validator uses them. Only ACTIVE rules are enforced; rules that
 * are `pending_reconciliation` or `dormant` are carried as evidence and never silently applied
 * (specification section 7: older research rules are reconciled before activation).
 */
import type { Role, StyleRule } from "@garderobe/contracts";

export interface RuleRef {
  key: string;
  version: number;
}

export interface FabricBound extends RuleRef {
  fabricClass: string;
  minC: number | null;
  maxC: number | null;
  basis: "daytime_peak" | "outdoor_interval";
}

export interface LayeringRule extends RuleRef {
  minC: number;
  maxC: number;
  requiredShirtFabricClass: string;
}

/** Which pieces a combination rule is about: every stated field of a piece must match. */
export interface PieceMatch {
  fabricClasses?: string[];
  categories?: string[];
  jacketLike?: boolean;
}

/**
 * A layer-combination comfort rule: two (or more) individually eligible pieces that the owner finds
 * too warm together inside a temperature band. Stored as a versioned style rule `layering.<name>` with
 * params `{ basis, minC?, maxC?, pieces: { outer?, top?, mid_layer?, bottom? } }`.
 */
export interface CombinationRule extends RuleRef {
  minC: number | null;
  maxC: number | null;
  basis: "daytime_peak" | "outdoor_interval";
  pieces: Partial<Record<"outer" | "top" | "mid_layer" | "bottom", PieceMatch>>;
  interpretation: string;
}

export interface RuleSet {
  /** Every current rule with its status, for validation evidence. */
  versions: { key: string; version: number; status: string; kind: string }[];
  socksRequired: RuleRef | null;
  defaultSockFabricClass: string | null;
  sneakersOnly: (RuleRef & { allowedKinds: string[]; excludedModels: string[]; restrictionId: string | null; inForce: boolean }) | null;
  pairedFootwear: (RuleRef & { inForce: boolean }) | null;
  jacketBand: LayeringRule | null;
  /** Owner-activated combination rules beyond the 14-16 C jacket rule. */
  combinations: CombinationRule[];
  /** Roles whose garment bounds with an unsettled basis resolve to the daytime peak (active profile rule). */
  peakRoles: Role[];
  peakRule: RuleRef | null;
  /** True when the active profile rule assesses outerwear against the outdoor (departure) interval. */
  outerFollowsDeparture: RuleRef | null;
  fabricBounds: FabricBound[];
  outerwearCeiling: (RuleRef & { maxC: number; basis: "daytime_peak" | "outdoor_interval" }) | null;
  repeat: { key: string | null; version: number | null; days: number; categories: string[] };
  patternDays: number;
  indoorOnly: RuleRef | null;
  excludedAccessories: (RuleRef & { words: string[] }) | null;
  navySwap: (RuleRef & { family: string }) | null;
  neutralMax: (RuleRef & { max: number }) | null;
  /** Retained but not enforced, with the reason. */
  notEnforced: { key: string; status: string; interpretation: string }[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Derive the enforced rule set. `activeRestrictionIds` decides whether the sneakers-only rule is in
 * force: it follows its healing restriction, which only the owner's explicit statement resolves.
 */
export function buildRuleSet(rules: StyleRule[], opts: { activeRestrictionIds: Set<string>; repeatHorizonDays: number; patternHorizonDays: number }): RuleSet {
  const out: RuleSet = {
    versions: rules.map((r) => ({ key: r.key, version: r.version, status: r.status, kind: r.kind })),
    socksRequired: null,
    defaultSockFabricClass: null,
    sneakersOnly: null,
    pairedFootwear: null,
    jacketBand: null,
    combinations: [],
    peakRoles: [],
    peakRule: null,
    outerFollowsDeparture: null,
    fabricBounds: [],
    outerwearCeiling: null,
    repeat: { key: null, version: null, days: opts.repeatHorizonDays, categories: ["shirt", "trousers"] },
    patternDays: opts.patternHorizonDays,
    indoorOnly: null,
    excludedAccessories: null,
    navySwap: null,
    neutralMax: null,
    notEnforced: [],
  };
  let sneakersRule: StyleRule | null = null;
  let pairedRule: StyleRule | null = null;
  for (const r of rules) {
    const ref = { key: r.key, version: r.version };
    const p = r.params;
    if (r.key === "footwear.sneakers_only_until_healed") {
      if (r.status !== "retired") sneakersRule = r;
      continue;
    }
    if (r.key === "footwear.name_sneaker_and_welted_alternative") {
      if (r.status !== "retired") pairedRule = r;
      continue;
    }
    if (r.status !== "active") {
      if (r.status !== "retired") out.notEnforced.push({ key: r.key, status: r.status, interpretation: r.interpretation });
      continue;
    }
    switch (r.key) {
      case "socks.required":
        out.socksRequired = ref;
        out.defaultSockFabricClass = str(p.defaultFabricClass);
        break;
      case "thermal.base_layers_follow_daytime_peak":
        out.peakRule = ref;
        out.peakRoles = strings(p.roles) as Role[];
        break;
      case "thermal.outerwear_follows_morning":
        out.outerFollowsDeparture = ref;
        break;
      case "thermal.jacket_14_16_lightweight_oxford_only": {
        const minC = num(p.minC);
        const maxC = num(p.maxC);
        const fabric = str(p.requiredShirtFabricClass);
        if (minC !== null && maxC !== null && fabric) out.jacketBand = { ...ref, minC, maxC, requiredShirtFabricClass: fabric };
        break;
      }
      case "thermal.outerwear_ceiling": {
        const maxC = num(p.maxC);
        // An unsettled basis is never silently resolved to morning or peak.
        if (maxC !== null && (p.basis === "daytime_peak" || p.basis === "outdoor_interval")) out.outerwearCeiling = { ...ref, maxC, basis: p.basis };
        else out.notEnforced.push({ key: r.key, status: "active_basis_unsettled", interpretation: r.interpretation });
        break;
      }
      case "variety.repeat_horizon": {
        const days = num(p.days);
        const categories = strings(p.categories);
        out.repeat = { key: r.key, version: r.version, days: days ?? opts.repeatHorizonDays, categories: categories.length > 0 ? categories : ["shirt", "trousers"] };
        break;
      }
      case "variety.nothing_repeats_inside_a_fortnight": {
        const days = num(p.days);
        if (days !== null) out.patternDays = days;
        break;
      }
      case "socks.bed_socks_indoors_only":
        out.indoorOnly = ref;
        break;
      case "accessories.no_watches_or_jewellery":
        out.excludedAccessories = { ...ref, words: strings(p.excluded) };
        break;
      case "swap.never_fall_back_to_navy":
        out.navySwap = { ...ref, family: str(p.avoidColourFamilyOnSwap) ?? "navy" };
        break;
      case "colour.no_neutral_three_times": {
        const max = num(p.maxSameNeutralPerOutfit);
        if (max !== null) out.neutralMax = { ...ref, max };
        break;
      }
      default:
        if (r.key.startsWith("layering.") && r.kind === "hard") {
          const pieces: CombinationRule["pieces"] = {};
          const raw = (p.pieces ?? {}) as Record<string, any>;
          for (const role of ["outer", "top", "mid_layer", "bottom"] as const) {
            const m = raw[role];
            if (!m || typeof m !== "object") continue;
            const match: PieceMatch = {};
            if (strings(m.fabricClasses).length > 0) match.fabricClasses = strings(m.fabricClasses);
            if (strings(m.categories).length > 0) match.categories = strings(m.categories);
            if (typeof m.jacketLike === "boolean") match.jacketLike = m.jacketLike;
            pieces[role] = match;
          }
          // A combination rule names at least two pieces and a settled temperature basis; anything less is not enforced.
          if (Object.keys(pieces).length >= 2 && (p.basis === "daytime_peak" || p.basis === "outdoor_interval") && (num(p.minC) !== null || num(p.maxC) !== null)) {
            out.combinations.push({ ...ref, minC: num(p.minC), maxC: num(p.maxC), basis: p.basis, pieces, interpretation: r.interpretation });
          } else {
            out.notEnforced.push({ key: r.key, status: "active_incomplete", interpretation: r.interpretation });
          }
          break;
        }
        // Generic fabric-class temperature bounds: thermal.<anything> with { fabricClass, minC|maxC, basis }.
        if (r.key.startsWith("thermal.") && r.kind === "hard" && str(p.fabricClass)) {
          if (p.basis === "daytime_peak" || p.basis === "outdoor_interval") {
            out.fabricBounds.push({ ...ref, fabricClass: str(p.fabricClass)!, minC: num(p.minC), maxC: num(p.maxC), basis: p.basis });
          } else {
            out.notEnforced.push({ key: r.key, status: "active_basis_unsettled", interpretation: r.interpretation });
          }
        }
    }
  }
  if (sneakersRule) {
    const restrictionId = str(sneakersRule.params.restrictionId);
    // In force while the rule is active and its restriction (when it names one) has not been resolved by the owner.
    const inForce = sneakersRule.status === "active" && (restrictionId === null || opts.activeRestrictionIds.has(restrictionId));
    out.sneakersOnly = {
      key: sneakersRule.key,
      version: sneakersRule.version,
      allowedKinds: strings(sneakersRule.params.allowedFootwearKinds),
      excludedModels: strings(sneakersRule.params.excludedModels).map((m) => m.toLowerCase()),
      restrictionId,
      inForce,
    };
  }
  if (pairedRule) {
    // Dormant while the healing restriction is active: the restriction outranks the paired-shoe format.
    const inForce = pairedRule.status === "active" || (pairedRule.status === "dormant" && out.sneakersOnly !== null && !out.sneakersOnly.inForce);
    out.pairedFootwear = { key: pairedRule.key, version: pairedRule.version, inForce };
    if (!inForce) out.notEnforced.push({ key: pairedRule.key, status: pairedRule.status, interpretation: pairedRule.interpretation });
  }
  return out;
}
