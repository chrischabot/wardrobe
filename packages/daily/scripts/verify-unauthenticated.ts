/**
 * Live contract check of what can be exercised WITHOUT credentials, through the real adapter code and
 * Node's global fetch (nothing is faked):
 *
 *  - Google Calendar v3: every operation the adapter performs (events.list, get, insert, patch, delete) is
 *    sent to the real service with a token that is not a token. Google must answer HTTP 401 on each exact
 *    URL and verb, and the adapter must report "not connected". A wrong path or verb would answer 404 or
 *    405 instead, so this proves the endpoints, verbs and query parameters are accepted as far as
 *    authentication, and that Google's real error body is parsed. Nothing can be written: the calls are
 *    refused before they act.
 *  - Apple WeatherKit: one forecast request signed with a throwaway P-256 key generated in this process.
 *    Apple must answer HTTP 401 and the adapter must raise a non-retryable provider error.
 *
 * It proves nothing about behaviour behind authentication (If-Match, 409 on a reused ID, restore by
 * patch, the WeatherKit response body). Those need a real Google grant and Apple credentials.
 *
 *   cd wardrobe/packages/daily
 *   node --experimental-transform-types scripts/verify-unauthenticated.ts
 */
import { createGoogleCalendar } from "../src/calendar/google.ts";
import { CalendarNotConnectedError, WeatherProviderError } from "../src/ports.ts";
import type { FetchLike, ManagedEventWrite } from "../src/ports.ts";
import { createWeatherKitProvider } from "../src/weather/weatherkit.ts";

const problems: string[] = [];
const check = (ok: boolean, message: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) problems.push(message);
};

const exchanges: { method: string; url: string; status: number; body: unknown }[] = [];
const recordingFetch: FetchLike = async (input, init) => {
  const response = await fetch(input, init);
  let body: unknown = null;
  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }
  exchanges.push({ method: init?.method ?? "GET", url: input, status: response.status, body });
  return response;
};

console.log(`Unauthenticated live verification, run at ${new Date().toISOString()}`);

/* ------------------------------ Google Calendar ------------------------ */
console.log("\nGoogle Calendar v3, with a value that is not an access token");
const calendar = createGoogleCalendar({ fetch: recordingFetch, getAccessToken: async () => "not-a-token-contract-check" });
const CALENDAR = "primary";
const EVENT = "garderobecontractcheck00000"; // base32hex characters only; never created
const write: ManagedEventWrite = {
  summary: "contract check (never created)",
  description: "contract check",
  privateProperties: { garderobeRevision: "0" },
  time: { kind: "timed", startsAt: "2030-01-01T07:00:00Z", endsAt: "2030-01-01T07:15:00Z", timezone: "Europe/London" },
  reminderMinutesBefore: null,
};
const operations: [string, string, () => Promise<unknown>][] = [
  ["events.list", "GET", () => calendar.listEvents("contract-check", { calendarIds: [CALENDAR], timeMin: "2030-01-01T00:00:00Z", timeMax: "2030-01-02T00:00:00Z", timezone: "Europe/London" })],
  ["events.get", "GET", () => calendar.getEvent("contract-check", CALENDAR, EVENT)],
  ["events.insert", "POST", () => calendar.insertEvent("contract-check", CALENDAR, EVENT, write)],
  ["events.patch", "PATCH", () => calendar.patchEvent("contract-check", CALENDAR, EVENT, write, '"etag-contract-check"')],
  ["events.delete", "DELETE", () => calendar.deleteEvent("contract-check", CALENDAR, EVENT)],
];
for (const [name, verb, run] of operations) {
  const before = exchanges.length;
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  const exchange = exchanges[before];
  if (!exchange) {
    check(false, `${name}: no request reached the service (${thrown instanceof Error ? thrown.message : String(thrown)})`);
    continue;
  }
  const error = (exchange.body as { error?: { code?: unknown; status?: unknown; errors?: { reason?: unknown }[] } } | null)?.error;
  console.log(`  ${exchange.method} ${exchange.url.replace(/\?.*$/, "")} -> HTTP ${exchange.status} status=${String(error?.status)} reason=${String(error?.errors?.[0]?.reason)}`);
  check(exchange.method === verb, `${name}: sent as ${verb}`);
  check(exchange.status === 401, `${name}: the real endpoint answers HTTP 401 to an invalid token (a wrong path or verb would answer 404 or 405)`);
  check(thrown instanceof CalendarNotConnectedError, `${name}: the adapter reports "not connected" (${thrown instanceof Error ? thrown.name : "no error"})`);
  check(thrown instanceof Error && !thrown.message.includes("not-a-token"), `${name}: the error message does not contain the token`);
  check(error?.code === 401 && typeof error?.status === "string", `${name}: error body has the documented shape { error: { code, status, errors[] } }`);
}

/* -------------------------------- WeatherKit --------------------------- */
console.log("\nApple WeatherKit, with a developer token signed by a throwaway key");
try {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const provider = createWeatherKitProvider({ fetch: recordingFetch, credentials: { teamId: "CONTRACT00", serviceId: "example.contract.check", keyId: "CONTRACT00", privateKeyPkcs8Pem: pem } });
  const before = exchanges.length;
  let thrown: unknown = null;
  try {
    await provider.forecast({ latitude: 51.5, longitude: -0.1, timezone: "Europe/London", startDate: "2030-01-01", endDate: "2030-01-01" });
  } catch (error) {
    thrown = error;
  }
  const exchange = exchanges[before];
  if (!exchange) check(false, `no request reached the service (${thrown instanceof Error ? thrown.message : String(thrown)})`);
  else {
    console.log(`  GET ${exchange.url.replace(/\?.*$/, "")} -> HTTP ${exchange.status} ${JSON.stringify(exchange.body)}`);
    check(exchange.status === 401, "the real endpoint answers HTTP 401 to a token Apple did not issue a key for");
    check(thrown instanceof WeatherProviderError && thrown.detail.status === 401 && thrown.detail.retryable === false, `the adapter raises a non-retryable provider error (${thrown instanceof Error ? thrown.message : "no error"})`);
  }
} catch (error) {
  check(false, `WeatherKit check failed to run: ${error instanceof Error ? error.message : String(error)}`);
}

if (problems.length > 0) {
  console.log(`\nRESULT: FAILED, ${problems.length} problem(s).`);
  process.exit(1);
}
console.log("\nRESULT: OK. Endpoints, verbs and the unauthenticated error contracts match the adapters. Behaviour behind authentication is NOT covered.");
