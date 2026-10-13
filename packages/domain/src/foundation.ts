import { CommandRegistry } from "./commands/registry.ts";
import { garmentHandlers } from "./handlers/garments.ts";
import { wearCareHandlers } from "./handlers/wear-care.ts";
import { styleHandlers } from "./handlers/style.ts";
import { commandUndo } from "./handlers/undo.ts";
import { importRecordRun } from "./handlers/import.ts";

/**
 * A registry with every foundation command, the foundation version resolvers and no commit hooks.
 * Each workstream receives this registry and registers its own commands, resolvers and hooks on it:
 *
 *   const registry = createFoundationRegistry();
 *   registerDailyService(registry);   // owned by the daily-service workstream
 *   const service = new CommandService({ db: env.DB, registry });
 */
export function createFoundationRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const def of [...garmentHandlers, ...wearCareHandlers, ...styleHandlers, importRecordRun]) registry.register(def);
  registry.register(commandUndo(registry));

  registry.registerVersionResolver("garment", (userId, id) => ({ sql: "SELECT version FROM garments WHERE user_id = ? AND garment_id = ?", params: [userId, id] }));
  registry.registerVersionResolver("wardrobe", (userId) => ({ sql: "SELECT wardrobe_revision FROM owner_state WHERE user_id = ?", params: [userId] }));
  registry.registerVersionResolver("style", (userId) => ({ sql: "SELECT style_revision FROM owner_state WHERE user_id = ?", params: [userId] }));
  registry.registerVersionResolver("settings", (userId) => ({ sql: "SELECT version FROM owner_settings WHERE user_id = ?", params: [userId] }));
  registry.registerVersionResolver("style_document", (userId, id) => ({
    sql: "SELECT version FROM style_documents WHERE user_id = ? AND document_id = ? AND status = 'active'",
    params: [userId, id || "owner-profile"],
  }));
  return registry;
}
