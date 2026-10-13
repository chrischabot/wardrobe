import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { deliverNotifications } from "../src/notifications/service.ts";
import { checkOwnerConnections, projectReminderEvents, reminderEventId, runAssistantJobs, runConnectionHealth } from "../src/scheduled/assistant.ts";
import { assistantPortsFor } from "../src/lanes/index.ts";
import { APP_ORIGIN, enableFakeModel, provisionOwner, testApp, uploadImage, type FakeModel, type TestOwner } from "../src/testing/index.ts";

/*
 * What the Worker does for the assistant workstream: the ports it hands the conversation actor, and the
 * scheduled work it runs (background jobs, connection health, reminder events on the outfit calendar,
 * reminder notifications). REAL owner fixture for the conversation; the connections belong to labelled
 * synthetic owners where a test changes their state.
 * Stand-ins: test-signed Access assertions; the labelled FAKE MODEL; the labelled Google fixture
 * (`google.fixture.test`: OAuth, Calendar events, a synthetic spreadsheet, the cheapest Gmail and Drive
 * reads); the labelled tool-service fixture at the Tavily endpoint (not Tavily); the labelled APNs
 * fixture (not Apple). None of this shows that the real services accept these requests.
 */
let owner: TestOwner;
let model: FakeModel;

const HOUR = 3_600_000;
const fixtureCalls = async (query = "?kind=API&contains=spreadsheets") => (await (await fetch(`https://google.fixture.test/__calls${query}`)).json()) as { method: string; url: string; body: string }[];
const settle = async (target: TestOwner, runId: string) => {
  let run: any;
  for (let i = 0; i < 200; i++) {
    run = await target.api.json("GET", `/v1/runs/${runId}`);
    if (["completed", "failed", "cancelled"].includes(run.state)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return run;
};
async function connectGoogle(target: TestOwner, capabilities: string[]): Promise<string> {
  const started = await target.api.json("POST", "/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, kind: "google_workspace", name: "Google", auth: { type: "oauth" }, capabilities });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  await SELF.fetch(`${APP_ORIGIN}/connections/callback?state=${encodeURIComponent(state)}&code=fixture-code`, { redirect: "manual" });
  // Reading the list mirrors the connection into the assistant's registry, as the app does after the callback.
  const listed = await target.api.json("GET", "/v1/connections");
  expect(listed.connections.find((c: any) => c.connectionId === started.connection.connectionId).state).toBe("connected");
  return started.connection.connectionId as string;
}
async function connectToolService(target: TestOwner, suffix: string): Promise<string> {
  const registered = await target.api.json("POST", "/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, kind: "tavily", name: "Page search", auth: { type: "secret", secret: `tvly-ASSISTANT-WORK-${suffix}` } });
  expect(registered.connection.state).toBe("connected");
  await target.api.json("GET", "/v1/connections");
  return registered.connection.connectionId as string;
}
const stateOf = async (target: TestOwner, connectionId: string) => (await target.api.json("GET", "/v1/connections")).connections.find((c: any) => c.connectionId === connectionId).state as string;
const effects = async (target: TestOwner, kind: string) => (await (await testApp()).db.prepare("SELECT state, attempts, target_key FROM effects WHERE user_id = ? AND kind = ? ORDER BY created_at, effect_id").bind(target.userId, kind).all<{ state: string; attempts: number; target_key: string }>()).results;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  model = await enableFakeModel(owner);
});

describe("the ports the Worker gives the conversation actor", () => {
  it("lets the assistant look at a photograph the owner attached (openImage), and a turn that only names an item needs no photograph", async () => {
    const uploaded = await uploadImage(owner, { intent: "attachment" });
    const assetId = uploaded.complete.asset.assetId as string;
    model.script({ text: "I can see the photograph." });
    const withPhoto = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "what is this?", attachmentIds: [assetId] });
    const run = await settle(owner, withPhoto.runId);
    expect(run.state, JSON.stringify(run.error)).toBe("completed");
    const seen = model.requests.at(-1)!.images;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.byteLength).toBeGreaterThan(0);
    expect(seen[0]!.mediaType).toMatch(/^image\//);

    const garment = (await owner.api.json("GET", "/v1/wardrobe")).items[0].garment;
    model.script({ text: "That is one of your pieces." });
    const named = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "tell me about this one", attachedRefs: [{ kind: "garment", id: garment.garmentId }] });
    const second = await settle(owner, named.runId);
    expect(second.state, JSON.stringify(second.error)).toBe("completed");
    expect(model.requests.at(-1)!.images).toEqual([]);

    // Another owner's photograph is not opened for this owner.
    const stranger = await provisionOwner();
    const theirs = (await uploadImage(stranger, { intent: "attachment" })).complete.asset.assetId as string;
    const refused = await owner.api.post("/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "and this?", attachmentIds: [theirs] });
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });

  it("answers a one-slot outfit question from the daily service's decision context (decisionContext)", async () => {
    const items = (await owner.api.json("GET", "/v1/wardrobe")).items.map((i: any) => i.garment).filter((g: any) => g.acquisition === "owned");
    const top = items.find((g: any) => g.roles.includes("top"));
    model.script({ toolCalls: [{ toolName: "outfit_question_context", input: { outfit: [{ role: "top", garmentId: top.garmentId }], role: "socks" } }] }, { text: "Here is what goes with it." });
    const turn = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "which socks with this?", attachedRefs: [{ kind: "garment", id: top.garmentId }] });
    expect((await settle(owner, turn.runId)).state).toBe("completed");
    const result = model.requests.flatMap((r) => r.toolResults).filter((t) => t.toolName === "outfit_question_context").at(-1)!;
    const output = result.output as Record<string, unknown>;
    expect(output.unavailable).toBeUndefined();
    expect(typeof output.text).toBe("string");
    expect(String(output.text).length).toBeGreaterThan(50);
  });

  it("shows the approved input schema of an enabled tool of the owner's own connection (describeConnectionTools)", async () => {
    const connectionId = await connectToolService(owner, "PORTS001");
    await owner.api.json("POST", `/v1/connections/${connectionId}/capabilities`, { enabled: ["tools:search"] });
    await owner.api.json("GET", "/v1/connections");
    model.script({ toolCalls: [{ toolName: "describe_connection_tools", input: { connectionId } }] }, { text: "Those are the tools." });
    const turn = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "what can the page search connection do?" });
    expect((await settle(owner, turn.runId)).state).toBe("completed");
    const output = model.requests.flatMap((r) => r.toolResults).filter((t) => t.toolName === "describe_connection_tools").at(-1)!.output as { tools: { name: string; callable: boolean; inputSchema?: unknown }[] };
    const callable = output.tools.filter((t) => t.callable);
    expect(callable.length).toBeGreaterThan(0);
    for (const tool of callable) expect(tool.inputSchema, tool.name).toBeTruthy();
    for (const tool of output.tools.filter((t) => !t.callable)) expect(tool.inputSchema).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("tvly-");
  });
});

describe("the transcript", () => {
  it("returns the messages surrounding one message, with the channel each came from", async () => {
    const all = (await owner.api.json("GET", "/v1/conversation/messages?limit=50")).messages as { messageId: string; channel: string | null; authoredAt: string }[];
    expect(all.length).toBeGreaterThanOrEqual(6);
    const middle = all[Math.floor(all.length / 2)]!;
    const around = (await owner.api.json("GET", `/v1/conversation/messages?around=${encodeURIComponent(middle.messageId)}&limit=3`)).messages as { messageId: string; channel: string | null }[];
    expect(around.map((m) => m.messageId)).toContain(middle.messageId);
    expect(around.length).toBeGreaterThan(1);
    expect(around.length).toBeLessThan(all.length);
    // The neighbours are the ones next to it in the full transcript, in the same order.
    const positions = around.map((m) => all.findIndex((a) => a.messageId === m.messageId));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.at(-1)! - positions[0]!).toBe(around.length - 1);
    expect(around.some((m) => m.channel === "ios")).toBe(true);
  });
});

describe("page retrieval in a browser", () => {
  it("renders a page through the Browser Rendering binding when the deployment has one, and says plainly when it has not", async () => {
    const app = await testApp();
    const other = await provisionOwner(); // no tool connection: the browser is the only method left
    const asked: { action: string; url: string }[] = [];
    // LABELLED FAKE of the Browser Rendering binding (there is none in a local run): it records what it was
    // asked and answers in the documented envelope. It shows the wiring, not that Cloudflare renders the page.
    const fakeBrowser = {
      quickAction: async (action: string, options: Record<string, unknown>) => {
        asked.push({ action, url: String(options.url) });
        return { success: true, result: `# Fixture product page (fake browser)\n\n${"A synthetic paragraph about a synthetic cardigan. ".repeat(40)}` };
      },
    };
    const request = { urls: ["https://shop.example.com/fixture-page"], need: "readable_copy" as const, expectedFields: [] };

    const withBrowser = assistantPortsFor({ ...app.env, BROWSER: fakeBrowser } as never, other.userId);
    const [rendered] = await withBrowser.extraction!.extract(request);
    expect(asked).toEqual([{ action: "markdown", url: "https://shop.example.com/fixture-page" }]);
    const usedBrowser = rendered!.status === "resolved" ? JSON.stringify(rendered) : JSON.stringify((rendered as { attempts: unknown[] }).attempts);
    expect(usedBrowser).toContain("browser");
    expect(usedBrowser).not.toContain("not configured");

    // A private address is refused before the browser is asked.
    await withBrowser.extraction!.extract({ ...request, urls: ["https://127.0.0.1/admin"] }).catch(() => []);
    expect(asked).toHaveLength(1);

    const withoutBrowser = assistantPortsFor({ ...app.env, BROWSER: undefined } as never, other.userId);
    const [unavailable] = await withoutBrowser.extraction!.extract(request);
    expect(unavailable!.status).toBe("unresolved");
    expect(JSON.stringify(unavailable)).toContain("browser rendering is not configured in this deployment");
    expect(asked).toHaveLength(1);
  });
});

describe("background jobs (assistant.run_job)", () => {
  it("runs a queued sheet-import job once with the owner's read-only Google grant and stores a preview, changing nothing", async () => {
    const app = await testApp();
    const other = await provisionOwner();
    const googleId = await connectGoogle(other, ["sheets.read_selected"]);
    const before = (await other.api.json("GET", "/v1/wardrobe")).total;
    const created = await app.service.execute(other.systemPrincipal, { type: "job.create", payload: { kind: "sheet_import", title: "Import the synthetic fixture sheet", params: { spreadsheetId: "fixture-sheet", connectionId: `${googleId}_sheets`, range: "A1:C10" } }, idempotencyKey: `job:${crypto.randomUUID()}`, expectedVersions: {}, authorization: "system_schedule", source: { channel: "system" } });
    const jobId = String(created.result.jobId);
    expect((await effects(other, "assistant.run_job")).map((e) => e.state)).toEqual(["pending"]);
    await fixtureCalls();

    const swept = await runAssistantJobs(app, Date.now());
    expect(swept.ran).toContainEqual({ userId: other.userId, jobId, state: "completed" });
    const job = await app.db.prepare("SELECT state, progress_json FROM assistant_jobs WHERE user_id = ? AND job_id = ?").bind(other.userId, jobId).first<{ state: string; progress_json: string }>();
    expect(job!.state).toBe("completed");
    const progress = JSON.parse(job!.progress_json);
    expect(progress.rows).toBe(2);
    expect(progress.phase).toContain("nothing was applied");
    // The sheet was read with this owner's token, at the Sheets values path, and nothing was written anywhere.
    const calls = (await fixtureCalls()).filter((c) => c.url.includes("/v4/spreadsheets/"));
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect((await other.api.json("GET", "/v1/wardrobe")).total).toBe(before);
    expect((await effects(other, "assistant.run_job")).map((e) => e.state)).toEqual(["projected"]);

    // A second sweep starts nothing again.
    const again = await runAssistantJobs(app, Date.now());
    expect(again.ran.filter((r) => r.jobId === jobId)).toEqual([]);
    expect((await fixtureCalls()).filter((c) => c.url.includes("/v4/spreadsheets/"))).toEqual([]);
  });

  it("fails a job with a reason the owner can act on when the connection is not this owner's or the capability is not granted", async () => {
    const app = await testApp();
    const other = await provisionOwner();
    const googleId = await connectGoogle(other, ["calendar.read"]); // no spreadsheet capability
    const stranger = await provisionOwner();
    const strangerGoogle = await connectGoogle(stranger, ["sheets.read_selected"]);
    const start = async (connectionId: string) =>
      String((await app.service.execute(other.systemPrincipal, { type: "job.create", payload: { kind: "sheet_import", title: "Import a sheet", params: { spreadsheetId: "fixture-sheet", connectionId, range: "A1:C10" } }, idempotencyKey: `job:${crypto.randomUUID()}`, expectedVersions: {}, authorization: "system_schedule", source: { channel: "system" } })).result.jobId);
    const notGranted = await start(`${googleId}_sheets`);
    const notTheirs = await start(`${strangerGoogle}_sheets`);
    await fixtureCalls();
    await runAssistantJobs(app, Date.now());
    for (const jobId of [notGranted, notTheirs]) {
      const job = await app.db.prepare("SELECT state, unresolved_reason FROM assistant_jobs WHERE user_id = ? AND job_id = ?").bind(other.userId, jobId).first<{ state: string; unresolved_reason: string | null }>();
      expect(job!.state).toBe("failed");
      expect(job!.unresolved_reason).toContain("could not be opened");
    }
    // The other owner's spreadsheet grant was never used for this owner's job.
    expect((await fixtureCalls()).filter((c) => c.url.includes("/v4/spreadsheets/"))).toEqual([]);
  });
});

describe("connection health", () => {
  it("probes each connected service, and a rejected key becomes one reconnect state while everything else keeps working", async () => {
    const app = await testApp();
    const other = await provisionOwner();
    const googleId = await connectGoogle(other, ["calendar.read"]);
    const toolId = await connectToolService(other, "HEALTH01");

    const healthy = await checkOwnerConnections(app, other.userId, "manual", Date.now());
    expect(healthy.checked.length).toBeGreaterThanOrEqual(2);
    expect(healthy.checked.every((c) => c.ok)).toBe(true);
    expect(healthy.ownerActions).toEqual([]);

    // The tool service starts rejecting this key (as after the owner revoked it there).
    await fetch("https://google.fixture.test/__reject?client=HEALTH01");
    const evening = await checkOwnerConnections(app, other.userId, "evening", Date.now() + HOUR);
    const rejected = evening.checked.filter((c) => c.needsOwner);
    expect(rejected.map((c) => c.connectionId)).toEqual([toolId]);
    expect(evening.ownerActions).toEqual(["Page search needs you to sign in again."]);
    expect(JSON.stringify(evening)).not.toContain("tvly-");

    // One clear state for that connection, in the owner's list and in the assistant's registry; Google is untouched.
    expect(await stateOf(other, toolId)).toBe("needs_reconnect");
    expect(await stateOf(other, googleId)).toBe("connected");
    const registry = (await app.assistant!.connections(other.systemPrincipal)).find((c) => c.connectionId === toolId)!;
    expect(registry.status).toBe("needs_reauthorization");
    expect((await other.api.get("/v1/wardrobe")).status).toBe(200);
    expect((await other.api.get("/v1/today")).status).toBe(200);

    // Checking again does not stack states or probe the rejected service again.
    await fixtureCalls("?method=MCP");
    const morning = await checkOwnerConnections(app, other.userId, "morning", Date.now() + 2 * HOUR);
    expect(morning.ownerActions).toEqual(["Page search needs you to sign in again."]);
    expect((await fixtureCalls("?method=MCP")).filter((c) => JSON.parse(c.body).client === "HEALTH01")).toEqual([]);
    const issues = (await other.api.json("GET", "/v1/connections")).connections.find((c: any) => c.connectionId === toolId);
    expect(issues.issue.action).toBe("reconnect");
  });

  it("runs once before the evening composition and once before the morning delivery of a day, not on every sweep", async () => {
    const app = await testApp();
    const other = await provisionOwner();
    await connectGoogle(other, ["calendar.read"]);
    const base = Date.now();
    const runs: { localDate: string; phase: string }[] = [];
    // A day and a half of sweeps, one every half hour (the cron runs every five minutes; the claim is what matters).
    for (let step = 0; step < 72; step++) {
      const swept = await runConnectionHealth(app, base + step * (HOUR / 2));
      runs.push(...swept.runs.filter((r) => r.userId === other.userId));
    }
    const keys = runs.map((r) => `${r.localDate}:${r.phase}`);
    expect(new Set(keys).size).toBe(keys.length); // never twice for the same day and phase
    expect(runs.some((r) => r.phase === "evening")).toBe(true);
    expect(runs.some((r) => r.phase === "morning")).toBe(true);
    expect(runs.length).toBeLessThanOrEqual(5);
    // Each run recorded a health check for the connection through the command service.
    const recorded = (await app.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'connection.record_health'").bind(other.userId).first<{ n: number }>())!.n;
    expect(recorded).toBeGreaterThanOrEqual(2);
    // Repeating the same instants does nothing more.
    expect((await runConnectionHealth(app, base)).runs.filter((r) => r.userId === other.userId)).toEqual([]);
  });
});

describe("a reminder set in conversation", () => {
  // As the owner sets and removes a reminder in the app (the same commands the assistant's tools commit).
  const ownerCommand = async (target: TestOwner, type: string, payload: Record<string, unknown>) => {
    const response = await target.api.command(type, payload);
    const body = (await response.json()) as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  };
  const setReminder = (target: TestOwner, payload: Record<string, unknown>) => ownerCommand(target, "reminder.set", payload);
  const cancelReminder = (target: TestOwner, reminderId: string) => ownerCommand(target, "reminder.cancel", { reminderId });

  it("appears as one event on the outfit calendar and is deleted when the reminder is removed", async () => {
    const app = await testApp();
    const other = await provisionOwner();
    const googleId = await connectGoogle(other, ["calendar.read", "calendar.write_outfit_calendar"]);
    const calendar = await other.api.json("POST", `/v1/connections/${googleId}/outfit-calendar`, { clientRequestId: `cal-${crypto.randomUUID()}` });
    const calendarId = calendar.calendar.calendarId as string;
    const dueAt = new Date(Date.now() + 3 * 24 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
    const set = await setReminder(other, { kind: "drop", title: "Synthetic drop (test fixture)", dueAt, note: "Fixture note", url: "https://shop.example.com/drop", leadMinutes: [60] });
    const reminderId = String(set.result.reminderId);
    const eventId = await reminderEventId(other.userId, reminderId);
    expect(eventId).toMatch(/^gdr[0-9a-f]{40}$/);
    await fixtureCalls(`?kind=API&contains=${eventId}`);

    const first = await projectReminderEvents(app, Date.now());
    expect(first).toMatchObject({ projected: 1, failed: 0, retried: 0 });
    const writes = (await fixtureCalls(`?kind=API&contains=${eventId}`)).filter((c) => c.method !== "GET");
    expect(writes.map((c) => c.method)).toEqual(["POST"]);
    const inserted = JSON.parse(writes[0]!.body);
    expect(writes[0]!.url).toContain(encodeURIComponent(calendarId));
    expect(inserted).toMatchObject({ id: eventId, summary: "Synthetic drop (test fixture)", start: { dateTime: dueAt } });
    expect(inserted.attendees).toBeUndefined(); // nobody is invited
    expect(inserted.reminders).toEqual({ useDefault: false, overrides: [] });
    expect((await effects(other, "calendar.project_reminder")).map((e) => e.state)).toEqual(["projected"]);

    // A second sweep writes nothing.
    expect(await projectReminderEvents(app, Date.now())).toMatchObject({ projected: 0, removed: 0 });
    expect((await fixtureCalls(`?kind=API&contains=${eventId}`)).filter((c) => c.method !== "GET")).toEqual([]);

    // The reminder is removed: its event is deleted, once.
    await cancelReminder(other, reminderId);
    expect(await projectReminderEvents(app, Date.now())).toMatchObject({ removed: 1 });
    const removed = (await fixtureCalls(`?kind=API&contains=${eventId}`)).filter((c) => c.method !== "GET");
    expect(removed.map((c) => c.method)).toEqual(["DELETE"]);
    expect(removed[0]!.url).toContain(eventId);
    expect(await projectReminderEvents(app, Date.now())).toMatchObject({ removed: 0 });
  });

  // (Changing an existing reminder failed on D1 until the assistant workstream fixed `reminder.set`.)
  it("moves the same event when the reminder changes", async () => {
    const app = await testApp();
    const other = await provisionOwner();
    const googleId = await connectGoogle(other, ["calendar.read", "calendar.write_outfit_calendar"]);
    await other.api.json("POST", `/v1/connections/${googleId}/outfit-calendar`, { clientRequestId: `cal-${crypto.randomUUID()}` });
    const dueAt = new Date(Date.now() + 3 * 24 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
    const set = await setReminder(other, { kind: "drop", title: "Synthetic drop (test fixture)", dueAt, leadMinutes: [60] });
    const reminderId = String(set.result.reminderId);
    const eventId = await reminderEventId(other.userId, reminderId);
    expect(await projectReminderEvents(app, Date.now())).toMatchObject({ projected: 1 });
    await fixtureCalls(`?kind=API&contains=${eventId}`);

    // The same event is updated; no second event is created.
    const later = new Date(Date.parse(dueAt) + 24 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");
    await setReminder(other, { reminderId, kind: "drop", title: "Synthetic drop, moved (test fixture)", dueAt: later, leadMinutes: [60] });
    expect(await projectReminderEvents(app, Date.now())).toMatchObject({ projected: 1 });
    const moved = (await fixtureCalls(`?kind=API&contains=${eventId}`)).filter((c) => c.method !== "GET");
    expect(moved.map((c) => c.method)).toEqual(["PATCH"]);
    expect(moved[0]!.url).toContain(eventId);
    expect(JSON.parse(moved[0]!.body)).toMatchObject({ summary: "Synthetic drop, moved (test fixture)", start: { dateTime: later } });
  });

  it("writes nothing for an owner without an outfit calendar, and never records that as projected", async () => {
    const app = await testApp();
    const other = await provisionOwner();
    await setReminder(other, { kind: "other", title: "Synthetic reminder without a calendar (test fixture)", dueAt: new Date(Date.now() + 48 * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z"), leadMinutes: [0] });
    const result = await projectReminderEvents(app, Date.now());
    expect(result.notConnected).toBeGreaterThanOrEqual(1);
    expect((await effects(other, "calendar.project_reminder")).map((e) => e.state)).toEqual(["cancelled"]);
    expect((await app.db.prepare("SELECT COUNT(*) AS n FROM reminder_calendar_events WHERE user_id = ?").bind(other.userId).first<{ n: number }>())!.n).toBe(0);
  });

  it("is delivered to the owner's phone when it is due, once, and not after it was removed", async () => {
    const app = await testApp();
    const other = await provisionOwner();
    // A tagged device (see the APNs fixture): its deliveries are read only by this test.
    const token = ("7a67" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")).slice(0, 64);
    const mine = `?kind=APNS_TAGGED&contains=${token.slice(0, 8)}`;
    await other.api.json("POST", "/v1/devices", { deviceId: "iphone-reminder-0001", token, environment: "development" });
    // Due in 61 minutes with a one-hour lead: the reminder is to be sent one minute from now.
    const dueMs = Date.now() + HOUR + 60_000;
    const dueAt = new Date(dueMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const kept = await setReminder(other, { kind: "sale_window", title: "Synthetic sale opens (test fixture)", dueAt, leadMinutes: [60] });
    const dropped = await setReminder(other, { kind: "other", title: "Synthetic reminder that is removed (test fixture)", dueAt, leadMinutes: [60] });
    await cancelReminder(other, String(dropped.result.reminderId));
    await fixtureCalls(mine);

    // Not due yet: nothing is sent.
    await deliverNotifications(app, Date.now());
    expect(await fixtureCalls(mine)).toEqual([]);

    // An hour before the time (the lead the reminder asked for) it is due.
    await deliverNotifications(app, Date.parse(dueAt) - HOUR + 1000);
    const sent = (await fixtureCalls(mine)).map((c) => JSON.parse(c.body));
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.aps.alert.title).toBe("Synthetic sale opens (test fixture)");
    expect(sent[0].payload.garderobe).toMatchObject({ kind: "notification.reminder", reminderId: String(kept.result.reminderId) });
    expect((await effects(other, "notification.reminder")).map((e) => e.state).sort()).toEqual(["cancelled", "projected"]);

    await deliverNotifications(app, Date.parse(dueAt) - HOUR + 120_000);
    expect(await fixtureCalls(mine)).toEqual([]);
  });
});
