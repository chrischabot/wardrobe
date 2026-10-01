import type { CommandReceipt } from "@garderobe/contracts";
import type { CommandService, Db, Principal } from "@garderobe/domain";
import type { ComfortObservation } from "./model.ts";
import type { CalendarReader, CalendarWriter, CompositionModel, Geocoder, WeatherProvider } from "./ports.ts";

/**
 * Everything the daily service needs from its host (the Worker). External services appear only as
 * ports; `null` means "not configured / not connected", which the service reports truthfully.
 */
export interface DailyDeps {
  db: Db;
  commands: CommandService;
  clock?: () => number;
  weather: { provider: WeatherProvider; geocoder: Geocoder } | null;
  calendar: { reader: CalendarReader | null; writer: CalendarWriter | null };
  /** The composition model behind the AI Gateway; without it the deterministic composer is used. */
  model?: CompositionModel | null;
  /** Reader for the owner's dated comfort observations (the assistant workstream's store). */
  comfort?: ((principal: Principal) => Promise<ComfortObservation[]>) | null;
  /** Upper bound on model calls per composition (the morning budget). */
  maxModelAttempts?: number;
}

/** Comfort observations are context, never a dependency of the morning: a failing reader yields none. */
export async function loadComfort(deps: DailyDeps, principal: Principal): Promise<ComfortObservation[]> {
  if (!deps.comfort) return [];
  try {
    return await deps.comfort(principal);
  } catch {
    return [];
  }
}

export function nowOf(deps: DailyDeps, nowMs?: number): number {
  return nowMs ?? deps.clock?.() ?? Date.now();
}

/** Execute a command as the given principal, with the authorization basis that principal can carry. */
export function execAs(deps: DailyDeps, principal: Principal, type: string, payload: Record<string, unknown>, idempotencyKey: string, opts: { expectedVersions?: Record<string, number> } = {}): Promise<CommandReceipt> {
  const authorization = principal.actor === "system" ? "system_schedule" : principal.actor === "assistant" ? "owner_statement" : "owner_tap";
  return deps.commands.execute(principal, {
    type,
    payload,
    idempotencyKey,
    expectedVersions: opts.expectedVersions ?? {},
    authorization,
    source: { channel: principal.channel },
  });
}
