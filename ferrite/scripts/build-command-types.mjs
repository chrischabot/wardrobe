// Writes src/seed/command-types.json: how the TypeScript service describes each command type this port
// executes (`describeCommandTypes` in apps/worker/src/routes/core.ts): its class, required scope,
// allowed authorizations and payload JSON Schema, from the same registry the Worker composes
// (packages/domain's foundation registry plus packages/daily's board commands). The Rust app embeds
// the file and narrows it to what the port's own handlers accept (src/command_types.rs), so the
// schemas are never retyped in Rust.
//
//   node --experimental-transform-types ferrite/scripts/build-command-types.mjs          # write
//   node --experimental-transform-types ferrite/scripts/build-command-types.mjs --check  # exit 1 when stale
//
// Run from the wardrobe repository root (Node 22.7 or later; the domain package uses TypeScript
// parameter properties, which strip-only mode refuses). `consequential` is not taken from the
// TypeScript policy: the port computes it from its own connected-assistant rules.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const { createFoundationRegistry } = await import(path.join(repo, "packages/domain/src/index.ts"));
const { registerDaily } = await import(path.join(repo, "packages/daily/src/index.ts"));
// The zod the command schemas were built with, as the Worker resolves it.
const { z } = await import(createRequire(path.join(repo, "apps/worker/package.json")).resolve("zod"));

// `ledger::COMMAND_TYPES` in src/ledger.rs; tests/command_types.rs holds the two lists equal.
const PORTED = ["care.mark_dirty", "care.washed", "command.undo", "board.publish", "board.select", "board.swap_slot", "laundry.collect", "laundry.return", "wear.record"];

const registry = createFoundationRegistry();
registerDaily(registry);
const types = PORTED.slice()
  .sort()
  .map((type) => {
    const def = registry.get(type);
    // As describeCommandTypes writes it.
    const payloadSchema = z.toJSONSchema(def.schema, { io: "input", unrepresentable: "any" });
    return { type, class: def.class, requiredScope: def.requiredScope, authorizations: registry.allowedAuthorizations(def), payloadSchema };
  });

const text =
  "{\n" +
  `  "generatedBy": ${JSON.stringify("ferrite/scripts/build-command-types.mjs from the Worker's command registry (packages/domain, packages/daily)")},\n` +
  '  "types": [\n' +
  types.map((t) => `    ${JSON.stringify(t)}`).join(",\n") +
  "\n  ]\n}\n";

const out = path.join(repo, "ferrite/src/seed/command-types.json");
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(out, "utf8");
  } catch {}
  if (current !== text) {
    console.error("ferrite/src/seed/command-types.json is stale: run node --experimental-transform-types ferrite/scripts/build-command-types.mjs");
    process.exit(1);
  }
  console.log(`command types are up to date: ${types.length} types`);
} else {
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ferrite/src/seed/command-types.json: ${types.length} types`);
}
