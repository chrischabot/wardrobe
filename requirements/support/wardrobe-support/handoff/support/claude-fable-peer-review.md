# Peer review: Garderobe replacement design (Revision 2)

**Verdict: revise before Phase 1.** The architecture is coherent at the level of ownership boundaries (D1 facts, Think Session transcript, R2 media, receipts as the recovery boundary) and does not invent platform features in its core loop. It is not yet implementable as written because six load-bearing mechanisms are asserted rather than specified: transcript backup, idempotency-key derivation across Think eviction, D1 abort-on-conflict, inbound MCP authorization, the Google consent path for unattended refresh, and the rule for when the full profile reaches the model. None requires rebuilding the design. Nothing below was tested against a live platform; items marked **verify** are claims I could not confirm from the document alone.

## Findings

**1. The canonical transcript has no backup. Severity: high. Definite.**
§4 and §5 make Think Session (DO SQLite) canonical for transcript text; §15 backs up "D1 exports, source assets, and manifests" and the §16 restore drill lists identities, quantities, wear revisions, style versions, media links and pending effects. Session is absent from both. §6 also keeps "deletion tombstones through the backup-retention interval", which presumes a transcript backup that does not exist.
Failure: a DO namespace loss or a bad migration destroys years of the "one continual chat" while the recall index in D1 survives and points at nothing.
Correction: add a periodic Session export (raw messages, attachments manifest, compaction checkpoints) to the R2 backup set; add transcript restore to the drill; state whether DO point-in-time recovery is relied on and for how long.

**2. The profile is omitted from "simple" turns. Severity: high. Definite contradiction.**
§6: "Ordinary status commands and simple factual queries do not need the entire taste essay" and profile injection happens "on relevant turns". The supplied profile's preamble forbids any compressed or absent stand-in, and §17 requires "a model that makes no tool calls still receives mandatory ... taste ... context". Relevance would have to be judged before inference, by heuristic or a paid classifier call, and the research shows "what socks with this?" is where taste failures occurred (9 Aug, 21 May).
Correction: inject the full profile on every turn that reaches a model; rely on provider prompt caching keyed by profile version. Skip it only on the no-model path (§12 "Routine native commands").

**3. Profile text and structured facts will disagree, with no stated precedence. Severity: high. Definite.**
§6 offers two modes at once: "the original full profile plus its current amendments, or the owner's edited replacement document." Profile §8.2 (sneakers only), §7 (44/44/17) and §8.5 are ingested as D1 restrictions and dated measurements. When the owner says the feet have healed, the restriction lifts in D1 but the verbatim profile still reads "sneakers only".
Failure: the composer refuses welted shoes after release, or two edits (Settings > My style vs chat correction) silently diverge.
Correction: define one rule in the system context: structured D1 state overrides profile prose for availability, restrictions, measurements and sizes; profile prose governs taste. Define that an edited document supersedes prior amendments and re-derives structured rules through the §5 change-preview path.

**4. Idempotency across Think eviction is asserted, not designed. Severity: high. Definite gap.**
§8 gives every command a key; §17 requires "no duplicate wear" after eviction mid-tool-call. Nothing says where a model-issued tool call gets its key. If Think recovery re-runs the model, it may emit a fresh tool call with a new ID and a fresh key after D1 already committed.
Correction: derive the key deterministically from (session, turn ID, tool-call ID); additionally reject a second identical command body from the same turn within a short window. **Verify** whether Think replays the pending tool call with its original ID or re-samples the model, since the two need different guards.

**5. D1 cannot express "abort the batch on a zero-row conditional update". Severity: high. Definite mechanism gap.**
§8 correctly forbids "a zero-row conditional update followed by unconditional inserts", but D1 batches are atomic without control flow or interactive transactions; a later statement cannot observe an earlier statement's rowcount.
Correction: make every statement in the batch conditional on the same version predicate (`INSERT ... SELECT ... WHERE EXISTS (version match)`), then verify expected rowcounts post-batch and treat a mismatch as a clean no-op conflict. State this in §8 so the §17 concurrency fixture tests the real mechanism.

**6. Inbound MCP authorization is missing. Severity: high. Definite omission.**
§13 says owner and scopes derive from "the authenticated connection" and §15 covers Sign in with Apple and outbound OAuth, but no section names the authorization server that issues tokens to Claude and ChatGPT: discovery, dynamic client registration, consent UI, token lifetime, revocation. The research's costliest transport failure (R58) was exactly this: reconnecting required a builder-held secret.
Correction: specify the OAuth AS the MCP server fronts (for example Cloudflare's Workers OAuth provider), consent completed in the iOS app or web board with the owner's Apple session, read vs write scopes as separate grants, and a phone-only revoke/reconnect path; add it to Phase 1 exit criteria.

**7. Unattended Gmail refresh has no consent path. Severity: high. Definite gap; specifics to verify.**
§15 notes seven-day refresh expiry in Testing and that Gmail read is a restricted scope, then requires "verify unattended token refresh" as acceptance. A personal Gmail account cannot use an Internal OAuth client, and a Production client with restricted scopes needs Google verification (and, for restricted scopes, a security assessment). The Google Workspace MCP endpoints in §10 are Developer Preview and may also be gated by account type.
Failure: the morning service works for six days, then Calendar projection and receipt import fail every week.
Correction: decide the path before Phase 1: apply for verification with the restricted scope, or use a narrower non-restricted scope plus owner-forwarded receipts, or accept a weekly re-consent with a one-tap phone flow. Record the Google MCP eligibility result per endpoint.

**8. Concurrent turn semantics on a single Think actor are unspecified. Severity: medium. Verify plus omitted UX.**
§4 promises a long crawl "cannot monopolize the actor" and background results are appended "without interleaving". A DO processes one turn at a time; §3 never says what happens when the owner sends "the chino is in the wash" while a turn streams (queue, interrupt, or parallel run), what **Stop** does to already-committed commands, or how an appended background result appears in the transcript.
Correction: run background jobs in Workflows or separate actors; define mid-turn messages as queued with a visible "waiting" state, Stop as "cancel remaining work, keep receipts"; and **verify** that Session can append a system/result message without starting an inference turn.

**9. Raw history versus compacted history rests on unverified Session behavior. Severity: medium. Verify.**
§5, §6 and §13 assume Session retains all original messages after compaction, exposes FTS over them, allows cursor paging of the raw transcript, supports per-message deletion, and lets a compaction summary be replaced after a deletion invalidates it. If compaction rewrites the stored history, or deletion is whole-session only, then "July recall from source" and "forget and restore" (§17) cannot pass.
Correction: make these five behaviors an explicit Phase 1 spike; if any fails, mirror raw messages to D1/R2 as the canonical archive and treat Session as working context only. Also record the actual names of the compaction hooks (`onCompaction`, `compactAfter`) against the pinned release.

**10. Native flows omitted from the app. Severity: medium. Definite omissions.**
- Laundry: §5 defines pickup, return-with-exceptions and **Socks washed**, but §3 Wardrobe lists only **In the wash**, **Back from the tailor**, **Arrived**, **Put into storage**. The weekly cycle is chat-only.
- Choose → wear: §3 says **Choose** is intention, **I wore this** is wear. The record shows wears often go unlogged; the 9 PM composer then applies the 7-day repeat rule blind. No conversion or evening prompt is specified.
- Undo: §6 promises undo instead of confirmation; no surface, duration or scope is defined.
Correction: add a laundry sheet (pickup / return with exceptions / socks washed), an end-of-day one-tap "wore the chosen outfit" prompt with Choose treated as provisional wear for repeat checks only, and undo as a receipt-card action with a stated window.

**11. Model and tool inference routing depends on eligibility not yet known. Severity: medium. Verify.**
§12's initial routing table is built on DeepSeek, Kimi and GLM, all gated on a Unified Billing probe; if `deepseek-flash` is ineligible the conversation profile defaults to Fable 5.1 with different cost and latency, and the September 19 credential gap means no probe has run. Also: the OpenAI image-edit endpoint through Gateway under Unified Billing is unproven; Tavily `include_answer` returns model text and must be disabled; Browser Run **Live View**, WebMCP discovery and crawl cancellation are listed as capabilities without citation. §10 handles `/json` correctly.
Correction: label the §12 table "pending probe" with the Fable fallback made explicit as the launch conversation model; add the Tavily parameter rule; mark the three Browser Run items as spike-verified before they enter §17.

**12. Free-tier arithmetic conflicts with stated budgets. Severity: medium. Definite for Browser Run, verify for Workflows.**
§11 allows up to two browser sessions per unresolved garment across ~300 items; §14 records 10 browser minutes per day on Free. At one to two minutes a session the backfill spans weeks, and any interactive product research competes for the same minutes. §14's "3,000 steps per day" for Workflows and the 10 ms CPU per step are figures I could not confirm; the §7 validation of dozens of candidates may exceed a 10 ms step. §11 storing cached rendition sizes in R2 also makes the Images transformation allowance largely redundant.
Correction: state the expected backfill duration under Free and the paid-minute trigger; run validation inside the DO or a Worker, not a Workflow step; pick either Images transforms or R2 renditions.

## Remaining acceptance risks

- **MCP 2026-07-28 contract (§13).** The wire-level description (header routing, MRTR shape, `_meta` envelope) postdates what I can confirm. The design's rule to use the SDK representation is the right safeguard; consumer-client protocol support at launch is unknown, so the compatibility adapter may carry all real traffic.
- **Calendar event shape (§9).** The research settled an all-day 07:00 event; the design proposes a 7:00–7:15 transparent timed event. It is a user-visible change and should be confirmed by the owner, not defaulted.
- **Deletion versus compaction regeneration (§6)** re-runs paid summarization on every forgotten fact; acceptable at this scale but unbudgeted in §12.
- **Google Workspace MCP write behavior (§10)** is already flagged; keep the Calendar API projector as the launch path, not the fallback.
- **Exa authentication (§19)** worked unkeyed; sustained use and rate limits are untested.
