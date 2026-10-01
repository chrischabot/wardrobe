/**
 * Secret hygiene: credentials pasted into the conversation are removed BEFORE anything is stored
 * (transcript, turn ledger, retrieval index, memory, export) or shown to a model.
 * Detection is deliberately conservative pattern matching; it errs towards removing.
 */

export const SECRET_PLACEHOLDER = "[secret removed]";

interface Pattern {
  name: string;
  re: RegExp;
  /** Index of the capture group holding the secret; the whole match when omitted. */
  group?: number;
}

const PATTERNS: Pattern[] = [
  { name: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: "bearer_token", re: /\b(Bearer)\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 2 },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "provider_key", re: /\b(?:sk|pk|rk)-(?:live-|test-|proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: "tavily_key", re: /\btvly-[A-Za-z0-9_-]{12,}\b/g },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google_api_key", re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { name: "google_oauth", re: /\bya29\.[A-Za-z0-9._-]{20,}\b/g },
  // "password: hunter2", "api key = abc", "token is abc123" - the value after an explicit credential label.
  {
    name: "labelled_credential",
    re: /\b(pass(?:word|code|phrase)?|pwd|secret|api[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|client[ _-]?secret|recovery[ _-]?(?:code|key)|token)\b(\s*(?:is|=|:)\s*)(["']?)([^\s"',;]{4,})\3/gi,
    group: 4,
  },
  // Key-bearing URL parameters.
  { name: "url_credential", re: /([?&](?:api[_-]?key|apikey|key|token|access_token|auth|secret|signature|tavilyApiKey|exaApiKey)=)([^&\s#]+)/gi, group: 2 },
  { name: "url_userinfo", re: /(\bhttps?:\/\/)([^\s/:@]+:[^\s/@]+)@/gi, group: 2 },
  // Long opaque tokens (hex or base64-like) that are not ordinary words. The application's own record
  // identifiers (prefix_hex, for example msg_trn_<hex>) are not secrets and are left intact.
  { name: "opaque_token", re: /\b(?![a-z]{2,5}_(?:[a-z]{2,5}_)?[0-9a-f]{20,40}\b)(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g },
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export interface RedactionResult {
  text: string;
  /** Kinds of secret removed (names only; never the values). */
  removed: string[];
}

export function redactSecrets(input: string): RedactionResult {
  let text = input;
  const removed: string[] = [];
  for (const p of PATTERNS) {
    text = text.replace(p.re, (...args: unknown[]) => {
      const match = args[0] as string;
      removed.push(p.name);
      if (p.group === undefined) return SECRET_PLACEHOLDER;
      const secret = args[p.group] as string;
      const at = match.lastIndexOf(secret);
      return match.slice(0, at) + SECRET_PLACEHOLDER + match.slice(at + secret.length);
    });
  }
  // Payment card numbers (13-19 digits, Luhn-valid), with spaces or dashes.
  text = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      removed.push("payment_card");
      return SECRET_PLACEHOLDER;
    }
    return match;
  });
  return { text, removed: [...new Set(removed)] };
}

/** Redact every string in a JSON-like value (tool results, attachments). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value).text as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
