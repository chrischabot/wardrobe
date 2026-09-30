import { z } from 'zod';
import {
  AcquisitionState,
  AliasKind,
  CareChannel,
  Category,
  DisposalReason,
  EntityType,
  FactSourceKind,
  GarmentCondition,
  GarmentRole,
  Instant,
  LaundryPolicy,
  LocalDate,
  LocationKind,
  OpaqueId,
  PlanningPolicy,
  RequiredEvidence,
  RestrictionKind,
  SourceChannel,
  StockTracking,
  TimeZone,
} from './enums.js';
import { GarmentAttributes } from './garment.js';
import { RestrictionScope, WearItem } from './stock.js';
import {
  AdvanceLifecycleProjectCommand,
  ImportOrderCommand,
  OpenLifecycleProjectCommand,
  RecordComfortFeedbackCommand,
  RecordOrderEventCommand,
  RecordReturnTermsCommand,
} from './lifecycle-commands.js';
import { PlanOutfitCommand, RemoveCombinationCommand, SaveCombinationCommand } from './visual.js';

/**
 * The typed domain command catalogue (spec section 8). Every mutation goes through one of these
 * commands, inside a CommandEnvelope that carries the idempotency key and expected versions.
 *
 * Command classes (see COMMAND_CLASS):
 * - observation: an owner's physical statement. Accepted and rebased on version conflict.
 * - edit: a change to plans, restrictions or records. Stale expected versions are a conflict.
 * - intake: explicit creation.
 * - compensation: undo of an earlier receipt.
 */

const Quantity = z.number().int().positive().max(500);

export const RecordWearCommand = z.strictObject({
  type: z.literal('record_wear'),
  /** Local wearing date: the durable day key. Defaults to occurredAt's date in timezone. */
  wearingDate: LocalDate.optional(),
  timezone: TimeZone,
  /** When the wear happened (not when it was reported). Defaults to the receipt time. */
  occurredAt: Instant.optional(),
  segment: z.string().max(40).optional(),
  items: z.array(WearItem).min(1).max(30),
  /** Optional reference to a board option this wear came from (intent, not truth). */
  optionId: OpaqueId.optional(),
  sourceRef: z.string().max(500).optional(),
});

export const AmendWearCommand = z.strictObject({
  type: z.literal('amend_wear'),
  observationId: OpaqueId,
  /** The corrected complete garment list for that observation. */
  items: z.array(WearItem).max(30),
  reason: z.string().max(500).optional(),
});

export const MarkInWashCommand = z.strictObject({
  type: z.literal('mark_in_wash'),
  garmentId: OpaqueId,
  quantity: Quantity.optional(),
  occurredAt: Instant.optional(),
});

export const MarkWashedCommand = z.strictObject({
  type: z.literal('mark_washed'),
  garmentId: OpaqueId,
  quantity: Quantity.optional(),
  occurredAt: Instant.optional(),
});

export const SocksWashedCommand = z.strictObject({
  type: z.literal('socks_washed'),
  /** Limit to these garments; default is every hand-wash garment with units in the hamper. */
  garmentIds: z.array(OpaqueId).max(100).optional(),
  occurredAt: Instant.optional(),
});

export const LaundryCollectedCommand = z.strictObject({
  type: z.literal('laundry_collected'),
  occurredAt: Instant.optional(),
});

const BatchException = z.strictObject({ garmentId: OpaqueId, quantity: Quantity.optional() });

export const LaundryReturnedCommand = z.strictObject({
  type: z.literal('laundry_returned'),
  /** Defaults to the oldest batch with items still away. */
  batchId: OpaqueId.optional(),
  /** Items that did not come back; they remain away as owner-reported exceptions. */
  exceptions: z.array(BatchException).max(100).optional(),
  occurredAt: Instant.optional(),
});

export const LaundryPartialReturnCommand = z.strictObject({
  type: z.literal('laundry_partial_return'),
  batchId: OpaqueId.optional(),
  exceptions: z.array(BatchException).min(1).max(100),
  occurredAt: Instant.optional(),
});

export const SendToTailorCommand = z.strictObject({
  type: z.literal('send_to_tailor'),
  garmentId: OpaqueId,
  work: z.string().max(1000),
  expectedReturn: LocalDate.optional(),
  occurredAt: Instant.optional(),
});

export const BackFromTailorCommand = z.strictObject({
  type: z.literal('back_from_tailor'),
  garmentId: OpaqueId,
  note: z.string().max(1000).optional(),
  occurredAt: Instant.optional(),
});

export const MarkArrivedCommand = z.strictObject({
  type: z.literal('mark_arrived'),
  garmentId: OpaqueId,
  /** Units that arrived; defaults to the ordered quantity still outstanding, or 1. */
  quantity: Quantity.optional(),
  occurredAt: Instant.optional(),
});

export const PutIntoStorageCommand = z.strictObject({
  type: z.literal('put_into_storage'),
  garmentId: OpaqueId,
  /** For anonymous quantities: how many units. Defaults to all clean units. */
  quantity: Quantity.optional(),
  locationDetail: z.string().max(200).optional(),
  occurredAt: Instant.optional(),
});

export const TakeOutOfStorageCommand = z.strictObject({
  type: z.literal('take_out_of_storage'),
  garmentId: OpaqueId,
  quantity: Quantity.optional(),
  occurredAt: Instant.optional(),
});

export const ReconcileQuantityCommand = z
  .strictObject({
    type: z.literal('reconcile_quantity'),
    garmentId: OpaqueId,
    /** Aggregate correction: "five pairs are clean". */
    clean: z.number().int().nonnegative().max(500).optional(),
    /** Correction of units owned: "I have twelve pairs". */
    totalOwned: z.number().int().nonnegative().max(500).optional(),
    occurredAt: Instant.optional(),
  })
  .refine((c) => c.clean !== undefined || c.totalOwned !== undefined, { message: 'Provide clean or totalOwned' });

export const AddItemCommand = z.strictObject({
  type: z.literal('add_item'),
  /** Item creation is explicit only: a status change can never create an item. */
  explicit: z.literal(true),
  name: z.string().min(1).max(120),
  category: Category,
  roles: z.array(GarmentRole).min(1).max(5),
  maker: z.string().max(120).optional(),
  productName: z.string().max(200).optional(),
  productCode: z.string().max(120).optional(),
  fabric: z.string().max(200).optional(),
  color: z.string().max(80).optional(),
  colorFamily: z.string().max(40).optional(),
  pattern: z.string().max(80).optional(),
  sizeLabel: z.string().max(60).optional(),
  careChannel: CareChannel.optional(),
  laundryPolicy: LaundryPolicy.optional(),
  tracking: StockTracking.optional(),
  acquisition: AcquisitionState.exclude(['disposed']).default('owned'),
  planningPolicy: PlanningPolicy.optional(),
  condition: GarmentCondition.optional(),
  location: LocationKind.optional(),
  quantity: Quantity.default(1),
  attributes: GarmentAttributes.optional(),
  aliases: z.array(z.strictObject({ phrase: z.string().min(1).max(200), kind: AliasKind.default('owner_phrase') })).max(20).optional(),
  notes: z.string().max(4000).optional(),
  /** Dated, sourced assertions stored with the new garment (e.g. the owner statement and profile passage it rests on). */
  facts: z
    .array(
      z.strictObject({
        field: z.string().min(1).max(80),
        value: z.unknown(),
        sourceKind: FactSourceKind.exclude(['model_inference']),
        sourceRef: z.string().min(1).max(500),
        observedAt: Instant,
      }),
    )
    .max(30)
    .optional(),
});

export const SetRestrictionCommand = z.strictObject({
  type: z.literal('set_restriction'),
  kind: RestrictionKind,
  scope: RestrictionScope,
  reason: z.string().min(1).max(1000),
  expectedEnd: LocalDate.optional(),
  requiredEvidence: RequiredEvidence.default('owner_statement'),
  occurredAt: Instant.optional(),
});

export const LiftRestrictionCommand = z.strictObject({
  type: z.literal('lift_restriction'),
  restrictionId: OpaqueId,
  /** The owner's evidence, e.g. "my feet have healed". Required: elapsed time is not evidence. */
  evidence: z.string().min(1).max(1000),
  occurredAt: Instant.optional(),
});

export const SelectOptionCommand = z.strictObject({
  type: z.literal('select_option'),
  boardId: OpaqueId,
  optionId: OpaqueId,
  /** Required when the option has footwear alternatives, so a later wear never logs both. */
  footwearGarmentId: OpaqueId.optional(),
});

export const UndoCommand = z.strictObject({
  type: z.literal('undo'),
  targetCommandId: OpaqueId,
});

/** Lifecycle: the item has physically left (sold, donated, discarded, returned, lost). History is kept. */
export const DisposeItemCommand = z.strictObject({
  type: z.literal('dispose_item'),
  garmentId: OpaqueId,
  reason: DisposalReason.exclude(['fabricated_entry']),
  note: z.string().max(500).optional(),
  occurredAt: Instant.optional(),
});

/**
 * Save a new version of a style document (Settings > My style, or a chat correction). The body is
 * stored verbatim. Rules whose quoted passage no longer appears are flagged for review, never
 * silently rewritten. Requires the version being edited (baseVersion) so concurrent edits conflict.
 */
export const EditStyleProfileCommand = z.strictObject({
  type: z.literal('edit_style_profile'),
  documentId: OpaqueId,
  baseVersion: z.number().int().positive(),
  body: z.string().min(1).max(200_000),
  title: z.string().min(1).max(200).optional(),
  /** Optional dated amendment text explaining the change (kept alongside the document). */
  amendment: z.string().max(4000).optional(),
});

/**
 * A temporary brief or dated exception ("today I'm happy to repeat the cords"). It never edits the
 * profile document; it adds a dated temporary rule. Overriding a rule whose exception policy is
 * 'none' or 'restriction_lift_only' is rejected.
 */
export const SetTemporaryBriefCommand = z
  .strictObject({
    type: z.literal('set_temporary_brief'),
    text: z.string().min(1).max(2000),
    validFrom: LocalDate,
    validTo: LocalDate,
    /** Rule key relaxed for this scope, if the brief is an exception rather than extra direction. */
    overridesRuleKey: z.string().min(3).max(80).optional(),
    machine: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((c) => c.validTo >= c.validFrom, { message: 'validTo must not precede validFrom' });

/**
 * Morning delivery settings (Settings > Morning delivery): time, number of outfits (3–5), the
 * outfit calendar and the home location label. Only the given fields change.
 */
export const UpdateDeliverySettingsCommand = z
  .strictObject({
    type: z.literal('update_delivery_settings'),
    deliveryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    dailyOptionCount: z.number().int().min(3).max(5).optional(),
    /** Outfit calendar id; null clears it (no Calendar projection). */
    calendarId: z.string().min(1).max(200).nullable().optional(),
    homeLocationLabel: z.string().min(1).max(120).optional(),
  })
  .refine((c) => c.deliveryTime !== undefined || c.dailyOptionCount !== undefined || c.calendarId !== undefined || c.homeLocationLabel !== undefined, {
    message: 'Provide at least one setting to change',
  });

/**
 * Pause Garderobe (spec section 9 "Pause and resume"): recommendations, board publication and outfit
 * events stop from `startsOn` until `resumeOn` (or until resumed). Observations keep working. Undo ends
 * the pause.
 */
export const PauseServiceCommand = z
  .strictObject({
    type: z.literal('pause_service'),
    startsOn: LocalDate.optional(),
    /** Exclusive: the first day served again. Omit for an open-ended pause. */
    resumeOn: LocalDate.nullable().optional(),
    reason: z.string().max(300).optional(),
  })
  .refine((c) => !c.resumeOn || !c.startsOn || c.resumeOn > c.startsOn, { message: 'resumeOn must come after startsOn' });

/** Resume Garderobe: end every open pause and prepare only the next useful board. Undo pauses again. */
export const ResumeServiceCommand = z.strictObject({ type: z.literal('resume_service') });

export const DomainCommand = z.discriminatedUnion('type', [
  RecordWearCommand,
  AmendWearCommand,
  MarkInWashCommand,
  MarkWashedCommand,
  SocksWashedCommand,
  LaundryCollectedCommand,
  LaundryReturnedCommand,
  LaundryPartialReturnCommand,
  SendToTailorCommand,
  BackFromTailorCommand,
  MarkArrivedCommand,
  PutIntoStorageCommand,
  TakeOutOfStorageCommand,
  ReconcileQuantityCommand,
  AddItemCommand,
  SetRestrictionCommand,
  LiftRestrictionCommand,
  SelectOptionCommand,
  UndoCommand,
  EditStyleProfileCommand,
  SetTemporaryBriefCommand,
  DisposeItemCommand,
  ImportOrderCommand,
  RecordOrderEventCommand,
  RecordReturnTermsCommand,
  RecordComfortFeedbackCommand,
  OpenLifecycleProjectCommand,
  AdvanceLifecycleProjectCommand,
  SaveCombinationCommand,
  PlanOutfitCommand,
  RemoveCombinationCommand,
  UpdateDeliverySettingsCommand,
  PauseServiceCommand,
  ResumeServiceCommand,
]);
export type DomainCommand = z.infer<typeof DomainCommand>;
export type DomainCommandInput = z.input<typeof DomainCommand>;
export type CommandType = DomainCommand['type'];
export type CommandOf<T extends CommandType> = Extract<DomainCommand, { type: T }>;

export const COMMAND_TYPES = DomainCommand.options.map((o) => o.shape.type.value) as CommandType[];

export type CommandClass = 'observation' | 'edit' | 'intake' | 'compensation';

export const COMMAND_CLASS: Record<CommandType, CommandClass> = {
  record_wear: 'observation',
  amend_wear: 'observation',
  mark_in_wash: 'observation',
  mark_washed: 'observation',
  socks_washed: 'observation',
  laundry_collected: 'observation',
  laundry_returned: 'observation',
  laundry_partial_return: 'observation',
  send_to_tailor: 'observation',
  back_from_tailor: 'observation',
  mark_arrived: 'observation',
  put_into_storage: 'observation',
  take_out_of_storage: 'observation',
  reconcile_quantity: 'observation',
  add_item: 'intake',
  set_restriction: 'edit',
  lift_restriction: 'edit',
  select_option: 'edit',
  undo: 'compensation',
  edit_style_profile: 'edit',
  set_temporary_brief: 'edit',
  dispose_item: 'observation',
  import_order: 'intake',
  record_order_event: 'observation',
  record_return_terms: 'edit',
  record_comfort_feedback: 'observation',
  open_lifecycle_project: 'edit',
  advance_lifecycle_project: 'observation',
  save_combination: 'edit',
  plan_outfit: 'edit',
  remove_combination: 'edit',
  update_delivery_settings: 'edit',
  pause_service: 'edit',
  resume_service: 'edit',
};

export const ExpectedVersion = z.strictObject({
  entityType: EntityType,
  entityId: z.string().min(1).max(200),
  version: z.number().int().nonnegative(),
});
export type ExpectedVersion = z.infer<typeof ExpectedVersion>;

/**
 * The request body of POST /v1/commands and garderobe_command. Owner identity is never part of
 * it: the backend derives the owner from the authenticated principal and rejects any body that
 * carries an owner/user field.
 */
export const CommandEnvelope = z.strictObject({
  idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9:._\-]+$/),
  source: SourceChannel,
  expectedVersions: z.array(ExpectedVersion).max(100).optional(),
  /** Client submission time; informational. */
  submittedAt: Instant.optional(),
  command: DomainCommand,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
export type CommandEnvelopeInput = z.input<typeof CommandEnvelope>;
