/**
 * LIVE smoke test of the Open-Meteo adapter (keyless public API). Not part of `npm test`: it needs
 * network access and real weather, so its numbers change daily. Run:
 *   npm run smoke:weather --workspace @garderobe/backend
 * It fetches tomorrow's hourly forecast for the owner's home city and prints the clothing
 * interpretation the daily service would preload (peak, departure, rain, wind, the brief line).
 */
import { OpenMeteoProvider } from '../src/weather/open-meteo.js';
import { interpretDay, resolveLocation } from '../src/weather/skill.js';
import { addDays, localDateOf } from '../src/domain/time.js';

const timezone = 'Europe/London';
const location = resolveLocation('London (Elephant and Castle)')!;
const today = localDateOf(new Date(), timezone);
const date = addDays(today, 1);
const provider = new OpenMeteoProvider();
const snapshot = await provider.forecast({ location, timezone, startDate: today, endDate: addDays(today, 2) });
const day = interpretDay(snapshot, date, timezone, { start: '08:00', end: '19:00', departure: '08:00', eveningOnly: false }, 'fresh', new Date().toISOString());
const s = day.summary;
if (!snapshot.hourly.length || s.peakTempC === null || s.departureTempC === null) {
  console.error('LIVE SMOKE FAILED: no usable hourly data', s.missingFields);
  process.exit(1);
}
console.log(JSON.stringify({ provider: s.provider, attribution: s.attribution, fetchedAt: s.fetchedAt, issuedAt: s.issuedAt, date, hours: snapshot.hourly.length, departureTempC: s.departureTempC, peakTempC: s.peakTempC, rainProbabilityMax: s.rainProbabilityMax, rainAmountMm: s.rainAmountMm, windGustMaxKmh: s.windGustMaxKmh, conditions: s.conditions, missingFields: s.missingFields, line: s.line }, null, 2));
console.log('LIVE SMOKE OK');
