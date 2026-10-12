import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  cleanGarment,
  connectMcp,
  count,
  createWorld,
  defect,
  fingerprint,
  ownerDay,
  sleep,
  sql,
  submit,
  syntheticOwner,
  toolResult,
  type ApiClient,
  type ApiErrorBody,
  type McpConnection,
  type TestOwner,
  type World,
} from "../src/harness.ts";
import { protocolRefusal } from "../src/connected-helpers.ts";

/*
 * THREAT CLASS 4: time zones, daylight-saving nights, and late or conflicting reports.
 *
 * Real Worker, real D1, real MCP server. `real` is the owner's imported profile and inventory (Europe/London);
 * `synthetic` is the LABELLED SYNTHETIC second owner; `traveller` is another LABELLED SYNTHETIC owner whose
 * home timezone the tests move (Pacific/Kiritimati, Pacific/Pago_Pago, Asia/Kathmandu) through the ordinary
 * `settings.update` command. Every garment created here is `isSynthetic: true` and named SYNTHETIC.
 *
 * Expected local days and instants are computed here with `Intl` (never with the product's own helpers), and
 * the days named to the Worker come from `ownerDay`, never from the UTC date.
 *
 * Specification: section 5 ("One counted wear per garment and wearing date", "Owner observations and
 * accounting repair", "Quantity and laundry"), section 8 ("A command is a verified change", "Repair after
 * reality changes"), section 17 rows "Wear correction" and "Quantities"; the contract of 2026-10-05
 * (.cadence/contract-2026-10-05.md), which removed the connected assistant's seven-day report window: an
 * observation from a connected assistant is recorded at once whatever its date.
 */

interface Outcome {
  status: number;
  receipt: any;
  error: ApiErrorBody | null;
}

let world: World;
let traveller: TestOwner;
let syntheticMcp: McpConnection;
let travellerMcp: McpConnection;

const NOTE = "synthetic test fixture - not the owner's wardrobe";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const uid = (label: string): string => `adv04-${label}-${crypto.randomUUID()}`;

/** The civil date in a timezone, computed independently of the product (Intl, en-CA gives YYYY-MM-DD). */
const dayIn = (timezone: string, ms: number = Date.now()): string => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** The wall-clock reading `YYYY-MM-DD HH:MM` of an instant in a timezone (independent of the product). */
function wallClock(timezone: string, ms: number): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** Every instant at which the timezone's wall clock reads `date time` (two on a fall-back night, none in a gap). */
function instantsOf(timezone: string, date: string, time: string): number[] {
  const naive = Date.parse(`${date}T${time}:00Z`);
  const found: number[] = [];
  for (let quarter = -15 * 4; quarter <= 15 * 4; quarter++) {
    const candidate = naive - quarter * 15 * 60_000;
    if (wallClock(timezone, candidate) === `${date} ${time}`) found.push(candidate);
  }
  return found.sort((a, b) => a - b);
}

async function send(api: ApiClient, type: string, payload: Record<string, unknown>, opts: { idempotencyKey?: string; expectedVersions?: Record<string, number>; occurredAt?: string } = {}): Promise<Outcome> {
  const response = await api.command(type, payload, opts);
  const body = (await response.json()) as any;
  return response.ok ? { status: response.status, receipt: body, error: null } : { status: response.status, receipt: null, error: body.error };
}

/** A raw envelope, for values the typed client would not let through. */
async function raw(owner: TestOwner, envelope: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await owner.api.post("/v1/commands", { idempotencyKey: uid("raw"), expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios" }, ...envelope });
  return { status: response.status, body: (await response.json()) as any };
}

async function viaMcp(mcp: McpConnection, type: string, payload: Record<string, unknown>, opts: { idempotencyKey?: string; occurredAt?: unknown } = {}): Promise<{ receipt: any; error: ApiErrorBody | null; threw: string | null }> {
  const args = { type, payload, idempotencyKey: opts.idempotencyKey ?? uid("mcp"), ...(opts.occurredAt !== undefined ? { occurredAt: opts.occurredAt } : {}) };
  try {
    const called = (await mcp.client.callTool({ name: "garderobe_command", arguments: args })) as { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: unknown };
    const text = called.content?.find((c) => c.type === "text")?.text ?? "";
    // The MCP SDK's own input-schema refusal, recognised by its exact form ("MCP error -32602: Input validation error:
    // Invalid arguments for tool <name>"): a plain-text tool error before any handler ran. Any other plain-text tool error
    // is not a schema refusal and fails the caller's expectation.
    if (called.isError && !text.trimStart().startsWith("{")) {
      if (/^(MCP error -32602: )?Input validation error: Invalid arguments for tool garderobe_command/.test(text.trimStart())) return { receipt: null, error: null, threw: text };
      throw new Error(`garderobe_command answered a plain-text tool error that is not the input-schema refusal: ${text.slice(0, 200)}`);
    }
    const result = toolResult(called);
    return result.ok ? { receipt: result.data.receipt, error: null, threw: null } : { receipt: null, error: result.error as ApiErrorBody, threw: null };
  } catch (error) {
    // Only the MCP server's own refusal (a JSON-RPC error answer) stands for a schema refusal; anything else fails the test.
    const refusal = protocolRefusal(error);
    if (refusal) return { receipt: null, error: null, threw: refusal.message };
    throw error;
  }
}

async function make(owner: TestOwner, garmentId: string, opts: { care?: "service" | "handwash" | "none"; quantity?: number } = {}): Promise<void> {
  const care = opts.care ?? "service";
  const created = await submit(owner, "garment.create", {
    garmentId,
    name: `SYNTHETIC ${garmentId} (adversarial fixture)`,
    category: care === "handwash" ? "socks" : care === "none" ? "belt" : "shirt",
    roles: [care === "handwash" ? "socks" : care === "none" ? "belt" : "top"],
    careChannel: care,
    acquisition: "owned",
    quantity: opts.quantity ?? 1,
    isSynthetic: true,
    source: { kind: "owner_statement", note: NOTE },
  });
  if (created.status !== 200) throw new Error(`fixture: creating ${garmentId} failed: ${created.status} ${JSON.stringify(created.error)}`);
}

async function buckets(owner: TestOwner, garmentId: string): Promise<Record<string, number>> {
  const rows = await sql<{ bucket: string; quantity: number }>("SELECT bucket, quantity FROM stock_balances WHERE user_id = ? AND garment_id = ?", owner.userId, garmentId);
  const out: Record<string, number> = {};
  for (const row of rows) {
    expect(row.quantity, `${garmentId} ${row.bucket} is negative`).toBeGreaterThanOrEqual(0);
    out[row.bucket] = (out[row.bucket] ?? 0) + row.quantity;
  }
  return out;
}
const units = (b: Record<string, number>): number => Object.values(b).reduce((n, q) => n + q, 0);

const countedWears = (owner: TestOwner, garmentId: string) => sql<{ wearing_date: string; observation_count: number; status: string }>("SELECT wearing_date, observation_count, status FROM daily_wears WHERE user_id = ? AND garment_id = ? ORDER BY wearing_date", owner.userId, garmentId);
const observations = (owner: TestOwner, garmentId: string) =>
  sql<{ wearing_date: string; occurred_at: string; reported_at: string; timezone: string; channel: string; status: string }>("SELECT wearing_date, occurred_at, reported_at, timezone, channel, status FROM wear_observations WHERE user_id = ? AND garment_id = ? ORDER BY rowid", owner.userId, garmentId);
const wearEvents = async (owner: TestOwner, garmentId: string) =>
  (await sql<{ payload_json: string; occurred_at: string }>("SELECT payload_json, occurred_at FROM stock_events WHERE user_id = ? AND garment_id = ? AND kind = 'wear' AND voided_by_command_id IS NULL ORDER BY seq", owner.userId, garmentId)).map((e) => ({ occurredAt: e.occurred_at, ...(JSON.parse(e.payload_json) as { wearingDate: string; dirtyAtMs: number }) }));

async function settled(owner: TestOwner): Promise<Record<string, unknown>> {
  let previous = await fingerprint(owner);
  for (let i = 0; i < 40; i++) {
    await sleep(25);
    const next = await fingerprint(owner);
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    previous = next;
  }
  return previous;
}

async function moveTo(owner: TestOwner, timezone: string): Promise<string> {
  const moved = await submit(owner, "settings.update", { patch: { timezone } });
  if (moved.status !== 200) throw new Error(`fixture: moving to ${timezone} failed: ${moved.status} ${JSON.stringify(moved.error)}`);
  expect((await owner.api.json("GET", "/v1/settings")).settings.timezone).toBe(timezone);
  return ownerDay(owner, 0);
}

beforeAll(async () => {
  world = await createWorld();
  traveller = await syntheticOwner("Synthetic travelling owner (adversarial test fixture)");
  syntheticMcp = await connectMcp(world.synthetic, { write: true, clientName: "Time assistant (synthetic owner)" });
  travellerMcp = await connectMcp(traveller, { write: true, clientName: "Time assistant (synthetic traveller)" });
});

afterAll(async () => {
  await syntheticMcp?.close();
  await travellerMcp?.close();
});

describe("instants and dates that are not real, not UTC, or not yet", () => {
  it("refuses an occurredAt that is in the future, has an offset, is a leap second, 24:00, an impossible date or not ISO, and writes nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-instants", { quantity: 3 });
    const before = await settled(owner);
    const bad: [string, unknown][] = [
      ["tomorrow", iso(Date.now() + DAY)],
      ["ten years ahead", iso(Date.now() + 3650 * DAY)],
      ["six minutes ahead", iso(Date.now() + 6 * 60_000)],
      ["year 9999", "9999-12-31T23:59:59Z"],
      ["offset +14:00", "2026-09-30T10:00:00+14:00"],
      ["offset -12:00", "2026-09-30T10:00:00-12:00"],
      ["offset +00:00", "2026-09-30T10:00:00+00:00"],
      ["leap second", "2016-12-31T23:59:60Z"],
      ["24:00", "2026-09-30T24:00:00Z"],
      ["25 o'clock", "2026-09-30T25:00:00Z"],
      ["minute 60", "2026-09-30T10:60:00Z"],
      ["30 February", "2026-02-30T10:00:00Z"],
      ["29 February of a common year", "2026-02-29T10:00:00Z"],
      ["month 13", "2026-13-01T10:00:00Z"],
      ["day 0", "2026-09-00T10:00:00Z"],
      ["words", "yesterday evening"],
      ["no zone", "2026-09-30T10:00:00"],
      ["date only", "2026-09-30"],
      ["lowercase z", "2026-09-30T10:00:00z"],
      ["space separator", "2026-09-30 10:00:00Z"],
      ["microseconds", "2026-09-30T10:00:00.123456Z"],
      ["expanded year", "+010000-01-01T00:00:00Z"],
      ["negative year", "-000001-01-01T00:00:00Z"],
      ["RFC 2822", "Wed, 30 Sep 2026 10:00:00 GMT"],
      ["epoch milliseconds", Date.now() - HOUR],
      ["null", null],
      ["an object", { at: "2026-09-30T10:00:00Z" }],
      ["trailing text", "2026-09-30T10:00:00Z; DROP TABLE commands"],
    ];
    for (const [label, occurredAt] of bad) {
      const r = await raw(owner, { type: "care.mark_dirty", payload: { items: [{ garmentId: "syn04-instants", quantity: 1 }] }, occurredAt });
      expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error.code, label).toBe("invalid_command");
    }
    // The offline batch applies the same rule to each of its commands.
    const batch = await owner.api.post("/v1/commands/batch", { commands: bad.slice(0, 12).map(([, occurredAt]) => ({ type: "care.mark_dirty", payload: { items: [{ garmentId: "syn04-instants", quantity: 1 }] }, idempotencyKey: uid("batch"), expectedVersions: {}, occurredAt, authorization: "owner_tap", source: { channel: "ios" } })) });
    expect(batch.status).toBe(200);
    const results = ((await batch.json()) as any).results as any[];
    expect(results.map((r) => (r.status === "error" ? r.error.code : "receipt"))).toEqual(Array(12).fill("invalid_command"));
    expect(await fingerprint(owner)).toEqual(before);
    expect(await buckets(owner, "syn04-instants")).toEqual({ clean: 3 });
  });

  it("accepts a real UTC instant in the past with or without milliseconds, and stores it as the time of the event", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-real-instants", { quantity: 3 });
    const whole = iso(Date.now() - 5 * HOUR);
    const millis = new Date(Date.now() - 4 * HOUR).toISOString();
    const first = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn04-real-instants", quantity: 1 }] }, { occurredAt: whole });
    const second = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn04-real-instants", quantity: 1 }] }, { occurredAt: millis });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    expect(first.receipt.occurredAt).toBe(whole);
    expect(Date.parse(second.receipt.occurredAt)).toBe(Date.parse(millis));
    // When it happened and when it was reported are separate facts.
    expect(Date.parse(first.receipt.recordedAt)).toBeGreaterThan(Date.parse(whole) + 4 * HOUR);
    const events = await sql<{ occurred_at: string; recorded_at: string }>("SELECT occurred_at, recorded_at FROM stock_events WHERE user_id = ? AND garment_id = ? AND kind = 'mark_dirty' ORDER BY seq", owner.userId, "syn04-real-instants");
    expect(events.map((e) => Date.parse(e.occurred_at))).toEqual([Date.parse(whole), Date.parse(millis)]);
    for (const e of events) expect(Date.parse(e.recorded_at)).toBeGreaterThan(Date.parse(e.occurred_at));
    expect(await buckets(owner, "syn04-real-instants")).toEqual({ clean: 1, dirty: 2 });
  });

  it("refuses a wearing date that is impossible, malformed or still to come, and writes nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-dates");
    const today = await ownerDay(owner, 0);
    const before = await settled(owner);
    const bad: [string, unknown][] = [
      ["30 February", "2026-02-30"],
      ["29 February of a common year", "2025-02-29"],
      ["month 13", "2026-13-01"],
      ["day 32", "2026-01-32"],
      ["year 0", "0000-01-01"],
      ["slashes", today.replace(/-/g, "/")],
      ["a word", "today"],
      ["an instant", `${today}T08:00:00Z`],
      ["two-digit year", today.slice(2)],
      ["a number", 20261003],
      ["null", null],
      ["tomorrow", addDays(today, 1)],
      ["next year", addDays(today, 365)],
      ["year 9999", "9999-12-31"],
    ];
    for (const [label, wearingDate] of bad) {
      const r = await raw(owner, { type: "wear.record", payload: { wearingDate, garmentIds: ["syn04-dates"] } });
      expect(r.status, `${label}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error.code, label).toBe("invalid_command");
    }
    // A correction is held to the same calendar (a future day through wear.amend is defect L04-6 below).
    for (const [label, wearingDate] of bad.slice(0, 11)) {
      const amended = await raw(owner, { type: "wear.amend", payload: { wearingDate, add: ["syn04-dates"] } });
      expect(amended.status, `amend ${label}: ${JSON.stringify(amended.body)}`).toBe(400);
    }
    expect(await fingerprint(owner)).toEqual(before);
    expect(await countedWears(owner, "syn04-dates")).toEqual([]);
    expect(await buckets(owner, "syn04-dates")).toEqual({ clean: 1 });
  });

  it("[fixed L04-6] wear.amend refuses a wear on a day that has not happened yet, the year 9999 included, without a server error", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-future-amend");
    const g = "syn04-future-amend";
    const today = await ownerDay(owner, 0);
    // wear.record refuses this ("a wear cannot be recorded for a future date"); the correction path must too.
    const tomorrow = await submit(owner, "wear.amend", { wearingDate: addDays(today, 1), add: [g] });
    const farFuture = await submit(owner, "wear.amend", { wearingDate: "9999-12-31", add: [g] });
    expect({ tomorrow: tomorrow.status, farFuture: farFuture.status, countedWears: (await countedWears(owner, g)).map((w) => w.wearing_date), stock: await buckets(owner, g) }).toEqual({ tomorrow: 400, farFuture: 400, countedWears: [], stock: { clean: 1 } });
  });

  it("refuses invalid timezone names in settings and in a wear report, and keeps the timezone it had", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-zone-names");
    const today = await ownerDay(owner, 0);
    const before = await settled(owner);
    const bad: unknown[] = ["Mars/Olympus_Mons", "", " ", "Europe/London; DROP TABLE users", "UTC+25", "Europe", "London", "Europe/Londonn", "../../etc/passwd", "America/New_York\u0000", "x".repeat(65), 0, null, ["Europe/London"], { zone: "Europe/London" }];
    for (const timezone of bad) {
      const label = JSON.stringify(timezone).slice(0, 40);
      const setting = await raw(owner, { type: "settings.update", payload: { patch: { timezone } } });
      expect(setting.status, `settings ${label}: ${JSON.stringify(setting.body)}`).toBe(400);
      expect(setting.body.error.code, label).toBe("invalid_command");
      const wear = await raw(owner, { type: "wear.record", payload: { wearingDate: today, timezone, garmentIds: ["syn04-zone-names"] } });
      expect(wear.status, `wear ${label}: ${JSON.stringify(wear.body)}`).toBe(400);
    }
    expect(await fingerprint(owner)).toEqual(before);
    expect((await owner.api.json("GET", "/v1/settings")).settings.timezone).toBe("Europe/London");
    expect(await countedWears(owner, "syn04-zone-names")).toEqual([]);
  });

  it("[fixed L04-4] settings refuse a bare UTC offset (+05:00) as the owner's timezone: only IANA zone names are valid", async () => {
    const owner = await syntheticOwner("Synthetic offset owner (adversarial test fixture)");
    for (const timezone of ["+05:00", "-11:00", "+14:00"]) {
      const r = await submit(owner, "settings.update", { patch: { timezone } });
      expect(r.status, `${timezone} was accepted as a timezone: ${JSON.stringify(r.receipt?.summary)}`).toBe(400);
    }
    expect((await owner.api.json("GET", "/v1/settings")).settings.timezone).toBe("Europe/London");
  });

  it("[fixed L04-5] settings refuse clock times that do not exist (25:99) for the morning delivery and the laundry collection", async () => {
    const owner = await syntheticOwner("Synthetic clock owner (adversarial test fixture)");
    const morning = await submit(owner, "settings.update", { patch: { delivery: { morningLocalTime: "25:99" } } });
    const collection = await submit(owner, "settings.update", { patch: { laundry: { service: { collectionLocalTime: "99:99" } } } });
    const settings = (await owner.api.json("GET", "/v1/settings")).settings;
    expect({ morning: morning.status, collection: collection.status, stored: [settings.delivery.morningLocalTime, settings.laundry.service.collectionLocalTime] }).toEqual({ morning: 400, collection: 400, stored: ["07:00", "08:00"] });
  });
});

describe("the owner's local day", () => {
  it("counts the real owner's day in Europe/London: today is accepted, tomorrow refused, and a past day is timed at London noon", async () => {
    const owner = world.real;
    const today = await ownerDay(owner, 0);
    expect(today).toBe(dayIn("Europe/London"));
    const item = await cleanGarment(owner, "belt");
    const id = item.garment.garmentId;

    const tomorrow = await submit(owner, "wear.record", { wearingDate: addDays(today, 1), garmentIds: [id] });
    expect(tomorrow.status).toBe(400);
    expect(tomorrow.error).toMatchObject({ code: "invalid_command", details: { today } });
    expect(await countedWears(owner, id)).toEqual([]);

    const now = await submit(owner, "wear.record", { wearingDate: today, garmentIds: [id] });
    expect(now.status, JSON.stringify(now.error)).toBe(200);
    const yesterday = addDays(today, -1);
    const late = await submit(owner, "wear.record", { wearingDate: yesterday, garmentIds: [id] });
    expect(late.status, JSON.stringify(late.error)).toBe(200);

    const seen = await observations(owner, id);
    expect(seen.map((o) => [o.wearing_date, o.timezone])).toEqual([[today, "Europe/London"], [yesterday, "Europe/London"]]);
    // Today's wear happened when it was reported; yesterday's is placed at noon of that London day.
    expect(Math.abs(Date.parse(seen[0]!.occurred_at) - Date.parse(seen[0]!.reported_at))).toBeLessThan(5_000);
    expect(instantsOf("Europe/London", yesterday, "12:00")).toEqual([Date.parse(seen[1]!.occurred_at)]);
    expect(Date.parse(seen[1]!.reported_at)).toBeGreaterThan(Date.parse(seen[1]!.occurred_at));
    expect(await countedWears(owner, id)).toEqual([{ wearing_date: yesterday, observation_count: 1, status: "active" }, { wearing_date: today, observation_count: 1, status: "active" }]);
    expect((await owner.api.json("GET", `/v1/days/${yesterday}`)).garments.map((g: any) => g.garmentId)).toContain(id);
  });

  it("follows an owner moved to Pacific/Kiritimati, Pacific/Pago_Pago and Asia/Kathmandu: the wearing day is the owner's day there, not the UTC day", async () => {
    const owner = traveller;
    const zones: { zone: string; garment: string; noonUtc: (date: string) => number; endUtc: (date: string) => number }[] = [
      { zone: "Pacific/Kiritimati", garment: "shirt-moss", noonUtc: (d) => Date.parse(`${d}T12:00:00Z`) - 14 * HOUR, endUtc: (d) => Date.parse(`${addDays(d, 1)}T00:00:00Z`) - 14 * HOUR },
      { zone: "Pacific/Pago_Pago", garment: "shirt-gold", noonUtc: (d) => Date.parse(`${d}T12:00:00Z`) + 11 * HOUR, endUtc: (d) => Date.parse(`${addDays(d, 1)}T00:00:00Z`) + 11 * HOUR },
      { zone: "Asia/Kathmandu", garment: "shirt-slate", noonUtc: (d) => Date.parse(`${d}T12:00:00Z`) - 5.75 * HOUR, endUtc: (d) => Date.parse(`${addDays(d, 1)}T00:00:00Z`) - 5.75 * HOUR },
    ];
    let zonesOffTheUtcDay = 0;
    for (const { zone, garment, noonUtc, endUtc } of zones) {
      const utcDay = new Date().toISOString().slice(0, 10);
      const local = await moveTo(owner, zone);
      expect(local, zone).toBe(dayIn(zone));

      const tomorrow = await submit(owner, "wear.record", { wearingDate: addDays(local, 1), garmentIds: [garment] });
      expect(tomorrow.status, zone).toBe(400);
      expect(tomorrow.error!.details.today, zone).toBe(local);
      const today = await submit(owner, "wear.record", { wearingDate: local, garmentIds: [garment] });
      expect(today.status, `${zone}: ${JSON.stringify(today.error)}`).toBe(200);
      const yesterday = addDays(local, -1);
      const past = await submit(owner, "wear.record", { wearingDate: yesterday, garmentIds: [garment] });
      expect(past.status, `${zone}: ${JSON.stringify(past.error)}`).toBe(200);

      if (local > utcDay) {
        // Already tomorrow for the owner: the day the UTC calendar calls tomorrow is wearable today.
        zonesOffTheUtcDay++;
        expect(local).toBe(addDays(utcDay, 1));
      } else if (local < utcDay) {
        // Still yesterday for the owner: the UTC date has not started there, so a wear on it is refused.
        zonesOffTheUtcDay++;
        const utcDated = await submit(owner, "wear.record", { wearingDate: utcDay, garmentIds: ["trouser-olive"] });
        expect(utcDated.status, zone).toBe(400);
      }

      const seen = await observations(owner, garment);
      expect(seen.map((o) => [o.wearing_date, o.timezone])).toEqual([[local, zone], [yesterday, zone]]);
      expect(Date.parse(seen[1]!.occurred_at), `${zone} noon`).toBe(noonUtc(yesterday));
      const events = await wearEvents(owner, garment);
      // The unit is awaiting care from the end of that local day (the next local midnight), in that zone.
      expect(events.map((e) => [e.wearingDate, e.dirtyAtMs]).sort()).toEqual([[local, endUtc(local)], [yesterday, endUtc(yesterday)]].sort());
      expect(await countedWears(owner, garment)).toEqual([{ wearing_date: yesterday, observation_count: 1, status: "active" }, { wearing_date: local, observation_count: 1, status: "active" }]);
      expect(units(await buckets(owner, garment))).toBe(1);
    }
    // Kiritimati (UTC+14) and Pago Pago (UTC-11) cannot both be on the UTC date at any moment.
    expect(zonesOffTheUtcDay).toBeGreaterThanOrEqual(1);
    await moveTo(owner, "Europe/London");
  });

  it("three reports at 00:30 and both 01:30s of the London fall-back night are one counted wear on one 25-hour day", async () => {
    const owner = world.real;
    const item = await cleanGarment(owner, "top");
    const id = item.garment.garmentId;
    const before = await buckets(owner, id);
    const night = "2025-10-26";
    const halfPastMidnight = instantsOf("Europe/London", night, "00:30");
    const halfPastOne = instantsOf("Europe/London", night, "01:30");
    expect(halfPastMidnight).toHaveLength(1);
    expect(halfPastOne).toHaveLength(2); // the repeated hour
    expect(halfPastOne[1]! - halfPastOne[0]!).toBe(HOUR);
    const results: Outcome[] = [];
    for (const at of [halfPastMidnight[0]!, halfPastOne[0]!, halfPastOne[1]!]) results.push(await submit(owner, "wear.record", { wearingDate: night, garmentIds: [id] }, { occurredAt: iso(at) }));
    for (const r of results) expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(results.map((r) => r.receipt.outcome)).toEqual(["committed", "merged", "merged"]);
    expect(await countedWears(owner, id)).toEqual([{ wearing_date: night, observation_count: 3, status: "active" }]);
    const seen = await observations(owner, id);
    expect(seen.map((o) => Date.parse(o.occurred_at))).toEqual([halfPastMidnight[0], halfPastOne[0], halfPastOne[1]]);
    const events = await wearEvents(owner, id);
    expect(events).toHaveLength(1);
    // The day ends at the next London midnight: 25 hours after it began.
    const start = instantsOf("Europe/London", night, "00:00")[0]!;
    expect(events[0]!.dirtyAtMs).toBe(instantsOf("Europe/London", "2025-10-27", "00:00")[0]);
    expect(events[0]!.dirtyAtMs - start).toBe(25 * HOUR);
    const after = await buckets(owner, id);
    expect((before.clean ?? 0) - (after.clean ?? 0)).toBe(1);
    expect(units(after)).toBe(units(before));
  });

  it("reports either side of the London spring-forward gap are one counted wear on one 23-hour day, and the neighbouring days stay separate", async () => {
    const owner = world.real;
    const item = await cleanGarment(owner, "belt", { skip: (await sql<{ garment_id: string }>("SELECT DISTINCT garment_id FROM daily_wears WHERE user_id = ?", owner.userId)).map((r) => r.garment_id) });
    const id = item.garment.garmentId;
    const night = "2026-03-29";
    expect(instantsOf("Europe/London", night, "01:30")).toEqual([]); // the hour that does not exist
    const beforeGap = instantsOf("Europe/London", night, "00:30")[0]!;
    const afterGap = instantsOf("Europe/London", night, "02:30")[0]!;
    expect(afterGap - beforeGap).toBe(HOUR);
    const results = [
      await submit(owner, "wear.record", { wearingDate: night, garmentIds: [id] }, { occurredAt: iso(beforeGap) }),
      await submit(owner, "wear.record", { wearingDate: night, garmentIds: [id] }, { occurredAt: iso(afterGap) }),
      await submit(owner, "wear.record", { wearingDate: night, garmentIds: [id] }),
      await submit(owner, "wear.record", { wearingDate: "2026-03-28", garmentIds: [id] }),
      await submit(owner, "wear.record", { wearingDate: "2026-03-30", garmentIds: [id] }),
    ];
    for (const r of results) expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(await countedWears(owner, id)).toEqual([
      { wearing_date: "2026-03-28", observation_count: 1, status: "active" },
      { wearing_date: night, observation_count: 3, status: "active" },
      { wearing_date: "2026-03-30", observation_count: 1, status: "active" },
    ]);
    const seen = await observations(owner, id);
    // The report without a time is placed at noon of that London day, which is 11:00 UTC after the change and 12:00 UTC before it.
    expect(seen.map((o) => o.occurred_at)).toEqual([iso(beforeGap), iso(afterGap), "2026-03-29T11:00:00Z", "2026-03-28T12:00:00Z", "2026-03-30T11:00:00Z"]);
    const events = await wearEvents(owner, id);
    const ofNight = events.filter((e) => e.wearingDate === night);
    expect(ofNight).toHaveLength(1);
    expect(ofNight[0]!.dirtyAtMs - instantsOf("Europe/London", night, "00:00")[0]!).toBe(23 * HOUR);
    expect(events).toHaveLength(3);
  });

  it("an outfit worn past midnight keeps its starting wearing date; only a report naming the next day counts again", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-overnight", { quantity: 3 });
    const today = await ownerDay(owner, 0);
    const evening = addDays(today, -2);
    const lateEvening = instantsOf("Europe/London", evening, "23:30")[0]!;
    const afterMidnight = instantsOf("Europe/London", addDays(evening, 1), "00:45")[0]!;
    const first = await submit(owner, "wear.record", { wearingDate: evening, garmentIds: ["syn04-overnight"], segment: "dinner" }, { occurredAt: iso(lateEvening) });
    const continued = await submit(owner, "wear.record", { wearingDate: evening, garmentIds: ["syn04-overnight"], segment: "dinner" }, { occurredAt: iso(afterMidnight) });
    expect(first.receipt.outcome).toBe("committed");
    expect(continued.receipt.outcome).toBe("merged");
    expect(await countedWears(owner, "syn04-overnight")).toEqual([{ wearing_date: evening, observation_count: 2, status: "active" }]);
    expect(await buckets(owner, "syn04-overnight")).toEqual({ clean: 2, dirty: 1 });
    const nextDay = await submit(owner, "wear.record", { wearingDate: addDays(evening, 1), garmentIds: ["syn04-overnight"] });
    expect(nextDay.receipt.outcome).toBe("committed");
    expect((await countedWears(owner, "syn04-overnight")).map((w) => [w.wearing_date, w.observation_count])).toEqual([[evening, 2], [addDays(evening, 1), 1]]);
    expect(await buckets(owner, "syn04-overnight")).toEqual({ clean: 1, dirty: 2 });
  });

  it("a timezone change between a wear and its duplicate report neither relabels the first nor counts the wear again", async () => {
    const owner = traveller;
    const london = await moveTo(owner, "Europe/London");
    const first = await submit(owner, "wear.record", { wearingDate: london, garmentIds: ["trouser-beige"] });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const stored = (await observations(owner, "trouser-beige"))[0]!;

    const kiritimati = await moveTo(owner, "Pacific/Kiritimati");
    expect(kiritimati >= london).toBe(true);
    // The second device, already on the new timezone, reports the same wear of the same stated day.
    const duplicate = await submit(owner, "wear.record", { wearingDate: london, garmentIds: ["trouser-beige"] });
    expect(duplicate.status, JSON.stringify(duplicate.error)).toBe(200);
    expect(duplicate.receipt.outcome).toBe("merged");
    expect(await countedWears(owner, "trouser-beige")).toEqual([{ wearing_date: london, observation_count: 2, status: "active" }]);
    const seen = await observations(owner, "trouser-beige");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(stored); // not relabelled
    expect(seen.map((o) => o.timezone)).toEqual(["Europe/London", "Pacific/Kiritimati"]);
    expect(await wearEvents(owner, "trouser-beige")).toHaveLength(1);
    expect(await buckets(owner, "trouser-beige")).toEqual({ dirty: 1 });
    // The earlier day is still the earlier day when read after the move.
    expect((await owner.api.json("GET", `/v1/days/${london}`)).garments.map((g: any) => g.garmentId)).toContain("trouser-beige");
    await moveTo(owner, "Europe/London");
  });

  it("refuses a board for a day that is already over for the owner, in London and after a move across the date line", async () => {
    const real = world.real;
    const realYesterday = await ownerDay(real, -1);
    const refusedReal = await real.api.post("/v1/recommendations", { clientRequestId: uid("past-board"), mode: "board", date: realYesterday });
    expect(refusedReal.status).toBe(400);
    expect(((await refusedReal.json()) as any).error).toMatchObject({ code: "invalid_command", details: { localDate: realYesterday, today: await ownerDay(real, 0) } });
    expect(await sql("SELECT board_id FROM boards WHERE user_id = ? AND local_date = ?", real.userId, realYesterday)).toEqual([]);

    const owner = traveller;
    const local = await moveTo(owner, "Pacific/Kiritimati");
    const utcDay = new Date().toISOString().slice(0, 10);
    for (const date of [...new Set([addDays(local, -1), addDays(local, -30), ...(utcDay < local ? [utcDay] : [])])]) {
      const response = await owner.api.post("/v1/recommendations", { clientRequestId: uid("past-board"), mode: "board", date });
      const body = (await response.json()) as any;
      expect(response.status, `${date}: ${JSON.stringify(body).slice(0, 300)}`).toBe(400);
      expect(body.error.details.today).toBe(local);
    }
    expect(await count("boards", owner.userId)).toBe(0);
    // A pause cannot start on a day that is over either, and a trip cannot return before it departs.
    const pause = await submit(owner, "service.pause", { from: addDays(local, -1), resumeOn: null });
    expect(pause.status).toBe(400);
    const trip = await submit(owner, "trip.create", { name: "SYNTHETIC backwards trip", departsOn: addDays(local, 5), returnsOn: addDays(local, 2), destinations: [{ label: "SYNTHETIC destination", timezone: "Europe/Paris", from: addDays(local, 5), to: addDays(local, 2) }], source: { kind: "owner_statement", note: NOTE } });
    expect(trip.status).toBe(400);
    expect(await count("trips", owner.userId)).toBe(0);
    await moveTo(owner, "Europe/London");
  });
});

describe("late and conflicting reports", () => {
  it("a wear reported late for yesterday does not undo today's wash, is accepted with stale versions, and its receipt says what was repaired", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-late-wash");
    const g = "syn04-late-wash";
    const now = Date.now();
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: g }] }, { occurredAt: iso(now - 72 * HOUR) });
    const washed = await submit(owner, "care.washed", { items: [{ garmentId: g }] }, { occurredAt: iso(now - 20 * 60_000) });
    expect(washed.status, JSON.stringify(washed.error)).toBe(200);
    expect(await buckets(owner, g)).toEqual({ clean: 1 });

    const yesterday = await ownerDay(owner, -1);
    const late = await submit(owner, "wear.record", { wearingDate: yesterday, garmentIds: [g] }, { expectedVersions: { [`garment:${g}`]: 1, wardrobe: 0 } });
    expect(late.status, JSON.stringify(late.error)).toBe(200);
    expect(late.receipt.outcome).toBe("committed");
    expect(late.receipt.result.counted).toEqual([g]);
    // Event order, not report order: worn yesterday while it was awaiting care, washed today.
    expect(await buckets(owner, g)).toEqual({ clean: 1 });
    expect((late.receipt.repairs as string[]).join(" ")).toMatch(/no clean unit|awaiting care/i);
    expect(await countedWears(owner, g)).toEqual([{ wearing_date: yesterday, observation_count: 1, status: "active" }]);
    const seen = (await observations(owner, g))[0]!;
    expect(Date.parse(seen.occurred_at)).toBeLessThan(Date.parse(washed.receipt.occurredAt));
    expect(Date.parse(seen.reported_at)).toBeGreaterThan(Date.parse(washed.receipt.recordedAt) - 1);

    // Undoing the late report puts everything back exactly.
    const undone = await submit(owner, "command.undo", { commandId: late.receipt.commandId });
    expect(undone.status, JSON.stringify(undone.error)).toBe(200);
    expect(await buckets(owner, g)).toEqual({ clean: 1 });
    expect(await countedWears(owner, g)).toEqual([{ wearing_date: yesterday, observation_count: 0, status: "retracted" }]);
  });

  it("a wear reported late for a day before the laundry pickup leaves the piece in that batch, and the return brings it back", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-late-pickup");
    const g = "syn04-late-pickup";
    const now = Date.now();
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: g }] }, { occurredAt: iso(now - 96 * HOUR) });
    const pickup = await submit(owner, "laundry.collect", { include: [{ garmentId: g, quantity: 1 }] }, { occurredAt: iso(now - 30 * 60_000) });
    expect(pickup.status, JSON.stringify(pickup.error)).toBe(200);
    const batchId = pickup.receipt.result.batchId as string;
    const twoDaysAgo = await ownerDay(owner, -2);
    const late = await submit(owner, "wear.record", { wearingDate: twoDaysAgo, garmentIds: [g] });
    expect(late.status, JSON.stringify(late.error)).toBe(200);
    expect(late.receipt.result.counted).toEqual([g]);
    // The pickup that happened after that wear is preserved.
    expect(await buckets(owner, g)).toEqual({ service: 1 });
    expect(await sql("SELECT quantity, returned_quantity FROM laundry_batch_items WHERE user_id = ? AND batch_id = ? AND garment_id = ?", owner.userId, batchId, g)).toEqual([{ quantity: 1, returned_quantity: 0 }]);
    const returned = await submit(owner, "laundry.return", { batchId });
    expect(returned.status, JSON.stringify(returned.error)).toBe(200);
    expect(returned.receipt.result.returned).toBeGreaterThanOrEqual(1);
    expect(await sql("SELECT quantity, returned_quantity, still_away FROM laundry_batch_items WHERE user_id = ? AND batch_id = ? AND garment_id = ?", owner.userId, batchId, g)).toEqual([{ quantity: 1, returned_quantity: 1, still_away: 0 }]);
    expect(await buckets(owner, g)).toEqual({ clean: 1 });
    expect(await countedWears(owner, g)).toEqual([{ wearing_date: twoDaysAgo, observation_count: 1, status: "active" }]);
  });

  it("a piece worn after the pickup is with the owner, not in the bag: the return does not claim it came back clean", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-after-pickup");
    const g = "syn04-after-pickup";
    const now = Date.now();
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: g }] }, { occurredAt: iso(now - 96 * HOUR) });
    const pickup = await submit(owner, "laundry.collect", { include: [{ garmentId: g, quantity: 1 }] }, { occurredAt: iso(now - 48 * HOUR) });
    const batchId = pickup.receipt.result.batchId as string;
    expect(await buckets(owner, g)).toEqual({ service: 1 });
    // The owner is wearing it now: an authoritative observation although the ledger had it at the laundry.
    const today = await ownerDay(owner, 0);
    const worn = await submit(owner, "wear.record", { wearingDate: today, garmentIds: [g] }, { expectedVersions: { [`garment:${g}`]: 1 } });
    expect(worn.status, JSON.stringify(worn.error)).toBe(200);
    expect(worn.receipt.result.counted).toEqual([g]);
    expect((worn.receipt.repairs as string[]).join(" ")).toMatch(/service|laundry/i);
    expect(await buckets(owner, g)).toEqual({ dirty: 1 });

    const returned = await submit(owner, "laundry.return", { batchId });
    expect(returned.status, JSON.stringify(returned.error)).toBe(200);
    // Whatever else was in that bag, this piece is not counted as returned and is not clean.
    expect((returned.receipt.repairs as string[]).join(" ")).toMatch(/not counted as returned/i);
    expect(await buckets(owner, g)).toEqual({ dirty: 1 });
    expect(await sql("SELECT returned_quantity FROM laundry_batch_items WHERE user_id = ? AND batch_id = ? AND garment_id = ?", owner.userId, batchId, g)).toEqual([{ returned_quantity: 0 }]);
  });

  it("a pickup reported for an instant before a piece became dirty does not put that piece in the bag", async () => {
    const owner = await syntheticOwner("Synthetic pickup owner (adversarial test fixture)");
    await make(owner, "syn04-early-pickup");
    await make(owner, "syn04-early-pickup-old");
    const now = Date.now();
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn04-early-pickup-old" }] }, { occurredAt: iso(now - 50 * HOUR) });
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn04-early-pickup" }] }, { occurredAt: iso(now - 1 * HOUR) });
    // The pickup happened three hours ago and is only reported now.
    const pickup = await submit(owner, "laundry.collect", {}, { occurredAt: iso(now - 3 * HOUR) });
    expect(pickup.status, JSON.stringify(pickup.error)).toBe(200);
    expect(pickup.receipt.result.members).toEqual([{ garmentId: "syn04-early-pickup-old", quantity: 1 }]);
    expect(pickup.receipt.result.units).toBe(1);
    expect(await buckets(owner, "syn04-early-pickup")).toEqual({ dirty: 1 });
    expect(await buckets(owner, "syn04-early-pickup-old")).toEqual({ service: 1 });
    expect(await sql("SELECT garment_id FROM laundry_batch_items WHERE user_id = ? ORDER BY garment_id", owner.userId)).toEqual([{ garment_id: "syn04-early-pickup-old" }]);
  });

  it("worn and washed at the same instant: both reports stand, the later-reported one applies last, and no unit is created", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-same-instant-a");
    await make(owner, "syn04-same-instant-b");
    // A past owner-local wearing day and an instant inside that day, so the shared instant lies on its own
    // wearing date whatever the time of day the suite runs (never "today minus two hours", which can fall on
    // the previous local day).
    const timezone = (await owner.api.json("GET", "/v1/settings")).settings.timezone as string;
    const day = await ownerDay(owner, -1);
    const instants = instantsOf(timezone, day, "14:00");
    expect(instants, `14:00 on ${day} in ${timezone}`).toHaveLength(1);
    const at = iso(instants[0]!);
    expect(dayIn(timezone, Date.parse(at))).toBe(day);
    expect(Date.parse(at)).toBeLessThan(Date.now());
    const wearKey = uid("same-instant-wear");
    const wornFirst = await submit(owner, "wear.record", { wearingDate: day, garmentIds: ["syn04-same-instant-a"] }, { occurredAt: at, idempotencyKey: wearKey });
    const thenWashed = await submit(owner, "care.washed", { items: [{ garmentId: "syn04-same-instant-a" }] }, { occurredAt: at });
    expect(wornFirst.status, JSON.stringify(wornFirst.error)).toBe(200);
    expect(thenWashed.status, JSON.stringify(thenWashed.error)).toBe(200);
    expect(await buckets(owner, "syn04-same-instant-a")).toEqual({ clean: 1 });

    const washedFirst = await submit(owner, "care.washed", { items: [{ garmentId: "syn04-same-instant-b" }] }, { occurredAt: at });
    const thenWorn = await submit(owner, "wear.record", { wearingDate: day, garmentIds: ["syn04-same-instant-b"] }, { occurredAt: at });
    expect(washedFirst.status, JSON.stringify(washedFirst.error)).toBe(200);
    expect(thenWorn.status, JSON.stringify(thenWorn.error)).toBe(200);
    expect(await buckets(owner, "syn04-same-instant-b")).toEqual({ dirty: 1 });

    // Both wears are counted once, and replaying the first report changes nothing.
    expect(await countedWears(owner, "syn04-same-instant-a")).toEqual([{ wearing_date: day, observation_count: 1, status: "active" }]);
    expect(await countedWears(owner, "syn04-same-instant-b")).toEqual([{ wearing_date: day, observation_count: 1, status: "active" }]);
    const replay = await submit(owner, "wear.record", { wearingDate: day, garmentIds: ["syn04-same-instant-a"] }, { occurredAt: at, idempotencyKey: wearKey });
    expect(replay.receipt).toMatchObject({ commandId: wornFirst.receipt.commandId, replayed: true });
    expect(await buckets(owner, "syn04-same-instant-a")).toEqual({ clean: 1 });
  });

  it("two devices reporting the same wear at different times of one local day count it once and keep both reports", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-two-devices", { quantity: 2 });
    const g = "syn04-two-devices";
    const day = await ownerDay(owner, -1);
    const morning = instantsOf("Europe/London", day, "08:10")[0]!;
    const evening = instantsOf("Europe/London", day, "21:40")[0]!;
    const phone = await submit(owner, "wear.record", { wearingDate: day, garmentIds: [g], segment: "day" }, { occurredAt: iso(morning) });
    const browser = await send(owner.api.with({ client: "web" }), "wear.record", { wearingDate: day, garmentIds: [g], segment: "dinner" }, { occurredAt: iso(evening) });
    const assistant = await viaMcp(syntheticMcp, "wear.record", { wearingDate: day, garmentIds: [g] });
    expect(phone.receipt.outcome).toBe("committed");
    expect(browser.receipt.outcome).toBe("merged");
    expect(assistant.receipt?.outcome).toBe("merged");
    expect(await countedWears(owner, g)).toEqual([{ wearing_date: day, observation_count: 3, status: "active" }]);
    const seen = await observations(owner, g);
    expect(seen.map((o) => o.channel)).toEqual(["ios", "web", "mcp"]);
    expect(seen.slice(0, 2).map((o) => Date.parse(o.occurred_at))).toEqual([morning, evening]);
    expect(await wearEvents(owner, g)).toHaveLength(1);
    expect(await buckets(owner, g)).toEqual({ clean: 1, dirty: 1 });
    expect((await owner.api.json("GET", `/v1/days/${day}`)).garments.filter((x: any) => x.garmentId === g)).toHaveLength(1);
  });

  it("amending a wear onto a date that already has a wear of that garment merges it: one counted wear, one unit", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-amend", { quantity: 3 });
    const g = "syn04-amend";
    const first = await ownerDay(owner, -3);
    const second = await ownerDay(owner, -2);
    await submit(owner, "wear.record", { wearingDate: first, garmentIds: [g] });
    await submit(owner, "wear.record", { wearingDate: second, garmentIds: [g] });
    expect(await buckets(owner, g)).toEqual({ clean: 1, dirty: 2 });

    // "It was the second day, not the first": added where it already is, removed where it was not.
    const added = await submit(owner, "wear.amend", { wearingDate: second, add: [g], reason: "SYNTHETIC correction" }, { expectedVersions: { [`garment:${g}`]: 1 } });
    expect(added.status, JSON.stringify(added.error)).toBe(200);
    expect(added.receipt.result).toMatchObject({ counted: [], merged: [g] });
    const removed = await submit(owner, "wear.amend", { wearingDate: first, remove: [g], reason: "SYNTHETIC correction" });
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);
    expect(removed.receipt.result.removed).toEqual([g]);
    expect((await countedWears(owner, g)).map((w) => [w.wearing_date, w.status, w.observation_count])).toEqual([[first, "retracted", 0], [second, "active", 2]]);
    expect(await wearEvents(owner, g)).toHaveLength(1);
    expect(await buckets(owner, g)).toEqual({ clean: 2, dirty: 1 });
    // Removing a wear that is not on record changes nothing.
    const nothing = await submit(owner, "wear.amend", { wearingDate: first, remove: [g] });
    expect(nothing.receipt.outcome).toBe("noop");
    expect(await buckets(owner, g)).toEqual({ clean: 2, dirty: 1 });
  });

  it("reports dated before the garment's record was made are accepted without creating or losing a unit", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-before-record", { quantity: 2 });
    const g = "syn04-before-record";
    const today = await ownerDay(owner, 0);
    const monthAgo = addDays(today, -30);
    const worn = await submit(owner, "wear.record", { wearingDate: monthAgo, garmentIds: [g] });
    expect(worn.status, JSON.stringify(worn.error)).toBe(200);
    expect(worn.receipt.result.counted).toEqual([g]);
    const dirty = await submit(owner, "care.mark_dirty", { items: [{ garmentId: g, quantity: 1 }] }, { occurredAt: iso(Date.now() - 400 * DAY) });
    expect(dirty.status, JSON.stringify(dirty.error)).toBe(200);
    const washed = await submit(owner, "care.washed", { items: [{ garmentId: g, quantity: 1 }] }, { occurredAt: iso(Date.now() - 399 * DAY) });
    expect(washed.status, JSON.stringify(washed.error)).toBe(200);
    const after = await buckets(owner, g);
    expect(units(after)).toBe(2);
    // Dirty a year ago, washed the next day, worn a month ago: one unit is awaiting care now.
    expect(after).toEqual({ clean: 1, dirty: 1 });
    expect(await countedWears(owner, g)).toEqual([{ wearing_date: monthAgo, observation_count: 1, status: "active" }]);
    // The real owner's imported garment, worn on a day long before the import.
    const item = await cleanGarment(world.real, "socks");
    const before = await buckets(world.real, item.garment.garmentId);
    const old = await submit(world.real, "wear.record", { wearingDate: "2024-02-29", garmentIds: [item.garment.garmentId] });
    expect(old.status, JSON.stringify(old.error)).toBe(200);
    expect(units(await buckets(world.real, item.garment.garmentId))).toBe(units(before));
    expect(await countedWears(world.real, item.garment.garmentId)).toEqual([{ wearing_date: "2024-02-29", observation_count: 1, status: "active" }]);
  });

  it("[fixed L04-1] a wear whose occurredAt lies decades before its own wearing date is refused, so an older wash cannot 'clean' today's wear", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-clock-1970");
    const g = "syn04-clock-1970";
    const now = Date.now();
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: g }] }, { occurredAt: iso(now - 30 * HOUR) });
    await submit(owner, "care.washed", { items: [{ garmentId: g }] }, { occurredAt: iso(now - 29 * HOUR) });
    expect(await buckets(owner, g)).toEqual({ clean: 1 });
    // A phone whose clock was reset reports "worn today" with a 1970 timestamp.
    const today = await ownerDay(owner, 0);
    const observationRows = () => sql("SELECT * FROM wear_observations WHERE user_id = ? AND garment_id = ? ORDER BY rowid", owner.userId, g);
    const stockEventRows = () => sql("SELECT * FROM stock_events WHERE user_id = ? AND garment_id = ? ORDER BY seq", owner.userId, g);
    const wearsBefore = await countedWears(owner, g);
    const observationsBefore = await observationRows();
    const stockEventsBefore = await stockEventRows();
    expect(stockEventsBefore.length, "the dirty and washed reports are on the ledger before the attempt").toBeGreaterThan(0);
    const worn = await submit(owner, "wear.record", { wearingDate: today, garmentIds: [g] }, { occurredAt: "1970-01-01T00:00:00Z" });
    // The contradictory report is refused (`invalid_command`, reason occurred_before_wearing_date) and writes nothing.
    expect(worn.status, JSON.stringify(worn.receipt ?? null)).toBe(400);
    expect(worn.error).toMatchObject({ code: "invalid_command", details: { reason: "occurred_before_wearing_date", wearingDate: today } });
    expect(await buckets(owner, g)).toEqual({ clean: 1 });
    expect(await countedWears(owner, g)).toEqual(wearsBefore);
    expect(await observationRows()).toEqual(observationsBefore);
    expect(await stockEventRows()).toEqual(stockEventsBefore);
    // The same wear without the contradictory time is recorded on its day and leaves the unit awaiting care.
    const honest = await submit(owner, "wear.record", { wearingDate: today, garmentIds: [g] });
    expect(honest.status, JSON.stringify(honest.error)).toBe(200);
    expect(await buckets(owner, g)).toEqual({ dirty: 1 });
  });

  it("[fixed L04-2] a laundry return dated before the batch's pickup is refused and leaves the batch open", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-return-first");
    const g = "syn04-return-first";
    const now = Date.now();
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: g }] }, { occurredAt: iso(now - 5 * HOUR) });
    const pickup = await submit(owner, "laundry.collect", { include: [{ garmentId: g, quantity: 1 }] }, { occurredAt: iso(now - 2 * HOUR) });
    const batchId = pickup.receipt.result.batchId as string;
    const batchRow = async () => (await sql<{ status: string; picked_up_at: string; returned_at: string | null }>("SELECT status, picked_up_at, returned_at FROM laundry_batches WHERE user_id = ? AND batch_id = ?", owner.userId, batchId))[0]!;
    const itemsRow = async () => sql("SELECT * FROM laundry_batch_items WHERE user_id = ? AND batch_id = ? ORDER BY garment_id", owner.userId, batchId);
    // Every ledger event of the piece or of its bag (pickup and return events carry the batch in their payload).
    const eventRows = async () => sql("SELECT * FROM stock_events WHERE user_id = ? AND (garment_id = ? OR json_extract(payload_json, '$.batchId') = ?) ORDER BY seq", owner.userId, g, batchId);
    expect(pickup.status, JSON.stringify(pickup.error)).toBe(200);
    const batchBefore = await batchRow();
    const itemsBefore = await itemsRow();
    const eventsBefore = await eventRows();
    const stockBefore = await buckets(owner, g);
    expect(batchBefore.status).not.toBe("returned");
    expect(eventsBefore.length, "the dirty report and the pickup are on the ledger before the attempt").toBeGreaterThan(0);
    const returned = await submit(owner, "laundry.return", { batchId }, { occurredAt: iso(now - 24 * HOUR) });
    // Refused (`invalid_command`, reason return_before_pickup), and nothing about the batch or the piece changed.
    expect(returned.status, JSON.stringify(returned.receipt ?? null)).toBe(400);
    expect(returned.error).toMatchObject({ code: "invalid_command", details: { reason: "return_before_pickup", batchId } });
    expect(await batchRow()).toEqual(batchBefore);
    expect(await itemsRow()).toEqual(itemsBefore);
    expect(await eventRows()).toEqual(eventsBefore);
    expect(await buckets(owner, g)).toEqual(stockBefore);
  });

  it("[fixed L04-3] a late-dated 'laundry is back' with no batch out claims no piece came back clean that the ledger leaves in the hamper", async () => {
    const owner = await syntheticOwner("Synthetic late-return owner (adversarial test fixture)");
    await make(owner, "syn04-claimed");
    const g = "syn04-claimed";
    const now = Date.now();
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: g }] }, { occurredAt: iso(now - 1 * HOUR) });
    // The return is reported for an instant before the piece became dirty.
    const returned = await submit(owner, "laundry.return", {}, { occurredAt: iso(now - 3 * HOUR) });
    expect(returned.status, JSON.stringify(returned.error)).toBe(200);
    // Nothing was awaiting the service at that time: the receipt says nothing came back, and the dirty unit stays dirty.
    expect(returned.receipt.outcome, returned.receipt.summary).toBe("noop");
    expect(returned.receipt.result?.returned ?? 0, returned.receipt.summary).toBe(0);
    expect(await buckets(owner, g)).toEqual({ dirty: 1 });
  });
});

describe("a connected assistant's late, old and zoned reports (the seven-day report window is removed)", () => {
  // Contract of 2026-10-05, sections 1 and 5: a wear or wash report is an observation, recorded at once on every
  // surface whatever its date. What still holds: the day is the owner's local day (or the day in the timezone the
  // report itself names), a day that has not begun there is refused (packages/domain/src/handlers/wear-care.ts:
  // 156-160), an occurredAt in the future is refused (packages/domain/src/commands/service.ts:271-273), and a time
  // that lies before its own wearing date is refused (wear-care.ts:27-34).
  const commandRow = async (owner: TestOwner, commandId: string) => (await sql<{ actor: string; channel: string; authorization_basis: string }>("SELECT actor, channel, authorization_basis FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, commandId))[0];

  it("records the assistant's wears for today and seven, eight, nine and four hundred days ago at once, each on that London day as one counted wear, as the assistant's own (mcp) with an undo; a repeat merges and tomorrow is refused", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-window", { care: "none" });
    const g = "syn04-window";
    const today = await ownerDay(owner, 0);
    expect(today).toBe(dayIn("Europe/London"));
    const days = [today, addDays(today, -7), addDays(today, -8), addDays(today, -9), addDays(today, -400)];
    for (const wearingDate of days) {
      const r = await viaMcp(syntheticMcp, "wear.record", { wearingDate, garmentIds: [g] });
      expect(r.error, `${wearingDate}: ${JSON.stringify(r.error)}`).toBeNull();
      expect(r.receipt, wearingDate).toMatchObject({ type: "wear.record", outcome: "committed", actor: "assistant", channel: "mcp", undo: { available: true }, result: { wearingDate, counted: [g], merged: [] } });
      expect(await commandRow(owner, r.receipt.commandId), wearingDate).toEqual({ actor: "assistant", channel: "mcp", authorization_basis: "owner_statement" });
    }
    // The same report again for one of the old days merges into that day's wear; nothing is counted twice.
    const repeat = await viaMcp(syntheticMcp, "wear.record", { wearingDate: addDays(today, -8), garmentIds: [g] });
    expect(repeat.error, JSON.stringify(repeat.error)).toBeNull();
    expect(repeat.receipt).toMatchObject({ outcome: "merged", result: { counted: [], merged: [g] } });
    expect(await countedWears(owner, g)).toEqual([...days].sort().map((d) => ({ wearing_date: d, observation_count: d === addDays(today, -8) ? 2 : 1, status: "active" })));
    // Every report is kept as the assistant's observation on the owner's London day; a past day is timed at London noon.
    const seen = await observations(owner, g);
    expect(seen.map((o) => [o.wearing_date, o.timezone, o.channel])).toEqual([...days, addDays(today, -8)].map((d) => [d, "Europe/London", "mcp"]));
    for (const o of seen.filter((x) => x.wearing_date !== today)) expect(Date.parse(o.occurred_at), `${o.wearing_date} noon`).toBe(instantsOf("Europe/London", o.wearing_date, "12:00")[0]);
    // A day that has not begun for the owner is refused and writes nothing.
    const ledger = await settled(owner);
    const tomorrow = await viaMcp(syntheticMcp, "wear.record", { wearingDate: addDays(today, 1), garmentIds: [g] });
    expect(tomorrow.receipt).toBeNull();
    expect(tomorrow.error).toMatchObject({ code: "invalid_command", details: { wearingDate: addDays(today, 1), today } });
    expect(await fingerprint(owner)).toEqual(ledger);
    expect((await countedWears(owner, g)).map((w) => w.wearing_date)).not.toContain(addDays(today, 1));
  });

  it("records the assistant's dirty and washed reports timed nine and eight days ago at once with receipts; an occurredAt in the future, a wear timed in 1970 before its own day, an offset, a leap second, an impossible date or words is refused and writes nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-window-care", { care: "handwash", quantity: 4 });
    const g = "syn04-window-care";
    const today = await ownerDay(owner, 0);
    const nineDaysAgo = iso(Date.now() - 9 * DAY);
    const dirty = await viaMcp(syntheticMcp, "care.mark_dirty", { items: [{ garmentId: g, quantity: 1 }] }, { occurredAt: nineDaysAgo });
    expect(dirty.error, JSON.stringify(dirty.error)).toBeNull();
    expect(dirty.receipt).toMatchObject({ type: "care.mark_dirty", outcome: "committed", actor: "assistant", channel: "mcp", occurredAt: nineDaysAgo, undo: { available: true } });
    expect(await buckets(owner, g)).toEqual({ clean: 3, dirty: 1 });
    const eightDaysAgo = iso(Date.now() - 8 * DAY);
    const washed = await viaMcp(syntheticMcp, "care.washed", { items: [{ garmentId: g, quantity: 1 }] }, { occurredAt: eightDaysAgo });
    expect(washed.error, JSON.stringify(washed.error)).toBeNull();
    expect(washed.receipt).toMatchObject({ type: "care.washed", outcome: "committed", actor: "assistant", channel: "mcp", occurredAt: eightDaysAgo, undo: { available: true } });
    expect(await buckets(owner, g)).toEqual({ clean: 4 });
    for (const r of [dirty, washed]) expect(await commandRow(owner, r.receipt.commandId)).toEqual({ actor: "assistant", channel: "mcp", authorization_basis: "owner_statement" });

    const ledger = await settled(owner);
    // Refused by the command service: a time still to come, and a wear timed decades before its own day.
    const future = await viaMcp(syntheticMcp, "care.mark_dirty", { items: [{ garmentId: g, quantity: 1 }] }, { occurredAt: iso(Date.now() + DAY) });
    expect(future.receipt).toBeNull();
    expect(future.error?.code).toBe("invalid_command");
    expect(future.error?.message).toMatch(/occurredAt is in the future/);
    const in1970 = await viaMcp(syntheticMcp, "wear.record", { wearingDate: today, garmentIds: [g] }, { occurredAt: "1970-01-01T00:00:00Z" });
    expect(in1970.receipt).toBeNull();
    expect(in1970.error).toMatchObject({ code: "invalid_command", details: { reason: "occurred_before_wearing_date", wearingDate: today } });
    // Refused by the tool's own input schema (`occurredAt` is a UTC instant, McpCommandInput) before any handler runs.
    const malformed: [string, string][] = [
      ["an offset instead of Z", "2026-09-30T10:00:00+14:00"],
      ["a leap second", "2016-12-31T23:59:60Z"],
      ["30 February", "2026-02-30T10:00:00Z"],
      ["words", "last week"],
    ];
    for (const [label, occurredAt] of malformed) {
      const r = await viaMcp(syntheticMcp, "care.mark_dirty", { items: [{ garmentId: g, quantity: 1 }] }, { occurredAt });
      expect(r.receipt, label).toBeNull();
      expect(r.error, label).toBeNull();
      expect(r.threw, label).toMatch(/occurredAt/);
    }
    expect(await fingerprint(owner)).toEqual(ledger);
    expect(await buckets(owner, g)).toEqual({ clean: 4 });
  });

  it("judges a report that names another timezone by that zone's calendar: the day it is there now and a day eight days back there are recorded for the date named, with that zone kept on the observation; a day not yet begun there and an unknown zone are refused", async () => {
    const owner = world.synthetic;
    await make(owner, "syn04-window-zone", { care: "none" });
    const g = "syn04-window-zone";
    // Computed independently of the product, at the moment of each report.
    const kiritimati = dayIn("Pacific/Kiritimati");
    const ahead = await viaMcp(syntheticMcp, "wear.record", { wearingDate: kiritimati, timezone: "Pacific/Kiritimati", garmentIds: [g] });
    expect(ahead.error, JSON.stringify(ahead.error)).toBeNull();
    expect(ahead.receipt).toMatchObject({ type: "wear.record", outcome: "committed", actor: "assistant", channel: "mcp", result: { wearingDate: kiritimati, counted: [g] } });
    const behindDay = addDays(dayIn("Pacific/Pago_Pago"), -8);
    const behind = await viaMcp(syntheticMcp, "wear.record", { wearingDate: behindDay, timezone: "Pacific/Pago_Pago", garmentIds: [g] });
    expect(behind.error, JSON.stringify(behind.error)).toBeNull();
    expect(behind.receipt).toMatchObject({ type: "wear.record", outcome: "committed", result: { wearingDate: behindDay, counted: [g] } });
    const ledger = await settled(owner);
    // The day after Kiritimati's today has not begun anywhere: refused, with that zone's today named.
    const notYet = await viaMcp(syntheticMcp, "wear.record", { wearingDate: addDays(dayIn("Pacific/Kiritimati"), 1), timezone: "Pacific/Kiritimati", garmentIds: [g] });
    expect(notYet.receipt).toBeNull();
    expect(notYet.error).toMatchObject({ code: "invalid_command", details: { today: dayIn("Pacific/Kiritimati") } });
    const invalid = await viaMcp(syntheticMcp, "wear.record", { wearingDate: await ownerDay(owner, 0), timezone: "Mars/Olympus_Mons", garmentIds: [g] });
    expect(invalid.receipt).toBeNull();
    expect(invalid.error?.code).toBe("invalid_command");
    expect(await fingerprint(owner)).toEqual(ledger);
    expect(await countedWears(owner, g)).toEqual([...new Set([behindDay, kiritimati])].sort().map((d) => ({ wearing_date: d, observation_count: 1, status: "active" })));
    expect((await observations(owner, g)).map((o) => [o.wearing_date, o.timezone, o.channel])).toEqual([
      [kiritimati, "Pacific/Kiritimati", "mcp"],
      [behindDay, "Pacific/Pago_Pago", "mcp"],
    ]);
  });

  it("after a move across the date line, the assistant's reports are dated by the owner's day there: today and seven and eight days ago there are recorded (past days at Kiritimati noon), and tomorrow there is refused with that day as today", async () => {
    const owner = traveller;
    const local = await moveTo(owner, "Pacific/Kiritimati");
    expect(local).toBe(dayIn("Pacific/Kiritimati"));
    const g = "shoe-olive";
    const days = [addDays(local, -8), addDays(local, -7), local];
    for (const wearingDate of days) {
      const r = await viaMcp(travellerMcp, "wear.record", { wearingDate, garmentIds: [g] });
      expect(r.error, `${wearingDate}: ${JSON.stringify(r.error)}`).toBeNull();
      expect(r.receipt, wearingDate).toMatchObject({ type: "wear.record", outcome: "committed", actor: "assistant", channel: "mcp", undo: { available: true }, result: { wearingDate, counted: [g] } });
    }
    const ledger = await settled(owner);
    const tomorrowThere = await viaMcp(travellerMcp, "wear.record", { wearingDate: addDays(local, 1), garmentIds: [g] });
    expect(tomorrowThere.receipt).toBeNull();
    expect(tomorrowThere.error).toMatchObject({ code: "invalid_command", details: { wearingDate: addDays(local, 1), today: local } });
    expect(await fingerprint(owner)).toEqual(ledger);
    expect(await countedWears(owner, g)).toEqual(days.map((d) => ({ wearing_date: d, observation_count: 1, status: "active" })));
    const seen = await observations(owner, g);
    expect(seen.map((o) => [o.wearing_date, o.timezone, o.channel])).toEqual(days.map((d) => [d, "Pacific/Kiritimati", "mcp"]));
    // Kiritimati is UTC+14 all year: noon there is 22:00 UTC of the day before.
    for (const o of seen.filter((x) => x.wearing_date !== local)) expect(Date.parse(o.occurred_at), `${o.wearing_date} noon`).toBe(Date.parse(`${o.wearing_date}T12:00:00Z`) - 14 * HOUR);
    await moveTo(owner, "Europe/London");
  });
});
