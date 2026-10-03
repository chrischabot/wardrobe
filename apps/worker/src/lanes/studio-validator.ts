import { suggestOutfits, validateOutfit } from "@garderobe/daily";
import { createPrincipal, first, type Db, type Principal } from "@garderobe/domain";
import type { OutfitValidator } from "@garderobe/media";
import type { DailyPort } from "../ports.ts";

type Forecast = Awaited<ReturnType<DailyPort["weather"]>>;

/** The mounted daily service's forecast read, or nothing when the daily service is not mounted. Supplied where the application is composed. */
export type ForecastSource = () => Promise<Pick<DailyPort, "weather"> | null | undefined>;

const mayRead = (principal: Principal): boolean => principal.scopes.includes("read") || principal.scopes.includes("admin");

/**
 * The forecast Studio hands to the daily service's check for a day, or undefined to leave the check to
 * what is recorded.
 *
 *  - A forecast already recorded for the day (a board was prepared, the owner asked about the weather)
 *    is the one the owner's board rests on. Studio then supplies nothing, so the daily service uses that
 *    recorded forecast and Studio never disagrees with the board. Only a day with no recorded forecast,
 *    or whose latest record says the forecast was unavailable, is read afresh.
 *  - The read goes through the mounted daily service (its provider, its shared forecast cache, the
 *    owner's freshness setting, the application's clock) with the read capability only. The daily
 *    service records a forecast as the owner's snapshot only for a caller that may write, so looking at
 *    an outfit leaves no command and no snapshot behind.
 *  - A caller without the read capability gets no forecast read at all; the daily service's check then
 *    refuses that caller as it always did.
 *  - Whatever stops a forecast from being had (no home city, the provider unreachable or refusing the
 *    date, the daily service not mounted, the read failing) yields undefined: the temperature rules are
 *    then reported as unchecked, never assumed, and the outfit check itself still answers.
 */
async function forecastToSupply(source: ForecastSource, db: Db, principal: Principal, localDate: string): Promise<Forecast | undefined> {
  if (!mayRead(principal)) return undefined;
  try {
    // Studio checks home days; the daily service reads the latest record that is not a trip destination's.
    const recorded = await first<{ freshness: string }>(db, "SELECT freshness FROM weather_snapshots WHERE user_id = ? AND local_date = ? AND purpose != 'trip' ORDER BY created_at DESC, snapshot_id DESC LIMIT 1", principal.userId, localDate);
    if (recorded && recorded.freshness !== "unavailable") return undefined;
    const daily = await source();
    if (!daily) return undefined;
    const reader = createPrincipal({ userId: principal.userId, actor: principal.actor, channel: principal.channel, scopes: ["read"], authRef: principal.authRef });
    const forecast = await daily.weather(reader, localDate);
    return forecast.freshness === "unavailable" ? undefined : forecast;
  } catch (error) {
    // Only the kind of failure is logged: a provider error's text can carry the request address, and with it the owner's home coordinates.
    console.warn("Studio could not read a forecast; temperature rules are reported as unchecked", error instanceof Error ? error.name : "error");
    return undefined;
  }
}

/**
 * Studio's validator: the daily service's own validation and suggestions (`validateOutfit`,
 * `suggestOutfits`; its `outfitValidator` is exactly these two and carries no name, so Studio labels the
 * result "daily-service"), given the day's forecast when none is recorded.
 *
 * Those functions read only a forecast that is already recorded, and for a day nobody has asked a board
 * for there is none. The forecast is mandatory context that the backend fetches (specification section
 * 7), so it is fetched here and handed in.
 *
 * One request checks an outfit several times (every suggestion is validated again), always with the
 * same authenticated caller object, so the forecast is decided once per caller and day and reused for
 * that caller; a new request authenticates again and decides again.
 *
 * A plan for a day (`studio.plan_for_day`) stores the verdict it was accepted on. When that verdict used
 * a forecast read here, the forecast is not recorded as the owner's snapshot (a plan is an intention,
 * not a board), so the stored verdict names no snapshot and a later check may see a newer forecast.
 */
export function createStudioValidator(source: ForecastSource): OutfitValidator {
  const decided = new WeakMap<Principal, Map<string, Promise<Forecast | undefined>>>();
  const forecastFor = (db: Db, principal: Principal, localDate: string): Promise<Forecast | undefined> => {
    let days = decided.get(principal);
    if (!days) decided.set(principal, (days = new Map()));
    let forecast = days.get(localDate);
    if (!forecast) days.set(localDate, (forecast = forecastToSupply(source, db, principal, localDate)));
    return forecast;
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
