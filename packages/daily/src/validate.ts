/**
 * Outfit validation in code (specification section 7, composition step 3). Pure: given the assembled
 * context it decides whether a candidate is a complete, wearable, rule-abiding outfit. No model output
 * becomes an option without passing here, and a model cannot supply names in place of garment IDs.
 */
import type { Role } from "@garderobe/contracts";
import type { OutfitSlot, OutfitValidation, OutfitViolation } from "@garderobe/contracts/ext/daily";
import { addDays, jointAvailability } from "@garderobe/domain";
import { NEUTRAL_FAMILIES, type PoolGarment, type RecommendationContext } from "./model.ts";
import { AVAILABILITY_MODEL_VERSION_OR_DEFAULT } from "./version.ts";

export interface ValidateOptions {
  /** Explicit scoped exception to the repeat rule. */
  allowRepeat?: boolean;
  /** Garments the owner explicitly asked for (lets occasional / indoor-only pieces through). */
  explicitGarmentIds?: string[];
  /** Boards must carry the sneaker + welted pair once that format is in force. */
  requirePairedFootwear?: boolean;
  /** Skip the brief's include list (used when checking a single replacement). */
  ignoreBriefInclusions?: boolean;
}

const REQUIRED_ROLES: Role[] = ["top", "bottom", "footwear", "socks"];
const SINGLE_ROLES: Role[] = ["top", "mid_layer", "bottom", "outer", "footwear", "socks", "belt", "neckwear", "one_piece"];

/** Codes that describe "not wearable today" rather than "not an outfit"; advisory in Explore mode. */
export const EXPLORE_ADVISORY = new Set([
  "unavailable", "restricted", "not_packed", "conditional_not_requested", "thermal_too_warm", "thermal_too_cold", "fabric_rule",
  "jacket_band_requires_lightweight_oxford", "too_warm_together", "outerwear_ceiling", "repeat_within_horizon", "footwear_restricted", "paired_footwear_required",
]);

const REASON_WORDS: Record<string, string> = {
  not_owned_yet: "ordered but not arrived",
  disposed: "no longer owned",
  merged: "merged into another record",
  no_units_at_home: "no clean unit at home",
  restricted: "under an active restriction",
  in_storage: "in storage",
  at_tailor: "at the tailor",
  on_trip: "packed for a trip",
  planning_excluded: "excluded from planning",
  observed_dirty: "awaiting care",
  in_service_batch: "away at the laundry",
  laundry_exception: "held by a reported laundry exception",
};

function v(code: string, message: string, garmentIds: string[], ruleKey: string | null = null, severity: "blocking" | "advisory" = "blocking"): OutfitViolation {
  return { code, message, garmentIds, severity, ruleKey };
}

export function roleAccepts(g: PoolGarment, role: Role): boolean {
  if (role === "mid_layer") return g.roles.includes("mid_layer") || ((g.category === "shirt" || g.category === "knitwear") && g.attributes.layeringOnly === true);
  return g.roles.includes(role);
}

/** Temperature a garment in a role is assessed against, and the basis used. */
function thermalBasis(ctx: RecommendationContext, g: PoolGarment, role: Role): "daytime_peak" | "outdoor_interval" | null {
  const basis = g.thermal?.basis;
  if (basis === "daytime_peak" || basis === "outdoor_interval") return basis;
  // A garment bound whose basis the source did not settle takes the basis of the owner's ACTIVE rule
  // for that role (profile section 8.4); with no such rule it stays unsettled and is not enforced.
  if (role === "outer") return ctx.rules.outerFollowsDeparture ? "outdoor_interval" : null;
  if (ctx.rules.peakRule && (ctx.rules.peakRoles.includes(role) || role === "mid_layer")) return "daytime_peak";
  return null;
}

/**
 * Checks on one garment in one role: identity, role, availability, restrictions, planning policy,
 * thermal bounds, fabric rules, the repeat horizon, brief exclusions. Combination rules are separate.
 */
export function garmentViolations(ctx: RecommendationContext, garmentId: string, role: Role, opts: ValidateOptions = {}): OutfitViolation[] {
  const g = ctx.garments.get(garmentId);
  if (!g) return [v("unknown_garment", "That garment is not in this wardrobe", [garmentId])];
  const out: OutfitViolation[] = [];
  const explicit = new Set([...(opts.explicitGarmentIds ?? []), ...ctx.brief.include]);
  if (!roleAccepts(g, role)) out.push(v("role_mismatch", `${g.name} cannot be worn as ${role.replace("_", " ")}`, [garmentId]));
  if (role === "top" && g.attributes.layeringOnly === true) out.push(v("layering_only", `${g.name} is kept as a layering piece, not a base shirt`, [garmentId]));

  const a = g.availability;
  if (a.hardExcluded) {
    const words = a.reasons.map((r) => REASON_WORDS[r]).filter(Boolean);
    if (a.reasons.includes("restricted")) out.push(v("restricted", `${g.name} is under an active restriction`, [garmentId]));
    else if (ctx.tripId && g.packedClean === 0) out.push(v("not_packed", `${g.name} has no clean packed unit on this trip`, [garmentId]));
    else out.push(v("unavailable", `${g.name} is not available: ${words.join(", ") || "unavailable"}`, [garmentId]));
  } else if (a.status === "conditional" && !explicit.has(garmentId)) {
    const why = g.attributes.indoorOnly === true ? "indoor-only" : "kept for occasional use";
    out.push(v("conditional_not_requested", `${g.name} is ${why} and is offered only on request`, [garmentId], g.attributes.indoorOnly === true ? (ctx.rules.indoorOnly?.key ?? null) : null));
  }

  const so = ctx.rules.sneakersOnly;
  if (role === "footwear" && so?.inForce) {
    const kind = String(g.attributes.footwearKind ?? "");
    const model = String(g.attributes.model ?? "").toLowerCase();
    if (!so.allowedKinds.includes(kind) || (model !== "" && so.excludedModels.includes(model))) {
      out.push(v("footwear_restricted", `${g.name} is excluded while the sneakers-only restriction is active`, [garmentId], so.key));
    }
  }

  const ex = ctx.rules.excludedAccessories;
  if (ex && /\b(watch|watches|jewel\w*|bracelet|necklace|cufflinks?)\b/i.test(g.name)) out.push(v("accessory_excluded", `${g.name} is not suggested: watches and jewellery are absent by choice`, [garmentId], ex.key));

  if (ctx.brief.exclude.includes(garmentId)) out.push(v("excluded_by_brief", `${g.name} was excluded for this day`, [garmentId]));

  // Thermal: garment bounds and active fabric-class rules, each against its own interval.
  const { peakC, departureC } = ctx.conditions;
  const tempFor = (basis: "daytime_peak" | "outdoor_interval") => (basis === "daytime_peak" ? peakC : departureC);
  const label = (basis: "daytime_peak" | "outdoor_interval") => (basis === "daytime_peak" ? `peak ${peakC} °C` : `${departureC} °C when outdoors`);
  if (g.thermal && (g.thermal.minC !== undefined || g.thermal.maxC !== undefined)) {
    const basis = thermalBasis(ctx, g, role);
    if (basis === null) {
      out.push(v("thermal_basis_unsettled", `${g.name} has a temperature note whose basis (morning or peak) is not settled; it is not enforced`, [garmentId], null, "advisory"));
    } else {
      const t = tempFor(basis);
      const ruleKey = basis === "daytime_peak" ? (ctx.rules.peakRule?.key ?? null) : (ctx.rules.outerFollowsDeparture?.key ?? null);
      if (t === null) out.push(v("thermal_unverified", `${g.name} has a temperature range that could not be checked: the forecast is unavailable`, [garmentId], ruleKey, "advisory"));
      else if (g.thermal.maxC !== undefined && t > g.thermal.maxC) out.push(v("thermal_too_warm", `${g.name} is kept to ${g.thermal.maxC} °C and below (${label(basis)})`, [garmentId], ruleKey));
      else if (g.thermal.minC !== undefined && t < g.thermal.minC) out.push(v("thermal_too_cold", `${g.name} is kept for ${g.thermal.minC} °C and above (${label(basis)})`, [garmentId], ruleKey));
    }
  }
  const fabricClass = g.attributes.fabricClass;
  for (const rule of ctx.rules.fabricBounds) {
    if (rule.fabricClass !== fabricClass) continue;
    const t = tempFor(rule.basis);
    if (t === null) out.push(v("thermal_unverified", `${g.name} could not be checked against its ${rule.fabricClass.replace("_", " ")} temperature rule: the forecast is unavailable`, [garmentId], rule.key, "advisory"));
    else if (rule.minC !== null && t < rule.minC) out.push(v("fabric_rule", `${g.name} (${rule.fabricClass.replace("_", " ")}) is for ${rule.minC} °C and above (${label(rule.basis)})`, [garmentId], rule.key));
    else if (rule.maxC !== null && t > rule.maxC) out.push(v("fabric_rule", `${g.name} (${rule.fabricClass.replace("_", " ")}) is for ${rule.maxC} °C and below (${label(rule.basis)})`, [garmentId], rule.key));
  }
  const ceiling = ctx.rules.outerwearCeiling;
  if (role === "outer" && ceiling) {
    const t = tempFor(ceiling.basis);
    if (t !== null && t > ceiling.maxC) out.push(v("outerwear_ceiling", `No outerwear above ${ceiling.maxC} °C (${label(ceiling.basis)})`, [garmentId], ceiling.key));
  }

  // Repeat horizon: recorded wear only. A trip's deliberate reuse is an explicit exception for that trip.
  const repeat = ctx.rules.repeat;
  if (repeat.categories.includes(g.category) && !opts.allowRepeat && !ctx.brief.allowRepeat && !ctx.tripId) {
    const from = addDays(ctx.localDate, -repeat.days);
    const hit = g.wornDates.filter((d) => d >= from && d < ctx.localDate).pop();
    if (hit) out.push(v("repeat_within_horizon", `${g.name} was worn on ${hit}, inside the ${repeat.days}-day repeat horizon`, [garmentId], repeat.key));
  }
  return out;
}

/** Validate a complete candidate. Returns every violation, never just the first. */
export function validateCandidate(ctx: RecommendationContext, candidate: { slots: OutfitSlot[]; footwearAlternatives?: string[] }, opts: ValidateOptions = {}): OutfitValidation {
  const violations: OutfitViolation[] = [];
  const slots = candidate.slots;
  const alternatives = candidate.footwearAlternatives ?? [];
  const byRole = new Map<Role, string[]>();
  for (const s of slots) byRole.set(s.role, [...(byRole.get(s.role) ?? []), s.garmentId]);

  const seen = new Set<string>();
  for (const id of [...slots.map((s) => s.garmentId), ...alternatives]) {
    if (seen.has(id)) violations.push(v("duplicate_garment", "The same garment appears twice in one outfit", [id]));
    seen.add(id);
  }
  for (const role of SINGLE_ROLES) {
    const ids = byRole.get(role) ?? [];
    if (ids.length > 1) violations.push(v("duplicate_role", `An outfit has one ${role.replace("_", " ")}; alternatives go in the footwear alternatives`, ids));
  }
  const onePiece = (byRole.get("one_piece") ?? []).length > 0;
  for (const role of REQUIRED_ROLES) {
    if ((byRole.get(role) ?? []).length > 0) continue;
    if (onePiece && (role === "top" || role === "bottom")) continue;
    if (role === "socks") violations.push(v("socks_required", "Every outfit includes socks; there is no sockless option", [], ctx.rules.socksRequired?.key ?? null));
    else violations.push(v(`missing_${role}`, `The outfit has no ${role}`, []));
  }

  for (const s of slots) violations.push(...garmentViolations(ctx, s.garmentId, s.role, opts));
  for (const id of alternatives) violations.push(...garmentViolations(ctx, id, "footwear", opts));

  const get = (role: Role) => {
    const id = byRole.get(role)?.[0];
    return id ? ctx.garments.get(id) : undefined;
  };
  const top = get("top");
  const outer = get("outer");
  const bottom = get("bottom");
  const footwear = get("footwear");

  // 14-16 C: a jacket goes over a lightweight oxford only. Evaluated on the jacket-wearing (outdoor)
  // interval, inclusive at both ends, never on the daily maximum.
  const band = ctx.rules.jacketBand;
  if (band && outer && top && (outer.attributes.jacketLike === true || outer.category === "outerwear")) {
    const t = ctx.conditions.departureC;
    const isRequired = top.attributes.fabricClass === band.requiredShirtFabricClass;
    if (t === null) {
      if (!isRequired) violations.push(v("jacket_band_unverified", `The ${band.minC}-${band.maxC} °C jacket rule could not be checked: the forecast is unavailable`, [outer.garmentId, top.garmentId], band.key, "advisory"));
    } else if (t >= band.minC && t <= band.maxC && !isRequired) {
      violations.push(v("jacket_band_requires_lightweight_oxford", `At ${t} °C outdoors a jacket goes over a lightweight oxford only; ${top.name} is not one`, [outer.garmentId, top.garmentId], band.key));
    }
  }

  // Owner-activated layer-combination rules: individually eligible pieces that are too warm together.
  for (const rule of ctx.rules.combinations) {
    const matched: PoolGarment[] = [];
    let all = true;
    for (const [role, match] of Object.entries(rule.pieces) as [Role, NonNullable<(typeof rule.pieces)["outer"]>][]) {
      const g = get(role);
      const ok = !!g && (!match.fabricClasses || match.fabricClasses.includes(String(g.attributes.fabricClass ?? ""))) && (!match.categories || match.categories.includes(g.category)) && (match.jacketLike === undefined || (g.attributes.jacketLike === true) === match.jacketLike);
      if (!ok) {
        all = false;
        break;
      }
      matched.push(g!);
    }
    if (!all) continue;
    const t = rule.basis === "daytime_peak" ? ctx.conditions.peakC : ctx.conditions.departureC;
    const ids = matched.map((g) => g.garmentId);
    if (t === null) violations.push(v("combination_unverified", `A layering rule for ${matched.map((g) => g.name).join(" with ")} could not be checked: the forecast is unavailable`, ids, rule.key, "advisory"));
    else if ((rule.minC === null || t >= rule.minC) && (rule.maxC === null || t <= rule.maxC)) {
      violations.push(v("too_warm_together", `${matched.map((g) => g.name).join(" with ")} are too warm together at ${t} °C ${rule.basis === "daytime_peak" ? "at the peak" : "outdoors"}`, ids, rule.key));
    }
  }

  // Sneaker + welted pair once the fleet returns; the restriction outranks the format while active.
  const paired = ctx.rules.pairedFootwear;
  if (paired?.inForce && footwear) {
    const kinds = new Set([footwear, ...alternatives.map((id) => ctx.garments.get(id)).filter((g): g is PoolGarment => !!g)].map((g) => String(g.attributes.footwearKind ?? "")));
    const eligible = (kind: string) => [...ctx.garments.values()].some((g) => g.roles.includes("footwear") && g.attributes.footwearKind === kind && garmentViolations(ctx, g.garmentId, "footwear", opts).every((x) => x.severity !== "blocking"));
    const missing = ["sneaker", "welted"].filter((k) => !kinds.has(k) && eligible(k));
    const bothWearable = eligible("sneaker") && eligible("welted");
    if (bothWearable && missing.length > 0) {
      violations.push(v("paired_footwear_required", `Every outfit names a sneaker and a welted alternative; this one lacks a ${missing.join(" and a ")} option`, [footwear.garmentId], paired.key, opts.requirePairedFootwear ? "blocking" : "advisory"));
    }
  }

  if (!opts.ignoreBriefInclusions) {
    for (const id of ctx.brief.include) {
      if (!seen.has(id)) violations.push(v("missing_requested_inclusion", `The outfit does not include a piece that was asked for (${ctx.garments.get(id)?.name ?? "unknown garment"})`, [id]));
    }
  }

  // Soft verdicts recorded as advisories: they inform ranking and never block.
  const neutral = ctx.rules.neutralMax;
  if (neutral) {
    const counts = new Map<string, string[]>();
    for (const g of [outer, top, bottom, footwear]) {
      if (g && NEUTRAL_FAMILIES.has(g.colourFamily)) counts.set(g.colourFamily, [...(counts.get(g.colourFamily) ?? []), g.garmentId]);
    }
    for (const [family, ids] of counts) {
      if (ids.length > neutral.max) violations.push(v("neutral_three_times", `The same neutral (${family.replace("_", " ")}) appears ${ids.length} times`, ids, neutral.key, "advisory"));
    }
  }
  if (!onePiece && (byRole.get("belt") ?? []).length === 0) violations.push(v("missing_belt", "No belt is named", [], null, "advisory"));

  const final = ctx.mode === "explore" ? violations.map((x) => (x.severity === "blocking" && EXPLORE_ADVISORY.has(x.code) ? { ...x, severity: "advisory" as const } : x)) : violations;
  const notWearable = violations.some((x) => x.severity === "blocking");
  const ids = [...seen].filter((id) => ctx.garments.has(id));
  const joint = ids.length > 0 ? jointAvailability(ctx.estimator, slots.map((s) => s.garmentId).filter((id) => ctx.garments.has(id))) : { pAllAvailable: 0, hardExcluded: [] };

  return {
    valid: final.every((x) => x.severity !== "blocking"),
    violations: final,
    evidence: {
      forDate: ctx.localDate,
      scope: ctx.scope,
      mode: ctx.mode,
      wearableToday: !notWearable,
      conditions: ctx.conditions,
      weatherBasis: {
        baseLayers: ctx.conditions.peakInterval ? `peak over ${ctx.conditions.peakInterval}` : "unavailable",
        outerwear: ctx.conditions.departureInterval ? `outdoor interval ${ctx.conditions.departureInterval}` : "unavailable",
        note: "Apparent temperature is recorded in the snapshot but never replaces the rule's temperature basis.",
      },
      rules: ctx.rules.versions,
      rulesNotEnforced: ctx.rules.notEnforced.map((r) => ({ key: r.key, status: r.status })),
      availability: {
        modelVersion: AVAILABILITY_MODEL_VERSION_OR_DEFAULT,
        parameters: { ...ctx.settings.estimator, parameterStatus: "hypothesis" },
        jointAvailability: joint.pAllAvailable,
        garments: ids.map((id) => {
          const a = ctx.garments.get(id)!.availability;
          return { garmentId: id, status: a.status, pAvailable: a.pAvailable, reasons: a.reasons, cleanObserved: a.cleanObserved, inferredWear: a.inferredWear };
        }),
      },
      revisions: ctx.revisions,
      sources: ctx.sources,
    },
  };
}

export function blocking(validation: OutfitValidation): OutfitViolation[] {
  return validation.violations.filter((x) => x.severity === "blocking");
}
