# Media abuse cases: open defects

Each open defect is kept as a `defect(...)` test (`../../harness/defect.ts`): an expected failure in
`npm test -w @garderobe/adversarial-tests`, an ordinary failure in `npm run test:strict`. When the product is
fixed, the test reports "expected to fail"; turn it into an ordinary `it(...)` and move its row to Fixed.

## Open

| ID | Defect | Reproduction | Owner |
| --- | --- | --- | --- |
| MEDIA-ABUSE-1 | `media.import_records` with part `garmentMedia`, naming a garment that already has a `garment_media` row, answers **500** `internal` (`D1_ERROR: UNIQUE constraint failed: garment_media.user_id, garment_media.garment_id`) instead of a typed 4xx refusal. Nothing is written, so the deleted photograph does not come back; the fault is the untyped crash. The insert is in `packages/media/src/portability.ts` (`INSERT INTO garment_media ...`). | `deleted-image-restore.test.ts`, "MEDIA-ABUSE-1 ...": POST `/v1/commands` `{ type: "media.import_records", payload: { part: "garmentMedia", rows: { garmentMedia: [{ garment_id, image_state: "resolved", primary_asset_id: <deleted asset>, version: 99, updated_at }] } }, authorization: "data_import" or "owner_tap" }` as the owner. | Visual wardrobe |
| MEDIA-ABUSE-2 | An upload made of a valid JPEG's headers up to the start-of-scan marker followed directly by the end marker `FFD9` (no picture data) is finalized, decoded into a blank picture, and its asset becomes `active` and is served. The specification requires the backend to validate even client-prepared images (section 11). | `hostile-images.test.ts`, "MEDIA-ABUSE-2 ...": authorize, PUT, complete the bytes `jpeg[0..SOS) + FF D9` as `image/jpeg`; after the normalization job, `media_assets.status` is `active`. | Visual wardrobe |

## Fixed

| Defect | Fix | Regression test |
| --- | --- | --- |
| A media job whose attempts all died without reporting back was started again by every redelivery and sweep, without end. | `packages/media/src/jobs.ts` (#41) | `queue-jobs.test.ts`, "a job whose every attempt died ..." |
| A restore consulted the deletion journal as of the last sweep, so a photograph deleted since then came back. | `apps/worker/src/backup/service.ts` (#41) | `deleted-image-restore.test.ts`, "does not come back when that backup is restored straight away ..." |
