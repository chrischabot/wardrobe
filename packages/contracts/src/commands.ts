import { z } from "zod";
import { Actor, AuthorizationBasis, Channel, CommandId, EntityVersion, GarmentId, Instant, IanaTimezone, LocalDate, PassageRef, SourceRef } from "./primitives.ts";
import { Bucket, CareChannel, Category, GarmentAttributes, PlanningPolicy, RestrictionKind, RestrictionScope, Role, ThermalBound } from "./garment.ts";
import { ExposureOption } from "./availability.ts";
import { OwnerSettings } from "./settings.ts";
import { RuleKind, RuleStatus, StyleFactRef, StyleFactResolution } from "./style.ts";

/* ------------------------------------------------------------------ */
/* Foundation command payloads. One schema per command type.           */
/* Other workstreams add their own in src/ext/<workstream>.ts and      */
/* register handlers with the command registry (see README).           */
/* ------------------------------------------------------------------ */

const Quantity = z.number().int().positive();

export const GarmentCreate = z.object({
  garmentId: GarmentId.optional().describe("Caller-chosen stable ID (importer); otherwise assigned."),
  name: z.string().min(1),
  category: Category,
  roles: z.array(Role).min(1),
  maker: z.string().nullable().default(null),
  product: z.string().nullable().default(null),
  fabric: z.string().nullable().default(null),
  colour: z.string().nullable().default(null),
  pattern: z.string().nullable().default(null),
  size: z.string().nullable().default(null),
  careChannel: CareChannel,
  planningPolicy: PlanningPolicy.default("normal"),
  planningReason: z.string().nullable().default(null),
  condition: z.string().nullable().default(null),
  seasonNote: z.string().nullable().default(null),
  thermal: ThermalBound.nullable().default(null),
  attributes: GarmentAttributes.default({}),
  aliases: z.array(z.object({ phrase: z.string().min(1), kind: z.enum(["owner_name", "maker_name", "code", "import"]) })).default([]),
  /** `incoming`: ordered, not arrived (never wearable). `owned`: the units are in the owner's possession. */
  acquisition: z.enum(["incoming", "owned"]),
  quantity: Quantity,
  /** Where owned units start. Imported stock whose cleanliness was never observed uses basis `import`. */
  initialBucket: z.enum(["clean", "storage", "tailor"]).default("clean"),
  wearLoggingSince: LocalDate.nullable().default(null),
  isSynthetic: z.boolean().default(false),
  source: SourceRef,
  facts: z.array(z.object({ attribute: z.string(), value: z.unknown(), source: SourceRef, scope: z.string().nullable().default(null) })).default([]),
});

/** Arrival is a separate observed fact from order/creation. */
export const GarmentReceive = z.object({ garmentId: GarmentId, quantity: Quantity.optional() });

export const GarmentCorrect = z.object({
  garmentId: GarmentId,
  changes: z
    .object({
      name: z.string().min(1),
      maker: z.string().nullable(),
      product: z.string().nullable(),
      fabric: z.string().nullable(),
      colour: z.string().nullable(),
      pattern: z.string().nullable(),
      size: z.string().nullable(),
      condition: z.string().nullable(),
      careChannel: CareChannel,
      roles: z.array(Role).min(1),
      thermal: ThermalBound.nullable(),
      attributes: GarmentAttributes,
    })
    .partial()
    .refine((c) => Object.keys(c).length > 0, "at least one change is required"),
  source: SourceRef,
});

/**
 * Which garments a bulk edit covers. Every set field must match (AND); `garmentIds` names an explicit
 * set, the others are evaluated against the current records. Merged, removed and disposed garments are
 * never selected.
 */
export const GarmentSelector = z
  .object({
    garmentIds: z.array(GarmentId).min(1).optional(),
    category: Category.optional(),
    search: z.string().min(1).optional().describe("All words must occur in the name, maker, product, colour, fabric or an alias."),
    maker: z.string().min(1).optional(),
    colour: z.string().min(1).optional(),
    fabric: z.string().min(1).optional(),
    careChannel: CareChannel.optional(),
    planningPolicy: PlanningPolicy.optional(),
    acquisition: z.enum(["incoming", "owned"]).optional(),
  })
  .refine((s) => Object.values(s).some((v) => v !== undefined), "a selector needs at least one criterion");
export type GarmentSelector = z.input<typeof GarmentSelector>;

/**
 * One correction applied to every garment a category or query selects, as a single command with one
 * receipt and one undo. `expectedCount` is the size of the set the owner saw; the command is refused,
 * with the current matches, when the selection has changed.
 */
export const GarmentBulkCorrect = z.object({
  selector: GarmentSelector,
  changes: z
    .object({
      maker: z.string().nullable(),
      product: z.string().nullable(),
      fabric: z.string().nullable(),
      colour: z.string().nullable(),
      pattern: z.string().nullable(),
      size: z.string().nullable(),
      condition: z.string().nullable(),
      careChannel: CareChannel,
      roles: z.array(Role).min(1),
      thermal: ThermalBound.nullable(),
      attributes: GarmentAttributes,
    })
    .partial()
    .refine((c) => Object.keys(c).length > 0, "at least one change is required"),
  expectedCount: z.number().int().positive().optional(),
  source: SourceRef,
});

export const GarmentAddAlias = z.object({ garmentId: GarmentId, phrase: z.string().min(1), kind: z.enum(["owner_name", "maker_name", "code"]).default("owner_name") });
export const GarmentRemoveAlias = z.object({ garmentId: GarmentId, phrase: z.string().min(1) });
export const GarmentSetPlanningPolicy = z.object({ garmentId: GarmentId, policy: PlanningPolicy, reason: z.string().nullable().default(null) });

/** Move units between home, storage and the tailor. "Back from the tailor" is `to: clean`. */
export const GarmentMove = z.object({
  garmentId: GarmentId,
  to: z.enum(["clean", "storage", "tailor"]),
  from: z.enum(["clean", "dirty", "storage", "tailor"]).optional(),
  quantity: Quantity.optional(),
  expectedReturn: Instant.nullable().default(null),
  note: z.string().nullable().default(null),
});

/** Physical departure. Drafting a listing or requesting a return is NOT this command. */
export const GarmentRetire = z.object({
  garmentId: GarmentId,
  quantity: Quantity.optional(),
  disposition: z.enum(["sold", "donated", "discarded", "returned_to_seller", "lost", "other"]),
  note: z.string().nullable().default(null),
});

/** Explicit identity merge: aliases, facts and wear keys move to the target; duplicates reconcile. */
export const GarmentMerge = z.object({
  sourceGarmentId: GarmentId,
  targetGarmentId: GarmentId,
  /** `same_units`: both records described the same physical units. `add_units`: the source's units are additional. */
  quantityMode: z.enum(["same_units", "add_units"]).default("same_units"),
});

export const GarmentRemoveFabricated = z.object({ garmentId: GarmentId, reason: z.string().min(1) });

/** Aggregate owner correction, e.g. "five pairs are clean". Never exposes per-unit identity. */
export const StockReconcile = z.object({
  garmentId: GarmentId,
  counts: z
    .object({ clean: z.number().int().nonnegative(), dirty: z.number().int().nonnegative(), storage: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .partial()
    // A count correction states at least one count: an empty one would verify stock without observing anything.
    .refine((c) => Object.values(c).some((v) => v !== undefined), "at least one count is required"),
  note: z.string().nullable().default(null),
});

export const StockPack = z.object({ tripId: z.string().min(1), items: z.array(z.object({ garmentId: GarmentId, quantity: Quantity.default(1) })).min(1) });
/** Unpacking returns units home WITHOUT declaring them clean. */
export const StockUnpack = z.object({ tripId: z.string().min(1), items: z.array(z.object({ garmentId: GarmentId, quantity: Quantity.optional() })).optional() });

/**
 * Authoritative owner observation: "I am wearing it" / "I wore it yesterday".
 * Counted once per (user, garment, wearing date); duplicate reports merge.
 */
export const WearRecord = z.object({
  wearingDate: LocalDate,
  garmentIds: z.array(GarmentId).min(1),
  timezone: IanaTimezone.optional(),
  segment: z.string().nullable().default(null).describe("Outfit segment label, e.g. 'day', 'dinner'."),
  /** Garments for which a further clean interchangeable unit was physically used (e.g. a second sock pair). */
  additionalUnits: z.array(z.object({ garmentId: GarmentId, quantity: Quantity })).default([]),
  /** On a trip: the wear uses the packed subset. */
  tripId: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
});

/** Factual correction of a wearing date: replaces only the facts it corrects. */
export const WearAmend = z.object({
  wearingDate: LocalDate,
  remove: z.array(GarmentId).default([]),
  add: z.array(GarmentId).default([]),
  reason: z.string().nullable().default(null),
});

/** "In the wash" / spill: observed dirty state. */
export const CareMarkDirty = z.object({ items: z.array(z.object({ garmentId: GarmentId, quantity: Quantity.default(1) })).min(1) });

/** "I washed it" / "Socks washed": observed clean state. Omit quantity to clear all dirty units. */
export const CareWashed = z.object({
  items: z.array(z.object({ garmentId: GarmentId, quantity: Quantity.optional() })).optional(),
  /** Clear every dirty unit of this care channel (e.g. `handwash` for "Socks washed"). */
  allOfChannel: CareChannel.optional(),
}).refine((p) => (p.items && p.items.length > 0) || p.allOfChannel, "items or allOfChannel is required");

/** Service pickup: snapshots the dirty service-channel quantities into a batch. */
export const LaundryCollect = z.object({
  batchId: z.string().optional(),
  exclude: z.array(GarmentId).default([]),
  include: z.array(z.object({ garmentId: GarmentId, quantity: Quantity })).default([]),
});

/** Batch return: completes only the returning batch's contents, less named exceptions. */
export const LaundryReturn = z.object({
  batchId: z.string().optional().describe("Defaults to the oldest outstanding batch."),
  stillAway: z.array(z.object({ garmentId: GarmentId, quantity: Quantity.default(1) })).default([]),
});

export const LaundryReportException = z.object({
  kind: z.enum(["missed_return", "delayed", "still_away", "lost"]),
  /** Item-level exception; omit for a cycle-level missed/delayed return. */
  garmentId: GarmentId.optional(),
  quantity: Quantity.default(1),
  cycleKey: LocalDate.optional().describe("Cycle the exception applies to; defaults to the latest applied cycle."),
  note: z.string().nullable().default(null),
});

/** Applies every elapsed, not-yet-applied weekly baseline exactly once per owner, channel and cycle. */
export const LaundryApplyWeeklyReset = z.object({ asOf: Instant.optional() });

export const RestrictionAdd = z.object({
  restrictionId: z.string().optional(),
  kind: RestrictionKind,
  scope: RestrictionScope,
  reason: z.string().min(1),
  expectedEnd: Instant.nullable().default(null),
  requiredEvidence: z.enum(["owner_statement", "owner_observation", "receipt"]).default("owner_statement"),
  source: SourceRef,
});

/** Lifting a restriction needs the evidence it names; elapsed time or a schedule never resolves it. */
export const RestrictionResolve = z.object({ restrictionId: z.string(), evidence: SourceRef, note: z.string().nullable().default(null) });

export const StyleImportDocument = z.object({
  documentId: z.string().default("owner-profile"),
  title: z.string(),
  content: z.string().min(1),
  expectedSha256: z.string().length(64).describe("Import is rejected unless the content hashes to this value."),
  source: SourceRef,
});

/**
 * Save in My style: new version against the same expected version. The command derives the diff of
 * structured facts (see StyleFactDiff); `factResolutions` are the owner's clear decisions for affected
 * facts and apply atomically with the new version and the amendment changes. Affected facts without a
 * resolution become open conflicts.
 */
export const StyleSaveDocument = z.object({
  documentId: z.string().default("owner-profile"),
  content: z.string().min(1),
  incorporateAmendmentIds: z.array(z.string()).default([]),
  factResolutions: z.array(z.object({ fact: StyleFactRef, resolution: StyleFactResolution })).default([]),
  source: SourceRef,
});

/** Decide an open conflict left by an earlier save. */
export const StyleResolveFactConflict = z.object({ conflictId: z.string().min(1), resolution: StyleFactResolution });

export const StyleAddAmendment = z.object({
  amendmentId: z.string().optional(),
  documentId: z.string().default("owner-profile"),
  text: z.string().min(1),
  kind: z.enum(["restriction", "measurement", "size", "physical_state", "taste", "other"]),
  source: SourceRef,
});
export const StyleSetAmendmentStatus = z.object({ amendmentId: z.string(), status: z.enum(["active", "incorporated", "retired"]) });

export const StyleUpsertRule = z.object({
  ruleId: z.string().optional(),
  key: z.string().min(1),
  kind: RuleKind,
  status: RuleStatus,
  params: z.record(z.string(), z.unknown()).default({}),
  interpretation: z.string().min(1),
  passages: z.array(PassageRef).default([]),
  origin: z.enum(["profile", "specification", "owner_direction", "owner_amendment"]),
});

export const StyleAddDirection = z.object({
  directionId: z.string().optional(),
  text: z.string().min(1),
  scope: z.string().nullable().default(null),
  checkKey: z.string().nullable().default(null),
  source: SourceRef,
});
export const StyleRetireDirection = z.object({ directionId: z.string() });
export const StyleSetBrief = z.object({ briefId: z.string().optional(), localDate: LocalDate, text: z.string().min(1), source: SourceRef });
export const StyleRetireBrief = z.object({ briefId: z.string() });

export const MeasurementRecord = z.object({
  subject: z.enum(["body", "garment"]),
  garmentId: GarmentId.nullable().default(null),
  key: z.string().min(1),
  value: z.number(),
  unit: z.enum(["in", "cm", "m", "uk_shoe", "other"]),
  convention: z.string().nullable().default(null),
  qualifier: z.string().nullable().default(null),
  measuredOn: LocalDate.nullable().default(null),
  source: SourceRef,
  passage: PassageRef.nullable().default(null),
});

export const SizeExperienceRecord = z.object({
  maker: z.string().min(1),
  productFamily: z.string().nullable().default(null),
  sizeLabel: z.string().min(1),
  note: z.string().nullable().default(null),
  notedOn: LocalDate.nullable().default(null),
  passage: PassageRef.nullable().default(null),
});

/** Deep-partial settings patch; versioned. */
export const SettingsUpdate = z.object({ patch: z.record(z.string(), z.unknown()) });

/** Register a set of mutually exclusive offered options (a published board) for probability estimates. */
export const ExposurePublish = z.object({
  exposureId: z.string().optional(),
  localDate: LocalDate,
  sourceKind: z.enum(["board", "plan", "test"]),
  sourceRef: z.string().describe("Board/plan identity and revision."),
  options: z.array(ExposureOption).min(1),
  /** Overrides the owner's pUseBoard setting for this set (e.g. 1.0 in a controlled fixture). */
  pUse: z.number().min(0).max(1).optional(),
  /** Exposure sets for the same date this one replaces (older board revisions). */
  supersedes: z.array(z.string()).default([]),
});
/** Choose records an intention, not a wear: it raises the selected option's probability. */
export const ExposureSelect = z.object({ exposureId: z.string(), optionId: z.string().nullable(), chosenAlternatives: z.array(GarmentId).default([]) });
export const ExposureSupersede = z.object({ exposureIds: z.array(z.string()).min(1) });

/** Import bookkeeping: every source row accounted for, plus migration issues. Written by the isolated importer. */
export const ImportRecordRun = z.object({
  importRunId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceSha256: z.string().length(64),
  sourceBytes: z.number().int().nonnegative(),
  importer: z.string().min(1),
  summary: z.record(z.string(), z.unknown()),
  rows: z.array(
    z.object({
      sourceRow: z.number().int().positive(),
      sourceKey: z.string(),
      disposition: z.enum(["imported", "merged", "held", "not_a_data_row"]),
      garmentId: GarmentId.nullable(),
      reason: z.string(),
      raw: z.record(z.string(), z.unknown()),
    }),
  ),
  issues: z.array(
    z.object({
      issueId: z.string(),
      kind: z.string(),
      severity: z.enum(["info", "conflict", "needs_owner"]),
      detail: z.string(),
      garmentId: GarmentId.nullable(),
      sourceRows: z.array(z.number().int().positive()),
    }),
  ),
});

/** Undo is a compensating command with the same checks; it never deletes a receipt. */
export const CommandUndo = z.object({ commandId: CommandId, reason: z.string().nullable().default(null) });

export const FOUNDATION_COMMANDS = {
  "garment.create": GarmentCreate,
  "garment.receive": GarmentReceive,
  "garment.correct": GarmentCorrect,
  "garment.bulk_correct": GarmentBulkCorrect,
  "garment.add_alias": GarmentAddAlias,
  "garment.remove_alias": GarmentRemoveAlias,
  "garment.set_planning_policy": GarmentSetPlanningPolicy,
  "garment.move": GarmentMove,
  "garment.retire": GarmentRetire,
  "garment.merge": GarmentMerge,
  "garment.remove_fabricated": GarmentRemoveFabricated,
  "stock.reconcile": StockReconcile,
  "stock.pack": StockPack,
  "stock.unpack": StockUnpack,
  "wear.record": WearRecord,
  "wear.amend": WearAmend,
  "care.mark_dirty": CareMarkDirty,
  "care.washed": CareWashed,
  "laundry.collect": LaundryCollect,
  "laundry.return": LaundryReturn,
  "laundry.report_exception": LaundryReportException,
  "laundry.apply_weekly_reset": LaundryApplyWeeklyReset,
  "restriction.add": RestrictionAdd,
  "restriction.resolve": RestrictionResolve,
  "style.import_document": StyleImportDocument,
  "style.save_document": StyleSaveDocument,
  "style.resolve_fact_conflict": StyleResolveFactConflict,
  "style.add_amendment": StyleAddAmendment,
  "style.set_amendment_status": StyleSetAmendmentStatus,
  "style.upsert_rule": StyleUpsertRule,
  "style.add_direction": StyleAddDirection,
  "style.retire_direction": StyleRetireDirection,
  "style.set_brief": StyleSetBrief,
  "style.retire_brief": StyleRetireBrief,
  "measurement.record": MeasurementRecord,
  "size_experience.record": SizeExperienceRecord,
  "settings.update": SettingsUpdate,
  "exposure.publish": ExposurePublish,
  "exposure.select": ExposureSelect,
  "exposure.supersede": ExposureSupersede,
  "import.record_run": ImportRecordRun,
  "command.undo": CommandUndo,
} as const;

export type FoundationCommandType = keyof typeof FOUNDATION_COMMANDS;
export type FoundationPayload<T extends FoundationCommandType> = z.input<(typeof FOUNDATION_COMMANDS)[T]>;
export const FOUNDATION_COMMAND_TYPES = Object.keys(FOUNDATION_COMMANDS) as FoundationCommandType[];

/* ------------------------------------------------------------------ */
/* Envelope and receipt                                                 */
/* ------------------------------------------------------------------ */

export const CommandSource = z.object({
  channel: Channel,
  /** Stable client submission ID created before sending (phone, MCP client...). */
  clientSubmissionId: z.string().max(128).optional(),
  /** Conversation turn or job that proposed the action. */
  parentKind: z.enum(["turn", "job", "workflow", "none"]).default("none"),
  parentId: z.string().max(128).optional(),
  /** Backend-issued action intent ID (see action intents); the idempotency key derives from it. */
  actionId: z.string().max(128).optional(),
  /** Attached item/outfit identity ("Ask about this"), never guessed by a model. */
  attachedRefs: z.array(z.string()).default([]),
});
export type CommandSource = z.infer<typeof CommandSource>;

export const CommandEnvelope = z.object({
  /** Command type, e.g. `wear.record`. Unknown types are rejected; there is no generic write. */
  type: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
  /** Same key + same body returns the previous receipt; same key + different body is an error. */
  idempotencyKey: z.string().min(8).max(200),
  /** Optimistic versions for plan edits, keyed `kind:id` (e.g. `garment:gmt_x`, `wardrobe`, `style`, `settings`). */
  expectedVersions: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** When the event happened (may be earlier than when it was reported). Defaults to now. */
  occurredAt: Instant.optional(),
  authorization: AuthorizationBasis,
  source: CommandSource,
});
export type CommandEnvelope = z.input<typeof CommandEnvelope>;
export type ParsedCommandEnvelope = z.infer<typeof CommandEnvelope>;

export const EffectState = z.enum(["pending", "in_progress", "projected", "failed", "superseded", "cancelled"]);
export type EffectState = z.infer<typeof EffectState>;

export const ReceiptEffect = z.object({
  effectId: z.string(),
  kind: z.string().describe("e.g. calendar.project_board, notification.send, media.process"),
  state: EffectState,
});

export const ReceiptOutcome = z.enum([
  "committed", // the change was written
  "merged", // an owner observation merged into an existing record (e.g. duplicate wear report); nothing double-counted
  "noop", // valid request, nothing to change
]);

/**
 * A verified receipt: what was actually written, read back from the same transaction.
 * `accepted` never appears here - long operations return a run ID instead.
 */
export const CommandReceipt = z.object({
  commandId: CommandId,
  type: z.string(),
  outcome: ReceiptOutcome,
  /** Concise, factual summary built from records (names from the ledger, never model prose). */
  summary: z.string(),
  affected: z.array(EntityVersion),
  /** `committed`: no external projection needed or all done; otherwise pending/projected per effects. */
  externalEffectState: z.enum(["none", "projection_pending", "projected"]),
  effects: z.array(ReceiptEffect),
  undo: z.object({
    available: z.boolean(),
    reason: z.string().nullable().describe("Why undo is unavailable, when it is."),
  }),
  /** Accounting repairs performed around an authoritative observation (never questions for the owner). */
  repairs: z.array(z.string()),
  /** Typed result data specific to the command (IDs created, counts, dates). */
  result: z.record(z.string(), z.unknown()),
  occurredAt: Instant,
  recordedAt: Instant,
  wardrobeRevision: z.number().int().nonnegative(),
  /** True when this response is the stored receipt of an earlier identical request. */
  replayed: z.boolean(),
  actor: Actor,
  channel: Channel,
  contractVersion: z.string(),
});
export type CommandReceipt = z.infer<typeof CommandReceipt>;

export const CommandErrorCode = z.enum([
  "invalid_command", // payload/envelope failed validation
  "unknown_command",
  "forbidden", // scope, channel or authorization basis not allowed
  "not_found", // a named target does not exist for this owner
  "ambiguous_target", // an alias resolved to more than one garment
  "conflict", // an expected version did not match (plan edits only)
  "idempotency_key_reuse", // same key, different body
  "precondition_failed", // quantity or state predicate failed
  "not_undoable",
  "internal",
]);
export type CommandErrorCode = z.infer<typeof CommandErrorCode>;

export const CommandErrorBody = z.object({
  code: CommandErrorCode,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type CommandErrorBody = z.infer<typeof CommandErrorBody>;
