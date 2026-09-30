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
  LaundryPolicy,
  LocalDate,
  LocationKind,
  OpaqueId,
  PlanningPolicy,
  StockTracking,
} from './enums.js';

/** Thermal and styling attributes used by composition rules. Unknown stays absent, never guessed. */
export const GarmentAttributes = z
  .object({
    /** e.g. 'welted', 'cemented', 'vulcanised' for footwear */
    construction: z.string().max(60).optional(),
    /** e.g. 'lightweight_oxford', 'cotton_linen', 'linen', 'alpaca', 'merino' */
    fabricClass: z.string().max(60).optional(),
    weight: z.enum(['light', 'mid', 'heavy']).optional(),
    minTempC: z.number().min(-40).max(50).optional(),
    maxTempC: z.number().min(-40).max(50).optional(),
    indoorOnly: z.boolean().optional(),
    season: z.array(z.enum(['spring', 'summer', 'autumn', 'winter'])).optional(),
    tags: z.array(z.string().max(40)).max(30).optional(),
  })
  .catchall(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));
export type GarmentAttributes = z.infer<typeof GarmentAttributes>;

/** The garment record as returned by the API (section 5 "Garments"). */
export const Garment = z.object({
  garmentId: OpaqueId,
  name: z.string().min(1).max(120),
  category: Category,
  roles: z.array(GarmentRole).min(1),
  maker: z.string().max(120).nullable(),
  productName: z.string().max(200).nullable(),
  productCode: z.string().max(120).nullable(),
  fabric: z.string().max(200).nullable(),
  color: z.string().max(80).nullable(),
  colorFamily: z.string().max(40).nullable(),
  pattern: z.string().max(80).nullable(),
  sizeLabel: z.string().max(60).nullable(),
  careChannel: CareChannel,
  laundryPolicy: LaundryPolicy,
  tracking: StockTracking,
  acquisition: AcquisitionState,
  disposalReason: DisposalReason.nullable(),
  planningPolicy: PlanningPolicy,
  condition: GarmentCondition,
  location: LocationKind,
  locationDetail: z.string().max(200).nullable(),
  attributes: GarmentAttributes,
  notes: z.string().max(4000).nullable(),
  /** Date from which wear history is considered reliable. Zero wears before it means "not recorded". */
  wearLoggingSince: LocalDate.nullable(),
  version: z.number().int().positive(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type Garment = z.infer<typeof Garment>;

export const GarmentAlias = z.object({
  aliasId: OpaqueId,
  garmentId: OpaqueId,
  phrase: z.string().min(1).max(200),
  kind: AliasKind,
  source: z.string().max(200).nullable(),
});
export type GarmentAlias = z.infer<typeof GarmentAlias>;

export const GarmentFact = z.object({
  factId: OpaqueId,
  garmentId: OpaqueId,
  field: z.string().max(80),
  value: z.unknown(),
  sourceKind: FactSourceKind,
  sourceRef: z.string().max(500).nullable(),
  observedAt: Instant,
  confidence: z.number().min(0).max(1).nullable(),
  scope: z.string().max(200).nullable(),
  supersededBy: OpaqueId.nullable(),
});
export type GarmentFact = z.infer<typeof GarmentFact>;

/** Result of resolving an owner phrase to garments. Ambiguity is explicit, never first-match. */
export const AliasResolution = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), phrase: z.string(), garmentId: OpaqueId, name: z.string() }),
  z.object({
    status: z.literal('ambiguous'),
    phrase: z.string(),
    candidates: z.array(z.object({ garmentId: OpaqueId, name: z.string(), distinguishing: z.string() })).min(2),
  }),
  z.object({ status: z.literal('not_found'), phrase: z.string() }),
]);
export type AliasResolution = z.infer<typeof AliasResolution>;
