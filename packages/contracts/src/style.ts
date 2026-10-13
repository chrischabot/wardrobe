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

/* ------------------------------------------------------------------ */
/* Structured facts anchored in the profile prose, and what a Save does */
/* to them (specification section 6, "Save in My style").               */
/* ------------------------------------------------------------------ */

/**
 * A structured fact that quotes the profile: a machine rule (`id` is its stable key), a dated
 * measurement or a size experience (`id` is the record ID).
 */
export const StyleFactRef = z.object({
  kind: z.enum(["rule", "measurement", "size_experience"]),
  id: z.string().min(1),
});
export type StyleFactRef = z.infer<typeof StyleFactRef>;

/**
 * The owner's decision about one structured fact whose quoted passage a profile edit removed or reworded.
 * Nothing here is ever derived by the application: a fact without a resolution stays as it was and is
 * shown as an open conflict.
 *   keep    - the fact still holds unchanged. With `quote` it is re-anchored to that passage of the new
 *             text; without one it stands on the owner's confirmation alone.
 *   replace - the fact changes: new rule parameters, a new dated measurement, or a new size experience.
 *   retire  - the fact no longer applies (rules and size experiences only; a measurement stays a dated
 *             fact, and an active restriction is never lifted by editing prose).
 */
export const StyleFactResolution = z
  .object({
    action: z.enum(["keep", "replace", "retire"]),
    quote: z.string().min(1).optional().describe("Passage of the saved text that now states the fact; must occur verbatim."),
    rule: z
      .object({
        params: z.record(z.string(), z.unknown()).optional(),
        interpretation: z.string().min(1).optional(),
        kind: RuleKind.optional(),
        status: z.enum(["active", "pending_reconciliation", "dormant"]).optional(),
      })
      .optional(),
    measurement: z
      .object({
        value: z.number(),
        unit: z.enum(["in", "cm", "m", "uk_shoe", "other"]),
        convention: z.string().nullable().optional(),
        qualifier: z.string().nullable().optional(),
        measuredOn: LocalDate.nullable().optional(),
      })
      .optional(),
    sizeExperience: z.object({ sizeLabel: z.string().min(1), note: z.string().nullable().optional() }).optional(),
    note: z.string().optional(),
  })
  .refine((r) => r.action !== "replace" || r.rule !== undefined || r.measurement !== undefined || r.sizeExperience !== undefined, "replace needs the new rule, measurement or size experience");
export type StyleFactResolution = z.infer<typeof StyleFactResolution>;

/** A structured fact whose passage a profile save removed or reworded and the owner has not yet decided. */
export const StyleFactConflict = z.object({
  conflictId: z.string(),
  documentId: z.string(),
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  fact: StyleFactRef,
  label: z.string().describe("What the fact says, built from the record (e.g. \"body chest: 44 in\")."),
  reason: z.enum(["passage_removed", "passage_changed"]),
  previousPassages: z.array(PassageRef).describe("The passages the fact quoted in the earlier version."),
  missingQuotes: z.array(z.string()).describe("Quotes that no longer occur verbatim in the saved text."),
  candidateText: z.string().nullable().describe("The owner's new wording at that place, verbatim; shown for the decision, never interpreted."),
  status: z.enum(["open", "resolved", "withdrawn"]),
  resolution: StyleFactResolution.nullable(),
  createdAt: Instant,
  resolvedAt: Instant.nullable(),
});
export type StyleFactConflict = z.infer<typeof StyleFactConflict>;

/**
 * What a Save in My style does to the structured facts, derived deterministically by comparing the
 * quoted passages with the edited text. No field is a model extraction.
 */
export const StyleFactDiff = z.object({
  documentId: z.string(),
  fromVersion: z.number().int().positive(),
  contentChanged: z.boolean(),
  anchoredFacts: z.number().int().nonnegative().describe("Structured facts that quoted the earlier version."),
  unchanged: z.number().int().nonnegative().describe("Facts whose quoted passages all still occur verbatim."),
  reanchored: z.array(z.object({ fact: StyleFactRef, label: z.string(), passages: z.array(PassageRef) })).describe("Unchanged rules whose passage references move to the new version."),
  applied: z.array(z.object({ fact: StyleFactRef, label: z.string(), action: z.enum(["keep", "replace", "retire"]) })).describe("Affected facts the owner resolved in this save."),
  conflicts: z
    .array(
      z.object({
        fact: StyleFactRef,
        label: z.string(),
        reason: z.enum(["passage_removed", "passage_changed"]),
        previousPassages: z.array(PassageRef),
        missingQuotes: z.array(z.string()),
        candidateText: z.string().nullable(),
        note: z.string().nullable().describe("Why this cannot be settled by the edit alone, where that applies."),
      }),
    )
    .describe("Affected facts left undecided; each stays in force and visible until the owner resolves it."),
  addedText: z.array(z.object({ lineStart: z.number().int().positive(), lineEnd: z.number().int().positive() })).describe("Line ranges of the new text that are new or reworded. No structured fact is created from them."),
});
export type StyleFactDiff = z.infer<typeof StyleFactDiff>;

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
  /** Open conflicts between the saved profile text and structured facts; absent means none were read. */
  factConflicts: z.array(StyleFactConflict).optional(),
  precedence: z.string(),
  styleRevision: z.number().int().nonnegative(),
});
export type StyleContext = z.infer<typeof StyleContext>;

export const STYLE_PRECEDENCE_STATEMENT =
  "Precedence: (1) physical reality and hard restrictions; (2) an explicit authorized exception where one is allowed; " +
  "(3) the current day's brief; (4) standing directions; (5) stylistic preferences. Newer owner-confirmed restrictions, " +
  "measurements, sizes and current physical state in the amendments supersede conflicting older profile passages; " +
  "the profile prose governs taste. Taste cannot make an absent garment available.";
