/** Studio reads: selectors, validation, suggestions, composition, saved combinations and day plans. None of these mutates anything. */
import { all, assertPrincipal, CommandError, first, getOwnerState, json, listInventory, localDateOf, requireScope, toInstant, type Principal } from "@garderobe/domain";
import type { Role } from "@garderobe/contracts";
import type { Composition, CompositionManifest, StudioCombination, StudioDayPlan, StudioMode, StudioSelectorItem, StudioSelectors, StudioShoppingCandidate, StudioSlot, StudioSuggestion, StudioValidation } from "@garderobe/contracts/ext/media";
import { COMPOSITE_COLS, type CompositeRow } from "../commands/composites.ts";
import { manifestLabels } from "../compose/manifest.ts";
import type { CommandReceipt } from "@garderobe/contracts";
import { execAs } from "../exec.ts";
import { assertOwnedKey } from "../keys.ts";
import type { MediaRuntime } from "../runtime.ts";
import { loadImageRefs } from "../store.ts";
import { baselineValidator } from "../validator.ts";
import { composeResolved, resolveSlots, validateResolved, type StudioSlotInput } from "./shared.ts";

const SELECTOR_ROLES: Role[] = ["top", "bottom", "footwear", "outer", "mid_layer", "one_piece", "socks", "belt", "neckwear", "accessory"];
const PRIMARY_ROLES: Role[] = ["top", "bottom", "footwear", "outer"];

function guard(principal: Principal): string {
  assertPrincipal(principal);
  requireScope(principal, "read");
  return principal.userId;
}

async function dateFor(rt: MediaRuntime, principal: Principal, forDate?: string | null): Promise<string> {
  if (forDate) return forDate;
  return localDateOf(rt.clock(), (await getOwnerState(rt.db, principal)).settings.timezone);
}

/**
 * What the Studio selectors hold. For today: only eligible owned pieces. Explore: also seasonal, stored,
 * incoming pieces and supplied shopping candidates, each clearly marked. The phone positions cached
 * assets itself; this read supplies identities, markers and image references only.
 */
export async function getStudioSelectors(
  rt: MediaRuntime,
  principal: Principal,
  input: { mode: StudioMode; forDate?: string | null; shoppingCandidates?: (StudioShoppingCandidate & { role: Role })[] },
): Promise<StudioSelectors> {
  const userId = guard(principal);
  const forDate = await dateFor(rt, principal, input.forDate);
  const nowMs = rt.clock();
  const inventory = await listInventory(rt.db, principal, { forDate }, { nowMs });
  const images = await loadImageRefs(rt.db, userId, inventory.items.map((i) => i.garment.garmentId));
  const selectors = SELECTOR_ROLES.map((role) => {
    const items: StudioSelectorItem[] = [];
    for (const item of inventory.items) {
      const g = item.garment;
      if (!g.roles.includes(role) || g.acquisition === "disposed" || g.mergedInto) continue;
      const a = item.availability;
      const eligibleToday = g.acquisition === "owned" && !!a && !a.hardExcluded && (a.status === "available" || a.status === "estimated");
      if (input.mode === "for_today" && !eligibleToday) continue;
      items.push({
        garmentId: g.garmentId,
        shoppingCandidate: null,
        name: g.name,
        category: g.category,
        marker: g.acquisition === "incoming" ? "incoming" : eligibleToday ? "owned" : "seasonal_or_stored",
        eligibleToday,
        availabilityStatus: a?.status ?? null,
        reasons: a?.reasons ?? [],
        image: images.get(g.garmentId) ?? null,
      });
    }
    if (input.mode === "explore") {
      for (const c of input.shoppingCandidates ?? []) {
        if (c.role !== role) continue;
        items.push({ garmentId: null, shoppingCandidate: { candidateId: c.candidateId, label: c.label, sourceUrl: c.sourceUrl ?? null }, name: c.label, category: "other", marker: "shopping_candidate", eligibleToday: false, availabilityStatus: null, reasons: ["not_owned"], image: null });
      }
    }
    return { role, primary: PRIMARY_ROLES.includes(role), items };
  });

  // A starting outfit for the canvas: the validator's first suggestion, else nothing (never an invented one).
  let opening: StudioSlot[] = [];
  try {
    const suggestions = await suggestStudioOutfits(rt, principal, { slots: [], mode: "for_today", forDate, limit: 1 });
    opening = suggestions[0]?.slots ?? [];
  } catch {
    opening = [];
  }
  return { mode: input.mode, forDate, selectors, opening, wardrobeRevision: inventory.wardrobeRevision, readAt: toInstant(nowMs) };
}

/** The authoritative check of a finished combination. Read only: nothing is saved, planned or worn. */
export async function validateStudioOutfit(rt: MediaRuntime, principal: Principal, input: { slots: StudioSlotInput[]; mode: StudioMode; forDate?: string | null }): Promise<StudioValidation> {
  const userId = guard(principal);
  const resolved = await resolveSlots(rt.db, userId, input.slots);
  return validateResolved(rt.deps, rt.db, principal, resolved, input.mode, await dateFor(rt, principal, input.forDate), rt.clock());
}

/**
 * "Find something that works with this": locked slots are returned exactly as given; only the other
 * slots are filled, by the validator's own suggestion function. A suggestion that moved a locked piece
 * is discarded.
 */
export async function suggestStudioOutfits(
  rt: MediaRuntime,
  principal: Principal,
  input: { slots: StudioSlotInput[]; mode: StudioMode; forDate?: string | null; openRoles?: Role[]; limit?: number },
): Promise<StudioSuggestion[]> {
  const userId = guard(principal);
  const forDate = await dateFor(rt, principal, input.forDate);
  const resolved = await resolveSlots(rt.db, userId, input.slots);
  const given = input.slots.map((s, i) => ({ ...resolved.slots[i]!, locked: s.locked === true }));
  const locked = given.filter((s) => s.locked && s.garmentId !== null);
  const lockedRoles = new Set(locked.map((s) => s.role));
  const openRoles = (input.openRoles ?? [...new Set<Role>([...given.filter((s) => !s.locked).map((s) => s.role), "top", "bottom", "footwear"])]).filter((r) => !lockedRoles.has(r));
  const validator = rt.deps.validator?.suggest ? rt.deps.validator : baselineValidator;
  const raw = await validator.suggest!(rt.db, principal, { locked: locked.map((s) => ({ role: s.role, garmentId: s.garmentId! })), openRoles, forDate, mode: input.mode, limit: input.limit ?? 5 });
  const out: StudioSuggestion[] = [];
  for (const suggestion of raw) {
    const keepsLocks = locked.every((l) => suggestion.slots.some((s) => s.role === l.role && s.garmentId === l.garmentId)) && !suggestion.slots.some((s) => lockedRoles.has(s.role) && !locked.some((l) => l.role === s.role && l.garmentId === s.garmentId));
    if (!keepsLocks) continue;
    const slots: StudioSlot[] = suggestion.slots.map((s) => ({ role: s.role, garmentId: s.garmentId, shoppingCandidate: null, locked: locked.some((l) => l.role === s.role && l.garmentId === s.garmentId) }));
    let suggested;
    try {
      suggested = await resolveSlots(rt.db, userId, slots);
    } catch {
      continue; // a suggestion naming a garment that is not this owner's is dropped, never shown
    }
    const validation = await validateResolved(rt.deps, rt.db, principal, suggested, input.mode, forDate, rt.clock());
    if (validation.valid) out.push({ slots, reason: suggestion.reason, validation });
  }
  return out;
}

function toComposition(manifest: CompositionManifest, hash: string, row: CompositeRow | null): Composition {
  return {
    manifestHash: hash,
    manifest,
    preview: { state: row?.preview_state ?? "none", sha256: row?.preview_sha256 ?? null, renderedAt: row?.rendered_at ?? null, failure: row?.failure ?? null },
    missingImages: manifest.layers.filter((l) => l.imageLabel === "missing" && l.garmentId).map((l) => l.garmentId!),
    labels: manifestLabels(manifest),
  };
}

/** The deterministic composition manifest for a set of slots, with the state of its cached preview. Read only. */
export async function composeOutfit(rt: MediaRuntime, principal: Principal, input: { slots: StudioSlotInput[] }): Promise<Composition> {
  const userId = guard(principal);
  const { manifest, hash } = await composeResolved(await resolveSlots(rt.db, userId, input.slots));
  const row = await first<CompositeRow>(rt.db, `SELECT ${COMPOSITE_COLS} FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?`, userId, hash);
  return toComposition(manifest, hash, row);
}

export async function getComposition(rt: MediaRuntime, principal: Principal, manifestHash: string): Promise<Composition> {
  const userId = guard(principal);
  const row = await first<CompositeRow>(rt.db, `SELECT ${COMPOSITE_COLS} FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?`, userId, manifestHash);
  if (!row) throw new CommandError("not_found", "no such outfit preview for this owner");
  return toComposition(json<CompositionManifest>(row.manifest_json, null as never), row.manifest_hash, row);
}

/** Queue the raster preview (background work). Wraps `media.request_composite_preview`. */
export async function requestCompositePreview(rt: MediaRuntime, principal: Principal, input: { slots: StudioSlotInput[]; idempotencyKey?: string }): Promise<{ receipt: CommandReceipt; manifestHash: string }> {
  const { hash } = await composeResolved(await resolveSlots(rt.db, principal.userId, input.slots));
  const receipt = await execAs(rt, principal, "media.request_composite_preview", { slots: input.slots }, input.idempotencyKey ?? `preview:${hash}`);
  return { receipt, manifestHash: String(receipt.result.manifestHash ?? hash) };
}

/** Authenticated read of a rendered preview (PNG) or its SVG scene. */
export async function openCompositePreview(rt: MediaRuntime, principal: Principal, manifestHash: string, format: "png" | "svg" = "png"): Promise<{ body: ReadableStream<Uint8Array>; contentType: string; etag: string }> {
  const userId = guard(principal);
  const row = await first<CompositeRow>(rt.db, `SELECT ${COMPOSITE_COLS} FROM outfit_composites WHERE user_id = ? AND manifest_hash = ?`, userId, manifestHash);
  const key = format === "png" ? row?.preview_key : row?.svg_key;
  if (!row || row.preview_state !== "rendered" || !key) throw new CommandError("not_found", "no rendered preview for this outfit");
  assertOwnedKey(userId, key);
  const object = await rt.deps.bucket.get(key);
  if (!object) throw new CommandError("not_found", "no rendered preview for this outfit");
  return { body: object.body, contentType: format === "png" ? "image/png" : "image/svg+xml", etag: `"${(row.preview_sha256 ?? manifestHash).slice(0, 32)}${format === "svg" ? "-svg" : ""}"` };
}

interface CombinationRow {
  combination_id: string;
  name: string | null;
  favourite: number;
  slots_json: string;
  has_candidate: number;
  status: "active" | "removed";
  validation_json: string;
  manifest_hash: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function toCombination(r: CombinationRow): StudioCombination {
  return {
    combinationId: r.combination_id, name: r.name, favourite: r.favourite === 1, slots: json<StudioSlot[]>(r.slots_json, []), containsShoppingCandidate: r.has_candidate === 1, status: r.status,
    validation: json<StudioValidation>(r.validation_json, null as never), manifestHash: r.manifest_hash, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const COMBINATION_READ = "combination_id, name, favourite, slots_json, has_candidate, status, validation_json, manifest_hash, version, created_at, updated_at";

export async function listStudioCombinations(rt: MediaRuntime, principal: Principal, opts: { includeRemoved?: boolean } = {}): Promise<StudioCombination[]> {
  const userId = guard(principal);
  const rows = await all<CombinationRow>(rt.db, `SELECT ${COMBINATION_READ} FROM studio_combinations WHERE user_id = ? ${opts.includeRemoved ? "" : "AND status = 'active'"} ORDER BY favourite DESC, updated_at DESC, combination_id`, userId);
  return rows.map(toCombination);
}

/** Saved combinations that include a garment (the item page's "known combinations"). */
export async function knownCombinationsForGarment(rt: MediaRuntime, principal: Principal, garmentId: string): Promise<StudioCombination[]> {
  const userId = guard(principal);
  const rows = await all<CombinationRow>(
    rt.db,
    `SELECT ${COMBINATION_READ} FROM studio_combinations WHERE user_id = ? AND status = 'active' AND combination_id IN (SELECT combination_id FROM studio_combination_items WHERE user_id = ? AND garment_id = ?) ORDER BY updated_at DESC, combination_id`,
    userId, userId, garmentId,
  );
  return rows.map(toCombination);
}

interface PlanRow {
  plan_id: string;
  local_date: string;
  combination_id: string | null;
  slots_json: string;
  status: "planned" | "removed";
  needs_revalidation: number;
  revalidation_reason: string | null;
  validation_json: string;
  exposure_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * Day plans. A plan flagged for re-validation (a planned garment's availability changed) is validated
 * again against CURRENT records for this read; the stored plan is not rewritten here.
 */
export async function listStudioDayPlans(rt: MediaRuntime, principal: Principal, opts: { from?: string; to?: string; includeRemoved?: boolean } = {}): Promise<StudioDayPlan[]> {
  const userId = guard(principal);
  const from = opts.from ?? (await dateFor(rt, principal, null));
  const rows = await all<PlanRow>(
    rt.db,
    `SELECT plan_id, local_date, combination_id, slots_json, status, needs_revalidation, revalidation_reason, validation_json, exposure_id, version, created_at, updated_at FROM studio_day_plans
      WHERE user_id = ? AND local_date >= ? AND local_date <= ? ${opts.includeRemoved ? "" : "AND status = 'planned'"} ORDER BY local_date, created_at, plan_id`,
    userId, from, opts.to ?? "9999-12-31",
  );
  const out: StudioDayPlan[] = [];
  for (const r of rows) {
    const slots = json<StudioSlot[]>(r.slots_json, []);
    let validation = json<StudioValidation>(r.validation_json, null as never);
    if (r.needs_revalidation === 1 && r.status === "planned") {
      try {
        validation = await validateResolved(rt.deps, rt.db, principal, await resolveSlots(rt.db, userId, slots), "for_today", r.local_date, rt.clock());
      } catch (e) {
        validation = { ...validation, valid: false, violations: [{ code: "unknown_garment", message: String((e as Error).message), garmentIds: [], severity: "blocking", ruleKey: null }], checkedAt: toInstant(rt.clock()) };
      }
    }
    out.push({
      planId: r.plan_id, localDate: r.local_date, combinationId: r.combination_id, slots, status: r.status, needsRevalidation: r.needs_revalidation === 1, revalidationReason: r.revalidation_reason,
      validation, exposureId: r.exposure_id, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
    });
  }
  return out;
}
