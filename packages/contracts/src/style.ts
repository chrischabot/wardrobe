import { z } from "zod";
import { Instant, LocalDate, PassageRef, SourceRef } from "./primitives.ts";

/** The full personal profile, preserved verbatim with its content hash. Never summarised in place. */
export const StyleDocument = z.object({
  documentId: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  content: z.string().describe("Verbatim document text."),
  contentSha256: z.string().length(64),
  byteLength: z.number().int().nonnegative(),
  status: z.enum(["active", "superseded"]),
  createdAt: Instant,
});
export type StyleDocument = z.infer<typeof StyleDocument>;

/** A dated owner-confirmed correction layered on top of the profile prose. */
export const StyleAmendment = z.object({
  amendmentId: z.string(),
  documentId: z.string(),
  basedOnVersion: z.number().int().positive(),
  text: z.string().min(1),
  kind: z.enum(["restriction", "measurement", "size", "physical_state", "taste", "other"]),
  status: z.enum(["active", "incorporated", "retired"]),
  source: SourceRef,
  createdAt: Instant,
});
export type StyleAmendment = z.infer<typeof StyleAmendment>;

export const RuleKind = z.enum(["hard", "soft"]);
export const RuleStatus = z.enum([
  "active",
  "pending_reconciliation", // retained with its source, not enforced until reconciled (spec section 7)
  "dormant", // defined but not applicable yet (e.g. sneaker + welted pairing during the healing restriction)
  "retired",
]);

/**
 * A machine rule derived from the profile or an owner direction. It always references the
 * passage(s) it interprets and records that interpretation; the prose itself stays intact.
 */
export const StyleRule = z.object({
  ruleId: z.string(),
  version: z.number().int().positive(),
  key: z.string().describe("Stable machine key, e.g. 'socks.required'."),
  kind: RuleKind,
  status: RuleStatus,
  params: z.record(z.string(), z.unknown()),
  interpretation: z.string().describe("How the passage was interpreted into params; explicit about any judgement."),
  passages: z.array(PassageRef),
  origin: z.enum(["profile", "specification", "owner_direction", "owner_amendment"]),
  createdAt: Instant,
});
export type StyleRule = z.infer<typeof StyleRule>;

/** Standing direction such as "stop making navy the default swap": versioned, scoped, undoable. */
export const StandingDirection = z.object({
  directionId: z.string(),
  version: z.number().int().positive(),
  text: z.string().min(1),
  scope: z.string().nullable(),
  checkKey: z.string().nullable().describe("Machine rule key enforcing it, where one exists."),
  status: z.enum(["active", "retired"]),
  source: SourceRef,
  createdAt: Instant,
});
export type StandingDirection = z.infer<typeof StandingDirection>;

/** One-day brief ("make tomorrow more dramatic"); never rewrites standing rules. */
export const TemporaryBrief = z.object({
  briefId: z.string(),
  localDate: LocalDate,
  text: z.string().min(1),
  status: z.enum(["active", "retired"]),
  source: SourceRef,
  createdAt: Instant,
});
export type TemporaryBrief = z.infer<typeof TemporaryBrief>;

export const Measurement = z.object({
  measurementId: z.string(),
  subject: z.enum(["body", "garment"]),
  garmentId: z.string().nullable(),
  key: z.string().describe("e.g. chest, waist, neck, height, half_chest"),
  value: z.number(),
  unit: z.enum(["in", "cm", "m", "uk_shoe", "other"]),
  convention: z.string().nullable().describe("Measurement convention, e.g. 'body circumference' vs 'flat half-chest'."),
  qualifier: z.string().nullable().describe("Source wording that qualifies the value, e.g. 'a little over'."),
  measuredOn: LocalDate.nullable(),
  source: SourceRef,
  passage: PassageRef.nullable(),
  supersededBy: z.string().nullable(),
});
export type Measurement = z.infer<typeof Measurement>;

/** Maker- and product-specific size experience. Never a universal substitute for a chart. */
export const SizeExperience = z.object({
  sizeExperienceId: z.string(),
  maker: z.string(),
  productFamily: z.string().nullable(),
  sizeLabel: z.string(),
  note: z.string().nullable(),
  notedOn: LocalDate.nullable(),
  passage: PassageRef.nullable(),
});
export type SizeExperience = z.infer<typeof SizeExperience>;

/**
 * Everything a conversational model turn or a composition run must receive about taste:
 * the complete active profile, then its active amendments, then the precedence statement.
 */
export const StyleContext = z.object({
  document: StyleDocument,
  amendments: z.array(StyleAmendment),
  rules: z.array(StyleRule),
  directions: z.array(StandingDirection),
  briefs: z.array(TemporaryBrief),
  measurements: z.array(Measurement),
  sizeExperiences: z.array(SizeExperience),
  precedence: z.string(),
  styleRevision: z.number().int().nonnegative(),
});
export type StyleContext = z.infer<typeof StyleContext>;

export const STYLE_PRECEDENCE_STATEMENT =
  "Precedence: (1) physical reality and hard restrictions; (2) an explicit authorized exception where one is allowed; " +
  "(3) the current day's brief; (4) standing directions; (5) stylistic preferences. Newer owner-confirmed restrictions, " +
  "measurements, sizes and current physical state in the amendments supersede conflicting older profile passages; " +
  "the profile prose governs taste. Taste cannot make an absent garment available.";
