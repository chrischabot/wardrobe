/** Test fixture: two lanes that export different schemas under one name (see right.ts). */
import { z } from "zod";

export const Connection = z.object({ connectionId: z.string(), provider: z.string() });
