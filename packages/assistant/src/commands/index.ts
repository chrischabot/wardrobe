import type { CommandRegistry } from "@garderobe/domain";
import { purchaseHandlers } from "./purchases.ts";
import { researchHandlers } from "./research.ts";
import { returnHandlers } from "./returns.ts";
import { lifecycleHandlers } from "./lifecycle.ts";
import { feedbackHandlers } from "./feedback.ts";
import { memoryHandlers } from "./memory.ts";
import { inferenceHandlers } from "./inference.ts";
import { connectionHandlers, jobHandlers } from "./connections.ts";
import { reminderHandlers } from "./reminders.ts";

export const ASSISTANT_HANDLERS = [
  ...purchaseHandlers,
  ...researchHandlers,
  ...returnHandlers,
  ...lifecycleHandlers,
  ...feedbackHandlers,
  ...memoryHandlers,
  ...inferenceHandlers,
  ...connectionHandlers,
  ...jobHandlers,
  ...reminderHandlers,
];

const RESOLVERS: [kind: string, table: string, idColumn: string][] = [
  ["order", "orders", "order_id"],
  ["return_case", "return_cases", "case_id"],
  ["lifecycle_project", "lifecycle_projects", "project_id"],
  ["connection", "connections", "connection_id"],
  ["job", "assistant_jobs", "job_id"],
  ["memory_conclusion", "memory_conclusions", "conclusion_id"],
  ["research_note", "research_notes", "note_id"],
  ["product", "products", "product_id"],
  ["reminder", "reminders", "reminder_id"],
];

/**
 * Registers every assistant-lane command and its expected-version resolvers on the shared registry.
 * `apps/worker` composes the lanes: `const registry = createFoundationRegistry(); registerAssistant(registry);`
 */
export function registerAssistant(registry: CommandRegistry): CommandRegistry {
  for (const def of ASSISTANT_HANDLERS) registry.register(def);
  for (const [kind, table, idColumn] of RESOLVERS) {
    registry.registerVersionResolver(kind, (userId, id) => ({ sql: `SELECT version FROM ${table} WHERE user_id = ? AND ${idColumn} = ?`, params: [userId, id] }));
  }
  return registry;
}
