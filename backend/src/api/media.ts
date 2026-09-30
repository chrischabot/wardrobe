import type { GarmentMedia } from '@garderobe/contracts';
import type { Env } from '../env.js';
import type { Principal } from '../domain/principal.js';

/**
 * Garment display media for API responses (Today, Wardrobe, item page). The visual-wardrobe
 * workstream owns assets and signed URLs; this adapter asks its media service for owner-scoped,
 * short-lived URLs. A resolver is installed at startup (see setMediaResolver); without one every
 * garment reports `media: null`, which clients render as "No photo yet".
 */
export type MediaResolver = (env: Env, principal: Principal, garmentIds: string[], origin: string) => Promise<Map<string, GarmentMedia>>;

let resolver: MediaResolver | null = null;

export function setMediaResolver(r: MediaResolver | null): void {
  resolver = r;
}

export async function garmentMedia(env: Env, principal: Principal, garmentIds: string[], origin: string): Promise<Map<string, GarmentMedia>> {
  if (!resolver || !garmentIds.length) return new Map();
  try {
    return await resolver(env, principal, [...new Set(garmentIds)], origin);
  } catch (err) {
    console.warn('media resolution failed', err instanceof Error ? err.message : String(err));
    return new Map();
  }
}
