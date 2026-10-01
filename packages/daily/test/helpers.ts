import type { Harness, TestOwner, ExecOptions } from "@garderobe/domain/testing";
import { all, systemPrincipalFor, type Principal } from "@garderobe/domain";
import { getBoard, getToday, prepareBoard, projectCalendarEffects, renderBoardCalendarText, type PrepareBoardResult } from "../src/index.ts";
import { createDailyHarness, TEST_DAILY_SETTINGS, type DailyHarness, type SyntheticHoursSpec } from "../src/testing/index.ts";

export { createDailyHarness, TEST_DAILY_SETTINGS };
export type { DailyHarness };

export const SCHEDULED: ExecOptions = { actor: "system", channel: "scheduled", authorization: "system_schedule" };
export const OUTFIT_CALENDAR = "outfits@test.calendar";

/** A mild day: 12 C at 08:00 rising to 19 C mid-afternoon (synthetic forecast for the fake provider). */
export const MILD_DAY: SyntheticHoursSpec = { temperatureByHour: { 0: 10, 6: 10, 8: 12, 12: 17, 15: 19, 19: 16, 23: 12 } };
export const WARM_DAY: SyntheticHoursSpec = { temperatureByHour: { 0: 17, 8: 20, 15: 26, 23: 19 } };
export const COLD_DAY: SyntheticHoursSpec = { temperatureByHour: { 0: 2, 8: 4, 15: 8, 23: 3 } };

/** The real owner (supplied profile + real inventory imported through the command service), with London and a chosen outfit calendar. */
export async function realOwner(h: DailyHarness): Promise<TestOwner> {
  const { owner } = await h.createRealOwner();
  await owner.exec("settings.update", { patch: TEST_DAILY_SETTINGS });
  return owner;
}

export async function syntheticOwner(h: DailyHarness, garments?: Parameters<Harness["createSyntheticOwner"]>[0]): Promise<TestOwner> {
  return h.createSyntheticOwner({ ...(garments ?? {}), settings: TEST_DAILY_SETTINGS as never });
}

export function system(h: DailyHarness, owner: TestOwner): Promise<Principal> {
  return systemPrincipalFor(h.db, owner.userId, "test:scheduled");
}

/** Compose and publish the board for a date as the scheduled service would. */
export async function compose(h: DailyHarness, owner: TestOwner, localDate: string, extra: Partial<Parameters<typeof prepareBoard>[2]> = {}): Promise<PrepareBoardResult> {
  return prepareBoard(h.deps, await system(h, owner), { localDate, purpose: "evening_compose", idempotencyKey: `test-compose:${owner.userId}:${localDate}:${h.clock.now()}`, ...extra });
}

export async function garmentsByName(h: DailyHarness, owner: TestOwner): Promise<Map<string, { garment_id: string; name: string; category: string; colour: string | null; attributes_json: string }>> {
  const rows = await all<any>(h.db, "SELECT garment_id, name, category, colour, attributes_json FROM garments WHERE user_id = ?", owner.userId);
  return new Map(rows.map((r) => [r.name, r]));
}

export async function garmentRows(h: DailyHarness, owner: TestOwner): Promise<Map<string, { garment_id: string; name: string; category: string; colour: string | null; attributes: Record<string, any> }>> {
  const rows = await all<any>(h.db, "SELECT garment_id, name, category, colour, attributes_json FROM garments WHERE user_id = ?", owner.userId);
  return new Map(rows.map((r) => [r.garment_id, { ...r, attributes: JSON.parse(r.attributes_json ?? "{}") }]));
}

export { getBoard, getToday, projectCalendarEffects, renderBoardCalendarText };
