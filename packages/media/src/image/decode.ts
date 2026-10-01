import type { ImageProbe } from "./sniff.ts";
import { probeImage } from "./sniff.ts";
import type { Raster } from "./raster.ts";
import { decodePng } from "./png.ts";
import { decodeJpeg } from "./jpeg.ts";
import { ImageDecodeError } from "./errors.ts";

export { ImageDecodeError, DEFAULT_MAX_PIXELS } from "./errors.ts";

/**
 * Decode PNG or JPEG to a raster (JPEG is turned upright by its EXIF orientation). WebP, HEIC, AVIF and
 * GIF are recognised but not decoded here: they raise `unsupported_format` so the caller can use a
 * transcoding adapter.
 */
export async function decodeImage(bytes: Uint8Array, opts: { maxPixels?: number } = {}): Promise<{ raster: Raster; probe: ImageProbe }> {
  const probe = probeImage(bytes);
  if (!probe) throw new ImageDecodeError("unrecognized", "the bytes are not a recognised image");
  if (probe.format === "png") return { raster: await decodePng(bytes, opts), probe };
  if (probe.format === "jpeg") return { raster: decodeJpeg(bytes, opts), probe };
  throw new ImageDecodeError("unsupported_format", `${probe.contentType} needs a transcoding adapter`);
}
