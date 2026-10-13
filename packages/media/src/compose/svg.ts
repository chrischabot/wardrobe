/**
 * SVG scene for a composition manifest. The document is assembled ONLY from numbers this package
 * computed, a fixed set of element templates, validated rendition references and XML-escaped garment
 * names. Nothing from a model or an external page is ever inserted as markup.
 */
import type { CompositionManifest } from "@garderobe/contracts/ext/media";
import { LAYER_TAG } from "./manifest.ts";

export function escapeXml(text: string): string {
  return text
    // Characters XML 1.0 does not allow at all are dropped.
    .replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const RENDITION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATA_URI = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;

function n(value: number): string {
  if (!Number.isFinite(value)) throw new Error("non-finite number in a composition manifest");
  return (Math.round(value * 100) / 100).toString();
}

/**
 * Render the manifest. `images` optionally maps rendition IDs to `data:image/...;base64,` URIs for a
 * self-contained document; otherwise images are referenced as `garderobe-rendition:<id>` for a renderer
 * that resolves them through owner-scoped access. A value that is not a validated data URI is refused.
 */
export function renderSvg(manifest: CompositionManifest, images?: Map<string, string>): string {
  const { width: W, height: H, background } = manifest.canvas;
  if (!HEX_COLOUR.test(background)) throw new Error("invalid canvas background");
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}" height="${n(H)}" viewBox="0 0 ${n(W)} ${n(H)}" role="img" aria-label="${escapeXml(manifest.caption)}">`);
  out.push(`<title>${escapeXml(manifest.caption)}</title>`);
  out.push(`<rect width="${n(W)}" height="${n(H)}" fill="${background}"/>`);
  for (const layer of [...manifest.layers].sort((a, b) => a.z - b.z)) {
    const x = layer.x * W, y = layer.y * H, w = layer.width * W, h = layer.height * H;
    const tag = LAYER_TAG[layer.imageLabel];
    out.push(`<g data-role="${escapeXml(layer.role)}">`);
    if (layer.renditionId) {
      if (!RENDITION_ID.test(layer.renditionId)) throw new Error("invalid rendition reference in a composition manifest");
      const embedded = images?.get(layer.renditionId);
      if (embedded !== undefined && !DATA_URI.test(embedded)) throw new Error("only validated image data URIs can be embedded in a composition");
      out.push(`<image x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="xMidYMid meet" href="${embedded ?? `garderobe-rendition:${layer.renditionId}`}"><title>${escapeXml(layer.name)}</title></image>`);
      if (tag) out.push(`<text x="${n(x + w / 2)}" y="${n(y + h + 14)}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#6B6B6B">${escapeXml(tag)}</text>`);
    } else {
      out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="none" stroke="#BDBDBD" stroke-width="2" stroke-dasharray="8 6"/>`);
      out.push(`<text x="${n(x + w / 2)}" y="${n(y + h / 2 - 4)}" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#3C3C3C">${escapeXml(layer.name)}</text>`);
      out.push(`<text x="${n(x + w / 2)}" y="${n(y + h / 2 + 16)}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#6B6B6B">${escapeXml(tag ?? "NO PHOTO YET")}</text>`);
    }
    out.push("</g>");
  }
  out.push("</svg>");
  return out.join("");
}
