/**
 * Guards applied to arbitrary tool arguments before they reach a public
 * search or extraction service. Re-exported from extract.ts.
 */

export type ToolArgs = Record<string, unknown>;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Normalized names of options that ask a provider to generate an answer or summary. */
export const GENERATED_ANSWER_OPTION_KEYS: readonly string[] = [
  "includeanswer",
  "answer",
  "answermode",
  "generateanswer",
  "summarize",
  "summarization",
  "summary",
  "includesummary",
];

function stripValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripValue);
  if (!isPlainObject(value)) return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (GENERATED_ANSWER_OPTION_KEYS.includes(normalizeKey(key))) continue;
    cleaned[key] = stripValue(inner);
  }
  return cleaned;
}

/**
 * Returns a copy of the arguments without generated-answer or summarization
 * options (include_answer, includeAnswer, answer, summarize, summary, ...),
 * at any nesting depth. Provider-side inference is not routed through
 * Garderobe's AI Gateway, so these options are never sent.
 */
export function stripGeneratedAnswerOptions(args: ToolArgs): ToolArgs {
  const cleaned: ToolArgs = {};
  for (const [key, inner] of Object.entries(args)) {
    if (GENERATED_ANSWER_OPTION_KEYS.includes(normalizeKey(key))) continue;
    cleaned[key] = stripValue(inner);
  }
  return cleaned;
}

export class PrivateForwardingError extends Error {
  readonly code = "private_forwarding_refused" as const;
  /** Dotted paths of the offending arguments. Values are never included. */
  readonly paths: string[];

  constructor(paths: string[]) {
    super(`Private data must not be forwarded to a public extraction service: ${paths.join(", ")}`);
    this.name = "PrivateForwardingError";
    this.paths = paths;
  }
}

const PRIVATE_KEYS = new Set([
  "cookie",
  "cookies",
  "setcookie",
  "cookiejar",
  "authorization",
  "proxyauthorization",
  "auth",
  "password",
  "session",
  "sessionid",
  "emailbody",
  "emailcontent",
  "emailcontents",
  "emailhtml",
  "emailtext",
  "mailbody",
  "messagebody",
]);

function isPrivateKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return PRIVATE_KEYS.has(normalized) || normalized.endsWith("token");
}

function carriesValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

const CREDENTIAL_VALUE = /^\s*(bearer|basic)\s+\S+/i;

function collectPrivatePaths(value: unknown, path: string, found: string[]): void {
  if (typeof value === "string") {
    if (CREDENTIAL_VALUE.test(value)) found.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((inner, index) => collectPrivatePaths(inner, `${path}[${index}]`, found));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, inner] of Object.entries(value)) {
    const innerPath = path === "" ? key : `${path}.${key}`;
    if (isPrivateKey(key) && carriesValue(inner)) {
      found.push(innerPath);
      continue;
    }
    collectPrivatePaths(inner, innerPath, found);
  }
}

/**
 * Throws PrivateForwardingError when the arguments carry cookies,
 * authorization headers, tokens, passwords or an email body. Private cookies,
 * account tokens and email contents stay inside the owner's connection
 * boundary and are never sent to a public extraction service.
 */
export function assertNoPrivateForwarding(args: ToolArgs): void {
  const found: string[] = [];
  collectPrivatePaths(args, "", found);
  if (found.length > 0) throw new PrivateForwardingError(found);
}
