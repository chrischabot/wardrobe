import { env, exports } from 'cloudflare:workers';
import { accessClaims, signRs256Jwt } from '../../../backend/src/auth/dev.js';
import { installApiTestOverrides } from '../../../backend/src/api/services.js';
import { FakeWeatherProvider, type FakeWeatherOptions } from '../../../backend/src/weather/fake.js';
import { newOwner, key } from './seed.js';

/** HTTP helpers: every request goes through the real Worker fetch handler (`exports.default.fetch`). */

export const ORIGIN = 'http://localhost:8787';
export const ISSUER = env.ACCESS_TEAM_DOMAIN!;
export const AUDIENCE = env.ACCESS_AUD!.split(',')[0]!;

export class ApiClock {
  constructor(public value: string) {}
  now = (): string => this.value;
  set(iso: string): void {
    this.value = new Date(iso).toISOString();
  }
}

/** Fake weather (FakeWeatherProvider stands in for Open-Meteo) and a controllable clock for the API services. */
export function installApiScenario(opts: { now?: string; scenario?: FakeWeatherOptions['scenario'] } = {}) {
  const clock = new ApiClock(opts.now ?? '2026-10-06T05:30:00.000Z');
  const weather = new FakeWeatherProvider({ scenario: opts.scenario ?? 'mild', clock: clock.now });
  installApiTestOverrides({ weather, calendar: null, clock: clock.now });
  return { clock, weather };
}

export async function accessToken(subject: string, extra: { issuer?: string; audience?: string; ttlSeconds?: number; nowSeconds?: number; jwk?: string; email?: string } = {}): Promise<string> {
  const jwk = JSON.parse(extra.jwk ?? env.TEST_ACCESS_PRIVATE_JWK!) as JsonWebKey & { kid?: string };
  return signRs256Jwt(jwk, accessClaims({ issuer: extra.issuer ?? ISSUER, audience: extra.audience ?? AUDIENCE, subject, email: extra.email, ttlSeconds: extra.ttlSeconds, nowSeconds: extra.nowSeconds }));
}

/** The owner (real profile, CSV and owner-asserted additions) linked to a local Access identity. */
export async function apiOwner(displayName = 'Chris') {
  const owner = await newOwner({ displayName });
  const subject = key('access-sub');
  await env.DB.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, email, linked_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(owner.userId, `idn_${crypto.randomUUID().replace(/-/g, '')}`, ISSUER, subject, `${subject}@example.invalid`, '2026-09-20T00:00:00.000Z')
    .run();
  await env.DB.prepare('UPDATE owner_settings SET home_latitude = 51.4941, home_longitude = -0.0996 WHERE user_id = ?').bind(owner.userId).run();
  const assertion = await accessToken(subject);
  return { ...owner, subject, assertion };
}
export type ApiOwner = Awaited<ReturnType<typeof apiOwner>>;

/** A signed-in owner with no records at all (a fresh Garderobe to restore into). */
export async function emptyApiOwner(displayName = 'Chris') {
  const subject = key('empty-sub');
  const userId = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (user_id, display_name, status, created_at, version) VALUES (?, ?, 'active', ?, 1)").bind(userId, displayName, '2026-10-05T00:00:00.000Z'),
    env.DB.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, linked_at) VALUES (?, ?, ?, ?, ?)').bind(userId, `idn_${crypto.randomUUID().replace(/-/g, '')}`, ISSUER, subject, '2026-10-05T00:00:00.000Z'),
  ]);
  return { userId, subject, assertion: await accessToken(subject) };
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: BodyInit;
  assertion?: string | null;
  bearer?: string;
  headers?: Record<string, string>;
  origin?: string;
}

export async function call(path: string, opts: CallOptions = {}): Promise<Response> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.assertion) headers.set('cf-access-jwt-assertion', opts.assertion);
  if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
  let body: BodyInit | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    if (opts.body instanceof URLSearchParams) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      body = opts.body.toString();
    } else {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      body = JSON.stringify(opts.body);
    }
  }
  const method = opts.method ?? (body !== undefined ? 'POST' : 'GET');
  return exports.default.fetch(new Request(`${opts.origin ?? ORIGIN}${path}`, { method, headers, body, redirect: 'manual' }));
}

export async function callJson<T = Record<string, unknown>>(path: string, opts: CallOptions = {}): Promise<{ status: number; body: T; res: Response; text: string }> {
  const res = await call(path, opts);
  const text = await res.text();
  let body: T;
  try {
    body = (text ? JSON.parse(text) : null) as T;
  } catch {
    body = { raw: text } as T;
  }
  return { status: res.status, body, res, text };
}

export async function prepareToday(assertion: string): Promise<Record<string, unknown>> {
  const r = await callJson('/v1/today/prepare', { assertion, body: {} });
  if (r.status !== 200 || !(r.body as { published?: boolean }).published) throw new Error(`prepare failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export function idem(prefix = 'app'): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function b64url(bytes: Uint8Array | ArrayBuffer | string): string {
  const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlJson(value: unknown): string {
  return b64url(JSON.stringify(value));
}

export function decodeJwtPart(part: string): Record<string, unknown> {
  const s = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)))) as Record<string, unknown>;
}

export async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

export function randomVerifier(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(48)));
}

/** A fresh RSA private JWK Access does not use (forged signatures). */
export async function foreignJwk(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return JSON.stringify({ ...jwk, kid: 'test-access-key' });
}
