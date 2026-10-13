# Open defects: profile integrity and hard-rule enforcement (test/07-profile-constraints.test.ts)

> **Status 2026-10-12:** P07-1 to P07-9 are all fixed and re-verified. Their tests are now ordinary `[fixed <id>]`
> tests; see "Fixed and re-verified" in `../DEFECTS.md`. The entries below are kept as the record of what was found.

Commit under test: garderobe-rebuild 5db4fd87. Every entry was an expected-failure test (`defect(...)` in the
test file) while open; each was confirmed to fail for the stated reason in a strict run
(`ADVERSARIAL_STRICT=1 npx vitest run test/07-profile-constraints.test.ts`). All what-if edits were made on
throwaway copies of the owner's data or on the labelled synthetic owner; none is the owner's statement.

### P07-1: Correcting a welted shoe's footwear kind to "sneaker" silently releases it from the active sneakers-only restriction
- Severity: high
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/07-profile-constraints.test.ts, "correcting a welted shoe's footwear kind to 'sneaker' does not release it from the active sneakers-only restriction"
- Expected: Specification section 6: "Sneakers-only wear remains active until the owner says the feet have healed; all welted footwear and the New Balance 990v6 are excluded during that restriction"; section 4: a tool cannot "alter a restriction merely to pass validation"; section 7: temporary restrictions are "dated records with explicit resolution". Profile section 8.2. A garment covered by an active restriction leaves it only through `restriction.resolve`; a correction of the garment's attributes is refused, or the garment stays excluded.
- Actual: `garment.correct` answers 200 ("Paraboot Michael Cerf: corrected attributes", no mention of the restriction). The shoe's availability becomes `available`, `restrictionIds: []`. The boards for the next three days offer it as the shoe of 1, 2 and 1 of 5 outfits (the journey suite's independent checker reports "not a sneaker while the sneakers-only rule holds" for each), and a recommendation naming it as a locked piece builds an outfit around it. The row in `restrictions` still reads `status = 'active'`, `resolved_at IS NULL`: nothing records that a garment was released.
- Reproduction: as the signed-in owner (app session, `owner_tap`): (1) `POST /v1/commands` `garment.correct` `{ garmentId: <Paraboot Michael Cerf>, changes: { attributes: { footwearKind: "sneaker" } }, source: { kind: "owner_statement" } }`; (2) `GET /v1/items/<id>`; (3) `POST /v1/recommendations` `{ mode: "board", date: <tomorrow> }`; (4) `POST /v1/recommendations` `{ mode: "preview", lockedGarmentIds: [<id>] }`.
- Where: the restriction's scope is a selector over the garment's own mutable attributes (`packages/domain/src/import/profile.ts:293`, evaluated by `restrictionCovers` in `packages/domain/src/availability/estimator.ts:82-95`); the validator's sneakers-only check reads the same attribute (`packages/daily/src/validate.ts:119-126`); `garmentCorrect.plan` (`packages/domain/src/handlers/garments.ts:246-278`, attribute merge at line 202) never looks at active restrictions.

### P07-2: Correcting the 990v6's model silently releases it from the active restriction
- Severity: high
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/07-profile-constraints.test.ts, "correcting the 990v6's model does not release it from the active restriction (same cause as P07-1)"
- Expected: As P07-1: the 990v6 is excluded until the restriction is resolved by the owner's explicit statement.
- Actual: On the labelled synthetic owner with a SYNTHETIC restriction of the same scope as the imported one: `garment.correct` answers 200; `GET /v1/items/shoe-990v6` shows `hardExcluded: false`, `restrictionIds: []`; a preview with it locked returns an outfit; 5 board outfits over three days offer it. The restriction row is still `active`.
- Reproduction: synthetic owner: (1) `restriction.add` `{ kind: "healing", scope: { anyOf: [{ category: "footwear", footwearKinds: ["welted","boot","other"] }, { models: ["990v6"] }] }, reason: "SYNTHETIC ...", source: { kind: "owner_statement" } }`; (2) `garment.correct` `{ garmentId: "shoe-990v6", changes: { attributes: { model: "990v4" } }, source: { kind: "owner_statement" } }`; (3) `GET /v1/items/shoe-990v6`; (4) `POST /v1/recommendations` board and locked preview.
- Where: same cause as P07-1 (`models` clause of `restrictionCovers`, `packages/domain/src/availability/estimator.ts:88-91`; `excludedModels` check in `packages/daily/src/validate.ts:122-123`).

### P07-3: A decision in a profile save can rewrite the rule that carries the active restriction (allowed footwear widened through prose)
- Severity: medium
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/07-profile-constraints.test.ts, "a decision in a profile save cannot rewrite the rule that carries the active restriction (its allowed footwear widened through prose)"
- Expected: Specification section 6 ("Save in My style") and the contract (`StyleFactResolution`: "an active restriction is never lifted by editing prose"); the handler's own statement: "Editing prose never lifts a restriction: while it is active, the rule that carries it stays as it is." A `replace` decision on `footwear.sneakers_only_until_healed` is refused (403) while the restriction is active, as `retire` and a status change are.
- Actual: `style.save_document` with the rule's passage reworded and `factResolutions: [{ fact: { kind: "rule", id: "footwear.sneakers_only_until_healed" }, resolution: { action: "replace", rule: { params: { ...same restrictionId, allowedFootwearKinds: ["sneaker","welted","boot","other",""], excludedModels: [] } } } }]` answers 200. The rule becomes version 2 with those parameters (origin `owner_amendment`). Shoes the restriction's scope names stay excluded by the restriction row, but an owned shoe with no recorded `footwearKind` (which only the rule kept out) is now offered: a locked preview returns 2 outfits around it.
- Reproduction: owner app session on a copy of the real data: (1) `garment.create` a labelled SYNTHETIC owned shoe without `attributes.footwearKind`; (2) `GET /v1/style`, reword the quoted passage of the rule in the document text; (3) `style.save_document` with that text, `expectedVersions: { "style_document:owner-profile": 1 }` and the `replace` resolution above; (4) `POST /v1/recommendations` `{ mode: "preview", lockedGarmentIds: [<synthetic shoe>] }`.
- Where: `packages/domain/src/handlers/style-facts.ts:181-185`: the guard compares only `next.status` and `next.params.restrictionId` with the current rule.

### P07-4: style.upsert_rule can rewrite the rule that carries the active restriction (hard to soft, allowed footwear widened)
- Severity: medium
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/07-profile-constraints.test.ts, "style.upsert_rule cannot rewrite the rule that carries the active restriction (hard to soft, allowed footwear widened)"
- Expected: The handler's own statement: "The rule that carries an active restriction stays as it is until the restriction itself is resolved: rewriting or retiring the rule is not a way to lift it." Any change to that rule is refused with `rule_carries_active_restriction` while the restriction is active.
- Actual: `style.upsert_rule` `{ key: "footwear.sneakers_only_until_healed", kind: "soft", status: "active", params: { restrictionId: "rst_profile_sneakers_only", allowedFootwearKinds: ["sneaker","welted","boot","other",""], excludedModels: [], ... }, origin: "owner_direction" }` answers 200; the rule is version 2, kind `soft`, with the widened parameters; the SYNTHETIC shoe with no recorded kind is offered (2 outfits around it).
- Reproduction: as P07-3 steps (1) and (4), with the `style.upsert_rule` command above in place of the save.
- Where: `packages/domain/src/handlers/style.ts:362-368`: only `p.status !== current.status || p.params.restrictionId !== carried` is refused.

### P07-5: Undoing the import command of the rule that carries the active restriction retires the rule
- Severity: medium
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/07-profile-constraints.test.ts, "undoing the import command of the rule that carries the active restriction is refused (as retiring it with style.upsert_rule is)"
- Expected: Specification section 8: "Undo is a compensating command with the same checks." Retiring this rule with `style.upsert_rule` is refused (403 `rule_carries_active_restriction`); undoing the command that recorded it is refused the same way. (The undo of the imported `restriction.add` itself IS refused, 403 `restriction_not_lifted_by_undo`.)
- Actual: `command.undo` of the import's `style.upsert_rule` for `footwear.sneakers_only_until_healed` answers 200; the rule row becomes `status = 'retired'`, `is_current = 0` and no current version of the rule is left. The restriction row keeps the shoes its scope names excluded, but the SYNTHETIC owned shoe with no recorded kind is now offered (2 outfits around it).
- Reproduction: owner app session on a copy of the real data: (1) `garment.create` the SYNTHETIC shoe as in P07-3; (2) find the command: `SELECT command_id FROM commands WHERE user_id = ? AND type = 'style.upsert_rule' AND authorization_basis = 'data_import' AND payload_json LIKE '%footwear.sneakers_only_until_healed%'`; (3) `command.undo` `{ commandId }`; (4) `SELECT status, is_current FROM style_rules WHERE key = 'footwear.sneakers_only_until_healed'`; (5) locked preview as in P07-3.
- Where: `styleUpsertRule.planUndo`, `packages/domain/src/handlers/style.ts:408-419`: no check for a carried active restriction (compare `plan`, lines 362-368).

### P07-6: measurement.record accepts a profile passage whose quote does not occur in the profile
- Severity: low
- Owning workstream: foundation (packages/domain, contracts, importer)
- Test: test/07-profile-constraints.test.ts, "measurement.record refuses a profile passage whose quote does not occur in the profile"
- Expected: Contract `PassageRef.quote`: "Exact quoted text; must occur verbatim in the document"; specification section 6: "derived rules reference passages" of the intact source, and measurements are "dated facts with units and a history" with their source. A measurement that cites the preserved profile for a sentence it does not contain is refused, as `style.upsert_rule` refuses an invented quotation for a rule of origin `profile` (409).
- Actual: `measurement.record` `{ subject: "body", key: "chest", value: <what-if>, unit: "in", source: { kind: "profile_passage", ref: "chris-wardrobe-profile.md@sha256:e156..." }, passage: { documentSha256: "e156...", lineStart, lineEnd, quote: "SYNTHETIC sentence that the profile does not contain (test fixture)." } }` answers 200. It supersedes the imported chest measurement, and `GET /v1/style` returns the new value with source `profile_passage` and that invented quotation against the hash of the owner's document.
- Reproduction: owner app session on a copy of the real data: the command above, then `GET /v1/style` and read `measurements[key = chest]`.
- Where: `measurementRecord.plan`, `packages/domain/src/handlers/style.ts:544-579` stores `p.passage` unverified (the verbatim check exists only in `styleUpsertRule.plan`, lines 369-378).

### P07-7: The record of a restriction can be undone from any owner channel except MCP (deny-list instead of app channels only)
- Severity: low
- Owning workstream: foundation (packages/domain, contracts, importer) and API/MCP (apps/worker)
- Test: test/07-profile-constraints.test.ts, "the record of a restriction is undone from the app channels only (the guard refuses the MCP channel instead of allowing iOS and web)"
- Expected: The handler's own statement: undoing the record of a restriction "is held to the same standard as lifting it: only the owner himself, in the app". Only an owner principal on `ios` or `web` may do it. (Previously reported; still reproduces at this commit.)
- Actual: an owner-actor principal on channel `conversation`, `scheduled`, `system`, `import` or `test` undoes an owner-recorded restriction: the command commits and the row becomes `resolved` with `resolution_json = {"undone":true}`. Only `mcp` and non-owner actors are refused. No HTTP route builds such a principal at this commit (app sessions are `ios` or `web`, `apps/worker/src/auth/session.ts:83`), so this is reachable only through the command service; the imported restriction is separately protected by its `data_import` basis.
- Reproduction: synthetic owner: (1) `restriction.add` `{ kind: "other", scope: { garmentIds: ["shoe-olive"] }, reason: "SYNTHETIC ...", source: { kind: "owner_statement" } }` in the app; (2) `app.service.execute(createPrincipal({ userId, actor: "owner", channel: "conversation", scopes: ["read","write"], authRef }), { type: "command.undo", payload: { commandId }, authorization: "owner_tap", source: { channel: "conversation" }, ... })`; (3) `SELECT status, resolution_json FROM restrictions WHERE restriction_id = ?`.
- Where: `packages/domain/src/handlers/style.ts:59` and the worker's surface guard `apps/worker/src/lanes/index.ts:80`: `actor !== "owner" || channel === "mcp"`.

### P07-8: restriction.resolve takes any owner principal that is not on MCP for the owner in the app, so a made-up evidence.ref lifts a restriction
- Severity: low
- Owning workstream: foundation (packages/domain, contracts, importer) and API/MCP (apps/worker)
- Test: test/07-profile-constraints.test.ts, "restriction.resolve treats only an app session as the owner himself (an owner principal on any channel but MCP lifts with a made-up evidence.ref)"
- Expected: The handler's own statement: "Anyone acting for the owner ... must point at the owner's statement itself, and that reference must check out ... without one nobody but the owner in the app lifts a restriction." A caller that is not an `ios` or `web` owner session has its `evidence.ref` verified.
- Actual: The previously reported item ("restriction.resolve accepting a made-up evidence.ref") is FIXED for callers acting for the owner: an assistant principal on `conversation`, `mcp`, `ios` or `web` and an owner principal on `mcp` are refused (`evidence_reference_not_verified`, `evidence_reference_required` or `owner_statement_not_verified`), nothing written (asserted by an ordinary passing test). Residue: an owner-actor principal on `conversation`, `scheduled`, `system`, `import` or `test` with `evidence: { kind: "owner_statement", ref: "msg_made_up_0001" }` commits; the reference is never verified. Reachable only through the command service at this commit, as P07-7.
- Reproduction: synthetic owner: (1) `restriction.add` as in P07-7; (2) `app.service.execute(<owner principal on channel "conversation">, { type: "restriction.resolve", payload: { restrictionId, evidence: { kind: "owner_statement", ref: "msg_made_up_0001" } }, authorization: "owner_tap", source: { channel: "conversation" }, ... })`; (3) read the restriction row.
- Where: `packages/domain/src/handlers/style.ts:107` (`actingForOwner`), and `apps/worker/src/lanes/index.ts:71` (the surface guard refuses only `mcp`).

### P07-9: A malformed garment identifier in lockedGarmentIds is answered with a server error
- Severity: low
- Owning workstream: API/MCP (apps/worker) with daily (packages/daily)
- Test: test/07-profile-constraints.test.ts, "a malformed garment identifier in lockedGarmentIds is refused as invalid input, not answered with a server error"
- Expected: Specification section 8: "The command handler validates the complete change before writing it"; a request with invalid input is refused as `invalid_command` (400). An unknown identifier is already handled (200, no outfit).
- Actual: `POST /v1/recommendations` with `lockedGarmentIds: [""]`, or an identifier of 65 characters or more, answers 500 `{ "error": { "code": "internal", "message": "an unexpected error occurred; nothing was confirmed" } }` in both `preview` and `board` mode (the Worker logs a `ZodError`). Nothing is written.
- Reproduction: any signed-in owner: `POST /v1/recommendations` `{ clientRequestId: "<8+ chars>", mode: "preview", lockedGarmentIds: [""] }`.
- Where: the request schema accepts any strings (`lockedGarmentIds: z.array(z.string())`, `packages/contracts/src/ext/api.ts:433`); `recommend` then parses them as garment identifiers inside the service (`DayBrief.parse`, `packages/daily/src/service.ts:301`; `include: z.array(GarmentId)`, `packages/contracts/src/ext/daily.ts:265`) and the uncaught `ZodError` becomes `internal`.
