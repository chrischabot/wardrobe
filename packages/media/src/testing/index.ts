/**
 * Test support for the media package and for other workstreams' integration tests. Everything runs
 * against the REAL command service, local D1, local R2 and the local queue; only provider adapters
 * (search, image editing) can be supplied as labelled test doubles.
 */
import { env } from "cloudflare:test";
import { all, createFoundationRegistry, type CommandRegistry, type Principal } from "@garderobe/domain";
import { createHarness, type Harness, type TestOwner } from "@garderobe/domain/testing";
import type { CommandReceipt } from "@garderobe/contracts";
import type { MediaAsset } from "@garderobe/contracts/ext/media";
import { encodeJpeg, encodePng, type Raster } from "../image/index.ts";
import { registerMedia } from "../index.ts";
import { dispatchMediaJobs } from "../jobs.ts";
import { createMediaRuntime, depsFromBindings, type MediaBindings, type MediaDeps, type MediaRuntime } from "../runtime.ts";
import { authorizeUpload, finalizeUpload, receiveUploadContent } from "../uploads.ts";
import { setQueueRuntime } from "./queue-runtime.ts";

export * from "./fixtures.ts";
export { getQueueRuntime, setQueueRuntime } from "./queue-runtime.ts";

export interface MediaHarness extends Harness {
  rt: MediaRuntime;
  /** The live deps object: assign adapters on it (e.g. `h.deps.imageEditor = ...`) and they take effect at once. */
  deps: MediaDeps;
  bindings: MediaBindings;
  /** Put committed jobs on the local queue and wait until the queue consumer has finished them. */
  settle(owner?: { userId: string }, timeoutMs?: number): Promise<void>;
  /** Authorize, send and finalize an image through the real upload path. */
  upload(owner: TestOwner, input: UploadFixture): Promise<{ receipt: CommandReceipt; asset: MediaAsset | null; rejected: string | null; jobId: string | null; uploadId: string }>;
}

export interface UploadFixture {
  garmentId?: string | null;
  intent?: "garment_photo" | "selfie" | "attachment";
  raster?: Raster;
  bytes?: Uint8Array;
  contentType?: "image/png" | "image/jpeg" | "image/webp" | "image/heic";
  demo?: boolean;
  wearingDate?: string | null;
  principal?: Principal;
}

export async function createMediaHarness(opts: { adapters?: Partial<MediaDeps>; startAt?: string; extend?: (registry: CommandRegistry) => void } = {}): Promise<MediaHarness> {
  const bindings = env as unknown as MediaBindings;
  const deps: MediaDeps = { ...depsFromBindings(bindings), ...(opts.adapters ?? {}) };
  const registry = createFoundationRegistry();
  registerMedia(registry, () => deps);
  opts.extend?.(registry);
  const h = await createHarness({ registry, startAt: opts.startAt });
  const rt = createMediaRuntime({ db: h.db, service: h.service, deps, clock: h.clock.now });
  // The queue consumer (test/worker.ts) picks this runtime up, so it shares the test's clock and adapters.
  setQueueRuntime(rt);

  const settle: MediaHarness["settle"] = async (owner, timeoutMs = 30_000) => {
    const started = Date.now();
    for (;;) {
      await dispatchMediaJobs(rt);
      const open = await all<{ n: number }>(h.db, `SELECT COUNT(*) AS n FROM media_jobs WHERE state IN ('queued', 'running') ${owner ? "AND user_id = ?" : ""}`, ...(owner ? [owner.userId] : []));
      const pendingOutbox = await all<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM outbox WHERE topic = 'media.job' AND state != 'acknowledged'");
      if ((open[0]?.n ?? 0) === 0 && (pendingOutbox[0]?.n ?? 0) === 0) return;
      if (Date.now() - started > timeoutMs) throw new Error(`media jobs did not settle within ${timeoutMs} ms (${open[0]?.n} still open)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const upload: MediaHarness["upload"] = async (owner, input) => {
    const contentType = input.contentType ?? "image/png";
    const bytes = input.bytes ?? (contentType === "image/jpeg" ? encodeJpeg(input.raster!, 92) : await encodePng(input.raster!));
    const principal = input.principal ?? owner.principal();
    const intent = input.intent ?? "garment_photo";
    const key = crypto.randomUUID();
    const { authorization } = await authorizeUpload(rt, principal, {
      intent, garmentId: input.garmentId ?? null, contentType, byteLength: bytes.length, demo: input.demo ?? false, wearingDate: input.wearingDate ?? null, idempotencyKey: `test-upload:${key}`,
    });
    const token = new URLSearchParams(authorization.url.split("?")[1]).get("token")!;
    await receiveUploadContent(rt, { uploadId: authorization.uploadId, token, body: bytes, contentLength: bytes.length, contentType });
    return { ...(await finalizeUpload(rt, principal, authorization.uploadId)), uploadId: authorization.uploadId };
  };

  return { ...h, rt, deps, bindings, settle, upload };
}
