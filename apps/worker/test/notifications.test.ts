import { beforeAll, describe, expect, it } from "vitest";
import { deliverNotifications } from "../src/notifications/service.ts";
import { ownerDay, provisionOwner, publishBoard, testApp, type TestOwner } from "../src/testing/index.ts";

/*
 * Morning notification delivery through the real Worker with the REAL owner fixture. Stand-ins:
 * test-signed Access assertions, and the labelled APNs fixture (`apns.fixture.test`), which verifies the
 * provider token's ES256 signature and required headers but is not Apple: delivery to a real iPhone is a
 * device check for the deployment.
 */
let owner: TestOwner;
/** A day as the owner counts it (every owner here is the real fixture, so one timezone), not the UTC date. */
const day = (offset: number) => ownerDay(owner, offset);
const hex = (prefix: string) => (prefix + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")).slice(0, 64);
const apnsCalls = async () => ((await (await fetch("https://google.fixture.test/__calls?method=APNS")).json()) as { method: string; url: string; body: string }[]).map((c) => ({ device: c.url.split("/").at(-1), ...JSON.parse(c.body) }));

async function present(target: TestOwner, localDate: string): Promise<void> {
  const app = await testApp();
  await publishBoard(target, { date: localDate });
  // What the daily service's morning phase does: mark the board presented, which queues the reminder.
  await app.service.execute(target.systemPrincipal, { type: "board.present", payload: { localDate, scope: "home" }, idempotencyKey: `present:${target.userId}:${localDate}`, expectedVersions: {}, authorization: "system_schedule", source: { channel: "system" } });
}
const effectsOf = async (target: TestOwner) => (await (await testApp()).db.prepare("SELECT state, attempts, target_key FROM effects WHERE user_id = ? AND kind = 'notification.morning_board' ORDER BY created_at").bind(target.userId).all<{ state: string; attempts: number; target_key: string }>()).results;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  await apnsCalls();
});

describe("registering a device", () => {
  it("keeps the token encrypted, never returns it, and one phone belongs to one owner at a time", async () => {
    const token = hex("a1b2");
    const registered = await owner.api.json("POST", "/v1/devices", { deviceId: "iphone-owner-0001", token, environment: "development" });
    expect(registered).toMatchObject({ deviceId: "iphone-owner-0001", status: "active" });
    const listed = await owner.api.json("GET", "/v1/devices");
    expect(listed.deliveryConfigured).toBe(true);
    expect(listed.devices).toHaveLength(1);
    expect(JSON.stringify([registered, listed])).not.toContain(token);
    const app = await testApp();
    expect(JSON.stringify((await app.db.prepare("SELECT * FROM notification_devices").all()).results)).not.toContain(token);
    expect((await owner.api.post("/v1/devices", { deviceId: "iphone-owner-0001", token: "not-a-token", environment: "development" })).status).toBe(400);

    // The same phone signs in to another account: the token moves, it is not delivered to both.
    const other = await provisionOwner();
    await other.api.json("POST", "/v1/devices", { deviceId: "iphone-other-0001", token, environment: "development" });
    expect((await owner.api.json("GET", "/v1/devices")).devices).toEqual([]);
    expect((await other.api.json("GET", "/v1/devices")).devices).toHaveLength(1);
    await other.api.json("POST", "/v1/devices/iphone-other-0001/remove", {});
    expect((await other.api.json("GET", "/v1/devices")).devices).toEqual([]);
    await owner.api.json("POST", "/v1/devices", { deviceId: "iphone-owner-0001", token, environment: "development" });
  });
});

describe("the morning notification", () => {
  it("is sent once when the board is presented, says where to look and nothing about the outfit", async () => {
    const app = await testApp();
    await present(owner, await day(0));
    expect((await effectsOf(owner)).map((e) => e.state)).toEqual(["pending"]);

    const first = await deliverNotifications(app, Date.now());
    expect(first).toMatchObject({ sent: 1, failed: 0, retried: 0 });
    const sent = await apnsCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ providerTokenValid: true, topic: "com.example.garderobe.test", pushType: "alert" });
    expect(sent[0].collapseId).toMatch(/^[0-9a-f]{48}$/);
    expect(sent[0].payload.aps.alert).toEqual({ title: "Today's outfits are ready", body: "Open Garderobe to see today's board." });
    expect(sent[0].payload.garderobe).toMatchObject({ kind: "notification.morning_board", localDate: await day(0) });
    // No garment, colour or outfit text leaves the service in a push.
    const board = (await owner.api.json("GET", `/v1/today?date=${await day(0)}`)).board;
    for (const option of board.options) for (const garment of option.garments) expect(JSON.stringify(sent[0].payload)).not.toContain(garment.name);
    expect((await effectsOf(owner)).map((e) => e.state)).toEqual(["projected"]);
    expect((await owner.api.json("GET", "/v1/devices")).devices[0].lastDeliveryAt).toBeTruthy();

    // A second sweep, and presenting the same day again, send nothing more.
    await present(owner, await day(0));
    expect(await deliverNotifications(app, Date.now())).toMatchObject({ claimed: 0, sent: 0 });
    expect(await apnsCalls()).toEqual([]);
  });

  it("is not sent late: a reminder still waiting hours after it was queued is cancelled, not delivered", async () => {
    const app = await testApp();
    await present(owner, await day(1));
    const late = await deliverNotifications(app, Date.now() + 7 * 3_600_000);
    expect(late).toMatchObject({ sent: 0, cancelled: 1 });
    expect(await apnsCalls()).toEqual([]);
    expect((await effectsOf(owner)).map((e) => e.state)).toEqual(["projected", "cancelled"]);
  });

  it("stays pending and visible while delivery is not configured, instead of being marked sent", async () => {
    const app = await testApp();
    await present(owner, await day(2));
    const topic = app.env.APNS_TOPIC;
    delete app.env.APNS_TOPIC;
    try {
      expect((await owner.api.json("GET", "/v1/devices")).deliveryConfigured).toBe(false);
      expect(await deliverNotifications(app, Date.now())).toMatchObject({ claimed: 0, sent: 0 });
      expect((await effectsOf(owner)).at(-1)!.state).toBe("pending");
    } finally {
      app.env.APNS_TOPIC = topic!;
    }
    expect(await deliverNotifications(app, Date.now())).toMatchObject({ sent: 1 });
    await apnsCalls();
  });

  it("retries when the push service is unavailable, and stops using a device the service says is gone", async () => {
    const app = await testApp();
    const busy = await provisionOwner({ real: true });
    await busy.api.json("POST", "/v1/devices", { deviceId: "iphone-busy-0001", token: hex("5e5e"), environment: "production" });
    await present(busy, await day(0));
    const gone = await provisionOwner({ real: true });
    await gone.api.json("POST", "/v1/devices", { deviceId: "iphone-gone-0001", token: hex("dead"), environment: "production" });
    await present(gone, await day(0));

    const result = await deliverNotifications(app, Date.now());
    expect(result).toMatchObject({ sent: 0, retried: 1, failed: 1, devicesDisabled: 1 });
    expect((await effectsOf(busy)).map((e) => e.state)).toEqual(["pending"]); // will be tried again later
    expect(await deliverNotifications(app, Date.now())).toMatchObject({ claimed: 0 }); // not before its retry time
    expect((await effectsOf(gone)).map((e) => e.state)).toEqual(["failed"]);
    expect((await gone.api.json("GET", "/v1/devices")).devices[0]).toMatchObject({ status: "disabled" });
    await apnsCalls();
  });

  it("with no registered device nothing is sent and nothing is recorded as delivered", async () => {
    const app = await testApp();
    const quiet = await provisionOwner({ real: true });
    await present(quiet, await day(0));
    expect(await deliverNotifications(app, Date.now())).toMatchObject({ sent: 0, cancelled: 1 });
    expect((await effectsOf(quiet)).map((e) => e.state)).toEqual(["cancelled"]);
    expect(await apnsCalls()).toEqual([]);
  });
});
