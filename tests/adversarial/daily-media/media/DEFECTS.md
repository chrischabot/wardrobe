# Media abuse cases: defects

An open defect is kept as a `defect(...)` test (`../../harness/defect.ts`): an expected failure in
`npm test -w @garderobe/adversarial-tests`, an ordinary failure in `npm run test:strict`. When the product is
fixed, the test reports "expected to fail"; turn it into an ordinary `it(...)` and move its row to Fixed.

## Open

None.

## Fixed

| ID | Defect | Fix | Regression test |
| --- | --- | --- | --- |
| MEDIA-ABUSE-1 | `media.import_records` with part `garmentMedia`, naming a garment that already had a `garment_media` row, answered 500 `internal` (UNIQUE constraint) instead of a typed 4xx refusal. Nothing was written. | `packages/media/src/portability.ts`: a garment that already has image state is refused as a state conflict before any insert (visual wardrobe) | `deleted-image-restore.test.ts`, "a garment picture record naming the deleted photograph, imported directly, is refused ..." |
| MEDIA-ABUSE-2 | An upload of a valid JPEG's headers up to the start-of-scan marker followed directly by `FFD9` (no picture data) was finalized, decoded into a blank picture, and became an `active`, served asset. | `packages/media/src/image/jpeg.ts` (the decoder refuses a JPEG without scan data) and `packages/media/src/commands/uploads.ts` (finalization rejects "the file holds no image data") (visual wardrobe) | `hostile-images.test.ts`, "a JPEG with headers and no picture data is never shown" |
| - | A media job whose attempts all died without reporting back was started again by every redelivery and sweep, without end. | `packages/media/src/jobs.ts` (#41) | `queue-jobs.test.ts`, "a job whose every attempt died ..." |
| - | A restore consulted the deletion journal as of the last sweep, so a photograph deleted since then came back. | `apps/worker/src/backup/service.ts` (#41) | `deleted-image-restore.test.ts`, "does not come back when that backup is restored straight away ..." |
