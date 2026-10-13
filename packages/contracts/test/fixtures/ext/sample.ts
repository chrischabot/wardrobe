/**
 * Test fixture standing in for a workstream's `src/ext/<workstream>.ts` contract module.
 * Not part of the contract: it only proves the generator picks extension modules up.
 */
import { z } from "zod";
import { GarmentId } from "../../../src/primitives.ts";

export const SampleExtNote = z.object({
  noteId: z.string(),
  garmentId: GarmentId,
  mood: z.enum(["calm", "bold"]),
  tags: z.array(z.string()).default([]),
});

/** Exports that are neither zod schemas nor command maps must be ignored. */
export const SAMPLE_EXT_LIMIT = 3;

/** A lane's command map: each payload gets a typed `Command*` form and its type joins `commandTypes`. */
export const SAMPLE_COMMANDS = { "sample.add_note": SampleExtNote } as const;
