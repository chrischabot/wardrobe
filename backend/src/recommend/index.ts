/**
 * Public interface of the recommendation service (daily boards, validation, swaps, repair).
 * The API/MCP layer and the assistant import from here.
 */
export { RecommendationService, newRunId, optionEvidence, type RecommendationDeps, type PublishOutcome, type RevisionOutcome, type ChangeRecord, type SwapRequest, type SwapCandidatesRequest, type SwapCandidate } from './service.js';
export { assembleContext, contextEvidence, revalidationWatermark, CONTEXT_VERSION, type ComposeRequest, type MandatoryContext, type SourceStamp, type ContextDeps } from './context.js';
export { composeBoard, eligiblePools, pinStatus, selectBoard, selectBoardDetailed, tasteScore, suitsOccasion, type CandidateProposer, type ComposedBoard, type ScoredOption, type ComposeOptions, type PinStatus, type BoardSelection, type SelectOptions } from './compose.js';
export { buildComfortContext, situationMatch, type ComfortContext, type ComfortDirection, type ComfortObservation } from './comfort.js';
export { validateOutfit, validateBoard, registersOf, isSafePermutation, partsOf, type Candidate, type CandidateSlot, type Check, type OutfitValidation, type OutfitParts, type ValidateOptions } from './validate.js';
export { compileProfilePolicy, ruleRef, type ProfilePolicy, type RuleRef } from './profile.js';
export { jointAvailability, loadEstimatorBoardDays, type JointInput } from './joint.js';
export { buildDocument, renderBoardText, whySentence, dayLineOf, checkProse, linesOf, type ProseWriter, type ProseWriterInput } from './document.js';
export { publishValidatedRevision, getDailyBoard, getRevisionRecord, managedEventId, type PublishRevisionInput, type PublishConflict } from './publish.js';
export { familiesOf, thermalBand, type WardrobeGarment, type ThermalBand } from './garments.js';
