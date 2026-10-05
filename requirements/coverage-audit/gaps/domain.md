# Coverage gaps: domain (ledger, commands, import, owner profile storage)

Audited at `garderobe-rebuild` commit `8445a1e`, by reading code and tests; nothing was executed. "spec" is `requirements/garderobe-replacement-design.md`, "profile" is `requirements/chris-wardrobe-profile.md`, "amendments" is `requirements/support/wardrobe-support/evals/sources/owner-amendments.md`, "research" is `requirements/support/wardrobe-support/handoff/support/garderobe-usage-research.md`. Per-row verdicts for every checklist row are in `../rows/`; the part letter after each entry says which file.

What holds: receipts, idempotency, expected versions, undo as compensation, effects and outbox, weekly reset with exceptions, hand-wash, event-order repair, per-garment per-date wear counting across clients, restrictions, per-owner isolation and the verbatim profile import are implemented and tested against a real local D1 in workerd (`packages/domain/src/testing/index.ts:1-8`).

## Rows whose status overstates what exists

| Row | Source | What is missing or weaker | Evidence | Closes when |
| --- | --- | --- | --- | --- |
| S05-005 | spec L237 | Facts carry no confidence value. | `migrations/0001_foundation.sql:229-242`; `packages/contracts/src/primitives.ts:96-112` (A) | A confidence field exists on fact sources and a test reads it back, or the row becomes partial. |
| S05-033 | spec L270 | Authority does not depend on the fact: `garment.correct` accepts any source kind, including a model inference, and overwrites the attribute. | `packages/domain/src/handlers/garments.ts:283-287`; only measurements and arrival are restricted (`handlers/style.ts:593`) (A) | Per-fact authority rules are enforced in the handler and a test shows a model inference refused for an owner-authority fact. |
| S05-002 | spec L229 | "A photograph is not proof of an unseen detail" is enforced only for measurements; a photograph can lift a restriction that requires an owner observation. | `packages/domain/src/handlers/style.ts:92-96` (A) | The restriction-lift handler refuses a photograph source where owner observation is required, with a test. |
| S05-036, S16-016 | spec L272, L1053 | The date reliable wear logging began is not preserved: the importer writes `wearLoggingSince: null` for every garment. | `packages/domain/src/import/inventory.ts:355`; `packages/domain/src/queries.ts:303` (A, F) | The import sets the date and a test reads it, or the rows become partial with the reason stated. |
| S05-056 | spec L286 | Selection priors are never learned: `learnedBoardUsePrior` is called only by its own test. | `packages/domain/src/availability/estimator.ts:299`; `packages/domain/src/queries.ts:190,208` (A) | Availability queries use the learned prior, with a test through the command service. |
| S05-071, AM-018 | spec L296; amendments L15 | No test of a continuous overnight outfit or a wear across a timezone change; the wearing date is whatever the caller sends. | `packages/domain/src/handlers/wear-care.ts:155-170` (A) | A test records an overnight wear and a wear across a timezone change and asserts one wear on the starting date. |
| S05-014, PR-030 | spec L246; profile L90 | Alterations have no record; imported body measurements are undated. | `packages/domain/src/import/apply.ts:76`; `packages/assistant/src/context/mandatory.ts:131` (A) | An alteration record exists and measurements carry the profile's date. |
| S08-021 | spec L485 | A changed proposal is treated as a new action and committed at once; nothing reconciles the earlier effect first. | `packages/domain/src/platform.ts:128-152` (A) | A test proposes, commits, then re-proposes with a changed payload and shows reconciliation before a second effect. |
| S08-019 (partial) | spec L485 | `pendingActionIntents` has no caller; recovery reconciles an intent only if the model re-proposes the same effect; the `abandoned` state is never written. | `packages/domain/src/platform.ts:155`; `packages/assistant/src/tools/runtime.ts:280-288` (A) | Recovery calls the reconciliation helper on start and a test shows a pending intent resolved without the model. |
| S08-007 | spec L471 | `garment.remove_fabricated` has no test of its effect on wears, aliases or stock. | `packages/domain/src/handlers/garments.ts:716-742` (A) | A test asserts the removal and its consequences. |
| S08-022 | spec L487 | No test retries an action after a long delay. | (A) | A delayed-retry test returns the original receipt. |
| S16-009 | spec L1047 | The importer takes only the profile and the inventory sheet; orders, wear history, laundry facts, saved combinations, calendar identifiers and image manifests cannot be imported. | `packages/domain/src/import/apply.ts:27` (F) | The migration boundary accepts those record kinds with reconciliation, or the row becomes partial naming what is not importable. |
| S16-015 | spec L1053 | The reconciliation report has no lifecycle state, received against available quantities, wear dates, outstanding laundry, order lines, unresolved aliases or missing assets. | `data/import/inventory-import-report.md` (F) | The report carries those sections (empty where the source has none, saying so). |
| S16-001 | spec L1030 | "No previous domain implementation is copied" rests on no test or check. | cited `packages/domain/test/import.test.ts` tests the importer (F) | The row cites a real check, or is reworded as a governing statement. |
| S01-005 | spec L13 | Unsupported: the cited foundation files contain nothing about the September 15 decisions. | `packages/domain/src/import/`; `packages/domain/test/import.test.ts` (B) | The row cites the amendment rows' evidence (AM-020 onward). |
| S01-001, S02-001, S01-003 | spec L5, L35, L7 | The replacement boundary and "owner's request wins over research" rest on a README sentence and the import test. | `README.md:6` (B) | Rows cite `apps/worker/wrangler.jsonc` and a precedence test, or become governing statements. |
| S07-048 | spec L435 | The trouser single-wear care rule is stored but no cited test exercises it. | `packages/domain/src/import/profile.ts:259`; uncited `packages/domain/test/wear.test.ts:25` (B) | The row cites the wear test. |
| R02 | research L279; spec L1163 | Expected arrival is not a ledger fact; only free-text `arrivalEstimate` on assistant order lines. | `packages/contracts/src/ext/assistant.ts:229,312` (G) | An expected-arrival date exists on orders or garments and is read by availability. |
| R37 | research L322, L82, L209 | Colour value, colour temperature, saturation and pattern scale are not stored anywhere. | `packages/contracts/src/garment.ts:94-120`; `packages/daily/src/model.ts:32` (G) | The attributes exist on the garment and the composer reads them, or the row becomes partial. |
| R53 | research L340, L125 | Location is only the stock bucket; "hallway" or "closet" cannot be recorded. | `packages/contracts/src/inventory.ts:63` (G) | A physical place within home can be recorded and queried. |

## Honest partial or open rows that still need work

- **S05-003** (spec L235): model profiles and budget sit in the untyped `extensions` map (`packages/contracts/src/settings.ts:58`).
- **S05-007** (spec L239): the tailor's expected return date is written into an event payload and cannot be read back (`handlers/garments.ts:535`).
- **PR-031 to PR-035** (profile L92-L96): size experiences imported, not asserted individually; "UK 8 too small" is a parameter nothing reads (`import/profile.ts:225,284-286`); the "lower than the Drake's Games rise slides" clause is not in the stored note.
- **Profile purchase gates, branding rule, fabric dislikes** (PR-002 to PR-005 and related): stored as rules with passages (`import/profile.ts:188-230`), enforced by no code.
- **R27** (research L308): `wear.record` takes garment IDs only; no wear by option number. **R48**: no register tags on accessories. **R49**: reconciliation is per garment, not per category.
- **S16-010, S16-014, S16-017** (spec L1047-L1055): no import of previous conversations and research as reference material, of saved combinations, or of an imported planned recommendation.
- **S17-049** (spec L1133): two-owner isolation proven for D1 commands and reads only.
- **S15-014, S15-015** (spec L989): no test enumerates the schema to prove every personal table carries `user_id`.

## Checklist bookkeeping to correct

- **S05-008** is `open` with no citations although orders and order lines exist and are tested in the assistant package.
- **S05-013, S08-010** say saved combinations are missing; `migrations/0400_media_visual_wardrobe.sql:245-298` defines them.
- **S05-025, S05-081, S08-015, S08-033, S16-018, S18-002, S18-004, R03, R33, R50, S21-012** cite tests that do not exercise the row; the tests that do are named in the row verdicts (parts A, F, G). S21-012 cites nothing about comfort although comfort feedback is built (`packages/assistant/src/commands/feedback.ts`).
- **S05-047**: its "remaining" note is partly out of date; daily already applies the weekly reset before composing (`packages/daily/test/service.test.ts:282-321`).
