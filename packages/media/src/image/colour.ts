import type { Raster, Rgb } from "./raster.ts";

const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/** sRGB (D65) to CIELAB. */
export function rgbToLab(rgb: Rgb): [number, number, number] {
  const r = LINEAR[Math.max(0, Math.min(255, Math.round(rgb[0])))]!;
  const g = LINEAR[Math.max(0, Math.min(255, Math.round(rgb[1])))]!;
  const b = LINEAR[Math.max(0, Math.min(255, Math.round(rgb[2])))]!;
  const x = labF((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047);
  const y = labF(r * 0.2126729 + g * 0.7151522 + b * 0.072175);
  const z = labF((r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function labDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Colour difference (CIE76: Euclidean distance in CIELAB). Roughly, 2 is just noticeable and 10 is clearly different. */
export function deltaE(a: Rgb, b: Rgb): number {
  return labDistance(rgbToLab(a), rgbToLab(b));
}

export interface ColourCluster {
  rgb: Rgb;
  share: number;
}

const MERGE_DELTA_E = 9;

/**
 * Dominant colours of the pixels whose alpha exceeds the threshold. Deterministic: a 4-bit-per-channel
 * histogram whose bins carry the true mean colour of their pixels, merged greedily (largest first) when
 * closer than a fixed colour difference. Shares sum to at most 1; clusters are sorted by share.
 */
export function dominantColours(src: Raster, opts: { maxColours?: number; alphaThreshold?: number } = {}): ColourCluster[] {
  const threshold = opts.alphaThreshold ?? 128;
  const counts = new Float64Array(4096);
  const sums = new Float64Array(4096 * 3);
  let total = 0;
  const d = src.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! <= threshold) continue;
    const bin = ((d[i]! >> 4) << 8) | ((d[i + 1]! >> 4) << 4) | (d[i + 2]! >> 4);
    counts[bin]! += 1;
    sums[bin * 3]! += d[i]!;
    sums[bin * 3 + 1]! += d[i + 1]!;
    sums[bin * 3 + 2]! += d[i + 2]!;
    total++;
  }
  if (total === 0) return [];
  const bins: { count: number; sum: [number, number, number]; bin: number }[] = [];
  for (let bin = 0; bin < 4096; bin++) {
    if (counts[bin]! > 0) bins.push({ count: counts[bin]!, sum: [sums[bin * 3]!, sums[bin * 3 + 1]!, sums[bin * 3 + 2]!], bin });
  }
  bins.sort((a, b) => b.count - a.count || a.bin - b.bin);
  const clusters: { count: number; sum: [number, number, number]; lab: [number, number, number] }[] = [];
  for (const b of bins) {
    const mean: Rgb = [b.sum[0] / b.count, b.sum[1] / b.count, b.sum[2] / b.count];
    const lab = rgbToLab(mean);
    let target: (typeof clusters)[number] | null = null;
    let best = MERGE_DELTA_E;
    for (const c of clusters) {
      const dist = labDistance(c.lab, lab);
      if (dist < best) {
        best = dist;
        target = c;
      }
    }
    if (target) {
      target.count += b.count;
      target.sum[0] += b.sum[0];
      target.sum[1] += b.sum[1];
      target.sum[2] += b.sum[2];
    } else clusters.push({ count: b.count, sum: [...b.sum], lab });
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters.slice(0, opts.maxColours ?? 5).map((c) => ({
    rgb: [Math.round(c.sum[0] / c.count), Math.round(c.sum[1] / c.count), Math.round(c.sum[2] / c.count)] as Rgb,
    share: c.count / total,
  }));
}

/**
 * Distance between two palettes; 0 means the same colours in the same proportions.
 *
 *   d(A -> B) = sum over a in A of share(a) * min over b in B of deltaE(a, b)      (colour term)
 *   s(A, B)   = 0.5 * sum over a in A of |share(a) - share(nearest b)|             (proportion term, 0..1)
 *   distance  = ( d(A -> B) + d(B -> A) ) / 2  +  10 * ( s(A, B) + s(B, A) ) / 2
 *
 * The colour term is in deltaE units; a full proportion mismatch adds 10. Two empty palettes are 0 apart;
 * one empty palette is 100 from anything.
 */
export function colourDistributionDistance(a: ColourCluster[], b: ColourCluster[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 100;
  const oneWay = (from: ColourCluster[], to: ColourCluster[]): { colour: number; proportion: number } => {
    const toLab = to.map((c) => rgbToLab(c.rgb));
    let colour = 0;
    let proportion = 0;
    let shares = 0;
    for (const f of from) {
      const lab = rgbToLab(f.rgb);
      let best = Infinity;
      let nearest = 0;
      toLab.forEach((t, i) => {
        const dist = labDistance(lab, t);
        if (dist < best) {
          best = dist;
          nearest = i;
        }
      });
      colour += f.share * best;
      proportion += Math.abs(f.share - to[nearest]!.share);
      shares += f.share;
    }
    return { colour: colour / Math.max(shares, 1e-9), proportion: 0.5 * proportion };
  };
  const ab = oneWay(a, b);
  const ba = oneWay(b, a);
  return (ab.colour + ba.colour) / 2 + (10 * (ab.proportion + ba.proportion)) / 2;
}
