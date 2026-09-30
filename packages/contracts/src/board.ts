import { z } from 'zod';
import { GarmentRole, Instant, LocalDate, OpaqueId, TimeZone } from './enums.js';
import { BoardDocument } from './board-document.js';

/**
 * Boards and options (section 5 "Boards and options", section 7). The daily-service workstream
 * writes boards; this package fixes the shape so selection commands, the API and MCP agree.
 */

export const OutfitSlot = z.object({
  garmentId: OpaqueId,
  role: GarmentRole,
  /** Slots sharing an alternative group are mutually exclusive choices (e.g. two footwear options). */
  alternativeGroup: z.string().max(40).nullable(),
});
export type OutfitSlot = z.infer<typeof OutfitSlot>;

export const OutfitOption = z.object({
  optionId: OpaqueId,
  boardId: OpaqueId,
  revision: z.number().int().positive(),
  /** Display position within this board revision; durable identity is optionId. */
  position: z.number().int().positive(),
  slots: z.array(OutfitSlot).min(1),
  explanation: z.string().max(2000),
  status: z.enum(['offerable', 'reserve', 'withdrawn']),
  validation: z.record(z.string(), z.unknown()),
});
export type OutfitOption = z.infer<typeof OutfitOption>;

export const DayBrief = z.object({
  text: z.string().max(2000).nullable(),
  occasion: z.string().max(200).nullable(),
  requestedCount: z.number().int().min(1).max(10).nullable(),
  wearingInterval: z.object({ start: z.string(), end: z.string() }).nullable(),
});
export type DayBrief = z.infer<typeof DayBrief>;

export const Board = z.object({
  boardId: OpaqueId,
  boardDate: LocalDate,
  timezone: TimeZone,
  purpose: z.string().max(80),
  currentRevision: z.number().int().nonnegative(),
  brief: DayBrief,
  status: z.enum(['draft', 'published', 'suppressed', 'archived']),
  options: z.array(OutfitOption),
  version: z.number().int().positive(),
  publishedAt: Instant.nullable(),
  /** Semantic outfit document of this revision (additive; absent on boards written without the daily service). */
  document: BoardDocument.nullable().optional(),
});
export type Board = z.infer<typeof Board>;

export const Selection = z.object({
  selectionId: OpaqueId,
  boardId: OpaqueId,
  optionId: OpaqueId,
  boardRevision: z.number().int().positive(),
  footwearGarmentId: OpaqueId.nullable(),
  selectedForDate: LocalDate,
  status: z.enum(['active', 'superseded', 'cleared']),
  createdAt: Instant,
  version: z.number().int().positive(),
});
export type Selection = z.infer<typeof Selection>;
