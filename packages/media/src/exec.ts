/** Executing commands from this package's functions and pipelines: always through the ONE command service. */
import { systemPrincipalFor, type Principal } from "@garderobe/domain";
import type { CommandReceipt } from "@garderobe/contracts";
import type { MediaRuntime } from "./runtime.ts";

/** Run a command as the authenticated caller (owner tap, or an assistant acting on an owner statement). */
export function execAs(rt: MediaRuntime, principal: Principal, type: string, payload: Record<string, unknown>, idempotencyKey: string, expectedVersions: Record<string, number> = {}): Promise<CommandReceipt> {
  const authorization = principal.actor === "owner" ? "owner_tap" : principal.actor === "assistant" ? "owner_statement" : "system_schedule";
  return rt.service.execute(principal, { type, payload, idempotencyKey, expectedVersions, authorization, source: { channel: principal.channel } });
}

/**
 * Record a pipeline result under the job's verified owner. `systemPrincipalFor` rechecks that the
 * account is still active, so a disabled account produces no further effects.
 */
export async function execSystem(rt: MediaRuntime, userId: string, type: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<CommandReceipt> {
  const principal = await systemPrincipalFor(rt.db, userId, `media:${idempotencyKey}`.slice(0, 120), "system");
  return rt.service.execute(principal, { type, payload, idempotencyKey, expectedVersions: {}, authorization: "system_schedule", source: { channel: "system" } });
}
