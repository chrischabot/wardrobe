import type { SourceChannel } from '@garderobe/contracts';
import { DomainError } from './errors.js';

/**
 * The authenticated principal. Every domain entry point takes one and scopes every query by its
 * internal userId. Request bodies never carry ownership: `findForgedOwnerFields` rejects them.
 *
 * Only trusted authentication code (Access assertion verification, the MCP OAuth provider, the
 * scheduler using a durable job's verified owner) constructs principals.
 */
export interface Principal {
  readonly userId: string;
  /** Granted scopes, e.g. 'wardrobe:read', 'wardrobe:write'. '*' grants everything. */
  readonly scopes: readonly string[];
  /** How the principal authenticated: 'access', 'mcp_oauth', 'scheduler', 'test', ... */
  readonly authenticatedBy: string;
}

export const SCOPE_READ = 'wardrobe:read';
export const SCOPE_WRITE = 'wardrobe:write';

/** Channels through which an owner can make an authoritative statement (e.g. "my feet have healed"). */
export const OWNER_CHANNELS: readonly SourceChannel[] = ['app', 'web', 'conversation', 'mcp', 'offline_replay'];

export function ownerPrincipal(userId: string, authenticatedBy = 'access', scopes: readonly string[] = [SCOPE_READ, SCOPE_WRITE]): Principal {
  return Object.freeze({ userId, scopes: Object.freeze([...scopes]), authenticatedBy });
}

export function readOnlyPrincipal(userId: string, authenticatedBy = 'mcp_oauth'): Principal {
  return ownerPrincipal(userId, authenticatedBy, [SCOPE_READ]);
}

/** Principal for scheduled work, derived from a durable job's verified owner. */
export function systemPrincipal(userId: string): Principal {
  return ownerPrincipal(userId, 'scheduler', [SCOPE_READ, SCOPE_WRITE]);
}

const USER_ID_PATTERN = /^usr_[A-Za-z0-9_-]{4,64}$/;

export function assertPrincipal(principal: Principal | null | undefined): asserts principal is Principal {
  if (!principal || typeof principal.userId !== 'string' || !USER_ID_PATTERN.test(principal.userId)) {
    throw new DomainError('unauthenticated', 'An authenticated principal with an internal user id is required');
  }
}

export function hasScope(principal: Principal, scope: string): boolean {
  return principal.scopes.includes('*') || principal.scopes.includes(scope);
}

export function requireScope(principal: Principal, scope: string): void {
  if (!hasScope(principal, scope)) {
    throw new DomainError('insufficient_scope', `This connection is not granted ${scope}`, { scope });
  }
}

const OWNER_KEY = /^(user_?id|owner_?id|owner|user|principal|account_?id|tenant_?id)$/i;

/** Returns JSON paths of any ownership-looking field in an untrusted body. */
export function findForgedOwnerFields(body: unknown, path = '$'): string[] {
  if (Array.isArray(body)) return body.flatMap((v, i) => findForgedOwnerFields(v, `${path}[${i}]`));
  if (body && typeof body === 'object') {
    const hits: string[] = [];
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (OWNER_KEY.test(key)) hits.push(`${path}.${key}`);
      hits.push(...findForgedOwnerFields(value, `${path}.${key}`));
    }
    return hits;
  }
  return [];
}
