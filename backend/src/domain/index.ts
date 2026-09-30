/**
 * Public interface of the Garderobe domain. Other workstreams (daily service, assistant, API/MCP,
 * test suites) import from here, never from internal files.
 *
 * Every function takes an authenticated Principal and scopes all reads and writes to its userId.
 */
export { CommandService, executeCommand, getReceipt, listReceiptsForEntity, type CommandServiceOptions } from './commands/service.js';
export type { CommandPlan, EffectSpec, HandlerContext, UndoPlan } from './commands/types.js';
export { HANDLERS } from './commands/handlers.js';
export {
  assertPrincipal,
  findForgedOwnerFields,
  hasScope,
  ownerPrincipal,
  readOnlyPrincipal,
  requireScope,
  systemPrincipal,
  OWNER_CHANNELS,
  SCOPE_READ,
  SCOPE_WRITE,
  type Principal,
} from './principal.js';
export { DomainError, type DomainErrorCode } from './errors.js';
export { createUser, resolveIdentity, type CreateUserInput } from './identity.js';
export { listWardrobe, getItemDetail, listDailyWears, resolveAlias, listReceiptsForGarment, type WardrobeQuery } from './queries.js';
export { evaluateEligibility, type Eligibility } from './availability.js';
export {
  estimateAvailability,
  estimateGarment,
  boardWearProbability,
  probabilityFewerThan,
  optionAvailability,
  type EstimatorInput,
  type EstimatorBoardDay,
  type EstimatorGarmentInput,
} from './estimator.js';
export { ensureLaundryResets, listLaundryResets, getLaundryState, loadSettings, routineOf, dueCycles, type LaundryState } from './laundry.js';
export { listRestrictions, restrictionMatches } from './restrictions.js';
export { getStyleContext, getStyleDocument, listStyleDocuments, listStyleRules, PROFILE_PRECEDENCE_STATEMENT, type StyleContext } from './style.js';
export { publishBoardRevision, getBoard, findBoardByDate, getActiveSelection, type PublishBoardInput } from './boards.js';
export { CATEGORY_DEFAULTS, normalizePhrase } from './catalog.js';
export { replay, type MovementParams, type ReplayMovement, type ReplayResult } from './stock/replay.js';
export { localDateOf, zonedInstant, addDays, dayOfWeek, isValidTimeZone } from './time.js';
export { sha256Hex, canonicalJson } from './hash.js';
