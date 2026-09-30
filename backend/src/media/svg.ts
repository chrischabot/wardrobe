/**
 * Allowlist validation for SVG produced by trusted Garderobe code (demo placeholders, outfit
 * composites). "Generated SVG accepts no arbitrary markup from models or external pages" (spec
 * section 11): anything outside a small drawing vocabulary is rejected, never sanitized into shape.
 * Owner uploads never accept SVG at all.
 */

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'pattern', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'text', 'tspan', 'image',
]);

const ATTRIBUTES = new Set([
  'xmlns', 'width', 'height', 'viewBox', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'transform', 'id', 'patternUnits', 'patternTransform', 'gradientUnits', 'offset', 'stop-color', 'stop-opacity',
  'clip-path', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'href',
  'preserveAspectRatio', 'role', 'aria-label', 'lang',
]);

const DATA_URI = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export interface SvgCheck {
  ok: boolean;
  problems: string[];
}

export function checkTrustedSvg(text: string): SvgCheck {
  const problems: string[] = [];
  const body = text.replace(/^\uFEFF/, '').replace(/^<\?xml version="1\.0"( encoding="UTF-8")?\?>\s*/, '');
  if (/<!|<\?/.test(body)) problems.push('doctype, entity, CDATA, comment or processing instruction');
  if (/javascript:|vbscript:/i.test(body)) problems.push('script URL');
  if (!body.trimStart().startsWith('<svg')) problems.push('root element is not svg');
  const tag = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*"[^"]*")*)\s*(\/?)\s*>/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  let depth = 0;
  while ((m = tag.exec(body))) {
    const between = body.slice(consumed, m.index);
    if (between.includes('<') || between.includes('>')) problems.push('malformed markup');
    consumed = m.index + m[0].length;
    const [, closing, name, attrs, selfClosing] = m;
    if (!ELEMENTS.has(name!)) problems.push(`element <${name}> not allowed`);
    if (closing) {
      depth--;
      continue;
    }
    if (!selfClosing) depth++;
    const attr = /([^\s=>/]+)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attr.exec(attrs ?? ''))) {
      const [, an, av] = a;
      if (an!.startsWith('data-')) continue;
      if (!ATTRIBUTES.has(an!)) {
        problems.push(`attribute ${an} not allowed`);
        continue;
      }
      if (an === 'href' && !(av!.startsWith('#') || DATA_URI.test(av!))) problems.push('href must be a fragment or an embedded image');
      if (an === 'xmlns' && av !== 'http://www.w3.org/2000/svg') problems.push('unexpected namespace');
      if (/url\(/i.test(av!) && !/^url\(#[\w-]+\)$/.test(av!)) problems.push(`external url() in ${an}`);
    }
  }
  const tail = body.slice(consumed);
  if (tail.trim().length) problems.push('trailing content after the root element');
  if (depth !== 0) problems.push('unbalanced elements');
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** data-* attributes on the root svg element (the placeholder's self-description). */
export function rootDataAttributes(text: string): Record<string, string> {
  const root = /<svg\b([^>]*)>/.exec(text);
  const out: Record<string, string> = {};
  if (!root) return out;
  const attr = /\sdata-([\w-]+)="([^"]*)"/g;
  let a: RegExpExecArray | null;
  while ((a = attr.exec(root[1]!))) out[a[1]!] = a[2]!;
  return out;
}
