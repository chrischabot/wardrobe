import { env, exports } from 'cloudflare:workers';
import { accessClaims, signRs256Jwt } from '../../src/auth/dev.js';
import { installApiTestOverrides } from '../../src/api/services.js';
import { FakeWeatherProvider, type FakeWeatherOptions } from '../../src/weather/fake.js';
import { newOwner, key } from './fixtures.js';

/** Helpers for HTTP API / MCP integration tests: requests go through the Worker's own fetch handler. */

export const ORIGIN = 'http://localhost:8787';
export const ISSUER = env.ACCESS_TEAM_DOMAIN!;
export const AUDIENCE = env.ACCESS_AUD!.split(',')[0]!;

/** A controllable clock for the API's services (board date, receipts, run events). */
export class ApiClock {
  constructor(public value: string) {}
  now = (): string => this.value;
  set(iso: string): void {
    this.value = new Date(iso).toISOString();
  }
}

export function installApiScenario(opts: { now?: string; scenario?: FakeWeatherOptions['scenario'] } = {}) {
  const clock = new ApiClock(opts.now ?? '2026-10-06T05:30:00.000Z');
  // Each fake instance has its own provider identity, so the shared weather cache never mixes scenarios.
  const weather = new FakeWeatherProvider({ scenario: opts.scenario ?? 'mild', clock: clock.now });
  installApiTestOverrides({ weather, calendar: null, clock: clock.now });
  return { clock, weather };
}

export async function accessToken(subject: string, extra: { issuer?: string; audience?: string; ttlSeconds?: number; nowSeconds?: number; jwk?: string } = {}): Promise<string> {
  const jwk = JSON.parse(extra.jwk ?? env.TEST_ACCESS_PRIVATE_JWK!) as JsonWebKey & { kid?: string };
  return signRs256Jwt(jwk, accessClaims({ issuer: extra.issuer ?? ISSUER, audience: extra.audience ?? AUDIENCE, subject, ttlSeconds: extra.ttlSeconds, nowSeconds: extra.nowSeconds }));
}

/** The owner (real profile, CSV and owner-asserted additions) linked to a local Access identity. */
export async function apiOwner() {
  const owner = await newOwner({ withAdditions: true });
  const subject = key('access-sub');
  await env.DB.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, email, linked_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(owner.userId, `idn_${crypto.randomUUID().replace(/-/g, '')}`, ISSUER, subject, 'owner@example.invalid', '2026-09-20T00:00:00.000Z')
    .run();
  await env.DB.prepare("UPDATE owner_settings SET home_latitude = 51.4941, home_longitude = -0.0996 WHERE user_id = ?").bind(owner.userId).run();
  const assertion = await accessToken(subject);
  return { ...owner, subject, assertion };
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  assertion?: string | null;
  bearer?: string;
  headers?: Record<string, string>;
  origin?: string;
}

export async function call(path: string, opts: CallOptions = {}): Promise<Response> {
  const headers = new Headers(opts.headers ?? {});
  if (opts.assertion) headers.set('cf-access-jwt-assertion', opts.assertion);
  if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (opts.body instanceof URLSearchParams) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      body = opts.body.toString();
    } else {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(opts.body);
    }
  }
  return exports.default.fetch(new Request(`${opts.origin ?? ORIGIN}${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body, redirect: 'manual' }));
}

export async function callJson<T = Record<string, unknown>>(path: string, opts: CallOptions = {}): Promise<{ status: number; body: T; res: Response }> {
  const res = await call(path, opts);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, res };
}

/** Publishes today's board through the API (the owner's "prepare now"). */
export async function prepareToday(assertion: string): Promise<Record<string, unknown>> {
  const r = await callJson('/v1/today/prepare', { assertion, body: {} });
  if (r.status !== 200 || !(r.body as { published?: boolean }).published) throw new Error(`prepare failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export function idem(prefix = 'app'): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
