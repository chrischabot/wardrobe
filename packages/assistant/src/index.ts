/**
 * @garderobe/assistant - the conversational assistant.
 *
 * What apps/worker mounts:
 *   - `registerAssistant(registry)`: assistant-lane commands on the shared command service.
 *   - `GarderobeAssistant`: the Think Durable Object (binding `ASSISTANT`, SQLite class).
 *   - `configureAssistant({ registry, ports })`: hand the actor the composed registry and optional ports.
 *   - `assistantClient(env, principal)`: the only way to reach the actor (addressed by the verified user ID).
 *   - reads `(db, principal, ...)` and export/import helpers.
 */
export { registerAssistant, ASSISTANT_HANDLERS } from "./commands/index.ts";
export { GarderobeAssistant, GarderobeAssistantBase, compactionThresholdFor, configureAssistant, type AssistantConfiguration, type AssistantEnv, type ConversationBackup, type ConversationExport } from "./agent/assistant.ts";
export { SubmissionReuseError } from "./agent/turns.ts";
export { assistantClient, AssistantRequestError, type AssistantClient } from "./client.ts";
export * from "./queries.ts";
export { exportAssistantData, importAssistantData, type AssistantExport } from "./export.ts";

export { ModelService, BudgetExceededError, NoSelectableProfileError, InferenceFailedError, classifyError, BREAKER_THRESHOLD, type ModelServiceDeps, type RunScope, type ModelCallMeta } from "./inference/service.ts";
export { PROFILE_SPECS, TASK_SPECS, DEFAULT_DAILY_BUDGETS, profileSpec, selectability, type ProfileSpec, type TaskSpec } from "./inference/registry.ts";
export { createGatewayModel, createGatewayModelService, assertGatewayId, gatewayMetadata, ALLOWED_GATEWAY_IDS, GatewayConfigError } from "./inference/gateway.ts";
export { reconcileInferenceReservations, ABANDONED_AFTER_MS, LOOKUP_NOT_BEFORE_MS, LOOKUP_WINDOW_MS, type ProviderUsageLookup, type ProviderUsageFinding, type DispatchedCall, type ReconcileDeps, type ReconcileResult } from "./inference/reconcile.ts";
export { createGatewayLogsLookup, type GatewayLogsOptions } from "./inference/gateway-usage.ts";
export { createCompositionModel, parseCandidates, type CompositionRequest, type CompositionCandidate } from "./inference/composition.ts";

export { assembleMandatoryContext, ASSISTANT_POLICY, ASSISTANT_PROMPT_VERSION, estimateTokens, type MandatoryContext } from "./context/mandatory.ts";
export { ownerAuthoredText, isDirectReport } from "./policy/voice.ts";
export { classifyChange, mayCommitFromConversation, OBSERVATION_TYPES, type ChangeClass } from "./policy/classes.ts";
export { resolveOwnerNaming, type OwnerNaming } from "./policy/naming.ts";
export { describeChange } from "./policy/describe.ts";
export { redactSecrets, redactDeep, SECRET_PLACEHOLDER } from "./policy/secrets.ts";
export { recall, indexMessages, indexWatermark, extractJudgements, type CanonicalMessage, type RecallInput } from "./recall/index.ts";
export { resolveDateRange } from "./recall/temporal.ts";
export { runSearchProjection, buildSearchDocument, SEARCH_TOPICS, type SearchProjectionResult } from "./recall/projection.ts";
export { AiSearchIndex, provisionSearchInstance, eraseSearchInstance, instanceNameFor, splitDocument, SEARCH_METADATA_FIELDS, type SearchIndexPort, type SearchDocument } from "./recall/ai-search.ts";
export type { AssistantPorts, TurnRuntime } from "./tools/runtime.ts";
export * as research from "./research/index.ts";
export { McpHttpClient, ConnectionError, searchProviderFor, extractBackendFor, argsFromSchema, type ConnectionRuntime, type McpClientOptions } from "./connections/mcp.ts";
export { runAssistantMaintenance, type MaintenanceDeps, type MaintenanceResult } from "./maintenance.ts";

export { wearAnalysis, displacementFor, ledgerMaterial, recheckPremises, LEDGER_SECTIONS, type WearAnalysis, type Displacement, type LedgerMaterialPage, type PremiseCheck, type ProspectivePiece } from "./analysis.ts";
export { GoogleApi, GOOGLE_SCOPES, createGmailSource, createDriveClient, createSheetsClient, purchaseQueries, htmlToText, decodeBase64Url, type GoogleApiOptions, type GmailSource, type DriveClient, type DriveFile, type SheetsClient } from "./connections/google.ts";
export { createBrowserRunBackend, type BrowserRunBackend, type BrowserRunBinding, type BrowserRunOptions, type BrowserQuickAction } from "./connections/browser-run.ts";
export { checkConnectionHealth, mcpProbe, googleProbe, type ConnectionProbe, type HealthCheckDeps, type HealthCheckResult, type HealthPhase } from "./connections/health.ts";
export { runPurchaseInvestigation, minimumExcerpt, OrderEmailExtraction, PurchaseInvestigationParams, ORDER_FACT_SCHEMA_VERSION, type PurchaseInvestigationDeps, type PurchaseInvestigationResult } from "./jobs/purchases.ts";
export { runAssistantJob, runPendingAssistantJobs, handleAssistantJobQueue, runAssistantJobStep, ASSISTANT_JOB_KINDS, type AssistantJobDeps, type AssistantJobMessage, type JobRunOutcome } from "./jobs/runner.ts";
