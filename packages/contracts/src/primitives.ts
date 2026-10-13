import { z } from "zod";

/** Opaque identifiers. The prefix is a readability aid only; never parse meaning from an ID. */
export const UserId = z.string().min(1).max(64).describe("Opaque internal user ID (never an email).");
export const GarmentId = z.string().min(1).max(64);
export const CommandId = z.string().min(1).max(64);
export const EntityId = z.string().min(1).max(128);

function isRealLocalDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isRealInstant(value: string): boolean {
  const ms = Date.parse(value);
  // The pattern admits 2026-13-45T99:99:99Z and engines roll 02-30 over to March: require an exact round trip.
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19);
}

function isRealTimezone(value: string): boolean {
  // The runtime also accepts a bare UTC offset ("+05:00") as a time zone; that is not a zone name and has
  // no daylight-saving rule, so the owner's days would be counted at a fixed offset all year.
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Civil date in the owner's (or the event's) timezone: YYYY-MM-DD. */
export const LocalDate = z
  .string()
  .regex(LOCAL_DATE_PATTERN, "expected YYYY-MM-DD")
  // A value of the wrong shape is reported once, by the pattern; the calendar check is for well-formed values.
  .refine((v) => !LOCAL_DATE_PATTERN.test(v) || isRealLocalDate(v), "not a real calendar date")
  .describe("Civil local date, YYYY-MM-DD.");
/** UTC instant, ISO 8601 with Z. */
export const Instant = z
  .string()
  .regex(INSTANT_PATTERN, "expected UTC ISO 8601 instant")
  .refine((v) => !INSTANT_PATTERN.test(v) || isRealInstant(v), "not a real date and time")
  .describe("UTC instant, ISO 8601 (e.g. 2026-09-15T06:50:00Z).");
export const IanaTimezone = z.string().min(1).max(64).refine(isRealTimezone, "not a known IANA timezone").describe("IANA timezone, e.g. Europe/London.");

/** Where a request entered the system. A channel is metadata on a turn/command, never a separate ledger. */
export const Channel = z.enum(["ios", "web", "mcp", "conversation", "scheduled", "import", "system", "test"]);
export type Channel = z.infer<typeof Channel>;

/** Who is acting. Only `owner` statements can establish physical facts or lift evidence-gated restrictions. */
export const Actor = z.enum(["owner", "assistant", "system"]);
export type Actor = z.infer<typeof Actor>;

/**
 * Why a mutation is authorized (specification sections 3 and 8: intent is encoded in
 * request policy, not inferred from conversational tone).
 */
export const AuthorizationBasis = z.enum([
  "owner_tap", // a deterministic native/web control
  "owner_statement", // an explicit owner statement resolved by the assistant or an MCP client
  "standing_policy", // an owner-authorized standing policy (e.g. the weekly laundry reset)
  "system_schedule", // scheduled work under the durable job's verified owner
  "data_import", // the isolated importer
]);
export type AuthorizationBasis = z.infer<typeof AuthorizationBasis>;

export const Scope = z.enum(["read", "write", "admin"]);
export type Scope = z.infer<typeof Scope>;

/** Basis of a recorded quantity movement or fact: observed physical fact versus inference. */
export const Basis = z.enum(["observed", "inferred", "import", "reconciliation"]);
export type Basis = z.infer<typeof Basis>;

export const EntityVersion = z.object({
  kind: z.string(),
  id: EntityId,
  version: z.number().int().nonnegative(),
});
export type EntityVersion = z.infer<typeof EntityVersion>;

/** Reference to a passage in a preserved source document. */
export const PassageRef = z.object({
  documentSha256: z.string().length(64),
  section: z.string().optional(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  quote: z.string().min(1).describe("Exact quoted text; must occur verbatim in the document."),
});
export type PassageRef = z.infer<typeof PassageRef>;

export const SourceRef = z.object({
  kind: z.enum([
    "owner_statement",
    "receipt",
    "maker_specification",
    "photograph",
    "body_measurement",
    "research_page",
    "import",
    "model_inference",
    "profile_passage",
    "system",
  ]),
  ref: z.string().optional().describe("Stable reference: message ID, import row key, URL, passage locator..."),
  observedAt: Instant.optional(),
  note: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;
