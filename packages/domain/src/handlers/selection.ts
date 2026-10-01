/**
 * Which garments a category or query selects (research requirement R12, bulk edits). One function
 * serves the read that shows the owner the set and the command that changes it, so the two can never
 * disagree about what a selector means.
 */
import { GarmentSelector, type GarmentSelection } from "@garderobe/contracts";
import { all, first, type Db } from "../db.ts";
import { CommandError } from "../errors.ts";
import { assertPrincipal, requireScope, type Principal } from "../principal.ts";
import { normalizePhrase } from "../util.ts";

/** Full `garments` rows the selector matches, in a stable order. Merged, removed and disposed garments never match. */
export async function selectGarments(db: Db, userId: string, selectorInput: GarmentSelector): Promise<Record<string, any>[]> {
  const parsed = GarmentSelector.safeParse(selectorInput);
  if (!parsed.success) throw new CommandError("invalid_command", "that selection is not valid", { issues: parsed.error.issues });
  const s = parsed.data;
  const rows = await all<Record<string, any>>(
    db,
    "SELECT * FROM garments WHERE user_id = ? AND merged_into IS NULL AND removed_reason IS NULL AND acquisition != 'disposed' ORDER BY category, name, garment_id",
    userId,
  );
  if (s.garmentIds) {
    const known = new Set(rows.map((r) => r.garment_id as string));
    const missing = [...new Set(s.garmentIds)].filter((id) => !known.has(id));
    if (missing.length > 0) throw new CommandError("not_found", `unknown garment${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}; nothing was written`, { missing });
  }
  const aliases = new Map<string, string[]>();
  if (s.search) {
    for (const a of await all<{ garment_id: string; normalized: string }>(db, "SELECT garment_id, normalized FROM garment_aliases WHERE user_id = ? AND removed_at IS NULL", userId)) {
      aliases.set(a.garment_id, [...(aliases.get(a.garment_id) ?? []), a.normalized]);
    }
  }
  const ids = s.garmentIds ? new Set(s.garmentIds) : null;
  const contains = (value: unknown, wanted: string) => normalizePhrase(String(value ?? "")).includes(normalizePhrase(wanted));
  const words = s.search ? normalizePhrase(s.search).split(" ").filter(Boolean) : [];
  return rows.filter((r) => {
    if (ids && !ids.has(r.garment_id)) return false;
    if (s.category && r.category !== s.category) return false;
    if (s.careChannel && r.care_channel !== s.careChannel) return false;
    if (s.planningPolicy && r.planning_policy !== s.planningPolicy) return false;
    if (s.acquisition && r.acquisition !== s.acquisition) return false;
    if (s.maker && !contains(r.maker, s.maker)) return false;
    if (s.colour && !contains(r.colour, s.colour)) return false;
    if (s.fabric && !contains(r.fabric, s.fabric)) return false;
    if (words.length > 0) {
      const haystack = [r.name, r.maker, r.product, r.colour, r.fabric].map((v) => normalizePhrase(String(v ?? ""))).concat(aliases.get(r.garment_id) ?? []).join(" | ");
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    return true;
  });
}

/** The garments a bulk edit with this selector would touch. Read it, show it, then send `expectedCount`. */
export async function previewGarmentSelection(db: Db, principal: Principal, selector: GarmentSelector): Promise<GarmentSelection> {
  assertPrincipal(principal);
  requireScope(principal, "read");
  const rows = await selectGarments(db, principal.userId, selector);
  const state = await first<{ wardrobe_revision: number }>(db, "SELECT wardrobe_revision FROM owner_state WHERE user_id = ?", principal.userId);
  return {
    garments: rows.map((r) => ({ garmentId: r.garment_id, version: r.version, name: r.name, category: r.category })),
    count: rows.length,
    wardrobeRevision: state?.wardrobe_revision ?? 0,
  };
}
