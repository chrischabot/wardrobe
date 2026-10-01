/**
 * Adapters over the Cloudflare Images binding, written against the binding contract in the installed
 * `@cloudflare/workers-types` (`ImagesBinding.input(stream).transform({...}).output({ format })`,
 * including `segment: "foreground"`). They are optional: without the binding, formats this package cannot
 * decode stay stored as supplied and cluttered photographs keep their background.
 *
 * NOT exercised by the local test suite (the local runtime has no Images service); they need the live
 * verification listed in the workstream report.
 */
import type { BackgroundRemover, ImageTranscoder } from "./adapters.ts";

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Transcode WebP/HEIC (and anything else the service reads) to PNG, bounded to `maxEdge`. */
export function createCloudflareImagesTranscoder(images: ImagesBinding): ImageTranscoder {
  return {
    name: "cloudflare-images",
    version: "binding",
    async toPng({ bytes, maxEdge }) {
      try {
        const result = await images.input(streamOf(bytes)).transform({ width: maxEdge, height: maxEdge, fit: "scale-down" }).output({ format: "image/png" });
        return { ok: true, png: await bytesOf(result.image()) };
      } catch (e) {
        return { ok: false, reason: String((e as Error)?.message ?? e).slice(0, 200) };
      }
    },
  };
}

/** Model-based foreground segmentation for photographs the deterministic cutout declines. Its output is still fidelity-checked. */
export function createCloudflareImagesBackgroundRemover(images: ImagesBinding): BackgroundRemover {
  return {
    name: "cloudflare-images-segment",
    version: "binding",
    async remove({ bytes }) {
      try {
        const result = await images.input(streamOf(bytes)).transform({ segment: "foreground" }).output({ format: "image/png" });
        return { ok: true, png: await bytesOf(result.image()) };
      } catch (e) {
        return { ok: false, reason: String((e as Error)?.message ?? e).slice(0, 200) };
      }
    },
  };
}
