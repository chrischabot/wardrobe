import { env } from 'cloudflare:workers';
import type { StudioSlot } from '@garderobe/contracts';
import { applyDemoPlaceholders, placeholderSvg } from '@garderobe/demo';
import { MediaPipeline, type MediaQueueMessage, type QueueLike } from '../../src/media/pipeline.js';
import type { MediaProviders } from '../../src/media/providers.js';
import { MediaService } from '../../src/media/service.js';
import { LOCAL_DEV_SIGNING_KEY } from '../../src/media/signing.js';
import { StudioService } from '../../src/studio/service.js';
import { CompositeService } from '../../src/visual/service.js';
import type { Principal } from '../../src/domain/principal.js';
import { ownerScenario, type Scenario } from './daily.js';
import { newUser } from './fixtures.js';

export const SIGNING_KEY = LOCAL_DEV_SIGNING_KEY;

export class RecordingQueue implements QueueLike {
  readonly sent: MediaQueueMessage[] = [];
  async send(body: MediaQueueMessage): Promise<void> {
    this.sent.push(body);
  }
}

export interface VisualKit {
  media: MediaService;
  pipeline: MediaPipeline;
  composites: CompositeService;
  queue: RecordingQueue;
}

export function visualKit(principal: Principal, clock: () => string, providers: MediaProviders = {}): VisualKit {
  const queue = new RecordingQueue();
  const base = { db: env.DB, bucket: env.MEDIA, principal, signingKey: SIGNING_KEY, clock };
  const pipeline = new MediaPipeline({ ...base, queue, providers });
  return { media: pipeline.media, pipeline, composites: new CompositeService(base), queue };
}

export interface VisualScenario extends Scenario, VisualKit {
  studio: StudioService;
  /** Recreate the kit with other providers (same owner, clock and queue semantics). */
  withProviders(p: MediaProviders): VisualKit;
}

/** The owner (real profile, rules, May 2026 CSV) + fake weather/calendar + media, composites and Studio. */
export async function visualScenario(opts: Parameters<typeof ownerScenario>[0] & { placeholders?: boolean; providers?: MediaProviders } = {}): Promise<VisualScenario> {
  const s = await ownerScenario(opts);
  const kit = visualKit(s.principal, s.clock.now, opts.providers);
  if (opts.placeholders) await applyDemoPlaceholders(env.DB, kit.media);
  const studio = new StudioService({ db: env.DB, principal: s.principal, weather: s.weather, calendar: s.calendar, clock: s.clock.now, bucket: env.MEDIA, signingKey: SIGNING_KEY });
  return { ...s, ...kit, studio, withProviders: (p) => visualKit(s.principal, s.clock.now, p) };
}

export async function bareUserKit(name = 'Media user'): Promise<{ principal: Principal } & VisualKit> {
  const principal = await newUser(name);
  return { principal, ...visualKit(principal, () => new Date().toISOString()) };
}

// ------------------------------------------------------------------ byte fixtures

const enc = new TextEncoder();

function be16(n: number): number[] {
  return [(n >> 8) & 255, n & 255];
}
function be32(n: number): number[] {
  return [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A structurally valid baseline JPEG header (SOI, optional EXIF APP1 with GPS text, SOF0, SOS, EOI). */
export function makeJpeg(width: number, height: number, opts: { exif?: boolean; comment?: boolean } = {}): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  out.push(0xff, 0xe0, ...be16(16), ...Array.from(enc.encode('JFIF\0')), 1, 1, 0, 0, 1, 0, 1, 0, 0);
  if (opts.exif) {
    const payload = [...Array.from(enc.encode('Exif\0\0')), ...Array.from(enc.encode('GPSLatitude=51.5074;GPSLongitude=-0.1278'))];
    out.push(0xff, 0xe1, ...be16(payload.length + 2), ...payload);
  }
  if (opts.comment) {
    const c = Array.from(enc.encode('taken at home'));
    out.push(0xff, 0xfe, ...be16(c.length + 2), ...c);
  }
  out.push(0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  out.push(0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, 0x12, 0x34, 0x56, 0x78, 0xff, 0xd9);
  return Uint8Array.from(out);
}

function chunk(type: string, data: number[]): number[] {
  return [...be32(data.length), ...Array.from(enc.encode(type)), ...data, 0, 0, 0, 0];
}

/** A PNG with IHDR, optional tEXt/eXIf location metadata, IDAT and IEND (CRCs are not checked by the service). */
export function makePng(width: number, height: number, opts: { text?: boolean } = {}): Uint8Array {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0])];
  if (opts.text) {
    out.push(...chunk('tEXt', Array.from(enc.encode('Location\0Utrecht 52.09N 5.12E'))));
    out.push(...chunk('eXIf', Array.from(enc.encode('MM\0*GPS'))));
  }
  out.push(...chunk('IDAT', [0x78, 0x9c, 0x63, 0, 0, 0, 1, 0, 1]), ...chunk('IEND', []));
  return Uint8Array.from(out);
}

export function includesBytes(hay: Uint8Array, needle: string): boolean {
  const n = enc.encode(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/** A demo placeholder rendered as if it were an owner photograph taken on the body (so a catalogue edit is wanted). */
export function ownerPhotoSvg(g: { name: string; category: string; color?: string | null }, pose: 'on_body' | 'front_flat' = 'on_body'): Uint8Array {
  return enc.encode(placeholderSvg(g).svg.replace('data-pose="front_flat"', `data-pose="${pose}"`).replace('data-garderobe="demo-placeholder"', 'data-garderobe="test-photo"'));
}

/** Upload an owner photograph of a garment through the real upload path (authorize → PUT → complete). SVG is not uploadable, so a JPEG is used. */
export async function uploadGarmentPhoto(media: MediaService, garmentId: string, bytes = makeJpeg(1200, 1600)): Promise<string> {
  const auth = await media.authorizeUpload({ purpose: 'garment_photo', contentType: 'image/jpeg', byteLength: bytes.length, garmentId });
  const token = new URL(auth.uploadUrl, 'https://x.invalid').searchParams.get('t')!;
  const r = await MediaService.receiveUpload({ db: env.DB, bucket: env.MEDIA, signingKey: SIGNING_KEY, clock: () => new Date(Date.parse(auth.expiresAt) - 60_000).toISOString() }, auth.uploadId, token, bytes, 'image/jpeg');
  if (!r.ok) throw new Error(`upload failed: ${r.code}`);
  const done = await media.completeUpload(auth.uploadId);
  if (done.status !== 'finalized') throw new Error(`upload rejected: ${done.reason}`);
  return done.assetId!;
}

export function tokenOf(url: string): string {
  return new URL(url, 'https://x.invalid').searchParams.get('t')!;
}

const COUNTED_TABLES = ['command_receipts', 'saved_combinations', 'daily_wears', 'wear_observations', 'selections', 'boards', 'stock_movements', 'media_assets', 'garment_media', 'outfit_composites', 'media_jobs', 'command_effects'] as const;

export async function tableCounts(userId: string): Promise<Record<(typeof COUNTED_TABLES)[number], number>> {
  const out = {} as Record<(typeof COUNTED_TABLES)[number], number>;
  for (const t of COUNTED_TABLES) out[t] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).bind(userId).first<{ n: number }>())!.n;
  return out;
}

export function slotsOf(option: { slots: { garmentId: string; role: string; alternativeGroup?: string | null }[] }): StudioSlot[] {
  return option.slots.map((s) => ({ garmentId: s.garmentId, role: s.role as StudioSlot['role'], ...(s.alternativeGroup ? { alternativeGroup: s.alternativeGroup } : {}) }));
}
