import { all, first, json as parseJson, restrictionCovers, type Db } from "@garderobe/domain";

/** Whether a wear report names a garment that an active restriction currently excludes. */
export async function wearsRestrictedGarment(db: Db, userId: string, payload: unknown): Promise<boolean> {
  const p = (payload ?? {}) as { garmentIds?: unknown; additionalUnits?: unknown };
  const named = Array.isArray(p.garmentIds) ? p.garmentIds : [];
  const units = Array.isArray(p.additionalUnits) ? p.additionalUnits.map((u) => (u as { garmentId?: unknown } | null)?.garmentId) : [];
  const ids = [...new Set([...named, ...units].filter((id): id is string => typeof id === "string"))];
  if (ids.length === 0) return false;
  const scopes = (await all<{ scope_json: string }>(db, "SELECT scope_json FROM restrictions WHERE user_id = ? AND status = 'active'", userId)).map((r) => parseJson<Parameters<typeof restrictionCovers>[0]>(r.scope_json, {} as never));
  if (scopes.length === 0) return false;
  for (const id of ids) {
    let row = await first<{ garment_id: string; category: string; attributes_json: string; merged_into: string | null }>(db, "SELECT garment_id, category, attributes_json, merged_into FROM garments WHERE user_id = ? AND garment_id = ?", userId, id);
    if (row?.merged_into) row = await first(db, "SELECT garment_id, category, attributes_json, merged_into FROM garments WHERE user_id = ? AND garment_id = ?", userId, row.merged_into);
    if (!row) continue; // an unknown garment is refused by the command itself
    const garment = { garmentId: row.garment_id, category: row.category, attributes: parseJson<Record<string, unknown>>(row.attributes_json, {}) };
    if (scopes.some((scope) => restrictionCovers(scope, garment))) return true;
  }
  return false;
}
