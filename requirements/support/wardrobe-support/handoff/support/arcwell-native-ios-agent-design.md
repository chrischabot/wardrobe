# Arcwell Native iOS Agent --- Architecture & Design Notes

## Vision

Build **Arcwell** as a private, native iOS personal-agent app rather
than depending on the ChatGPT or Claude mobile clients for MCP support.

The app would use:

-   **Native SwiftUI iOS client**, distributed privately through
    TestFlight during development.
-   **Cloudflare as the agent/backend runtime**.
-   **DeepSeek V4.1 Flash** (or another server-selected model) for
    reasoning, multimodal understanding, and tool calling.
-   The existing **Garderobe** wardrobe logic and data as a first-class
    toolset.
-   Explicit server-side state for wardrobe history, planned outfits,
    preferences, and conversation memory.
-   Existing MCP endpoints retained as optional adapters for ChatGPT,
    Claude, or other MCP clients in the future.

The core idea is to own the complete read/write loop instead of waiting
for third-party chat apps to support the required MCP capabilities on
mobile.

------------------------------------------------------------------------

## Why This Architecture

The wardrobe assistant needs more than read-only access.

Useful recommendations depend on knowing:

-   What was worn recently.
-   What has already been planned.
-   Which items are available.
-   Item status and wear counts.
-   Style preferences.
-   Upcoming plans and occasions.
-   Which combinations have become repetitive.

It also needs to **write decisions back**:

-   Mark an outfit as worn.
-   Save a planned outfit.
-   Change an item's status.
-   Record new items.
-   Update preferences or metadata.
-   Log feedback on recommendations.

A private Arcwell client removes the dependency on whether ChatGPT or
Claude currently allows arbitrary MCP writes from their mobile apps.

------------------------------------------------------------------------

## Proposed System Architecture

``` text
Native iOS App
    |
    | HTTPS / streaming
    v
Cloudflare Worker / Arcwell API
    |
    +-- Authentication / user identity
    +-- Conversation/session management
    +-- Context & memory assembly
    +-- Agent loop
    |      +-- Model call
    |      +-- Tool selection
    |      +-- Tool execution
    |      +-- Follow-up model call
    +-- Garderobe domain tools
    +-- Wardrobe / wear history / plans / preferences
    +-- Image/file handling
    +-- Model-provider abstraction
           +-- DeepSeek V4.1 Flash
           +-- Future DeepSeek models
           +-- Workers AI
           +-- OpenAI
           +-- Anthropic
           +-- Gemini
```

The **iOS app should be a client, not the agent runtime**. The server
owns prompts, tools, state, model configuration, and the agent loop.

------------------------------------------------------------------------

## Keep Intelligence on Cloudflare

Avoid embedding agent orchestration directly in Swift.

The iOS app should primarily handle:

-   Chat UI and streaming responses.
-   Camera and photo selection.
-   Native notifications.
-   Outfit/item presentation.
-   Quick-action buttons.
-   Authentication/session handling.
-   Local UI state.

Cloudflare should handle:

-   System instructions and model selection.
-   Tool schemas and execution.
-   Conversation history and long-term memory.
-   Garderobe access.
-   Image preparation/storage.
-   Logging and observability.
-   Model fallbacks.

### Benefits

1.  Change models without releasing an iOS update.
2.  Keep API keys and secrets off-device.
3.  Improve prompts and tools instantly.
4.  Centralize state and business logic.
5.  Reuse the backend with future clients.
6.  Test multiple models against identical tools and context.

------------------------------------------------------------------------

## Model Abstraction

Do not tightly couple Arcwell to DeepSeek.

``` ts
interface ModelProvider {
  run(request: AgentRequest): Promise<ModelResponse>
}
```

Configuration could select the provider/model:

``` ts
const model = env.DEFAULT_MODEL ?? "deepseek-flash";
```

Conceptually:

``` text
Arcwell Agent
    +-- DeepSeek adapter
    +-- OpenAI adapter
    +-- Anthropic adapter
    +-- Workers AI adapter
```

DeepSeek V4.1 Flash can be the initial default because its speed, price,
multimodal capabilities, and agent/tool performance make it particularly
interesting for this workload.

------------------------------------------------------------------------

## Garderobe: Separate Domain Logic from MCP

MCP should be an **adapter**, not the core architecture.

Refactor toward:

``` text
                    +--> MCP adapter
                    |
Garderobe Core -----+
                    |
                    +--> Arcwell agent tools
```

Example:

``` ts
export const garderobe = {
  getRecentOutfits,
  getPlannedOutfits,
  searchItems,
  getItem,
  getWearCounts,
  savePlannedOutfit,
  markOutfitWorn,
  updateItemStatus,
  addItem,
}
```

The MCP server exposes those functions as MCP tools. The Arcwell agent
exposes the **same functions** as model/function tools.

This avoids making the internal agent pretend to be an MCP client when
both systems are already under our control.

------------------------------------------------------------------------

## Example Garderobe Tool Surface

### Retrieval

``` text
get_recent_outfits(days)
get_outfit(date)
get_planned_outfits(start_date, end_date)
get_available_items(filters)
search_items(query, filters)
get_item(item_id)
get_item_wear_counts(item_ids)
get_recent_item_usage(item_id)
get_style_preferences()
```

### Mutations

``` text
save_planned_outfit(date, item_ids, notes)
mark_outfit_worn(date, item_ids)
update_item_status(item_id, status)
add_item(item)
remove_planned_outfit(date)
update_style_preferences(...)
```

### Higher-Level Deterministic Functions

``` text
find_underused_items()
find_overused_items()
find_recently_repeated_combinations()
find_items_not_worn_in(days)
calculate_outfit_novelty(...)
```

The model can reason over concise results instead of processing the
entire wardrobe database.

------------------------------------------------------------------------

## Example Agent Interaction

User:

> What should I wear tomorrow? I've got work and then dinner.

Agent:

``` text
1. get_weather(tomorrow)
2. get_recent_outfits(days=14)
3. get_planned_outfits(days=7)
4. get_available_items(...)
5. get_style_preferences()
6. potentially get_item_wear_counts(...)
7. reason about outfit
```

Assistant proposes an outfit.

User:

> Yep, let's do that.

Agent calls:

``` text
save_planned_outfit(date=tomorrow, items=[...])
```

The following day:

> I wore what we planned.

Agent calls:

``` text
get_planned_outfits(today)
mark_outfit_worn(...)
```

The database now contains the fact that those items were worn, affecting
future recommendations. This closes the read/write loop.

------------------------------------------------------------------------

## Memory Architecture

Do **not** treat the chat transcript as the database.

Separate:

``` text
Conversation history
        !=
Wardrobe state
        !=
Wear history
        !=
Planned outfits
        !=
Style preferences
        !=
Long-term personal memory
```

### Context Assembly

For each turn, assemble only useful context:

``` text
System instructions
+ User/style profile
+ Relevant durable memories
+ Recent outfit history
+ Upcoming planned outfits
+ Small recent conversation window
+ Current message
+ Available tool definitions
```

Anything else should be retrieved through tools when needed.

------------------------------------------------------------------------

## Outfit Novelty

Maintain:

-   Last-worn date per item.
-   Wear frequency over 7/30/90 days.
-   Outfit combinations previously worn.
-   Planned future combinations.
-   Similarity between proposed and recent outfits.
-   Item/category rotation.

Expose something like:

``` text
outfit_novelty_score(outfit, recent_window=21)
```

The model can optimize for:

``` text
style fit
+ occasion suitability
+ weather suitability
+ item availability
+ novelty
+ user preferences
```

This directly supports the requirement that next week's outfits should
not simply repeat last week's ideas.

------------------------------------------------------------------------

## Native iOS App

A first version does not need to recreate ChatGPT.

### 1. Chat

Support streaming text, images, tool activity indicators, outfit cards,
and suggested actions.

### 2. Today

Show today's planned outfit, context/weather, an **I wore this** action,
and swap/recommend-another controls.

### 3. Wardrobe

Browse/search by category, colour, season, status, last worn, and wear
count.

### 4. Camera / Photos

Support mirror selfies, photographing individual garments, shopping
comparisons, and visual outfit questions.

### 5. Settings

Initially keep this small: account, notification preferences,
debug/logging controls, and perhaps developer-only model selection.

------------------------------------------------------------------------

## Streaming API

Start simple:

``` http
POST /api/chat
```

Example request:

``` json
{
  "conversationId": "...",
  "message": "What should I wear tomorrow?",
  "attachments": []
}
```

Stream structured events:

``` text
message_started
text_delta
tool_started
tool_finished
outfit_card
text_delta
message_finished
```

SSE is probably sufficient initially. Add WebSockets only if persistent
bidirectional communication becomes genuinely useful.

------------------------------------------------------------------------

## Structured UI Responses

Do not force every response into plain text.

The server can emit semantic UI objects:

``` json
{
  "type": "outfit",
  "title": "Dinner after work",
  "items": [
    {"id": "123", "name": "Navy overshirt"},
    {"id": "456", "name": "Cream trousers"},
    {"id": "789", "name": "White trainers"}
  ],
  "actions": [
    {"type": "save_plan", "label": "Wear this"},
    {"type": "regenerate", "label": "Another outfit"}
  ]
}
```

SwiftUI renders a proper native card. Chat remains excellent for intent
while native controls make common actions fast.

------------------------------------------------------------------------

## Multimodal Opportunities

### Mirror Selfie

> This is what I'm wearing. Log it.

The system can inspect the image, compare visible clothing with
Garderobe, clarify ambiguity when necessary, and call
`mark_outfit_worn`.

### Shopping

> Would this work with my wardrobe?

The agent can understand the photographed item, retrieve relevant
existing pieces, find combinations, identify redundancy, and recommend
whether it adds value.

### Outfit Comparison

> Which works better tonight?

The model combines visual judgment with wardrobe history, occasion,
plans, and preferences.

------------------------------------------------------------------------

## Authentication & Security

Never put model API keys in the iOS bundle.

``` text
iPhone
  |
  | Arcwell user token
  v
Cloudflare
  |
  | provider secret
  v
DeepSeek
```

Cloudflare secrets should hold model-provider and third-party
credentials. Consider signed upload URLs for images rather than proxying
large files unnecessarily.

------------------------------------------------------------------------

## Observability

Store enough information to inspect:

``` text
user turn
model selected
context size
model latency
tool calls
tool arguments
tool results
token usage
errors
final response
```

Be thoughtful about retaining sensitive images or personal data.

An internal trace view should make flows easy to inspect:

``` text
User
  ↓
DeepSeek
  ↓ requested get_recent_outfits
Tool
  ↓ result
DeepSeek
  ↓ requested get_weather
Tool
  ↓ result
DeepSeek
  ↓ final answer
```

------------------------------------------------------------------------

## Model Evaluation Before Committing

Do not assume benchmark performance means V4.1 Flash will match GPT-5.6
Sol specifically for wardrobe advice.

Wardrobe assistance combines taste, personalization, visual
understanding, tool use, instruction following, memory/context use,
creativity, and consistency.

Create an evaluation set of roughly **20--50 real scenarios** from
actual Garderobe usage.

Compare:

``` text
GPT-5.6 Sol
vs.
DeepSeek V4.1 Flash
```

Blind-evaluate:

-   Outfit quality.
-   Originality.
-   Personal fit.
-   Correct use of history.
-   Tool-call accuracy.
-   Image understanding.
-   Latency.
-   Cost.

If DeepSeek is close enough---or preferable---the architectural freedom
and cost advantage may outweigh a modest model-quality difference.

------------------------------------------------------------------------

## Cost Philosophy

At personal-agent scale, optimize primarily for:

1.  Quality.
2.  Reliability.
3.  Latency.
4.  Developer control.
5.  Cost.

Keep context efficient through explicit state, tool retrieval, cached
profile context, image resizing, conversation summarization, and
provider prompt caching where available.

------------------------------------------------------------------------

## TestFlight / Build Strategy

### Stage 1 --- Backend Prototype

No iOS app yet.

``` text
Garderobe Core
+ DeepSeek adapter
+ agent loop
+ simple test harness
```

Prove that DeepSeek reliably uses the existing tools.

### Stage 2 --- Model Evaluation

Run the real wardrobe test set and decide whether DeepSeek quality is
sufficient.

### Stage 3 --- Minimal SwiftUI Client

Build chat, streaming, and authentication. Avoid fancy wardrobe UI
initially.

### Stage 4 --- Native Garderobe Experience

Add outfit cards, Today screen, **I wore this**, wardrobe browser, and
native actions.

### Stage 5 --- Multimodal

Add camera, photo picker, mirror-selfie logging, shopping assistant, and
visual outfit comparison.

### Stage 6 --- Proactive Agent Features

Potential additions:

``` text
morning outfit suggestion
weather-triggered changes
packing suggestions
planned-outfit reminders
laundry/status awareness
wardrobe gaps
seasonal rotation
```

------------------------------------------------------------------------

## Future: Arcwell as the App, Garderobe as a Skill

Rather than making the application narrowly Garderobe-specific, make
**Arcwell** the personal-agent shell:

``` text
Arcwell
  +-- Garderobe
  +-- Calendar
  +-- Travel
  +-- Food
  +-- Notes
  +-- Purchases
  +-- Future personal tools
```

Each domain exposes a clean tool interface. The Arcwell agent decides
which tools to use.

------------------------------------------------------------------------

## Preserve MCP Compatibility

Even if Arcwell no longer needs MCP internally, keep an MCP adapter:

``` text
                       +--> Arcwell native iOS
                       |
Garderobe Core --------+--> MCP --> ChatGPT
                       |
                       +--> MCP --> Claude
                       |
                       +--> future clients
```

When ChatGPT eventually supports the desired mobile custom-MCP write
functionality on the relevant subscription, the same Garderobe backend
can connect there again. Nothing built for Arcwell needs to be thrown
away.

------------------------------------------------------------------------

## Possible Repository Direction

Once the existing `arcwell` repository is inspected, consider a
structure along these lines:

``` text
arcwell/
  apps/
    ios/
      Arcwell/

  workers/
    api/
    agent/

  packages/
    garderobe-core/
    agent-core/
    model-providers/
    shared-types/

  adapters/
    mcp/
    deepseek/
    openai/
    anthropic/

  evals/
    garderobe/
```

Do not force a monorepo restructure if the current repository has good
boundaries already.

The important architectural distinction is:

``` text
domain logic
!= transport
!= MCP
!= model provider
!= native UI
```

------------------------------------------------------------------------

## Initial Engineering Checklist

-   [ ] Inspect current Arcwell repository and Garderobe implementation.
-   [ ] Identify where MCP transport and Garderobe domain logic are
    coupled.
-   [ ] Extract reusable Garderobe functions if necessary.
-   [ ] Define stable agent tool schemas.
-   [ ] Add DeepSeek V4.1 Flash provider adapter.
-   [ ] Implement server-side agent loop.
-   [ ] Add conversation/session storage.
-   [ ] Define durable memory/state boundaries.
-   [ ] Add structured tracing.
-   [ ] Build wardrobe evaluation dataset.
-   [ ] Compare DeepSeek with GPT-5.6 Sol on real scenarios.
-   [ ] Define `/api/chat` streaming protocol.
-   [ ] Create minimal SwiftUI chat client.
-   [ ] Add structured outfit-card protocol.
-   [ ] Add native Today screen.
-   [ ] Add image upload/camera support.
-   [ ] Add TestFlight distribution.
-   [ ] Retain MCP adapter for external clients.

------------------------------------------------------------------------

## Key Design Principles

1.  **Own the state.** Wardrobe history and plans belong in
    Arcwell/Garderobe, not inside a chat model's memory.
2.  **Own the write loop.** Every important decision should be
    persistable through deterministic tools.
3.  **Keep the model replaceable.** DeepSeek is an implementation
    choice, not the architecture.
4.  **Keep the client thin.** SwiftUI presents and captures information;
    Cloudflare runs the agent.
5.  **Keep Garderobe independent of MCP.** MCP is one interface onto the
    domain, not the domain itself.
6.  **Prefer structured state over giant prompts.** Retrieve relevant
    information when needed.
7.  **Use native UI where it improves the experience.** Chat for intent;
    cards, buttons, cameras, and wardrobe browsers for interaction.
8.  **Evaluate with real personal scenarios.** Model choice should
    follow actual Garderobe quality, not benchmark headlines.

------------------------------------------------------------------------

## Recommended Next Step

Before writing significant iOS code:

1.  Inspect the current `chrischabot/arcwell` repository and Garderobe
    tool.
2.  Map the existing storage and MCP boundaries.
3.  Extract or confirm a reusable Garderobe domain layer.
4.  Implement a minimal DeepSeek tool-calling agent against it.
5.  Run real wardrobe scenarios through DeepSeek V4.1 Flash.
6.  Only then build the SwiftUI client.

That sequence answers the biggest unknown---**whether the model is good
enough for the actual wardrobe workflow**---before investing heavily in
the native app.

The end state is a portable personal-agent architecture in which
**Arcwell owns the data, memory, tools, and write loop; the model is
replaceable; and MCP remains available as an external integration rather
than a constraint on the system.**
