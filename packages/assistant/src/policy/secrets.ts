/**
 * Secret hygiene: credentials pasted into the conversation are removed BEFORE anything is stored
 * (transcript, turn ledger, retrieval index, memory, export) or shown to a model.
 * Detection is pattern matching: it recognises the common ways a credential is written and it is
 * PARTIAL by nature (an unlabelled secret, or one described in a way no pattern covers, is not found).
 * The assistant's policy therefore also tells the owner never to paste secrets, and the owner can forget
 * any message.
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
  // A passphrase is several words: everything after its label to the end of the line goes.
  { name: "labelled_passphrase", re: /\b(pass ?phrase)\b(\s*(?:is|=|:)\s*)([^\n]{4,200}?)(?=[.!?]?\s*(?:\n|$))/gim, group: 3 },
  // A password of several capitalised words or numbers ("password is Tulip Garden 99").
  { name: "labelled_passphrase", re: /\b([Pp]ass(?:word|code)|PASSWORD|[Pp]wd)\b(\s*(?:is|=|:)\s*)((?:[A-Z0-9][^\s"',;.]*\s){1,4}[A-Z0-9][^\s"',;.]*)/g, group: 3 },
  { name: "bearer_token", re: /\b(Bearer)\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 2 },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "provider_key", re: /\b(?:sk|pk|rk)-(?:live-|test-|proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: "tavily_key", re: /\btvly-[A-Za-z0-9_-]{12,}\b/g },
  { name: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google_api_key", re: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { name: "google_oauth", re: /\bya29\.[A-Za-z0-9._-]{20,}\b/g },
  // Forms the adversarial suite found unredacted (D12-1): Stripe keys written with underscores, an AWS
  // secret access key after its name, npm, GitLab and Hugging Face tokens, and a Telegram bot token.
  { name: "provider_key", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { name: "aws_secret_key", re: /\b(aws_secret_access_key|secret_access_key)\b(\s*[=:]\s*)(["']?)([A-Za-z0-9/+=]{20,})\3/gi, group: 4 },
  { name: "npm_token", re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { name: "huggingface_token", re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: "telegram_bot_token", re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g },
  // "password: hunter2", "api key = abc", "token is abc123" - the value after an explicit credential label.
  {
    name: "labelled_credential",
    re: /\b(pass(?:word|code|phrase)|pwd|api[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|client[ _-]?secret|recovery[ _-]?(?:code|key))\b(\s*(?:is|=|:)\s*)(["']?)([^\s"',;]{4,})\3/gi,
    group: 4,
  },
  // "pass", "secret" and "token" are ordinary words too ("the secret is good shoes"): their value counts only when it looks like one (it has a digit, or is long).
  { name: "labelled_credential", re: /\b(pass|secret|token)\b(\s*(?:is|=|:)\s*)(["']?)((?=[^\s"',;]*\d)[^\s"',;]{4,}|[^\s"',;]{12,})\3/gi, group: 4 },
  // The same label followed directly by the value ("password hunter2secret") or after "is:" ("my password is: x").
  {
    name: "labelled_credential",
    re: /\b(pass(?:word|code|phrase)|pwd|api[ _-]?key|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|client[ _-]?secret|recovery[ _-]?(?:code|key))\b(\s*(?:is\s*[:=]|[:=]\s*is|is|[:=])?\s*)(["']?)((?=[^\s"',;]*\d)[^\s"',;]{6,}|[^\s"',;]{10,})\3/gi,
    group: 4,
  },
  // Short labels and other languages: "pw: x", "passwd x", "p/w x", "Passwort: x", "mot de passe: x", "contraseña: x".
  { name: "labelled_credential", re: /(?<![A-Za-z])(passwort|passwd|kennwort|mot de passe|contrase\u00f1a|wachtwoord|pwd|pw|p\/w)(?![A-Za-z])(\s*(?:is\s*[:=]?|[:=])?\s*)(["']?)([^\s"',;]{4,})\3/gi, group: 4 },
  // The password that follows a dash or "it's" after naming an account: "the password to my X account - it's Y".
  { name: "labelled_credential", re: /\b(pass(?:word|code|phrase))\b([^.\n]{0,60}?(?:\u2014|\u2013|-|:)\s*(?:it'?s|it is)\s+)([^\s"',;.]{4,})/gi, group: 3 },
  // PINs, door and verification codes: a number given with its label.
  { name: "pin_or_code", re: /\b(pin|pin code|pin number|passcode|door code|alarm code|gate code|entry code|locker code|safe code|security code|verification code|2fa code|otp|one[- ]time (?:code|password)|auth(?:entication)? code|cvv|cvc|cv2)\b([^\d\n]{0,24}?)(\d{3,10})\b/gi, group: 3 },
  // Answers to security questions.
  { name: "security_answer", re: /\b((?:secret|security) (?:answer|question)[^:\n]{0,40}?(?:\bis\b|:)\s*)([^\n.;]{2,80})/gi, group: 2 },
  // Bank and government identifiers.
  { name: "bank_sort_code", re: /\b(sort code)([^\d\n]{0,12})(\d{2}[- ]?\d{2}[- ]?\d{2})\b/gi, group: 3 },
  { name: "bank_account", re: /\b(account (?:number|no\.?)|acct\.? (?:number|no\.?)|routing number)([^\d\n]{0,12})(\d{6,17})\b/gi, group: 3 },
  { name: "iban", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  { name: "national_insurance", re: /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g },
  { name: "national_insurance", re: /\b((?:ni|nino|national insurance)(?: number| no\.?)?[^A-Za-z0-9\n]{0,6}(?:is\s+)?)([A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-Z])\b/gi, group: 2 },
  // Recovery or seed words.
  { name: "recovery_words", re: /\b((?:recovery|seed|backup|mnemonic) (?:words|phrase|key)s?[^:\n]{0,20}?(?:\bare\b|\bis\b|:)\s*)((?:[a-z]+[ ,]+){3,23}[a-z]+)/gi, group: 2 },
  // Credentials in structured or command form.
  { name: "json_credential", re: /(["'](?:pass(?:word|code|phrase)?|pwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret|pin)["']\s*:\s*["'])([^"']{1,200})(?=["'])/gi, group: 2 },
  { name: "basic_auth", re: /\b(Basic)\s+([A-Za-z0-9+/=]{8,})/g, group: 2 },
  { name: "url_userinfo", re: /(\b[a-z][a-z0-9+.-]{1,15}:\/\/)([^\s/:@]+:[^\s/@]+)@/gi, group: 2 },
  { name: "url_userinfo", re: /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@]+:)([^\s/@]+)@/gi, group: 2 },
  { name: "ssh_password", re: /\b(ssh\s+\S+@\S+\s+(?:with|using|pw|password)\s+)(\S{4,})/gi, group: 2 },
  { name: "cloudflare_token", re: /\bv1\.0-[A-Za-z0-9_-]{16,}\b/g },
  { name: "login_pair", re: /\b((?:creds|credentials|log[- ]?in|login details)\s+(?:are|is|:)\s*)([^\s:/|,;]{2,}\s*[:/|]\s*[^\s,;]{4,})/gi, group: 2 },
  { name: "login_pair", re: /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\s*[/|:]\s*)((?=\S*\d)\S{6,})/g, group: 2 },
  // "login / password" pairs: "name / secret", "user: x pass: y", "x:y" after the word login or credentials.
  { name: "login_pair", re: /\b(log[- ]?in|credentials?|username)\b(\s*(?:is|=|:)?\s*)([^\s/|,;]{2,})(\s*[/|]\s*)([^\s/|,;]{4,})/gi, group: 5 },
  { name: "login_pair", re: /\b(user)\b(\s*(?:is|=|:)?\s*)([^\s/|,;]{2,})(\s*[/|]\s*)((?=[^\s/|,;]*\d)[^\s/|,;]{4,})/gi, group: 5 },
  // A UUID-format or 32+ hexadecimal key near the word key, token or secret.
  { name: "labelled_key", re: /\b(key|token|secret)\b([^\n]{0,24}?)\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,})\b/gi, group: 3 },
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
      // Never redact a redaction (a later pattern meeting the placeholder an earlier one left).
      if (secret.includes("[secret") || secret.includes("removed]")) return match;
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
