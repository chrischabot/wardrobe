# Coverage audit part C — assistant (taste and memory, research and lifecycle, inference)
Audited at commit 8445a1e.

## Summary

This part covers 210 checklist rows: 81 in section 6, 87 in section 10 and 42 in section 12. The verdicts are 169 verified, 40 weaker and 1 unsupported. Seventeen of the verified rows are `open` or `blocked` rows that honestly claim nothing; they are listed as gaps because the requirement is not implemented. The audit read files only; no test was run, so a verdict says what the code and the tests contain, not that the tests pass.

The assistant's core is real and well tested behind a labelled fake model: the Think Durable Object, the mandatory context with the complete profile on every turn, the original-message transcript, compaction with checkpoints, dated recall, forgetting, the reservation ledger and the rule that a conversation changes the wardrobe only through domain commands. The weaker rows fall into five groups. First, several rows marked `implemented` describe library code that no production path calls (the browser session policy, the capability registry, the history claim assessor, the exact-variant matcher, the purchase refresh check, the sheet export and re-import diff, AI Search provisioning). Second, rows that promise an immediate effect from the owner's sentence are implemented in conversation as a request the owner must confirm in the app, under an owner decision of 1 October 2026 that the code cites but the requirements folder does not contain. Third, model probes are only recorded, never performed, and effort parameters are recorded but never sent. Fourth, compaction validation, event time in the recall projection and overflow recovery do less than their rows say. Fifth, deletion covers five stores and has no store for Browser Run recordings, Workflow step data, Queue payloads, extraction caches, generated exports or the private images a forgotten message referenced.

I found no assistant path that writes wardrobe tables (garments, stock, wear, restrictions, style, measurements) other than through the command service; the direct D1 writes in `packages/assistant/src` are to the assistant's own operational tables.

## Row verdicts

In the Evidence column, a path that starts with `src/` or `test/` is under `packages/assistant/`; other paths are relative to the repository root. "Names only" means I matched the cited test by its name and did not read its body. "Fake" always means a labelled test double.

| ID | Checklist status | Verdict | Evidence |
| --- | --- | --- | --- |
| S06-001 | implemented | verified | Names only: `packages/domain/test/import.test.ts:10` (profile byte-identical to the named SHA-256) and `:108` (imported verbatim); `src/context/mandatory.ts:111` prints version and hash. |
| S06-002 | implemented | verified | The cited tests concern profile import, not precedence. The behaviour is shown by `packages/daily/test/validation.test.ts:203` (research rules absent from the profile are retained but not enforced), which the row does not cite. Names only. |
| S06-003 | partial | verified | The partial status is accurate. `src/context/mandatory.ts:109-134` supplies the document, amendments and hard rules only; I found no section for dated examples of outfits that worked or were rejected, and soft rules are not listed (`:120-125` filters `kind === "hard"`). |
| S06-004 | partial | verified | Routing past a profile whose window cannot hold the context exists (`src/inference/service.ts:145-147`, `src/agent/assistant.ts:497-498`); I found no test for that skip. Daily citations matched by name only. |
| S06-005 | implemented | verified | `test/conversation.test.ts:14-32` sends a short sock question and asserts the system prompt contains the whole profile text verbatim; `src/agent/assistant.ts:428` assembles it on every turn with no relevance check. |
| S06-006 | partial | verified | Compaction and extraction calls receive only their own system text and source (`src/agent/compaction.ts:10-12`, `src/agent/assistant.ts:344`). Partial status is accurate. |
| S06-007 | implemented | verified | Names only: `packages/domain/test/isolation-style-platform.test.ts:214`; `test/journeys.test.ts:244-264` shows a direction with scope and undo. |
| S06-008 | partial | verified | `test/journeys.test.ts:244-258`: the one-day brief leaves the document hash unchanged and an inferred memory stays a candidate. |
| S06-009 | implemented | weaker | True for a direct command (`isolation-style-platform.test.ts:214`, names only). In conversation a direction is class `confirm` (`src/policy/classes.ts:19-24`) and takes effect only after the owner confirms it in the app (`test/journeys.test.ts:250` uses `runAndConfirm`), which is the confirmation step the specification line rules out. |
| S06-010 | implemented | verified | Names only: `packages/daily/test/validation.test.ts:81`, `:315`, `:351`. |
| S06-011 | partial | verified | Names only: `validation.test.ts:292` (an explicit exception is scoped to the request). |
| S06-012 | implemented | verified | Names only: `validation.test.ts:51`, `:71`, `:162`, `:178` (jacket interval, not the daily maximum). |
| S06-013 | partial | verified | Partial status is accurate; taste judging is not in this package. |
| S06-014 | implemented | weaker | Holds by absence only: a search of `packages/daily/src/compose.ts` for loud, quiet, statement and character finds no rule that requires a conspicuous piece (the one match, line 301, is a comment about socks), and no test in `packages/daily/test/board.test.ts` asserts that an all-quiet board is accepted. |
| S06-015 | implemented | verified | Names only: `isolation-style-platform.test.ts:239`; `src/context/mandatory.ts:131` prints unit, convention and date. |
| S06-016 | implemented | verified | `src/research/commerce/fit.ts:206-211` and `test/research/commerce/fit.test.ts:74-79` (a label alone gives `cannot_determine`); `test/photo.test.ts:89` (no measurement is offered from a photograph, by name). |
| S06-017 | implemented | verified | `src/research/commerce/fit.ts:186-192` flags an old body measurement when the ease is near a limit; `src/tools/read.ts:106-111` passes the measurement date; `fit.test.ts:104`. No conversation test shows the assistant asking. |
| S06-018 | implemented | verified | `test/commands.test.ts:245-254` (conclusions carry source message IDs); the wardrobe records are in every turn's context (`src/context/mandatory.ts:161-164`). |
| S06-019 | implemented | verified | `test/ledger-tools.test.ts:207-226`: a changed chest measurement produces "PREMISE NO LONGER HOLDS" in the next turn's system prompt. |
| S06-020 | implemented | weaker | The guarantee is structural (a summary is text; only commands change stock) plus an instruction to the summarizer (`src/agent/compaction.ts:12`). Neither cited test contains a case in which a summary asserts an arrival or a retirement. |
| S06-021 | partial | verified | Profile injected verbatim (`test/conversation.test.ts:21`); following it is model behaviour, as the row says. |
| S06-022 | partial | verified | Same evidence and limitation as S06-021. |
| S06-023 | partial | verified | Same evidence and limitation as S06-021. |
| S06-024 | implemented | verified | Names only: `validation.test.ts:338`, `packages/daily/test/review-regressions.test.ts:324`; `packages/daily/src/validate.ts:48-62`. |
| S06-025 | implemented | verified | `src/context/mandatory.ts:132` prints each size experience "(this maker only)"; domain tests by name. |
| S06-026 | implemented | verified | Names only: `validation.test.ts:51`, `board.test.ts:290`. |
| S06-027 | partial | verified | Names only: `validation.test.ts:71`, `:95`, `:105`. |
| S06-028 | implemented | verified | Names only: `validation.test.ts:128`, `:150`; `weather-assess.test.ts:39`. |
| S06-029 | implemented | verified | Names only: `isolation-style-platform.test.ts:239`. |
| S06-030 | implemented | weaker | Same cause as S06-009: a correction made in conversation is a request to confirm, not an immediate update (`src/context/mandatory.ts:38`, `src/policy/classes.ts:19-24`). |
| S06-031 | implemented | verified | `src/context/mandatory.ts:110-118` emits profile, then amendments, then the precedence statement; `test/conversation.test.ts:21-25`. The order itself is not asserted by a test. |
| S06-032 | implemented | weaker | `test/confirmation.test.ts:44` and `test/corpus-adversarial.test.ts:63` (names): a genuine recovery statement yields only a proposal; the restriction is retired and the amendment added on the owner's confirmation in the app. |
| S06-033 | implemented | verified | `test/commands.test.ts:245-249` (an assistant extraction cannot be recorded as active); `packages/domain/test/style-facts.test.ts:188` by name. |
| S06-034 | implemented | verified | Names only: `style-facts.test.ts:57`, `:144`. |
| S06-035 | implemented | verified | Names only: `style-facts.test.ts:82`; `isolation-style-platform.test.ts:178`. |
| S06-036 | partial | verified | Compaction has no command path (`src/agent/compaction.ts`, `src/agent/assistant.ts:336-362` writes only a checkpoint row). |
| S06-037 | partial | verified | Names only: `ClosedGapTests.swift:123`, `OwnerMorningJourney.swift:84`. Not run on a device, as the row says. |
| S06-038 | implemented | verified | `test/memory.test.ts:86-107` (working context shorter than the transcript, all 20 originals retrievable) and `:123-144` (index rebuilt from its watermark). |
| S06-039 | implemented | verified | `getHistory(` appears in `src/` only in a comment; the transcript uses the `gd_transcript` ledger and `session.getMessage` (`src/agent/assistant.ts:647-668`, `:1085-1107`); `test/memory.test.ts:106` shows no summary text in the transcript. |
| S06-040 | implemented | verified | `test/memory.test.ts:104-106`; `src/agent/compaction.ts:93`. |
| S06-041 | implemented | verified | `src/agent/assistant.ts:410-428` rebuilds the context from D1 at the start of each turn; `test/journeys.test.ts:198-201` shows a new return in the next turn. |
| S06-042 | implemented | verified | `withCachedPrompt` does not occur in `packages/assistant/src`; nothing is cached across turns. |
| S06-043 | implemented | weaker | The counting is in `src/agent/assistant.ts:484-502` (characters divided by 3.5, a flat allowance per image). No test asserts the counts or the skip of a profile whose window is too small; the strings `mandatoryTokens` and `toolSchemaTokens` occur in no test. |
| S06-044 | implemented | verified | `src/agent/assistant.ts:99-113`; `test/adapters-jobs.test.ts:516-525`. The threshold uses the smallest candidate window; there is no per-model tuning from evaluations. |
| S06-045 | implemented | verified | `src/agent/assistant.ts:317-319` registers `onCompaction` and `compactAfter`; `test/memory.test.ts:86-94` shows the compaction call reserved and settled. The Gateway itself is replaced by the fake model in tests. |
| S06-046 | implemented | weaker | Only the archived large payload is tested (`test/ledger-tools.test.ts:259`). The appended exact IDs and links (`src/agent/compaction.ts:86-93`) and the pending-tool-pair boundary (`:77`) have no test; unresolved requests, commitments and corrections rest on the summarizer prompt alone. |
| S06-047 | implemented | weaker | The checkpoint is written (`src/agent/assistant.ts:349-355`, `test/memory.test.ts:87-90`). Validation before activation is a length check only (`src/agent/compaction.ts:84`); the summary's references are not validated. |
| S06-048 | implemented | verified | `test/memory.test.ts:104`, `test/turn-control.test.ts:251-254`; compaction calls no deletion or command. |
| S06-049 | implemented | weaker | The profile is refreshed after compaction (`test/memory.test.ts:103`) and a resampled action in the same turn resolves to its receipt (`test/journeys.test.ts:310-331`). No test re-proposes, in a later turn after compaction, an action whose narrative was compacted away; action intents are scoped to one turn (`src/tools/runtime.ts:277`), so protection across turns depends on each command's own business key. |
| S06-050 | implemented | weaker | One generic classifier (`src/agent/assistant.ts:234`, `src/inference/service.ts:44`), tested with one error text, not one per provider. When shortening fails the test accepts `failed` as well as `resumable` (`test/turn-control.test.ts:269`), and `describeFailure` (`src/agent/assistant.ts:531-534`) does not treat an overflow as resumable. |
| S06-051 | implemented | weaker | Event time is never stored: the columns `event_date_from` and `event_date_to` exist (`migrations/0200_assistant_core.sql:74-75`) but nothing in `packages/assistant/src` writes them. The other fields are present (`src/recall/index.ts:161-178`). |
| S06-052 | implemented | verified | `test/memory.test.ts:59-62`, `:70-75`. A correction superseding a fact has no dedicated test. |
| S06-053 | implemented | verified | `test/memory.test.ts:123-144`. |
| S06-054 | implemented | verified | `src/recall/temporal.ts:48-61`; `test/memory.test.ts:77-84`. |
| S06-055 | implemented | verified | `src/recall/index.ts:347-368`; `test/memory.test.ts:48-58`; `test/review-regressions.test.ts:178` by name. |
| S06-056 | implemented | verified | `test/memory.test.ts:48-68`. |
| S06-057 | partial | weaker | The stated limitation understates the gap. Recall queries AI Search only for `conversation_episode` and only to raise rows already in the D1 projection (`src/recall/index.ts:299-306`). Garment, order, product, note and memory documents are uploaded (`src/recall/projection.ts:23-60`) but no read path searches them. |
| S06-058 | implemented | verified | `src/agent/assistant.ts:1048-1057`, `src/recall/index.ts:312-321`; `test/ledger-tools.test.ts:259` by name. |
| S06-059 | blocked | verified | Nothing is provisioned; `apps/worker/wrangler.jsonc:44-45` lists AI_SEARCH as a binding not present locally. Listed as a gap. |
| S06-060 | partial | weaker | `provisionSearchInstance` (`src/recall/ai-search.ts:73-80`) is called only by `test/search-projection.test.ts:106`; no command or route invokes it. `search.record_instance` (`src/commands/reminders.ts:72-90`) only records a row. |
| S06-061 | implemented | verified | The index is built from the verified user ID by trusted code (`apps/worker/src/lanes/index.ts:194`); the recall input has no instance field. The test checks only name derivation (`test/search-projection.test.ts:95-96`). |
| S06-062 | implemented | verified | `test/search-projection.test.ts:55-57` (the garment document states no ownership or availability); daily tests by name. |
| S06-063 | implemented | verified | `src/recall/projection.ts:23-60`, `src/recall/ai-search.ts:59-66`; `test/search-projection.test.ts:94-101`. |
| S06-064 | partial | verified | `src/recall/ai-search.ts:44`, `:78`, `:100`; `test/search-projection.test.ts:97`, `:108-109`. Fake namespace, as the row says. |
| S06-065 | implemented | verified | A photo is stored as a reference line (`src/agent/assistant.ts:823-824`), so no image enters the index. There is no path that indexes a verified description or OCR text. |
| S06-066 | partial | verified | Commands emit their outbox entries with the change (`src/commands/research.ts:38`, `:139`). |
| S06-067 | partial | verified | `test/search-projection.test.ts:45-66`. The projection is driven by the maintenance sweep (`src/maintenance.ts:90-94`); I found no Queue consumer for indexing in this package. |
| S06-068 | implemented | verified | `test/search-projection.test.ts:75-83`. The candidate's `sourceVersion` is not compared with the canonical revision (`src/recall/index.ts:302-306`). |
| S06-069 | blocked | verified | Nothing deployed. Listed as a gap. |
| S06-070 | partial | verified | `src/recall/projection.ts:80-97`, `:153-159`; settled at a fixed figure per document, as the row says. |
| S06-071 | blocked | verified | No Agent Memory code exists in `packages/assistant/src`. Listed as a gap. |
| S06-072 | implemented | verified | Agent Memory is not used; candidates go through `memory.record_conclusion` (`test/commands.test.ts:245-254`, `test/journeys.test.ts:247-258`). The `recall_enrichment` task is declared (`src/inference/registry.ts:187`) but nothing calls it. |
| S06-073 | blocked | verified | Nothing exists. Listed as a gap. |
| S06-074 | implemented | verified | `test/commands.test.ts:245-254`. `test/review-round3.test.ts` was not opened. |
| S06-075 | implemented | weaker | Forgetting covers transcript, summaries, retrieval index, ledger and AI Search (`test/memory.test.ts:176-177`). I found no store for Browser Run recordings, Workflow step data, Queue payloads, cached extraction artifacts or generated exports, and a forgotten message's images are only dereferenced (`src/agent/assistant.ts:716`), not deleted from private media. |
| S06-076 | implemented | unsupported | The cited files (`src/recall/projection.ts`, `ai-search.ts`, `index.ts`, `test/search-projection.test.ts`) concern the search projection and do not address passing references into durable steps. |
| S06-077 | implemented | verified | `test/memory.test.ts:146-178`, `test/commands.test.ts:256-270`. |
| S06-078 | implemented | verified | `src/agent/assistant.ts:761-784`; `test/memory.test.ts:156`, `:179`. |
| S06-079 | implemented | verified | `test/ledger-tools.test.ts:228-244`. |
| S06-080 | implemented | verified | `test/memory.test.ts:169-170`, `:189-191`; `src/agent/assistant.ts:1171-1192` applies tombstones on restore. |
| S06-081 | implemented | weaker | Correction works by command (`test/commands.test.ts:250-253`). There is no surface to inspect conclusions: the row's own note says iOS shows none, and `apps/worker/src` has no route that lists them (`listMemoryConclusions` is not referenced there). |
| S10-001 | blocked | verified | Only the fake Google API is exercised (`test/adapters-jobs.test.ts:31`, headed "NOT a live check"). Unattended token refresh is not verified. Listed as a gap. |
| S10-002 | open | verified | Nothing exists. Listed as a gap. |
| S10-003 | partial | verified | `src/research/web/connectors.ts:20` lists the endpoints; the adapters call the Google REST APIs, as the row says (`test/adapters-jobs.test.ts:32-111`). |
| S10-004 | partial | verified | Names only: `packages/daily/test/calendar-google.test.ts:100-319`. |
| S10-005 | partial | verified | `test/adapters-jobs.test.ts:32-60` covers search, pagination, message open, attachments and history. The Gmail source has no method that opens a thread (`src/connections/google.ts` uses `threadId` only as a field). |
| S10-006 | partial | verified | Names only (daily calendar tests). |
| S10-007 | partial | weaker | The Drive client is tested against the fake (`test/adapters-jobs.test.ts:81-95`), but `createDriveClient` is not referenced anywhere in `apps/worker/src`, so the claim that the real Drive waits only on the owner's grant is not accurate: no Worker path uses it. |
| S10-008 | partial | verified | `test/adapters-jobs.test.ts:97-111`; wired in `apps/worker/src/scheduled/assistant.ts:96-103`. |
| S10-009 | partial | verified | `test/connections-maintenance.test.ts:73` (fake MCP server), `test/research/web/connectors.test.ts:87`. |
| S10-010 | partial | verified | Same evidence as S10-009; `test/commands.test.ts:293-296` (secret reference, research tool disabled). |
| S10-011 | partial | verified | `test/research/web/connectors.test.ts:117-140`; `test/adapters-jobs.test.ts:221-242`. |
| S10-012 | implemented | verified | `test/research/commerce/sheets.test.ts:21` (a preview never touches the ledger); `test/adapters-jobs.test.ts:454-466`. |
| S10-013 | partial | verified | The preview is real (`src/jobs/runner.ts:69`). `commandsForPreview` (`src/research/commerce/sheets.ts:123`) is called only by its test, so applying a preview has no production path yet. |
| S10-014 | implemented | weaker | `buildInventoryExport` and `diffReimport` (`src/research/commerce/sheets.ts:150`, `:171`) are pure functions referenced only by `test/research/commerce/sheets.test.ts`; no tool, job or route exports a sheet or re-imports one. |
| S10-015 | partial | verified | `packages/media/test/illustration.test.ts:81-82` uses stand-in bytes, as the row says. |
| S10-016 | partial | verified | `test/adapters-jobs.test.ts:81-95`. See S10-007 for the missing Worker wiring. |
| S10-017 | implemented | verified | Untrusted material is delimited (`src/agent/assistant.ts:826`, `test/research/web/connectors.test.ts:142-152`); the ledger refuses a sensitive command from a turn whatever the model does (`test/confirmation.test.ts:114`, `test/corpus-adversarial.test.ts:75`, by name). |
| S10-018 | implemented | verified | `test/research/web/search.test.ts:29` (results are candidates); `test/journeys.test.ts:100-141` (search, then the page is read). In the Worker all connections are merged into one provider (`apps/worker/src/connections/outbound.ts:166-186`). |
| S10-019 | implemented | verified | `src/commands/research.ts:69-71` stores checked URL, time, country, currency, size, colour and anchored facts; `test/journeys.test.ts:117`, `:141`. |
| S10-020 | implemented | verified | `test/research/web/connectors.test.ts:43-95`. |
| S10-021 | implemented | verified | `test/commands.test.ts:293` (a key-bearing endpoint is refused); `test/research/web/url.test.ts:117-135`. |
| S10-022 | implemented | verified | `test/research/web/search.test.ts:29`, `:93`, `:106`, `:117`; `src/tools/read.ts:187` (6 queries, 30 results). |
| S10-023 | partial | verified | Media discovery tests by name. `imageBackfillPlan` (`src/research/web/search.ts:176`) is called only by its test. |
| S10-024 | implemented | weaker | Fail-over and reduced coverage work in the library with fake providers (`test/research/web/search.test.ts:56`). The Worker gives it one merged provider that discards a failed connection's error when another answered (`apps/worker/src/connections/outbound.ts:171-184`), so reduced coverage is never recorded there. `isExactVariantMatch` (`src/research/web/evidence.ts:195`) is called only by its test. |
| S10-025 | partial | verified | `test/adapters-jobs.test.ts:126-145` (fake binding). The quick actions are markdown, content, links, snapshot, screenshot and pdf (`src/connections/browser-run.ts:22`); element scraping and the accessibility tree are not separate actions. |
| S10-026 | partial | verified | `test/adapters-jobs.test.ts:147-157` (fake binding). |
| S10-027 | implemented | verified | `test/adapters-jobs.test.ts:469-513`: the record is schema-validated, repaired once, and an invalid one stays unresolved. |
| S10-028 | blocked | verified | Only the capability entry exists (`src/research/web/browser-capabilities.ts:36-41`). Listed as a gap. |
| S10-029 | blocked | verified | `BrowserService` is constructed only in `test/research/web/browser.test.ts:51`; there is no session backend. Listed as a gap. |
| S10-030 | blocked | verified | Same as S10-029. Listed as a gap. |
| S10-031 | blocked | verified | Same as S10-029. Listed as a gap. |
| S10-032 | blocked | verified | Same as S10-029. Listed as a gap. |
| S10-033 | blocked | verified | Same as S10-029. Listed as a gap. |
| S10-034 | blocked | verified | Same as S10-029. Listed as a gap. |
| S10-035 | implemented | weaker | `CapabilityRegistry` keeps probes in memory (`src/research/web/browser-capabilities.ts:110-124`) and is constructed only in `test/research/web/browser.test.ts:79`, `:92`. No deployed probe exists, nothing persists a result and no production path consults it. |
| S10-036 | implemented | weaker | The page-state and reconstruction policy is tested only with `FakeBrowserBackend` (`test/research/web/browser.test.ts:111-157`), and `BrowserService` has no production caller. This is the same code that rows S10-029 to S10-034 call blocked. |
| S10-037 | blocked | verified | Same as S10-029. Listed as a gap. |
| S10-038 | implemented | verified | Structured extraction is raw retrieval followed by the model service (`src/agent/assistant.ts:461`, `test/adapters-jobs.test.ts:469-501`). The cited `browser.test.ts:101-107` only checks a constant list that no code consults. |
| S10-039 | implemented | verified | `test/research/web/connectors.test.ts:97-115`; `test/research/web/extract.test.ts:181`. |
| S10-040 | partial | verified | `SettingsModel.swift:403` has `budgetLines`; no file under `ios/GarderobeKit/Tests` references it. |
| S10-041 | implemented | verified | `test/research/web/extract.test.ts:65`, `:75`, `:110`. |
| S10-042 | implemented | verified | `test/research/web/extract.test.ts:110`, `:133`, `:155`. The method cache is in memory (`src/research/web/extract-types.ts:87`). |
| S10-043 | implemented | verified | `src/research/web/evidence.ts:30`; `test/research/web/evidence.test.ts:144-160`. |
| S10-044 | implemented | verified | `test/research/web/extract.test.ts:124`, `:165`, `:172`; `test/research/web/evidence.test.ts:31`, `:85`. |
| S10-045 | implemented | weaker | Interpretation by the model service and the refusal to forward private values are real (`src/research/web/tool-catalog.ts:165-170`, `test/research/web/extract.test.ts:187`). Human participation for a login or challenge exists only as `BrowserService` policy with a fake backend (`test/research/web/browser.test.ts:201`). |
| S10-046 | partial | verified | `test/adapters-jobs.test.ts:32-78`; wired in `apps/worker/src/scheduled/assistant.ts:91-94`. |
| S10-047 | partial | verified | `test/adapters-jobs.test.ts:273-340`; `test/research/commerce/investigation.test.ts:40-97`. |
| S10-048 | implemented | verified | `test/research/commerce/orders.test.ts:16-39`; `src/research/commerce/order-types.ts:16`, `:179` (arrival estimate). |
| S10-049 | implemented | verified | `test/research/commerce/orders.test.ts:42-123`; `test/commands.test.ts:44-109`. |
| S10-050 | implemented | weaker | "Log the order" does not authorize intake by itself: it becomes one request that the owner confirms in the app (`test/journeys.test.ts:36-39`). The other clauses hold (`:53-58` a question changes nothing; `test/adapters-jobs.test.ts:426-430` a scheduled job only drafts). |
| S10-051 | partial | verified | The owner's arrival sentence is recorded only after confirmation (`test/journeys.test.ts:66-73`); a shop photo becomes a product record (`test/photo.test.ts:115`, by name). |
| S10-052 | partial | verified | `test/adapters-jobs.test.ts:290`, `:320-325`; `test/research/commerce/investigation.test.ts:51`. |
| S10-053 | partial | verified | `test/adapters-jobs.test.ts:469-513`; `test/journeys.test.ts:100-141`. Fake page backends, as the row says. |
| S10-054 | implemented | verified | `src/commands/research.ts:56-61`; `test/commands.test.ts:279-288`. |
| S10-055 | implemented | weaker | The checked URL is stored. The refresh before purchase is a sentence in the receipt (`src/commands/research.ts:66`); `requiresRefreshBeforePurchase` (`src/research/web/evidence.ts:170`) is called only by its test and no purchase action exists to enforce it. |
| S10-056 | implemented | verified | `src/research/commerce/fit.ts:39-53`, `:149-193`; `test/research/commerce/fit.test.ts:18-50`; `test/journeys.test.ts:132-140`. |
| S10-057 | implemented | verified | `test/research/commerce/fit.test.ts:52-79`. |
| S10-058 | implemented | verified | `test/ledger-tools.test.ts:141-180`. |
| S10-059 | partial | verified | Names only: `BoundaryTests.swift:275`. |
| S10-060 | implemented | weaker | `assessClaim` (`src/research/commerce/history.ts:32`) is called only by its test. The save tool lets the model set each claim's status and takes `sourceClass` as free text (`src/tools/write.ts:303`); the command checks only that a supported claim cites something (`src/commands/research.ts:116-120`), so a maker's origin story can be saved as support. |
| S10-061 | implemented | weaker | `exploreHypothesis` (`src/research/commerce/history.ts:92`) is called only by its test. `test/journeys.test.ts:146-156` stores what a scripted fake model sent; the only enforced rule is the one named in S10-060. |
| S10-062 | implemented | verified | `test/ledger-tools.test.ts:182-205`. I did not find or check code for including private measurements only when a document needs them. |
| S10-063 | implemented | verified | `test/commands.test.ts:197-225`. |
| S10-064 | partial | verified | Model behaviour, as the row says; a collection preference is stored (`test/commands.test.ts:216`). |
| S10-065 | partial | verified | `test/confirmation.test.ts:186` by name. |
| S10-066 | partial | verified | `test/journeys.test.ts:204-221`. Changed measurements are free-form event detail, not measurement facts. |
| S10-067 | implemented | weaker | Authorization for a concrete submission is real at the ledger (`test/commands.test.ts:205-211`). No browser session is attached to a project: `BrowserService` has no production caller. |
| S10-068 | implemented | weaker | Retained authorization is real (`test/commands.test.ts:215`). The handoff is a `preparedStep` value from `BrowserService` with a fake backend (`test/research/web/browser.test.ts:201-210`); nothing delivers it to the phone. |
| S10-069 | implemented | weaker | Ten browser and connection rows in this section are blocked or open and the rows above are library-only, so parity is not reached. |
| S10-070 | implemented | verified | Names only: `packages/daily/test/trips.test.ts:39`, `:197`, `:209`. |
| S10-071 | implemented | verified | Names only: `trips.test.ts:39`; `journey-defects.test.ts:182`. |
| S10-072 | implemented | verified | Names only: `trips.test.ts:39` ("packs nothing"), `:116`. |
| S10-073 | implemented | verified | Names only: `trips.test.ts:116`. |
| S10-074 | partial | verified | Names only: `trips.test.ts:156`. |
| S10-075 | partial | verified | Names only: `ClosedGapTests.swift:181`; the row itself says offline reading has no test. |
| S10-076 | implemented | verified | Names only: `trips.test.ts:156`. |
| S10-077 | implemented | verified | `src/commands/returns.ts:18-25`, `:110-114`; `test/commands.test.ts:126-150`. |
| S10-078 | implemented | verified | `test/commands.test.ts:128-140`; `test/journeys.test.ts:182-194`. |
| S10-079 | implemented | weaker | Seven and two days, configurable and deduplicated by operation key (`src/commands/returns.ts:27-45`, `test/commands.test.ts:150-155`). Return reminders exist only as `notification.return_reminder`; no calendar effect is planned for them, so deduplication across app and calendar is not exercised. |
| S10-080 | implemented | verified | `src/commands/returns.ts:190-199`; `test/commands.test.ts:153-170`. |
| S10-081 | implemented | verified | `test/commands.test.ts:157-171`, `:174-185`. |
| S10-082 | implemented | weaker | The action authorization tested is for lifecycle projects (`test/commands.test.ts:205-207`), and the browser policy has no production caller. I found no return-specific external submission path. |
| S10-083 | implemented | verified | `test/journeys.test.ts:224-242` (no question asked), `test/commands.test.ts:229-243`; iOS `ItemModel.swift:230`. In conversation the note is a request to confirm. |
| S10-084 | implemented | verified | `test/commands.test.ts:235` (wearing date and layer stay null). |
| S10-085 | implemented | weaker | A comfort note said in conversation is class `confirm` (`src/policy/classes.ts:13-14`) and reaches recommendations only after the owner confirms it (`test/journeys.test.ts:229-230`), not immediately. |
| S10-086 | partial | verified | `test/journeys.test.ts:244-264`. |
| S10-087 | partial | verified | Names only: `board.test.ts:227`, `journey-defects.test.ts:220`. |
| S12-001 | partial | verified | `createWorkersAI(` occurs only in `src/inference/gateway.ts:72`; the conversation, compaction, extraction and composition calls all go through `ModelService` (`src/agent/assistant.ts:299-302`, `:344`, `:461`). Fake binding and fake model in tests, as the row says. |
| S12-002 | implemented | weaker | No Code Mode or Sandbox job exists in the repository, so the first clause is untested and the cited tests do not mention either. The third-party clause is real: research and answer tools stay disabled (`test/research/web/connectors.test.ts:97`). |
| S12-003 | implemented | verified | `src/inference/gateway.ts:48-50`, `:74`; `test/inference.test.ts:164-165`, `:189-192` (fake binding records the metadata). Every attempt is a ledger row (`test/inference.test.ts:71-76`). |
| S12-004 | implemented | weaker | Selection is gated on recorded probes (`src/inference/registry.ts:216-227`, `test/inference.test.ts:10-32`). Nothing performs a probe: `inference.record_probe` is issued only by test fixtures (`test/helpers.ts:24-31`, labelled "no Gateway was probed") and `apps/worker/src/testing/index.ts:407`. |
| S12-005 | implemented | verified | `src/inference/gateway.ts:77-78` sets no `byok`; `test/inference.test.ts:170-196` shows the stored-key path is never taken; an ineligible route is refused (`:29-32`). |
| S12-006 | partial | verified | Same evidence as S12-005; Gateway settings wait on deployment, as the row says. |
| S12-007 | open | verified | Only the name `garderobe-dev` is configured (`apps/worker/wrangler.jsonc:38`). Listed as a gap. |
| S12-008 | open | verified | Nothing exists. Listed as a gap. |
| S12-009 | partial | verified | No cache option is sent (`src/inference/gateway.ts:9-11`, `:78`). |
| S12-010 | implemented | verified | `src/inference/gateway.ts:30-37`, `:67-70`; `test/inference.test.ts:149-162`. |
| S12-011 | implemented | verified | The adapter uses the Worker binding and no token (`src/inference/gateway.ts:72-78`). No test presents a token to a model, an MCP consumer or the phone; the evidence is the absence of a token in the request (`test/inference.test.ts:193-195`). |
| S12-012 | implemented | verified | `src/inference/gateway.ts:33-34`, `src/commands/inference.ts:104`; `test/inference.test.ts:149-155`. |
| S12-013 | implemented | verified | `src/inference/registry.ts:12-31`, `:229-258`. Rate limits and price observation dates are fields that are always null until a probe (`test/inference.test.ts:166`). |
| S12-014 | implemented | weaker | Selection is checked per operation (`test/inference.test.ts:24-27`, `test/photo.test.ts:154`), but no code probes anything; see S12-004. |
| S12-015 | implemented | weaker | Reservation before dispatch, settlement and uncertain holds are real (`src/inference/service.ts:261`, `test/inference.test.ts:48-61`, `test/reservation-reconcile.test.ts:63-130` by name). Tool charges are not reserved: nothing under `src/tools/` reserves, and search, extraction and browser calls are bounded by call counts only. |
| S12-016 | implemented | verified | `src/inference/registry.ts:192-199`, `src/commands/inference.ts:12`, `:39-41`; `test/inference.test.ts:117-131` (the board budget is untouched and still works). No test reserves under `image_backfill`. |
| S12-017 | open | verified | Nothing exists. Listed as a gap. |
| S12-018 | implemented | verified | `src/agent/assistant.ts:342-345`, `:357-360`; `test/memory.test.ts:91-94`; `test/turn-control.test.ts:232-275`. No test exhausts the maintenance budget during a compaction. |
| S12-019 | implemented | verified | `test/inference.test.ts:109-116`: the turn is `resumable` and no model was called. |
| S12-020 | partial | verified | `src/recall/projection.ts:80-97`; `test/search-projection.test.ts:67-69`, `:85-91`. |
| S12-021 | implemented | weaker | Routing is backend configuration and changes by command (`test/inference.test.ts:134-144`). A profile has no budget field (budgets belong to budget classes, `src/inference/registry.ts:192-199`), and the iOS display (`SettingsModel.swift:413`) is referenced by no test. |
| S12-022 | implemented | verified | `test/inference.test.ts:10-20`, `:166-167`; `src/inference/registry.ts:180`. |
| S12-023 | implemented | verified | `test/inference.test.ts:63-79`. Fallback happens on transport failure or timeout; nothing falls back on quality or tool behaviour. |
| S12-024 | partial | verified | `test/inference.test.ts:120-131`; daily tests by name. |
| S12-025 | partial | verified | `test/adapters-jobs.test.ts:312-317`, `:342-371`. |
| S12-026 | partial | verified | `src/agent/assistant.ts:500`; `test/photo.test.ts:47`, `:146` by name. |
| S12-027 | implemented | verified | `src/inference/registry.ts:184`, `src/agent/assistant.ts:494`; `test/journeys.test.ts:158-180` and `test/turn-control.test.ts:70-73` (research budget, own run). |
| S12-028 | partial | verified | Names only: `packages/media/test/pipeline.test.ts:123`; test-double editor, as the row says. |
| S12-029 | implemented | verified | `src/inference/registry.ts:186`; `test/memory.test.ts:87-106` (history kept). |
| S12-030 | partial | verified | `src/inference/registry.ts:133-148`; lexical search survives a search failure (`src/recall/index.ts:307-309`). |
| S12-031 | implemented | verified | Names only: `packages/domain/test/command-service.test.ts:11-84`. |
| S12-032 | implemented | verified | `src/inference/service.ts:265-267`, `:335`; `test/adapters-jobs.test.ts:315-316` (the fake model's reported ID is stored). |
| S12-033 | implemented | weaker | Kimi and GLM are fixed entries with no model ID and no route (`src/inference/registry.ts:85-116`), and the adapter loads only the OpenAI and Anthropic providers (`src/inference/gateway.ts:75`). They cannot be configured or enabled without a code change; the test asserts that Kimi is refused (`test/inference.test.ts:160`). |
| S12-034 | implemented | verified | `src/inference/registry.ts:53-84`, `:117-132`; `test/inference.test.ts:14`, `:167`. |
| S12-035 | implemented | weaker | Every profile's `effort` is `{}` and it is never sent to the provider: `spec.effort` is used only to fill the reservation row (`src/inference/service.ts:203`), and the call passes the caller's `providerOptions` unchanged (`:290`). Nothing rejects an unsupported parameter when a profile is tested. The test asserts only that `effort_json` parses as an object (`test/adapters-jobs.test.ts:316`). |
| S12-036 | partial | verified | The application performs the reads (`src/context/mandatory.ts`); no contract test reaches a real endpoint, as the row says. |
| S12-037 | implemented | verified | `src/inference/service.ts:55`, `:297`; `test/inference.test.ts:63-91`; `test/adapters-jobs.test.ts:342-371`. I did not check the "too few valid candidates" case in `src/inference/composition.ts`. |
| S12-038 | implemented | verified | `src/commands/inference.ts:49-51`; `test/adapters-jobs.test.ts:313-317`. |
| S12-039 | implemented | weaker | The fallback model receives the same context and committed commands are not reissued (`test/inference.test.ts:77-78`, `test/journeys.test.ts:310-331`). I found no code in `src/inference/` and no test that removes private reasoning blocks before a different provider is called. |
| S12-040 | partial | verified | `src/inference/service.ts:270-271`; `test/reservation-reconcile.test.ts:63-130` by name. No paid image request path exists in this package. |
| S12-041 | implemented | verified | `test/inference.test.ts:93-107`; `src/inference/registry.ts:192-199`. |
| S12-042 | implemented | weaker | The gate is that an `evaluationRef` string is present (`src/commands/inference.ts:137-139`); nothing checks that the evaluation exists or passed. The test asserts only the refusal when it is absent (`test/inference.test.ts:138-139`). |

## Gaps

Each gap names the row and the specification line, what is missing, and the evidence. Line numbers of the specification refer to `requirements/garderobe-replacement-design.md`.

### domain

- S06-003 (line 312): the third profile layer, dated examples of outfits that worked or were rejected with the owner's reasons, does not reach the model. `packages/assistant/src/context/mandatory.ts` has no such section and lists only hard rules (`:120-125`). I did not search the domain schema for a table that holds such examples.
- S06-009, S06-030, S06-032 (lines 316 and 334): these rows are owned by the foundation and are accurate for a direct command. They are listed under assistant below because the conversation path changes what the owner experiences.

### daily

- S06-014 (line 320): holds by absence only. `compose.ts` has no rule requiring a loud piece, and no test in `packages/daily/test/board.test.ts` asserts that an all-quiet board is accepted.
- S10-079 (line 671): return reminders are planned only as `notification.return_reminder` effects (`packages/assistant/src/commands/returns.ts:37-44`). No calendar effect exists for them, so "deduplicated across app and calendar" has only the app half.

### API/MCP

- S06-081 (line 377): no route lists remembered conclusions for the owner; `listMemoryConclusions` is not referenced in `apps/worker/src`. The owner can only ask the assistant.
- S06-060 (line 360): no administrative command or route calls `provisionSearchInstance`; `search.record_instance` only records a row (`packages/assistant/src/commands/reminders.ts:72-90`).

### assistant

- Confirmation instead of immediate effect. S06-009 (line 316), S06-030 and S06-032 (line 334), S10-050 (line 629), S10-085 (line 677), and the notes on S10-051 and S10-083. In conversation only wear and wash reports are recorded at once; every other change is a request the owner confirms in the app (`src/policy/classes.ts:1-25`, `src/context/mandatory.ts:36-38`). The code cites "the owner's decision of 2026-10-01". I found that decision nowhere under `requirements/` and no checklist row in this scope records it. If the decision stands, these rows need rewording or superseding rows; if it does not, the conversation path contradicts the specification and the owner amendment that an owner statement about possession or location establishes the fact.
- Library code with no production caller, marked `implemented`. S10-035 and S10-036 (lines 604 and 606) `CapabilityRegistry` and `BrowserService`; S10-067, S10-068 and S10-082 (lines 657 and 671) the browser half; S10-045 (line 621) the human handoff; S10-060 and S10-061 (lines 645 and 647) `assessClaim` and `exploreHypothesis`; S10-024 (line 588) `isExactVariantMatch`; S10-055 (line 637) `requiresRefreshBeforePurchase`; S10-014 (line 578) `buildInventoryExport` and `diffReimport`. In each case a search of `packages/*/src` and `apps/*/src` finds the symbol only at its definition and in its own test.
- S10-024 (line 588): the Worker merges all search connections into one provider and drops the error of a failed connection when another answered (`apps/worker/src/connections/outbound.ts:171-184`); reduced coverage is not recorded.
- S10-060 (line 645): a claim's status and source class are whatever the model sends (`src/tools/write.ts:303`); only "supported needs a citation" is enforced (`src/commands/research.ts:116-120`).
- S10-069 (line 659): functional parity is claimed while browser sessions, interactive actions, crawl, Live View, WebMCP and the real Google connection are blocked.
- S06-047 (line 348): summary validation is a length check (`src/agent/compaction.ts:84`); references are not validated before activation.
- S06-050 (line 350): one generic overflow classifier, and an overflow that cannot be shortened ends as `failed`, not as a resumable failure (`src/agent/assistant.ts:531-534`, `test/turn-control.test.ts:269`).
- S06-051 (line 352): event time is never written to the projection (`migrations/0200_assistant_core.sql:74-75` has the columns; no writer).
- S06-057 (line 358): AI Search is queried only for conversation episodes and only to raise rows the D1 projection already holds (`src/recall/index.ts:299-306`); garment, purchase, investigation and note documents are uploaded but never searched.
- S06-075 (line 377): deletion has no store for Browser Run recordings, Workflow step data, Queue payloads, cached extraction artifacts or generated exports (the stores named in `test/memory.test.ts:176-177` are retrieval index, ledger, transcript, summaries and AI Search).
- S06-076 (line 377): no cited code or test shows that durable steps receive references instead of raw private payloads.
- S12-002 (line 732): no Code Mode or Sandbox job exists, so the rule that neither receives a provider key is untested.
- S12-004 and S12-014 (lines 734 and 744): no code performs a capability or billing probe; results are only recorded by `inference.record_probe`, which only test fixtures issue.
- S12-015 (line 746): search, extraction and browser service charges are not reserved before the call.
- S12-033 (line 771): Kimi and GLM cannot be enabled without a code change (`src/inference/registry.ts:85-116`, `src/inference/gateway.ts:75`).
- S12-035 (line 777): effort parameters are never sent to a provider and nothing rejects an unsupported parameter at profile test time (`src/inference/service.ts:203`, `:290`).
- S12-039 (line 783): no code or test removes private reasoning blocks when the provider changes.
- S12-042 (line 785): promotion to the morning profile needs only a non-empty `evaluationRef` (`src/commands/inference.ts:137-139`).
- S10-005 (line 570): the Gmail source cannot open a thread. S10-013 (line 578): applying a sheet preview has no caller. S06-072 (line 372): the `recall_enrichment` task is declared and unused.

### media/Studio

- S06-075 (line 377): a forgotten message's private images are dereferenced in the transcript (`src/agent/assistant.ts:716`) but I found no deletion of the media assets themselves.
- S10-007 and S10-015 (lines 572 and 578): `createDriveClient` has no caller in `apps/worker/src`, so no path reads a Drive file into private media.

### iOS

- S06-081 (line 377): no screen shows remembered conclusions (the row's own note).
- S12-021 and S10-040 (lines 753 and 610): `routingLines` and `budgetLines` (`SettingsModel.swift:403-413`) are referenced by no file under `ios/GarderobeKit/Tests`.
- S10-068 (line 657): no phone surface receives a browser handoff.

### deployment

- Not implemented, honestly marked `blocked` or `open`: S06-059 and S06-069 (AI Search instances and their Gateway association, lines 360 and 366); S06-071 and S06-073 (Agent Memory, lines 370 and 374); S10-001 and S10-002 (real Gmail and Calendar acceptance and token refresh, line 562); S10-028 to S10-034 and S10-037 (crawl, sessions, interactive actions, files, Live View, WebMCP, session boundary, lines 597 to 606); S12-007, S12-008 and S12-017 (dedicated gateways, logging settings, refill state, lines 738 and 746).
- S12-004, S12-014, S12-022 (lines 734, 744, 755): no profile has been probed on a real Gateway; every passing probe in the repository is a test fixture.

### tests

- S06-020 (line 324): no test has a summary that claims an arrival or a retirement.
- S06-043 (line 346): no test asserts the pre-inference counts or the skip of a profile whose window is too small.
- S06-046 (line 347): no test covers the appended IDs and links or the pending-tool-pair boundary.
- S06-049 (line 349): no test re-proposes a committed action in a later turn after its narrative was compacted away.
- S06-031 (line 334): the order profile, amendments, precedence is in the code but not asserted. S06-061 (line 360): no test supplies an instance name or an owner header from a client. S12-016 (line 746): no test reserves under `image_backfill`. S12-018 (line 749): no test exhausts the budget during compaction.

### evaluation

- S06-021, S06-022, S06-023 and S10-064 (lines 328, 330 and 653) are honestly partial: the profile is injected, and whether the advice follows it waits on a live model and independent judging.
- S06-044 (line 346): the 65% threshold is not tuned per model through evaluations.
- S12-042 and S12-024 (lines 785 and 760): no evaluation result is linked to the choice of the morning profile.

## Unmapped requirements

Searched for in `requirements/CHECKLIST.md` by phrase; none of these has a row whose wording carries it.

- `garderobe-replacement-design.md` line 619: "Query-focused extraction may omit context, so important fit or care claims must be checked against sufficient surrounding content." S10-044 covers missing fields and visual evidence and drops this sentence.
- Line 779: "OpenAI's GPT-6 guidance specifies Responses for tool calling." S12-036 covers mandatory reads and contract tests and says nothing about which OpenAI interface the adapter uses.
- Line 746: "Gateway limits provide another control where available; they do not replace this task-level accounting." No row covers configuring Gateway limits as a second control.
- Line 736: "Cloudflare's Unified Billing uses prepaid credits and adds a 5% fee when credits are purchased." No row says whether cost accounting includes the fee.
- Line 744: "A passing text call is not proof that the same Gateway route supports ... a particular reasoning parameter." S12-014 lists text, tools, vision and image editing and omits probing of reasoning parameters.
- Line 590: "exact provider tool names are mapped from the pinned release and discovered catalogue." Rows S10-025 to S10-033 cover the table and none covers this mapping.
- Line 374: "The July query must still distinguish what the owner liked from what the assistant suggested." S06-052 covers this for the D1 projection; the blocked Agent Memory row S06-073 does not carry it as an adoption test.
- Line 677: "without making the owner maintain another profile." S10-087 keeps the explanation and drops this clause.
- Line 312: "Dated examples record outfits that worked, combinations rejected, and the owner's explanation of why." S06-003 names the three layers, but no row requires a store or a capture path for the dated examples.
- Line 360: "do not infer a new runtime account token requirement from an unrelated Gateway-management HTTP 403." Guidance to the implementer; no row, and probably none is needed.

