import type { EntityType } from '@garderobe/contracts';

/** Machine-readable domain error codes. The API layer maps them to HTTP statuses. */
export type DomainErrorCode =
  | 'unauthenticated'
  | 'insufficient_scope'
  | 'forbidden_owner_field'
  | 'validation_failed'
  | 'not_found'
  | 'idempotency_key_reused'
  | 'conflict'
  | 'invalid_state'
  | 'never_laundered'
  | 'not_reversible'
  | 'already_undone'
  | 'rule_admits_no_exception'
  | 'evidence_required'
  | 'user_disabled';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function notFound(entityType: EntityType, entityId: string): DomainError {
  // Deliberately identical for "missing" and "belongs to another user": existence is not leaked.
  return new DomainError('not_found', `No ${entityType.replace('_', ' ')} ${entityId}`, { entityType, entityId });
}
