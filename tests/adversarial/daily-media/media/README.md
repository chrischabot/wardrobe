# Media abuse cases

Adversarial tests of the visual wardrobe: private R2 media, uploads, signed delivery, the job queue, backups
and outfit composites. They are part of the adversarial suite and can also be run on their own.

```
npx vitest run --config tests/adversarial/daily-media/media/vitest.config.ts        # from the repository root
```

One file can be named after the configuration, for example `... vitest.config.ts queue-jobs`.

## What runs for real, and what stands in

Every case drives the real Worker inside workerd (`@garderobe/worker/testing`): the same `fetch`, `queue` and
`scheduled` handlers as the deployed Worker, with Miniflare's local D1, the private local media bucket and
export bucket (R2), KV, and the local queue with the Worker as its consumer. Assertions read state straight
from D1 and R2 as well as the HTTP answers.

Stand-ins, at external boundaries only:

- sign-in assertions are signed with the test run's key in place of Cloudflare Access (the Worker verifies
  them with its ordinary code);
- outbound network requests are answered by the Worker test plugin's fixture (no real network);
- no Images binding is configured, so a requested width serves the stored copy.

Every owner, garment and picture in these files is a synthetic test fixture, labelled as such. Where a case
needs a state no request can produce (an isolate that died holding a job, a corrupted job row, bucket objects
restored by an operator, a deployment without the deletion journal) it edits D1 or a bucket directly and says
`TEST SETUP` at that line.

## Files

| File | Abuse cases |
| --- | --- |
| `cross-owner.test.ts` | Another owner's images, uploads, previews, saved outfits and day plans cannot be read, listed, changed or completed, over HTTP or through a connected assistant (MCP); an answer never tells an existing ID of someone else's from an invented one; composites cannot be built, previewed, saved or planned from another owner's garments; knowing a manifest hash gives nothing. |
| `signed-urls.test.ts` | Signed image URLs and upload authorizations: every claim, the signature and the key tampered with; purpose confusion between the two kinds of token; lifetime caps; expiry (the Worker's own clock moved forward); replay after the image was deleted, after finalization and after the account's access ended. |
| `hostile-images.test.ts` | Oversized uploads (declared, sent, streamed, and by pixel count); content-type spoofing; polyglot files; truncated and corrupt images; animated and tiny pictures; decompression bombs; EXIF, XMP, IPTC, comment and trailing data carrying a location, checked on every served copy, the outfit preview and the portable export. |
| `queue-jobs.test.ts` | Poison messages; replayed and duplicated deliveries; a job named under another owner; replay of a deleted picture's jobs; a job whose attempts all died; work of a disabled account; a job row naming another owner's files. |
| `deleted-image-restore.test.ts` | A photograph deleted after a backup was taken does not come back: restoring the backup at once, restoring where the deletion journal is missing, importing over the same account, writing its records with the import command directly, putting its files back in the bucket, and taking a new backup. |
| `support.ts` | Synthetic owners and pictures, hostile-file builders, the upload route step by step, reads of D1 and R2. Imports nothing from the other adversarial directories. |

## Defects these cases found, each fixed with the case as its regression test

- A media job whose attempts all ended without reporting back (the isolate ran out of memory or time while it
  held the lease) was started again by every redelivery and sweep, without end. It is now recorded as failed
  once its allowance is spent (`packages/media/src/jobs.ts`; `queue-jobs.test.ts`, "a job whose every attempt
  died ...").
- A restore consulted the deletion journal as it was written at the last scheduled sweep, so a photograph
  deleted since then was written back to storage and shown again. While the backup's owner is still in the
  deployment the journal is now read from the ledger (`apps/worker/src/backup/service.ts`;
  `deleted-image-restore.test.ts`, "does not come back when that backup is restored straight away ...").

## Not covered here: needs the deployed platform

These are for the deployment thread to run against the development deployment; nothing here claims them.

- Resizing through the Cloudflare Images binding at the fixed widths, and that a resized copy carries no
  metadata (locally no Images binding is configured for the Worker test run).
- Signed URL delivery at the edge: the `private` cache directive honoured by Cloudflare's cache, and the
  per-data-centre purge of cached thumbnails after a deletion.
- The deployed R2 buckets being private (no public bucket URL, no `r2.dev` access) and their lifecycle rules.
- Queue behaviour on the real service: redelivery timing, the dead-letter queue, and consumer concurrency.
- Worker memory and CPU limits under a decompression bomb on the deployed plan (locally the inflate limit
  stops it; the isolate's real limits differ).
