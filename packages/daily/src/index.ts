/**
 * @garderobe/daily - the daily service.
 *
 * `registerDaily(registry)` adds the board, pause, trip and snapshot commands, the `board` and `trip`
 * version resolvers and the in-commit board repair hook to the shared command registry. Everything
 * else here is a function the API/MCP, assistant and visual-wardrobe workstreams mount or call.
 */
import type { CommandRegistry } from "@garderobe/domain";
import { registerBoardCommands } from "./boards.ts";
import { registerPauseCommands } from "./pause.ts";
import { boardRepairHook } from "./repair.ts";
import { registerSnapshotCommands } from "./snapshots.ts";
import { registerTripCommands } from "./trips.ts";

export function registerDaily(registry: CommandRegistry): void {
  registerBoardCommands(registry);
  registerPauseCommands(registry);
  registerTripCommands(registry);
  registerSnapshotCommands(registry);
  registry.addCommitHook("daily.board_repair", boardRepairHook);
}

export { DAILY_SERVICE_VERSION, COMPOSER_VERSION } from "./version.ts";
export type { DailyDeps } from "./deps.ts";
export * from "./ports.ts";

// Reads
export { getToday, getBoard, getPauseState, renderBoardHtml, renderBoardDocumentHtml, renderBoardCalendarText, optionLines, boardSummary, type BoardRef } from "./document.ts";
export { listTrips, getTrip } from "./trips.ts";
export { validateOutfit, suggestOutfits, outfitValidator, temperaturePreview } from "./service.ts";

// Composition-driven operations (they commit through board.publish / trip.record_packing_proposal)
export { prepareBoard, recommend, rebuildDay, rebuildOption, replenishBoards, reviseBoard, type PrepareBoardOptions, type PrepareBoardResult, type RecommendInput, type RecommendResult, type ReplenishResult } from "./service.ts";
export { proposePacking, prepareTripDayBoard } from "./trips.ts";
export { resumeService, MORNING_REMINDER_EFFECT_KIND } from "./pause.ts";

// Scheduled entry points
export { runDueJobs, runOwnerPhase, phaseSchedule, PHASES, type Phase, type PhaseRun } from "./schedule.ts";
export { projectCalendarEffects, mergeDescription, REVISION_PROPERTY, BOARD_PROPERTY, type ProjectionOutcome } from "./calendar/projector.ts";
export { CALENDAR_EFFECT_KIND, projectionTarget } from "./boards.ts";

// Weather skill and source snapshots
export { fetchWeatherSnapshot, readCalendarSnapshot, weatherForecast, weatherCompareLocations, weatherCacheKey, resolveLocation } from "./snapshots.ts";
export { WEATHER_SKILL, WEATHER_TOOLS } from "./weather/skill.ts";
export { buildWeatherSnapshot, materialChange } from "./weather/assess.ts";

// Real adapters (isolated behind the ports)
export { createOpenMeteoProvider, createOpenMeteoGeocoder, OPEN_METEO_ATTRIBUTION } from "./weather/open-meteo.ts";
export { createWeatherKitProvider, WEATHERKIT_ATTRIBUTION, WEATHERKIT_LEGAL_ATTRIBUTION_URL } from "./weather/weatherkit.ts";
export { createGoogleCalendar } from "./calendar/google.ts";
export { managedEventId, isValidGoogleEventId } from "./calendar/event-id.ts";
export { weighEvents, relevantEvents, suitableMajority } from "./calendar/influence.ts";

// Building blocks for the assistant and test workstreams
export { assembleContext, type AssembleOptions, type Overlay } from "./context.ts";
export { renderContextText, renderContextData } from "./context-text.ts";
export { validateCandidate, garmentViolations, type ValidateOptions } from "./validate.ts";
export { composeBoard, eligibleFor, factualReason, verifyExplanation, findReplacement, type ComposedOption, type ComposeOptions, type ComposeResult } from "./compose.ts";
export { buildRuleSet, type RuleSet } from "./rules.ts";
export { colourFamily, type PoolGarment, type RecommendationContext } from "./model.ts";
export { repairOptions, overlayFromPlan, boardRepairHook } from "./repair.ts";

// Portable export
export { exportDailyData, importDailyData, DAILY_TABLES, DAILY_SHARED_TABLES, type DailyExport } from "./export.ts";
