import type { CompositionManifest } from '@garderobe/contracts';
import { escapeXml } from '../media/svg.js';

/**
 * Render a composition manifest as SVG on a neutral white canvas. Pure and deterministic: the same
 * manifest and the same asset bytes give byte-identical output. Garment images are embedded as
 * base64 data URIs from Garderobe's own R2 assets (or, for delivery, referenced by signed URL);
 * text comes only from D1 names and fixed labels, escaped. No markup from models or pages enters.
 * Stored previews are cached by manifest hash, so a change to this renderer's output must ship with
 * a new LAYOUT_VERSION (which changes every manifest hash).
 */

export interface EmbeddedImage {
  contentType: 'image/png' | 'image/jpeg' | 'image/svg+xml';
  base64: string;
}

export interface RenderOptions {
  /** Delivery mode: reference images by URL instead of embedding them (not stored). */
  hrefFor?: (assetId: string) => string;
}

const FONT = 'system-ui, -apple-system, Helvetica, Arial, sans-serif';

export function renderCompositeSvg(m: CompositionManifest, images: ReadonlyMap<string, EmbeddedImage>, opts: RenderOptions = {}): string {
  const { width, height } = m.canvas;
  const names = m.items.map((i) => i.name).join(', ');
  // A per-piece label is drawn only when it tells pieces apart; the footer always lists every label.
  const pieceLabels = new Set(m.items.map((i) => (i.assetId ? i.label : 'No photo yet')));
  const distinguish = pieceLabels.size > 1;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-layout-version="${m.layoutVersion}" data-template="${m.template}" role="img" aria-label="${escapeXml(`Outfit: ${names}`)}">`);
  out.push(`<title>${escapeXml(`Outfit: ${names}`)}</title>`);
  out.push(`<rect width="${width}" height="${height}" fill="#FFFFFF"/>`);
  for (const it of m.items) {
    const href = it.assetId ? (opts.hrefFor ? opts.hrefFor(it.assetId) : imageHref(images.get(it.assetId))) : null;
    if (it.assetId && href) {
      out.push(`<image x="${it.x}" y="${it.y}" width="${it.width}" height="${it.height}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(href)}" data-garment-id="${it.garmentId}" data-role="${it.role}"/>`);
    } else {
      // No usable image: keep the garment's place with a quiet outline and its perceptible name.
      out.push(`<g data-garment-id="${it.garmentId}" data-role="${it.role}" data-placeholder="true">`);
      out.push(`<rect x="${it.x + 4}" y="${it.y + 4}" width="${Math.max(1, it.width - 8)}" height="${Math.max(1, it.height - 8)}" rx="16" fill="#FAFAFA" stroke="#C9C9C9" stroke-width="2" stroke-dasharray="10 8"/>`);
      out.push(`<text x="${it.x + Math.floor(it.width / 2)}" y="${it.y + Math.floor(it.height / 2)}" text-anchor="middle" font-family="${FONT}" font-size="22" fill="#444444">${escapeXml(truncate(it.name, 34))}</text>`);
      out.push(`<text x="${it.x + Math.floor(it.width / 2)}" y="${it.y + Math.floor(it.height / 2) + 30}" text-anchor="middle" font-family="${FONT}" font-size="18" fill="#777777">No photo yet</text>`);
      out.push('</g>');
    }
    if (it.assetId && it.label && distinguish) {
      out.push(`<text x="${it.x + 8}" y="${it.y + it.height + 20}" font-family="${FONT}" font-size="16" fill="#666666" data-label="true">${escapeXml(it.label)}</text>`);
    }
  }
  if (m.labels.length) {
    out.push(`<text x="24" y="${height - 24}" font-family="${FONT}" font-size="18" fill="#666666">${escapeXml(m.labels.join(' · '))}</text>`);
  }
  out.push('</svg>');
  return out.join('');
}

function imageHref(img: EmbeddedImage | undefined): string | null {
  return img ? `data:${img.contentType};base64,${img.base64}` : null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
