/**
 * Contract versioning.
 *
 * CONTRACTS_VERSION identifies the shape of every schema exported from this package.
 * It is a date string: additive changes keep the version, breaking changes mint a new one.
 * API_VERSION is the URL prefix of the native/web HTTP API (spec section 13).
 */
export const CONTRACTS_VERSION = '2026-10-01' as const;
export const API_VERSION = 'v1' as const;

/** Version of the availability estimator implemented in backend/src/domain/estimator. */
export const ESTIMATOR_VERSION = 'availability-estimator/1' as const;

/** Format marker of the neutral import/export dataset (spec section 16). */
export const NEUTRAL_EXPORT_FORMAT = 'garderobe-neutral-export' as const;
export const NEUTRAL_EXPORT_VERSION = 1 as const;
