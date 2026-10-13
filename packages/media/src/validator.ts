/**
 * Baseline outfit validator, used ONLY when the daily service's validator is not injected. It checks
 * garment identity, slot structure and the foundation's eligibility and availability; it knows nothing
 * of weather or the owner's profile rules, and says so in its evidence. Deployments and integration
 * tests inject `outfitValidator` from `@garderobe/daily`.
 */
import { allIn, getAvailability, json, type Db, type Principal } from "@garderobe/domain";
import type { Role } from "@garderobe/contracts";
import type { OutfitValidator, ValidatorResult, ValidatorSlot, ValidatorViolation } from "./adapters.ts";

export const BASELINE_VALIDATOR_NAME = "media-baseline";
const SINGLE_ROLES: Role[] = ["top", "mid_layer", "bottom", "outer", "footwear", "socks", "belt", "one_piece"];

interface GarmentLite {
  garment_id: string;
  name: string;
  roles_json: string;
  acquisition: string;
  merged_into: string | null;
  removed_reason: string | null;
}

async function validate(db: Db, principal: Principal, input: { slots: ValidatorSlot[]; forDate: string; mode: "for_today" | "explore"; nowMs?: number }): Promise<ValidatorResult> {
  const violations: ValidatorViolation[] = [];
  const strict = input.mode === "for_today";
  const add = (code: string, message: string, garmentIds: string[], severity: "blocking" | "advisory") => violations.push({ code, message, garmentIds, severity, ruleKey: null });
  const ids = [...new Set(input.slots.map((s) => s.garmentId))];
  const rows = await allIn<GarmentLite>(db, "SELECT garment_id, name, roles_json, acquisition, merged_into, removed_reason FROM garments WHERE user_id = ? AND garment_id IN (:ids)", [principal.userId], ids);
  const byId = new Map(rows.map((r) => [r.garment_id, r]));
  const snapshot = await getAvailability(db, principal, { forDate: input.forDate, nowMs: input.nowMs });
  const availability = new Map(snapshot.garments.map((g) => [g.garmentId, g]));

  const seen = new Set<string>();
  for (const slot of input.slots) {
    const g = byId.get(slot.garmentId);
    if (!g || g.merged_into !== null || g.removed_reason !== null) {
      add("unknown_garment", "That garment is not in this wardrobe", [slot.garmentId], "blocking");
      continue;
    }
    if (seen.has(slot.garmentId)) add("duplicate_garment", `${g.name} appears twice`, [slot.garmentId], "blocking");
    seen.add(slot.garmentId);
    if (!json<string[]>(g.roles_json, []).includes(slot.role)) add("role_mismatch", `${g.name} cannot be worn as ${slot.role.replace("_", " ")}`, [slot.garmentId], "blocking");
    if (g.acquisition === "disposed") add("unavailable", `${g.name} is no longer in the collection`, [slot.garmentId], "blocking");
    else if (g.acquisition === "incoming") add("not_owned_yet", `${g.name} has not arrived yet`, [slot.garmentId], strict ? "blocking" : "advisory");
    else {
      const a = availability.get(slot.garmentId);
      if (!a || a.hardExcluded || a.status === "unavailable") {
        add(strict ? "unavailable" : "not_wearable_today", `${g.name} is not available to wear on ${input.forDate}${a && a.reasons.length > 0 ? ` (${a.reasons.join(", ").replace(/_/g, " ")})` : ""}`, [slot.garmentId], strict ? "blocking" : "advisory");
      } else if (a.status === "conditional") {
        add("conditional", `${g.name} is kept for particular occasions (${a.reasons.join(", ").replace(/_/g, " ")})`, [slot.garmentId], "advisory");
      }
    }
  }
  const roleCount = (role: Role) => input.slots.filter((s) => s.role === role).length;
  for (const role of SINGLE_ROLES) {
    if (roleCount(role) > 1) add("duplicate_role", `Only one ${role.replace("_", " ")} fits in an outfit`, input.slots.filter((s) => s.role === role).map((s) => s.garmentId), "blocking");
  }
  if (roleCount("one_piece") > 0 && (roleCount("top") > 0 || roleCount("bottom") > 0)) {
    add("one_piece_conflict", "A one-piece replaces the top and bottom", input.slots.filter((s) => ["one_piece", "top", "bottom"].includes(s.role)).map((s) => s.garmentId), "blocking");
  }
  const hasBase = roleCount("one_piece") > 0 || ((roleCount("top") > 0 || roleCount("mid_layer") > 0) && roleCount("bottom") > 0);
  if (!hasBase) add("incomplete_outfit", "An outfit needs a top and a bottom, or a one-piece", [], strict ? "blocking" : "advisory");
  if (roleCount("footwear") === 0) add("footwear_required", "An outfit to wear needs footwear", [], strict ? "blocking" : "advisory");
  return {
    valid: !violations.some((v) => v.severity === "blocking"),
    violations,
    evidence: {
      validator: BASELINE_VALIDATOR_NAME,
      availabilityModel: snapshot.modelVersion,
      wardrobeRevision: snapshot.wardrobeRevision,
      limitation: "baseline only: garment identity, slot structure, eligibility and availability; weather and the owner's profile rules are checked by the daily service validator",
    },
  };
}

async function suggest(
  db: Db,
  principal: Principal,
  input: { locked: ValidatorSlot[]; openRoles: Role[]; forDate: string; mode: "for_today" | "explore"; limit?: number; nowMs?: number },
): Promise<{ slots: ValidatorSlot[]; reason: string; validation?: ValidatorResult }[]> {
  const snapshot = await getAvailability(db, principal, { forDate: input.forDate, nowMs: input.nowMs });
  const offerable = snapshot.garments.filter((g) => !g.hardExcluded && (g.status === "available" || g.status === "estimated") && g.acquisition === "owned");
  const rows = await allIn<GarmentLite>(db, "SELECT garment_id, name, roles_json, acquisition, merged_into, removed_reason FROM garments WHERE user_id = ? AND garment_id IN (:ids)", [principal.userId], offerable.map((g) => g.garmentId));
  const p = new Map(offerable.map((g) => [g.garmentId, g.pAvailable]));
  const lockedIds = new Set(input.locked.map((s) => s.garmentId));
  const pool = (role: Role) =>
    rows
      .filter((r) => r.merged_into === null && r.removed_reason === null && !lockedIds.has(r.garment_id) && json<string[]>(r.roles_json, []).includes(role))
      .sort((a, b) => (p.get(b.garment_id) ?? 0) - (p.get(a.garment_id) ?? 0) || a.name.localeCompare(b.name) || a.garment_id.localeCompare(b.garment_id));
  const roles = input.openRoles.filter((r) => !input.locked.some((l) => l.role === r));
  const pools = roles.map((role) => ({ role, items: pool(role) })).filter((x) => x.items.length > 0);
  const out: { slots: ValidatorSlot[]; reason: string; validation?: ValidatorResult }[] = [];
  const limit = input.limit ?? 5;
  const seen = new Set<string>();
  for (let i = 0; out.length < limit && i < limit * 4; i++) {
    const used = new Set<string>(lockedIds);
    const slots: ValidatorSlot[] = [...input.locked];
    for (const [index, { role, items }] of pools.entries()) {
      // Rotate each role's pool at a different pace so successive suggestions differ in more than one slot.
      const pick = items.filter((g) => !used.has(g.garment_id))[Math.floor(i / (index + 1)) % Math.max(1, items.length)] ?? items.find((g) => !used.has(g.garment_id));
      if (!pick) continue;
      used.add(pick.garment_id);
      slots.push({ role, garmentId: pick.garment_id });
    }
    const key = slots.map((s) => `${s.role}:${s.garmentId}`).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const validation = await validate(db, principal, { slots, forDate: input.forDate, mode: input.mode, nowMs: input.nowMs });
    if (validation.valid) out.push({ slots, reason: "Available pieces that fill the open slots (baseline suggestion; not a style judgment)", validation });
  }
  return out;
}

export const baselineValidator: OutfitValidator = { name: BASELINE_VALIDATOR_NAME, validate, suggest };
