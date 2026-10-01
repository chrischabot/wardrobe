# @garderobe/assistant

The conversational assistant of Garderobe: the Think Durable Object that holds the owner's one continuous
conversation, inference through AI Gateway, memory and recall, photo intake, research, purchases, returns,
lifecycle work, reminders and comfort feedback. Every change it makes goes through the shared command
service (`@garderobe/domain`); it never writes to the ledger directly.

## What the Worker mounts

| Export | Purpose |
| --- | --- |
| `registerAssistant(registry)` | Assistant-lane commands on the shared command registry. |
| `GarderobeAssistant` | The Durable Object class (binding `ASSISTANT`, SQLite). The same class also runs research task actors, named `<userId>::research::<turnId>`, so no second binding is needed; the actor's environment must carry the `ASSISTANT` namespace. |
| `configureAssistant({ registry, ports })` | Hands the actor the composed registry (so other lanes' commit hooks run for assistant commands) and the optional ports below. |
| `assistantClient(env, principal)` | The only way to reach the actor; it is addressed by the verified internal user ID. |
| `runAssistantMaintenance(deps)` | Result delivery, erasure reconciliation, index and AI Search projection. |
| `runPendingAssistantJobs(deps)`, `handleAssistantJobQueue`, `runAssistantJobStep` | One idempotent job runner, driven by the scheduled sweep, a Queue consumer or a Workflow step. |
| `checkConnectionHealth(deps, userId, phase)` | Connection health before the evening and morning runs. |

Optional ports (`AssistantPorts`): `validateOutfit`, `decisionContext` (daily service), `openImage` (private
media; photo turns are refused without it), `searchProviders`, `extraction`, `searchIndex`,
`describeConnectionTools`.

## Authority rules enforced in code

- A write tool must quote the owner's own words from the current turn. Attachments, pasted or forwarded
  text, web pages, emails, tool results and photographs are data and are never accepted as that quote.
- The quote is also tied to the action (`src/policy/intent.ts`): the owner's sentence must contain wording
  for that kind of action, name (or have attached) each piece it touches, and supply the words of any
  rule, profile amendment or measurement that is stored. An unrelated owner sentence authorizes nothing.
- Words that arrive through a connected assistant (the `mcp` channel) never change the profile, the rules,
  the wardrobe's contents or a restriction: such requests are kept as proposals for the owner to confirm
  in the app. A research topic is never treated as an owner statement.
- The assistant retrieves only addresses the owner supplied or a search of the same turn returned.
- A restriction is lifted only by `resolve_restriction` on the owner's statement that its condition ended.
  The sentence must be about the restricted condition; doubt, a wish, a future, negation, reported or
  quoted speech and a hypothetical anywhere in the message are refused.
  The `undo` tool refuses to undo the command that recorded a restriction, and refuses imported records.
- A photograph never logs a wear and never creates a garment. What cannot be seen stays unknown.
- An order is not an arrival. A mailbox investigation only finds orders unless the owner asked to log them.

## Deviation from the specification: outbound connections

The specification (sections 4 and 13) says outbound tool connections "build on the Agents MCP client".
This package does not. It uses its own narrowly scoped MCP client (`src/connections/mcp.ts`) and typed
Google adapters (`src/connections/google.ts`). The decision was answered for the owner by Fabric support:
keep this design and record the deviation.

Why:

- The Agents MCP client stores a connection's transport options, including authorization headers, in the
  actor's own storage (`cf_agents_mcp_servers.server_options`). Here a credential is resolved from the
  Worker's encrypted credential store only at dispatch and is never stored in the actor.
- The Agents client negotiates the protocol version itself. The specification needs a version per
  connection (the Exa endpoint rejected `2026-07-28`).
- This client refuses redirects, bounds response size and the number of calls per run, and sends only the
  arguments a discovered schema declares.

This acceptance does not certify any live integration. The client and adapters are tested against a fake
MCP server and a labelled fake Google API only; the real Exa, Tavily, Google and owner-added endpoints have
not been exercised from this package.

## Verified against documentation only, not against the live service

| Adapter | Contract source | Needs for live verification |
| --- | --- | --- |
| Gmail, Drive, Sheets (`connections/google.ts`) | Google discovery documents (Gmail v1, Drive v3, Sheets v4) | The owner's Google grant with the matching scopes, held by the Worker's credential store |
| Browser Run Quick Actions (`connections/browser-run.ts`) | Cloudflare Browser Run documentation | The `BROWSER` binding on a deployed Worker (it does not run in local development) |
| AI Gateway (`inference/gateway.ts`) | Installed `workers-ai-provider` and AI binding types | The `AI` binding and the named Gateway |
| AI Search (`recall/ai-search.ts`) | Workers types for the AI Search namespace | The `AI_SEARCH` namespace binding |
| MCP connections (`connections/mcp.ts`) | MCP JSON-RPC over HTTP | Exa and Tavily keys, owner-added endpoints |

Not built, because the contract could not be verified without the live binding: Browser Run sessions,
interactive actions, file transfer, Live View, WebMCP and crawl. The typed policy for them is in
`src/research/web/browser.ts`.

## Tests

```
bash tools/sandbox-install.sh        # from the repository root, in the Fabric sandbox
cd packages/assistant
npx tsc -p tsconfig.json
npx vitest run
```

Tests run inside workerd against real local D1, a real Durable Object and, for photo intake, the real
media package on local R2. Stand-ins are labelled where they are used: the fake model at the model
boundary (`src/testing/fake-model.ts`), the fake Google API at the fetch boundary
(`src/testing/fake-google.ts`), fake MCP, Browser Run and AI Search bindings inside the tests that use
them, and synthetic images from the media package's fixtures.

The photo tests use the real media package, declared as a development dependency of this package.
