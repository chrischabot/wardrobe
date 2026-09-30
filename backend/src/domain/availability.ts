import type { AvailabilitySummary } from '@garderobe/contracts';
import { parseJson } from './db.js';
import type { GarmentRow, LotRow } from './records.js';
import { restrictionMatches, type RestrictionRow } from './restrictions.js';

/**
 * Hard eligibility: facts that make a garment unavailable regardless of probability (spec section 5
 * and 7). Uncertainty alone is never a hard exclusion; that is the estimator's job.
 */
export interface Eligibility extends AvailabilitySummary {
  restrictionIds: string[];
  conditional: boolean;
}

const LOCATION_LABEL: Record<string, string> = {
  storage: 'In storage',
  tailor: 'At the tailor',
  repair: 'At repair',
  trip: 'Packed for a trip',
  consignment: 'At consignment',
  in_transit: 'Incoming',
  unknown: 'Location unknown',
};

export function evaluateEligibility(
  g: GarmentRow,
  restrictions: RestrictionRow[],
  opts: { includeOccasional?: boolean; includeExcluded?: boolean; lots?: LotRow[] } = {},
): Eligibility {
  const reasons: string[] = [];
  const restrictionIds: string[] = [];
  let label = 'Available';
  let conditional = false;
  if (g.acquisition === 'incoming') {
    reasons.push('Incoming: ordered, not yet arrived');
    label = 'Incoming';
  } else if (g.acquisition === 'disposed') {
    reasons.push(`Retired${g.disposal_reason ? ` (${g.disposal_reason.replace('_', ' ')})` : ''}`);
    label = 'Retired';
  }
  if (g.acquisition === 'owned' && g.location !== 'home') {
    const l = LOCATION_LABEL[g.location] ?? g.location;
    reasons.push(l);
    label = l;
  }
  if (g.planning_policy === 'excluded' && !opts.includeExcluded) {
    const attrs = parseJson<Record<string, unknown>>(g.attributes_json, {});
    reasons.push(`Benched${attrs.benchedReason ? ` (${String(attrs.benchedReason)})` : ''}: excluded from planning`);
    if (label === 'Available') label = 'Benched';
  }
  if (g.planning_policy === 'occasional' && !opts.includeOccasional) {
    reasons.push('Occasional: offered only on explicit request');
    conditional = true;
    if (label === 'Available') label = 'Occasional';
  }
  for (const r of restrictions) {
    if (r.lifted_at) continue;
    if (restrictionMatches(parseJson(r.scope_json, {}), g)) {
      reasons.push(`Restricted: ${r.reason}`);
      restrictionIds.push(r.restriction_id);
      if (label === 'Available' || label === 'Occasional') label = r.kind === 'healing' ? 'Resting (healing restriction)' : 'Restricted';
    }
  }
  if (opts.lots && g.acquisition === 'owned') {
    const owned = opts.lots.reduce((n, l) => n + l.clean_qty + l.worn_qty + l.hamper_qty + l.laundry_qty + l.storage_qty + l.away_qty, 0);
    if (owned === 0) {
      reasons.push('No units on record');
      if (label === 'Available') label = 'No units on record';
    }
  }
  return { label, available: reasons.length === 0, reasons, restrictionIds, conditional };
}
