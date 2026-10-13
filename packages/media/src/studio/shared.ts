/** Shared Studio plumbing: resolving slots against the owner's wardrobe, validating through the injected validator, composing. */
import { allIn, CommandError, first, json, sha256Hex, toInstant, type Db, type Principal } from "@garderobe/domain";
import { StudioSlot } from "@garderobe/contracts/ext/media";
import type { CompositionManifest, StudioValidation, StudioViolation } from "@garderobe/contracts/ext/media";
import type { z } from "zod";
import type { OutfitValidator, ValidatorSlot } from "../adapters.ts";
import { buildManifest, manifestHash, type ComposeSlot } from "../compose/manifest.ts";
import type { MediaDeps } from "../runtime.ts";
import { loadImageRefs } from "../store.ts";
import { BASELINE_VALIDATOR_NAME, baselineValidator } from "../validator.ts";

export type StudioSlotInput = z.input<typeof StudioSlot>;

export interface ResolvedSlots {
  /** Normalized slots as stored: lock flags are presentation state and are not persisted. */
  slots: StudioSlot[];
  garmentSlots: ValidatorSlot[];
  hasCandidate: boolean;
  compose: ComposeSlot[];
  names: string[];
}

interface GarmentLite {
  garment_id: string;
  name: string;
  category: string;
  attributes_json: string;
  merged_into: string | null;
  removed_reason: string | null;
}

/** Resolve slots against THIS owner's garments. An ID that is not the owner's (including another owner's) is `not_found`. */
export async function resolveSlots(db: Db, userId: string, input: StudioSlotInput[]): Promise<ResolvedSlots> {
  const slots = input.map((s) => StudioSlot.parse(s));
  for (const s of slots) {
    if ((s.garmentId === null) === (s.shoppingCandidate === null)) throw new CommandError("invalid_command", "each slot holds exactly one garment or one shopping candidate");
  }
  const ids = [...new Set(slots.map((s) => s.garmentId).filter((id): id is string => id !== null))];
  const rows = await allIn<GarmentLite>(db, "SELECT garment_id, name, category, attributes_json, merged_into, removed_reason FROM garments WHERE user_id = ? AND garment_id IN (:ids)", [userId], ids);
  const byId = new Map(rows.filter((r) => r.merged_into === null && r.removed_reason === null).map((r) => [r.garment_id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new CommandError("not_found", `unknown garment${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}; nothing was written`, { missing });
  const images = await loadImageRefs(db, userId, ids);
  const compose: ComposeSlot[] = slots.map((s) => {
    if (s.garmentId === null) return { role: s.role, garmentId: null, shoppingCandidateId: s.shoppingCandidate!.candidateId, name: s.shoppingCandidate!.label, category: "other", image: null };
    const g = byId.get(s.garmentId)!;
    const attributes = json<Record<string, unknown>>(g.attributes_json, {});
    const outerLength = attributes.outerLength === "long" || attributes.outerLength === "short" ? attributes.outerLength : null;
    return { role: s.role, garmentId: g.garment_id, shoppingCandidateId: null, name: g.name, category: g.category, outerLength, image: images.get(g.garment_id) ?? null };
  });
  return {
    slots: slots.map((s) => ({ role: s.role, garmentId: s.garmentId, shoppingCandidate: s.shoppingCandidate, locked: false })),
    garmentSlots: slots.filter((s) => s.garmentId !== null).map((s) => ({ role: s.role, garmentId: s.garmentId! })),
    hasCandidate: slots.some((s) => s.shoppingCandidate !== null),
    compose,
    names: compose.map((c) => c.name),
  };
}

export async function slotSignature(slots: StudioSlot[]): Promise<string> {
  return sha256Hex(slots.map((s) => `${s.role}:${s.garmentId ?? `candidate:${s.shoppingCandidate!.candidateId}`}`).sort().join("|"));
}

export async function composeResolved(resolved: ResolvedSlots): Promise<{ manifest: CompositionManifest; hash: string }> {
  const manifest = buildManifest(resolved.compose);
  return { manifest, hash: await manifestHash(manifest) };
}

/** The validator Studio may use: the injected one, or the baseline only when it was explicitly accepted. Otherwise Studio fails closed. */
export function studioValidator(deps: MediaDeps): OutfitValidator {
  if (deps.validator) return deps.validator;
  if (deps.allowBaselineValidator === true) return baselineValidator;
  throw new CommandError("precondition_failed", "outfit validation is not configured (the daily service's validator is missing), so this outfit cannot be checked against the owner's rules; nothing was written");
}

/**
 * Validate through the injected validator (the daily service's), adding the one rule that is Studio's
 * own: a shopping candidate is not owned stock, so it can be explored but never worn or planned.
 */
export async function validateResolved(deps: MediaDeps, db: Db, principal: Principal, resolved: ResolvedSlots, mode: "for_today" | "explore", forDate: string, nowMs: number): Promise<StudioValidation> {
  const validator = studioValidator(deps);
  const violations: StudioViolation[] = [];
  if (resolved.garmentSlots.length > 0) {
    const result = await validator.validate(db, principal, { slots: resolved.garmentSlots, forDate, mode, nowMs });
    for (const v of result.violations) violations.push({ code: v.code, message: v.message, garmentIds: v.garmentIds, severity: v.severity, ruleKey: v.ruleKey ?? null });
    if (!result.valid && !violations.some((v) => v.severity === "blocking")) {
      violations.push({ code: "invalid", message: "The validator rejected this combination", garmentIds: [], severity: "blocking", ruleKey: null });
    }
  } else if (mode === "for_today") {
    violations.push({ code: "incomplete_outfit", message: "There is no owned garment in this outfit", garmentIds: [], severity: "blocking", ruleKey: null });
  }
  if (resolved.hasCandidate) {
    violations.push({
      code: "shopping_candidate_not_owned",
      message: "This outfit includes a shopping candidate, which is not owned and cannot be worn or planned",
      garmentIds: [],
      severity: mode === "for_today" ? "blocking" : "advisory",
      ruleKey: null,
    });
  }
  const state = await first<{ wardrobe_revision: number }>(db, "SELECT wardrobe_revision FROM owner_state WHERE user_id = ?", principal.userId);
  return {
    valid: !violations.some((v) => v.severity === "blocking"),
    wearableOn: mode === "for_today" ? forDate : null,
    violations,
    validator: validator.name ?? (deps.validator ? "daily-service" : BASELINE_VALIDATOR_NAME),
    wardrobeRevision: state?.wardrobe_revision ?? 0,
    checkedAt: toInstant(nowMs),
  };
}

export function blockingMessages(validation: StudioValidation): string {
  return validation.violations.filter((v) => v.severity === "blocking").map((v) => v.message).join("; ");
}
