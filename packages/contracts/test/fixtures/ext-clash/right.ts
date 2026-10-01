/** Test fixture: two lanes that export different schemas under one name (see left.ts). */
import { z } from "zod";

export const Connection = z.object({ socketId: z.string() });
