import type { Actor, Channel, Scope } from "@garderobe/contracts";
import { CommandError } from "./errors.ts";

/**
 * The authenticated principal every domain read and write requires.
 *
 * A Principal is only ever constructed by trusted code from a verified identity (Access
 * assertion, MCP grant, durable job owner, importer). Request bodies never carry ownership:
 * there is no code path that reads a user ID from a payload.
 */
export interface Principal {
  readonly userId: string;
  readonly actor: Actor;
  readonly channel: Channel;
  readonly scopes: readonly Scope[];
  /** Opaque reference to the verified credential/grant/job, for audit. */
  readonly authRef: string;
}

const brand = new WeakSet<object>();

export function createPrincipal(input: { userId: string; actor: Actor; channel: Channel; scopes: Scope[]; authRef: string }): Principal {
  if (!input.userId || typeof input.userId !== "string") throw new CommandError("forbidden", "a principal requires a verified internal user ID");
  const principal: Principal = Object.freeze({ ...input, scopes: Object.freeze([...input.scopes]) });
  brand.add(principal);
  return principal;
}

/** Rejects look-alike objects (e.g. a parsed request body) that were not created by createPrincipal. */
export function assertPrincipal(p: unknown): asserts p is Principal {
  if (typeof p !== "object" || p === null || !brand.has(p)) {
    throw new CommandError("forbidden", "an authenticated principal is required");
  }
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!p.scopes.includes(scope) && !p.scopes.includes("admin")) {
    throw new CommandError("forbidden", `this connection lacks the '${scope}' capability`, { requiredScope: scope });
  }
}
