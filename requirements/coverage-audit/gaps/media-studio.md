# Coverage gaps: media and Studio (visual wardrobe)

Audited at `garderobe-rebuild` commit `8445a1e`, by reading code and tests; nothing was executed. "spec" is `requirements/garderobe-replacement-design.md`. Per-row verdicts are in `../rows/E-ios-media.md` unless another part letter is given.

What holds: the upload, queue, R2 and D1 path is real in tests (`packages/media/src/testing/index.ts:1-5`) and composites are built from stored renditions with no generated stand-in. Two limits apply to all of section 11 (S11-001 to S11-036): every test image is a drawn synthetic shape (`packages/media/src/testing/fixtures.ts:1-7`), and the owner's 127 garments have no image at all (`packages/media/test/real-inventory.test.ts:55-69`).

## Rows whose status overstates what exists

| Row | Source | What is missing or weaker | Evidence | Closes when |
| --- | --- | --- | --- | --- |
| S11-016 | spec L702 | Marked implemented although generative editing runs only against a test double and the Worker wires no editor or background remover. | `apps/worker/src/lanes/index.ts:58` passes only the Studio validator | A provider is wired in the Worker and exercised, or the row becomes partial like S11-020. |
| S11-010 | spec L694 | The backfill estimate is never shown to the owner: `getBackfillEstimate` is exposed by no route or media port. | `packages/media/src/reads.ts`; `apps/worker/src/routes/media.ts:40-134`; `apps/worker/src/lanes/media.ts:52-123` | A route returns it and the app shows it. |
| S11-025 | spec L716 | Today's outfit image is a tile grid, not the composition manifest; only Studio renders the manifest. | `ios/App/Garderobe/Screens/Today/OutfitComposition.swift:45-57`; `Screens/Studio/StudioCanvas.swift:21-32` | Today renders the manifest. |
| S11-028 | spec L718 | No app surface places a wear photograph beside the composition; a search of `ios/App` for "selfie" finds nothing. | | A surface exists, or the row becomes partial. |
| S11-034 | spec L726 | Only the 90-day selfie retention default is tested; no test changes the setting, no screen offers it, and nothing covers catalogue originals when a garment leaves. | `packages/media/test/pipeline.test.ts:233` | A test changes the period and the app offers it. |
| S11-036 | spec L726 | The cited test is about location stripping, not faces; the claim holds only by absence of face analysis. | | The row cites absence honestly or a test asserts it. |
| S14-060 | spec L969 | The image backfill budget protects nothing: `apps/worker/src/lanes/media.ts` wires no image editing or model call. | (F) | A consumer reserves under the budget. |

## Honest partial or open rows that still need work

- **No provider wired in the mounted Worker:** no discovery provider, image editor, background remover, transcoder or preview exporter (`apps/worker/src/lanes/index.ts:58`). In a deployment, discovery is the purchase-link step only (S11-003, S11-004), a busy-background photo gets no cutout, and no edited rendition can be produced (S11-020). S20-012: no Browser Run provider connected.
- **Real images:** S11-005, S11-017, S17-016, S16-007: colour, outline and fidelity thresholds were validated on synthetic images only; "representative real garments retain identity" has no evidence.
- **Cloudflare Images:** S11-014, S14-021, S14-053: thumbnails ran on the local runtime's Images binding only; the monthly transformation count is unmeasured.
- **S11-022** (spec L712): proportions from trustworthy dimensions are not implemented (`packages/media/src/compose/manifest.ts:54`); sizing is by category.
- **S11-012** (spec L696): the image review screen exists; only candidate loading has a Swift test.
- **S03-084** (spec L132): discovery starts from the maintenance sweep, not a first-use event.
- **S14-014** (spec L903): no R2 lifecycle rule or event notification.
- **S05-015** (spec L247): thumbnails are generated on demand, not stored renditions with their own history.
- **S01-018, S09-022** (spec L23, L542): no garment image or composition reaches the board document, Calendar event or web board.
- **S10-007, S10-015**: no path reads a Drive file into private media.
- **Untested:** S11-008 (no test drives a browser provider to the two-session cap), S11-027 (preview rendering alongside morning-board composition), S17-017 (cached swipe responsiveness needs a device).

## Checklist bookkeeping to correct

- **S05-013, S08-010** should cite `migrations/0400_media_visual_wardrobe.sql:245-298` and the Studio tests for saved combinations.
- **S11-035** quotes a Worker test name that does not exist; the behaviour is inside `apps/worker/test/backup.test.ts:128-152` under a different title.
