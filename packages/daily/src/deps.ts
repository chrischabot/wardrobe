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
  /**
   * A composition model budgeted to one owner. When given it takes precedence over `model`, so the
   * scheduled sweep (which serves every owner with one set of dependencies) attributes each owner's
   * inference to that owner. Return null for an owner with no usable model.
   */
  modelFor?: ((principal: Principal) => CompositionModel | null) | null;
  /** Wall-clock budget for the model part of one composition (default two minutes); the fallback composer then takes over. */
  modelBudgetMs?: number;
  /** Reader for the owner's dated comfort observations (the assistant workstream's store). */
  comfort?: ((principal: Principal) => Promise<ComfortObservation[]>) | null;
  /** Upper bound on model calls per composition (the morning budget). */
  maxModelAttempts?: number;
  /**
   * The deployment's own origin (for example `https://garderobe.example`). The Calendar event links to
   * `<origin>/board/<date>` unless the owner's settings name another base address.
   */
  boardBaseUrl?: string | null;
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

/** The composition model to use for this owner, or null for the deterministic composer alone. */
export function modelOf(deps: DailyDeps, principal: Principal): CompositionModel | null {
  if (deps.modelFor) {
    try {
      return deps.modelFor(principal);
    } catch {
      return null; // a model that cannot be constructed is an outage, never a reason to fail the board
    }
  }
  return deps.model ?? null;
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
