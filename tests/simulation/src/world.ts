/**
 * The simulated world as the Worker sees it at one moment: the harness moves the clock through each
 * simulated day and signs a fresh SimState for every request.
 */
import { addDays, destinationWeather, londonInstant, type Scenario } from './scenario.js';
import { sha256Hex, signSimState, SIM_VERSION, type DayWeather, type SimCalendarEvent, type SimState } from './sim-state.js';

export class World {
  private state: SimState | null = null;
  private anchor: { clock: number; real: number } = { clock: 0, real: 0 };
  readonly destination: Record<string, DayWeather>;
  dayIndex = -1;
  hhmm = '21:00';

  constructor(
    private readonly scenario: Scenario,
    private readonly userId: string,
    private readonly secret: string,
  ) {
    this.destination = destinationWeather(scenario);
  }

  /** Local date of the current simulated moment. */
  get date(): string {
    return this.dayIndex < 0 ? addDays(this.scenario.startDate, -1) : this.scenario.days[this.dayIndex]!.date;
  }

  get now(): string {
    return londonInstant(this.date, this.hhmm);
  }

  /** Moves the simulated clock to `hhmm` London time on day `index` (-1 = the evening before day 0). */
  async at(index: number, hhmm: string): Promise<void> {
    this.dayIndex = index;
    this.hhmm = hhmm;
    const today = this.date;
    const home: Record<string, DayWeather> = {};
    const events: SimCalendarEvent[] = [];
    for (let d = addDays(today, -1); d <= addDays(today, 3); d = addDays(d, 1)) {
      const day = this.scenario.days.find((x) => x.date === d);
      if (!day) continue;
      // Past and current days: what happened. Future days: the forecast as it stood the evening before.
      home[d] = d > today ? day.eveningForecast : day.weather;
      events.push(...day.calendar);
    }
    const current = this.scenario.days[index];
    const weather = { home, byLocation: { [this.scenario.trip.destination.label]: this.destination }, fail: Boolean(current?.circumstances.includes('weather_outage') && hhmm >= '06:00') };
    const calendar = { events, fail: Boolean(current?.circumstances.includes('calendar_outage') && hhmm >= '06:00') };
    const revision = (await sha256Hex(JSON.stringify({ weather, calendar }))).slice(0, 16);
    this.state = { v: SIM_VERSION, userId: this.userId, clock: this.now, weather, calendar, revision };
    this.anchor = { clock: Date.parse(this.now), real: Date.now() };
  }

  /** The simulated instant right now (the anchor plus real time elapsed since `at()`). */
  get clock(): string {
    return new Date(this.anchor.clock + (Date.now() - this.anchor.real)).toISOString();
  }

  get revision(): string {
    return this.state?.revision ?? 'none';
  }

  /**
   * The signed header for a request sent now. The clock in the header advances with real elapsed
   * time since `at()`, so a long request sequence at one simulated moment still moves forward.
   */
  async header(): Promise<string> {
    if (!this.state) await this.at(-1, '21:00');
    return signSimState({ ...this.state!, clock: this.clock }, this.secret);
  }
}
