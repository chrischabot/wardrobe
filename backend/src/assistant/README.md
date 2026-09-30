# Assistant and integrations

Server-side assistant for Garderobe (spec sections 3, 4, 6, 8, 10, 12, 13, 15, 17). Directories: `assistant/`, `models/`, `recall/`, `connectors/`, `research/`, `intake/`, `lifecycle/`, `export/`. Migration: `migrations/0010_assistant.sql`.

## Runtime (real packages, pinned)

`@cloudflare/think` 0.19.0, `agents` 0.24.0, `ai` 7.0.122, `@ai-sdk/provider` 4.0.19, `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/sdk` 1.30.0 (a peer that `agents` requires). `GarderobeAssistant` (the `ASSISTANT` Durable Object) extends `Think`, with `sendReasoning = false`, `includeMcpTools = false`, `workspaceBash = false` and `maxSteps = 8`. There is one actor per internal user: `${ENVIRONMENT}:${userId}`.

## Interface for the API/MCP layer (`@garderobe/backend/assistant`)

```ts
const a = await assistantFor(env, principal);            // never pass a user id from a request
await a.submitTurn({ clientTurnId, text, channel: 'conversation' | 'mcp', attachments?, captureIntent?, askAbout?, references?, grant: { scopes, authenticatedBy } });
await a.getTurn(clientTurnId);   // status queued|running|completed|cancelled|failed, result text, failure, profileVersion
await a.stop(); await a.stopAndSend(input); await a.waitForIdle();
await a.deliverResult({ deliveryId, card: { kind, title, summary, jobRef } });   // no inference turn
await a.rawTranscript(); await a.workingHistory(); await a.forgetMessage(id);
```

- A resubmitted `clientTurnId` returns the existing turn. The same id with a different body returns `error.code = 'idempotency_key_reused'`. Refusals come back as `receipt.error` and are never thrown across the RPC boundary.
- Pass the grant from the authenticated connection. With a read-only MCP grant, the assistant can read but not change anything.
- Deterministic native commands (the In the wash button, Arrived, …) go straight to `CommandService`, never through the assistant.
- Direct tool execution without a model (for MCP tools, tests and Code Mode) is `executeTool(name, input, ctx)` with the same policy.
- `GarderobeAssistant.dayContext` accepts an injected `DayContextProvider`. The default is `dailyServiceDayContext` (`assistant/day-context.ts`): before each turn, trusted code calls `RecommendationService.context({ date })` from `@garderobe/backend/recommend` for weather (with fetch and issue times), the calendar day brief, availability and recent wear, and `getDailyBoard` for the published board. If the daily service returns nothing, the turn gets the published board alone, and the section is labelled `Today (FALLBACK: daily service context unavailable)`. Providers default to Open-Meteo and no calendar (the same as `createDailyService`); tests install fakes with `installTestDailyProviders`.
- Outfit proposals: the model must use the `propose_outfit` tool, which calls `RecommendationService.validateProposal`. The resulting `OutfitCard` has `actionable` set by the validator alone, and a rejected card names the failed rules. Cards are stored with the turn (`getTurn(id).result.cards`); show only these as outfit cards. `getTurn` also returns `contextDigest`, and `result.day` gives `{ sources, fallback }`.
- Ask about this: pass `references` (the contract's `ConversationReference[]`: `{kind:'garment', garmentId}` or `{kind:'option', boardId, optionId, boardRevision}`). At acceptance trusted code resolves each one against the owner's records and stores `{...ref, found, display: {label, garments[]}}` in the Session user message's `metadata.references` (`assistant/references.ts`). The turn context lists them, recall indexes `Asked about: ...` with the names, and `GET /v1/conversation/messages` renders them as `reference` parts. An unresolvable reference is kept and marked not found. The legacy `askAbout` still works and is converted to a reference.
- Conversational grounding (`assistant/grounding.ts`, `domain/healing.ts`): the healing restriction lifts only on the owner's own first-person, unhedged statement in his own words (quoted, forwarded, fenced or `>` text, second-person and reported speech never count); the `lift_restriction` command handler applies the same rule to its evidence for every channel. `amend_profile` needs a substantial quote of his own words and refuses amendment text that adds claims he did not make. `set_temporary_brief` from conversation must fit a date window his words name (today, tomorrow, a weekday, this weekend or week, explicit dates, his planned trip).

Other services: `connectionRegistry(env, principal)` (outbound MCP), `EmailIntakeService` (`@garderobe/backend/intake`), `ResearchService` / `createResearchService` (`/research`), `issueRecoveryCredential`, `recoverWithCredential`, `isSessionValid`, `isGrantValid` (`/lifecycle`), `exportOwnerData`, `verifyExport`, `importExport` (`/export`), `createModelService` (`/assistant`), `ModelRegistry` (`/models`).

New commands in the shared `CommandService`: `import_order`, `record_order_event`, `record_return_terms`, `record_comfort_feedback`, `open_lifecycle_project`, `advance_lifecycle_project` (contracts: `lifecycle-commands.ts`).

Return deadlines (`lifecycle/deadlines.ts`, migration `0012_order_line_arrivals.sql`): `mark_arrived` records `order_lines.arrived_at`. A delivery-based `record_return_terms` refuses while nothing has arrived and otherwise counts from the recorded arrival, whatever date the caller supplied (the stated date is kept as `statedTrigger`). A later arrival on the same line recalculates its open delivery deadlines inside the arrival's own receipt (`facts.recalculatedDeadlines`), and undoing the arrival restores them.

Export and import: `app_sessions` and `native_auth_codes` are never exported; token-hash, code-challenge and provider-grant columns are stripped; `verifyExport` reports any credential table or column (so `importExport` refuses such a package). Import revokes every MCP grant (`revoked_reason = 'restored from an export; reconnect to authorize'`), cancels pending confirmations, disconnects connections and never creates sessions. CSV views neutralise leading `= + - @`, tab and CR.

Pasted secrets (ADV-17, `assistant/secrets.ts`): `submitTurn` redacts recovery codes (`GRDB.rcv_….<secret>`, retyped variants, the secret part alone), one-time download/collect link tokens, bearer and OAuth tokens, provider keys and 32+ character mixed-case random tokens (outside links) before anything is stored, so the turn ledger, the Think Session, recall, the search index, every model call and the export see only `[recovery code removed]` / `[secret removed]`. The receipt carries `redacted: [{ kind, count }]` when something was removed, and a settled `notice` result card ("Recovery code removed from your message", advising a new code) is appended after the reply. The card's `jobRef` is `message:<owner message id>`, the `messageId` the turn response and the transcript give clients, so the app can tie each card to exactly its own turn and drop its local copy of that note. Cards written before this change carry `turn:<internal turn id>`; clients cannot resolve that form and keep their own notice for those turns. The recall projection and the export apply the same redaction as defence in depth; the export applies only the specific formats (not the generic token rule), so ids that other rows reference stay intact. Garment names, maker codes, sizes and product links are untouched (tested against the owner's real profile and CSV).

## Profile injection and versioning

Every conversational turn assembles its instructions in `beforeTurn` from current D1 state (`assistant/context.ts`), in this order: the policy (including the section 11 advice contract), the precedence statement, every current style document verbatim inside `<owner_profile document_id version sha256>`, active amendments, hard rules (rules whose passage has left the profile are shown as NEEDS REVIEW), standing directions, active restrictions, today's briefs, the day, a compact wardrobe index with real ids, recent recorded wears, and the turn's channel and request policy. Nothing is frozen or cached. Think's frozen system prompt is overridden on every turn, and each turn records its `profile_version` and a context digest. A profile edit, or a chat correction through `amend_profile`, creates a new document version, and the next turn uses it.

The wardrobe index is compact (prompt version `2026-10-02.2`). Each line is `id | name | category`, followed only by what differs from the common case: status, when the piece is not owned, at home and normally planned; availability, always; clean/owned units, unless the piece is one clean unit; and recorded wears, only when some exist. A legend line in the section says so. A restricted piece refers to its restriction by id, and the reason is stated once under Active restrictions. Tool schemas are sent without the `$schema` URL and without zod's generated regex next to a `format` (`models/tool-schema.ts`, applied in `ModelService.generate`). Tool input is still validated against each tool's own zod schema. On the owner's real data the chat request went from 33,067 to 27,747 Claude input tokens (tests: `test/assistant-context-size.test.ts`).

## Model transport notes

- **Workers AI binding.** It reads both reply shapes: the classic `{ response, tool_calls }` and the OpenAI-style `{ choices }`, which kimi-k2.7-code returns. A reply with no text and no tool call is `invalid_output`, never an empty answer. Embedding requests (`task: 'embeddings'`) send `{ text: [...] }`, one entry per user text part, and return `ModelResult.embeddings`, with one vector per text.
- **Failures.** A failed call keeps the provider's HTTP status and message, with credentials and the gateway token redacted. They are stored in `model_runs.error_message` and `provider_status` (migration 0014) and logged as a `model_run_failed` JSON line. The `ModelUnavailableError` message lists each profile's reason. A turn that fails on a non-fallback provider error has the failure `model_<class>: Gateway <status>: <provider message>`.

## Model assignment (owner's choice, 2026-09-29)

The owner chose two chat models, **GPT-6.1 Sol** and **Claude Opus 5.5 at medium effort**, and ruled out defaulting to anything above them. Both run through the `garderobe-dev` gateway with Unified Billing (`models/registry.ts`):

| Profile | Model and route | Effort and wire settings | Price per million tokens (input / output) |
| --- | --- | --- | --- |
| `chat.gpt-6-1-sol` | `gpt-6.1-sol`, OpenAI Responses route `/openai/responses` | `reasoning.effort: medium`; stateless (`store: false`, encrypted reasoning returned with the next tool step); no temperature | $2 / $10 (OpenAI) |
| `chat.opus-5-5-medium` | `claude-opus-5-5`, native Anthropic route `/anthropic/v1/messages` | `output_config.effort: medium`; no temperature; tool choice always `auto` | $4 / $20 (gateway catalogue and Anthropic) |

Neither model runs on the compat endpoint, for reasons verified on `garderobe-dev`:
- **Sol:** chat completions refuses function tools with reasoning for gpt-6.1-sol. The error says to use `/v1/responses`, and effort `none` is refused too. The assistant always offers tools, so Sol runs on the Responses API.
- **Opus:** the compat endpoint silently drops Anthropic's effort parameter. An invalid effort value is accepted there, while the native route rejects it, so Opus runs on the native Anthropic route.

Opus 5.5 thinking cannot be disabled. The transport returns thinking blocks as reasoning parts carrying their signature (`providerMetadata.anthropic`), and they go back to the model with the next tool step. Sol's encrypted reasoning items are handled the same way (`providerMetadata.openai`). Think's `sendReasoning = false` keeps both from clients. Reasoning from any other model is dropped rather than sent.

Assignment by task. The first profile serves; the rest are fallbacks, used only on transport-class failures:

| Task | Chain | Why |
| --- | --- | --- |
| `chat`, routine turns | Sol, then Opus | Dressing, logging, laundry and board questions: capable and cheap |
| `chat`, deep turns (served as `research`) | Opus 5.5 medium, then Sol | Purchase judgments, size charts and fit, provenance and construction, research, keep/sell/alter decisions |
| `composition`, `vision` | Sol, then Opus | Board prose and photos |
| `compaction`, `extraction` | kimi-k2.7-code (Workers AI), then Sol, then Opus | Fractions of a cent per call |
| `embeddings` | bge-m3 (Workers AI) | |
| `generation` | none | |

The depth of a turn is decided by trusted code from the owner's submitted message when the turn starts (`assistant/model-routing.ts`). It is never decided by a model, a tool result or a fetched page, and it grants no command authority. The request's task stays `chat`; `ModelRequest.depth: 'deep'` makes the model service use the `research` chain and record the run as `research` in `model_runs`. Only the owner's own words count, read the same way as the healing statement (`domain/healing.ts` `ownWords`): double-, curly- or single-quoted spans (a calendar title such as "Design review"), forwarded and `>`-quoted blocks are ignored, and "review" means product reviews ("reviews of", "any reviews"), not a meeting. The 28-day simulation sent three routine board questions to Opus because a quoted "Design review" matched; `test/model-selection.test.ts` covers those questions.

**Days in the continuous conversation.** Each owner message in the model's copy of the history starts with a separate stamp, `[Sent Monday 2026-10-05 07:10 Europe/London]`, taken from the turn ledger in his time zone (`assistant/turn-dates.ts`). The policy says an answer from an earlier day described that day and is never to be called wrong or made up because today's weather, board or calendar differ. The stored transcript is unchanged. This follows the simulation, where on 6 October the assistant called its correct 5 October answer "made up".

**Spend.** Every run reserves its worst case from the owner's monthly budget before dispatch (`models/budget.ts`). A deployment can also set `MODEL_SPEND_CAP_USD`, a ceiling over a sliding 30 days across every owner and model, checked in the same conditional insert. The dev deployment sets it to the owner's $50 rule, because the AI Gateway's cost rule does not count gpt-6.1-sol: that model is not in the gateway's price catalogue, so its requests are logged at $0, even with a `cf-aig-custom-cost` header (checked on garderobe-dev, 2026-09-29). The cap prices Sol and Opus at the registry's list rates, so it bounds what the app sends, not the exact Unified Billing charge.

Claude Fable 5.1 ($10 / $50) and DeepSeek remain listed but are assigned to no task and are no one's fallback. A test (`test/model-selection.test.ts`) enables every candidate and checks that no default chain reaches a profile priced above Opus 5.5.

Cost of a typical turn, measured at about 28k input tokens (`test/assistant-context-size.test.ts`), with output at a few hundred tokens:
- Sol: about $0.06.
- Opus 5.5 medium: about $0.12, plus any thinking output at $20 per million.

## Local runs

With `ENVIRONMENT=local` and no `AI_GATEWAY_ACCOUNT_ID`, the assistant uses the deterministic fake model, and every run log shows provider `fake`. Otherwise the AI Gateway transport serves candidate profiles, which stay unavailable until their Gateway and Unified Billing probe passes. There is no direct-provider or BYOK path.

## Recorded probes on a deployment (`MODEL_PROBES`)

A deployed Worker learns which candidate profiles have passed from the `MODEL_PROBES` variable: a JSON object keyed by profile id, each entry `{ status: "passed" | "failed", checkedAt, gatewayId, reason? }`. `applyRecordedProbes` (`models/registry.ts`) applies an entry only when it names a known, non-fake profile and the deployment's own `AI_GATEWAY_ID`. Only an entry with `status: "passed"` makes a profile selectable. A missing, failed, malformed or other-gateway entry leaves it unavailable, and a failed entry shows its reason in the chain's `skipped` list (no silent fallback). The dev deployment writes the variable from `npm run dev:probe -- models`, which calls each profile's own route and model id from inside the deployed Worker (`deploy/scripts/probe.ts`). Tests: `test/model-probes.test.ts`.
