/**
 * @garderobe/domain - the domain ledger and the single command service.
 *
 * Public surface for every other workstream. Import from here (or from the documented subpaths
 * `@garderobe/domain/testing`, `@garderobe/domain/import`); do not reach into internal files.
 */
export { CommandService, type CommandServiceOptions } from "./commands/service.ts";
export { CommandRegistry } from "./commands/registry.ts";
export { createFoundationRegistry } from "./foundation.ts";
export type { CommandContext, CommandDefinition, CommandPlan, CommitHook, DomainChanges, PlanFragment, PlannedEffect, PlannedOutbox, Precondition, StoredCommand, VersionResolver } from "./commands/types.ts";
export { noChanges } from "./commands/types.ts";
export { CommandError, isCommandError } from "./errors.ts";
export { createPrincipal, assertPrincipal, requireScope, type Principal } from "./principal.ts";
export { stmt, all, first, allIn, prepare, json, type Db, type Stmt } from "./db.ts";
export * from "./util.ts";

// Stock accounting primitives
export { StockPlanner, explainGarmentStock, type GarmentRow, type StockBuild, type PlannedGarmentStock } from "./stock/planner.ts";
export { replayGarment, toBalances, ownedUnits, emptyState, sortEvents, type StockEvent, type StockEventKind, type StockState, type ReplayResult, type ReplayMovement, type BalanceRow } from "./stock/replay.ts";

// Availability estimator (pure) and its D1-backed readers
export * from "./availability/estimator.ts";

// Handler building blocks other workstreams compose into their own commands
export { define } from "./handlers/garments.ts";
export { loadGarment, loadGarments, stockParts, simpleStockUndo, undoStockEvents, bumpGarment, nameList } from "./handlers/common.ts";
export { exposurePublish, exposureSelect, exposureSupersede } from "./handlers/style.ts";
export { dueCycleKeys, cycleCutoffMs } from "./handlers/wear-care.ts";

// Reads
export * from "./queries.ts";

// Owners, identity mapping, action intents, effects, outbox
export * from "./platform.ts";
