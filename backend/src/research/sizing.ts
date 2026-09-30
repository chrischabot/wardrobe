import { normalizeMerchant } from '../intake/normalize.js';
import { factValue, type SizeFact } from './owner-sizes.js';

/**
 * Size-chart arithmetic (spec section 10, "A product investigation"): body circumference vs garment
 * circumference vs flat half-chest are distinguished, units normalized before computing ease, and
 * missing decisive measurements stay missing. Maker-specific sizes are individual experiences: a
 * size recorded for one maker is never carried to another.
 */

export interface ChartRow {
  label: string;
  measurements: Record<string, number>;
}

export interface SizeAdviceInput {
  maker: string;
  category: 'jacket' | 'coat' | 'shirt' | 'trousers' | 'jeans' | 'footwear' | 'rugby' | 'knitwear';
  chart?: ChartRow[];
  chartUnit?: 'cm' | 'in';
  measurementConvention?: 'garment_circumference' | 'flat_half' | 'body';
}

export interface SizeAdvice {
  maker: string;
  category: string;
  recommendation: string | null;
  basis: 'recorded_for_this_maker' | 'chart_arithmetic' | 'unknown';
  arithmetic: string[];
  caveats: string[];
  missing: string[];
  neverCarried: string[];
  sources: { quote: string; source: string; profileVersion?: number; measuredOn?: string }[];
}

const CM_PER_IN = 2.54;
const EASE_CM: Record<string, [number, number]> = { jacket: [10, 16], coat: [14, 22], shirt: [10, 16], knitwear: [5, 14], rugby: [12, 22] };

function cite(f: SizeFact | undefined) {
  return f ? [{ quote: f.quote, source: f.source, profileVersion: f.profileVersion, measuredOn: f.measuredOn }] : [];
}

function pick(m: Record<string, number>, names: string[]): number | undefined {
  for (const [k, v] of Object.entries(m)) if (names.some((n) => k.toLowerCase().replace(/[^a-z]/g, '').includes(n))) return v;
  return undefined;
}

function toCm(v: number, unit: 'cm' | 'in'): number {
  return unit === 'in' ? v * CM_PER_IN : v;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

export function sizeAdvice(input: SizeAdviceInput, facts: SizeFact[]): SizeAdvice {
  const maker = normalizeMerchant(input.maker);
  const fact = (k: string) => facts.find((f) => f.key === k);
  const out: SizeAdvice = { maker, category: input.category, recommendation: null, basis: 'unknown', arithmetic: [], caveats: [], missing: [], neverCarried: [], sources: [] };
  const unit = input.chartUnit ?? 'cm';

  const chestArithmetic = (kind: 'jacket' | 'coat' | 'shirt' | 'knitwear' | 'rugby') => {
    const chestIn = factValue(facts, 'body.chest_in');
    out.sources.push(...cite(fact('body.chest_in')));
    if (chestIn === null) {
      out.missing.push('body chest measurement');
      return;
    }
    if (!input.chart?.length) {
      out.missing.push(`${maker} size chart`);
      return;
    }
    const convention = input.measurementConvention;
    if (!convention) {
      out.missing.push('whether the chart gives body, garment circumference or flat half-chest measurements');
      return;
    }
    const bodyCm = chestIn * CM_PER_IN;
    out.arithmetic.push(`Body chest ${chestIn} in = ${round(bodyCm)} cm.`);
    const [lo, hi] = EASE_CM[kind]!;
    const rows: { label: string; ease: number }[] = [];
    for (const r of input.chart) {
      const raw = pick(r.measurements, ['chest', 'pittopit', 'bust']);
      if (raw === undefined) continue;
      const cm = toCm(raw, unit);
      if (convention === 'body') {
        out.arithmetic.push(`${r.label}: chart body chest ${raw} ${unit} (${round(cm)} cm) ${cm >= bodyCm ? '≥' : '<'} ${round(bodyCm)} cm.`);
        rows.push({ label: r.label, ease: cm - bodyCm });
        continue;
      }
      const garment = convention === 'flat_half' ? cm * 2 : cm;
      const ease = garment - bodyCm;
      out.arithmetic.push(`${r.label}: ${convention === 'flat_half' ? `flat ${raw} ${unit} × 2 = ${round(garment)} cm` : `garment ${round(garment)} cm`}; ease ${round(garment)} − ${round(bodyCm)} = ${round(ease)} cm.`);
      rows.push({ label: r.label, ease });
    }
    if (!rows.length) {
      out.missing.push('chest measurement in the chart');
      return;
    }
    const chosen = convention === 'body' ? rows.filter((r) => r.ease >= 0).sort((a, b) => a.ease - b.ease)[0] : rows.filter((r) => r.ease >= lo && r.ease <= hi).sort((a, b) => a.ease - b.ease)[0];
    if (chosen) {
      out.recommendation = chosen.label;
      out.basis = 'chart_arithmetic';
      out.arithmetic.push(convention === 'body' ? `Smallest size whose body chest covers ${round(bodyCm)} cm: ${chosen.label}.` : `Target ease for a ${kind} is ${lo}–${hi} cm; ${chosen.label} gives ${round(chosen.ease)} cm.`);
    } else {
      const nearest = [...rows].sort((a, b) => Math.abs(a.ease - (lo + hi) / 2) - Math.abs(b.ease - (lo + hi) / 2))[0]!;
      out.caveats.push(`No size falls inside ${lo}–${hi} cm of ease; the nearest is ${nearest.label} at ${round(nearest.ease)} cm.`);
    }
    out.missing.push('shoulder width', 'sleeve length', 'back length');
    out.caveats.push('Chest ease alone does not settle fit: shoulder, length, cut and layering are unchecked.');
  };

  switch (input.category) {
    case 'jacket':
    case 'coat': {
      const drakes = fact('jacket.drakes');
      const pw = fact('jacket.private_white');
      const dbf = fact('jacket.de_bonne_facture');
      if (maker === "Drake's" && drakes) {
        out.recommendation = drakes.value;
        out.basis = 'recorded_for_this_maker';
        out.sources.push(...cite(drakes));
        return out;
      }
      if (maker === 'Private White V.C.' && pw) {
        out.recommendation = pw.value;
        out.basis = 'recorded_for_this_maker';
        out.sources.push(...cite(pw));
        return out;
      }
      if (drakes) out.neverCarried.push(`Drake's ${drakes.value} is a Drake's experience and does not transfer to ${maker}.`);
      if (maker === 'De Bonne Facture' && dbf) {
        out.sources.push(...cite(dbf));
        out.caveats.push('De Bonne Facture runs to its own chart; use its chart, never a Drake’s number.');
      }
      chestArithmetic(input.category);
      return out;
    }
    case 'rugby': {
      const r = fact('rugby');
      if (r) {
        out.recommendation = r.value;
        out.basis = 'recorded_for_this_maker';
        out.sources.push(...cite(r));
        out.caveats.push('Recorded as the rugby size generally; check this maker’s chest measurement if it runs unusually.');
        if (input.chart?.length && input.measurementConvention) chestArithmetic('rugby');
        return out;
      }
      chestArithmetic('rugby');
      return out;
    }
    case 'knitwear':
      chestArithmetic('knitwear');
      return out;
    case 'shirt': {
      const mtm = fact('shirt.mtm');
      const collar = fact('shirt.collar');
      if (mtm && mtm.maker && normalizeMerchant(mtm.maker) === maker) {
        out.recommendation = 'made to measure (current manual measure)';
        out.basis = 'recorded_for_this_maker';
        out.sources.push(...cite(mtm));
        return out;
      }
      out.sources.push(...cite(collar));
      const collarIn = collar?.value ? Number(collar.value.replace('½', '.5').split(' ')[0]) : null;
      if (collarIn === null) {
        out.missing.push('collar size');
        return out;
      }
      if (input.chart?.length) {
        const target = collarIn * CM_PER_IN;
        out.arithmetic.push(`Collar ${collarIn} in = ${round(target)} cm.`);
        const rows = input.chart.map((r) => ({ label: r.label, v: pick(r.measurements, ['collar', 'neck']) })).filter((r) => r.v !== undefined) as { label: string; v: number }[];
        const chosen = rows.map((r) => ({ ...r, cm: toCm(r.v, unit) })).filter((r) => r.cm >= target - 0.3).sort((a, b) => a.cm - b.cm)[0];
        if (chosen) {
          out.recommendation = chosen.label;
          out.basis = 'chart_arithmetic';
          out.arithmetic.push(`Smallest collar ≥ ${round(target)} cm: ${chosen.label} (${round(chosen.cm)} cm).`);
        } else out.missing.push('collar measurements in the chart');
      } else {
        out.recommendation = `${collar!.value} collar`;
        out.basis = 'recorded_for_this_maker';
        out.caveats.push('Ready-to-wear collar size; body and sleeve measurements still need the maker’s chart.');
      }
      out.caveats.push('Cloth weight and a sewn collar must be verified before recommending a new shirtmaker.');
      return out;
    }
    case 'trousers':
    case 'jeans': {
      const wl = fact('trousers.waist_length');
      const low = fact('trousers.low_rise_waist');
      const rise = fact('trousers.rise');
      out.sources.push(...cite(wl), ...cite(low), ...cite(rise));
      if (!wl?.value) {
        out.missing.push('waist and length');
        return out;
      }
      const [waist, length] = wl.value.split('x').map(Number) as [number, number];
      let targetWaist = waist;
      const riseRows = input.chart?.map((r) => ({ label: r.label, rise: pick(r.measurements, ['rise']), waist: pick(r.measurements, ['waist']) })) ?? [];
      if (!riseRows.some((r) => r.rise !== undefined)) out.missing.push('front rise (decisive: anything lower than the Drake’s Games rise slides)');
      if (low?.value) out.caveats.push(`If the rise sits below the waist, drop to a ${low.value} waist.`);
      if (input.chart?.length) {
        const lowRise = riseRows.some((r) => r.rise !== undefined && toCm(r.rise, unit) < 28);
        if (lowRise && low?.value) {
          targetWaist = Number(low.value);
          out.arithmetic.push(`The chart's rise is low (< 28 cm), so the target waist is ${targetWaist} in.`);
        }
        const chosen = riseRows.filter((r) => r.waist !== undefined).map((r) => ({ ...r, waistIn: unit === 'cm' ? r.waist! / CM_PER_IN : r.waist! })).filter((r) => r.waistIn >= targetWaist - 0.25).sort((a, b) => a.waistIn - b.waistIn)[0];
        if (chosen) {
          out.recommendation = chosen.label;
          out.basis = 'chart_arithmetic';
          out.arithmetic.push(`Smallest waist ≥ ${targetWaist} in: ${chosen.label} (${round(chosen.waistIn)} in).`);
        }
      } else {
        out.recommendation = `${waist}x${length}`;
        out.basis = 'recorded_for_this_maker';
      }
      out.caveats.push('Stretch is for movement, never for basic fit.');
      return out;
    }
    case 'footwear': {
      const uk = fact('footwear.uk');
      const small = fact('footwear.too_small');
      out.sources.push(...cite(uk), ...cite(small));
      if (!uk?.value) {
        out.missing.push('footwear size');
        return out;
      }
      if (small?.value) out.caveats.push(`UK ${small.value} is too small and caused real damage; never size down.`);
      if (input.chart?.length) {
        const row = input.chart.find((r) => {
          const v = pick(r.measurements, ['uk']);
          return v !== undefined && Math.abs(v - Number(uk.value)) < 0.01;
        });
        if (row) {
          out.recommendation = row.label;
          out.basis = 'chart_arithmetic';
          out.arithmetic.push(`${maker}'s chart maps UK ${uk.value} to ${row.label}.`);
        } else {
          out.missing.push(`${maker}'s own conversion for UK ${uk.value}`);
          out.caveats.push('EU and US conversions vary by maker; do not convert generically.');
        }
      } else {
        out.recommendation = `UK ${uk.value}`;
        out.basis = 'recorded_for_this_maker';
      }
      return out;
    }
  }
}
