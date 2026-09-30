import type { Env } from '../env.js';
import type { Principal } from '../domain/principal.js';
import { MediaPipeline, MediaService, mediaSigningKey, type QueueLike } from '../media/index.js';
import { StudioService } from '../studio/index.js';
import { HttpError, json, readJson } from './http.js';
import { setMediaResolver } from './media.js';
import { now, weatherProvider } from './services.js';

/**
 * Routes over the visual-wardrobe workstream's services: uploads, signed media, Studio. The HTTP
 * layer authenticates and derives the principal; the services own validation and storage.
 */

const MAX_UPLOAD_BYTES = 25_000_000;

export function mediaFor(env: Env, principal: Principal, origin: string): MediaService {
  return new MediaPipeline({ db: env.DB, bucket: env.MEDIA, principal, signingKey: mediaSigningKey(env), queue: env.MEDIA_QUEUE as unknown as QueueLike, urlBase: origin, clock: now }).media;
}

export function studioFor(env: Env, principal: Principal): StudioService {
  return new StudioService({ db: env.DB, principal, weather: weatherProvider(env), calendar: null, clock: now, bucket: env.MEDIA, signingKey: mediaSigningKey(env) });
}

setMediaResolver((env, principal, ids, origin) => mediaFor(env, principal, origin).garmentMedia(ids));

export async function authorizeUpload(env: Env, principal: Principal, request: Request, origin: string): Promise<Response> {
  return json(await mediaFor(env, principal, origin).authorizeUpload(await readJson(request)), 201);
}

/** PUT <uploadUrl>: authorized by the signed upload token alone (the app may upload without a session header). */
export async function receiveUpload(env: Env, request: Request, uploadId: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get('t') ?? '';
  const length = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (!Number.isFinite(length)) throw new HttpError(411, 'length_required', 'Content-Length is required');
  if (length > MAX_UPLOAD_BYTES) throw new HttpError(413, 'payload_too_large', 'Uploads are limited to 25 MB');
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, 'payload_too_large', 'Uploads are limited to 25 MB');
  const r = await MediaService.receiveUpload({ db: env.DB, bucket: env.MEDIA, signingKey: mediaSigningKey(env), clock: now }, uploadId, token, body, request.headers.get('content-type'));
  if (!r.ok) throw new HttpError(r.status, r.code, r.message);
  return json({ uploadId: r.uploadId, receivedBytes: r.receivedBytes }, 200);
}

export async function completeUpload(env: Env, principal: Principal, uploadId: string, origin: string): Promise<Response> {
  return json(await mediaFor(env, principal, origin).completeUpload(uploadId));
}

export function serveSignedMedia(env: Env, assetId: string, token: string): Promise<Response> {
  return MediaService.serveSigned({ db: env.DB, bucket: env.MEDIA, signingKey: mediaSigningKey(env), clock: now }, assetId, token);
}

export async function studio(env: Env, principal: Principal, action: 'choices' | 'validate' | 'suggest', request: Request): Promise<Response> {
  const body = await readJson(request);
  const s = studioFor(env, principal);
  if (action === 'choices') return json(await s.choices(body));
  if (action === 'validate') return json(await s.validate(body));
  return json(await s.suggest(body));
}
