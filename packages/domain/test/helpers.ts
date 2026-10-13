import { all } from "../src/index.ts";
import type { Harness, TestOwner, ExecOptions } from "../src/testing/index.ts";

/** Materialized quantities of one garment, by bucket (service/trip refs summed). */
export async function balances(h: Harness, owner: TestOwner, garmentId: string): Promise<Record<string, number>> {
  const rows = await all<{ bucket: string; quantity: number }>(h.db, "SELECT bucket, quantity FROM stock_balances WHERE user_id = ? AND garment_id = ?", owner.userId, garmentId);
  const out: Record<string, number> = { incoming: 0, clean: 0, dirty: 0, service: 0, storage: 0, tailor: 0, trip: 0, gone: 0 };
  for (const r of rows) out[r.bucket] = (out[r.bucket] ?? 0) + r.quantity;
  return out;
}

export async function countedWears(h: Harness, owner: TestOwner, garmentId?: string): Promise<{ garment_id: string; wearing_date: string; observation_count: number }[]> {
  return garmentId
    ? all(h.db, "SELECT garment_id, wearing_date, observation_count FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active' ORDER BY wearing_date", owner.userId, garmentId)
    : all(h.db, "SELECT garment_id, wearing_date, observation_count FROM daily_wears WHERE user_id = ? AND status = 'active' ORDER BY wearing_date, garment_id", owner.userId);
}

export const SCHEDULED: ExecOptions = { actor: "system", channel: "scheduled", authorization: "standing_policy" };
export const MCP_ASSISTANT: ExecOptions = { actor: "assistant", channel: "mcp", authorization: "owner_statement" };

/** Record a wear on a given local date, moving the test clock to 09:00 UTC of that day first. */
export async function wearOn(h: Harness, owner: TestOwner, date: string, garmentIds: string[], opts: ExecOptions = {}) {
  h.clock.set(`${date}T09:00:00Z`);
  return owner.exec("wear.record", { wearingDate: date, garmentIds }, opts);
}
