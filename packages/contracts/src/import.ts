import { z } from 'zod';
import {
  AcquisitionState,
  AliasKind,
  CareChannel,
  Category,
  DisposalReason,
  FactSourceKind,
  GarmentCondition,
  GarmentRole,
  Instant,
  LocalDate,
  LocationKind,
  LaundryPolicy,
  PlanningPolicy,
  RequiredEvidence,
  RestrictionKind,
  StockBucket,
  StockTracking,
  TimeZone,
} from './enums.js';
import { GarmentAttributes } from './garment.js';
import { LaundryRoutine, RestrictionScope } from './stock.js';
import { NEUTRAL_EXPORT_FORMAT, NEUTRAL_EXPORT_VERSION } from './version.js';
import { StyleRuleDefinition } from './style.js';

/**
 * Neutral import dataset (spec section 16, "Import only data"). The importer maps these records to
 * fresh canonical identities and keeps the source IDs in import_references. Source IDs are unique
 * per dataset; repeated imports are deduplicated by them.
 */

const SourceId = z.string().min(1).max(120);

export const ImportGarment = z.strictObject({
  sourceId: SourceId,
  name: z.string().min(1).max(120),
  category: Category,
  roles: z.array(GarmentRole).min(1),
  maker: z.string().max(120).optional(),
  productName: z.string().max(200).optional(),
  productCode: z.string().max(120).optional(),
  fabric: z.string().max(200).optional(),
  color: z.string().max(80).optional(),
  colorFamily: z.string().max(40).optional(),
  pattern: z.string().max(80).optional(),
  sizeLabel: z.string().max(60).optional(),
  careChannel: CareChannel,
  laundryPolicy: LaundryPolicy,
  tracking: StockTracking.default('unit'),
  acquisition: AcquisitionState,
  disposalReason: DisposalReason.optional(),
  planningPolicy: PlanningPolicy.default('normal'),
  condition: GarmentCondition.default('good'),
  location: LocationKind.default('home'),
  locationDetail: z.string().max(200).optional(),
  attributes: GarmentAttributes.default({}),
  notes: z.string().max(4000).optional(),
  /** Units per bucket at export time. Incoming items normally have none. */
  stock: z.partialRecord(StockBucket, z.number().int().nonnegative()).default({}),
  aliases: z.array(z.strictObject({ phrase: z.string().min(1).max(200), kind: AliasKind.default('owner_phrase') })).default([]),
  /** Dated assertions sourced to the dataset (fabric, season, price, acquired date, construction notes...). */
  facts: z
    .array(
      z.strictObject({
        field: z.string().min(1).max(80),
        value: z.unknown(),
        sourceKind: FactSourceKind.default('import'),
        sourceRef: z.string().max(500),
        observedAt: Instant,
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .default([]),
  /**
   * Every source row this garment accounts for. The first is 'imported'; further rows that describe
   * the same interchangeable garment are 'merged' with an explicit note. Defaults to [sourceId].
   */
  sourceRows: z
    .array(
      z.strictObject({
        sourceId: SourceId,
        row: z.number().int().positive().optional(),
        rowSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        disposition: z.enum(['imported', 'merged']),
        note: z.string().max(500).optional(),
      }),
    )
    .optional(),
});
export type ImportGarment = z.infer<typeof ImportGarment>;
export type ImportGarmentInput = z.input<typeof ImportGarment>;

export const ImportRestriction = z.strictObject({
  sourceId: SourceId,
  kind: RestrictionKind,
  /** Scope may reference garments by import sourceId in garmentSourceIds. */
  scope: z.strictObject({
    garmentSourceIds: z.array(SourceId).optional(),
    categories: z.array(Category).optional(),
    roles: z.array(GarmentRole).optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  reason: z.string().min(1).max(1000),
  startsAt: Instant,
  expectedEnd: LocalDate.optional(),
  requiredEvidence: RequiredEvidence.default('owner_statement'),
});

export const ImportOrder = z.strictObject({
  sourceId: SourceId,
  merchant: z.string().min(1).max(120),
  merchantOrderNumber: z.string().min(1).max(120),
  orderedAt: Instant,
  currency: z.string().length(3),
  lines: z
    .array(
      z.strictObject({
        externalLineId: z.string().min(1).max(120),
        garmentSourceId: SourceId.optional(),
        description: z.string().max(500),
        quantity: z.number().int().positive(),
        unitPriceMinor: z.number().int().nonnegative(),
        arrivalEstimate: LocalDate.optional(),
        arrivedQuantity: z.number().int().nonnegative().default(0),
        returnDeadline: z
          .strictObject({
            kind: z.enum(['request', 'post', 'retailer_receipt']),
            deadline: Instant,
            timezone: TimeZone,
            termsSource: z.string().max(500),
            checkedAt: Instant,
          })
          .optional(),
      }),
    )
    .min(1),
});

export const ImportMeasurement = z.strictObject({
  sourceId: SourceId,
  subject: z.enum(['body', 'garment']),
  garmentSourceId: SourceId.optional(),
  name: z.string().min(1).max(80),
  value: z.number(),
  unit: z.enum(['cm', 'in', 'mm', 'kg', 'eu', 'uk', 'us']),
  convention: z.string().max(200).optional(),
  measuredOn: LocalDate,
  source: z.string().max(200),
});

export const ImportStyleDocument = z.strictObject({
  sourceId: SourceId,
  title: z.string().min(1).max(200),
  /** Verbatim text. The importer stores it byte-exact with its SHA-256. */
  body: z.string().min(1),
  /** A demo/synthetic profile is flagged so it can never be mistaken for the owner's real profile. */
  isDemo: z.boolean(),
  source: z.enum(['owner_supplied', 'import', 'synthetic_test']).default('import'),
  authoredOn: LocalDate,
  /** Optional expected hash; a mismatch is recorded as a migration issue (the supplied text stays authoritative). */
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Rules derived from this document; each quote must be a verbatim substring of body. */
  rules: z.array(StyleRuleDefinition).default([]),
});

export const ImportStyleRule = StyleRuleDefinition;

export const ImportDataset = z.strictObject({
  format: z.literal(NEUTRAL_EXPORT_FORMAT),
  version: z.literal(NEUTRAL_EXPORT_VERSION),
  source: z.strictObject({ system: z.string().min(1).max(80), exportedAt: Instant, label: z.string().max(200).optional() }),
  owner: z.strictObject({
    displayName: z.string().min(1).max(120),
    homeLocationLabel: z.string().max(120),
    homeLatitude: z.number().min(-90).max(90).optional(),
    homeLongitude: z.number().min(-180).max(180).optional(),
    timezone: TimeZone,
    deliveryTime: z.string().regex(/^\d{2}:\d{2}$/).default('07:00'),
    dailyOptionCount: z.number().int().min(3).max(5).default(5),
    laundryRoutine: LaundryRoutine.optional(),
    wearLoggingSince: LocalDate,
    /** Optional separate estimator parameters (defaults apply otherwise). */
    estimatorParameters: z.record(z.string(), z.unknown()).optional(),
  }),
  styleDocuments: z.array(ImportStyleDocument).default([]),
  garments: z.array(ImportGarment).min(1),
  restrictions: z.array(ImportRestriction).default([]),
  orders: z.array(ImportOrder).default([]),
  measurements: z.array(ImportMeasurement).default([]),
  lifecycleProjects: z
    .array(
      z.strictObject({
        sourceId: SourceId,
        kind: z.enum(['tailoring', 'return', 'storage', 'sale', 'consignment', 'repair']),
        garmentSourceIds: z.array(SourceId).min(1),
        status: z.string().max(40),
        details: z.record(z.string(), z.unknown()).default({}),
        expectedReturn: LocalDate.optional(),
      }),
    )
    .default([]),
  /** Source rows that could not be mapped; each is recorded as held for resolution. */
  heldRows: z
    .array(z.strictObject({ sourceId: SourceId, row: z.number().int().positive().optional(), rowSha256: z.string().optional(), reason: z.string().min(1).max(500) }))
    .default([]),
  /** Migration issues: conflicts and gaps recorded instead of guessed. */
  issues: z
    .array(
      z.strictObject({
        issueKey: z.string().min(3).max(200),
        kind: z.string().min(1).max(60),
        severity: z.enum(['info', 'review', 'conflict']).default('review'),
        garmentSourceId: SourceId.optional(),
        sourceId: SourceId.optional(),
        detail: z.string().min(1).max(2000),
        evidence: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .default([]),
});
export type ImportDataset = z.infer<typeof ImportDataset>;
export type ImportDatasetInput = z.input<typeof ImportDataset>;
export { RestrictionScope };
