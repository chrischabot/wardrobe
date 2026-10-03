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
| `runAssistantMaintenance(deps)` | Result delivery, erasure reconciliation, index and AI Search projection, and reconciliation of model-call reservations whose outcome is not known. Pass `usageLookup` (see "Model-call reservations") to let it close uncertain reservations; without it they stay uncertain. |
| `runPendingAssistantJobs(deps)`, `handleAssistantJobQueue`, `runAssistantJobStep` | One idempotent job runner, driven by the scheduled sweep, a Queue consumer or a Workflow step. |
| `checkConnectionHealth(deps, userId, phase)` | Connection health before the evening and morning runs. |

Optional ports (`AssistantPorts`): `validateOutfit`, `decisionContext` (daily service), `openImage` (private
media; photo turns are refused without it), `searchProviders`, `extraction`, `searchIndex`,
`describeConnectionTools`.

## How a change takes effect

Conversation text is never authority for a sensitive change, on any channel. Two independent reviews
showed that matching the owner's words cannot establish what was meant, so there is no word check to
pass. Trusted code (`src/policy/classes.ts`, `src/tools/runtime.ts`) puts every change into one of three
classes; a command type that is not listed is in the strict one.

| Class | What | How it takes effect |
| --- | --- | --- |
| Report | `wear.record`, `wear.amend`, `care.mark_dirty`, `care.washed`, and the owner's own comfort note (`feedback.record`) | Recorded at once, but only for garments the owner **named in their own words** in that message or **attached** to it, in a sentence that reads as their own report, for today or the last seven days. Which garments were named, and by which words, is kept on the turn (`assistant_turns.grants_json`). Anything else becomes a request. |
| Bookkeeping | a research note, a shopping candidate outside the wardrobe, a product observation, a fit assessment, a background research job, a memory **candidate** | Recorded without owner words. None of these states a fact about the wardrobe, the profile or the owner. |
| Request | everything else: adding, correcting, moving, retiring or receiving a piece, an alias, a restriction, lifting a restriction, a rule, a day brief, a profile amendment, a measurement, an order, a return or any update to one, a project or project event, an authorization, a reminder, a setting, a settled memory, forgetting, undo, a mailbox search | Nothing is written. The turn records a **proposal**: the typed command, its payload, and a summary written by trusted code (`src/policy/describe.ts`) that names records from the ledger and shows every stored free-text value inside quotation marks. The change happens only when the signed-in owner confirms that exact proposal in the app (the Worker's owner-only `GET /v1/proposals` and `POST /v1/proposals/{id}/decision`). |

What "named" means (`src/policy/naming.ts`, `src/policy/voice.ts`): the owner's own voice is the owner's
text field with block quotes, fenced and indented pastes, forwarded mail, anything in quotation marks and
whatever follows a relaying introducer ("my brother wrote: ...") removed. An attachment is never part of
it. A garment is named when that voice contains its alias, or enough words of its record to single it
out; a referring word ("it", "that") names nothing. This is a convenience gate for everyday reports
only. Failing it never refuses anything: the report becomes a request.

Backstop at the ledger (`registerAssistant`, commit hook `assistant.conversation_authority`): a command
that arrives from a conversation turn on `owner_statement` is refused unless it is bookkeeping, or a
report whose garments are all covered by the naming record of that turn. This holds whatever a tool,
present or future, sends.

A proposal is confirmed against the record it described (`expectedVersionsFor` in
`src/policy/describe.ts`). Every proposal that corrects, renames, moves, receives or retires a piece,
including a project event that moves or retires its pieces, carries the piece's version as read when the
proposal was made, and a proposal about a return, a project, a reminder or a remembered conclusion carries
that record's version. If the record changed before the owner confirmed, the command service refuses the
confirmation with `conflict` and writes nothing; the owner asks again. A proposal that only refers to a
piece (a restriction, a return or project being opened, a wear or wash report that became a request)
carries no garment version. A confirmed proposal for an observation command is held to its versions by
the commit hook, because the command service rebases observations.

Further rules:

- Lifting a restriction is one command, `assistant.lift_restriction` (the restriction is resolved and
  the profile gets a dated amendment). It accepts only the owner's tap in the app. The `undo` tool
  refuses to undo the command that recorded a restriction, and refuses imported records.
- Changes that used to be several commands are one command and one request: an order with its incoming
  wardrobe records (`purchase.import_order` with `incoming`), an arrival with its order line
  (`assistant.report_arrival`), a sale project with its hold (`lifecycle.open_project` with
  `holdForSale`), a physical project event with its stock movement (`lifecycle.record_event` with
  `moveStock`). They are planned by the foundation's own command definitions and merged
  (`src/commands/composite.ts`).
- On the connected-assistant (`mcp`) channel, relayed words record only a wear or wash report for named
  pieces that are not under a restriction, and research bookkeeping. A research topic is never the owner
  speaking.
- A mailbox job logs the orders it finds only when the ledger shows the job was created by the owner's
  tap (a confirmed request). A parameter proves nothing.
- A turn leaves at most eight requests. A request that is not a well-formed command, or that names a
  piece that does not exist, is not offered.
- The assistant retrieves only addresses the owner wrote in their own words, or that a search of the
  same turn returned. Addresses in attachments, quotations and pastes are not retrieved. A search query
  may not carry a number or a health or personal term that was not in the request (product names
  excepted).
- A question to the owner (`ask_owner`) is refused if it asks for a password, a code or any other
  secret, or carries a link.
- A photograph never logs a wear and never creates a garment. What cannot be seen stays unknown.
- An order is not an arrival.

## Forgetting

`conversation.forget_source` is itself a request the owner confirms when asked for in conversation. In
its one commit it removes the text from: the turn record and its events, proposals and naming record;
the command ledger's own copies for every command of that turn, including ones the owner confirmed from
it (the foundation's `planLedgerScrub`: payloads, receipt prose, undo data, effect and outbox payloads,
action intents); what the assistant wrote from it (comfort notes, research notes, shopping candidates,
reminders, remembered conclusions, background jobs and their result cards); the reply; later assistant
messages that repeated it; and the retrieval index. Summaries that covered any of these are invalidated.

Records the owner confirmed as their own (a profile amendment, a rule, a restriction, a wardrobe record,
an order, a return, a project) are kept, and the receipt names them so the owner can remove them too. The
transcript, compaction summaries and AI Search erase asynchronously; the receipt says so, and each store
is reported erased only when it confirms.

Known limit: a later repetition is found by the words the forgotten message introduced to the
conversation. A paraphrase that shares none of them is not found.

## Secrets

Credentials pasted into the conversation are removed before anything is stored or sent to a model
(`src/policy/secrets.ts`). This is pattern matching and is partial by nature: an unlabelled secret, or
one described in a way no pattern covers, is not found.

## Model-call reservations

Spend is reserved in the ledger before each model call and settled when the call ends
(`src/inference/service.ts`). A call that ends without a clear answer from the provider (a timeout, a
dropped stream, a stop) leaves its reservation `uncertain`, and it keeps counting against the day's budget.
`reconcileInferenceReservations` (`src/inference/reconcile.ts`), run by `runAssistantMaintenance`, closes
open reservations only on evidence:

- A reservation still `reserved` ten minutes after it was taken belongs to a call that is no longer
  running (the actor was evicted before settling). It is recorded as `uncertain`, never released.
- An `uncertain` reservation is looked up in the provider's record of the call, from two minutes to
  thirty days after it was taken. Recorded usage settles it at the registry price of that usage; a
  record showing no usage releases it; no record, an unreadable record or no configured lookup leaves it
  uncertain. Each closure is an `inference.settle` command whose source names the provider record.

The provider record is AI Gateway's log of the call (`createGatewayLogsLookup` in
`src/inference/gateway-usage.ts`), matched by the run and attempt identifiers the Gateway adapter sends
as metadata. It needs the Cloudflare account ID and an API token limited to "AI Gateway Read", passed to
`runAssistantMaintenance` as `usageLookup` by the Worker. Until the Worker passes it, nothing uncertain
is closed. The adapter has never run against a real Gateway.

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
| AI Gateway logs (`inference/gateway-usage.ts`) | Cloudflare API reference, "List Gateway Logs", read 2026-10-03. The format of a log's `metadata` field is not stated there; the adapter accepts only a JSON object naming the run and attempt | Account ID and an "AI Gateway Read" API token as Worker secrets, and logging enabled on the named Gateway |
| AI Search (`recall/ai-search.ts`) | Workers types for the AI Search namespace | The `AI_SEARCH` namespace binding |
| MCP connections (`connections/mcp.ts`) | MCP JSON-RPC over HTTP | Exa and Tavily keys, owner-added endpoints |

Not built, because the contract could not be verified without the live binding: Browser Run sessions,
interactive actions, file transfer, Live View, WebMCP and crawl. The typed policy for them is in
`src/research/web/browser.ts`.

## Tests

```
npm ci --no-audit --no-fund          # from the repository root
cd packages/assistant
npx tsc -p tsconfig.json
npx vitest run
```

Tests run inside workerd against real local D1, a real Durable Object and, for photo intake, the real
media package on local R2, with the owner's real imported profile and inventory. Stand-ins are labelled
where they are used: the fake model at the model boundary (`src/testing/fake-model.ts`), the fake Google
API at the fetch boundary (`src/testing/fake-google.ts`), fake MCP, Browser Run and AI Search bindings
inside the tests that use them, and synthetic images from the media package's fixtures.

The confirmation design is tested in:

- `test/confirmation.test.ts`: classes, the lift, the ledger backstop, combined commands, stale requests.
- `test/stale-proposals.test.ts`: a retire, move, arrival, alias or stock-moving project event confirmed
  after the piece changed is refused with `conflict` and writes nothing.
- `test/corpus-adversarial.test.ts` and `test/corpus-ordinary.test.ts`: the committed corpora of
  `src/testing/corpora.ts` (rebuilt from the shapes of the two independent reviews, and extended). The
  fake model plays a compromised model in the first and an honest one in the second.
- `test/forgetting.test.ts`: scans every table of the database that has a text column.
- `apps/worker/test/assistant-confirmation.test.ts`: the same corpora and the owner's confirm, reject,
  stale, modified, expired and already-decided cases through the real Worker routes.

In this package's own tests the owner's confirmation is carried out as the Worker's route does it (the
proposed command through the command service as the owner's tap); the route itself is exercised only in
the Worker's test.

`test/reservation-reconcile.test.ts` covers the reservation sweep against a labelled fake provider
record, and the Gateway logs adapter against a fake `fetch` in the documented response shape.
