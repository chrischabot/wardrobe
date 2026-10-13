/**
 * Evidence and error redaction for the Ferrite tooling. Ported from the Cloudflare tooling's `redactEvidence`
 * (deploy/verify.mjs) and extended with what its reviews asked for:
 *
 * - every known secret value is replaced wherever it appears, whatever its length (longest first, so a secret
 *   that contains another is removed whole);
 * - credential NAMES are recognised by one pattern, used both for object keys and inside strings, whatever their
 *   case or separator (`Authorization`, `X-Auth-Key`, `client-secret`, `PASSPHRASE`, `clientPassphrase`,
 *   `WARDROBE_OWNER_TOKEN`), with a quoted value (double or single quotes, JSON inside a string) replaced up to its
 *   closing quote and an unquoted value up to whitespace or punctuation;
 * - a credential header's value is replaced to the end of its line, whatever it holds;
 * - URL credentials (`scheme://user:password@host`) are replaced wherever a URL appears;
 * - bearer tokens, JWTs and long token-like runs are replaced (a 64-hex digest is kept only under a digest key);
 * - text is shortened only AFTER redaction, so a cut can never split a secret out of its match.
 */

// Separators between the words of a credential name: any of `_`, `-` or `.` (or none).
const SEP = "[_.-]?";
const NAME_SUFFIX = String.raw`(?:token|secret|password|passphrase|passwd|api${SEP}key|private${SEP}key|auth${SEP}key|access${SEP}key|credentials?)`;
const CODE_NAME = String.raw`(?:invitation|auth|authorization|recovery|otp|verification|device|user|one${SEP}time)${SEP}code`;
const HEADER_NAME = String.raw`(?:proxy${SEP}authorization|authorization|set${SEP}cookie|cookie|x${SEP}api${SEP}key|x${SEP}auth${SEP}key|x${SEP}auth${SEP}token|x${SEP}auth${SEP}email)`;
/** One credential-name pattern for keys and strings alike. */
export const CREDENTIAL_NAME = String.raw`(?:${HEADER_NAME}|${CODE_NAME}|[a-z0-9_.-]*${NAME_SUFFIX})`;
const KEY = new RegExp(`^${CREDENTIAL_NAME}$`, "i");
const QUOTED = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
// A quoted value that may be cut off before its closing quote (a truncated diagnostic): redacted to the end.
const QUOTED_OR_OPEN = String.raw`(?:"(?:[^"\\]|\\.)*(?:"|\\?$)|'(?:[^'\\]|\\.)*(?:'|\\?$))`;
// Every rule below names the part it redacts as the group `v`; `d` gives its indices (see scrub).
// The rules built on CREDENTIAL_NAME (whose prefix `[a-z0-9_.-]*` is unbounded) may only start where a run of name
// characters starts: their boundary excludes every name character, the dot included, so each run is scanned from one
// position only and the scan stays linear (a boundary that admitted `.` re-scanned a long dot run from every dot).
const HEADER_LINE = new RegExp(String.raw`(^|[^A-Za-z0-9_-])(${HEADER_NAME})(\s*:\s*)(?<v>[^\r\n]*)`, "gid");
const NAMED_QUOTED = new RegExp(String.raw`(^|[^A-Za-z0-9_.-])(${CREDENTIAL_NAME})(["']?\s*[:=]\s*)(?<v>${QUOTED_OR_OPEN})`, "gid");
// JSON inside a string, at any escaping depth: `{\"password\":\"v\"}` or `{\\\"password\\\":\\\"v\\\"}`. The value
// opens with N backslashes and a quote and closes only at a quote preceded by EXACTLY N backslashes; a quote escaped
// inside the value carries more (2N+1), so it does not close it. A value that never closes is redacted to the end.
const NAMED_ESCAPED = new RegExp(String.raw`(^|[^A-Za-z0-9_.-])(${CREDENTIAL_NAME})(\\+["']\s*[:=]\s*)(?<v>(\\+)["'](?:(?!(?<!\\)\5["'])[\s\S])*(?:(?<!\\)\5["']|$))`, "gid");
// An unquoted value: anything up to whitespace or punctuation, backslashes included (`password=\hunter2`); only an
// escaped quote (`\"`) is left to NAMED_ESCAPED.
const NAMED_UNQUOTED = new RegExp(String.raw`(^|[^A-Za-z0-9_.-])(${CREDENTIAL_NAME})(\\*["']?\s*[:=]\s*)(?!\\*["'])(?<v>[^\s"',;&)}\]]+)`, "gid");
const BEARER = /\b(Bearer|Basic)\s+(?<v>[^\s"',;]+)/gid;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// Any three dot-separated base64url segments: a JWT whatever its header's spelling. It is redacted when its first
// segment decodes to a JSON object (a JWT header), so host names and version numbers are left alone.
const JWS_LIKE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]*)(?![A-Za-z0-9_.-])/g;
function looksLikeJwtHeader(segment) {
  try {
    return /^\s*\{/.test(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return false;
  }
}
const LONG_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const DIGEST_KEY = /^(sha256|digest)$|(Sha256|Digest)$/;
const HEX64 = /^[0-9a-f]{64}$/;
// (URL credentials: see markUrlCredentials below.)
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const LETTER = /[A-Za-z]/;
/**
 * Credentials carried in anything a URL parser might read as a URL, found structurally rather than by one URL
 * spelling. The scan runs on a view of the text without ASCII tab, LF and CR (the parser removes them anywhere, even
 * inside the scheme), with every position mapped back to the original. Every `:` that ends a valid scheme starts a
 * candidate: a scheme is a letter followed by scheme characters, so a `:` qualifies when the run of scheme characters
 * before it contains a letter (any suffix starting at that letter is a scheme, so `1https:`, `x.https:` and
 * `a-b+https:` all count, glued to whatever precedes them). After it, whatever slashes, backslashes and spaces follow
 * are skipped (a parser accepts `https:u:p@h`, `https:/u:p@h`, `https:///u:p@h`, `https:\\u:p@h`), then everything
 * up to the LAST `@` before `/`, `?` or `#` is marked. A backslash never ends the authority here: special schemes read
 * it as `/`, others as part of userinfo, and taking the longer reading only ever redacts more. Spaces, quotes and a
 * second `@` inside a password are therefore covered. Over-redaction (an `@` in prose after a `word:`) is accepted.
 * Everything is precomputed in single passes, so the scan is linear however many `word:` occurrences the text holds.
 */
function markUrlCredentials(text, mark) {
  const map = [];
  let view = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\t" || text[i] === "\n" || text[i] === "\r") continue;
    map.push(i);
    view += text[i];
  }
  const n = view.length;
  const end = new Int32Array(n + 1);
  end[n] = n;
  for (let k = n - 1; k >= 0; k--) {
    const c = view[k];
    end[k] = c === "/" || c === "?" || c === "#" ? k : end[k + 1];
  }
  const lastAt = new Int32Array(n + 1);
  lastAt[0] = -1;
  for (let k = 0; k < n; k++) lastAt[k + 1] = view[k] === "@" ? k : lastAt[k];
  // Letter-bearing runs before a ':' found so far; overlapping candidates (many `word:` before one distant `@`) are
  // merged before marking, so every character is marked at most once and the whole scan stays linear.
  let spanFrom = -1;
  let spanTo = -1;
  const flush = () => {
    if (spanFrom >= 0) mark(map[spanFrom], map[spanTo - 1] + 1);
  };
  // Whether the current run of scheme characters holds a letter yet.
  let letterInRun = false;
  for (let c = 0; c < n; c++) {
    const ch = view[c];
    if (ch !== ":") {
      letterInRun = SCHEME_CHAR.test(ch) ? letterInRun || LETTER.test(ch) : false;
      continue;
    }
    const valid = letterInRun;
    letterInRun = false;
    if (!valid) continue;
    const start = c + 1;
    let i = start;
    while (i < n && (view[i] === "/" || view[i] === "\\" || view[i] === " ")) i++;
    // The last `@` before the authority ends (at index < end[i]), if it is at or after i.
    const at = lastAt[end[i]];
    if (at >= i && at > start) {
      if (spanFrom >= 0 && start <= spanTo) spanTo = Math.max(spanTo, at);
      else {
        flush();
        spanFrom = start;
        spanTo = at;
      }
    }
  }
  flush();
}
const VALUE_RULES = [HEADER_LINE, NAMED_ESCAPED, NAMED_QUOTED, NAMED_UNQUOTED, BEARER];

export const MAX_STRING = 600;

/** Whether an object key names a credential. */
export function isCredentialKey(key) {
  return typeof key === "string" && KEY.test(key);
}

function knownValues(known) {
  return [...new Set((known ?? []).filter((s) => typeof s === "string" && s.length > 0))].sort((a, b) => b.length - a.length);
}

/**
 * Redaction works on the ORIGINAL text: every known-secret occurrence and every part a rule recognises (the `v` group
 * of a value rule, or a whole JWT or long token-like run) is marked, and each maximal marked run is then replaced by
 * one `[redacted]`. No rule ever sees another's output, so a short known secret can neither cut a credential value
 * short (leaving its tail) nor alter a credential name before it is recognised.
 */
function scrub(text, secrets, key) {
  const digestKey = key !== undefined && DIGEST_KEY.test(key);
  if (digestKey && HEX64.test(text) && !secrets.some((s) => text.includes(s))) return text;
  const mask = new Uint8Array(text.length);
  const mark = (from, to) => {
    if (to > from) mask.fill(1, from, to);
  };
  for (const s of secrets) {
    for (let i = text.indexOf(s); i !== -1; i = text.indexOf(s, i + 1)) mark(i, i + s.length);
  }
  for (const rule of VALUE_RULES) {
    for (const m of text.matchAll(rule)) {
      const span = m.indices?.groups?.v;
      if (span) mark(span[0], span[1]);
    }
  }
  markUrlCredentials(text, mark);
  for (const m of text.matchAll(JWT)) mark(m.index, m.index + m[0].length);
  for (const m of text.matchAll(JWS_LIKE)) if (looksLikeJwtHeader(m[1])) mark(m.index, m.index + m[0].length);
  for (const m of text.matchAll(LONG_RUN)) if (!(digestKey && HEX64.test(m[0]))) mark(m.index, m.index + m[0].length);
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (!mask[i]) {
      out += text[i++];
      continue;
    }
    while (i < text.length && mask[i]) i++;
    out += "[redacted]";
  }
  return out;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Redact one piece of text, then shorten it to `max` characters. */
export function redactText(text, known = [], max = MAX_STRING) {
  return clip(scrub(String(text ?? ""), knownValues(known), undefined), max);
}

/** Redact any JSON-like value: credential-named fields are replaced whole, every string is scrubbed, then shortened. */
export function redact(value, known = [], max = MAX_STRING) {
  const secrets = knownValues(known);
  const walk = (v, key) => {
    if (key !== undefined && isCredentialKey(key) && v !== null && v !== undefined && typeof v !== "boolean") return "[redacted]";
    if (typeof v === "string") return clip(scrub(v, secrets, key), max);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k, secrets, undefined), walk(x, k)]));
    return v;
  };
  return walk(value);
}

/** An error's message (or the value itself), redacted before anything shortens it. */
export function redactError(error, known = [], max = 400) {
  return redactText(error instanceof Error ? error.message : typeof error === "object" && error !== null && "message" in error ? error.message : error, known, max);
}
