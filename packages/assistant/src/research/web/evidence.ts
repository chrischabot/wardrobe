/**
 * Common evidence envelope returned by every extractor, plus the
 * deterministic rules that keep missing information from turning into
 * invented product facts.
 */
import { z } from "zod";

export const extractionMethodSchema = z.enum([
  "tavily_basic",
  "tavily_advanced",
  "browser_quick",
  "browser_interactive",
  "direct_fetch",
]);
export type ExtractionMethod = z.infer<typeof extractionMethodSchema>;

export const completenessSchema = z.enum(["complete", "partial", "failed"]);
export type Completeness = z.infer<typeof completenessSchema>;

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export const selectedVariantSchema = z.object({
  size: z.string().optional(),
  colour: z.string().optional(),
  country: z.string().optional(),
  currency: z.string().optional(),
});
export type SelectedVariant = z.infer<typeof selectedVariantSchema>;

export const evidenceEnvelopeSchema = z.object({
  canonicalUrl: z.string().min(1),
  finalUrl: z.string().min(1),
  retrievedAt: z
    .string()
    .refine((value) => UTC_ISO.test(value) && !Number.isNaN(Date.parse(value)), "retrievedAt must be a UTC ISO timestamp"),
  content: z.string(),
  imageCandidates: z.array(z.object({ url: z.string().min(1), alt: z.string().optional() })),
  /** Present only when a selection was actually observed on the page; otherwise null. */
  selectedVariant: selectedVariantSchema.nullable(),
  method: extractionMethodSchema,
  completeness: completenessSchema,
  sourceAnchors: z.array(z.object({ label: z.string(), quote: z.string() })),
  failures: z.array(z.object({ url: z.string(), reason: z.string() })),
  extractor: z.string().min(1),
  missingFields: z.array(z.string()),
});
export type EvidenceEnvelope = z.infer<typeof evidenceEnvelopeSchema>;

export interface ExpectedField {
  name: string;
  pattern: RegExp;
}

export interface ExtractionClassification {
  completeness: Completeness;
  missingFields: string[];
  reason: string;
}

/** Below this many non-whitespace-collapsed characters a response is treated as empty. */
export const MIN_MEANINGFUL_TEXT_CHARS = 120;
/** A challenge or cookie marker only fails a response this short; long pages may mention them in passing. */
export const CHALLENGE_PAGE_MAX_CHARS = 1500;

const CHALLENGE_MARKERS: { pattern: RegExp; reason: string }[] = [
  { pattern: /just a moment/i, reason: "bot challenge interstitial" },
  { pattern: /checking your browser/i, reason: "bot challenge interstitial" },
  { pattern: /captcha/i, reason: "captcha challenge" },
  { pattern: /verify (that )?you are (a )?human/i, reason: "human verification challenge" },
  { pattern: /enable javascript/i, reason: "page requires JavaScript rendering" },
  { pattern: /access denied/i, reason: "access denied by the site" },
  { pattern: /we use cookies|accept all cookies|cookie (settings|preferences|consent|policy)/i, reason: "cookie wall" },
];

function testPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(text);
  pattern.lastIndex = 0;
  return matched;
}

function isNavigationLine(line: string): boolean {
  const withoutLinks = line.replace(/!?\[[^\]]*\]\([^)]*\)/g, "").replace(/[-*|>#\s]/g, "");
  if (withoutLinks === "") return true;
  return line.split(/\s+/).filter((word) => word !== "").length <= 3;
}

/**
 * Classifies extracted content. A transport-level success is not evidence:
 * navigation-only text, cookie walls, bot challenges and near-empty bodies
 * are `failed`. Expected fields that do not appear are listed, never filled in.
 */
export function classifyExtraction(content: string, expectedFields: ExpectedField[]): ExtractionClassification {
  const text = content.replace(/\s+/g, " ").trim();
  const missingFields = expectedFields.filter((field) => !testPattern(field.pattern, content)).map((field) => field.name);
  const allNames = expectedFields.map((field) => field.name);
  const failed = (reason: string): ExtractionClassification => ({ completeness: "failed", missingFields: allNames, reason });

  if (text.length < MIN_MEANINGFUL_TEXT_CHARS) {
    const marker = CHALLENGE_MARKERS.find((candidate) => testPattern(candidate.pattern, text));
    return failed(marker ? marker.reason : "very little text was returned");
  }
  if (text.length <= CHALLENGE_PAGE_MAX_CHARS) {
    const marker = CHALLENGE_MARKERS.find((candidate) => testPattern(candidate.pattern, text));
    if (marker) return failed(marker.reason);
  }

  const foundAny = expectedFields.length > missingFields.length;
  if (!foundAny) {
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== "");
    const navigationLines = lines.filter(isNavigationLine).length;
    if (lines.length > 1 && navigationLines / lines.length >= 0.8) {
      return failed("content is navigation only");
    }
  }

  if (missingFields.length > 0) {
    return { completeness: "partial", missingFields, reason: `missing expected fields: ${missingFields.join(", ")}` };
  }
  return { completeness: "complete", missingFields: [], reason: "all expected fields were found" };
}

export type AvailabilityState = "available" | "unavailable" | "unknown";

export interface AvailabilityInput {
  /** The product page itself loaded as a live product page. */
  pageLive: boolean;
  /** Size actually observed as selected on the page, if any. */
  observedSize: string | null;
  /** Colour actually observed as selected on the page, if any. */
  observedColour: string | null;
  /** Stock signal for the selected variant: true in stock, false sold out, null not observed. */
  inStockSignal: boolean | null;
}

export interface AvailabilityResult {
  state: AvailabilityState;
  size: string | null;
  colour: string | null;
}

function observed(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A live product page without an observed size AND colour selection is
 * `unknown`, never `available`. A page that is not live is also `unknown`:
 * a blocked or missing page does not prove the variant is sold out.
 */
export function deriveAvailability(input: AvailabilityInput): AvailabilityResult {
  const size = observed(input.observedSize);
  const colour = observed(input.observedColour);
  if (!input.pageLive || size === null || colour === null || input.inStockSignal === null) {
    return { state: "unknown", size, colour };
  }
  return { state: input.inStockSignal ? "available" : "unavailable", size, colour };
}

/** True when the observation is older than `maxAgeHours`, or its timestamp cannot be read. */
export function isObservationStale(observedAtIso: string, nowMs: number, maxAgeHours: number): boolean {
  const observedAt = Date.parse(observedAtIso);
  if (Number.isNaN(observedAt)) return true;
  return nowMs - observedAt > maxAgeHours * 3_600_000;
}

/** True when the observation is older than `freshMinutes` and must be refreshed before a purchase step. */
export function requiresRefreshBeforePurchase(observedAtIso: string, nowMs: number, freshMinutes = 15): boolean {
  const observedAt = Date.parse(observedAtIso);
  if (Number.isNaN(observedAt)) return true;
  return nowMs - observedAt > freshMinutes * 60_000;
}

export interface VariantIdentity {
  productCode: string | null | undefined;
  colour: string | null | undefined;
  size: string | null | undefined;
}

function normalizeLabel(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeProductCode(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toUpperCase().replace(/[\s\-_./]/g, "");
}

/**
 * Strict equality on product code, colour and size after normalization
 * (case, whitespace, code separators). A similar colour is not a match, and
 * a missing value on either side is not a match.
 */
export function isExactVariantMatch(candidate: VariantIdentity, wanted: VariantIdentity): boolean {
  const pairs: [string, string][] = [
    [normalizeProductCode(candidate.productCode), normalizeProductCode(wanted.productCode)],
    [normalizeLabel(candidate.colour), normalizeLabel(wanted.colour)],
    [normalizeLabel(candidate.size), normalizeLabel(wanted.size)],
  ];
  return pairs.every(([left, right]) => left !== "" && left === right);
}
