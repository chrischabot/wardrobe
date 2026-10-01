/**
 * @garderobe/contracts - the versioned shared contract between the backend modules,
 * the HTTP API, the MCP server and the native client.
 *
 * Foundation-owned. Other workstreams add contract modules under `src/ext/<workstream>.ts`
 * (imported as `@garderobe/contracts/ext/<workstream>`); the generator picks them up
 * automatically, so nobody needs to edit this file.
 */
export * from "./version.ts";
export * from "./primitives.ts";
export * from "./garment.ts";
export * from "./availability.ts";
export * from "./style.ts";
export * from "./settings.ts";
export * from "./commands.ts";
export * from "./inventory.ts";
