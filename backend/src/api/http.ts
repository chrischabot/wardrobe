import { CONTRACTS_VERSION } from '@garderobe/contracts';
import { z } from 'zod';
import { DomainError } from '../domain/errors.js';

/** JSON response helpers and error mapping for the HTTP API. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...headers } });
}

export function apiError(status: number, code: string, message: string, details?: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return json({ schemaVersion: CONTRACTS_VERSION, error: { code, message, ...(details ? { details } : {}) } }, status, headers);
}

const DOMAIN_STATUS: Record<string, number> = {
  unauthenticated: 401,
  insufficient_scope: 403,
  forbidden_owner_field: 400,
  validation_failed: 422,
  not_found: 404,
  idempotency_key_reused: 409,
  conflict: 409,
  invalid_state: 409,
  never_laundered: 422,
  not_reversible: 409,
  already_undone: 409,
  rule_admits_no_exception: 422,
  evidence_required: 422,
  user_disabled: 403,
};

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return apiError(err.status, err.code, err.message, err.details, err.headers);
  if (err instanceof Error && err.name === 'UrlPolicyError') return apiError(422, 'url_not_allowed', err.message);
  if (err instanceof DomainError) return apiError(DOMAIN_STATUS[err.code] ?? 400, err.code, err.message, err.details);
  if (err instanceof z.ZodError) {
    return apiError(422, 'validation_failed', err.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '), { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  console.error('unhandled API error', err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err));
  return apiError(500, 'internal_error', 'Something went wrong on the server; nothing was changed by this response.');
}

const MAX_BODY = 1_000_000;

export async function readJson(request: Request, maxBytes = MAX_BODY): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Send application/json');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

export async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Send application/x-www-form-urlencoded');
  const text = new TextDecoder().decode(await request.arrayBuffer());
  if (text.length > 20_000) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  return new URLSearchParams(text);
}

export function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('content-security-policy', "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(body, { status, headers: h });
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
