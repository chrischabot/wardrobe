import { env } from 'cloudflare:workers';
import profileText from '../../../data/owner-profile.md?raw';
import csvText from '../../../data/wardrobe-inventory-2026-05.csv?raw';
import rulesCatalogue from '../../../data/owner-profile-rules.json';
import ownerAdditions from '../../../data/owner-asserted-additions-2026-09-29.json';
import { CommandService, createUser, ownerPrincipal, type Principal } from '../../../backend/src/domain/index.js';
import { applyOwnerAssertedAdditions, importOwnerData, parseOwnerAdditions } from '../../../backend/src/import/index.js';
import { accessClaims, signRs256Jwt } from '../../../backend/src/auth/dev.js';
import { applyTestEvents, TEST_EVENT_LABEL, type TestEventResult } from '../../../demo/src/test-events.js';

/**
 * Seeds the owner exactly as the foundation's seed does (demo/scripts/seed-local.ts): the real
 * profile (data/owner-profile.md, byte-exact), its 41 rules, the real May 2026 inventory CSV through
 * the section-16 importer, and the owner-asserted additions of 2026-09-29. The owner is linked to a
 * local Cloudflare Access identity so every journey authenticates through the Worker's own Access
 * verification. Scenario state is only ever added through commands as labelled TEST EVENTs.
 */

export const PROFILE_TEXT = profileText;
export const PROFILE_SHA256 = 'e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198';
export const ISSUER = env.ACCESS_TEAM_DOMAIN!;
export const AUDIENCE = env.ACCESS_AUD!.split(',')[0]!;
export { TEST_EVENT_LABEL };

let n = 0;
export function uniq(prefix = 'j'): string {
  n++;
  return `${prefix}-${Date.now().toString(36)}-${n}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function accessAssertion(subject: string, opts: { ttlSeconds?: number; nowSeconds?: number } = {}): Promise<string> {
  const jwk = JSON.parse(env.TEST_ACCESS_PRIVATE_JWK!) as JsonWebKey & { kid?: string };
  return signRs256Jwt(jwk, accessClaims({ issuer: ISSUER, audience: AUDIENCE, subject, ttlSeconds: opts.ttlSeconds ?? 3600, nowSeconds: opts.nowSeconds }));
}

export interface Owner {
  userId: string;
  principal: Principal;
  subject: string;
  /** A verified Cloudflare Access assertion for this owner (signed with the local test key). */
  assertion: string;
  garmentCount: number;
  byName: (name: string) => Promise<string>;
  /** Labelled scenario events, applied through the real command service. */
  applyTestEvents: (weekStart: string, now?: () => string) => Promise<TestEventResult>;
}

export async function seedOwner(opts: { displayName?: string; importedAt?: string } = {}): Promise<Owner> {
  const subject = uniq('access-sub');
  const { userId } = await createUser(env.DB, {
    displayName: opts.displayName ?? 'Chris',
    identity: { issuer: ISSUER, subject, email: 'owner@example.invalid' },
    now: '2026-09-20T00:00:00.000Z',
  });
  const principal = ownerPrincipal(userId, 'test');
  const imported = await importOwnerData(env.DB, principal, { profileText, csvText, rulesCatalogue }, { importedAt: opts.importedAt ?? '2026-09-20T08:00:00.000Z' });
  void imported;
  const additions = parseOwnerAdditions(ownerAdditions, profileText);
  await applyOwnerAssertedAdditions(env.DB, principal, additions);
  const byName = async (name: string): Promise<string> => {
    const row = await env.DB.prepare('SELECT garment_id FROM garments WHERE user_id = ? AND name = ?').bind(userId, name).first<{ garment_id: string }>();
    if (!row) throw new Error(`No garment named ${name}`);
    return row.garment_id;
  };
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM garments WHERE user_id = ?').bind(userId).first<{ n: number }>();
  return {
    userId,
    principal,
    subject,
    assertion: await accessAssertion(subject),
    garmentCount: count?.n ?? 0,
    byName,
    applyTestEvents: (weekStart, now) => applyTestEvents(new CommandService(env.DB, principal, now ? { now } : {}), { garment: byName, weekStart }),
  };
}
