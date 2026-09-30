import { getAgentByName } from 'agents';
import type { Env } from '../env.js';
import { assertPrincipal, type Principal } from '../domain/principal.js';
import type { GarderobeAssistant } from './agent.js';

/**
 * Public interface of the assistant for the API/MCP workstream and scheduled work.
 *
 * - `assistantFor(env, principal)` returns the owner's continuous-conversation actor. The actor name
 *   derives from environment + internal user id only; callers never pass a user id from a request.
 * - Conversational turns: `submitTurn({ clientTurnId, text, channel, attachments?, captureIntent?,
 *   askAbout?, grant })` -> TurnReceipt (a resubmitted clientTurnId returns the existing turn);
 *   `getTurn(clientTurnId)`, `stop()`, `stopAndSend(input)`, `waitForIdle()`.
 *   Pass `grant: { scopes, authenticatedBy }` from the authenticated connection (a read-only MCP grant
 *   gets read-only tools).
 * - Background results: `deliverResult({ deliveryId, card })` appends one settled card at a message
 *   boundary without an inference turn; duplicates are ignored.
 * - Transcript: `rawTranscript()` (original messages), `workingHistory()` (compacted view),
 *   `forgetMessage(id)`.
 * - Deterministic native commands do NOT go through the assistant: call the CommandService directly.
 */
export type AssistantActor = Pick<
  GarderobeAssistant,
  'submitTurn' | 'stopAndSend' | 'stop' | 'getTurn' | 'deliverResult' | 'waitForIdle' | 'rawTranscript' | 'workingHistory' | 'compactNow' | 'forgetMessage' | 'runtimeInfo'
>;

export function assistantActorName(environment: string, userId: string): string {
  return `${environment}:${userId}`;
}

export async function assistantFor(env: Pick<Env, 'ASSISTANT' | 'ENVIRONMENT'>, principal: Principal): Promise<AssistantActor> {
  assertPrincipal(principal);
  return (await getAgentByName(env.ASSISTANT as never, assistantActorName(env.ENVIRONMENT, principal.userId))) as unknown as AssistantActor;
}

export { GarderobeAssistant, SubmitTurnInput, type TurnReceipt, type ResultCard } from './agent.js';
export { buildMandatoryContext, defaultDayContext, type MandatoryContext, type DayContextProvider, type DayContext, type TurnFacts } from './context.js';
export { classifyTurnIntent, findHealingStatement, quoteInOwnerText, type TurnIntent, type CommandFamily, type CaptureIntent } from './intent.js';
export { executeTool, buildToolSet, runCommand, TOOL_SPECS, BUILTIN_TOOL_NAMES, type ToolContext, type ToolOutcome, type AssistantServices } from './tools.js';
export { dailyServiceDayContext, validateOutfitProposal, installTestDailyProviders, recommendationsFor, type OutfitCard, type ProposalSlot, type DailyProviders, type DailyRecommendations, type RecommendationsFactory } from './day-context.js';
export { ASSISTANT_POLICY, PROMPT_VERSION } from './policy.js';
export { createModelService, createRecallService, installTestModelTransport, clearTestModelTransport, usesSimulatedModel } from './runtime.js';
export { registerActionIntent, reconcilePendingIntents, actionIntentsFor } from './actions.js';
export { TurnLedger } from './turns.js';
