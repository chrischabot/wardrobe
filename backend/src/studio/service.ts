import {
  CONTRACTS_VERSION,
  StudioChoicesRequest,
  StudioSuggestRequest,
  StudioValidateRequest,
  type CommandReceipt,
  type GarmentRole,
  type SavedCombination,
  type SourceChannel,
  type StudioBadge,
  type StudioChoices,
  type StudioIssue,
  type StudioMode,
  type StudioSlot,
  type StudioSuggestion,
  type StudioValidation,
} from '@garderobe/contracts';
import { CommandService, type CommandServiceOptions } from '../domain/commands/service.js';
import { parseJson } from '../domain/db.js';
import { DomainError } from '../domain/errors.js';
import { findForgedOwnerFields, requireScope, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { localDateOf } from '../domain/time.js';
import { eligiblePools, tasteScore } from '../recommend/compose.js';
import type { MandatoryContext } from '../recommend/context.js';
import type { WardrobeGarment } from '../recommend/garments.js';
import { RecommendationService, type RecommendationDeps } from '../recommend/service.js';
import { validateOutfit, type Candidate, type CandidateSlot, type Check, type OutfitValidation } from '../recommend/validate.js';
import { loadGarmentAssetRows, selectCatalogue } from '../media/records.js';
import { CompositeService, type CompositeDeps } from '../visual/service.js';

/**
 * Studio backend (spec section 3, "Studio"). The phone positions cached assets locally; everything
 * authoritative comes from here, built on the daily service's mandatory context and validator so
 * there is one recommendation engine.
 *
 *  - choices / validate / suggest / manifest are reads: they never write a plan, a wear, a receipt
 *    or a composite.
 *  - For today: selectors hold eligible owned pieces; a combination is valid only if it passes the
 *    daily-service validator for the date. Explore: seasonal, stored and incoming pieces appear with
 *    badges; a combination is valid if it breaks no rule that is not bound to the day (weather,
 *    cleanliness, availability, the recent-repeat rule, the healing restriction). `validForDate` still
 *    reports the full daily verdict.
 *  - Find something that works with this: only unlocked roles change; locked slots are returned
 *    exactly as sent, and every suggestion passes the validator. When nothing works with the locked
 *    pieces, the answer says so rather than moving a locked piece.
 *  - Save combination, Plan for a day and Wear this are three different commands
 *    (save_combination, plan_outfit, record_wear) through the shared CommandService.
 */

/** Rules bound to a particular day's conditions; Explore mode reports them without failing. */
export const DAY_BOUND_RULES = new Set([
  'availability.eligible',
  'hard.thermal_peak_for_base',
  'hard.thermal_morning_for_outerwear',
  'hard.thermal_jacket_14_16_lightweight_oxford',
  'comfort.layering',
  'hard.variety_seven_days',
  'hard.sneakers_only_until_healed',
  'hard.sneaker_and_welted_alternative',
  'request.exclusions',
]);

const SUGGEST_BUDGET = { validations: 1500, perRole: { base_top: 10, bottom: 10, outer_layer: 5, mid_layer: 4, one_piece: 6, socks: 5, footwear: 4, belt: 3, accessory: 3 } as Partial<Record<GarmentRole, number>> };
const FILL_ORDER: GarmentRole[] = ['one_piece', 'base_top', 'bottom', 'outer_layer', 'mid_layer', 'footwear', 'socks', 'belt', 'accessory'];
const STUDIO_ROLES: GarmentRole[] = ['base_top', 'mid_layer', 'outer_layer', 'bottom', 'one_piece', 'footwear', 'socks', 'belt', 'accessory'];

export interface StudioDeps extends RecommendationDeps {
  /** Private media bucket and URL signing key: needed for composition manifests with signed URLs. */
  bucket?: R2Bucket | null;
  signingKey?: string | null;
  commandOptions?: CommandServiceOptions;
}

export interface StudioCommandInput {
  idempotencyKey: string;
  source?: SourceChannel;
}

export interface StudioActionResult {
  /** Null when the combination failed the day's validation (nothing was written). */
  receipt: CommandReceipt | null;
  validation: StudioValidation;
}

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function slotKey(slots: readonly { garmentId: string; role: string }[]): string {
  return slots.map((s) => `${s.role}:${s.garmentId}`).sort().join('|');
}

export class StudioService {
  readonly rec: RecommendationService;
  private readonly db: D1Database;
  private readonly principal: Principal;
  private readonly now: () => string;

  constructor(private readonly deps: StudioDeps) {
    this.rec = new RecommendationService(deps);
    this.db = deps.db;
    this.principal = deps.principal;
    this.now = deps.clock ?? (() => new Date().toISOString());
  }

  private parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, input: unknown): T {
    const forged = findForgedOwnerFields(input);
    if (forged.length) throw new DomainError('forbidden_owner_field', 'Owner identity comes from the authenticated connection', { fields: forged });
    const r = schema.safeParse(input);
    if (!r.success) throw new DomainError('validation_failed', 'The Studio request is not valid', { issues: r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) });
    return r.data;
  }

  /** Mandatory context for the date; pieces the owner put in the Studio count as explicitly requested. */
  private async context(date: string, requested: string[]): Promise<MandatoryContext> {
    return this.rec.context({ date, include: [...new Set(requested)] });
  }

  // ---------------------------------------------------------------- choices

  async choices(input: unknown): Promise<StudioChoices> {
    requireScope(this.principal, SCOPE_READ);
    const req = this.parse(StudioChoicesRequest, input);
    const ctx = await this.context(req.date, []);
    const eligible = new Set(this.poolFor(ctx, req.role, 'today').map((g) => g.garmentId));
    const pool = req.mode === 'today' ? ctx.wardrobe.filter((g) => eligible.has(g.garmentId)) : this.poolFor(ctx, req.role, 'explore');
    const media = await loadGarmentAssetRows(this.db, this.principal.userId, pool.map((g) => g.garmentId));
    const items = pool
      .map((g) => {
        const cat = selectCatalogue(media.filter((m) => m.garment_id === g.garmentId));
        return {
          garmentId: g.garmentId,
          name: g.name,
          role: req.role,
          category: g.category,
          badges: this.badges(ctx, g, req.role),
          eligibleToday: eligible.has(g.garmentId),
          catalogueAssetId: cat?.asset_id ?? null,
          assetClass: cat?.asset_class ?? null,
          label: cat?.label ?? null,
        };
      })
      .sort((a, b) => Number(b.eligibleToday) - Number(a.eligibleToday) || a.name.localeCompare(b.name) || a.garmentId.localeCompare(b.garmentId));
    return { schemaVersion: CONTRACTS_VERSION, mode: req.mode, date: req.date, role: req.role, items };
  }

  private badges(ctx: MandatoryContext, g: WardrobeGarment, role: GarmentRole): StudioBadge[] {
    const b: StudioBadge[] = [];
    if (g.location === 'storage') b.push('in_storage');
    if (g.acquisition === 'incoming') b.push('incoming');
    if (g.planningPolicy === 'occasional') b.push('occasional');
    if (['tailor', 'repair', 'trip', 'consignment'].includes(g.location)) b.push('away');
    if (g.eligibility.restrictionIds.length) b.push('restricted');
    if (['per_wear', 'single_wear_day'].includes(g.laundryPolicy) && g.acquisition === 'owned' && (!g.estimate || g.estimate.estimatedCleanUnits <= 0)) b.push('not_clean');
    const t = role === 'outer_layer' ? ctx.thermal.departureTempC : ctx.thermal.peakTempC;
    if (['base_top', 'bottom', 'mid_layer', 'outer_layer', 'one_piece'].includes(role) && !(g.thermal.minC <= t && t <= g.thermal.maxC)) b.push('not_for_today_weather');
    const from = addDays(ctx.day.date, -ctx.policy.repeat.horizonDays);
    if (ctx.policy.repeat.roles.includes(role) && g.wornDates.some((d) => d >= from && d < ctx.day.date)) b.push('recently_worn');
    return b;
  }

  /** Candidate pieces for one role. Today: the daily service's eligible pools. Explore: the whole collection with badges. */
  private poolFor(ctx: MandatoryContext, role: GarmentRole, mode: StudioMode): WardrobeGarment[] {
    const byRole = (g: WardrobeGarment) => g.roles.includes(role);
    const base = (g: WardrobeGarment) =>
      g.acquisition !== 'disposed' && g.planningPolicy !== 'excluded' && !g.indoorOnly && !g.tags.some((t) => ctx.policy.excludedTags.includes(t)) && !/watch|\bring\b|bracelet|necklace|jewel|cufflink/i.test(g.name);
    if (mode === 'explore') return ctx.wardrobe.filter((g) => byRole(g) && base(g));
    const pools = eligiblePools(ctx);
    const map: Partial<Record<GarmentRole, WardrobeGarment[]>> = {
      base_top: pools.tops,
      mid_layer: pools.mids,
      outer_layer: pools.outers,
      bottom: pools.bottoms,
      socks: pools.socks,
      footwear: pools.footwear,
      belt: pools.belts,
      accessory: pools.flourishes,
    };
    if (role === 'one_piece') {
      const peak = ctx.thermal.peakTempC;
      return ctx.wardrobe.filter(
        (g) => byRole(g) && base(g) && g.eligibility.available && g.estimate?.eligible !== false && (g.planningPolicy !== 'occasional' || ctx.request.include.includes(g.garmentId)) && g.thermal.minC <= peak && peak <= g.thermal.maxC,
      );
    }
    return map[role] ?? [];
  }

  // ---------------------------------------------------------------- validation

  private toIssue(c: Check): StudioIssue {
    return { code: c.ruleKey, message: c.detail, garmentId: c.garmentIds?.[0] ?? null, strength: c.strength, dayBound: DAY_BOUND_RULES.has(c.ruleKey) };
  }

  private verdict(mode: StudioMode, v: OutfitValidation): StudioValidation {
    const blocking = mode === 'today' ? v.violations : v.violations.filter((c) => !DAY_BOUND_RULES.has(c.ruleKey));
    return {
      schemaVersion: CONTRACTS_VERSION,
      mode,
      valid: blocking.length === 0,
      validForDate: v.valid,
      issues: v.violations.map((c) => this.toIssue(c)),
      warnings: v.warnings.map((c) => this.toIssue(c)),
      checkedAt: this.now(),
    };
  }

  private candidate(slots: readonly StudioSlot[]): Candidate {
    return { slots: slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup ?? null })), source: 'model' };
  }

  async validate(input: unknown): Promise<StudioValidation> {
    requireScope(this.principal, SCOPE_READ);
    const req = this.parse(StudioValidateRequest, input);
    const ctx = await this.context(req.date, req.slots.map((s) => s.garmentId));
    return this.verdict(req.mode, validateOutfit(this.candidate(req.slots), ctx));
  }

  // ---------------------------------------------------------------- suggest

  async suggest(input: unknown): Promise<StudioSuggestion> {
    requireScope(this.principal, SCOPE_READ);
    const req = this.parse(StudioSuggestRequest, input);
    const locked = req.locked.map((s) => ({ garmentId: s.garmentId, role: s.role, ...(s.alternativeGroup ? { alternativeGroup: s.alternativeGroup } : {}) }));
    if (new Set(locked.map((s) => s.garmentId)).size !== locked.length) throw new DomainError('validation_failed', 'A garment is locked twice');
    const ctx = await this.context(req.date, locked.map((s) => s.garmentId));
    const lockedRoles = new Set(locked.map((s) => s.role));
    const fill = new Set<GarmentRole>(req.roles.filter((r) => STUDIO_ROLES.includes(r) && !lockedRoles.has(r)));
    // Required roles are filled when missing; a locked one-piece replaces top and trousers.
    const onePiece = lockedRoles.has('one_piece') || (fill.has('one_piece') && !lockedRoles.has('base_top') && !lockedRoles.has('bottom'));
    if (onePiece) {
      fill.delete('base_top');
      fill.delete('bottom');
    } else {
      fill.delete('one_piece');
      for (const r of ['base_top', 'bottom'] as GarmentRole[]) if (!lockedRoles.has(r)) fill.add(r);
    }
    for (const r of ['socks', 'footwear'] as GarmentRole[]) if (!lockedRoles.has(r)) fill.add(r);
    if (req.mode === 'today' && Math.round(ctx.thermal.departureTempC) < 14 && !lockedRoles.has('outer_layer')) fill.add('outer_layer');
    if (lockedRoles.has('outer_layer') || lockedRoles.has('mid_layer')) {
      // Knit and jacket together are too warm above a 12 °C departure: don't add the other layer unasked.
      if (ctx.thermal.departureTempC >= 12 && !req.roles.includes('mid_layer')) fill.delete('mid_layer');
    }

    const lockedValidation = validateOutfit(this.candidate(locked), ctx);
    const lockedProblems = lockedValidation.violations.filter((c) => c.garmentIds?.some((id) => locked.some((l) => l.garmentId === id)) && (req.mode === 'today' || !DAY_BOUND_RULES.has(c.ruleKey)) && c.ruleKey !== 'integrity.complete');

    const seed = `${req.date}|${slotKey(locked)}`;
    const lists = new Map<GarmentRole, (CandidateSlot[] | null)[]>();
    const lockedIds = new Set(locked.map((l) => l.garmentId));
    for (const role of FILL_ORDER) {
      if (!fill.has(role)) continue;
      const pool = this.poolFor(ctx, role, req.mode).filter((g) => !lockedIds.has(g.garmentId));
      const ranked = [...pool].sort((a, b) => fnv(`${seed}|${role}|${a.garmentId}`) - fnv(`${seed}|${role}|${b.garmentId}`) || a.garmentId.localeCompare(b.garmentId));
      const cap = SUGGEST_BUDGET.perRole[role] ?? 3;
      let options: (CandidateSlot[] | null)[];
      if (role === 'footwear') {
        const sneakers = ranked.filter((g) => g.footwearKind === 'sneaker');
        const welted = ranked.filter((g) => g.footwearKind === 'welted');
        const pairing = ctx.policy.sneakerAndWelted.active && sneakers.length > 0 && welted.length > 0;
        options = pairing
          ? sneakers.slice(0, 2).flatMap((s) => welted.slice(0, 2).map((w) => [{ garmentId: s.garmentId, role, alternativeGroup: 'footwear' }, { garmentId: w.garmentId, role, alternativeGroup: 'footwear' }]))
          : ranked.slice(0, cap).map((g) => [{ garmentId: g.garmentId, role }]);
      } else {
        options = ranked.slice(0, cap).map((g) => [{ garmentId: g.garmentId, role, ...(role === 'accessory' ? { alternativeGroup: 'flourish' } : {}) }]);
      }
      // Optional roles may stay empty if nothing fits; required ones may not.
      const required = ['base_top', 'bottom', 'one_piece', 'socks', 'footwear'].includes(role) || (role === 'outer_layer' && req.mode === 'today' && Math.round(ctx.thermal.departureTempC) < 14);
      if (!required) options.push(null);
      lists.set(role, options);
    }

    const roles = [...lists.keys()];
    const isValid = (v: OutfitValidation) => (req.mode === 'today' ? v.valid : v.violations.every((c) => DAY_BOUND_RULES.has(c.ruleKey)));
    let best: { slots: CandidateSlot[]; v: OutfitValidation; score: number; key: string } | null = null;
    let validations = 0;
    let found = 0;
    const empty = roles.some((r) => lists.get(r)!.length === 0);
    if (!lockedProblems.length && !empty) {
      // Mixed-radix enumeration in a fixed order: deterministic and bounded.
      const idx = roles.map(() => 0);
      outer: while (validations < SUGGEST_BUDGET.validations) {
        const slots: CandidateSlot[] = [...locked.map((l) => ({ garmentId: l.garmentId, role: l.role, alternativeGroup: l.alternativeGroup ?? null }))];
        roles.forEach((r, i) => {
          const pick = lists.get(r)![idx[i]!];
          if (pick) slots.push(...pick);
        });
        validations++;
        const v = validateOutfit({ slots, source: 'swap' }, ctx);
        if (isValid(v) && v.statementCount <= ctx.policy.maxStatementPieces) {
          found++;
          const score = tasteScore(v.parts, v, ctx).score + slots.length * 0.01;
          const key = slotKey(slots);
          if (!best || score > best.score || (score === best.score && key < best.key)) best = { slots, v, score, key };
          if (found >= 40) break;
        }
        for (let i = roles.length - 1; i >= 0; i--) {
          idx[i]!++;
          if (idx[i]! < lists.get(roles[i]!)!.length) continue outer;
          idx[i] = 0;
        }
        break;
      }
    }

    const names = (ids: string[]) => ids.map((id) => ctx.byId.get(id)?.name ?? id).join(', ');
    if (!best) {
      const why = lockedProblems.length
        ? lockedProblems.map((c) => c.detail).join('; ')
        : empty
          ? `nothing ${req.mode === 'today' ? 'eligible today' : 'in the wardrobe'} fills ${roles.filter((r) => lists.get(r)!.length === 0).map((r) => r.replace('_', ' ')).join(', ')}`
          : 'no combination of the remaining pieces passes the rules';
      const v = this.verdict(req.mode, lockedValidation);
      return {
        schemaVersion: CONTRACTS_VERSION,
        slots: locked,
        explanation: `Nothing works with ${locked.length ? names(locked.map((l) => l.garmentId)) : 'an empty outfit'} ${req.mode === 'today' ? 'today' : 'right now'}: ${why}. The locked pieces were left as they are.`,
        validation: { ...v, valid: false },
        found: false,
        changedRoles: [],
        manifest: null,
      };
    }
    const slots: StudioSlot[] = best.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, ...(s.alternativeGroup ? { alternativeGroup: s.alternativeGroup } : {}) }));
    // Invariant: every locked slot is returned exactly as sent.
    for (const l of locked) if (!slots.some((s) => s.garmentId === l.garmentId && s.role === l.role)) throw new Error('studio invariant: a locked slot changed');
    const changed = slots.filter((s) => !lockedIds.has(s.garmentId));
    const changedRoles = [...new Set(changed.map((s) => s.role))];
    const lead = locked.length ? `Works with ${names(locked.map((l) => l.garmentId))}` : 'A complete outfit';
    const explanation = `${lead}: ${changed.length ? names(changed.map((s) => s.garmentId)) : 'nothing needed changing'}. ${req.mode === 'today' ? `Checked against ${req.date}'s weather, availability and your rules.` : 'Explore mode: day-bound checks (weather, laundry, recent wears) are shown, not enforced.'}`;
    return {
      schemaVersion: CONTRACTS_VERSION,
      slots,
      explanation,
      validation: this.verdict(req.mode, best.v),
      found: true,
      changedRoles,
      manifest: await this.manifest(slots),
    };
  }

  /** Composition manifest for a Studio combination (a read; nothing is rendered or stored). */
  async manifest(slots: readonly StudioSlot[]) {
    if (!this.deps.bucket || !this.deps.signingKey) return null;
    const composites = new CompositeService({ db: this.db, bucket: this.deps.bucket, principal: this.principal, signingKey: this.deps.signingKey, clock: this.deps.clock } satisfies CompositeDeps);
    return (await composites.manifestFor(slots)).manifest;
  }

  // ---------------------------------------------------------------- commands

  private commands(): CommandService {
    return new CommandService(this.db, this.principal, { now: this.now, ...this.deps.commandOptions });
  }

  private async existingReceipt(key: string): Promise<boolean> {
    const r = await this.db.prepare('SELECT 1 AS ok FROM command_receipts WHERE user_id = ? AND idempotency_key = ?').bind(this.principal.userId, key).first();
    return Boolean(r);
  }

  /** Save combination. Explore combinations may be saved; the verdict is returned alongside. */
  async save(input: StudioCommandInput & { slots: StudioSlot[]; name?: string; mode?: StudioMode; favorite?: boolean; date?: string }): Promise<StudioActionResult> {
    requireScope(this.principal, SCOPE_WRITE);
    const mode = input.mode ?? 'explore';
    const date = input.date ?? (await this.rec.localToday());
    const validation = this.verdict(mode, validateOutfit(this.candidate(input.slots), await this.context(date, input.slots.map((s) => s.garmentId))));
    const receipt = await this.commands().execute({
      idempotencyKey: input.idempotencyKey,
      source: input.source ?? 'app',
      command: { type: 'save_combination', slots: input.slots, mode, ...(input.name ? { name: input.name } : {}), ...(input.favorite !== undefined ? { favorite: input.favorite } : {}) },
    });
    return { receipt, validation };
  }

  /** Plan for a day: only a combination that passes the daily-service validator for that date is planned. */
  async plan(input: StudioCommandInput & { date: string; slots: StudioSlot[]; name?: string }): Promise<StudioActionResult> {
    requireScope(this.principal, SCOPE_WRITE);
    const ctx = await this.context(input.date, input.slots.map((s) => s.garmentId));
    const validation = this.verdict('today', validateOutfit(this.candidate(input.slots), ctx));
    if (!validation.valid && !(await this.existingReceipt(input.idempotencyKey))) return { receipt: null, validation };
    const receipt = await this.commands().execute({
      idempotencyKey: input.idempotencyKey,
      source: input.source ?? 'app',
      command: { type: 'plan_outfit', date: input.date, slots: input.slots, ...(input.name ? { name: input.name } : {}) },
    });
    return { receipt, validation };
  }

  /**
   * Wear this: records the actual outfit as a wear. It is an observation of what the owner wore, so it
   * is not re-litigated against taste rules; it only needs one chosen pair of shoes.
   */
  async wear(input: StudioCommandInput & { slots: StudioSlot[]; wearingDate?: string; timezone?: string }): Promise<CommandReceipt> {
    requireScope(this.principal, SCOPE_WRITE);
    const shoes = input.slots.filter((s) => s.role === 'footwear');
    if (shoes.length > 1) throw new DomainError('validation_failed', 'Choose one pair of shoes before recording the wear, so both alternatives are never logged', { garmentIds: shoes.map((s) => s.garmentId) });
    const timezone = input.timezone ?? (await this.rec.timezone());
    return this.commands().execute({
      idempotencyKey: input.idempotencyKey,
      source: input.source ?? 'app',
      command: {
        type: 'record_wear',
        timezone,
        wearingDate: input.wearingDate ?? localDateOf(this.now(), timezone),
        items: input.slots.map((s) => ({ garmentId: s.garmentId, role: s.role })),
        sourceRef: 'studio:wear_this',
      },
    });
  }

  async remove(input: StudioCommandInput & { combinationId: string }): Promise<CommandReceipt> {
    requireScope(this.principal, SCOPE_WRITE);
    return this.commands().execute({ idempotencyKey: input.idempotencyKey, source: input.source ?? 'app', command: { type: 'remove_combination', combinationId: input.combinationId } });
  }

  async listCombinations(filter: { kind?: 'saved' | 'plan'; includeInactive?: boolean; from?: string; to?: string } = {}): Promise<SavedCombination[]> {
    requireScope(this.principal, SCOPE_READ);
    const { results } = await this.db
      .prepare(
        `SELECT combination_id, kind, name, slots_json, mode, planned_for_date, status, created_at, version FROM saved_combinations
         WHERE user_id = ?1 AND (?2 IS NULL OR kind = ?2) AND (?3 = 1 OR status = 'active')
           AND (?4 IS NULL OR planned_for_date >= ?4) AND (?5 IS NULL OR planned_for_date <= ?5)
         ORDER BY COALESCE(planned_for_date, ''), created_at, combination_id`,
      )
      .bind(this.principal.userId, filter.kind ?? null, filter.includeInactive ? 1 : 0, filter.from ?? null, filter.to ?? null)
      .all<{ combination_id: string; kind: 'saved' | 'plan'; name: string | null; slots_json: string; mode: StudioMode; planned_for_date: string | null; status: SavedCombination['status']; created_at: string; version: number }>();
    return results.map((r) => ({ combinationId: r.combination_id, kind: r.kind, name: r.name, slots: parseJson<StudioSlot[]>(r.slots_json, []), mode: r.mode, plannedForDate: r.planned_for_date, status: r.status, createdAt: r.created_at, version: r.version }));
  }

  async planFor(date: string): Promise<SavedCombination | null> {
    return (await this.listCombinations({ kind: 'plan', from: date, to: date }))[0] ?? null;
  }
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
