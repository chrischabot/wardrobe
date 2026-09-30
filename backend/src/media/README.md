# Visual wardrobe: media, composites, Studio backend

Spec sections 3 ("Studio") and 11, and the image-fidelity and Studio rows of section 17. Code: `backend/src/media`, `backend/src/visual`, `backend/src/studio`, migration `0020_visual_wardrobe.sql`, contracts `packages/contracts/src/visual.ts`, demo assets `demo/assets`. Tests: `backend/test/visual/*` (real workerd, local D1 and R2).

Import from `@garderobe/backend/media`, `@garderobe/backend/visual` and `@garderobe/backend/studio`. No real image provider is configured anywhere. Every provider sits behind an interface, and the tests use the fakes in `media/fakes.ts`.

## Storage model

| What | Where |
| --- | --- |
| Image bytes | Private R2 (`MEDIA`), key `u/<userId>/a/<assetId>`; uploads first land under `u/<userId>/uploads/<uploadId>` and are not evidence |
| Identity, kind, class, provenance, transformation chain, fidelity report, label | D1 `media_assets` (0001 columns plus the 0020 provenance columns) |
| Garment links | D1 `garment_media`: at most one `catalogue` link per garment (unique index). Triggers refuse links to non-final assets and catalogue links to imagined renderings or composites |
| Uploads | D1 `media_uploads`: declared type and size, expiry, `authorized → uploaded → finalized / rejected` |
| Jobs | D1 `media_jobs` (idempotent per `operation_key`). `MEDIA_QUEUE` messages carry only `{ v, userId, jobId }` |
| Search state and Photos needed | D1 `garment_photo_status`: strategies, pages and browser sessions used, sources tried, review candidates, one-sentence photo request |
| Composites | D1 `outfit_composites` keyed by manifest hash, pointing to a `composite` asset |
| Studio | D1 `saved_combinations` (0001 table plus `kind`, `mode`, `status`, `command_id`). One active plan per date (partial unique index) |

Asset classes: `exact_product_photo`, `owner_photo`, `edited_rendition` (label "Edited"), `illustration` ("Illustration"), `demo_placeholder` ("Demo placeholder"), `imagined_rendering` (never a catalogue image, never composed) and `composite`. Renditions (`kind`): `source`, `cutout`, `catalogue`, `mask`, `thumbnail`, `composite`. Each derived asset names its `sourceAssetId` and carries the whole transformation chain, oldest first. Derivatives are stripped of EXIF/XMP/IPTC/comments (JPEG) and text/eXIf/tIME chunks (PNG).

## Service interfaces

```ts
import { MediaService, MediaPipeline, handleMediaQueue, mediaSigningKey } from '@garderobe/backend/media';
import { CompositeService, layoutOutfit, renderCompositeSvg } from '@garderobe/backend/visual';
import { StudioService } from '@garderobe/backend/studio';
```

### MediaService: `new MediaService({ db, bucket, principal, signingKey, urlBase?, clock?, onGarmentPhoto?, transformer? })`

| Call | Route (API worker) | Notes |
| --- | --- | --- |
| `authorizeUpload(body)` → `UploadAuthorization` | `POST /v1/uploads` | Single-object PUT URL, 10-minute token, declared type (JPEG/PNG/HEIC) and size (≤ 25 MB). Owner fields in the body are rejected |
| `MediaService.receiveUpload({db,bucket,signingKey}, id, token, bytes, contentType)` | `PUT /v1/uploads/{id}?t=` | Token-authenticated. Enforces type, size, expiry and single use |
| `completeUpload(id)` → `UploadCompleteResponse` | `POST /v1/uploads/{id}/complete` | **Finalization**: validates magic bytes against the declared type and checks dimensions (16–12000 px), then creates the `final` source asset. A garment photo is linked as a verified supporting image and queues normalization. Rejected bytes are deleted |
| `signedUrl(assetId, ttl?)` | | Short-lived (15 min) token naming one owner and one asset |
| `MediaService.serveSigned(deps, assetId, token)` / `serve(assetId)` | `GET /v1/media/{id}` | Private cache headers, `nosniff`, a locked CSP on SVG, `X-Garderobe-Image-Label` (percent-encoded). Foreign or missing assets return 404 |
| `garmentMedia(ids)` → `Map<id, GarmentMedia>` | Today, Wardrobe, item page | Three D1 queries for any number of garments, plus signing; no R2 reads |
| `ingest(...)`, `recordRejected(...)`, `setCatalogue(...)`, `thumbnail(id, 160 \| 480 \| 960)`, `derivationTree(id)`, `deleteAsset(id)` | | Trusted pipeline operations. SVG must pass the drawing allowlist (`media/svg.ts`). Deletion propagates to renditions, links, composites and R2 bytes, leaving a D1 tombstone |

Signing key: the `MEDIA_URL_SIGNING_KEY` secret (at least 32 characters). A built-in development key is used only when `ENVIRONMENT` is `local` or `test`.

### MediaPipeline: `new MediaPipeline({ ...MediaServiceDeps, queue, providers })`, or `createMediaPipeline(env, userId)`

- `enqueueDiscovery(garmentId)`, `backfill(limit)` (active, normally planned, most-worn first), `retryDiscovery(garmentId, reason)`, `enqueueNormalize(assetId, garmentId)`, `enqueueComposite(slots)`, `enqueueBoardComposites(date)`.
- `runJob(id)` and `drain()`. The Worker's `queue` handler calls `handleMediaQueue(batch, env)`. Permanent domain errors fail the job at once; transient errors retry up to three times.
- **Discovery**: three strategies (purchase source, maker archive, identifier search), at most 12 candidate pages and 2 browser sessions per job. Exact-identifier candidates rank first, and a source already tried is never searched again. Adoption needs identity evidence from the source page (the exact product code, or maker plus product name plus matching colourway) and passing quality checks (smallest side at least 600 px, not clipped, no busy background). Wrong colourway, different generation, wrong garment type or a different code means reject. Anything else is uncertain and goes to a grouped `reviewQueue()`; a provider confidence number is recorded but never used. An unresolved garment enters **Photos needed** with one sentence describing the useful photograph.
- **Normalization**: the original stays immutable. The pipeline produces a cutout and mask, which must pass the fidelity check. A front-flat source then gets canvas normalization; any other pose gets a generative edit with explicit preservation constraints. The edit passes only if `checkFidelity` holds for garment identity, dominant colours (CIE76 ΔE ≤ 10), pattern, counted details, silhouette, clipping, halo and components. A failed or identity-altering edit is recorded as a `rejected` asset (no bytes, no link), and the cutout or original remains the catalogue image.
- `photosNeeded()` lists only unresolved garments that still lack a verified image. `acceptReviewCandidate(garmentId, imageUrl)` adopts a candidate the owner has confirmed.

### Composites: `new CompositeService({ db, bucket, principal, signingKey })`

- `manifestFor(slots)` is a pure read returning `{ manifest, manifestHash }`. `compose(slots)` renders and stores the SVG once per manifest hash. `forOption(optionId)` does the same for a board option. `recordImaginedRendering(generator, prompt, garmentIds)` stores a labelled asset that is never linked.
- **Layout `outfit-layout/1`** (`visual/layout.ts`) is a pure function. The shirt and trousers form the main column, shoes sit beneath (alternatives side by side), and outerwear goes beside the shirt, partially layered behind it. Knitwear sits beside the shirt; the belt goes on the waistline, the tie or scarf top left and the socks bottom left. Templates: `separates`, `separates_layered`, `separates_long_coat` and `one_piece`. The canvas is 1200×1500 on white. Sizing is by category: each image is contained in its role's box. Coordinates are integers and input order doesn't matter, so the same inputs give a byte-identical manifest, hash and SVG. A garment without an image keeps its place as a labelled outline ("No photo yet"). Illustrations and demo placeholders carry their labels, and imagined renderings or composites throw. Any change to a box, rule or the renderer's output must mint a new `LAYOUT_VERSION`.
- The stored SVG embeds only this owner's approved asset bytes as data URIs. Names are escaped, and the output passes the same allowlist.

### Studio: `new StudioService({ db, principal, weather, calendar, clock?, bucket, signingKey })`

| Call | Effect |
| --- | --- |
| `choices({ mode, date, role })` → `StudioChoices` | Read. `today` returns the daily service's eligible pools for the role. `explore` returns the whole collection, with badges (`in_storage`, `incoming`, `occasional`, `away`, `restricted`, `not_clean`, `not_for_today_weather`, `recently_worn`) |
| `validate({ mode, date, slots })` → `StudioValidation` | Read. `today` is valid only if the daily-service validator passes for that date. `explore` is valid if no rule outside the day-bound set fails (weather, availability, cleanliness, the recent-repeat rule, the healing restriction). `validForDate` always gives the full verdict |
| `suggest({ mode, date, locked, roles })` → `StudioSuggestion` | Read. "Find something that works with this": only unlocked roles are filled (required roles are added when missing), and locked slots are returned exactly as sent. Enumeration is bounded and deterministic, every candidate is validated, and taste is scored with the daily service's scorer. If nothing works, it returns `found: false` with the reason and the locks untouched. Includes the composition manifest |
| `save({ idempotencyKey, slots, name?, mode? })` | `save_combination` command: stores the combination only |
| `plan({ idempotencyKey, date, slots })` | Validates for the date, then `plan_outfit`: one active plan per date (supersedes the previous one; undo restores it). Returns `receipt: null` if the combination is invalid that day. Never records a wear |
| `wear({ idempotencyKey, slots, wearingDate? })` | `record_wear`: the only action that counts a wear. Two shoes are refused. Not re-litigated against taste rules |
| `remove`, `listCombinations`, `planFor(date)` | `remove_combination` (undoable) and reads |

## Demo assets

`demo/assets/placeholders.ts` (`demo-flatlay/1`) is a pure generator producing one SVG flat-lay per garment. Its colours come from the garment's recorded colour text and its pattern from the name and colour (stripe, check, dots, print). Each image has a visible red "DEMO" mark and `data-garderobe="demo-placeholder"` on the root element, plus a self-description that the fake analyzer reads. `applyDemoPlaceholders(db, media)` stores one per image-less garment as a `demo_placeholder` catalogue image: labelled, never verified, and replaced once a real photo exists. The local seed (`npm run seed:demo`) applies them to the owner (144 garments) and to synthetic owner B. For inspection: `npx tsx demo/scripts/write-demo-assets.ts` writes all of them, with a contact sheet, to `demo/assets/generated/`, and `npx tsx demo/scripts/preview-composite.ts` writes two sample composites there.

## Not done or not verified

- There are no real providers: no product-image search, Browser Run, background removal, image editing, vision analysis, image generation, or Cloudflare Images raster resizing. Raster thumbnails return `null` without a transformer, and HEIC uploads are stored but cannot be embedded in composites until a transformer produces a rendition. The adoption and fidelity rules have run only against fake descriptors.
- Composite previews are SVG only; there is no PNG export (it would go through the image/browser rendering adapter).
- The discovery allowance is enforced per job; a daily Browser Run budget across garments is not implemented.
- Explore mode has a `shopping_candidate` badge in the contract, but research candidates are not yet listed as Studio choices.
- A `plan_outfit` plan is stored and listed, but the daily service does not yet read it when composing that day's board.
