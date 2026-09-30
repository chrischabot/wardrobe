/**
 * Pasted-secret redaction for conversation text (ADV-17; spec sections 15 and 16).
 *
 * The collect page tells the owner never to paste his recovery code into a chat, but people do. Text
 * the owner sends is redacted here before the turn is stored (turn ledger, Think Session), projected
 * to recall, indexed, sent to a model or exported, so a working credential never becomes part of the
 * conversation record. The export applies the same redaction to rows written before this existed.
 *
 * Rules are narrow on purpose: garment names, maker codes (D-43, 990v6), sizes (40x32, UK 8.5), product
 * links and Garderobe's own lowercase-hex ids are never touched.
 */

export type SecretKind = 'recovery_code' | 'garderobe_link' | 'access_token' | 'api_key';

export interface Redaction {
  kind: SecretKind;
  count: number;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
}

export const REMOVED: Record<SecretKind, string> = {
  recovery_code: '[recovery code removed]',
  garderobe_link: '[removed]',
  access_token: '[secret removed]',
  api_key: '[secret removed]',
};

interface Rule {
  kind: SecretKind;
  pattern: RegExp;
  /** Replacement; `$1` keeps a non-secret prefix (e.g. the link path before `t=`). */
  replace: string;
  /** Applied only outside URLs, and not to export rows (the generic high-entropy rule). */
  outsideUrlsOnly?: boolean;
}

const RULES: Rule[] = [
  // GRDB.rcv_<id>.<secret> as issued, tolerating spaces, colons, dashes or lower case from retyping.
  { kind: 'recovery_code', pattern: /\bGRDB[\s.:_-]*rcv_[0-9a-f]{6,}[\s.:_-]*[A-Za-z0-9]{12,}/gi, replace: REMOVED.recovery_code },
  { kind: 'recovery_code', pattern: /\brcv_[0-9a-f]{16}[\s.:_-]+[A-Za-z0-9]{12,}/gi, replace: REMOVED.recovery_code },
  // The secret part alone: exactly 32 characters of the recovery alphabet (no I, O, 0 or 1).
  { kind: 'recovery_code', pattern: /(?<![A-Za-z0-9+/=_.-])[A-HJ-NP-Z2-9]{32}(?![A-Za-z0-9+/=_-])/g, replace: REMOVED.recovery_code },
  // One-time export download and recovery collection links: keep the path, drop the signed token.
  { kind: 'garderobe_link', pattern: /(\/v1\/(?:export\/downloads|auth\/recovery-kit\/collect)\/[A-Za-z0-9_-]+\?(?:[^\s#]*?&)?t=)[^&#\s"'<>)\]]+/g, replace: `$1${REMOVED.garderobe_link}` },
  // Bearer headers and OAuth parameters.
  { kind: 'access_token', pattern: /\bBearer\s+(?=[A-Za-z0-9._~+/=:-]*\d)[A-Za-z0-9._~+/=:-]{20,}/g, replace: `Bearer ${REMOVED.access_token}` },
  { kind: 'access_token', pattern: /([?&#](?:access_token|refresh_token|id_token|client_secret|api[_-]?key|apikey|password)=)[^&#\s"'<>]+/gi, replace: `$1${REMOVED.access_token}` },
  { kind: 'access_token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, replace: REMOVED.access_token },
  // Provider key formats (the connector redactor's list).
  { kind: 'api_key', pattern: /\b(?:tvly-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|ya29\.[A-Za-z0-9._-]{10,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,})/g, replace: REMOVED.api_key },
  // Garderobe app/session tokens and similar: 32+ random base64url characters mixing upper case,
  // lower case and digits, outside links (product and tracking URLs stay intact).
  {
    kind: 'access_token',
    pattern: /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
    replace: REMOVED.access_token,
    outsideUrlsOnly: true,
  },
];

const URL_SPAN = /\bhttps?:\/\/[^\s<>"']+/gi;

function applyRule(text: string, rule: Rule, counts: Map<SecretKind, number>): string {
  const bump = () => counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
  const run = (segment: string) =>
    segment.replace(rule.pattern, (...args: unknown[]) => {
      bump();
      const prefix = typeof args[1] === 'string' && rule.replace.startsWith('$1') ? args[1] : '';
      return rule.replace.startsWith('$1') ? `${prefix}${rule.replace.slice(2)}` : rule.replace;
    });
  if (!rule.outsideUrlsOnly) return run(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(URL_SPAN)) {
    out += run(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + run(text.slice(last));
}

/** Redacts pasted credentials from conversation text and reports what was removed. */
export function redactPastedSecrets(text: string, opts: { highEntropy?: boolean } = {}): RedactionResult {
  const counts = new Map<SecretKind, number>();
  let out = text;
  for (const rule of RULES) if (opts.highEntropy !== false || !rule.outsideUrlsOnly) out = applyRule(out, rule, counts);
  return { text: out, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}

/**
 * Text only (recall projection, stored replies). The export passes `highEntropy: false`: stored rows
 * carry opaque ids and keys that other rows reference, so only the specific credential formats apply.
 */
export function withoutPastedSecrets(text: string, opts: { highEntropy?: boolean } = {}): string {
  return redactPastedSecrets(text, opts).text;
}

/** The short, settled note the owner sees after a turn that carried a secret. */
export function redactionNotice(redactions: readonly Redaction[]): { title: string; summary: string } {
  const recovery = redactions.some((r) => r.kind === 'recovery_code');
  return {
    title: recovery ? 'Recovery code removed from your message' : 'Secret removed from your message',
    summary: recovery
      ? 'Garderobe removed a recovery code from your message before saving it; it was not stored, sent to the assistant or included in exports. If it is your current code, create a new one in Garderobe, since pasted codes should be treated as exposed.'
      : 'Garderobe removed something that looked like a password, token or key from your message before saving it; it was not stored, sent to the assistant or included in exports.',
  };
}
