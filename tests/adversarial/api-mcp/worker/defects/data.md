# Open defects found by the data, media, outbound-policy and secrets files (08, 10, 11, 12)

> **Status 2026-10-12:** D08-4 is fixed and re-verified (an ordinary `[fixed D08-4]` test). D08-1, D08-3, D10-1, D10-2 and
> D11-1 pass only on unpublished edits in the shared tree and stay open until those fixes are on the branch. New
> failures N-1, N-2 and N-8 are listed in `../DEFECTS.md`.

Commit under test: garderobe-rebuild 5db4fd87 (`adv-base-5db4fd8/`). Each entry was found with a `defect(...)` test that asserts the
correct behaviour and fails while the defect is open; `npm run test:strict` shows the failure text. Fixed entries
are now ordinary `[fixed <id>]` tests.

### D08-1: an export or backup download ticket is honoured on the MCP hostname as well as the app hostname
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/08-imports-exports.test.ts, "an export or backup download ticket is honoured on the MCP hostname as well as the app hostname"
- Expected: The two hostnames are separate trust domains (apps/worker/README.md, "Two trust domains"; specification section 15): the MCP hostname serves `/mcp`, `/.well-known/oauth-*`, `/oauth/token` and `/oauth/register` only. The owner's whole wardrobe package is not downloadable there.
- Actual: `GET http://127.0.0.1:8787/v1/exports/{id}/download?ticket=...` answers 200 `application/zip` with the package; the same for a backup ticket (`{"export":200,"exportType":"application/zip","backup":200}`).
- Reproduction: as the owner `POST /v1/exports`, `POST /v1/exports/{id}/ticket`; then `GET {MCP origin}{ticket url}` with no credential. Same with `POST /v1/backups` and `POST /v1/backups/{id}/ticket`.
- Where: apps/worker/src/router.ts:64-66 (the hostname check covers only `access` and `access_identity` routes; `ticket` and `one_time_state` routes are served on any hostname); apps/worker/src/routes/export.ts:23. Same cause as D10-2.

### D08-2: an import that fails part-way reports "nothing from it was kept" but leaves records and image files behind, and the account can then no longer be imported into
- Severity: medium
- Status: open. A fix in the shared tree passed this test on 2026-10-13. The API/MCP workstream then took it back out, because by coordinator ruling it lands only with or after the assistant's held change (`discardImportedConversation`); the test is an expected failure again.
- Owning workstream: API/MCP (apps/worker)
- Test: test/08-imports-exports.test.ts, "an import that fails part-way says 'nothing from it was kept' but leaves the records of the modules that had already been written"
- Expected: Specification section 15 (portable export: "import the package into an empty isolated owner fixture"); the import's own report says "The package could not be imported; nothing from it was kept." A failed import leaves the account empty and able to take a good package.
- Actual: With a package whose image records are refused (after the ledger, daily, assistant and conversation parts were written) the answer is 200 `state: "failed"` with that sentence, but the account keeps 1 `research_notes` row, 2 `conversation_index` rows, 1 `conversation_index_state` row, 2 conversation messages (served by `GET /v1/conversation/messages`) and 2 image objects in the private bucket with no record. A second import of the unmodified package then fails too (the Worker logs "import needs an empty owner: research_notes already has records"); the account stays without a wardrobe.
- Reproduction: export an account that has a research note, a conversation turn and a photo; in `records/media.json` set every `records.records.renditions[].file` to `../../not-a-media-path`; recompute `manifest.json` and `checksums.sha256`; `POST /v1/imports` into an empty account; read the tables, the transcript and the bucket prefix `u/<owner>/`; `POST /v1/imports` again with the original package.
- Where: apps/worker/src/export/import.ts:228-253 (the cleanup deletes only the ledger tables listed in `written`; what `app.daily.importData`, `app.assistant.importData` and `app.media.importData` wrote at lines 205-224, and the image objects already stored, are not removed); packages/assistant/src/export.ts:68-71 (the next import refuses an owner that has any assistant record).

### D08-3: the importer inflates a package without any bound: a 313 KB upload that expands to 256 MB in one entry is accepted and imported
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/08-imports-exports.test.ts, "the importer inflates a package without any bound: a small upload that expands to 256 MB in one entry is accepted and imported"
- Expected: Specification section 15 ("response limits" for untrusted input) and the route's own 95 MB limit on a package: a zip bomb or oversized entry is refused before it is inflated.
- Actual: `POST /v1/imports` answers 200 `state: "completed"` for a 313 KB package containing one listed entry of 256 MB of zero bytes (ratio 837:1); every entry is inflated into memory and hashed. On a deployed Worker (128 MB) this exhausts the isolate. Only the signed-in owner can send it, to their own account.
- Reproduction: take an export; add `records/zeros.json` (256 MB of zero bytes, deflated) to the ZIP, list it in `manifest.json` `files` with its size and SHA-256 and in `checksums.sha256`; `POST /v1/imports` into an empty account.
- Where: apps/worker/src/export/package.ts:165-166 (`unzipSync(bytes)` with no size check); apps/worker/src/routes/export.ts:10 and 28 (the only limit is on the compressed body).

### D08-4: a background job that is still queued inside a package is started by the scheduled sweep after the import, with the new account's Google grant
- Severity: medium
- Owning workstream: assistant (packages/assistant)
- Test: test/08-imports-exports.test.ts, "a background job that is still queued inside a package is started by the scheduled sweep after the import (a mailbox search with the new account's Google grant)"
- Expected: Specification section 15: an import happens "without ... replaying external effects"; apps/worker/src/export/import.ts says "work that had not been done stays undone and is never dispatched from an import" and does this for `effects` rows.
- Actual: An `assistant_jobs` row of kind `email_investigation` in state `queued` is imported as it is. After the account's owner connects Google with mail access, the next scheduled sweep runs it: one request to `/gmail/v1/users/me/messages` left the Worker and two `job.update` commands were recorded (the job ended `failed` only because the Google fixture has no such resource). The package can also carry the `job.create` receipt (`actor: owner`, `authorization_basis: owner_tap`) that the runner reads to decide whether found orders may be logged; logging of orders was not observed because the fixture returns no mail.
- Reproduction: export an account; add to `records/assistant.json` `tables.assistant_jobs` a row `{kind: "email_investigation", state: "queued", params_json: {from, to, importAuthorizedBy: "owner_confirmation"}}`, and to `records/receipts.json` a `commands` row of type `job.create` (actor owner, owner_tap) with a `command_entities` row `{kind: "job", entity_id: <job id>}`; recompute manifest and checksums; `POST /v1/imports` into an empty account (200, completed, `externalEffectsReplayed: 0`); connect Google with `gmail.read_orders`; `GET /v1/connections`; run the scheduled handler.
- Where: packages/assistant/src/export.ts:28 and 72-79 (`assistant_jobs` rows are inserted with their state); packages/assistant/src/jobs/runner.ts:86 (the sweep starts every queued job of these kinds); packages/assistant/src/jobs/purchases.ts:95-103 (the authorization is read from command rows, which an import also writes); apps/worker/src/export/import.ts:167-171 (only `effects` are neutralised).

### D10-1: the sign route mints a bearer URL for the original photograph, which is then served with its GPS metadata to whoever holds the link
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/10-signed-media.test.ts, "the sign route mints a bearer URL for the ORIGINAL photograph, which is then served with its GPS metadata to anyone holding the link"
- Expected: The original (full resolution, with whatever metadata it carried) goes only to the owner in the app through an authenticated read; a link that works without a session carries a derived, metadata-free copy (specification section 11: "Strip location metadata from derivatives"; packages/media/src/delivery.ts: "Outside the owner's own app only derived, metadata-free copies are ever linked").
- Actual: `POST /v1/media/renditions/{original rendition}/sign` answers 200 with a URL, and `GET /v1/media/signed/{token}` (no session) serves the exact uploaded bytes, Exif GPS pointer included, for up to 15 minutes. The Worker always signs with audience `app`, while its README says these links are opened by Calendar and the share sheet without a session.
- Reproduction: upload a JPEG with an Exif GPS IFD for a garment; read the `original` rendition ID; as the owner `POST /v1/media/renditions/{id}/sign`; `GET` the returned URL with no credential; compare the SHA-256 with the upload.
- Where: apps/worker/src/lanes/media.ts:72 (`audience: "app"` for every caller); packages/media/src/delivery.ts:179-188 (an original may be signed for audience `app`); apps/worker/README.md:138. Note: packages/media/test/rereview-fixes.test.ts:201-202 asserts that the owner principal can sign the original, so the media package treats this as intended inside the app; the defect is that the HTTP route cannot tell an in-app image view from a link that is handed on.

### D10-2: token-authenticated media routes (signed image link, upload target) are served on the MCP hostname as well as the app hostname
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/10-signed-media.test.ts, "token-authenticated media routes (signed image link, upload target) are served on the MCP hostname as well as the app hostname"
- Expected: As D08-1: the MCP hostname serves the MCP transport and its OAuth endpoints only; private media is delivered and received on the app hostname.
- Actual: `GET http://127.0.0.1:8787/v1/media/signed/{token}` answers 200 with the image; `PUT http://127.0.0.1:8787/v1/uploads/{id}/content?token=...` is accepted and the bytes are staged.
- Reproduction: as the owner sign a rendition and authorize an upload; send both requests to the MCP origin.
- Where: apps/worker/src/router.ts:64-66; apps/worker/src/routes/media.ts:53 and 86. Same cause as D08-1.

### D11-1: an owner-added tool service is called by name without resolving it: an endpoint whose DNS answer is a private address is contacted, with the connection's key
- Severity: high (classified as a security defect by the project coordinator: the specification's outbound rule is not enforced on this path and a credential is sent. The suite's own estimate of impact is lower, because the owner must add the service himself and no request reached a real private address in a local run)
- Owning workstream: API/MCP (apps/worker)
- Test: test/11-outbound-ssrf.test.ts, "an owner-added tool service is called by name without resolving it: a public-looking endpoint whose DNS answer is a private address is contacted, with the connection's key"
- Expected: Specification section 15: "Validate remote URLs and OAuth redirects, and prevent requests to loopback, private infrastructure, metadata endpoints". The image search does this by resolving the name over DNS-over-HTTPS and failing closed (packages/media/src/pipeline/safe-fetch.ts); the connection path should not be weaker.
- Actual: With the resolver answering `10.0.0.5` for the endpoint's host, `POST /v1/connections` (kind `mcp`, secret) answers 200 `state: "connected"`; one `tools/list` request was sent to the host with `Authorization: Bearer <the key>`; the resolver was never asked. Only the form of the URL is checked. Whether the deployed platform refuses a private destination by itself (`global_fetch_strictly_public`) was not verified here and cannot be in a local run: in this suite every outbound request ends in the test double, so no request reached a real private address.
- Reproduction: plant the DNS answer `{Status: 0, Answer: [{type: 1, data: "10.0.0.5"}]}` at `https://cloudflare-dns.com/dns-query?name=<host>`; `POST /v1/connections {kind: "mcp", endpoint: "https://<host>/mcp", auth: {type: "secret", secret}}`; read the outbound log.
- Where: apps/worker/src/connections/endpoints.ts:38-57 (`checkRemoteUrl` examines the literal URL only; lines 6-7 rely on the platform flag) and 103-113 (`guardedFetch`); apps/worker/src/connections/outbound.ts:24-37. packages/assistant/src/research/web/url.ts:123 says the same of the assistant's check ("DNS resolution is the fetcher's concern").

### D11-2: the Calendar link setting accepts any text as the board address: a `javascript:` address is saved and written into the Calendar event
- Severity: high (classified as a security defect by the project coordinator: an unvalidated address reaches text that other programs render as a link. The suite's own estimate of impact is lower, because only the owner's own setting, or a request he confirms, can store it)
- Owning workstream: daily (packages/daily)
- Test: test/11-outbound-ssrf.test.ts, "the Calendar link setting accepts any text as the board address: a javascript: address is saved and written into the Calendar event"
- Expected: An address the application puts into text other programs render as a link is validated like every other address someone supplies (specification section 15, "Validate remote URLs"): an https address, or refused.
- Actual: `settings.update` with `extensions.daily.calendar.boardBaseUrl: "javascript:alert(document.domain)//"` answers 200, and the projected Calendar event's text contains `javascript:alert(document.domain)/board/<date>`. The Worker itself never fetches the address (asserted by an ordinary test).
- Reproduction: connect Google and create the outfit calendar; `POST /v1/commands {type: "settings.update", payload: {patch: {extensions: {daily: {calendar: {boardBaseUrl: "javascript:alert(document.domain)//"}}}}}}`; publish a board for today; run the scheduled handler; read the event.
- Where: packages/contracts/src/ext/daily.ts:599 (`boardBaseUrl: z.string().nullable()`); packages/daily/src/calendar/projector.ts:161-163.

### D12-1: redaction of credentials before storage misses common forms
- Severity: medium
- Owning workstream: assistant (packages/assistant)
- Test: test/12-secrets.test.ts, "redaction of credentials before storage misses common forms: they stay in the transcript, the recall index, the model's input and the export"
- Expected: Specification section 15: credentials are never returned "through chat, MCP resources, diagnostic bundles, or logs"; packages/assistant/src/policy/secrets.ts: credentials pasted into the conversation are removed before anything is stored or shown to a model.
- Actual: Of 28 forms said in an owner message, 22 are replaced by `[secret removed]`. These six stay in clear in `GET /v1/conversation/messages`, `conversation_index.excerpt`, the model's input, the export and the backup: a Stripe secret key (`sk_live_` + 24 characters), an AWS secret access key written as `aws_secret_access_key = <40 characters with />`, an npm token (`npm_` + 36), a GitLab personal access token (`glpat-` + 20), a Telegram bot token (`<digits>:<35 characters>`), a Hugging Face token (`hf_` + 34).
- Reproduction: `POST /v1/conversation/turns` with, for example, `text: "For the tailor's portal: charge with sk_live_<24 characters>"`; `GET /v1/conversation/messages`.
- Where: packages/assistant/src/policy/secrets.ts:19-84 (`provider_key` matches `sk-` but not `sk_`; no pattern for `npm_`, `glpat-`, `hf_` or the Telegram form; the labelled-secret patterns need a word boundary before `secret`, which `aws_secret_access_key` does not have; `opaque_token` needs 40 characters without `/`).

### D12-2: a credential in the assistant's own reply is removed from the run result but stored and served in clear
- Severity: medium
- Owning workstream: assistant (packages/assistant)
- Test: test/12-secrets.test.ts, "a credential in the assistant's own reply is removed from the run result but stored and served in clear: transcript text, recall index, export and backup"
- Expected: As D12-1: secret hygiene applies to everything stored (transcript, retrieval index, export). The product already redacts the reply in the run result, so the same reply must not be readable elsewhere.
- Actual: When the model's reply contains `sk-proj-...` and `password: ...` (forms the redaction recognises), `GET /v1/runs/{id}` shows `[secret removed]`, but the same reply is readable in clear in the `text` field of `GET /v1/conversation/messages` (its `parts` are redacted), in `conversation_index.excerpt`, in `POST /v1/recall/search` results, and in the export and the backup.
- Reproduction: script the FAKE MODEL reply `your key is sk-proj-<24+ characters> ... password: <value>`; `POST /v1/conversation/turns`; read the run, the transcript, recall, the table and an export.
- Where: packages/assistant/src/agent/assistant.ts:561 (only the reply projection is redacted) and 1073 (`text: textOf(parts)` beside `parts: redactDeep(parts)`); the stored message and the retrieval projection are written from the unredacted parts.

### D11-3: OAuth metadata of an owner-added service that names a `javascript:` sign-in address is answered 500 `internal` instead of a refusal
- Severity: low (nothing harmful is handed out: no sign-in address reaches the owner and no connection is made; the server error is the defect)
- Owning workstream: API/MCP (apps/worker)
- Test: test/11-outbound-ssrf.test.ts, "OAuth metadata that names a javascript: sign-in address is answered with a server error (500 internal) instead of a refusal". Confirmed by running it on 2026-10-13: the expected failure fails as described.
- Expected: a hostile service's metadata is input to refuse, with a 4xx naming the problem or an unusable connection, as for every other hostile variant in the same file.
- Actual: `POST /v1/connections` answers 500 `internal`.
- Reproduction: plant protected-resource metadata and authorization-server metadata with `authorization_endpoint: "javascript:alert(document.domain)"` at a public test host; register `{ kind: "mcp", endpoint: "https://<host>/mcp", auth: { type: "oauth" } }`.
- Where (read, not traced in a debugger): the MCP SDK's URL check throws on the metadata, and `apps/worker/src/errors.ts:28-37` maps the unknown error to 500.

### Note, not filed: an import whose image records are all set aside reports media imported in full
An import whose image records are all set aside (for example rendition paths containing `..`) completes and reports media as imported in full, with no note (`apps/worker/src/export/import.ts:203`). No test is written for this; it was observed while changing the D08-2 trigger.
