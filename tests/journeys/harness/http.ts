import { exports } from 'cloudflare:workers';
import { CommandReceipt, TodayResponse, WardrobePage, type DomainCommandInput, type WardrobeItem } from '@garderobe/contracts';
import { uniq } from './owner.js';

/** HTTP client for the Worker's own fetch handler (the native/web API surface). */

export const ORIGIN = 'http://localhost:8787';

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
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body: body as T, res };
}

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** An authenticated app session (Access assertion) with typed helpers for the journeys. */
export class App {
  constructor(public assertion: string) {}

  get<T = Record<string, unknown>>(path: string) {
    return callJson<T>(path, { assertion: this.assertion });
  }

  post<T = Record<string, unknown>>(path: string, body: unknown = {}) {
    return callJson<T>(path, { assertion: this.assertion, body });
  }

  async today(date?: string): Promise<TodayResponse> {
    const r = await this.get(`/v1/today${date ? `?date=${date}` : ''}`);
    if (r.status !== 200) throw new Error(`GET /v1/today ${r.status}: ${JSON.stringify(r.body)}`);
    return TodayResponse.parse(r.body);
  }

  /** "Prepare now": compose, validate and publish the day's board through the API. */
  async prepare(body: { date?: string; count?: number } = {}): Promise<{ published: boolean; reason: string; revision: number | null; shortfall: string | null }> {
    const r = await this.post<{ published: boolean; reason: string; revision: number | null; shortfall: string | null }>('/v1/today/prepare', body);
    if (r.status !== 200) throw new Error(`POST /v1/today/prepare ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  }

  /** POST /v1/commands with a fresh idempotency key; returns the HTTP status and the parsed receipt. */
  async command(command: DomainCommandInput, extra: { idempotencyKey?: string; source?: string; expectedVersions?: unknown[] } = {}): Promise<{ status: number; receipt: CommandReceipt; raw: unknown }> {
    const body = { idempotencyKey: extra.idempotencyKey ?? uniq('app'), source: extra.source ?? 'app', ...(extra.expectedVersions ? { expectedVersions: extra.expectedVersions } : {}), command };
    const r = await this.post('/v1/commands', body);
    const parsed = CommandReceipt.safeParse(r.body);
    if (!parsed.success) throw new Error(`POST /v1/commands ${r.status} returned no receipt: ${JSON.stringify(r.body).slice(0, 600)}`);
    return { status: r.status, receipt: parsed.data, raw: r.body };
  }

  /** A command that must commit (or merge); throws with the error otherwise. */
  async commit(command: DomainCommandInput, extra: { idempotencyKey?: string; source?: string; expectedVersions?: unknown[] } = {}): Promise<CommandReceipt> {
    const { status, receipt } = await this.command(command, extra);
    if (receipt.outcome !== 'committed' && receipt.outcome !== 'merged') throw new Error(`${command.type} → ${status} ${receipt.outcome}: ${receipt.error?.code} ${receipt.error?.message} ${JSON.stringify(receipt.error?.details ?? {})}`);
    return receipt;
  }

  /** The complete wardrobe (every page), keyed by garment id. */
  async wardrobe(query = ''): Promise<{ page: WardrobePage; byId: Map<string, WardrobeItem> }> {
    const items: WardrobeItem[] = [];
    let cursor: string | null = null;
    let first: WardrobePage | null = null;
    do {
      const sep = query ? '&' : '';
      const r = await this.get(`/v1/wardrobe?${query}${sep}limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      if (r.status !== 200) throw new Error(`GET /v1/wardrobe ${r.status}: ${JSON.stringify(r.body)}`);
      const page = WardrobePage.parse(r.body);
      first ??= page;
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return { page: first!, byId: new Map(items.map((i) => [i.garment.garmentId, i])) };
  }
}
