/**
 * DEMO PLACEHOLDER GARMENT IMAGES — generated flat-lay drawings, not photographs.
 *
 * A pure, deterministic generator: one simple SVG flat-lay per garment, coloured from the garment's
 * recorded colour text and drawn with its pattern (stripe, check, dots, print). Every image is
 * visibly labelled "DEMO" and its root element declares data-garderobe="demo-placeholder"; the media
 * service stores them with asset class `demo_placeholder` and the label "Demo placeholder". They let
 * composites, Studio and the end-to-end simulation show pictures without any image provider, and
 * they are never presented as the owner's actual garments.
 *
 * The root element also carries a self-description (kind, dominant colours, pattern, counted
 * details, silhouette, components, pose, background). The pipeline's fake analyzer reads it, and the
 * fake cutout/editor genuinely change it, so fidelity checks run on real differences.
 *
 * Output uses only the drawing vocabulary accepted by backend/src/media/svg.ts (checkTrustedSvg).
 */

export const DEMO_ASSET_GENERATOR_VERSION = 'demo-flatlay/1';
export const DEMO_LABEL = 'Demo placeholder';

export interface PlaceholderGarment {
  name: string;
  category: string;
  color?: string | null;
  pattern?: string | null;
  fabric?: string | null;
}

export interface Placeholder {
  svg: string;
  width: number;
  height: number;
  colours: string[];
  pattern: 'plain' | 'stripe' | 'check' | 'dots' | 'print';
  kind: string;
}

// Longest phrases first so "light blue" wins over "blue".
const COLOURS: [RegExp, string][] = [
  [/clotted cream/, '#F1E6C8'], [/milky tea/, '#C9B08C'], [/biscuit/, '#D4B98E'], [/bone white/, '#ECE6D8'], [/off-white|ecru/, '#F3F0E6'],
  [/light blue/, '#A8C5E2'], [/slate blue/, '#5D7593'], [/strong blue/, '#2451A3'], [/blue jean/, '#4A6A8F'], [/inky? blue/, '#1E2740'],
  [/dark navy/, '#141B2D'], [/faded navy/, '#3B4A66'], [/almond green/, '#A9B48E'], [/dusty green/, '#7C8B6D'], [/light olive/, '#9A9A6A'],
  [/soft olive/, '#7F7B55'], [/dried sage/, '#A3AE8E'], [/deep earth/, '#4B3A2B'], [/deep forest/, '#2C4633'], [/fire red/, '#C0262D'],
  [/golden yellow/, '#D8AE3A'], [/true black/, '#161616'], [/correct grey/, '#8C8E90'], [/pow check|prince of wales/, '#8E8F8C'],
  [/navy|\bink\b/, '#1F2A44'], [/black|noir/, '#1C1C1C'], [/white/, '#F5F4F0'], [/cream/, '#EFE5CF'], [/beige|sand|natural|stone/, '#CDBA98'],
  [/camel/, '#B98A56'], [/walnut/, '#6B4A2F'], [/tobacco|mocha/, '#6D4A2C'], [/marron|caf[eé]/, '#5E3C2A'], [/bark/, '#5A4636'],
  [/brown|earth/, '#6A4A33'], [/charcoal/, '#3F4245'], [/grey|gray/, '#8A8C8E'], [/slate/, '#5F6B75'], [/sage/, '#9CAF94'],
  [/fatigue/, '#6E6B45'], [/olive|khaki/, '#6B6B3A'], [/moss/, '#6C7A3F'], [/evergreen/, '#2F4F3E'], [/laurel/, '#7A8A55'],
  [/pine/, '#2E5540'], [/emerald/, '#1F6E54'], [/forest|green/, '#3F6B4A'], [/rust|brick/, '#A5522F'], [/clay/, '#B0654A'],
  [/burgundy|wine|maroon/, '#6D1F2F'], [/rose/, '#C98A93'], [/pink/, '#E8B7C0'], [/red/, '#B3272D'], [/gold|yellow|ochre/, '#D9B44A'],
  [/denim|indigo/, '#3E5C85'], [/blue/, '#3B6EA8'],
];

const FALLBACK = '#9A9A9A';

/** Colours named in the text, in the order they appear (at most three). */
export function coloursOf(text: string | null | undefined): string[] {
  const t = (text ?? '').toLowerCase();
  const hits: { at: number; end: number; hex: string }[] = [];
  for (const [re, hex] of COLOURS) {
    const g = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(t))) {
      const at = m.index;
      const end = at + m[0].length;
      if (!hits.some((h) => at < h.end && end > h.at)) hits.push({ at, end, hex });
    }
  }
  const out: string[] = [];
  for (const h of hits.sort((a, b) => a.at - b.at)) if (!out.includes(h.hex)) out.push(h.hex);
  return out.slice(0, 3);
}

function patternOf(g: PlaceholderGarment): Placeholder['pattern'] {
  const t = `${g.name} ${g.color ?? ''} ${g.pattern ?? ''}`.toLowerCase();
  if (/stripe/.test(t)) return 'stripe';
  if (/plaid|check|pow\b|ombre|tartan|herringbone|tweed/.test(t)) return 'check';
  if (/polka|dot/.test(t)) return 'dots';
  if (/mughal|moghul|bandana|unicorn|paisley|print/.test(t)) return 'print';
  return 'plain';
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f))));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

interface Shape {
  w: number;
  h: number;
  body: string;
  /** Extra strokes drawn over the fill (collar, placket, seams) in an outline colour. */
  lines: string;
  kind: string;
  silhouette: string;
  details: Record<string, number>;
  components: string[];
}

function shapeFor(g: PlaceholderGarment): Shape {
  const c = g.category;
  const n = g.name.toLowerCase();
  if (c === 'shirt' || c === 'overshirt' || c === 'polo' || c === 'tshirt') {
    const buttons = c === 'tshirt' ? 0 : c === 'polo' ? 2 : 7;
    const lines = c === 'tshirt' ? 'M260 70 Q300 110 340 70' : `M300 90 L300 640 M250 70 L300 120 L350 70 ${Array.from({ length: buttons }, (_, i) => `M296 ${150 + i * 70} L304 ${150 + i * 70}`).join(' ')}`;
    return { w: 600, h: 700, kind: c, silhouette: c === 'tshirt' || c === 'polo' ? 'top-short-sleeve' : 'shirt-long-sleeve', details: { buttons, pockets: c === 'shirt' ? 1 : 0 }, components: c === 'tshirt' ? ['neckline'] : ['collar', 'placket', ...(c === 'polo' ? [] : ['cuffs'])], body: c === 'tshirt' || c === 'polo' ? 'M190 60 L250 50 Q300 90 350 50 L410 60 L540 150 L490 250 L430 210 L430 660 L170 660 L170 210 L110 250 L60 150 Z' : 'M190 60 L250 50 L300 100 L350 50 L410 60 L560 200 L585 520 L520 530 L480 260 L440 230 L440 660 L160 660 L160 230 L120 260 L80 530 L15 520 L40 200 Z', lines };
  }
  if (c === 'knitwear' || c === 'sweatshirt') {
    return { w: 600, h: 650, kind: c, silhouette: 'knit-crew', details: {}, components: ['neckline', 'ribbed_cuffs', 'ribbed_hem'], body: 'M200 60 Q300 110 400 60 L560 180 L590 520 L520 535 L470 270 L450 600 L150 600 L130 270 L80 535 L10 520 L40 180 Z', lines: 'M150 570 L450 570 M200 60 Q300 130 400 60' };
  }
  if (c === 'trousers' || c === 'jeans' || c === 'shorts') {
    const len = c === 'shorts' ? 420 : 780;
    const drawstring = /drawstring/.test(n);
    return { w: 500, h: c === 'shorts' ? 460 : 820, kind: c, silhouette: c === 'shorts' ? 'shorts' : 'trousers-straight', details: { pockets: c === 'jeans' || /5-pocket/.test(n) ? 5 : 4 }, components: drawstring ? ['waistband', 'drawstring'] : ['waistband', 'belt_loops', 'fly'], body: `M90 30 L410 30 L440 ${len} L285 ${len} L250 200 L215 ${len} L60 ${len} Z`, lines: `M90 80 L410 80 M250 80 L250 200 ${drawstring ? 'M230 55 L220 120 M270 55 L280 120' : 'M130 30 L130 80 M250 30 L250 80 M370 30 L370 80'}` };
  }
  if (c === 'coat' || /overcoat|grandfather|peacoat|work coat|traveler/.test(n)) {
    return { w: 600, h: 1000, kind: 'coat', silhouette: 'coat-long', details: { pockets: 2, buttons: 6 }, components: ['collar', 'sleeves', 'fastening'], body: 'M180 50 L250 40 L300 120 L350 40 L420 50 L570 190 L590 700 L520 710 L480 280 L470 960 L130 960 L120 280 L80 710 L10 700 L30 190 Z', lines: 'M300 120 L300 960 M250 40 L300 200 L350 40 M160 620 L250 620 M350 620 L440 620 M285 300 L295 300 M285 450 L295 450 M285 600 L295 600 M305 300 L315 300 M305 450 L315 450 M305 600 L315 600' };
  }
  if (c === 'jacket' || c === 'blazer') {
    return { w: 600, h: 720, kind: c, silhouette: 'jacket-short', details: { pockets: c === 'blazer' ? 3 : 4, buttons: c === 'blazer' ? 2 : 4 }, components: ['collar', 'sleeves', 'fastening'], body: 'M180 50 L250 40 L300 120 L350 40 L420 50 L570 190 L590 600 L520 610 L480 270 L470 680 L130 680 L120 270 L80 610 L10 600 L30 190 Z', lines: 'M300 120 L300 680 M250 40 L300 230 L350 40 M160 470 L260 470 M340 470 L440 470 M170 300 L240 300 M360 300 L430 300' };
  }
  if (c === 'sneakers' || c === 'shoes' || c === 'boots') {
    const boot = c === 'boots';
    const sneaker = c === 'sneakers';
    return { w: 700, h: 420, kind: c, silhouette: boot ? 'boot-high' : 'shoe-low', details: { eyelets: boot ? 7 : 5 }, components: sneaker ? ['sole', 'laces', 'heel_tab'] : ['sole', 'laces', 'welt'], body: boot ? 'M110 40 L300 40 L310 220 Q420 230 560 280 Q650 310 650 350 L650 380 L60 380 L70 250 Z' : 'M70 200 Q140 150 250 150 L330 110 Q470 190 600 250 Q660 280 660 330 L660 370 L50 370 Z', lines: `M50 345 L660 345 ${Array.from({ length: boot ? 7 : 5 }, (_, i) => `M${boot ? 180 + i * 15 : 290 + i * 28} ${boot ? 70 + i * 24 : 140 + i * 16} l24 -6`).join(' ')}` };
  }
  if (c === 'socks') {
    return { w: 320, h: 520, kind: 'socks', silhouette: 'sock', details: {}, components: ['cuff', 'heel', 'toe'], body: 'M90 20 L230 20 L230 330 Q230 380 280 400 Q310 440 280 480 L130 490 Q70 480 80 420 L90 330 Z', lines: 'M90 70 L230 70 M90 90 L230 90' };
  }
  if (c === 'belt') {
    return { w: 760, h: 170, kind: 'belt', silhouette: 'belt', details: { holes: 5 }, components: ['buckle', 'strap'], body: 'M120 55 L730 55 Q750 85 730 115 L120 115 Z M30 35 L130 35 L130 135 L30 135 Z', lines: 'M50 55 L110 55 L110 115 L50 115 Z M560 85 l6 0 M600 85 l6 0 M640 85 l6 0 M680 85 l6 0 M520 85 l6 0' };
  }
  if (c === 'tie') {
    return { w: 220, h: 760, kind: 'tie', silhouette: 'tie', details: {}, components: ['knot', 'blade'], body: 'M85 20 L135 20 L145 90 L185 640 L110 740 L35 640 L75 90 Z', lines: 'M75 90 L145 90' };
  }
  if (c === 'scarf' || /bandana|scarf/.test(n)) {
    return { w: 320, h: 760, kind: 'scarf', silhouette: 'scarf', details: {}, components: ['fringe'], body: 'M60 20 L260 20 L260 700 L60 700 Z', lines: 'M70 700 L70 740 M100 700 L100 740 M130 700 L130 740 M160 700 L160 740 M190 700 L190 740 M220 700 L220 740 M250 700 L250 740' };
  }
  return { w: 400, h: 400, kind: c || 'accessory', silhouette: 'square', details: {}, components: [], body: 'M60 60 L340 60 L340 340 L60 340 Z', lines: 'M60 60 L340 340' };
}

/** Generate the placeholder for one garment. Same garment facts → byte-identical SVG. */
export function placeholderSvg(g: PlaceholderGarment): Placeholder {
  const shape = shapeFor(g);
  const found = coloursOf(g.color);
  const colours = found.length ? found : coloursOf(g.name).length ? coloursOf(g.name) : [FALLBACK];
  const pattern = patternOf(g);
  const base = colours[0]!;
  const accent = colours[1] ?? (lum(base) > 0.6 ? shade(base, -0.35) : shade(base, 0.55));
  const outline = lum(base) > 0.75 ? '#9C9C9C' : shade(base, -0.45);
  const { w, h } = shape;
  const defs: string[] = [];
  let fill = base;
  if (pattern === 'stripe') {
    const wide = /wide|extra-wide|university/.test(`${g.name} ${g.color ?? ''}`.toLowerCase());
    const p = wide ? 40 : 18;
    defs.push(`<pattern id="p" width="${p}" height="${p}" patternUnits="userSpaceOnUse"><rect width="${p}" height="${p}" fill="${base}"/><rect width="${Math.round(p / 3)}" height="${p}" fill="${accent}"/></pattern>`);
    fill = 'url(#p)';
  } else if (pattern === 'check') {
    defs.push(`<pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse"><rect width="48" height="48" fill="${base}"/><rect width="16" height="48" fill="${accent}" fill-opacity="0.55"/><rect width="48" height="16" fill="${accent}" fill-opacity="0.55"/>${colours[2] ? `<rect x="30" width="3" height="48" fill="${colours[2]}"/>` : ''}</pattern>`);
    fill = 'url(#p)';
  } else if (pattern === 'dots') {
    const dot = lum(base) > 0.5 ? shade(base, -0.5) : '#F5F4F0';
    defs.push(`<pattern id="p" width="30" height="30" patternUnits="userSpaceOnUse"><rect width="30" height="30" fill="${base}"/><circle cx="15" cy="15" r="4" fill="${dot}"/></pattern>`);
    fill = 'url(#p)';
  } else if (pattern === 'print') {
    defs.push(`<pattern id="p" width="60" height="60" patternUnits="userSpaceOnUse"><rect width="60" height="60" fill="${base}"/><path d="M10 30 Q20 10 30 30 Q40 50 50 30" fill="none" stroke="${accent}" stroke-width="4"/><circle cx="30" cy="12" r="3" fill="${accent}"/></pattern>`);
    fill = 'url(#p)';
  }
  const dominant = pattern === 'plain' ? colours : [base, accent, ...colours.slice(2)].filter((c, i, a) => a.indexOf(c) === i);
  const details = Object.entries(shape.details).map(([k, v]) => `${k}:${v}`).join(';');
  const labelY = h - 12;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"` +
    ` data-garderobe="demo-placeholder" data-generator="${DEMO_ASSET_GENERATOR_VERSION}" data-kind="${shape.kind}" data-colours="${dominant.join(',')}"` +
    ` data-pattern="${pattern}" data-details="${details}" data-silhouette="${shape.silhouette}" data-components="${shape.components.join(',')}"` +
    ` data-pose="front_flat" data-background="neutral" role="img" aria-label="${esc(`Demo placeholder drawing: ${g.name}`)}">` +
    `<title>${esc(`DEMO placeholder — ${g.name}`)}</title>` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    `<rect data-role="background" width="${w}" height="${h}" fill="#FFFFFF"/>` +
    `<path d="${shape.body}" fill="${fill}" stroke="${outline}" stroke-width="3" stroke-linejoin="round"/>` +
    `<path d="${shape.lines}" fill="none" stroke="${outline}" stroke-width="3" stroke-linecap="round" opacity="0.8"/>` +
    `<text x="${w - 10}" y="${labelY}" text-anchor="end" font-family="system-ui, Helvetica, Arial, sans-serif" font-size="${Math.max(12, Math.round(w / 28))}" font-weight="600" letter-spacing="2" fill="#B00020" opacity="0.85">DEMO</text>` +
    `</svg>`;
  return { svg, width: w, height: h, colours: dominant, pattern, kind: shape.kind };
}
