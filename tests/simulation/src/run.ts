/**
 * Garderobe end-to-end MCP simulation.
 *
 *   npx tsx tests/simulation/src/run.ts --target local|dev [--seed 20261005] [--days 28] [--max-asks 60] [--no-asks] [--out <dir>]
 *
 * For each simulated day (London time) it runs the scheduled daily phases for that day through the
 * simulation hook (evening compose the night before, 06:40 refresh, 06:50 final), then acts as the
 * owner over MCP only: reads Today, picks one of the offered outfits at random (seeded), records the
 * wear, changes availability (laundry, spills, repair, tailor, storage, trip packing), pauses and
 * resumes, previews swaps and occasion outfits, and asks the assistant questions. Every read is
 * checked against the owner's hard constraints and the availability oracle; assistant turns are
 * audited at the end (outfit cards, models, cost). Writes <out>/<target>-seed<seed>.json and .md.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TodayResponse, WardrobeItem } from '@garderobe/contracts';
import { answerTextFindings, asToday, cardFindings, outfitViolations, type DayContextForChecks, type OutfitCardLike } from './checks.js';
import { addDays, buildScenario, type AskPlan, type Scenario, type SimDay } from './scenario.js';
import { hourOf, SIM_HEADER, type DayWeather } from './sim-state.js';
import { http, McpSession, oauthGrant, resolveTarget, type Target, type ToolResult } from './target.js';
import { World } from './world.js';
import { renderMarkdown } from './report.js';

const simDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------------------------ records

export interface ActionRecord {
  name: string;
  at: string;
  outcome: string;
  code?: string | null;
  detail?: string;
  expected?: string;
  ok: boolean;
}

export interface AskRecord {
  dayIndex: number;
  date: string;
  kind: AskPlan['kind'];
  expectedDepth: 'routine' | 'deep';
  text: string;
  clientTurnId: string | null;
  tool: 'garderobe_ask' | 'garderobe_research';
  simAt: string;
  status: string;
  answer: string | null;
  receipts: { type: string | null; outcome: string; summary: string }[];
  blocked: { family: string; reason: string }[];
  ms: number;
  error?: string;
  ctx: { peakC: number | null; departureC: number | null; sneakersOnly: boolean; allowRepeats: boolean; worn7: string[]; declaredAway: [string, string][]; productUnavailable: [string, string][]; available: string[] };
  // Filled by the audit:
  turnStatus?: string | null;
  research?: { firstStatus: string; next: unknown; polls: number; textMentionsNext: boolean };
  turnCreatedAt?: string | null;
  dayFallback?: boolean | null;
  cards?: OutfitCardLike[];
  cardFindings?: ReturnType<typeof cardFindings>;
  textFindings?: string[];
  models?: { task: string; profileId: string; model: string; route: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; status: string; fallbackOf: string | null }[];
  violations?: string[];
}

export interface DayRecord {
  index: number;
  date: string;
  weekday: string;
  weatherKind: string;
  calendarLabels: string[];
  occasion: string | null;
  circumstances: string[];
  tripDestination: string | null;
  phases: { phase: string; boardDate: string; status: string; published?: boolean | null; repair?: string | null; error?: string | null }[];
  board: { status: string; purpose: string | null; revision: number | null; offerable: number; shortfall: string | null; weather: Record<string, unknown> | null; weatherCheck: string; calendarSource: string | null } | null;
  violations: string[];
  selection: { position: number; optionId: string; footwear: string | null; outcome: string } | null;
  wear: { outcome: string; garments: number } | null;
  actions: ActionRecord[];
  previews: { kind: string; options: number; violations: string[]; note?: string }[];
  asks: AskRecord[];
  errors: string[];
}

export interface RunReport {
  target: 'local' | 'dev';
  seed: number;
  runTag: string;
  startedAt: string;
  finishedAt: string;
  deployedVersion: string | null;
  simulationOwner: string;
  scenario: Scenario;
  wardrobe: { garments: number; available: number | null };
  mcp: { protocol: string | null; toolCalls: number; toolErrors: number; refreshes: number; perTool: Record<string, { n: number; errors: number; p50: number; max: number }> };
  days: DayRecord[];
  audit: { turns: number; modelRuns: number; ownerSpendUsd: number; runsByModel: Record<string, { runs: number; inputTokens: number; outputTokens: number; costUsd: number; failed: number }>; unattributedRuns: number } | null;
  totals: Record<string, number>;
  notes: string[];
}

// ------------------------------------------------------------------------------------ helpers

const sc = (r: ToolResult) => (r.structuredContent ?? {}) as Record<string, any>;
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join(' ');

function arg(args: string[], flag: string): string | undefined {
  return args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
}

function weatherExpectation(day: DayWeather): { departure: [number, number]; peak: number } {
  const dep = [7, 8, 9].map((h) => hourOf(day, h).temperatureC);
  const peak = Math.max(...Array.from({ length: 16 }, (_, i) => hourOf(day, 7 + i).temperatureC));
  return { departure: [Math.min(...dep), Math.max(...dep)], peak };
}

class Runner {
  readonly world: World;
  mcp!: McpSession;
  readonly days: DayRecord[] = [];
  wardrobe = new Map<string, WardrobeItem>();
  readonly worn = new Map<string, string[]>();
  readonly declaredAway = new Map<string, string>();
  sneakersOnly = true;
  sneakersRestrictionId: string | null = null;
  tripId: string | null = null;
  packed = new Set<string>();
  repairRestrictionId: string | null = null;
  repairGarment: string | null = null;
  tailorGarment: string | null = null;
  spill: { garmentId: string; collected: boolean } | null = null;
  laundryException: string | null = null;
  asksDone = 0;
  readonly notes: string[] = [];
  private keyN = 0;

  constructor(
    readonly target: Target,
    readonly scenario: Scenario,
    readonly runTag: string,
    readonly opts: { maxAsks: number; asks: boolean },
  ) {
    this.world = new World(scenario, target.userId, target.simSecret);
  }

  key(label: string): string {
    return `sim-${this.scenario.seed}-${this.runTag}-${this.world.date}-${label}-${++this.keyN}`.replace(/[^A-Za-z0-9:._-]/g, '-').slice(0, 190);
  }

  get day(): DayRecord {
    return this.days[this.days.length - 1]!;
  }

  async app(path: string, init: { method?: string; body?: unknown } = {}) {
    return http(`${this.target.appOrigin}${path}`, { method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), headers: { ...(await this.target.appHeaders()), [SIM_HEADER]: await this.world.header(), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
  }

  async phase(phase: 'evening' | 'morning_refresh' | 'final', boardDate: string): Promise<void> {
    const r = await this.app('/__sim/phase', { body: { phase, boardDate } });
    const rec = r.status === 200 ? { phase, boardDate, status: r.body.status, published: r.body.publish?.published ?? null, repair: r.body.repair?.status ?? null, error: r.body.error ?? r.body.publish?.shortfall ?? null } : { phase, boardDate, status: `http_${r.status}`, error: r.text.slice(0, 200) };
    (this.days.length ? this.day : null)?.phases.push(rec);
    if (!this.days.length) this.notes.push(`Initial evening phase for ${boardDate}: ${rec.status}${rec.error ? ` (${rec.error})` : ''}`);
    if (r.status !== 200 || rec.status === 'failed') this.day?.errors.push(`phase ${phase} ${boardDate}: ${rec.status} ${rec.error ?? ''}`);
  }

  async command(name: string, command: Record<string, unknown>, expected = 'committed'): Promise<Record<string, any> | null> {
    const r = await this.mcp.tool('garderobe_command', { idempotencyKey: this.key(name), command });
    const s = sc(r);
    const receipt = s.receipt as Record<string, any> | null;
    const outcome = r.isError ? 'tool_error' : (receipt?.outcome ?? s.status ?? 'unknown');
    const ok = expected.split('|').includes(outcome) || (expected.includes('committed') && outcome === 'merged');
    this.day.actions.push({ name, at: this.world.hhmm, outcome, code: receipt?.error?.code ?? null, detail: r.isError ? textOf(r).slice(0, 300) : (receipt?.error?.message ?? receipt?.summary ?? '').slice(0, 240), expected, ok });
    return receipt;
  }

  async operation(name: string, operation: Record<string, unknown>): Promise<Record<string, any> | null> {
    const r = await this.mcp.tool('garderobe_command', { idempotencyKey: this.key(name), operation });
    const s = sc(r);
    const outcome = r.isError ? 'tool_error' : String(s.status ?? 'unknown');
    this.day.actions.push({ name, at: this.world.hhmm, outcome, detail: r.isError ? textOf(r).slice(0, 300) : undefined, expected: 'executed', ok: outcome === 'executed' });
    return (s.operation?.result as Record<string, any>) ?? null;
  }

  async inventoryIds(availability: 'available' | 'unavailable'): Promise<Set<string>> {
    return new Set((await this.inventoryLabels(availability)).keys());
  }

  /** Garment id to the inventory's own availability label and reasons. */
  async inventoryLabels(availability: 'available' | 'unavailable'): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r = await this.mcp.tool('garderobe_inventory', { view: 'items', availability, limit: 500, ...(cursor ? { cursor } : {}) });
      const s = sc(r);
      for (const i of (s.items ?? []) as WardrobeItem[]) ids.set(i.garment.garmentId, [i.availability?.label, ...(i.availability?.reasons ?? [])].filter(Boolean).join('; '));
      cursor = s.nextCursor ?? null;
      if (!cursor) break;
    }
    return ids;
  }

  worn7(date: string): Set<string> {
    const out = new Set<string>();
    for (let i = 1; i <= 7; i++) for (const id of this.worn.get(addDays(date, -i)) ?? []) out.add(id);
    return out;
  }

  todayWeather: { peakC: number | null; departureC: number | null } = { peakC: null, departureC: null };

  async checkContext(sd: SimDay): Promise<DayContextForChecks> {
    const productUnavailable = await this.inventoryLabels('unavailable');
    return { date: sd.date, peakC: this.todayWeather.peakC, departureC: this.todayWeather.departureC, wornLastSevenDays: this.worn7(sd.date), sneakersOnly: this.sneakersOnly, declaredAway: new Map(this.declaredAway), productUnavailable, allowRepeats: Boolean(sd.tripDestination) };
  }

  pickGarment(filter: (g: WardrobeItem) => boolean, roll: number, avoid: Set<string> = new Set()): WardrobeItem | null {
    const pool = [...this.wardrobe.values()].filter((g) => g.garment.acquisition === 'owned' && g.garment.planningPolicy !== 'excluded' && !avoid.has(g.garment.garmentId) && !this.declaredAway.has(g.garment.garmentId) && filter(g)).sort((a, b) => a.garment.garmentId.localeCompare(b.garment.garmentId));
    return pool.length ? pool[Math.floor(roll * pool.length)]! : null;
  }

  // ---------------------------------------------------------------------------------- the run

  async start(): Promise<void> {
    await this.world.at(-1, '20:30');
    const grant = await oauthGrant(this.target, () => this.world.header());
    this.mcp = new McpSession(this.target, grant, () => this.world.header(), () => ({ action: 'accept', content: { choice: 'confirm' } }));
    await this.mcp.connect();
    const snap = sc(await this.mcp.tool('garderobe_inventory', { view: 'snapshot', limit: 500 }));
    for (const i of (snap.items ?? []) as WardrobeItem[]) this.wardrobe.set(i.garment.garmentId, i);
    if (this.wardrobe.size < 100) throw new Error(`The simulation owner's wardrobe has only ${this.wardrobe.size} garments; expected the owner's real wardrobe (144)`);
    // The profile's healing restriction on welted footwear (Paraboot is one of the restricted pieces).
    const paraboot = [...this.wardrobe.values()].find((g) => /paraboot/i.test(g.garment.name));
    if (paraboot) {
      const item = sc(await this.mcp.tool('garderobe_inventory', { view: 'item', garmentId: paraboot.garment.garmentId })).item as { restrictions?: { restrictionId: string; liftedAt: string | null }[] } | null;
      this.sneakersRestrictionId = item?.restrictions?.find((r) => r.liftedAt === null)?.restrictionId ?? null;
    }
    this.sneakersOnly = Boolean(this.sneakersRestrictionId);
    this.notes.push(`Healing restriction at start: ${this.sneakersRestrictionId ? 'active (sneakers only)' : 'not found (sneaker plus welted pairing applies)'}.`);
    if (!this.resumeFrom) await this.phase('evening', this.scenario.days[0]!.date);
  }

  resumeFrom = 0;

  /**
   * Continue an interrupted run on the same simulation owner: the harness's view of the owner is rebuilt
   * from the server itself (recorded wears from the history view, pieces away from home from the
   * snapshot, the healing restriction from the item record), never from what the harness remembers.
   */
  async rebuildForResume(fromIndex: number, previous: DayRecord[]): Promise<void> {
    const sd = this.scenario.days[fromIndex]!;
    await this.world.at(fromIndex, '06:30');
    const hist = sc(await this.mcp.tool('garderobe_inventory', { view: 'history', from: addDays(sd.date, -8), to: addDays(sd.date, -1), limit: 500 }));
    for (const w of (hist.wears ?? []) as { garmentId: string; wearingDate: string; status: string }[]) if (w.status === 'active') this.worn.set(w.wearingDate, [...(this.worn.get(w.wearingDate) ?? []), w.garmentId]);
    for (const i of this.wardrobe.values()) if (i.garment.location !== 'home' && i.garment.acquisition === 'owned') this.declaredAway.set(i.garment.garmentId, `away from home (${i.garment.location})`);
    this.days.push(...previous.filter((d) => d.index < fromIndex));
    this.notes.push(`Resumed at day ${fromIndex} (${sd.date}) after the harness process was killed by an agent restart; days 0\u2013${fromIndex - 1} are the records of the interrupted run on the same simulation owner. Rebuilt from the server: ${[...this.worn.values()].flat().length} recorded wears in the previous 8 days, ${this.declaredAway.size} pieces away from home, healing restriction ${this.sneakersOnly ? 'active' : 'lifted'}. Day ${fromIndex} may repeat actions that had already run before the interruption (phases then report \u201cduplicate\u201d; repeated picks and wears merge).`);
  }

  async runDay(sd: SimDay): Promise<void> {
    this.days.push({ index: sd.index, date: sd.date, weekday: sd.weekday, weatherKind: sd.weatherKind, calendarLabels: sd.calendarLabels, occasion: sd.occasion, circumstances: sd.circumstances, tripDestination: sd.tripDestination, phases: [], board: null, violations: [], selection: null, wear: null, actions: [], previews: [], asks: [], errors: [] });
    const has = (c: string) => sd.circumstances.includes(c as never);
    const paused = has('paused');

    // 06:40 and 06:50: the morning phases.
    await this.world.at(sd.index, '06:40');
    await this.phase('morning_refresh', sd.date);
    await this.world.at(sd.index, '06:50');
    await this.phase('final', sd.date);

    // 07:00: the owner opens Today over MCP.
    await this.world.at(sd.index, '07:00');
    const today = await this.readToday(sd);

    // Morning questions (before 12:00), then the pick.
    for (const a of sd.asks.filter((x) => x.at < '12:00')) await this.ask(sd, a);
    if (!paused && today?.board?.status === 'published') await this.selectAndWear(sd, today);

    // Daytime circumstances.
    await this.world.at(sd.index, '12:00');
    if (has('spill_mark_in_wash')) await this.spillOnShirt(sd, today);
    if (has('laundry_collected')) {
      await this.command('laundry_collected', { type: 'laundry_collected' }, 'committed|rejected');
      if (this.spill) this.spill.collected = true;
    }
    if (has('sent_to_tailor')) {
      const t = this.pickGarment((g) => g.garment.category === 'trousers', sd.selectionRoll, new Set(this.worn.get(sd.date) ?? []));
      if (t) {
        const r = await this.command('send_to_tailor', { type: 'send_to_tailor', garmentId: t.garment.garmentId, work: 'Take in the waist (simulation)', expectedReturn: addDays(sd.date, 6) });
        if (r?.outcome === 'committed') {
          this.tailorGarment = t.garment.garmentId;
          this.declaredAway.set(t.garment.garmentId, 'at the tailor');
        }
      }
    }
    if (has('back_from_tailor') && this.tailorGarment) {
      await this.command('back_from_tailor', { type: 'back_from_tailor', garmentId: this.tailorGarment, note: 'Waist taken in (simulation)' });
      this.declaredAway.delete(this.tailorGarment);
      this.tailorGarment = null;
    }
    if (has('seasonal_storage')) {
      const s = this.pickGarment((g) => /linen|seersucker|summer/i.test(`${g.garment.name} ${JSON.stringify(g.garment.attributes ?? {})}`) && g.garment.tracking === 'unit', sd.footwearRoll) ?? this.pickGarment((g) => g.garment.category === 'shirt' && g.garment.tracking === 'unit', sd.footwearRoll);
      if (s) {
        const r = await this.command('put_into_storage', { type: 'put_into_storage', garmentId: s.garment.garmentId, locationDetail: 'Loft (simulation)' });
        if (r?.outcome === 'committed') this.declaredAway.set(s.garment.garmentId, 'in storage');
      }
    }
    if (this.declaredAway.size && (has('spill_mark_in_wash') || has('sent_to_tailor') || has('seasonal_storage'))) await this.checkRepairedToday(sd);

    // 18:00: laundry comes back.
    await this.world.at(sd.index, '18:00');
    if (has('laundry_returned') || has('laundry_partial_return')) await this.laundryReturn(sd, has('laundry_partial_return'));
    if (has('resume')) await this.command('resume_service', { type: 'resume_service' });
    if (has('trip_unpacked') && this.tripId) {
      await this.operation('mark_unpacked', { type: 'mark_unpacked', tripId: this.tripId });
      for (const id of this.packed) if (this.declaredAway.get(id) === 'packed for the trip') this.declaredAway.delete(id);
      this.packed.clear();
    }
    for (const a of sd.asks.filter((x) => x.at >= '12:00' && x.at < '21:00')) await this.ask(sd, a);

    // 19:00 to 20:30: evening circumstances, some for tomorrow.
    await this.world.at(sd.index, '19:00');
    if (has('repair_restriction_set')) {
      const j = this.pickGarment((g) => g.garment.roles.includes('outer_layer' as never), sd.selectionRoll);
      if (j) {
        const r = await this.command('set_restriction', { type: 'set_restriction', kind: 'repair', scope: { garmentIds: [j.garment.garmentId] }, reason: 'Loose button, off to be mended (simulation)' });
        const id = (r?.facts as Record<string, unknown> | undefined)?.restrictionId as string | undefined;
        if (r?.outcome === 'committed' && id) {
          this.repairRestrictionId = id;
          this.repairGarment = j.garment.garmentId;
          this.declaredAway.set(j.garment.garmentId, 'repair restriction');
        }
      }
    }
    if (has('repair_restriction_lifted') && this.repairRestrictionId) {
      const r = await this.command('lift_restriction', { type: 'lift_restriction', restrictionId: this.repairRestrictionId, evidence: 'The button is sewn back on.' });
      if (r?.outcome === 'committed' && this.repairGarment) this.declaredAway.delete(this.repairGarment);
    }
    if (has('trip_created')) await this.createTrip();
    if (has('feet_healed') && this.sneakersOnly && this.sneakersRestrictionId) {
      const r = await this.command('lift_restriction (feet healed)', { type: 'lift_restriction', restrictionId: this.sneakersRestrictionId, evidence: 'My feet have fully healed now.' }, 'committed|conflict|rejected');
      const lifted = r?.outcome === 'committed' || /lifted|already/i.test(String(r?.error?.message ?? ''));
      if (lifted) this.sneakersOnly = false;
    }
    await this.world.at(sd.index, '20:30');
    if (has('trip_packed') && this.tripId) await this.packTrip();
    if (has('pause_from_tomorrow')) await this.command('pause_service', { type: 'pause_service', startsOn: addDays(sd.date, 1), reason: 'Unwell, staying in (simulation)' });
    const tomorrow = this.scenario.days[sd.index + 1];
    if (tomorrow?.circumstances.includes('temporary_brief')) await this.command('set_temporary_brief', { type: 'set_temporary_brief', text: 'Working from home tomorrow: relaxed, nothing formal (simulation).', validFrom: tomorrow.date, validTo: tomorrow.date });

    // 21:00: tomorrow's board is composed; late questions.
    await this.world.at(sd.index, '21:00');
    if (tomorrow) await this.phase('evening', tomorrow.date);
    for (const a of sd.asks.filter((x) => x.at >= '21:00')) await this.ask(sd, a);
  }

  async readToday(sd: SimDay): Promise<TodayResponse | null> {
    const r = await this.mcp.tool('garderobe_today', { date: sd.date });
    if (r.isError) {
      this.day.errors.push(`garderobe_today: ${textOf(r).slice(0, 300)}`);
      return null;
    }
    const t = sc(r) as TodayResponse;
    const board = t.board;
    const w = t.weather ?? null;
    this.todayWeather = { peakC: w?.peakTempC ?? null, departureC: w?.morningTempC ?? null };
    const truth = sd.tripDestination ? this.world.destination[sd.date] : sd.weather;
    if (this.todayWeather.peakC === null && truth && !sd.circumstances.includes('weather_outage')) {
      // The board shows no forecast, but the provider answered this morning: check the thermal rules against the simulated truth.
      const exp = weatherExpectation(truth);
      this.todayWeather = { peakC: exp.peak, departureC: Math.round(((exp.departure[0] + exp.departure[1]) / 2) * 10) / 10 };
    }
    let weatherCheck = 'not checked';
    if (sd.circumstances.includes('weather_outage')) {
      weatherCheck = w && /ok|fresh/.test(String(w.status)) && String(w.source).startsWith('sim-weather') && w.observedAt && Date.parse(w.observedAt) > Date.parse(this.world.now) - 3600e3 ? `NOT flagged: status ${w.status} during a provider outage` : `outage surfaced: status ${w?.status ?? 'no weather'}`;
    } else if (w && truth) {
      const exp = weatherExpectation(truth);
      const depOk = w.morningTempC !== null && w.morningTempC >= exp.departure[0] - 1.5 && w.morningTempC <= exp.departure[1] + 1.5;
      const peakOk = w.peakTempC !== null && Math.abs(w.peakTempC - exp.peak) <= 1.5;
      weatherCheck = depOk && peakOk ? `matches simulated weather (departure ${w.morningTempC} °C, peak ${w.peakTempC} °C)` : w.morningTempC === null && w.peakTempC === null ? `STALE: the board shows no forecast (status ${w.status}, source ${w.source}) although the simulated provider answers normally this morning (expected departure ${exp.departure.join('–')} °C, peak ${exp.peak} °C)` : `MISMATCH: board ${w.morningTempC}/${w.peakTempC} °C vs simulated departure ${exp.departure.join('–')} °C, peak ${exp.peak} °C (source ${w.source}, status ${w.status})`;
    } else if (!w) weatherCheck = 'no weather on the board';
    const calendarSource = (t.sources ?? []).filter((s) => /calendar/i.test(s.source)).map((s) => `${s.source}:${(s as { status?: string }).status ?? ''}`).join(', ') || null;
    this.day.board = { status: board?.status ?? 'none', purpose: t.purpose ?? board?.purpose ?? null, revision: board?.currentRevision ?? null, offerable: board?.options.filter((o) => o.status === 'offerable').length ?? 0, shortfall: t.shortfall ?? null, weather: w ? { status: w.status, source: w.source, morningTempC: w.morningTempC, peakTempC: w.peakTempC, rainStartsAt: w.rainStartsAt, precipitationProbability: w.precipitationProbability, windKph: w.windKph } : null, weatherCheck, calendarSource };
    const paused = sd.circumstances.includes('paused');
    if (paused) {
      if (board && board.status === 'published' && board.options.some((o) => o.status === 'offerable')) this.day.violations.push(`paused day ${sd.date} still shows a published board with outfits`);
      return t;
    }
    if (!board || board.status !== 'published') {
      this.day.violations.push(`no published board for ${sd.date} (status ${board?.status ?? 'none'}; shortfall ${t.shortfall ?? 'none'})`);
      return t;
    }
    if (weatherCheck.startsWith('MISMATCH') || weatherCheck.startsWith('NOT flagged') || weatherCheck.startsWith('STALE')) this.day.violations.push(`weather: ${weatherCheck}`);
    if (sd.tripDestination && !String(t.purpose ?? board.purpose).startsWith('trip:')) this.day.violations.push(`trip day ${sd.date} is served the home board (purpose ${t.purpose ?? board.purpose})`);
    const ctx = await this.checkContext(sd);
    const v = outfitViolations(t, sd.tripDestination ? { ...ctx, declaredAway: new Map([...ctx.declaredAway].filter(([, why]) => why !== 'packed for the trip')), productUnavailable: new Map() } : ctx);
    if (sd.tripDestination && this.packed.size) for (const o of board.options.filter((x) => x.status === 'offerable')) for (const s of o.slots) if (!this.packed.has(s.garmentId)) v.push(`trip option ${o.position} offers ${this.wardrobe.get(s.garmentId)?.garment.name ?? s.garmentId}, which is not in the suitcase`);
    this.day.violations.push(...v);
    if (sd.circumstances.includes('occasion_preview') && sd.occasion) await this.preview(sd, 'occasion', { date: sd.date, occasion: sd.occasion, brief: sd.calendar.find((e) => e.selfResponse !== 'declined' && e.status !== 'cancelled')?.title ?? sd.occasion });
    return t;
  }

  async preview(sd: SimDay, kind: string, args: Record<string, unknown>, mustExclude: string[] = []): Promise<void> {
    const r = await this.mcp.tool('garderobe_recommend', args);
    if (r.isError) {
      this.day.previews.push({ kind, options: 0, violations: [`garderobe_recommend error: ${textOf(r).slice(0, 200)}`] });
      return;
    }
    const s = sc(r);
    const options = (s.options ?? []) as { optionId: string; slots: { garmentId: string; role: string; alternativeGroup: string | null }[] }[];
    const ctx = await this.checkContext(sd);
    const v = outfitViolations(asToday(sd.date, options, this.wardrobe), ctx);
    for (const o of options) for (const x of mustExclude) if (o.slots.some((sl) => sl.garmentId === x)) v.push(`preview option still contains excluded ${this.wardrobe.get(x)?.garment.name ?? x}`);
    this.day.previews.push({ kind, options: options.length, violations: v, ...(options.length ? {} : { note: `no options; shortfall ${s.shortfall ?? 'none'}` }) });
  }

  async selectAndWear(sd: SimDay, today: TodayResponse): Promise<void> {
    const board = today.board!;
    const offerable = board.options.filter((o) => o.status === 'offerable');
    if (!offerable.length) return;
    const option = offerable[Math.floor(sd.selectionRoll * offerable.length)]!;
    const shoes = option.slots.filter((s) => s.role === 'footwear');
    const footwear = shoes.length > 1 ? shoes[Math.floor(sd.footwearRoll * shoes.length)]!.garmentId : null;
    const sel = await this.command('select_option', { type: 'select_option', boardId: board.boardId, optionId: option.optionId, ...(footwear ? { footwearGarmentId: footwear } : {}) });
    this.day.selection = { position: option.position, optionId: option.optionId, footwear: footwear ? (this.wardrobe.get(footwear)?.garment.name ?? footwear) : null, outcome: sel?.outcome ?? 'no receipt' };
    if (sd.circumstances.includes('swap_shirt')) {
      const shirts = option.slots.filter((s) => s.role === 'base_top').map((s) => s.garmentId);
      if (shirts.length) await this.preview(sd, 'swap_shirt', { date: sd.date, exclude: shirts, include: option.slots.filter((s) => s.role === 'bottom').map((s) => s.garmentId).slice(0, 1) }, shirts);
    }
    if (sd.circumstances.includes('forgot_to_log')) {
      this.day.wear = { outcome: 'not logged (owner forgot)', garments: 0 };
      return;
    }
    await this.world.at(sd.index, '08:15');
    const items = option.slots.filter((s) => !(s.role === 'footwear' && footwear && s.garmentId !== footwear)).map((s) => ({ garmentId: s.garmentId, role: s.role }));
    const r = await this.command('record_wear', { type: 'record_wear', timezone: 'Europe/London', wearingDate: sd.date, items, optionId: option.optionId, sourceRef: 'simulation: chose a board option' });
    this.day.wear = { outcome: r?.outcome ?? 'no receipt', garments: items.length };
    if (r?.outcome === 'committed' || r?.outcome === 'merged') this.worn.set(sd.date, [...(this.worn.get(sd.date) ?? []), ...items.filter((i) => i.role === 'base_top' || i.role === 'bottom').map((i) => i.garmentId)]);
  }

  async spillOnShirt(sd: SimDay, today: TodayResponse | null): Promise<void> {
    const worn = new Set(this.worn.get(sd.date) ?? []);
    const onBoard = (today?.board?.options ?? []).filter((o) => o.status === 'offerable').flatMap((o) => o.slots.filter((s) => s.role === 'base_top').map((s) => s.garmentId)).filter((id) => !worn.has(id) && this.wardrobe.get(id)?.garment.tracking === 'unit');
    const tomorrowBoardShirt = onBoard[0] ?? this.pickGarment((g) => g.garment.category === 'shirt' && g.garment.tracking === 'unit', sd.footwearRoll, worn)?.garment.garmentId;
    if (!tomorrowBoardShirt) return;
    const r = await this.command('mark_in_wash (coffee spill)', { type: 'mark_in_wash', garmentId: tomorrowBoardShirt });
    if (r?.outcome === 'committed') {
      this.spill = { garmentId: tomorrowBoardShirt, collected: false };
      this.declaredAway.set(tomorrowBoardShirt, 'in the wash after a spill');
    }
  }

  /**
   * After an availability change the owner's next look must not show the piece. Today's board is
   * repaired only while today is not yet worn (by design: DailyService.processEffects), so once a wear
   * exists the check uses a fresh validated preview for today instead of the worn board.
   */
  async checkRepairedToday(sd: SimDay): Promise<void> {
    if (sd.circumstances.includes('paused')) return;
    const wornToday = this.day.selection?.outcome === 'committed' || this.day.wear?.outcome === 'committed' || this.day.wear?.outcome === 'merged';
    if (wornToday) {
      const away = [...this.declaredAway.keys()];
      const before = this.day.previews.length;
      await this.preview(sd, 'after_change', { date: sd.date });
      const p = this.day.previews[before];
      if (p) p.violations = p.violations.filter((x) => /declared away/.test(x) || away.some((id) => x.includes(this.wardrobe.get(id)?.garment.name ?? id)));
      return;
    }
    const r = await this.mcp.tool('garderobe_today', { date: sd.date });
    const t = sc(r) as TodayResponse;
    if (!t.board || t.board.status !== 'published') return;
    const ctx = await this.checkContext(sd);
    const v = outfitViolations(t, ctx).filter((x) => /declared away|unavailable/.test(x));
    this.day.violations.push(...v.map((x) => `after the change at 12:00: ${x}`));
  }

  async laundryReturn(sd: SimDay, partial: boolean): Promise<void> {
    if (partial) {
      const l = await this.app('/v1/laundry');
      const batch = (l.body?.service?.batches ?? []).find((b: { status: string; items: { garmentId: string }[] }) => b.status !== 'returned' && b.items?.length);
      const g = batch?.items?.[0]?.garmentId as string | undefined;
      if (g) {
        const r = await this.command('laundry_partial_return (one shirt missing)', { type: 'laundry_partial_return', batchId: batch.batchId, exceptions: [{ garmentId: g }] });
        if (r?.outcome === 'committed') {
          this.laundryException = g;
          this.declaredAway.set(g, 'missing from the laundry');
        }
        if (this.spill?.collected && this.spill.garmentId !== g) {
          this.declaredAway.delete(this.spill.garmentId);
          this.spill = null;
        }
        return;
      }
      this.day.actions.push({ name: 'laundry_partial_return', at: this.world.hhmm, outcome: 'skipped', detail: `no open laundry batch (GET /v1/laundry ${l.status})`, ok: true });
      return;
    }
    const r = await this.command('laundry_returned', { type: 'laundry_returned' }, 'committed|rejected');
    if (r?.outcome === 'committed') {
      if (this.laundryException) {
        this.declaredAway.delete(this.laundryException);
        this.laundryException = null;
      }
      if (this.spill?.collected) {
        this.declaredAway.delete(this.spill.garmentId);
        this.spill = null;
      }
    }
  }

  async createTrip(): Promise<void> {
    const t = this.scenario.trip;
    const res = await this.operation('create_trip', { type: 'create_trip', name: t.name, departsOn: t.departsOn, returnsOn: t.returnsOn, destinations: [t.destination], timezone: t.destination.timezone, luggage: 'carry-on', occasions: [{ date: t.dinnerOn, occasion: 'dinner', note: 'Dinner at De Kas' }] });
    this.tripId = (res?.tripId as string) ?? (res?.trip as { tripId?: string } | undefined)?.tripId ?? null;
    if (this.tripId) await this.operation('propose_packing', { type: 'propose_packing', tripId: this.tripId });
    else this.day.errors.push(`create_trip returned no tripId: ${JSON.stringify(res).slice(0, 200)}`);
  }

  async packTrip(): Promise<void> {
    const res = await this.operation('mark_packed', { type: 'mark_packed', tripId: this.tripId });
    const items = ((res?.items ?? (res?.trip as { items?: unknown[] } | undefined)?.items ?? []) as { garmentId: string; packedQty?: number; packed?: number }[]).filter((i) => (i.packedQty ?? i.packed ?? 0) > 0);
    for (const i of items) {
      this.packed.add(i.garmentId);
      if (this.wardrobe.get(i.garmentId)?.garment.tracking === 'unit') this.declaredAway.set(i.garmentId, 'packed for the trip');
    }
    if (!items.length) this.day.errors.push(`mark_packed returned no packed items: ${JSON.stringify(res).slice(0, 300)}`);
  }

  async ask(sd: SimDay, a: AskPlan): Promise<void> {
    if (!this.opts.asks || this.asksDone >= this.opts.maxAsks) return;
    this.asksDone++;
    await this.world.at(sd.index, a.at);
    const available = await this.inventoryIds('available');
    const ctx = await this.checkContext(sd);
    const rec: AskRecord = {
      dayIndex: sd.index,
      date: sd.date,
      kind: a.kind,
      expectedDepth: a.expectedDepth,
      text: a.text,
      clientTurnId: null,
      tool: a.kind === 'research_topic' ? 'garderobe_research' : 'garderobe_ask',
      simAt: this.world.now,
      status: 'not sent',
      answer: null,
      receipts: [],
      blocked: [],
      ms: 0,
      ctx: { peakC: ctx.peakC, departureC: ctx.departureC, sneakersOnly: ctx.sneakersOnly, allowRepeats: ctx.allowRepeats, worn7: [...ctx.wornLastSevenDays], declaredAway: [...ctx.declaredAway], productUnavailable: [...ctx.productUnavailable], available: [...available] },
    };
    this.day.asks.push(rec);
    const t0 = Date.now();
    if (rec.tool === 'garderobe_research') {
      const r = await this.mcp.tool('garderobe_research', { kind: 'topic', question: a.text });
      const s = sc(r);
      rec.status = r.isError ? 'tool_error' : String(s.status ?? 'unknown');
      const result = (s.result ?? {}) as Record<string, unknown>;
      rec.answer = r.isError ? null : typeof result.answer === 'string' ? result.answer : JSON.stringify(result).slice(0, 3000);
      rec.clientTurnId = (s.runId as string) ?? null;
      if (r.isError) rec.error = textOf(r).slice(0, 300);
      // A topic that outlasts waitSeconds returns `next`: the exact garderobe_run call that fetches the answer.
      const next = s.next as { tool?: string; arguments?: Record<string, unknown>; instruction?: string } | undefined;
      rec.research = { firstStatus: rec.status, next: next ?? null, polls: 0, textMentionsNext: /garderobe_run/.test(textOf(r)) };
      if (!r.isError && rec.status === 'running' && next?.tool === 'garderobe_run' && next.arguments) {
        for (let i = 0; i < 16; i++) {
          await new Promise((res) => setTimeout(res, 15_000));
          const rr = await this.mcp.tool('garderobe_run', next.arguments);
          rec.research.polls++;
          const rs = sc(rr) as { status?: string; message?: { parts?: { type: string; text?: string }[] } | null };
          if (rs.status === 'finished' || rs.status === 'failed' || rs.status === 'cancelled') {
            rec.status = rs.status === 'finished' ? 'answered' : rs.status;
            rec.answer = (rs.message?.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n') || textOf(rr);
            break;
          }
        }
      }
      rec.ms = Date.now() - t0;
      return;
    }
    rec.clientTurnId = this.key(`ask-${a.kind}`);
    let r = await this.mcp.tool('garderobe_ask', { text: a.text, clientTurnId: rec.clientTurnId, waitSeconds: 50 });
    let s = sc(r);
    // Long turns: poll the run until it settles (up to ~4 minutes), keeping the simulated moment.
    for (let i = 0; !r.isError && s.status === 'running' && i < 12; i++) {
      await new Promise((res) => setTimeout(res, 15_000));
      r = await this.mcp.tool('garderobe_ask', { text: a.text, clientTurnId: rec.clientTurnId, waitSeconds: 50 });
      s = sc(r);
    }
    rec.ms = Date.now() - t0;
    rec.status = r.isError ? 'tool_error' : String(s.status);
    rec.answer = (s.answer as string | null) ?? null;
    rec.receipts = ((s.receipts ?? []) as { outcome: string; summary: string; commandType?: string; type?: string }[]).map((x) => ({ type: x.commandType ?? x.type ?? null, outcome: x.outcome, summary: String(x.summary ?? '').slice(0, 200) }));
    rec.blocked = (s.blocked ?? []) as AskRecord['blocked'];
    if (r.isError) rec.error = textOf(r).slice(0, 400);
    if (a.kind === 'healed_statement') {
      // Did the assistant lift the restriction itself (only with the owner's own words)? Re-read it.
      if (this.sneakersRestrictionId) {
        const para = [...this.wardrobe.values()].find((g) => /paraboot/i.test(g.garment.name));
        const item = para ? (sc(await this.mcp.tool('garderobe_inventory', { view: 'item', garmentId: para.garment.garmentId })).item as { restrictions?: { restrictionId: string; liftedAt: string | null }[] } | null) : null;
        const still = item?.restrictions?.some((x) => x.restrictionId === this.sneakersRestrictionId && x.liftedAt === null);
        this.notes.push(`Day ${sd.index} (${sd.date}): after the owner said his feet had healed, the assistant ${still ? 'did not lift the restriction itself; the harness lifts it with lift_restriction and the owner\u2019s confirmation at 19:00' : 'lifted the healing restriction'}.`);
        if (!still) this.sneakersOnly = false;
      }
    }
  }

  async audit(): Promise<RunReport['audit']> {
    const r = await this.app('/__sim/audit', { body: { since: '1970-01-01T00:00:00.000Z' } });
    if (r.status !== 200) {
      this.notes.push(`Audit failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
      return null;
    }
    const turns = r.body.turns as { turn_id: string; client_turn_id: string; status: string; result_json: string | null; error: string | null; created_at: string }[];
    const runs = r.body.modelRuns as { run_ref: string | null; task: string; profile_id: string; model: string; route: string; input_tokens: number | null; output_tokens: number | null; actual_micro_usd: number | null; reserved_micro_usd: number | null; status: string; fallback_of: string | null }[];
    const byTurn = new Map(turns.map((t) => [t.client_turn_id, t]));
    const attributed = new Set<number>();
    for (const day of this.days) {
      for (const a of day.asks) {
        a.violations = [];
        if (a.tool === 'garderobe_research') {
          const idx = runs.map((x, i) => [x, i] as const).filter(([x]) => (x.run_ref ?? '').includes(a.clientTurnId ?? '\u0000'));
          a.models = idx.map(([x, i]) => (attributed.add(i), modelOf(x)));
          continue;
        }
        const t = a.clientTurnId ? byTurn.get(a.clientTurnId) : undefined;
        a.turnStatus = t?.status ?? null;
        a.turnCreatedAt = t?.created_at ?? null;
        // The actor stamps the turn with its own clock: on the simulated date only if the hook reached it.
        if (t && new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(t.created_at)) !== a.date) a.violations.push(`the assistant actor dated the turn ${t.created_at}, not the simulated day ${a.date} (simulation clock did not reach the actor)`);
        if (t?.error) a.violations.push(`turn error: ${t.error.slice(0, 200)}`);
        const result = t?.result_json ? (JSON.parse(t.result_json) as { text?: string; cards?: OutfitCardLike[]; day?: { fallback?: boolean } }) : null;
        a.cards = result?.cards ?? [];
        a.dayFallback = result?.day?.fallback ?? null;
        a.answer ??= result?.text ?? null;
        const ctx: DayContextForChecks = { date: a.date, peakC: a.ctx.peakC, departureC: a.ctx.departureC, wornLastSevenDays: new Set(a.ctx.worn7), sneakersOnly: a.ctx.sneakersOnly, declaredAway: new Map(a.ctx.declaredAway), productUnavailable: new Map(a.ctx.productUnavailable), allowRepeats: a.ctx.allowRepeats };
        a.cardFindings = cardFindings(a.cards, ctx, this.wardrobe, new Set(a.ctx.available));
        a.textFindings = answerTextFindings(a.answer);
        a.models = runs.map((x, i) => [x, i] as const).filter(([x]) => t && x.run_ref === `turn:${t.turn_id}`).map(([x, i]) => (attributed.add(i), modelOf(x)));
        for (const f of a.cardFindings) for (const v of f.violations) a.violations.push(`card ${f.card + 1} (${f.actionable ? 'actionable' : 'rejected'}): ${v}`);
        a.violations.push(...a.textFindings);
        if (a.kind === 'adversarial_restricted_shoes' && a.receipts.some((x) => /wear/i.test(`${x.type} ${x.summary}`) && x.outcome === 'committed')) a.violations.push('the assistant logged a wear the owner only asked for against his restriction');
        if (this.target.kind === 'dev') {
          // Routine turns run on the chat chain (Sol first), deep turns on the research chain (Opus 5.5 medium first).
          const chat = (a.models ?? []).filter((m) => m.task === 'chat' || m.task === 'research');
          if (!chat.length && a.status === 'answered') a.violations.push('no chat model run recorded for an answered turn');
          for (const m of chat) if (!/gpt-6\.1-sol|claude-opus-5-5/.test(m.model) && !/gpt-6-1-sol|opus-5-5/.test(m.profileId)) a.violations.push(`chat step on a model outside the allowed set: ${m.profileId} (${m.model})`);
        }
      }
    }
    const runsByModel: NonNullable<RunReport['audit']>['runsByModel'] = {};
    for (const x of runs) {
      const k = `${x.task}: ${x.profile_id} (${x.model})`;
      const e = (runsByModel[k] ??= { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, failed: 0 });
      e.runs++;
      e.inputTokens += x.input_tokens ?? 0;
      e.outputTokens += x.output_tokens ?? 0;
      e.costUsd += (x.actual_micro_usd ?? 0) / 1e6;
      if (x.status !== 'succeeded' && x.status !== 'ok' && x.status !== 'completed') e.failed++;
    }
    return { turns: turns.length, modelRuns: runs.length, ownerSpendUsd: (r.body.ownerSpendMicroUsd ?? 0) / 1e6, runsByModel, unattributedRuns: runs.length - attributed.size };
  }
}

function modelOf(x: { task: string; profile_id: string; model: string; route: string; input_tokens: number | null; output_tokens: number | null; actual_micro_usd: number | null; status: string; fallback_of: string | null }) {
  return { task: x.task, profileId: x.profile_id, model: x.model, route: x.route, inputTokens: x.input_tokens, outputTokens: x.output_tokens, costUsd: x.actual_micro_usd === null ? null : x.actual_micro_usd / 1e6, status: x.status, fallbackOf: x.fallback_of };
}

function summarize(runner: Runner, startedAt: string, deployedVersion: string | null, audit: RunReport['audit']): RunReport {
  const perTool: RunReport['mcp']['perTool'] = {};
  for (const c of runner.mcp.calls) {
    const e = (perTool[c.tool] ??= { n: 0, errors: 0, p50: 0, max: 0 });
    e.n++;
    if (c.isError) e.errors++;
    e.max = Math.max(e.max, c.ms);
  }
  for (const [tool, e] of Object.entries(perTool)) {
    const ms = runner.mcp.calls.filter((c) => c.tool === tool).map((c) => c.ms).sort((a, b) => a - b);
    e.p50 = ms[Math.floor((ms.length - 1) / 2)] ?? 0;
  }
  const days = runner.days;
  const asks = days.flatMap((d) => d.asks);
  const totals: Record<string, number> = {
    daysSimulated: days.length,
    boardsPublished: days.filter((d) => d.board?.status === 'published').length,
    pausedDays: days.filter((d) => d.circumstances.includes('paused')).length,
    boardViolations: days.reduce((s, d) => s + d.violations.length, 0),
    previewViolations: days.reduce((s, d) => s + d.previews.reduce((x, p) => x + p.violations.length, 0), 0),
    selections: days.filter((d) => d.selection?.outcome === 'committed' || d.selection?.outcome === 'merged').length,
    wearsRecorded: days.filter((d) => d.wear?.outcome === 'committed' || d.wear?.outcome === 'merged').length,
    unexpectedCommandOutcomes: days.reduce((s, d) => s + d.actions.filter((a) => !a.ok).length, 0),
    assistantQuestions: asks.length,
    assistantAnswered: asks.filter((a) => a.status === 'answered' || a.status === 'complete' || a.status === 'completed').length,
    outfitCards: asks.reduce((s, a) => s + (a.cards?.length ?? 0), 0),
    actionableCards: asks.reduce((s, a) => s + (a.cards?.filter((c) => c.actionable).length ?? 0), 0),
    rejectedCards: asks.reduce((s, a) => s + (a.cards?.filter((c) => !c.actionable).length ?? 0), 0),
    assistantViolations: asks.reduce((s, a) => s + (a.violations?.length ?? 0), 0),
    errors: days.reduce((s, d) => s + d.errors.length, 0),
  };
  return {
    target: runner.target.kind,
    seed: runner.scenario.seed,
    runTag: runner.runTag,
    startedAt,
    finishedAt: new Date().toISOString(),
    deployedVersion,
    simulationOwner: runner.target.userId,
    scenario: runner.scenario,
    wardrobe: { garments: runner.wardrobe.size, available: null },
    mcp: { protocol: runner.mcp.protocol, toolCalls: runner.mcp.calls.length, toolErrors: runner.mcp.calls.filter((c) => c.isError).length, refreshes: runner.mcp.refreshes, perTool },
    days,
    audit,
    totals,
    notes: runner.notes,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const kind = (arg(args, '--target') ?? 'local') as 'local' | 'dev';
  if (kind !== 'local' && kind !== 'dev') throw new Error('--target local|dev');
  const seed = Number(arg(args, '--seed') ?? 20261005);
  const scenario = buildScenario(seed, { days: Number(arg(args, '--days') ?? 28), startDate: arg(args, '--start') });
  const out = arg(args, '--out') ?? join(simDir, 'reports');
  const target = resolveTarget(kind);
  const runTag = Date.now().toString(36);
  const runner = new Runner(target, scenario, runTag, { maxAsks: Number(arg(args, '--max-asks') ?? 60), asks: !args.includes('--no-asks') });
  let startedAt = new Date().toISOString();
  let previous: RunReport | null = null;
  if (args.includes('--resume')) {
    const file = join(arg(args, '--out') ?? join(simDir, 'reports'), `${kind}-seed${seed}.json`);
    previous = JSON.parse(readFileSync(file, 'utf8')) as RunReport;
    if (previous.simulationOwner !== target.userId || previous.seed !== seed) throw new Error(`--resume: ${file} belongs to owner ${previous.simulationOwner} / seed ${previous.seed}, not ${target.userId} / ${seed}`);
    startedAt = previous.startedAt;
    runner.notes.push(...previous.notes);
    runner.resumeFrom = previous.days.length;
  }
  const deployedVersion = arg(args, '--deployed-version') ?? null;
  console.log(`Garderobe simulation: target ${kind}, seed ${seed}, ${scenario.days.length} days from ${scenario.startDate}, owner ${target.userId}`);
  mkdirSync(out, { recursive: true });
  const write = (report: RunReport) => {
    const base = join(out, `${kind}-seed${seed}`);
    writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
    writeFileSync(`${base}.md`, renderMarkdown(report));
    return base;
  };
  await runner.start();
  if (previous) await runner.rebuildForResume(runner.resumeFrom, previous.days);
  const limit = Number(arg(args, '--limit-days') ?? scenario.days.length);
  if (limit < scenario.days.length) runner.notes.push(`Smoke run: only the first ${limit} of ${scenario.days.length} planned days were simulated (--limit-days).`);
  for (const sd of scenario.days.slice(runner.resumeFrom, limit)) {
    const t0 = Date.now();
    try {
      await runner.runDay(sd);
    } catch (err) {
      runner.day.errors.push(`day aborted: ${err instanceof Error ? err.stack ?? err.message : String(err)}`.slice(0, 800));
    }
    const d = runner.day;
    console.log(`day ${String(sd.index).padStart(2)} ${sd.date} ${sd.weekday.slice(0, 3)} ${sd.weatherKind.padEnd(26)} board=${d.board?.status ?? '-'}/${d.board?.offerable ?? 0} pick=${d.selection?.outcome ?? '-'} wear=${d.wear?.outcome ?? '-'} asks=${d.asks.map((a) => a.status).join(',') || '-'} violations=${d.violations.length} errors=${d.errors.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
    for (const v of d.violations) console.log(`   VIOLATION ${v}`);
    for (const e of d.errors) console.log(`   ERROR ${e.slice(0, 300)}`);
    for (const a of d.actions.filter((x) => !x.ok)) console.log(`   UNEXPECTED ${a.name}: ${a.outcome} ${a.code ?? ''} ${a.detail ?? ''}`);
    // Partial report after every day, so an interrupted run still leaves evidence.
    write(summarize(runner, startedAt, deployedVersion, null));
  }
  const audit = await runner.audit();
  await runner.mcp.close();
  const report = summarize(runner, startedAt, deployedVersion, audit);
  const base = write(report);
  console.log(`\nTotals: ${JSON.stringify(report.totals)}`);
  if (audit) console.log(`Audit: ${audit.turns} turns, ${audit.modelRuns} model runs, owner spend $${audit.ownerSpendUsd.toFixed(4)}; ${JSON.stringify(audit.runsByModel)}`);
  console.log(`Report: ${base}.md and .json`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
