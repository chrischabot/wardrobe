/**
 * Secret redaction for errors, traces, diagnostics and anything a model or client could see
 * (spec sections 13 and 15). Key-bearing URLs are resolved privately at dispatch time only.
 */

const SECRET_PARAMS = /([?&](?:api[_-]?key|apikey|key|token|access_token|refresh_token|id_token|secret|client_secret|password|pwd|sig|signature|auth|authorization|tavilyApiKey|exaApiKey|x-api-key|code)=)[^&#\s"']+/gi;
const PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\btvly-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bya29\.[A-Za-z0-9._-]{10,}/g,
  /\b1\/\/[A-Za-z0-9._-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text.replace(SECRET_PARAMS, '$1[redacted]');
  for (const p of PATTERNS) out = out.replace(p, '[redacted]');
  for (const s of knownSecrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  return out;
}

/** A URL safe to show in settings, logs or model context. */
export function credentialFreeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret|sig|auth|password|code/i.test(k)) u.searchParams.set(k, '[redacted]');
    return u.toString();
  } catch {
    return redactSecrets(raw);
  }
}

export function redactDeep<T>(value: T, knownSecrets: readonly string[] = []): T {
  if (typeof value === 'string') return redactSecrets(value, knownSecrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, knownSecrets)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = /^(authorization|api[_-]?key|token|secret|password|refresh_token|access_token|cookie|set-cookie)$/i.test(k) ? '[redacted]' : redactDeep(v, knownSecrets);
    return out as T;
  }
  return value;
}
