import { DailySettings } from "@garderobe/contracts/ext/daily";
import { suggestOutfits, validateOutfit } from "@garderobe/daily";
import { createPrincipal, first, getSettings, localDateOf, type Db, type Principal } from "@garderobe/domain";
import type { OutfitValidator } from "@garderobe/media";
import type { DailyPort } from "../ports.ts";

type Forecast = Awaited<ReturnType<DailyPort["weather"]>>;

/**
 * The mounted daily service's forecast read and the application's clock, or nothing when the daily
 * service is not mounted. Supplied where the application is composed.
 */
export type ForecastSource = () => Promise<{ weather: DailyPort["weather"]; now(): number } | null | undefined>;

export interface StudioValidatorOptions {
  /**
   * How long (milliseconds of real time) one caller's decision for a day is reused. One request checks
   * an outfit several times; this only has to outlast a request. Default ten seconds.
   */
  reuseMs?: number;
}

const DEFAULT_REUSE_MS = 10_000;

const mayRead = (principal: Principal): boolean => principal.scopes.includes("read") || principal.scopes.includes("admin");

/**
 * The forecast Studio hands to the daily service's check for a day, or undefined to leave the check to
 * what is recorded.
 *
 *  - A forecast recorded for the day (a board was prepared, the owner asked about the weather) is the
 *    one the owner's board rests on. While that record is within the owner's forecast freshness setting,
 *    or the day is already over, Studio supplies nothing: the daily service uses the record and Studio
 *    does not disagree with the board.
 *  - A day with no recorded forecast, one whose latest record says the forecast was unavailable, and one
 *    whose record is past the freshness setting are read afresh, as the daily service itself does before
 *    a weather-dependent swap. A fresh read replaces a usable record only when it is newer than that
 *    record; on an outage the record stands.
 *  - The read goes through the mounted daily service (its provider, its shared forecast cache, the
 *    owner's freshness setting, the application's clock) with the read capability only. The daily
 *    service records a forecast as the owner's snapshot only for a caller that may write, so looking at
 *    an outfit leaves no command and no snapshot behind.
 *  - A caller without the read capability gets no forecast read at all; the daily service's check then
 *    refuses that caller as it always did.
 *  - The daily service answers "unavailable" itself when a forecast cannot be had (no home city, the
 *    provider unreachable or refusing the date); that, and the daily service not being mounted, yield
 *    undefined: the temperature rules are then reported as unchecked, never assumed. Nothing is caught
 *    here, so a failing database or a defect surfaces as an error instead of reading as "unchecked".
 */
async function forecastToSupply(source: ForecastSource, db: Db, principal: Principal, localDate: string): Promise<Forecast | undefined> {
  if (!mayRead(principal)) return undefined;
  const daily = await source();
  if (!daily) return undefined;
  // Studio checks home days; the daily service reads the latest record that is not a trip destination's.
  const recorded = await first<{ freshness: string; fetched_at: string }>(db, "SELECT freshness, fetched_at FROM weather_snapshots WHERE user_id = ? AND local_date = ? AND purpose != 'trip' ORDER BY created_at DESC, snapshot_id DESC LIMIT 1", principal.userId, localDate);
  const usable = recorded && recorded.freshness !== "unavailable" ? recorded : null;
  if (usable) {
    const { settings } = await getSettings(db, principal);
    const threshold = DailySettings.safeParse((settings.extensions as { daily?: unknown }).daily ?? {});
    const maxAgeMinutes = (threshold.success ? threshold.data : DailySettings.parse({})).weatherMaxAgeMinutes;
    const nowMs = daily.now();
    const ageMinutes = (nowMs - Date.parse(usable.fetched_at)) / 60_000;
    // A record whose time cannot be read is treated as out of date. A day already over keeps its record: there is no forecast left to read for it.
    const fresh = Number.isFinite(ageMinutes) && ageMinutes <= maxAgeMinutes;
    if (fresh || localDate < localDateOf(nowMs, settings.timezone)) return undefined;
  }
  const reader = createPrincipal({ userId: principal.userId, actor: principal.actor, channel: principal.channel, scopes: ["read"], authRef: principal.authRef });
  const forecast = await daily.weather(reader, localDate);
  if (forecast.freshness === "unavailable") return undefined;
  // A fresh read replaces a usable record only when it is newer; a record whose time cannot be read is simply replaced.
  const recordedAt = usable ? Date.parse(usable.fetched_at) : Number.NaN;
  if (usable && Number.isFinite(recordedAt) && !(Date.parse(forecast.fetchedAt) > recordedAt)) return undefined;
  return forecast;
}

/**
 * Studio's validator: the daily service's own validation and suggestions (`validateOutfit`,
 * `suggestOutfits`; its `outfitValidator` is exactly these two and carries no name, so Studio labels the
 * result "daily-service"), given the day's forecast when none is recorded or the record is out of date.
 *
 * Those functions read only a forecast that is already recorded, and for a day nobody has asked a board
 * for there is none. The forecast is mandatory context that the backend fetches (specification section
 * 7), so it is fetched here and handed in.
 *
 * One request checks an outfit several times (every suggestion is validated again), always with the
 * same authenticated caller object, so the forecast is decided once per caller and day and reused for
 * that caller for a few seconds; a new request authenticates again and decides again, and a caller
 * object that lives longer (scheduled or queued work) decides again once that time has passed. A read
 * that failed is not kept.
 *
 * A plan for a day (`studio.plan_for_day`) stores the verdict it was accepted on. When that verdict used
 * a forecast read here, the forecast is not recorded as the owner's snapshot (a plan is an intention,
 * not a board), so the stored verdict names no snapshot and a later check may see a newer forecast.
 */
export function createStudioValidator(source: ForecastSource, options: StudioValidatorOptions = {}): OutfitValidator {
  const reuseMs = options.reuseMs ?? DEFAULT_REUSE_MS;
  type Decision = { at: number; forecast: Promise<Forecast | undefined> };
  const decided = new WeakMap<Principal, Map<string, Decision>>();
  const forecastFor = (db: Db, principal: Principal, localDate: string): Promise<Forecast | undefined> => {
    let days = decided.get(principal);
    if (!days) decided.set(principal, (days = new Map()));
    const at = Date.now();
    for (const [day, decision] of days) if (at - decision.at >= reuseMs) days.delete(day);
    const held = days.get(localDate);
    if (held) return held.forecast;
    const decision: Decision = { at, forecast: forecastToSupply(source, db, principal, localDate) };
    days.set(localDate, decision);
    const kept = days;
    decision.forecast.catch(() => {
      if (kept.get(localDate) === decision) kept.delete(localDate);
    });
    return decision.forecast;
  };
  const withForecast = async <T extends { forDate: string }>(db: Db, principal: Principal, input: T) => {
    const weather = await forecastFor(db, principal, input.forDate);
    return weather ? { ...input, weather } : input;
  };
  return {
    validate: async (db, principal, input) => validateOutfit(db, principal, await withForecast(db, principal, input)),
    suggest: async (db, principal, input) => suggestOutfits(db, principal, await withForecast(db, principal, input)),
  };
}
