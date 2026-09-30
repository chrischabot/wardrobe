import type { Board } from '@garderobe/contracts';
import type { CalendarSource } from '../calendar/types.js';
import type { Principal } from '../domain/principal.js';
import { RecommendationService, getDailyBoard, type Candidate, type MandatoryContext as DailyContext, type OutfitValidation } from '../recommend/index.js';
import { OpenMeteoProvider } from '../weather/open-meteo.js';
import type { WeatherProvider } from '../weather/types.js';
import { wrapUntrusted } from '../connectors/untrusted.js';
import type { DayContext, DayContextProvider } from './context.js';

/**
 * The daily service's trusted mandatory context for conversational turns (spec section 7).
 *
 * Before every turn, trusted code calls the daily service: `RecommendationService.context({ date })`
 * (weather with fetch and issue times, the calendar day brief, availability, recent wear) and
 * `getDailyBoard` for the published board. The assistant therefore discusses the same weather,
 * calendar and availability the morning board uses. When the daily service cannot build its
 * context, the turn gets the published-board summary alone and the section says so.
 *
 * Outfit proposals from the model go through `RecommendationService.validateProposal`: only a
 * proposal that passes is presented as an actionable outfit card.
 */

export interface DailyProviders {
  weather: WeatherProvider | null;
  calendar: CalendarSource | null;
  clock?: () => string;
}

/** The daily-service surface the assistant uses (the real RecommendationService satisfies it). */
export interface DailyRecommendations {
  context(req: { date: string }): Promise<DailyContext>;
  validateProposal(req: { date: string; include?: string[] }, candidate: Candidate): Promise<OutfitValidation>;
}

export type RecommendationsFactory = (db: D1Database, principal: Principal) => DailyRecommendations;

let testProviders: DailyProviders | null = null;
let testFactory: RecommendationsFactory | null = null;

/** Tests and the simulation install fake weather/calendar (and optionally a failing daily service). */
export function installTestDailyProviders(p: DailyProviders | null, factory: RecommendationsFactory | null = null): void {
  testProviders = p;
  testFactory = factory;
}

/**
 * Default providers: Open-Meteo for weather (keyless, the daily service's own default) and no
 * calendar until the owner connects Google Calendar (reported as "not connected", never as an
 * empty day). This mirrors createDailyService's defaults.
 */
export function recommendationsFor(db: D1Database, principal: Principal): DailyRecommendations {
  if (testFactory) return testFactory(db, principal);
  const p = testProviders ?? { weather: new OpenMeteoProvider(), calendar: null };
  return new RecommendationService({ db, principal, weather: p.weather, calendar: p.calendar, clock: p.clock });
}

const fmt = (v: number | null | undefined, unit: string) => (v === null || v === undefined ? 'unknown' : `${Math.round(v * 10) / 10}${unit}`);

function weatherSection(ctx: DailyContext): string {
  const w = ctx.weather.summary;
  const t = ctx.thermal;
  const lines = [
    `Source: ${w.provider ?? 'none'} (${w.status}); fetched ${w.fetchedAt ?? 'never'}; issued ${w.issuedAt ?? 'not supplied'}${w.ageMinutes !== null ? `; ${w.ageMinutes} min old` : ''}. Location ${w.locationLabel}.`,
    `Wearing interval ${w.wearingInterval.start}–${w.wearingInterval.end}${w.eveningOnly ? ' (evening only)' : ''}; departure ${w.departureTime}.`,
    `Departure ${fmt(w.departureTempC, ' °C')} (outerwear basis); peak ${fmt(w.peakTempC, ' °C')} (shirt and trouser basis); low ${fmt(w.lowTempC, ' °C')}; evening ${fmt(w.eveningTempC, ' °C')}.`,
    `Rain: max probability ${fmt(w.rainProbabilityMax, '%')}${w.rainStartsAt ? `, likely from ${w.rainStartsAt}` : ''}; amount ${fmt(w.rainAmountMm, ' mm')}. Wind max ${fmt(w.windSpeedMaxKmh, ' km/h')}, gusts ${fmt(w.windGustMaxKmh, ' km/h')}.`,
    `Conditions: ${w.conditions.length ? w.conditions.join(', ') : 'none flagged'}.`,
    `Thermal basis used by the validator: peak ${t.peakTempC} °C, departure ${t.departureTempC} °C (${t.source === 'forecast' ? 'forecast' : `seasonal fallback, not a forecast: ${t.detail}`}).`,
  ];
  return lines.join('\n');
}

function calendarSection(ctx: DailyContext): string {
  const b = ctx.calendar.brief;
  const head = `Status ${b.status}${b.fetchedAt ? `, read ${b.fetchedAt}` : ''}. Shape of the day: ${b.shapeOfDay}${b.occasion ? ` Occasion shaping part of the board: ${b.occasion}.` : ''}`;
  if (!b.events.length) return head;
  // Titles come from other people's calendars: data, never instructions. Descriptions are not passed on.
  const events = wrapUntrusted(
    'Google Calendar (titles only)',
    b.events.map((e) => `${e.allDay ? 'all day' : `${e.localStart ?? '?'}–${e.localEnd ?? '?'}`} ${e.title}${e.occasion ? ` [${e.occasion}]` : ''}${e.ignoredBecause ? ` (ignored: ${e.ignoredBecause})` : ''}`).join('\n'),
    { maxChars: 2000 },
  );
  return `${head}\n${events.notice}\n${events.content}`;
}

function availabilitySection(ctx: DailyContext): string {
  const planned = ctx.wardrobe.filter((g) => g.acquisition === 'owned');
  const unavailable = planned.filter((g) => !g.eligibility.available || ((g.laundryPolicy === 'per_wear' || g.laundryPolicy === 'single_wear_day') && (!g.estimate || g.estimate.estimatedCleanUnits <= 0)));
  const uncertain = planned.filter((g) => g.eligibility.available && g.estimate && g.estimate.estimatedCleanUnits > 0 && !g.estimate.likelyAvailable);
  const reason = (g: DailyContext['wardrobe'][number]) => (g.eligibility.available ? 'no clean unit (dirty or away)' : g.eligibility.reasons.join('; ') || g.eligibility.label);
  return [
    `${planned.length - unavailable.length} of ${planned.length} owned pieces are available for ${ctx.day.date}.`,
    unavailable.length ? `Not available:\n${unavailable.map((g) => `- ${g.name}: ${reason(g)}`).join('\n')}` : 'Nothing owned is unavailable.',
    uncertain.length ? `Uncertain (estimate, not an observation):\n${uncertain.map((g) => `- ${g.name}: P(clean) ${Math.round((g.estimate!.probabilityAvailable ?? 0) * 100)}%`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function wearSection(ctx: DailyContext): string {
  if (!ctx.recentWears.length) return 'None recorded (a missing record means unlogged, not unworn).';
  const names = new Map(ctx.wardrobe.map((g) => [g.garmentId, g.name]));
  const byDate = new Map<string, string[]>();
  for (const w of ctx.recentWears) byDate.set(w.wearingDate, [...(byDate.get(w.wearingDate) ?? []), names.get(w.garmentId) ?? w.garmentId]);
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([d, ns]) => `- ${d}: ${ns.join(', ')}`)
    .join('\n');
}

function boardSection(board: Board | null, date: string): string {
  if (!board || board.status !== 'published') return `No board is published for ${date}.`;
  const doc = board.document;
  const text = (doc as { text?: string } | null | undefined)?.text;
  const ids = board.options
    .filter((o) => o.status === 'offerable')
    .map((o) => `option ${o.position} = ${o.optionId}: ${o.slots.map((s) => `${s.role} ${s.garmentId}${s.alternativeGroup ? ` (alt ${s.alternativeGroup})` : ''}`).join(', ')}`);
  return [`Revision ${board.currentRevision}, published ${board.publishedAt ?? 'unknown'}.`, text ?? doc?.dayLine ?? '', 'Option ids:', ...ids].filter(Boolean).join('\n');
}

/** Fallback when the daily service cannot build its context: the published board alone, labelled. */
async function boardOnlyFallback(db: D1Database, principal: Principal, date: string, reason: string): Promise<DayContext> {
  const board = await getDailyBoard(db, principal, date).catch(() => null);
  return {
    text: `FALLBACK — the daily service could not build today's context (${reason}). Weather, calendar and availability for ${date} are unknown in this turn; do not invent them.\n\n## Published board\n${boardSection(board, date)}`,
    sources: ['board', 'fallback'],
    fallback: true,
  };
}

export const dailyServiceDayContext: DayContextProvider = async (db, principal, date) => {
  let ctx: DailyContext | null = null;
  let reason = 'no context returned';
  try {
    ctx = await recommendationsFor(db, principal).context({ date });
  } catch (err) {
    reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  }
  if (!ctx) return boardOnlyFallback(db, principal, date, reason);
  const board = await getDailyBoard(db, principal, date).catch(() => null);
  const stamps = ctx.sources.map((s) => `${s.source}: ${s.status}${s.observedAt ? ` @ ${s.observedAt}` : ''}${s.revision ? ` (${s.revision})` : ''}`).join('; ');
  const text = [
    `Daily service context ${ctx.contextVersion}, built ${ctx.builtAt} for ${ctx.day.date} (${ctx.day.timezone}). Sources — ${stamps}.`,
    `## Weather\n${weatherSection(ctx)}`,
    `## Calendar day brief\n${calendarSection(ctx)}`,
    `## Availability (hard gate for any outfit)\n${availabilitySection(ctx)}`,
    `## Recent wear (daily service, 7-day repeat horizon)\n${wearSection(ctx)}`,
    `## Published board\n${boardSection(board, date)}`,
    'Any outfit you suggest must be submitted with propose_outfit; only a validated proposal is shown as actionable.',
  ].join('\n\n');
  return { text, sources: ['daily_service', ...ctx.sources.map((s) => s.source), ...(board ? ['board'] : [])], fallback: false };
};

export interface ProposalSlot {
  garmentId: string;
  role: Candidate['slots'][number]['role'];
  alternativeGroup?: string | null;
}

export interface OutfitCard {
  kind: 'outfit_card';
  actionable: boolean;
  date: string;
  validatedBy: 'daily_service.validateProposal';
  slots: { garmentId: string; role: string; name: string | null; alternativeGroup: string | null }[];
  explanation: string | null;
  failedRules: { ruleKey: string; detail: string; garmentIds: string[] }[];
  warnings: { ruleKey: string; detail: string }[];
  summary: string;
}

/**
 * Validate a model-proposed outfit with the daily service. Nothing is published, selected or worn:
 * the result is a card whose `actionable` flag comes from the validator alone.
 */
export async function validateOutfitProposal(
  db: D1Database,
  principal: Principal,
  input: { date: string; slots: ProposalSlot[]; explanation?: string | null; include?: string[] },
): Promise<OutfitCard> {
  const rec = recommendationsFor(db, principal);
  const candidate: Candidate = { slots: input.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, alternativeGroup: s.alternativeGroup ?? null })), source: 'model' };
  let validation: OutfitValidation | null = null;
  let failure: string | null = null;
  try {
    validation = await rec.validateProposal({ date: input.date, include: input.include }, candidate);
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  const names = new Map<string, string>();
  const ids = [...new Set(input.slots.map((s) => s.garmentId))];
  if (ids.length) {
    const { results } = await db
      .prepare(`SELECT garment_id, name FROM garments WHERE user_id = ? AND garment_id IN (${ids.map(() => '?').join(',')})`)
      .bind(principal.userId, ...ids)
      .all<{ garment_id: string; name: string }>();
    for (const r of results) names.set(r.garment_id, r.name);
  }
  const slots = input.slots.map((s) => ({ garmentId: s.garmentId, role: s.role, name: names.get(s.garmentId) ?? null, alternativeGroup: s.alternativeGroup ?? null }));
  if (!validation) {
    return {
      kind: 'outfit_card',
      actionable: false,
      date: input.date,
      validatedBy: 'daily_service.validateProposal',
      slots,
      explanation: input.explanation ?? null,
      failedRules: [{ ruleKey: 'validation.unavailable', detail: `The daily service could not validate this outfit: ${failure ?? 'no result'}`, garmentIds: [] }],
      warnings: [],
      summary: 'Not actionable: the outfit could not be validated.',
    };
  }
  const failedRules = validation.violations.map((v) => ({ ruleKey: v.ruleKey, detail: v.detail, garmentIds: v.garmentIds ?? [] }));
  return {
    kind: 'outfit_card',
    actionable: validation.valid,
    date: input.date,
    validatedBy: 'daily_service.validateProposal',
    slots,
    explanation: input.explanation ?? null,
    failedRules,
    warnings: validation.warnings.map((w) => ({ ruleKey: w.ruleKey, detail: w.detail })),
    summary: validation.valid
      ? `Actionable outfit for ${input.date}: ${slots.map((s) => s.name ?? s.garmentId).join(', ')}.`
      : `Not actionable: failed ${failedRules.map((f) => f.ruleKey).join(', ')} — ${failedRules.map((f) => f.detail).join(' ')}`,
  };
}
