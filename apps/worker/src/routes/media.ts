import { AssetImageQuery, ImageQuery, SignRenditionRequest, StudioComposeRequest, StudioOutfitRequest, StudioPreviewRequest, StudioQuery, UploadRequest } from "@garderobe/contracts/ext/api";
import { afterCommit } from "../app.ts";
import { MEDIA_THUMBNAIL_WIDTHS } from "@garderobe/contracts/ext/media";
import { requireMedia } from "../app.ts";
import { ApiException } from "../errors.ts";
import { BASE_HEADERS, json, readJson, readQuery } from "../http.ts";
import { IMAGE_RESPONSE_HEADERS as IMAGE_SAFETY } from "../lanes/media.ts";
import type { MediaBody } from "../ports.ts";
import { owner, selfAuthenticated, type RouteDef } from "../router.ts";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function width(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!(MEDIA_THUMBNAIL_WIDTHS as readonly number[]).includes(value)) throw new ApiException("invalid_command", `width must be one of ${MEDIA_THUMBNAIL_WIDTHS.join(", ")}`);
  return value;
}

/** Private image bytes: owner-authenticated, never publicly cacheable, never framed or sniffed. */
/** Headers of an image response: the API's base set, then the visual wardrobe's image set, then this response's own (one value per name). */
function imageHeaders(own: Record<string, string>): Headers {
  const headers = new Headers(BASE_HEADERS);
  for (const [name, value] of [...Object.entries(IMAGE_SAFETY), ...Object.entries(own)]) headers.set(name, value);
  return headers;
}

function imageResponse(request: Request, media: MediaBody): Response {
  // The visual wardrobe's header set: no script, no frame, no sniffing, whatever the stored bytes claim to be.
  const headers = imageHeaders({ "Content-Type": media.contentType, "Cache-Control": "private, max-age=300" });
  if (media.etag) {
    headers.set("ETag", media.etag);
    if (request.headers.get("If-None-Match") === media.etag) return new Response(null, { status: 304, headers });
  }
  if (media.byteLength !== null) headers.set("Content-Length", String(media.byteLength));
  return new Response(media.body, { status: 200, headers });
}

export function mediaRoutes(): RouteDef[] {
  return [
    owner("POST", "/v1/uploads", "write", async ({ app, session, request }) => {
      const body = await readJson(request, UploadRequest);
      const result = await requireMedia(app, "uploads").authorizeUpload(session.principal, body);
      return json({ ...result.authorization, replayed: result.replayed });
    }),

    owner("GET", "/v1/uploads/{id}", "read", async ({ app, session, params }) => json(await requireMedia(app, "uploads").uploadStatus(session.principal, params.id!))),

    /*
     * The upload target. It is authenticated by the short-lived token in the authorization URL, which
     * the media module binds to the owner, the upload, its content type and size. The bytes land in
     * staging and are not evidence until `complete` validates them.
     */
    selfAuthenticated("PUT", "/v1/uploads/{id}/content", "ticket", async ({ app, request, params, url }) => {
      const media = requireMedia(app, "uploads");
      const token = url.searchParams.get("token");
      if (!token) throw new ApiException("unauthenticated", "this upload URL is missing its token");
      const contentLength = Number(request.headers.get("Content-Length") ?? "NaN");
      if (!Number.isInteger(contentLength) || contentLength <= 0) throw new ApiException("invalid_command", "Content-Length is required for an upload");
      if (contentLength > MAX_UPLOAD_BYTES) throw new ApiException("payload_too_large", `an upload may not exceed ${MAX_UPLOAD_BYTES} bytes`);
      if (!request.body) throw new ApiException("invalid_command", "the upload has no content");
      const result = await media.receiveUpload({ uploadId: params.id!, token, body: request.body, contentLength, contentType: request.headers.get("Content-Type") ?? "application/octet-stream" });
      return json({ uploadId: params.id!, receivedBytes: result.receivedBytes, sha256: result.sha256 });
    }),

    owner("POST", "/v1/uploads/{id}/complete", "write", async ({ app, session, params, exec }) => {
      const result = await requireMedia(app, "uploads").finalizeUpload(session.principal, params.id!);
      // The photograph's catalogue view is prepared now, not at the next scheduled sweep.
      if (result.jobId && !result.receipt.replayed) exec.waitUntil(afterCommit(app, session.principal));
      return json({ uploadId: params.id!, state: result.asset ? "finalized" : "rejected", asset: result.asset, rejectionReason: result.rejected, jobId: result.jobId, receipt: result.receipt });
    }),

    owner("GET", "/v1/media/renditions/{id}", "read", async ({ app, session, params, url, request }) =>
      imageResponse(request, await requireMedia(app, "images").openRendition(session.principal, params.id!, width(readQuery(url, ImageQuery).width))),
    ),

    /*
     * Signed delivery, for an image view that cannot attach the sign-in to its request. The owner asks for
     * a URL for one of their own renditions; the URL carries a short-lived token bound to that owner,
     * rendition and width. The visual wardrobe answers every failure (bad or expired token, deleted image,
     * disabled account) with the same 404, so a URL reveals nothing about what exists.
     */
    owner("POST", "/v1/media/renditions/{id}/sign", "read", async ({ app, session, params, request }) => {
      const body = await readJson(request, SignRenditionRequest);
      const w = width(body.width);
      return json(await requireMedia(app, "images").signRendition(session.principal, params.id!, { ...(w ? { width: w } : {}), ...(body.ttlSeconds ? { ttlSeconds: body.ttlSeconds } : {}) }));
    }),

    selfAuthenticated("GET", "/v1/media/signed/{token}", "ticket", async ({ app, params, request }) => {
      const response = await requireMedia(app, "images").serveSigned(params.token!, request);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(IMAGE_SAFETY)) headers.set(name, value);
      return new Response(response.body, { status: response.status, headers });
    }),

    owner("GET", "/v1/media/assets/{id}", "read", async ({ app, session, params, url, request }) => {
      const q = readQuery(url, AssetImageQuery);
      const w = width(q.width);
      return imageResponse(request, await requireMedia(app, "images").openAsset(session.principal, params.id!, { ...(q.variant ? { variant: q.variant } : {}), ...(w ? { width: w } : {}) }));
    }),

    owner("GET", "/v1/items/{id}/image", "read", async ({ app, session, params, url, request }) => {
      const media = requireMedia(app, "images");
      const ref = await media.garmentImage(session.principal, params.id!);
      // No real image means 404 with the honest note; an invented or placeholder picture is never served.
      if (!ref || !ref.hasRealImage || !ref.renditionId) throw new ApiException("not_found", ref?.missingImageNote ?? "No photo yet", { missingImageNote: ref?.missingImageNote ?? "No photo yet" });
      return imageResponse(request, await media.openRendition(session.principal, ref.renditionId, width(readQuery(url, ImageQuery).width)));
    }),

    owner("GET", "/v1/media/photos-needed", "read", async ({ app, session }) => json({ items: await requireMedia(app, "photos needed").photosNeeded(session.principal) })),

    owner("GET", "/v1/media/review", "read", async ({ app, session }) => json(await requireMedia(app, "image review").review(session.principal))),

    owner("GET", "/v1/studio", "read", async ({ app, session, url }) => {
      const media = requireMedia(app, "Studio");
      const q = readQuery(url, StudioQuery);
      const [selectors, combinations, dayPlans] = await Promise.all([media.studio(session.principal, q), media.combinations(session.principal), media.dayPlans(session.principal)]);
      return json({ ...selectors, combinations, dayPlans });
    }),

    owner("POST", "/v1/studio/validate", "read", async ({ app, session, request }) => json(await requireMedia(app, "Studio").validate(session.principal, await readJson(request, StudioOutfitRequest)))),

    owner("POST", "/v1/studio/suggest", "read", async ({ app, session, request }) => json({ suggestions: await requireMedia(app, "Studio").suggest(session.principal, await readJson(request, StudioOutfitRequest)) })),

    owner("POST", "/v1/studio/compose", "read", async ({ app, session, request }) => json(await requireMedia(app, "Studio").compose(session.principal, (await readJson(request, StudioComposeRequest)).slots))),

    /* A rendered preview of a composition: requested as a job, read by its manifest hash, served only to its owner. */
    owner("POST", "/v1/studio/previews", "write", async ({ app, session, request, exec }) => {
      const body = await readJson(request, StudioPreviewRequest);
      const result = await requireMedia(app, "Studio previews").requestPreview(session.principal, body.slots, body.clientRequestId);
      if (!result.receipt.replayed) exec.waitUntil(afterCommit(app, session.principal));
      return json(result);
    }),

    owner("GET", "/v1/studio/compositions/{id}", "read", async ({ app, session, params }) => json(await requireMedia(app, "Studio previews").composition(session.principal, params.id!))),

    owner("GET", "/v1/studio/compositions/{id}/preview", "read", async ({ app, session, params }) => {
      const image = await requireMedia(app, "Studio previews").openPreview(session.principal, params.id!);
      return new Response(image.body, { status: 200, headers: imageHeaders({ "Content-Type": image.contentType, "Cache-Control": "private, max-age=300", ETag: image.etag }) });
    }),
  ];
}
