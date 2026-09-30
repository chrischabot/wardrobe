/**
 * The simulated world for one request, shared by the harness (Node) and the Worker-side hook
 * (tests/simulation/worker/sim-hook.ts). The harness signs it with DEV_SIM_SECRET and sends it in the
 * `x-garderobe-sim` header; the hook verifies the signature before it changes anything.
 *
 * Only WebCrypto and JSON are used, so this file runs unchanged in Node 22 and in workerd.
 */

export const SIM_HEADER = 'x-garderobe-sim';
export const SIM_VERSION = 1;

/** One simulated day's weather at one place: a diurnal curve plus rain and wind. */
export interface DayWeather {
  /** Temperature at 05:00 (the curve's low). */
  low: number;
  /** Temperature at 15:00 (the curve's high). */
  high: number;
  /** Optional fixed temperature for 07:00–09:00 (a departure that differs from the curve). */
  departure?: number | null;
  /** Maximum hourly precipitation probability, 0–100. */
  rainProbability: number;
  /** Hourly amount while raining, mm. */
  rainMm: number;
  /** First local hour with that rain (inclusive); null = all day when rainProbability is high. */
  rainFromHour?: number | null;
  windKmh: number;
  gustKmh: number;
  humidity?: number;
}

export interface SimCalendarEvent {
  eventId: string;
  title: string;
  /** UTC instants for timed events. */
  start?: string | null;
  end?: string | null;
  /** Local dates for all-day events (end exclusive). */
  startDate?: string | null;
  endDate?: string | null;
  allDay?: boolean;
  location?: string | null;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  selfResponse?: 'accepted' | 'declined' | 'tentative' | 'needsAction' | null;
}

export interface SimState {
  v: typeof SIM_VERSION;
  /** The simulation owner; the hook only pushes state into this owner's assistant actor. */
  userId: string;
  /** Simulated instant at the moment the harness sent the request (UTC ISO). */
  clock: string;
  /** Weather per local date at home; `byLocation` per trip destination label. */
  weather: { home: Record<string, DayWeather>; byLocation?: Record<string, Record<string, DayWeather>>; fail?: boolean };
  /** The owner's calendar (Google Calendar stand-in); null = not connected. */
  calendar: { events: SimCalendarEvent[]; fail?: boolean } | null;
  /** Changes whenever weather or calendar content changes; names the fake provider so caches never mix scenarios. */
  revision: string;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signSimState(state: SimState, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error('DEV_SIM_SECRET must be at least 32 characters');
  const body = b64url(enc.encode(JSON.stringify(state)));
  return `${body}.${b64url(await hmac(secret, body))}`;
}

/** Returns the state when the signature matches, otherwise null. Constant-time comparison of the MAC. */
export async function verifySimState(header: string, secret: string | undefined): Promise<SimState | null> {
  if (!secret || secret.length < 32) return null;
  const [body, mac] = header.split('.');
  if (!body || !mac) return null;
  const expected = await hmac(secret, body);
  const given = fromB64url(mac);
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given[i]! ^ expected[i]!;
  if (diff !== 0) return null;
  try {
    const state = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SimState;
    if (state.v !== SIM_VERSION || !/^usr_[A-Za-z0-9_-]{4,64}$/.test(state.userId) || Number.isNaN(Date.parse(state.clock))) return null;
    return state;
  } catch {
    return null;
  }
}

/** Hourly conditions of a simulated day (the same curve shape as the product's FakeWeatherProvider `diurnal`). */
export function hourOf(day: DayWeather, hour: number): { temperatureC: number; precipitationProbability: number; precipitationMm: number; precipitationType: 'none' | 'rain'; windKmh: number; gustKmh: number; humidity: number } {
  const h = hour < 5 ? hour + 24 : hour;
  const shape = h <= 15 ? (1 - Math.cos((Math.PI * (h - 5)) / 10)) / 2 : (1 + Math.cos((Math.PI * (h - 15)) / 14)) / 2;
  let t = Math.round((day.low + (day.high - day.low) * shape) * 10) / 10;
  if (day.departure !== null && day.departure !== undefined && hour >= 7 && hour <= 9) t = day.departure;
  const raining = day.rainProbability >= 40 && (day.rainFromHour === null || day.rainFromHour === undefined || hour >= day.rainFromHour);
  return {
    temperatureC: t,
    precipitationProbability: raining ? day.rainProbability : Math.min(day.rainProbability, 10),
    precipitationMm: raining ? day.rainMm : 0,
    precipitationType: raining && day.rainMm > 0 ? 'rain' : 'none',
    windKmh: day.windKmh,
    gustKmh: day.gustKmh,
    humidity: day.humidity ?? (raining ? 92 : 70),
  };
}
