import type { CommandService, Db } from "@garderobe/domain";
import type { BackgroundRemover, DiscoveryProvider, ImageEditProvider, ImageFetcher, ImageTranscoder, OutfitValidator, RasterPreviewExporter } from "./adapters.ts";

/** Queue message: identifiers only. The job ledger in D1 is the truth; a message never carries image bytes or private text. */
export interface MediaQueueMessage {
  kind: "media.job";
  userId: string;
  jobId: string;
}

/** The Worker bindings this package uses. Names are the ones `apps/worker` declares in its wrangler configuration. */
export interface MediaBindings {
  DB: D1Database;
  /** PRIVATE bucket: no public access, no r2.dev URL, no custom domain. Objects are reached only through this binding. */
  MEDIA_BUCKET: R2Bucket;
  MEDIA_QUEUE?: Queue<MediaQueueMessage>;
  /** Cloudflare Images binding (on-demand thumbnails, transcoding, segmentation). Optional. */
  IMAGES?: ImagesBinding;
  /** Worker secret used to sign upload tokens and media URLs (HMAC-SHA-256). */
  MEDIA_SIGNING_KEY: string;
}

export interface MediaLimits {
  /** Upload authorization lifetime. */
  uploadTtlSeconds: number;
  maxUploadBytes: number;
  /** Decoded pixel ceiling, checked from the header before any pixel is decoded. */
  maxPixels: number;
  minDimension: number;
  maxDimension: number;
  /** Longest edge of stored derivatives. */
  workingEdge: number;
  /** Square catalogue canvas edge. */
  catalogueEdge: number;
  /** Signed URL lifetimes (seconds). */
  defaultUrlTtlSeconds: number;
  maxUrlTtlSeconds: number;
  /** Discovery allowance per unresolved garment (specification section 11). */
  discovery: { maxStrategies: number; maxCandidatePages: number; maxBrowserSessions: number; minCandidateEdge: number; maxCandidateBytes: number };
  jobMaxAttempts: number;
  jobLeaseSeconds: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  uploadTtlSeconds: 600,
  maxUploadBytes: 20 * 1024 * 1024,
  maxPixels: 25_000_000,
  minDimension: 64,
  maxDimension: 8192,
  workingEdge: 1600,
  catalogueEdge: 1200,
  defaultUrlTtlSeconds: 300,
  maxUrlTtlSeconds: 900,
  discovery: { maxStrategies: 3, maxCandidatePages: 12, maxBrowserSessions: 2, minCandidateEdge: 400, maxCandidateBytes: 15 * 1024 * 1024 },
  jobMaxAttempts: 3,
  jobLeaseSeconds: 300,
};

/**
 * Everything the media commands and pipelines need besides the ledger. Provider capabilities are
 * adapters: absent adapters are reported as unavailable in job results, never silently substituted.
 */
export interface MediaDeps {
  bucket: R2Bucket;
  signingKey: string;
  queue?: Queue<MediaQueueMessage>;
  images?: ImagesBinding;
  limits?: Partial<MediaLimits>;
  /** Outfit validation (the daily service's `outfitValidator`). Falls back to the labelled baseline validator. */
  validator?: OutfitValidator;
  backgroundRemover?: BackgroundRemover;
  imageEditor?: ImageEditProvider;
  transcoder?: ImageTranscoder;
  discoveryProviders?: DiscoveryProvider[];
  imageFetcher?: ImageFetcher;
  previewExporter?: RasterPreviewExporter;
}

export type MediaDepsSource = MediaDeps | (() => MediaDeps);

export function resolveDeps(source: MediaDepsSource): MediaDeps {
  return typeof source === "function" ? source() : source;
}

export function limitsOf(deps: MediaDeps): MediaLimits {
  return { ...DEFAULT_MEDIA_LIMITS, ...(deps.limits ?? {}), discovery: { ...DEFAULT_MEDIA_LIMITS.discovery, ...(deps.limits?.discovery ?? {}) } };
}

/** Deps straight from Worker bindings, with optional adapters. */
export function depsFromBindings(env: MediaBindings, adapters: Omit<MediaDeps, "bucket" | "signingKey" | "queue" | "images"> = {}): MediaDeps {
  if (!env.MEDIA_SIGNING_KEY || env.MEDIA_SIGNING_KEY.length < 32) throw new Error("MEDIA_SIGNING_KEY must be a Worker secret of at least 32 characters");
  return { bucket: env.MEDIA_BUCKET, signingKey: env.MEDIA_SIGNING_KEY, queue: env.MEDIA_QUEUE, images: env.IMAGES, ...adapters };
}

/** What the functions outside the command service need: the ledger, the ONE command service, and the deps. */
export interface MediaRuntime {
  db: Db;
  service: CommandService;
  deps: MediaDeps;
  clock: () => number;
}

export function createMediaRuntime(input: { db: Db; service: CommandService; deps: MediaDepsSource; clock?: () => number }): MediaRuntime {
  return { db: input.db, service: input.service, deps: resolveDeps(input.deps), clock: input.clock ?? (() => Date.now()) };
}
