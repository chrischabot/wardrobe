import type { Board, GarmentRole } from '@garderobe/contracts';
import { DEFAULT_ESTIMATOR_PARAMETERS, ESTIMATOR_VERSION } from '@garderobe/contracts';
import { json, parseJson } from '../domain/db.js';
import { DomainError } from '../domain/errors.js';
import { ensureLaundryResets, listLaundryResets, loadSettings } from '../domain/laundry.js';
import { assertPrincipal, requireScope, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { localDateOf } from '../domain/time.js';
import type { CalendarSource } from '../calendar/types.js';
import { loadTrip } from '../trips/store.js';
import { WeatherSkill, type WeatherSkillOptions } from '../weather/skill.js';
import type { WeatherProvider } from '../weather/types.js';
import { composeBoard, eligiblePools, suitsOccasion, tasteScore, type CandidateProposer, type ComposedBoard, type ScoredOption } from './compose.js';
import { assembleContext, contextEvidence, type ComposeRequest, type MandatoryContext } from './context.js';
import { buildDocument, checkProse, dayLineOf, whySentence, type DocumentOption, type ProseWriter } from './document.js';
import type { WardrobeGarment } from './garments.js';
import { estimatorParamsOf, jointAvailability, loadEstimatorBoardDays, type JointInput } from './joint.js';
import { getDailyBoard, getRevisionRecord, newOptionId, publishValidatedRevision, type PublishConflict, type PublishOption } from './publish.js';
import { validateOutfit, type Candidate, type CandidateSlot, type Check } from './validate.js';

/**
 * Public recommendation interface for the API/MCP layer, the daily service and the assistant.
 * Composition, validation, swaps and repair need no model; injected `ProseWriter` and
 * `CandidateProposer` interfaces may improve prose or add candidates, never bypass validation.
 */

export interface RecommendationDeps {
  db: D1Database;
  principal: Principal;
  weather: WeatherProvider | null;
  calendar: CalendarSource | null;
  prose?: ProseWriter | null;
  proposer?: CandidateProposer | null;
  clock?: () => string;
  weatherOptions?: WeatherSkillOptions;
  /** Milliseconds allowed for the prose writer before falling back to deterministic prose. */
  proseTimeoutMs?: number;
}

export interface PublishOutcome {
  published: boolean;
  board: Board | null;
  composed: ComposedBoard | null;
  context: MandatoryContext | null;
  attempts: number;
  shortfall: string | null;
  reason: 'published' | 'no_valid_outfit' | PublishConflict | 'unchanged';
}

export interface ChangeRecord {
  position: number;
  previousOptionId: string | null;
  optionId: string | null;
  kind: 'kept' | 'slot_repaired' | 'replaced_from_reserve' | 'replaced_by_composition' | 'withdrawn' | 'swapped';
  replaced: { role: GarmentRole; from: string; to: string }[];
  reason: string | null;
}

export interface RevisionOutcome {
  changed: boolean;
  board: Board | null;
  fromRevision: number;
  toRevision: number | null;
  changes: ChangeRecord[];
  summary: string;
  receiptId: string | null;
  status: 'revised' | 'unchanged' | 'skipped_day_in_wear' | 'skipped_past' | 'no_board' | 'no_valid_replacement' | 'suppressed_no_valid_option' | 'paused' | 'conflict';
}

export interface RepairOptions {
  /** Fetch the forecast afresh instead of reusing a cached snapshot (morning phases). */
  forceWeatherRefresh?: boolean;
  /** Publish a new revision even when every option is still valid (e.g. the forecast is back), with this summary. */
  republishReason?: string;
  /**
   * Weather-only revision on a day already being worn: every option, the selection and the recorded
   * wears stay exactly as they are; only the context (the recovered forecast) and the copy change.
   */
  weatherOnlyWhenWorn?: boolean;
}

export interface SwapRequest {
  boardDate: string;
  purpose?: string;
  optionId: string;
  role: GarmentRole;
  /** Which garment to replace when the role has alternatives (footwear). */
  replacedGarmentId?: string;
  /** The owner's explicit choice; without it the service chooses (never a navy fallback). */
  replacementGarmentId?: string;
}

export interface SwapCandidatesRequest {
  boardDate: string;
  purpose?: string;
  optionId: string;
  role: GarmentRole;
  /** Which garment is being swapped out when the role has alternatives (footwear). */
  replacedGarmentId?: string;
  limit?: number;
}

export interface SwapCandidate {
  garmentId: string;
  name: string;
  reason: string;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export function newRunId(prefix: 'run' | 'rep' | 'swp'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export class RecommendationService {
  readonly db: D1Database;
  readonly principal: Principal;
  private readonly clock: () => string;
  private readonly skill: WeatherSkill | null;

  constructor(private readonly deps: RecommendationDeps) {
    assertPrincipal(deps.principal);
    this.db = deps.db;
    this.principal = deps.principal;
    this.clock = deps.clock ?? (() => new Date().toISOString());
    this.skill = deps.weather ? new WeatherSkill(deps.db, deps.weather, { clock: this.clock, ...deps.weatherOptions }) : null;
  }

  now(): string {
    return this.clock();
  }

  async timezone(): Promise<string> {
    return (await loadSettings(this.db, this.principal))?.timezone ?? 'Europe/London';
  }

  async localToday(): Promise<string> {
    return localDateOf(this.now(), await this.timezone());
  }

  /** Mandatory context for a request (trip purpose loads the trip's packed subset). */
  async context(req: ComposeRequest): Promise<MandatoryContext> {
    const purpose = req.purpose ?? 'day';
    const trip = purpose.startsWith('trip:') ? await loadTrip(this.db, this.principal.userId, purpose.slice(5)) : null;
    if (purpose.startsWith('trip:') && !trip) throw new DomainError('not_found', 'No such trip');
    return assembleContext({ db: this.db, weather: this.skill, calendar: this.deps.calendar, now: this.now() }, this.principal, { ...req, purpose }, trip);
  }

  async jointInput(ctx: MandatoryContext): Promise<Omit<JointInput, 'garments' | 'targetDate'>> {
    const settings = await loadSettings(this.db, this.principal);
    if (ctx.trip) return { boardDays: [], resets: [], asOf: ctx.builtAt, params: estimatorParamsOf(settings?.estimator_params_json) };
    return {
      boardDays: await loadEstimatorBoardDays(this.db, this.principal.userId, ctx.builtAt, ctx.day.date),
      resets: await listLaundryResets(this.db, this.principal),
      asOf: ctx.builtAt,
      params: estimatorParamsOf(settings?.estimator_params_json),
    };
  }

  /** Composes without publishing (preview; also the basis of every publication). */
  async compose(req: ComposeRequest): Promise<{ context: MandatoryContext; composed: ComposedBoard }> {
    const context = await this.context(req);
    const composed = await composeBoard(context, { proposer: this.deps.proposer, jointInput: await this.jointInput(context), allowRepeats: context.trip?.trip.allowRepeats ?? false });
    return { context, composed };
  }

  /** Validates an outfit proposed by anyone (a model, MCP client or app) against the day's context. */
  async validateProposal(req: ComposeRequest, candidate: Candidate): Promise<ReturnType<typeof validateOutfit>> {
    const ctx = await this.context(req);
    return validateOutfit(candidate, ctx, { allowRepeats: ctx.trip?.trip.allowRepeats ?? false });
  }

  /**
   * Compose, validate and atomically publish a new board revision. A command that changes availability
   * while composition runs makes the publication fail its precondition; the service recomposes from the
   * new state (bounded attempts). Fewer valid options are published rather than padding; none, nothing.
   * Any weekly laundry reset that is already due is applied first (idempotent, once per pool and
   * cycle), so an explicit "prepare now" sees the same availability as the scheduled evening phase.
   */
  async composeAndPublish(req: ComposeRequest, opts: { maxAttempts?: number; beforePublish?: (attempt: number) => Promise<void> } = {}): Promise<PublishOutcome> {
    const purpose = req.purpose ?? 'day';
    const max = opts.maxAttempts ?? 3;
    await ensureLaundryResets(this.db, this.principal, this.now());
    let last: PublishOutcome = { published: false, board: null, composed: null, context: null, attempts: 0, shortfall: null, reason: 'no_valid_outfit' };
    for (let attempt = 1; attempt <= max; attempt++) {
      const existing = await getDailyBoard(this.db, this.principal, req.date, purpose);
      const { context, composed } = await this.compose(req);
      last = { published: false, board: existing, composed, context, attempts: attempt, shortfall: composed.shortfall, reason: 'no_valid_outfit' };
      if (!composed.options.length) return last;
      const docOptions: DocumentOption[] = [
        ...composed.options.map((o, i) => ({ optionId: newOptionId(), position: i + 1, status: 'offerable' as const, scored: o, why: whySentence(o, context) })),
        ...composed.reserves.map((o, i) => ({ optionId: newOptionId(), position: composed.options.length + i + 1, status: 'reserve' as const, scored: o, why: whySentence(o, context) })),
      ];
      const prose = await this.improveProse(context, docOptions);
      const document = buildDocument(context, { options: docOptions, shortfall: composed.shortfall, suitableCount: composed.suitableCount, prose: prose.used ? 'model' : 'deterministic', dayLine: prose.dayLine });
      if (opts.beforePublish) await opts.beforePublish(attempt);
      try {
        const board = await publishValidatedRevision(this.db, this.principal, {
          boardDate: req.date,
          timezone: context.day.timezone,
          purpose,
          expectedRevision: existing?.currentRevision ?? 0,
          watermark: context.watermark,
          brief: { text: req.briefText ?? null, occasion: context.calendar.brief.occasion, requestedCount: req.requestedCount ?? null, wearingInterval: { start: context.day.window.start, end: context.day.window.end } },
          options: docOptions.map((o) => toPublishOption(o, context)),
          document,
          context: { ...contextEvidence(context), request: req },
          validation: boardEvidence(context, composed),
          estimator: estimatorEvidence(context, docOptions),
          projectCalendar: true,
          now: this.now(),
        });
        return { published: true, board, composed, context, attempts: attempt, shortfall: composed.shortfall, reason: 'published' };
      } catch (err) {
        if (!(err instanceof DomainError) || err.code !== 'conflict') throw err;
        const reason = (err.details?.reason ?? 'state_changed') as PublishConflict;
        last = { ...last, reason };
        if (reason === 'paused') return last;
      }
    }
    return last;
  }

  private async improveProse(ctx: MandatoryContext, options: DocumentOption[]): Promise<{ used: boolean; dayLine?: string }> {
    const writer = this.deps.prose;
    if (!writer) return { used: false };
    try {
      const out = await withTimeout(
        writer.write({
          dayLine: dayLineOf(ctx),
          profile: ctx.style.documents.map((d) => d.body).join('\n\n'),
          options: options.map((o) => ({
            optionId: o.optionId,
            why: o.why,
            devices: o.scored.devices,
            garments: o.scored.slots.map((s) => {
              const g = ctx.byId.get(s.garmentId)!;
              return { name: g.name, role: s.role, colour: g.color, fabric: g.fabric };
            }),
          })),
        }),
        this.deps.proseTimeoutMs ?? 8000,
      );
      let used = false;
      for (const o of options) {
        const t = out.why?.[o.optionId];
        if (t && !checkProse(t, o.scored, ctx)) {
          o.why = t.trim();
          used = true;
        }
      }
      const peak = ctx.weather.summary.peakTempC;
      const dayLine = out.dayLine && !checkProse(out.dayLine, null, ctx) && (peak === null || out.dayLine.includes(String(Math.round(peak)))) ? out.dayLine.trim() : undefined;
      return { used: used || Boolean(dayLine), dayLine };
    } catch {
      return { used: false };
    }
  }

  // ---------------------------------------------------------------- revisions: repair and swap

  /**
   * Revalidates an open board against current reality (a wear, spill, laundry change, arrival or
   * restriction). Valid options are carried; a selected option keeps its unaffected slots and only the
   * unavailable piece is replaced; other invalid options are replaced from reserves or fresh
   * composition, or withdrawn. The day being worn (recorded wears today) is not rewritten.
   */
  async repairBoard(boardDate: string, purpose = 'day', reason = 'revalidation', opts: RepairOptions = {}): Promise<RevisionOutcome> {
    return this.reviseBoard(boardDate, purpose, reason, null, opts);
  }

  /**
   * Whether the published board was composed without a usable forecast (weather `unavailable` or
   * `missing`, i.e. the seasonal fallback) while a forecast is usable now. Fetches the forecast afresh.
   * Returns the board's recorded request, and whether an option is selected or the day is being worn,
   * so the morning service can recompose (nothing chosen yet) or republish around the selection.
   */
  async weatherRecovery(boardDate: string, purpose = 'day'): Promise<{ recovered: boolean; selected: boolean; worn: boolean; request: ComposeRequest | null }> {
    const none = { recovered: false, selected: false, worn: false, request: null };
    const board = await getDailyBoard(this.db, this.principal, boardDate, purpose);
    if (!board || board.status !== 'published' || !board.document) return none;
    const prior = board.document.weather.status;
    if (prior !== 'unavailable' && prior !== 'missing') return none;
    const record = await getRevisionRecord(this.db, this.principal, board.boardId, board.currentRevision);
    const request = (record?.context.request as ComposeRequest | undefined) ?? { date: boardDate, purpose };
    const ctx = await this.context({ ...request, date: boardDate, purpose, forceWeatherRefresh: true });
    const now = ctx.weather.summary;
    if (!((now.status === 'fresh' || now.status === 'stale') && now.peakTempC !== null)) return { ...none, request };
    const selected = Boolean(await this.db.prepare("SELECT 1 AS x FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active' LIMIT 1").bind(this.principal.userId, board.boardId).first());
    const worn = Boolean(await this.db.prepare("SELECT 1 AS x FROM daily_wears WHERE user_id = ? AND wearing_date = ? AND status = 'active' LIMIT 1").bind(this.principal.userId, boardDate).first());
    return { recovered: true, selected, worn, request };
  }

  /** A morning correction is a swap, not a rebuild: only the named slot changes. */
  async swap(req: SwapRequest): Promise<RevisionOutcome> {
    return this.reviseBoard(req.boardDate, req.purpose ?? 'day', 'swap', req);
  }

  /**
   * The Swap list for one piece of a published option (reads only). Each candidate is validated as a
   * swap with the rest of the outfit, so profile rule 6 applies: a navy piece is never offered as a
   * default replacement (the owner can still name one explicitly through `swap`). Shirts and trousers
   * already used by another option of the board are not offered, so a swap cannot create a repeat
   * within the board. Candidates come from the composer's eligible pools (clean, at home, thermal,
   * seven-day and comfort rules) and are ranked by the same taste score.
   */
  async swapCandidates(req: SwapCandidatesRequest): Promise<{ candidates: SwapCandidate[] }> {
    requireScope(this.principal, SCOPE_READ);
    const purpose = req.purpose ?? 'day';
    const board = await getDailyBoard(this.db, this.principal, req.boardDate, purpose);
    const option = board?.options.find((o) => o.optionId === req.optionId && (o.status === 'offerable' || o.status === 'reserve'));
    if (!board || !option) throw new DomainError('not_found', `No option ${req.optionId} on the board for ${req.boardDate}`);
    const current = option.slots.filter((s) => s.role === req.role && (!req.replacedGarmentId || s.garmentId === req.replacedGarmentId));
    if (!current.length) throw new DomainError('validation_failed', `This option has no ${req.role.replace('_', ' ')} piece to swap`);
    const target = current[0]!;
    const record = await getRevisionRecord(this.db, this.principal, board.boardId, board.currentRevision);
    const request = (record?.context.request as ComposeRequest | undefined) ?? { date: req.boardDate, purpose };
    const ctx = await this.context({ ...request, date: req.boardDate, purpose });
    const allowRepeats = ctx.trip?.trip.allowRepeats ?? false;
    const pools = eligiblePools(ctx, allowRepeats);
    const pool: WardrobeGarment[] =
      req.role === 'base_top' ? pools.tops : req.role === 'bottom' ? pools.bottoms : req.role === 'outer_layer' ? pools.outers : req.role === 'socks' ? pools.socks : req.role === 'footwear' ? pools.footwear : req.role === 'belt' ? pools.belts : req.role === 'accessory' ? pools.flourishes : req.role === 'mid_layer' ? pools.mids : [];
    const inOption = new Set(option.slots.map((s) => s.garmentId));
    const onOtherOptions = new Set(
      board.options.filter((o) => o.status === 'offerable' && o.optionId !== option.optionId).flatMap((o) => o.slots.filter((s) => s.role === 'base_top' || s.role === 'bottom').map((s) => s.garmentId)),
    );
    const scored: { g: WardrobeGarment; score: number; reason: string }[] = [];
    for (const g of pool) {
      if (inOption.has(g.garmentId)) continue;
      if ((req.role === 'base_top' || req.role === 'bottom') && !allowRepeats && onOtherOptions.has(g.garmentId)) continue;
      const slots = option.slots.map((s) => (s === target ? { garmentId: g.garmentId, role: s.role, alternativeGroup: s.alternativeGroup } : { garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup }));
      const v = validateOutfit({ slots, source: 'swap' }, ctx, { allowRepeats, swap: { role: req.role, replacedGarmentId: target.garmentId, replacementGarmentId: g.garmentId, explicit: false } });
      if (!v.valid) continue;
      scored.push({ g, score: tasteScore(v.parts, v, ctx).score, reason: v.warnings.length ? `Works; note: ${v.warnings[0]!.detail}` : 'Passes every rule for today with the rest of this outfit.' });
    }
    scored.sort((a, b) => b.score - a.score || a.g.name.localeCompare(b.g.name));
    return { candidates: scored.slice(0, req.limit ?? 8).map((x) => ({ garmentId: x.g.garmentId, name: x.g.name, reason: x.reason })) };
  }

  private async reviseBoard(boardDate: string, purpose: string, reason: string, swap: SwapRequest | null, opts: RepairOptions = {}): Promise<RevisionOutcome> {
    requireScope(this.principal, SCOPE_WRITE);
    const board = await getDailyBoard(this.db, this.principal, boardDate, purpose);
    const base: RevisionOutcome = { changed: false, board, fromRevision: board?.currentRevision ?? 0, toRevision: null, changes: [], summary: '', receiptId: null, status: 'unchanged' };
    if (!board || board.status !== 'published') return { ...base, status: 'no_board', summary: 'No published board for that day.' };
    const today = await this.localToday();
    if (boardDate < today) return { ...base, status: 'skipped_past', summary: 'Past boards are history and are not revised.' };
    let wornDay = false;
    if (!swap && boardDate === today) {
      const worn = await this.db.prepare("SELECT 1 AS x FROM daily_wears WHERE user_id = ? AND wearing_date = ? AND status = 'active' LIMIT 1").bind(this.principal.userId, boardDate).first();
      if (worn && !opts.weatherOnlyWhenWorn) return { ...base, status: 'skipped_day_in_wear', summary: 'Today is already being worn; the outfit being worn is not rewritten.' };
      wornDay = Boolean(worn);
    }
    const record = await getRevisionRecord(this.db, this.principal, board.boardId, board.currentRevision);
    const request = (record?.context.request as ComposeRequest | undefined) ?? { date: boardDate, purpose };
    const ctx = await this.context({ ...request, date: boardDate, purpose, ...(opts.forceWeatherRefresh ? { forceWeatherRefresh: true } : {}) });
    const jointIn = await this.jointInput(ctx);
    const allowRepeats = ctx.trip?.trip.allowRepeats ?? false;
    const selection = await this.db
      .prepare("SELECT selection_id, option_id, footwear_garment_id FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'")
      .bind(this.principal.userId, board.boardId)
      .first<{ selection_id: string; option_id: string; footwear_garment_id: string | null }>();
    const priorDoc = board.document ?? null;
    const score = (slots: CandidateSlot[], source: ScoredOption['source']): ScoredOption | null => {
      const v = validateOutfit({ slots, source }, ctx, { allowRepeats });
      if (!v.valid) return null;
      const t = tasteScore(v.parts, v, ctx);
      const garments = [...new Set(slots.filter((s) => !s.alternativeGroup).map((s) => s.garmentId))].map((id) => ctx.byId.get(id)!);
      const jd = jointAvailability({ ...jointIn, garments, targetDate: ctx.day.date });
      return { slots, validation: v, taste: t.score, joint: jd.probability, jointDetail: jd, score: t.score + 2.5 * jd.probability, devices: t.devices, suitable: suitsOccasion(v.parts, ctx.calendar.brief.occasion, v.statementCount), source };
    };
    /** An option carried unchanged whatever it validates to (a worn day is never rewritten); its validation is recorded as it is. */
    const scoreAsIs = (slots: CandidateSlot[]): ScoredOption => {
      const v = validateOutfit({ slots, source: 'carried' }, ctx, { allowRepeats });
      const t = tasteScore(v.parts, v, ctx);
      const garments = [...new Set(slots.filter((s) => !s.alternativeGroup).map((s) => s.garmentId))].map((id) => ctx.byId.get(id)!).filter(Boolean);
      const jd = jointAvailability({ ...jointIn, garments, targetDate: ctx.day.date });
      return { slots, validation: v, taste: t.score, joint: jd.probability, jointDetail: jd, score: t.score + 2.5 * jd.probability, devices: t.devices, suitable: suitsOccasion(v.parts, ctx.calendar.brief.occasion, v.statementCount), source: 'carried' };
    };
    const pools = eligiblePools(ctx, allowRepeats);
    const poolFor = (role: GarmentRole): WardrobeGarment[] =>
      role === 'base_top' ? pools.tops : role === 'bottom' ? pools.bottoms : role === 'outer_layer' ? pools.outers : role === 'socks' ? pools.socks : role === 'footwear' ? pools.footwear : role === 'belt' ? pools.belts : role === 'accessory' ? pools.flourishes : role === 'mid_layer' ? pools.mids : [];
    const navy = (g: WardrobeGarment) => ctx.policy.navyFallback.active && (g.families.includes(ctx.policy.navyFallback.colorFamily) || g.colorFamily === ctx.policy.navyFallback.colorFamily);

    type Working = { position: number; status: 'offerable' | 'reserve'; previousOptionId: string | null; slots: CandidateSlot[]; scored: ScoredOption | null; why: string | null; change: ChangeRecord; consumed?: boolean };
    const toSlots = (o: Board['options'][number]): CandidateSlot[] => o.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup }));
    const working: Working[] = board.options
      .filter((o) => o.status === 'offerable' || o.status === 'reserve')
      .map((o) => {
        // On a worn day nothing is rewritten: every option is carried as it is, valid under the new forecast or not.
        const scored = score(toSlots(o), 'carried') ?? (wornDay ? scoreAsIs(toSlots(o)) : null);
        return {
          position: o.position,
          status: o.status as 'offerable' | 'reserve',
          previousOptionId: o.optionId,
          slots: toSlots(o),
          scored,
          why: scored ? (priorDoc?.options.find((d) => d.optionId === o.optionId)?.why ?? o.explanation) : null,
          change: { position: o.position, previousOptionId: o.optionId, optionId: null, kind: 'kept', replaced: [], reason: null },
        };
      });

    const topsInUse = (except: Working | null) => new Set(working.filter((w) => w !== except && w.status === 'offerable' && w.scored).map((w) => w.slots.find((s) => s.role === 'base_top')?.garmentId));
    /** Trousers on the other offerable options: a repair or swap never repeats them within the board (trip boards excepted). */
    const bottomsInUse = (except: Working | null) =>
      allowRepeats ? new Set<string | undefined>() : new Set(working.filter((w) => w !== except && w.status === 'offerable' && w.scored).map((w) => w.slots.find((s) => s.role === 'bottom')?.garmentId));
    const clashes = (slots: CandidateSlot[], except: Working | null) =>
      topsInUse(except).has(slots.find((s) => s.role === 'base_top')?.garmentId) || bottomsInUse(except).has(slots.find((s) => s.role === 'bottom')?.garmentId);
    /** Replace only the offending garments of an option, keeping every other slot (never a navy fallback). */
    const slotRepair = (w: Working, offending: string[], explicit: Map<string, string> | null): { scored: ScoredOption; replaced: ChangeRecord['replaced'] } | null => {
      let slots = [...w.slots];
      const replaced: ChangeRecord['replaced'] = [];
      for (const gid of offending) {
        const slot = slots.find((s) => s.garmentId === gid);
        if (!slot) continue;
        const forced = explicit?.get(gid);
        const used = topsInUse(w);
        const usedBottoms = bottomsInUse(w);
        const candidates = forced
          ? [ctx.byId.get(forced)].filter((g): g is WardrobeGarment => Boolean(g))
          : poolFor(slot.role).filter((g) => g.garmentId !== gid && !slots.some((s) => s.garmentId === g.garmentId) && !navy(g) && !(slot.role === 'base_top' && used.has(g.garmentId)) && !(slot.role === 'bottom' && usedBottoms.has(g.garmentId)));
        let best: { scored: ScoredOption; g: WardrobeGarment } | null = null;
        for (const g of candidates) {
          const trial = slots.map((s) => (s === slot ? { ...s, garmentId: g.garmentId } : s));
          const v = validateOutfit({ slots: trial, source: 'repair' }, ctx, { allowRepeats, swap: { role: slot.role, replacedGarmentId: gid, replacementGarmentId: g.garmentId, explicit: Boolean(forced) } });
          if (!v.valid) continue;
          const sc = score(trial, 'repair');
          if (sc && (!best || sc.score > best.scored.score)) best = { scored: sc, g };
        }
        if (!best) return null;
        slots = best.scored.slots;
        replaced.push({ role: slot.role, from: ctx.byId.get(gid)?.name ?? gid, to: best.g.name });
      }
      const final = score(slots, 'repair');
      return final ? { scored: final, replaced } : null;
    };

    // Apply the owner's swap first.
    if (swap) {
      const w = working.find((x) => x.previousOptionId === swap.optionId);
      if (!w) throw new DomainError('conflict', 'That option is not part of the current board revision; the board changed since it was shown', { boardRevision: board.currentRevision });
      const target = w.slots.filter((s) => s.role === swap.role && (!swap.replacedGarmentId || s.garmentId === swap.replacedGarmentId));
      if (target.length !== 1) throw new DomainError('validation_failed', target.length ? 'Name which piece to swap' : `That option has no ${swap.role.replace('_', ' ')} to swap`);
      if (swap.replacementGarmentId && !ctx.byId.has(swap.replacementGarmentId)) throw new DomainError('not_found', 'Unknown garment');
      const res = slotRepair(w, [target[0]!.garmentId], swap.replacementGarmentId ? new Map([[target[0]!.garmentId, swap.replacementGarmentId]]) : null);
      if (!res) {
        const g = swap.replacementGarmentId ? ctx.byId.get(swap.replacementGarmentId) : null;
        const why = g ? validateOutfit({ slots: w.slots.map((s) => (s === target[0] ? { ...s, garmentId: g.garmentId } : s)) }, ctx, { allowRepeats, swap: { role: swap.role, replacedGarmentId: target[0]!.garmentId, replacementGarmentId: g.garmentId, explicit: true } }).violations.map((v) => v.detail) : [];
        return { ...base, status: 'no_valid_replacement', summary: g ? `${g.name} cannot go in: ${why.join('; ')}` : 'No available replacement keeps this outfit valid; the board is unchanged.' };
      }
      w.scored = res.scored;
      w.slots = res.scored.slots;
      w.why = whySentence(res.scored, ctx);
      w.change = { ...w.change, kind: 'swapped', replaced: res.replaced, reason: 'owner swap' };
    }

    // Repair every option that is no longer valid.
    const composedFill = { value: null as ComposedBoard | null };
    const freshCandidates = async (): Promise<ScoredOption[]> => {
      composedFill.value ??= await composeBoard(ctx, { jointInput: jointIn, allowRepeats, reserveCount: 6 });
      return [...composedFill.value.options, ...composedFill.value.reserves];
    };
    for (const w of working) {
      if (w.scored || w.consumed) continue;
      const v = validateOutfit({ slots: w.slots }, ctx, { allowRepeats });
      const offending = [...new Set(v.violations.flatMap((x) => x.garmentIds ?? []).filter((id) => w.slots.some((s) => s.garmentId === id)))];
      const why = v.violations.map((x) => x.detail).join('; ');
      const isSelected = selection?.option_id === w.previousOptionId;
      const trySlot = () => (offending.length ? slotRepair(w, offending, null) : null);
      const tryReserve = () => {
        if (w.status !== 'offerable') return null;
        const r = working.find((x) => x.status === 'reserve' && x.scored && !x.consumed && !clashes(x.slots, w));
        return r ?? null;
      };
      if (isSelected) {
        const res = trySlot();
        if (res) {
          Object.assign(w, { scored: res.scored, slots: res.scored.slots, why: whySentence(res.scored, ctx) });
          w.change = { ...w.change, kind: 'slot_repaired', replaced: res.replaced, reason: why };
          continue;
        }
      }
      const reserve = tryReserve();
      if (reserve) {
        Object.assign(w, { scored: reserve.scored, slots: reserve.slots, why: reserve.why });
        w.change = { ...w.change, kind: 'replaced_from_reserve', reason: why };
        reserve.consumed = true;
        reserve.scored = null;
        reserve.change = { ...reserve.change, kind: 'withdrawn', reason: 'promoted to the board' };
        continue;
      }
      const res = trySlot();
      if (res) {
        Object.assign(w, { scored: res.scored, slots: res.scored.slots, why: whySentence(res.scored, ctx) });
        w.change = { ...w.change, kind: 'slot_repaired', replaced: res.replaced, reason: why };
        continue;
      }
      if (w.status === 'offerable') {
        const fresh = (await freshCandidates()).find((o) => !clashes(o.slots, w) && !working.some((x) => x.scored === o));
        if (fresh) {
          Object.assign(w, { scored: fresh, slots: fresh.slots, why: whySentence(fresh, ctx) });
          w.change = { ...w.change, kind: 'replaced_by_composition', reason: why };
          continue;
        }
      }
      w.change = { ...w.change, kind: 'withdrawn', reason: why };
    }

    const changed = working.some((w) => w.change.kind !== 'kept');
    if (!changed && !opts.republishReason) return { ...base, status: 'unchanged', summary: 'Every option is still valid.' };
    const kept = working.filter((w) => w.scored);
    const offerable = kept.filter((w) => w.status === 'offerable').sort((a, b) => a.position - b.position);
    const reserves = kept.filter((w) => w.status === 'reserve');
    if (!offerable.length) {
      await this.db.prepare("UPDATE boards SET status = 'suppressed', version = version + 1 WHERE user_id = ? AND board_id = ? AND current_revision = ?").bind(this.principal.userId, board.boardId, board.currentRevision).run();
      const summary = `No valid outfit remains for ${boardDate}; the board is withdrawn rather than left stale.`;
      const receiptId = await this.recordRun(swap ? 'swap' : 'board_repair', board.boardId, { reason, boardDate }, { fromRevision: board.currentRevision, toRevision: null, changes: working.map((w) => w.change), summary });
      return { ...base, changed: true, status: 'suppressed_no_valid_option', changes: working.map((w) => w.change), summary, receiptId };
    }
    const docOptions: DocumentOption[] = [
      ...offerable.map((w, i) => ({ optionId: newOptionId(), position: i + 1, status: 'offerable' as const, scored: w.scored!, why: w.why ?? whySentence(w.scored!, ctx), lineage: { previousOptionId: w.previousOptionId, changedRoles: w.change.replaced.map((r) => r.role) } })),
      ...reserves.map((w, i) => ({ optionId: newOptionId(), position: offerable.length + i + 1, status: 'reserve' as const, scored: w.scored!, why: w.why ?? whySentence(w.scored!, ctx), lineage: { previousOptionId: w.previousOptionId, changedRoles: [] } })),
    ];
    offerable.forEach((w, i) => (w.change.optionId = docOptions[i]!.optionId));
    const shortfall = offerable.length < ctx.day.requestedCount ? `${offerable.length} complete outfit${offerable.length === 1 ? '' : 's'} instead of ${ctx.day.requestedCount}: the remaining combinations are no longer available.` : null;
    const document = buildDocument(ctx, { options: docOptions, shortfall, suitableCount: offerable.filter((w) => w.scored!.suitable).length, prose: 'deterministic' });
    let carry: { previousSelectionId: string; toOptionId: string; footwearGarmentId: string | null; reference: string } | null = null;
    const runId = newRunId(swap ? 'swp' : 'rep');
    if (selection) {
      const idx = offerable.findIndex((w) => w.previousOptionId === selection.option_id);
      if (idx >= 0) {
        const target = docOptions[idx]!;
        const footwear = target.scored.slots.filter((s) => s.role === 'footwear').map((s) => s.garmentId);
        carry = { previousSelectionId: selection.selection_id, toOptionId: target.optionId, footwearGarmentId: selection.footwear_garment_id && footwear.includes(selection.footwear_garment_id) ? selection.footwear_garment_id : footwear.length === 1 ? footwear[0]! : null, reference: `repair:${runId}` };
      }
    }
    let published: Board;
    try {
      published = await publishValidatedRevision(this.db, this.principal, {
        boardDate,
        timezone: ctx.day.timezone,
        purpose,
        expectedRevision: board.currentRevision,
        watermark: ctx.watermark,
        brief: board.brief,
        options: docOptions.map((o) => toPublishOption(o, ctx)),
        document,
        context: { ...contextEvidence(ctx), request },
        validation: { ...boardEvidence(ctx, null), revisionReason: reason, changes: working.map((w) => w.change) },
        estimator: estimatorEvidence(ctx, docOptions),
        carrySelection: carry,
        projectCalendar: true,
        now: this.now(),
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'conflict') {
        const r = err.details?.reason as PublishConflict | undefined;
        return { ...base, status: r === 'paused' ? 'paused' : 'conflict', summary: r === 'paused' ? 'Recommendations are paused for that day.' : 'The wardrobe changed again during repair; the next revalidation covers it.' };
      }
      throw err;
    }
    const summary = [opts.republishReason && !changed ? opts.republishReason : null, changed ? changeSummary(boardDate, working.map((w) => w.change)) : null].filter(Boolean).join(' ');
    const receiptId = await this.recordRun(swap ? 'swap' : 'board_repair', board.boardId, { reason, boardDate, swap }, { fromRevision: board.currentRevision, toRevision: published.currentRevision, changes: working.map((w) => w.change), summary, selectionCarried: Boolean(carry) });
    return { changed: true, board: published, fromRevision: board.currentRevision, toRevision: published.currentRevision, changes: working.map((w) => w.change), summary, receiptId, status: 'revised' };
  }

  /** Changed-item receipt of a repair or swap (never a model's text). */
  private async recordRun(kind: string, boardId: string, input: Record<string, unknown>, result: Record<string, unknown>): Promise<string> {
    const runId = newRunId('run');
    const now = this.now();
    await this.db
      .prepare("INSERT INTO runs (user_id, run_id, kind, status, parent_ref, input_json, result_json, created_at, updated_at, version) VALUES (?, ?, ?, 'complete', ?, ?, ?, ?, ?, 1)")
      .bind(this.principal.userId, runId, kind, `board:${boardId}`, json(input), json(result), now, now)
      .run();
    return runId;
  }

  async listRevisionReceipts(boardId: string): Promise<{ runId: string; kind: string; createdAt: string; result: Record<string, unknown> }[]> {
    const { results } = await this.db
      .prepare("SELECT run_id, kind, created_at, result_json FROM runs WHERE user_id = ? AND parent_ref = ? AND kind IN ('board_repair', 'swap') ORDER BY created_at")
      .bind(this.principal.userId, `board:${boardId}`)
      .all<{ run_id: string; kind: string; created_at: string; result_json: string }>();
    return results.map((r) => ({ runId: r.run_id, kind: r.kind, createdAt: r.created_at, result: parseJson(r.result_json, {}) }));
  }
}

function changeSummary(date: string, changes: ChangeRecord[]): string {
  const parts = changes
    .filter((c) => c.kind !== 'kept' && !(c.kind === 'withdrawn' && c.reason === 'promoted to the board'))
    .map((c) => {
      if (c.replaced.length) return `${c.replaced.map((r) => `${r.to} replaces ${r.from}`).join(', ')}`;
      if (c.kind === 'replaced_from_reserve' || c.kind === 'replaced_by_composition') return `option ${c.position} replaced`;
      if (c.kind === 'withdrawn') return `option ${c.position} withdrawn`;
      return `option ${c.position} changed`;
    });
  return `Updated the board for ${date}: ${parts.join('; ')}.`;
}

function toPublishOption(o: DocumentOption, ctx: MandatoryContext): PublishOption {
  return {
    optionId: o.optionId,
    position: o.position,
    status: o.status,
    explanation: o.why,
    slots: o.scored.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup ?? null })),
    validation: optionEvidence(o.scored, ctx),
  };
}

function compactCheck(c: Check) {
  return { ruleKey: c.ruleKey, strength: c.strength, passed: c.passed, detail: c.detail, section: c.passage?.section ?? null };
}

/** Stored validation evidence of an option: every rule checked, with its result and passage section. */
export function optionEvidence(o: ScoredOption, ctx: MandatoryContext): Record<string, unknown> {
  return {
    valid: o.validation.valid,
    source: o.source,
    register: o.validation.register,
    registers: o.validation.registers,
    safe: o.validation.safe,
    statementCount: o.validation.statementCount,
    suitable: o.suitable,
    taste: Math.round(o.taste * 100) / 100,
    devices: o.devices,
    jointAvailability: o.jointDetail ? { probability: o.jointDetail.probability, perGarment: o.jointDetail.perGarment, constrained: o.jointDetail.constrained, model: 'exact DP over earlier board days (availability-estimator/1 inputs)' } : { probability: o.joint },
    rulesChecked: o.validation.checks.map(compactCheck),
    thermal: ctx.thermal,
  };
}

function boardEvidence(ctx: MandatoryContext, composed: ComposedBoard | null): Record<string, unknown> {
  return {
    policyVersion: ctx.policy.policyVersion,
    profile: { sha256: ctx.policy.documentSha256, version: ctx.policy.documentVersion },
    rulesApplied: Object.values(ctx.policy.rules).map((r) => ({ ruleKey: r.ruleKey, strength: r.strength, section: r.section, relaxedBy: r.relaxedBy })),
    sneakersOnlyActive: ctx.policy.sneakersOnly.active,
    sneakerAndWeltedActive: ctx.policy.sneakerAndWelted.active,
    ...(composed
      ? {
          boardChecks: composed.boardChecks.map(compactCheck),
          pools: composed.pools,
          shortfall: composed.shortfall,
          candidatesConsidered: composed.candidatesConsidered,
          rejectedCandidates: composed.rejected.length,
          rejectedSample: composed.rejected.slice(0, 10).map((r) => ({ source: r.source, violations: r.violations.map((v) => `${v.ruleKey}: ${v.detail}`) })),
          occasion: composed.occasion,
          suitableCount: composed.suitableCount,
        }
      : {}),
  };
}

function estimatorEvidence(ctx: MandatoryContext, options: DocumentOption[]): Record<string, unknown> {
  const ids = [...new Set(options.flatMap((o) => o.scored.slots.map((s) => s.garmentId)))];
  return {
    estimatorVersion: ESTIMATOR_VERSION,
    parametersNote: 'Initial parameters are hypotheses, not calibrated accuracy',
    defaultParameters: DEFAULT_ESTIMATOR_PARAMETERS,
    garments: Object.fromEntries(
      ids.map((id) => {
        const e = ctx.byId.get(id)?.estimate;
        return [id, e ? { probabilityAvailable: e.probabilityAvailable, estimatedCleanUnits: e.estimatedCleanUnits, expectedInferredWears: e.expectedInferredWears, basis: e.basis } : null];
      }),
    ),
  };
}
