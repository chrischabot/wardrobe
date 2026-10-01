/**
 * Contract versioning.
 *
 * CONTRACT_VERSION follows semver. Additive changes (new optional fields, new
 * command types, new enum members that clients must tolerate) bump the minor
 * version; a breaking change bumps the major version and the API path prefix.
 * Clients must tolerate unknown fields, unknown command/event types and unknown
 * enum members (specification section 13).
 */
export const CONTRACT_VERSION = "1.0.0" as const;
export const API_VERSION = "v1" as const;
/** Version of the availability estimator whose output shape is part of the contract. */
export const AVAILABILITY_MODEL_VERSION = "availability-estimator/1.0.0" as const;
