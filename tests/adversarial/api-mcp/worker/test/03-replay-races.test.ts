import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanGarment,
  connectMcp,
  count,
  createWorld,
  defect,
  fingerprint,
  ownerDay,
  publishBoard,
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

/*
 * THREAT CLASS 3: idempotency, replay, concurrency and race conditions on the command ledger.
 *
 * Real Worker, real D1, real MCP server (the SDK client over the real OAuth consent flow). `real` is the
 * owner's imported profile and inventory; `synthetic` and `collider` are LABELLED SYNTHETIC owners whose
 * garment IDs are identical on purpose, so a replayed key or batch that crossed owners would land on a
 * garment that exists on both sides. Every garment created here is `isSynthetic: true` and named SYNTHETIC.
 *
 * Specification: section 8 ("A command is a verified change", "Concurrent actions and external effects"),
 * section 5 ("One counted wear per garment and wearing date", "Owner observations and accounting repair"),
 * section 17 rows "Quantities", "Wear correction" and "Concurrency".
 */

interface Outcome {
  status: number;
  receipt: any;
  error: ApiErrorBody | null;
}

let world: World;
let collider: TestOwner;
let syntheticMcp: McpConnection;
let realMcp: McpConnection;

const NOTE = "synthetic test fixture - not the owner's wardrobe";
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const uid = (label: string): string => `adv03-${label}-${crypto.randomUUID()}`;

/** One command through a given API client (the iOS client by default, or the owner's web session). */
async function send(api: ApiClient, type: string, payload: Record<string, unknown>, opts: { idempotencyKey?: string; expectedVersions?: Record<string, number>; occurredAt?: string } = {}): Promise<Outcome> {
  const response = await api.command(type, payload, opts);
  const body = (await response.json()) as any;
  return response.ok ? { status: response.status, receipt: body, error: null } : { status: response.status, receipt: null, error: body.error };
}

/** The envelope the phone would queue for offline replay. */
const queued = (type: string, payload: Record<string, unknown>, idempotencyKey: string, extra: Record<string, unknown> = {}) => ({ type, payload, idempotencyKey, expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios" }, ...extra });

async function batch(owner: TestOwner, commands: unknown[]): Promise<{ status: number; results: any[]; wardrobeRevision: number; error: ApiErrorBody | null }> {
  const response = await owner.api.post("/v1/commands/batch", { commands });
  const body = (await response.json()) as any;
  return { status: response.status, results: body.results ?? [], wardrobeRevision: body.wardrobeRevision ?? -1, error: body.error ?? null };
}

/** One typed command from a connected assistant (the real `garderobe_command` tool). */
async function viaMcp(mcp: McpConnection, type: string, payload: Record<string, unknown>, opts: { idempotencyKey: string; expectedVersions?: Record<string, number>; occurredAt?: string }): Promise<{ receipt: any; error: ApiErrorBody | null }> {
  const args = { type, payload, idempotencyKey: opts.idempotencyKey, ...(opts.expectedVersions ? { expectedVersions: opts.expectedVersions } : {}), ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}) };
  const result = toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: args }));
  return result.ok ? { receipt: result.data.receipt, error: null } : { receipt: null, error: result.error as ApiErrorBody };
}

/** A labelled synthetic garment for one test. */
async function make(owner: TestOwner, garmentId: string, opts: { care?: "service" | "handwash" | "none"; quantity?: number; acquisition?: "owned" | "incoming" } = {}): Promise<void> {
  const care = opts.care ?? "service";
  const created = await submit(owner, "garment.create", {
    garmentId,
    name: `SYNTHETIC ${garmentId} (adversarial fixture)`,
    category: care === "handwash" ? "socks" : care === "none" ? "belt" : "shirt",
    roles: [care === "handwash" ? "socks" : care === "none" ? "belt" : "top"],
    careChannel: care,
    acquisition: opts.acquisition ?? "owned",
    quantity: opts.quantity ?? 1,
    isSynthetic: true,
    source: { kind: "owner_statement", note: NOTE },
  });
  if (created.status !== 200) throw new Error(`fixture: creating ${garmentId} failed: ${created.status} ${JSON.stringify(created.error)}`);
}

/** Units per bucket for one garment, straight from the materialized balances. */
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

const liveEvents = (owner: TestOwner, garmentId: string, kind?: string) =>
  sql<{ event_id: string; kind: string; command_id: string; payload_json: string }>(
    `SELECT event_id, kind, command_id, payload_json FROM stock_events WHERE user_id = ? AND garment_id = ? AND voided_by_command_id IS NULL${kind ? " AND kind = ?" : ""} ORDER BY seq`,
    ...(kind ? [owner.userId, garmentId, kind] : [owner.userId, garmentId]),
  );

const rowsForKey = (owner: TestOwner, key: string) => sql<{ command_id: string; type: string; channel: string; actor: string; undone_by_command_id: string | null }>("SELECT command_id, type, channel, actor, undone_by_command_id FROM commands WHERE user_id = ? AND idempotency_key = ?", owner.userId, key);

/**
 * The owner's fingerprint once background follow-up work of earlier commands has finished, so a later
 * comparison only sees what the attack itself wrote. "Finished" means a sustained quiet interval: at least
 * four consecutive readings, 100 ms apart, equal to the one before them and spanning at least 500 ms. When
 * the fingerprint does not go quiet within 30 s this throws, naming the fingerprint entries that were still
 * changing (never their values): background work that never settles is a finding, not a baseline.
 */
async function settled(owner: TestOwner): Promise<Record<string, unknown>> {
  const intervalMs = 100;
  const quietMs = 500;
  const minEqualReadings = 4;
  const timeoutMs = 30_000;
  const started = Date.now();
  let previous = await fingerprint(owner);
  let quietSince = Date.now();
  let equalReadings = 0;
  let changes = 0;
  let lastChanged: string[] = [];
  while (Date.now() - started < timeoutMs) {
    await sleep(intervalMs);
    const next = await fingerprint(owner);
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
    if (changed.length === 0) {
      equalReadings++;
      if (equalReadings >= minEqualReadings && Date.now() - quietSince >= quietMs) return next;
      continue;
    }
    changes++;
    lastChanged = changed;
    previous = next;
    equalReadings = 0;
    quietSince = Date.now();
  }
  throw new Error(`fixture: the owner's fingerprint did not stay unchanged for ${quietMs} ms within ${timeoutMs} ms (${changes} changes seen; last change in: ${lastChanged.join(", ") || "none seen"})`);
}

const pendingProposals = async (owner: TestOwner): Promise<any[]> => (await owner.api.json("GET", "/v1/proposals")).proposals;

async function boardFor(owner: TestOwner, date: string): Promise<any> {
  const published = await publishBoard(owner, { date });
  if (published.board) return published.board;
  for (let i = 0; i < 200; i++) {
    const today = await owner.api.json("GET", `/v1/today?date=${date}`);
    if (today.board) return today.board;
    await sleep(50);
  }
  throw new Error(`fixture: no board was published for ${date}`);
}

beforeAll(async () => {
  world = await createWorld();
  collider = await syntheticOwner("Synthetic colliding owner (adversarial test fixture)");
  syntheticMcp = await connectMcp(world.synthetic, { write: true, clientName: "Replay assistant (synthetic owner)" });
  realMcp = await connectMcp(world.real, { write: true, clientName: "Replay assistant (real owner fixture)" });
});

afterAll(async () => {
  await syntheticMcp?.close();
  await realMcp?.close();
});

describe("one idempotency key is one command", () => {
  it("the same key and body replayed over HTTP returns the same receipt and writes one command and one stock event", async () => {
    const owner = world.real;
    const item = await cleanGarment(owner, "socks");
    const id = item.garment.garmentId;
    const before = await buckets(owner, id);
    const commandsBefore = await count("commands", owner.userId);
    const key = uid("same");
    const payload = { items: [{ garmentId: id, quantity: 1 }] };

    const first = await submit(owner, "care.mark_dirty", payload, { idempotencyKey: key });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.receipt).toMatchObject({ type: "care.mark_dirty", outcome: "committed", replayed: false, actor: "owner", channel: "ios" });

    for (let i = 0; i < 3; i++) {
      const again = await submit(owner, "care.mark_dirty", payload, { idempotencyKey: key });
      expect(again.status).toBe(200);
      expect(again.receipt.replayed).toBe(true);
      // The stored receipt, not a recomputed one: everything but the replay flag is identical.
      expect({ ...again.receipt, replayed: false }).toEqual(first.receipt);
    }

    expect(await rowsForKey(owner, key)).toHaveLength(1);
    expect(await count("commands", owner.userId)).toBe(commandsBefore + 1);
    expect(await sql("SELECT event_id FROM stock_events WHERE user_id = ? AND command_id = ?", owner.userId, first.receipt.commandId)).toHaveLength(1);
    const after = await buckets(owner, id);
    expect(after.clean ?? 0).toBe((before.clean ?? 0) - 1);
    expect(after.dirty ?? 0).toBe((before.dirty ?? 0) + 1);
    expect(units(after)).toBe(units(before));
    // The receipt can be found again by the key (a client whose response was lost).
    const found = (await owner.api.json("GET", `/v1/commands?idempotencyKey=${encodeURIComponent(key)}`)).receipts;
    expect(found.map((r: any) => r.commandId)).toEqual([first.receipt.commandId]);
  });

  it("a used key with a different payload, type, time, version set or authorization is refused and writes nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-reuse", { quantity: 3 });
    const key = uid("reuse");
    const at = iso(Date.now() - 3_600_000);
    const first = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-reuse", quantity: 1 }] }, { idempotencyKey: key, occurredAt: at });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const before = await settled(owner);

    const attempts: [string, () => Promise<Response>][] = [
      ["different payload", () => owner.api.command("care.mark_dirty", { items: [{ garmentId: "syn03-reuse", quantity: 2 }] }, { idempotencyKey: key, occurredAt: at })],
      ["different type", () => owner.api.command("care.washed", { items: [{ garmentId: "syn03-reuse", quantity: 1 }] }, { idempotencyKey: key, occurredAt: at })],
      ["different occurredAt", () => owner.api.command("care.mark_dirty", { items: [{ garmentId: "syn03-reuse", quantity: 1 }] }, { idempotencyKey: key, occurredAt: iso(Date.now() - 7_200_000) })],
      ["no occurredAt", () => owner.api.command("care.mark_dirty", { items: [{ garmentId: "syn03-reuse", quantity: 1 }] }, { idempotencyKey: key })],
      ["different expected versions", () => owner.api.command("care.mark_dirty", { items: [{ garmentId: "syn03-reuse", quantity: 1 }] }, { idempotencyKey: key, occurredAt: at, expectedVersions: { wardrobe: 0 } })],
      ["different authorization", () => owner.api.post("/v1/commands", queued("care.mark_dirty", { items: [{ garmentId: "syn03-reuse", quantity: 1 }] }, key, { occurredAt: at, authorization: "owner_statement" }))],
      ["a retirement under the same key", () => owner.api.command("garment.retire", { garmentId: "syn03-reuse", disposition: "discarded" }, { idempotencyKey: key, occurredAt: at })],
    ];
    for (const [label, attempt] of attempts) {
      const response = await attempt();
      const body = (await response.json()) as any;
      expect(response.status, `${label}: ${JSON.stringify(body)}`).toBe(409);
      expect(body.error.code, label).toBe("idempotency_key_reuse");
    }
    expect(await fingerprint(owner)).toEqual(before);
    expect(await rowsForKey(owner, key)).toHaveLength(1);
    expect(await buckets(owner, "syn03-reuse")).toEqual({ clean: 2, dirty: 1 });
    // The original is still what the key answers with.
    const replay = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-reuse", quantity: 1 }] }, { idempotencyKey: key, occurredAt: at });
    expect(replay.receipt).toMatchObject({ commandId: first.receipt.commandId, replayed: true });
  });

  it("the same request with its JSON keys in another order is the same request, not a second command", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-order", { quantity: 2 });
    const key = uid("order");
    const date = await ownerDay(owner, 0);
    const first = await owner.api.post("/v1/commands", { type: "wear.record", payload: { wearingDate: date, garmentIds: ["syn03-order"], note: "SYNTHETIC note" }, idempotencyKey: key, expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios" } });
    expect(first.status).toBe(200);
    const firstReceipt = (await first.json()) as any;
    const reordered = await owner.api.post("/v1/commands", { source: { channel: "ios" }, authorization: "owner_tap", expectedVersions: {}, idempotencyKey: key, payload: { note: "SYNTHETIC note", garmentIds: ["syn03-order"], wearingDate: date }, type: "wear.record" });
    expect(reordered.status).toBe(200);
    expect((await reordered.json()) as any).toMatchObject({ commandId: firstReceipt.commandId, replayed: true });
    expect(await rowsForKey(owner, key)).toHaveLength(1);
    expect(await liveEvents(owner, "syn03-order", "wear")).toHaveLength(1);
    expect(await buckets(owner, "syn03-order")).toEqual({ clean: 1, dirty: 1 });
  });

  it("a refused command reserves nothing: the key then commits exactly once, and the refusal wrote nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-retry");
    const key = uid("retry");
    const before = await settled(owner);
    const unknown = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-no-such-garment" }] }, { idempotencyKey: key });
    expect(unknown.status).toBe(404);
    expect(unknown.error!.code).toBe("not_found");
    const invalid = await submit(owner, "care.mark_dirty", { items: [] }, { idempotencyKey: key });
    expect(invalid.status).toBe(400);
    expect(invalid.error!.code).toBe("invalid_command");
    const future = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-retry" }] }, { idempotencyKey: key, occurredAt: iso(Date.now() + 86_400_000) });
    expect(future.status).toBe(400);
    expect(await fingerprint(owner)).toEqual(before);
    expect(await rowsForKey(owner, key)).toHaveLength(0);

    const valid = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-retry" }] }, { idempotencyKey: key });
    expect(valid.status, JSON.stringify(valid.error)).toBe(200);
    expect(valid.receipt.replayed).toBe(false);
    // The earlier refused bodies are now a different body for a used key.
    const afterwards = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-no-such-garment" }] }, { idempotencyKey: key });
    expect(afterwards.error!.code).toBe("idempotency_key_reuse");
    expect(await rowsForKey(owner, key)).toHaveLength(1);
    expect(await buckets(owner, "syn03-retry")).toEqual({ dirty: 1 });
  });

  it("a missing, short, oversized or non-text idempotency key is refused and writes nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-keys", { quantity: 2 });
    const before = await settled(owner);
    const payload = { items: [{ garmentId: "syn03-keys", quantity: 1 }] };
    const bad: [string, unknown][] = [
      ["missing", undefined],
      ["seven characters", "1234567"],
      ["201 characters", "k".repeat(201)],
      ["empty", ""],
      ["a number", 1234567890],
      ["null", null],
      ["an object", { key: "adv03-object-key" }],
      ["an array", ["adv03-array-key"]],
    ];
    for (const [label, key] of bad) {
      const envelope: Record<string, unknown> = queued("care.mark_dirty", payload, "placeholder-key");
      if (key === undefined) delete envelope.idempotencyKey;
      else envelope.idempotencyKey = key;
      const response = await owner.api.post("/v1/commands", envelope);
      const body = (await response.json()) as any;
      expect(response.status, `${label}: ${JSON.stringify(body)}`).toBe(400);
      expect(body.error.code, label).toBe("invalid_command");
    }
    expect(await fingerprint(owner)).toEqual(before);
    expect(await buckets(owner, "syn03-keys")).toEqual({ clean: 2 });

    // The boundary itself is accepted, once.
    const longest = "K".repeat(200);
    const accepted = await submit(owner, "care.mark_dirty", payload, { idempotencyKey: longest });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
    expect((await submit(owner, "care.mark_dirty", payload, { idempotencyKey: longest })).receipt.replayed).toBe(true);
    expect(await buckets(owner, "syn03-keys")).toEqual({ clean: 1, dirty: 1 });
  });

  it("the same key used by three owners with colliding garment IDs gives each owner its own receipt and never another owner's", async () => {
    const a = world.synthetic;
    const b = collider;
    const key = uid("shared-across-owners");
    const body = { items: [{ garmentId: "sock-grey", quantity: 1 }] };
    const real = world.real;
    const realItem = await cleanGarment(real, "socks");
    const aBefore = await buckets(a, "sock-grey");
    const bBefore = await buckets(b, "sock-grey");

    const forA = await submit(a, "care.mark_dirty", body, { idempotencyKey: key });
    expect(forA.status, JSON.stringify(forA.error)).toBe(200);
    expect(forA.receipt.replayed).toBe(false);
    const aAfterOwn = await settled(a);

    // The colliding owner sends the very same bytes under the very same key.
    const forB = await submit(b, "care.mark_dirty", body, { idempotencyKey: key });
    expect(forB.status, JSON.stringify(forB.error)).toBe(200);
    expect(forB.receipt.replayed).toBe(false);
    expect(forB.receipt.commandId).not.toBe(forA.receipt.commandId);
    const forReal = await submit(real, "care.mark_dirty", { items: [{ garmentId: realItem.garment.garmentId, quantity: 1 }] }, { idempotencyKey: key });
    expect(forReal.status, JSON.stringify(forReal.error)).toBe(200);
    expect(forReal.receipt.replayed).toBe(false);
    expect(await fingerprint(a)).toEqual(aAfterOwn);

    // The real owner's key with the synthetic owner's body: its own conflict, naming only its own command.
    const crossed = await submit(real, "care.mark_dirty", body, { idempotencyKey: key });
    expect(crossed.status).toBe(409);
    expect(crossed.error!.code).toBe("idempotency_key_reuse");
    const leaked = JSON.stringify(crossed.error);
    expect(leaked).not.toContain(forA.receipt.commandId);
    expect(leaked).not.toContain(forB.receipt.commandId);

    // Each owner's replay answers with that owner's command.
    expect((await submit(a, "care.mark_dirty", body, { idempotencyKey: key })).receipt).toMatchObject({ commandId: forA.receipt.commandId, replayed: true });
    expect((await submit(b, "care.mark_dirty", body, { idempotencyKey: key })).receipt).toMatchObject({ commandId: forB.receipt.commandId, replayed: true });
    for (const [owner, own] of [[a, forA], [b, forB], [real, forReal]] as [TestOwner, Outcome][]) {
      const listed = (await owner.api.json("GET", `/v1/commands?idempotencyKey=${encodeURIComponent(key)}`)).receipts;
      expect(listed.map((r: any) => r.commandId)).toEqual([own.receipt.commandId]);
      expect(await rowsForKey(owner, key)).toHaveLength(1);
    }
    expect(await sql("SELECT user_id FROM commands WHERE idempotency_key = ? ORDER BY user_id", key)).toHaveLength(3);

    // Another owner's receipt cannot be read or undone by its identifier either.
    expect((await b.api.get(`/v1/commands/${forA.receipt.commandId}`)).status).toBe(404);
    expect((await real.api.get(`/v1/commands/${forA.receipt.commandId}`)).status).toBe(404);
    const stolenUndo = await submit(b, "command.undo", { commandId: forA.receipt.commandId });
    expect(stolenUndo.status).toBe(404);
    expect(stolenUndo.error!.code).toBe("not_found");
    expect(await fingerprint(a)).toEqual(aAfterOwn);
    expect((await rowsForKey(a, key))[0]!.undone_by_command_id).toBeNull();

    // One unit moved on each side, nothing more.
    const aAfter = await buckets(a, "sock-grey");
    const bAfter = await buckets(b, "sock-grey");
    expect((aAfter.dirty ?? 0) - (aBefore.dirty ?? 0)).toBe(1);
    expect((bAfter.dirty ?? 0) - (bBefore.dirty ?? 0)).toBe(1);
    expect(units(aAfter)).toBe(units(aBefore));
    expect(units(bAfter)).toBe(units(bBefore));
  });

  it("a key reused across HTTP, the offline batch and the MCP tool stays one command", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-channels", { quantity: 4 });
    const key = uid("channels");
    const payload = { items: [{ garmentId: "syn03-channels", quantity: 1 }] };

    const http = await submit(owner, "care.mark_dirty", payload, { idempotencyKey: key });
    expect(http.status, JSON.stringify(http.error)).toBe(200);
    const afterFirst = await settled(owner);

    // The phone's offline queue replays it.
    const replayed = await batch(owner, [queued("care.mark_dirty", payload, key)]);
    expect(replayed.status).toBe(200);
    expect(replayed.results).toHaveLength(1);
    expect(replayed.results[0]).toMatchObject({ status: "receipt", idempotencyKey: key, receipt: { commandId: http.receipt.commandId, replayed: true } });

    // The owner's browser session sends the same key and body.
    const web = await send(owner.api.with({ client: "web" }), "care.mark_dirty", payload, { idempotencyKey: key });
    expect(web.status, JSON.stringify(web.error)).toBe(200);
    expect(web.receipt).toMatchObject({ commandId: http.receipt.commandId, replayed: true, channel: "ios" });

    // A connected assistant sends the same key: the stored receipt or a refusal, never a second change.
    const mcp = await viaMcp(syntheticMcp, "care.mark_dirty", payload, { idempotencyKey: key });
    if (mcp.receipt) expect(mcp.receipt).toMatchObject({ commandId: http.receipt.commandId, replayed: true });
    else expect(mcp.error!.code).toBe("idempotency_key_reuse");

    expect(await fingerprint(owner)).toEqual(afterFirst);
    expect(await rowsForKey(owner, key)).toHaveLength(1);
    expect(await buckets(owner, "syn03-channels")).toEqual({ clean: 3, dirty: 1 });

    // The other direction: a key first used by the assistant, then replayed by the app.
    const assistantKey = uid("channels-mcp-first");
    const direct = await viaMcp(syntheticMcp, "care.mark_dirty", payload, { idempotencyKey: assistantKey });
    expect(direct.error, JSON.stringify(direct.error)).toBeNull();
    expect(direct.receipt).toMatchObject({ replayed: false, actor: "assistant", channel: "mcp" });
    const again = await viaMcp(syntheticMcp, "care.mark_dirty", payload, { idempotencyKey: assistantKey });
    expect(again.receipt).toMatchObject({ commandId: direct.receipt.commandId, replayed: true });
    const afterAssistant = await settled(owner);
    const fromApp = await submit(owner, "care.mark_dirty", payload, { idempotencyKey: assistantKey });
    if (fromApp.receipt) expect(fromApp.receipt).toMatchObject({ commandId: direct.receipt.commandId, replayed: true, actor: "assistant" });
    else expect(fromApp.error!.code).toBe("idempotency_key_reuse");
    const fromBatch = (await batch(owner, [queued("care.mark_dirty", payload, assistantKey)])).results[0];
    if (fromBatch.status === "receipt") expect(fromBatch.receipt).toMatchObject({ commandId: direct.receipt.commandId, replayed: true });
    else expect(fromBatch.error.code).toBe("idempotency_key_reuse");
    expect(await fingerprint(owner)).toEqual(afterAssistant);
    expect(await rowsForKey(owner, assistantKey)).toEqual([expect.objectContaining({ command_id: direct.receipt.commandId, channel: "mcp", actor: "assistant" })]);
    expect(await buckets(owner, "syn03-channels")).toEqual({ clean: 2, dirty: 2 });
  });

  it("twelve parallel submissions of one key commit exactly once", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-parallel", { quantity: 12 });
    const key = uid("parallel");
    const payload = { items: [{ garmentId: "syn03-parallel", quantity: 1 }] };
    const results = await Promise.all(Array.from({ length: 12 }, () => submit(owner, "care.mark_dirty", payload, { idempotencyKey: key })));
    for (const r of results) expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(new Set(results.map((r) => r.receipt.commandId)).size).toBe(1);
    expect(results.filter((r) => r.receipt.replayed === false)).toHaveLength(1);
    expect(await rowsForKey(owner, key)).toHaveLength(1);
    expect(await liveEvents(owner, "syn03-parallel", "mark_dirty")).toHaveLength(1);
    expect(await buckets(owner, "syn03-parallel")).toEqual({ clean: 11, dirty: 1 });
  });

  it("one key raced through HTTP, the batch route, the web session and the MCP tool at once is still one command", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-mixed", { quantity: 12 });
    const key = uid("mixed");
    const payload = { items: [{ garmentId: "syn03-mixed", quantity: 1 }] };
    const web = owner.api.with({ client: "web" });
    const [http, viaBatch, viaWeb, viaTool] = await Promise.all([
      Promise.all(Array.from({ length: 3 }, () => submit(owner, "care.mark_dirty", payload, { idempotencyKey: key }))),
      Promise.all(Array.from({ length: 3 }, () => batch(owner, [queued("care.mark_dirty", payload, key)]))),
      Promise.all(Array.from({ length: 3 }, () => send(web, "care.mark_dirty", payload, { idempotencyKey: key }))),
      Promise.all(Array.from({ length: 3 }, () => viaMcp(syntheticMcp, "care.mark_dirty", payload, { idempotencyKey: key }))),
    ]);
    const rows = await rowsForKey(owner, key);
    expect(rows).toHaveLength(1);
    const winner = rows[0]!.command_id;
    // Every answer is the one stored receipt, or a clean refusal for a body that differs by its authorization.
    for (const r of [...http, ...viaWeb]) {
      if (r.receipt) expect(r.receipt.commandId).toBe(winner);
      else expect(r.error!.code).toBe("idempotency_key_reuse");
    }
    for (const b of viaBatch) {
      expect(b.status).toBe(200);
      const item = b.results[0];
      if (item.status === "receipt") expect(item.receipt.commandId).toBe(winner);
      else expect(item.error.code).toBe("idempotency_key_reuse");
    }
    for (const r of viaTool) {
      if (r.receipt) expect(r.receipt.commandId).toBe(winner);
      else expect(r.error!.code).toBe("idempotency_key_reuse");
    }
    const fresh = [...http, ...viaWeb, ...viaTool].filter((r) => r.receipt && r.receipt.replayed === false).length + viaBatch.filter((b) => b.results[0].status === "receipt" && b.results[0].receipt.replayed === false).length;
    expect(fresh).toBe(1);
    expect(await liveEvents(owner, "syn03-mixed", "mark_dirty")).toHaveLength(1);
    expect(await buckets(owner, "syn03-mixed")).toEqual({ clean: 11, dirty: 1 });
  });
});

describe("the offline batch", () => {
  it("answers a duplicated key inside one batch with the first command's receipt and refuses a changed body, in order", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-dup", { quantity: 5 });
    const key = uid("dup");
    const one = { items: [{ garmentId: "syn03-dup", quantity: 1 }] };
    const result = await batch(owner, [queued("care.mark_dirty", one, key), queued("care.mark_dirty", one, key), queued("care.mark_dirty", { items: [{ garmentId: "syn03-dup", quantity: 3 }] }, key), queued("care.washed", one, key), queued("care.mark_dirty", one, key)]);
    expect(result.status).toBe(200);
    expect(result.results.map((r) => r.status)).toEqual(["receipt", "receipt", "error", "error", "receipt"]);
    expect(result.results.map((r) => r.idempotencyKey)).toEqual([key, key, key, key, key]);
    const commandId = result.results[0].receipt.commandId;
    expect(result.results[0].receipt.replayed).toBe(false);
    expect(result.results[1].receipt).toMatchObject({ commandId, replayed: true });
    expect(result.results[4].receipt).toMatchObject({ commandId, replayed: true });
    for (const refusedItem of [result.results[2], result.results[3]]) {
      expect(refusedItem.error.code).toBe("idempotency_key_reuse");
      expect(refusedItem.retryable).toBe(false);
    }
    expect(await rowsForKey(owner, key)).toHaveLength(1);
    expect(await buckets(owner, "syn03-dup")).toEqual({ clean: 4, dirty: 1 });
  });

  it("runs each command of a partly invalid batch on its own: valid ones commit, each invalid one is reported and writes nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-partial-a");
    await make(owner, "syn03-partial-b");
    const keys = Array.from({ length: 8 }, (_, i) => uid(`partial-${i}`));
    const commandsBefore = await count("commands", owner.userId);
    const withoutKey: Record<string, unknown> = queued("care.mark_dirty", { items: [{ garmentId: "syn03-partial-b" }] }, "placeholder-key");
    delete withoutKey.idempotencyKey;
    const result = await batch(owner, [
      queued("care.mark_dirty", { items: [{ garmentId: "syn03-partial-a" }] }, keys[0]!),
      queued("care.mark_dirty", { items: [{ garmentId: "syn03-not-a-garment" }] }, keys[1]!),
      queued("wardrobe.write_anything", { sql: "DELETE FROM garments" }, keys[2]!),
      queued("wear.record", { wearingDate: "2026-02-30", garmentIds: ["syn03-partial-b"] }, keys[3]!),
      withoutKey,
      queued("care.mark_dirty", { items: [{ garmentId: "syn03-partial-b" }] }, keys[5]!, { authorization: "owner_statement", source: { channel: "mcp" } }),
      queued("stock.reconcile", { garmentId: "syn03-partial-b", counts: { clean: 7 } }, keys[6]!, { expectedVersions: { "garment:syn03-partial-b": 99 } }),
      queued("care.mark_dirty", { items: [{ garmentId: "syn03-partial-b" }] }, keys[7]!),
    ]);
    expect(result.status).toBe(200);
    expect(result.results).toHaveLength(8);
    expect(result.results.map((r) => (r.status === "receipt" ? "receipt" : r.error.code))).toEqual(["receipt", "not_found", "unknown_command", "invalid_command", "invalid_command", "forbidden", "conflict", "receipt"]);
    expect(result.results.map((r) => r.idempotencyKey)).toEqual([keys[0], keys[1], keys[2], keys[3], "", keys[5], keys[6], keys[7]]);
    for (const r of result.results.filter((x) => x.status === "error")) expect(r.retryable).toBe(false);
    // Exactly the two valid commands are in the ledger; nothing of the refused ones is.
    expect(await count("commands", owner.userId)).toBe(commandsBefore + 2);
    for (const key of [keys[1]!, keys[2]!, keys[3]!, keys[5]!, keys[6]!]) expect(await rowsForKey(owner, key)).toHaveLength(0);
    expect(await buckets(owner, "syn03-partial-a")).toEqual({ dirty: 1 });
    expect(await buckets(owner, "syn03-partial-b")).toEqual({ dirty: 1 });
    expect(await sql("SELECT garment_id FROM daily_wears WHERE user_id = ? AND garment_id = ?", owner.userId, "syn03-partial-b")).toHaveLength(0);
    const state = await sql<{ wardrobe_revision: number }>("SELECT wardrobe_revision FROM owner_state WHERE user_id = ?", owner.userId);
    expect(result.wardrobeRevision).toBe(state[0]!.wardrobe_revision);
    expect(result.results[7].receipt.wardrobeRevision).toBe(state[0]!.wardrobe_revision);
  });

  it("refuses an oversized, empty or malformed batch as a whole and writes nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-big", { quantity: 60 });
    const before = await settled(owner);
    const one = { items: [{ garmentId: "syn03-big", quantity: 1 }] };
    const tooMany = await batch(owner, Array.from({ length: 51 }, (_, i) => queued("care.mark_dirty", one, uid(`big-${i}`))));
    expect(tooMany.status).toBe(400);
    expect(tooMany.error!.code).toBe("invalid_command");
    const empty = await batch(owner, []);
    expect(empty.status).toBe(400);
    for (const body of [{ commands: "care.mark_dirty" }, { commands: null }, {}, { commands: ["not an object", 7] }, [queued("care.mark_dirty", one, uid("bare-array"))]]) {
      const response = await owner.api.post("/v1/commands/batch", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      await response.text();
    }
    expect(await fingerprint(owner)).toEqual(before);
    expect(await buckets(owner, "syn03-big")).toEqual({ clean: 60 });

    // The largest allowed batch is fifty independent commands, each with its own receipt.
    const full = await batch(owner, Array.from({ length: 50 }, (_, i) => queued("care.mark_dirty", one, uid(`full-${i}`))));
    expect(full.status).toBe(200);
    expect(full.results).toHaveLength(50);
    expect(full.results.every((r) => r.status === "receipt" && r.receipt.replayed === false)).toBe(true);
    expect(new Set(full.results.map((r) => r.receipt.commandId)).size).toBe(50);
    expect(await buckets(owner, "syn03-big")).toEqual({ clean: 10, dirty: 50 });
  });

  it("replaying a captured batch after one of its commands was undone re-applies nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-captured", { quantity: 2 });
    const date = await ownerDay(owner, 0);
    const captured = [queued("care.mark_dirty", { items: [{ garmentId: "syn03-captured", quantity: 1 }] }, uid("captured-dirty")), queued("wear.record", { wearingDate: date, garmentIds: ["syn03-captured"] }, uid("captured-wear"))];
    const first = await batch(owner, captured);
    expect(first.results.map((r) => r.status)).toEqual(["receipt", "receipt"]);
    expect(await buckets(owner, "syn03-captured")).toEqual({ dirty: 2 });

    const undone = await submit(owner, "command.undo", { commandId: first.results[1].receipt.commandId });
    expect(undone.status, JSON.stringify(undone.error)).toBe(200);
    expect(await buckets(owner, "syn03-captured")).toEqual({ clean: 1, dirty: 1 });
    const afterUndo = await settled(owner);

    for (let i = 0; i < 2; i++) {
      const replay = await batch(owner, captured);
      expect(replay.status).toBe(200);
      expect(replay.results.map((r) => r.status)).toEqual(["receipt", "receipt"]);
      expect(replay.results[0].receipt).toMatchObject({ commandId: first.results[0].receipt.commandId, replayed: true });
      expect(replay.results[1].receipt).toMatchObject({ commandId: first.results[1].receipt.commandId, replayed: true });
      // The replayed receipt of the undone wear says it can no longer be undone.
      expect(replay.results[1].receipt.undo.available).toBe(false);
    }
    expect(await fingerprint(owner)).toEqual(afterUndo);
    expect(await buckets(owner, "syn03-captured")).toEqual({ clean: 1, dirty: 1 });
    expect(await sql("SELECT status FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", owner.userId, "syn03-captured")).toHaveLength(0);
    // A second undo of the replayed command is refused.
    const secondUndo = await submit(owner, "command.undo", { commandId: first.results[1].receipt.commandId });
    expect(secondUndo.status).toBe(409);
    expect(secondUndo.error!.code).toBe("not_undoable");
    expect(await fingerprint(owner)).toEqual(afterUndo);
  });

  it("a batch captured from one owner and replayed by another runs only in the replaying owner's ledger", async () => {
    const victim = world.synthetic;
    const attacker = collider;
    const date = await ownerDay(victim, 0);
    // Garment IDs that exist for both synthetic owners.
    const captured = [queued("wear.record", { wearingDate: date, garmentIds: ["shirt-moss", "trouser-olive"] }, uid("stolen-wear")), queued("care.mark_dirty", { items: [{ garmentId: "shirt-gold" }] }, uid("stolen-dirty"))];
    const original = await batch(victim, captured);
    expect(original.results.map((r) => r.status)).toEqual(["receipt", "receipt"]);
    const victimAfter = await settled(victim);
    const attackerWearsBefore = await count("daily_wears", attacker.userId);

    const stolen = await batch(attacker, captured);
    expect(stolen.status).toBe(200);
    for (const [i, r] of stolen.results.entries()) {
      expect(r.status).toBe("receipt");
      // Not the victim's receipt: a new command of the attacker's own.
      expect(r.receipt.replayed).toBe(false);
      expect(r.receipt.commandId).not.toBe(original.results[i].receipt.commandId);
    }
    expect(await fingerprint(victim)).toEqual(victimAfter);
    expect(await count("daily_wears", attacker.userId)).toBe(attackerWearsBefore + 2);
    const owners = await sql<{ user_id: string }>("SELECT user_id FROM commands WHERE command_id = ?", stolen.results[0].receipt.commandId);
    expect(owners).toEqual([{ user_id: attacker.userId }]);
    // The victim's replay still answers with the victim's own receipts.
    const again = await batch(victim, captured);
    expect(again.results.map((r) => r.receipt.commandId)).toEqual(original.results.map((r) => r.receipt.commandId));
    expect(again.results.every((r) => r.receipt.replayed === true)).toBe(true);
  });

  it("three copies of one batch sent at the same time commit each key once", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-triple", { quantity: 9 });
    const keys = Array.from({ length: 5 }, (_, i) => uid(`triple-${i}`));
    const commands = keys.map((key) => queued("care.mark_dirty", { items: [{ garmentId: "syn03-triple", quantity: 1 }] }, key));
    const copies = await Promise.all([batch(owner, commands), batch(owner, commands), batch(owner, commands)]);
    for (const copy of copies) {
      expect(copy.status).toBe(200);
      expect(copy.results.map((r) => r.status)).toEqual(Array(5).fill("receipt"));
    }
    for (const [i, key] of keys.entries()) {
      const rows = await rowsForKey(owner, key);
      expect(rows).toHaveLength(1);
      for (const copy of copies) expect(copy.results[i].receipt.commandId).toBe(rows[0]!.command_id);
      expect(copies.filter((copy) => copy.results[i].receipt.replayed === false)).toHaveLength(1);
    }
    expect(await liveEvents(owner, "syn03-triple", "mark_dirty")).toHaveLength(5);
    expect(await buckets(owner, "syn03-triple")).toEqual({ clean: 4, dirty: 5 });
  });
});

describe("commands racing on the same stock", () => {
  it("the same wear reported at once by the phone, the browser and a connected assistant is counted once", async () => {
    const owner = world.real;
    const item = await cleanGarment(owner, "top");
    const id = item.garment.garmentId;
    const date = await ownerDay(owner, 0);
    const before = await buckets(owner, id);
    const web = owner.api.with({ client: "web" });
    const payload = { wearingDate: date, garmentIds: [id] };
    const [ios, browser, assistant] = await Promise.all([
      Promise.all(Array.from({ length: 3 }, () => submit(owner, "wear.record", payload))),
      Promise.all(Array.from({ length: 3 }, () => send(web, "wear.record", payload))),
      Promise.all(Array.from({ length: 2 }, (_, i) => viaMcp(realMcp, "wear.record", payload, { idempotencyKey: uid(`same-wear-mcp-${i}`) }))),
    ]);
    for (const r of [...ios, ...browser]) expect(r.status, JSON.stringify(r.error)).toBe(200);
    for (const r of assistant) expect(r.error, JSON.stringify(r.error)).toBeNull();
    const receipts = [...ios, ...browser, ...assistant].map((r) => r.receipt);
    // Eight separate commands (eight keys), one counted wear.
    expect(new Set(receipts.map((r) => r.commandId)).size).toBe(8);
    expect(receipts.filter((r) => (r.result.counted as string[]).includes(id))).toHaveLength(1);
    expect(receipts.filter((r) => r.outcome === "merged" && (r.result.merged as string[]).includes(id))).toHaveLength(7);

    const counted = await sql<{ observation_count: number; status: string }>("SELECT observation_count, status FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", owner.userId, id, date);
    expect(counted).toEqual([{ observation_count: 8, status: "active" }]);
    const observations = await sql<{ channel: string; n: number }>("SELECT channel, COUNT(*) AS n FROM wear_observations WHERE user_id = ? AND garment_id = ? AND wearing_date = ? AND status = 'active' GROUP BY channel ORDER BY channel", owner.userId, id, date);
    expect(observations).toEqual([{ channel: "ios", n: 3 }, { channel: "mcp", n: 2 }, { channel: "web", n: 3 }]);
    // One unit was consumed, not eight.
    expect(await liveEvents(owner, id, "wear")).toHaveLength(1);
    const after = await buckets(owner, id);
    expect(units(after)).toBe(units(before));
    expect(after.clean ?? 0).toBe((before.clean ?? 0) - 1);
    expect((await owner.api.json("GET", `/v1/days/${date}`)).garments.filter((g: any) => g.garmentId === id)).toHaveLength(1);
  });

  it("different commands racing for a garment's last clean unit never go negative, never create a unit and never lose an accepted event", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-last-unit");
    const date = await ownerDay(owner, 0);
    const trip = await submit(owner, "trip.create", { name: "SYNTHETIC race trip", departsOn: date, returnsOn: await ownerDay(owner, 2), destinations: [{ label: "SYNTHETIC destination", timezone: "Europe/Paris", from: date, to: await ownerDay(owner, 2) }], source: { kind: "owner_statement", note: NOTE } });
    expect(trip.status, JSON.stringify(trip.error)).toBe(200);
    const tripId = trip.receipt.result.tripId as string;

    const g = "syn03-last-unit";
    const results = await Promise.all([
      submit(owner, "wear.record", { wearingDate: date, garmentIds: [g] }),
      submit(owner, "care.mark_dirty", { items: [{ garmentId: g, quantity: 1 }] }),
      submit(owner, "stock.pack", { tripId, items: [{ garmentId: g, quantity: 1 }] }),
      submit(owner, "garment.retire", { garmentId: g, quantity: 1, disposition: "donated" }),
      submit(owner, "laundry.collect", { include: [{ garmentId: g, quantity: 1 }] }),
      submit(owner, "care.washed", { items: [{ garmentId: g, quantity: 1 }] }),
      submit(owner, "garment.move", { garmentId: g, to: "storage", quantity: 1 }),
      submit(owner, "laundry.report_exception", { kind: "still_away", garmentId: g, quantity: 1 }),
    ]);
    // An owner's report is never dropped because another client moved the unit first.
    for (const r of results) expect(r.status, JSON.stringify(r.error)).toBe(200);
    const after = await buckets(owner, g);
    expect(units(after)).toBe(1);

    // Every accepted command is in the ledger with exactly one receipt, and each change kept its journal event.
    for (const r of results) {
      const stored = await sql<{ receipt_json: string; outcome: string }>("SELECT receipt_json, outcome FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, r.receipt.commandId);
      expect(stored).toHaveLength(1);
      expect(JSON.parse(stored[0]!.receipt_json).commandId).toBe(r.receipt.commandId);
      const events = await sql("SELECT event_id FROM stock_events WHERE user_id = ? AND command_id = ? AND voided_by_command_id IS NULL", owner.userId, r.receipt.commandId);
      if (r.receipt.outcome === "noop") expect(events).toHaveLength(0);
      else expect(events.length, `${r.receipt.type} lost its journal event`).toBeGreaterThanOrEqual(1);
    }
    expect(await sql("SELECT observation_count FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", owner.userId, g)).toEqual([{ observation_count: 1 }]);
    // The garment's version moved once per committed change to it: no command was applied on a stale read.
    const changes = results.filter((r) => r.receipt.outcome !== "noop").length;
    const version = await sql<{ version: number }>("SELECT version FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, g);
    expect(version[0]!.version).toBe(1 + changes);
  });

  it("six parallel retirements of one unit each from a two-unit garment dispose of exactly two", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-retire", { quantity: 2 });
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(owner, "garment.retire", { garmentId: "syn03-retire", quantity: 1, disposition: "sold" })));
    for (const r of results) expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(results.filter((r) => r.receipt.outcome === "committed")).toHaveLength(2);
    expect(results.filter((r) => r.receipt.outcome === "noop")).toHaveLength(4);
    expect(results.filter((r) => r.receipt.outcome === "committed").map((r) => r.receipt.result.retired)).toEqual([1, 1]);
    expect(await buckets(owner, "syn03-retire")).toEqual({ gone: 2 });
    expect(await liveEvents(owner, "syn03-retire", "retire")).toHaveLength(2);
  });

  it("parallel laundry pickups put each dirty unit into exactly one batch, and parallel returns bring it back once", async () => {
    const owner = world.synthetic;
    const ids = ["syn03-bag-1", "syn03-bag-2", "syn03-bag-3", "syn03-bag-4"];
    for (const id of ids) await make(owner, id, { quantity: 2 });
    const dirtied = await submit(owner, "care.mark_dirty", { items: ids.map((garmentId) => ({ garmentId, quantity: 2 })) });
    expect(dirtied.status, JSON.stringify(dirtied.error)).toBe(200);

    const pickups = await Promise.all(Array.from({ length: 5 }, () => submit(owner, "laundry.collect", {})));
    for (const r of pickups) expect(r.status, JSON.stringify(r.error)).toBe(200);
    const marks = ids.map(() => "?").join(",");
    const membership = await sql<{ garment_id: string; batches: number; quantity: number }>(
      `SELECT i.garment_id, COUNT(*) AS batches, SUM(i.quantity) AS quantity FROM laundry_batch_items i WHERE i.user_id = ? AND i.garment_id IN (${marks}) GROUP BY i.garment_id ORDER BY i.garment_id`,
      owner.userId,
      ...ids,
    );
    expect(membership).toEqual(ids.map((garment_id) => ({ garment_id, batches: 1, quantity: 2 })));
    for (const id of ids) expect(await buckets(owner, id)).toEqual({ service: 2 });
    // What the receipts claim was collected is what the batches hold.
    const claimed = pickups.filter((r) => r.receipt.outcome === "committed").flatMap((r) => r.receipt.result.members as { garmentId: string; quantity: number }[]).filter((m) => ids.includes(m.garmentId));
    expect(claimed.reduce((n, m) => n + m.quantity, 0)).toBe(8);

    const batchIds = [...new Set((await sql<{ batch_id: string }>(`SELECT DISTINCT batch_id FROM laundry_batch_items WHERE user_id = ? AND garment_id IN (${marks})`, owner.userId, ...ids)).map((r) => r.batch_id))];
    const returns = await Promise.all(batchIds.flatMap((batchId) => Array.from({ length: 5 }, () => submit(owner, "laundry.return", { batchId }))));
    for (const r of returns) expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(returns.filter((r) => r.receipt.outcome === "committed")).toHaveLength(batchIds.length);
    for (const id of ids) expect(await buckets(owner, id)).toEqual({ clean: 2 });
    const items = await sql<{ quantity: number; returned_quantity: number; still_away: number }>(`SELECT quantity, returned_quantity, still_away FROM laundry_batch_items WHERE user_id = ? AND garment_id IN (${marks})`, owner.userId, ...ids);
    for (const item of items) expect(item).toEqual({ quantity: 2, returned_quantity: 2, still_away: 0 });
    expect(returns.filter((r) => r.receipt.outcome === "committed").reduce((n, r) => n + (r.receipt.result.returned as number), 0)).toBeGreaterThanOrEqual(8);
  });

  it("five parallel creations of the same garment ID create one garment with one opening stock", async () => {
    const owner = world.synthetic;
    const payload = { garmentId: "syn03-created-once", name: "SYNTHETIC created once (adversarial fixture)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 2, isSynthetic: true, source: { kind: "owner_statement", note: NOTE } };
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(owner, "garment.create", payload)));
    const created = results.filter((r) => r.status === 200);
    expect(created).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(409);
      expect(["precondition_failed", "conflict"]).toContain(r.error!.code);
    }
    expect(await sql("SELECT garment_id FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, "syn03-created-once")).toHaveLength(1);
    expect(await buckets(owner, "syn03-created-once")).toEqual({ clean: 2 });
    expect(await sql("SELECT event_id FROM stock_events WHERE user_id = ? AND garment_id = ?", owner.userId, "syn03-created-once")).toHaveLength(1);
    expect(await sql("SELECT command_id FROM commands WHERE user_id = ? AND type = 'garment.create' AND payload_json LIKE '%syn03-created-once%'", owner.userId)).toHaveLength(1);
    // The colliding owner can still create the same ID for itself: the refusal was about one owner's ledger only.
    const other = await submit(collider, "garment.create", payload);
    expect(other.status, JSON.stringify(other.error)).toBe(200);
    expect(await buckets(owner, "syn03-created-once")).toEqual({ clean: 2 });
  });

  it("parallel count corrections made against the same garment version: one is accepted, the others are refused and write nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-count", { quantity: 3 });
    const version = (await sql<{ version: number }>("SELECT version FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, "syn03-count"))[0]!.version;
    const commandsBefore = await count("commands", owner.userId);
    const results = await Promise.all([4, 5, 6, 7, 8].map((clean) => submit(owner, "stock.reconcile", { garmentId: "syn03-count", counts: { clean } }, { expectedVersions: { "garment:syn03-count": version } })));
    const accepted = results.filter((r) => r.status === 200);
    expect(accepted).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(409);
      expect(r.error!.code).toBe("conflict");
    }
    expect(await buckets(owner, "syn03-count")).toEqual({ clean: accepted[0]!.receipt.result.clean });
    expect(await liveEvents(owner, "syn03-count", "reconcile")).toHaveLength(1);
    expect(await count("commands", owner.userId)).toBe(commandsBefore + 1);
  });

  it("parallel settings edits each get their own version: none is lost and none shares a version", async () => {
    const owner = world.synthetic;
    const versionBefore = (await owner.api.json("GET", "/v1/settings")).version as number;
    const rowsBefore = await count("owner_settings_versions", owner.userId);
    const horizons = [8, 9, 10, 11, 12, 13];
    const results = await Promise.all(horizons.map((repeatHorizonDays) => submit(owner, "settings.update", { patch: { variety: { repeatHorizonDays } } })));
    for (const r of results) expect(r.status, JSON.stringify(r.error)).toBe(200);
    const versions = results.map((r) => r.receipt.result.version as number).sort((x, y) => x - y);
    expect(versions).toEqual(horizons.map((_, i) => versionBefore + 1 + i));
    expect(await count("owner_settings_versions", owner.userId)).toBe(rowsBefore + horizons.length);
    const now = await owner.api.json("GET", "/v1/settings");
    expect(now.version).toBe(versionBefore + horizons.length);
    const last = results.find((r) => r.receipt.result.version === now.version)!;
    expect(now.settings.variety.repeatHorizonDays).toBe(horizons[results.indexOf(last)]);
    // A stale settings edit (the version the client saw is gone) is refused.
    const stale = await submit(owner, "settings.update", { patch: { variety: { repeatHorizonDays: 3 } } }, { expectedVersions: { settings: versionBefore } });
    expect(stale.status).toBe(409);
    expect(stale.error!.code).toBe("conflict");
    expect((await owner.api.json("GET", "/v1/settings")).version).toBe(now.version);
  });

  it("a burst of simultaneous reports loses nothing: each is recorded, or refused whole and recorded once when retried under its key", async () => {
    const owner = world.synthetic;
    const ids = ["syn03-burst-1", "syn03-burst-2", "syn03-burst-3", "syn03-burst-4"];
    for (const id of ids) await make(owner, id, { quantity: 10 });
    const burst = Array.from({ length: 24 }, (_, i) => ({ key: uid(`burst-${i}`), garmentId: ids[i % ids.length]! }));
    const first = await Promise.all(burst.map((b) => submit(owner, "care.mark_dirty", { items: [{ garmentId: b.garmentId, quantity: 1 }] }, { idempotencyKey: b.key })));
    for (const [i, r] of first.entries()) {
      if (r.status === 200) continue;
      // The only acceptable refusal is the one that says nothing was written and the key is safe to resend.
      expect(r.status).toBe(500);
      expect(r.error).toMatchObject({ code: "internal", details: { retryable: true } });
      expect(await rowsForKey(owner, burst[i]!.key)).toHaveLength(0);
      const retried = await submit(owner, "care.mark_dirty", { items: [{ garmentId: burst[i]!.garmentId, quantity: 1 }] }, { idempotencyKey: burst[i]!.key });
      expect(retried.status, JSON.stringify(retried.error)).toBe(200);
    }
    for (const b of burst) expect(await rowsForKey(owner, b.key)).toHaveLength(1);
    for (const id of ids) {
      expect(await liveEvents(owner, id, "mark_dirty")).toHaveLength(6);
      expect(await buckets(owner, id)).toEqual({ clean: 4, dirty: 6 });
    }
  });

  defect("L03-2", "a burst of eighty simultaneous owner reports: many are refused with HTTP 500 instead of being rebased and recorded", async () => {
    const owner = world.synthetic;
    const ids = ["syn03-flood-1", "syn03-flood-2", "syn03-flood-3", "syn03-flood-4"];
    for (const id of ids) await make(owner, id, { quantity: 20 });
    const results = await Promise.all(Array.from({ length: 80 }, (_, i) => submit(owner, "care.mark_dirty", { items: [{ garmentId: ids[i % ids.length]!, quantity: 1 }] })));
    const refusedReports = results.filter((r) => r.status !== 200);
    // Section 5: an owner observation is rebased and retried internally, never discarded because another
    // client changed the record. Every one of these is a valid report about a garment with stock to spare.
    expect(refusedReports.map((r) => `${r.status} ${r.error!.code}`), `${refusedReports.length} of 80 reports were refused`).toEqual([]);
  });

  it("four parallel board publications for one day make one board with consecutive revisions; one request retransmitted makes one revision", async () => {
    const owner = world.real;
    const date = await ownerDay(owner, 4);
    const published = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const response = await owner.api.post("/v1/recommendations", { clientRequestId: uid("publish"), mode: "board", date });
        return { status: response.status, body: (await response.json()) as any };
      }),
    );
    for (const p of published) expect(p.status, JSON.stringify(p.body.error)).toBe(200);
    const boards = await sql<{ board_id: string; current_revision: number }>("SELECT board_id, current_revision FROM boards WHERE user_id = ? AND local_date = ? AND scope = 'home'", owner.userId, date);
    expect(boards).toHaveLength(1);
    const revisions = await sql<{ revision: number }>("SELECT revision FROM board_revisions WHERE user_id = ? AND board_id = ? ORDER BY revision", owner.userId, boards[0]!.board_id);
    expect(revisions.map((r) => r.revision)).toEqual(revisions.map((_, i) => i + 1));
    // Four independent requests are four publications: none was silently dropped.
    expect(revisions, "one revision per independent publication").toHaveLength(4);
    expect(boards[0]!.current_revision).toBe(revisions.length);
    for (const p of published) expect(p.body.board?.boardId, "every publication answers with the day's board").toBe(boards[0]!.board_id);

    const other = await ownerDay(owner, 5);
    const requestId = uid("publish-retransmitted");
    const retransmitted = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const response = await owner.api.post("/v1/recommendations", { clientRequestId: requestId, mode: "board", date: other });
        return { status: response.status, body: (await response.json()) as any };
      }),
    );
    for (const p of retransmitted) expect(p.status, JSON.stringify(p.body.error)).toBe(200);
    const otherBoards = await sql<{ board_id: string; current_revision: number }>("SELECT board_id, current_revision FROM boards WHERE user_id = ? AND local_date = ? AND scope = 'home'", owner.userId, other);
    expect(otherBoards).toHaveLength(1);
    expect(await sql("SELECT revision FROM board_revisions WHERE user_id = ? AND board_id = ? AND reason = 'compose'", owner.userId, otherBoards[0]!.board_id)).toHaveLength(1);
  });

  it("[fixed L03-3] the same laundry return reported a second time (another device, a new key) does not launder the hamper: pieces worn after the pickup stay dirty", async () => {
    // A dedicated LABELLED SYNTHETIC owner: the return in question touches every piece awaiting the service.
    const owner = await syntheticOwner("Synthetic laundry owner (adversarial test fixture)");
    const now = Date.now();
    const hour = 3_600_000;
    await make(owner, "syn03-in-the-bag");
    await make(owner, "syn03-worn-after-pickup");
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-in-the-bag" }] }, { occurredAt: iso(now - 50 * hour) });
    const pickup = await submit(owner, "laundry.collect", {}, { occurredAt: iso(now - 40 * hour) });
    expect(pickup.receipt.result.members).toEqual([{ garmentId: "syn03-in-the-bag", quantity: 1 }]);
    // Dirty after the pickup: it is in the hamper, not in the bag (section 5, "A shirt worn after pickup stays in the hamper").
    await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-worn-after-pickup" }] }, { occurredAt: iso(now - 30 * hour) });

    const returnedAt = iso(now - 2 * hour);
    const phone = await submit(owner, "laundry.return", {}, { occurredAt: returnedAt });
    expect(phone.status, JSON.stringify(phone.error)).toBe(200);
    expect(phone.receipt.result).toMatchObject({ batchId: pickup.receipt.result.batchId, returned: 1 });
    expect(await buckets(owner, "syn03-in-the-bag")).toEqual({ clean: 1 });
    expect(await buckets(owner, "syn03-worn-after-pickup")).toEqual({ dirty: 1 });

    // The same return, reported again from the browser for the same instant under its own key.
    const browser = await send(owner.api.with({ client: "web" }), "laundry.return", {}, { occurredAt: returnedAt });
    expect([200, 409]).toContain(browser.status);
    // "A return completes only the contents of the returning batch": nothing else may come back with it.
    expect(await buckets(owner, "syn03-worn-after-pickup")).toEqual({ dirty: 1 });
    expect(await buckets(owner, "syn03-in-the-bag")).toEqual({ clean: 1 });
  });
});

describe("stale expected versions", () => {
  it("wear, wash and laundry reports with stale versions are accepted and rebased", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-rebase", { quantity: 2 });
    const g = "syn03-rebase";
    const date = await ownerDay(owner, 0);
    const stale = { expectedVersions: { [`garment:${g}`]: 0, wardrobe: 0 } };

    const wear = await submit(owner, "wear.record", { wearingDate: date, garmentIds: [g] }, stale);
    expect(wear.status, JSON.stringify(wear.error)).toBe(200);
    expect(wear.receipt.result.counted).toEqual([g]);
    expect(await buckets(owner, g)).toEqual({ clean: 1, dirty: 1 });

    const amend = await submit(owner, "wear.amend", { wearingDate: date, remove: [g] }, stale);
    expect(amend.status, JSON.stringify(amend.error)).toBe(200);
    expect(amend.receipt.result.removed).toEqual([g]);
    expect(await buckets(owner, g)).toEqual({ clean: 2 });

    const dirty = await submit(owner, "care.mark_dirty", { items: [{ garmentId: g, quantity: 2 }] }, stale);
    expect(dirty.status, JSON.stringify(dirty.error)).toBe(200);
    expect(await buckets(owner, g)).toEqual({ dirty: 2 });

    const washed = await submit(owner, "care.washed", { items: [{ garmentId: g, quantity: 1 }] }, stale);
    expect(washed.status, JSON.stringify(washed.error)).toBe(200);
    expect(await buckets(owner, g)).toEqual({ clean: 1, dirty: 1 });

    const collected = await submit(owner, "laundry.collect", { include: [{ garmentId: g, quantity: 1 }] }, stale);
    expect(collected.status, JSON.stringify(collected.error)).toBe(200);
    expect((await buckets(owner, g)).service).toBe(1);

    const returned = await submit(owner, "laundry.return", { batchId: collected.receipt.result.batchId }, stale);
    expect(returned.status, JSON.stringify(returned.error)).toBe(200);
    expect(await buckets(owner, g)).toEqual({ clean: 2 });

    const exception = await submit(owner, "laundry.report_exception", { kind: "still_away", garmentId: g, quantity: 1 }, stale);
    expect(exception.status, JSON.stringify(exception.error)).toBe(200);
    expect(await buckets(owner, g)).toEqual({ clean: 1, service: 1 });
    expect(units(await buckets(owner, g))).toBe(2);
  });

  it("corrections, moves, retirements, counts, packing, arrivals, measurements and size notes with stale versions are refused and write nothing", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-stale", { quantity: 2 });
    await make(owner, "syn03-stale-incoming", { acquisition: "incoming" });
    const g = "syn03-stale";
    const date = await ownerDay(owner, 0);
    const trip = await submit(owner, "trip.create", { name: "SYNTHETIC stale trip", departsOn: date, returnsOn: date, destinations: [{ label: "SYNTHETIC destination", timezone: "Europe/Paris", from: date, to: date }], source: { kind: "owner_statement", note: NOTE } });
    const tripId = trip.receipt.result.tripId as string;
    const packed = await submit(owner, "stock.pack", { tripId, items: [{ garmentId: g, quantity: 1 }] });
    expect(packed.status, JSON.stringify(packed.error)).toBe(200);
    // Another client then changes the garment: every version the first client holds is stale.
    const current = (await sql<{ version: number }>("SELECT version FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, g))[0]!.version;
    const staleGarment = { expectedVersions: { [`garment:${g}`]: current - 1 } };
    const before = await settled(owner);

    const attempts: [string, Record<string, unknown>, { expectedVersions: Record<string, number> }][] = [
      ["garment.correct", { garmentId: g, changes: { colour: "SYNTHETIC stale colour" }, source: { kind: "owner_statement", note: NOTE } }, staleGarment],
      ["garment.bulk_correct", { selector: { garmentIds: [g] }, changes: { colour: "SYNTHETIC stale colour" }, source: { kind: "owner_statement", note: NOTE } }, staleGarment],
      ["garment.move", { garmentId: g, to: "storage", quantity: 1 }, staleGarment],
      ["garment.retire", { garmentId: g, disposition: "discarded" }, staleGarment],
      ["stock.reconcile", { garmentId: g, counts: { clean: 9 } }, staleGarment],
      ["stock.pack", { tripId, items: [{ garmentId: g, quantity: 1 }] }, staleGarment],
      ["stock.unpack", { tripId }, staleGarment],
      ["garment.receive", { garmentId: "syn03-stale-incoming" }, { expectedVersions: { "garment:syn03-stale-incoming": 7 } }],
      ["measurement.record", { subject: "garment", garmentId: g, key: "chest", value: 55, unit: "cm", source: { kind: "owner_statement", note: NOTE } }, staleGarment],
      ["size_experience.record", { maker: "SYNTHETIC maker", sizeLabel: "M" }, { expectedVersions: { style: 987_654 } }],
    ];
    for (const [type, payload, opts] of attempts) {
      const r = await submit(owner, type, payload, opts);
      expect(r.status, `${type}: ${JSON.stringify(r.receipt ?? r.error)}`).toBe(409);
      expect(r.error!.code, type).toBe("conflict");
    }
    expect(await fingerprint(owner)).toEqual(before);
    expect(await sql("SELECT colour FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, g)).toEqual([{ colour: null }]);
    expect(await buckets(owner, g)).toEqual({ clean: 1, trip: 1 });
    expect(await buckets(owner, "syn03-stale-incoming")).toEqual({ incoming: 1 });

    // Control: with the version the ledger holds, the same count correction is accepted.
    const fresh = await submit(owner, "stock.reconcile", { garmentId: g, counts: { clean: 1 } }, { expectedVersions: { [`garment:${g}`]: current } });
    expect(fresh.status, JSON.stringify(fresh.error)).toBe(200);
    // An unknown version kind is an error, never silently ignored on a version-checked command.
    const unknownKind = await submit(owner, "stock.reconcile", { garmentId: g, counts: { clean: 1 } }, { expectedVersions: { "spaceship:enterprise": 1 } });
    expect(unknownKind.status).toBe(400);
    expect(unknownKind.error!.code).toBe("invalid_command");
    for (const versions of [{ [`garment:${g}`]: -1 }, { [`garment:${g}`]: 1.5 }, { [`garment:${g}`]: "1" }]) {
      const response = await owner.api.post("/v1/commands", queued("stock.reconcile", { garmentId: g, counts: { clean: 1 } }, uid("bad-version"), { expectedVersions: versions }));
      expect(response.status, JSON.stringify(versions)).toBe(400);
      await response.text();
    }
  });
});

describe("undo under replay and races", () => {
  it("six parallel undos of one command compensate it exactly once", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-undo", { quantity: 3 });
    const dirty = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-undo", quantity: 2 }] });
    expect(await buckets(owner, "syn03-undo")).toEqual({ clean: 1, dirty: 2 });
    const undos = await Promise.all(Array.from({ length: 6 }, () => submit(owner, "command.undo", { commandId: dirty.receipt.commandId })));
    const done = undos.filter((u) => u.status === 200);
    expect(done).toHaveLength(1);
    for (const u of undos.filter((x) => x.status !== 200)) {
      expect(u.status).toBe(409);
      expect(["not_undoable", "precondition_failed"]).toContain(u.error!.code);
    }
    expect(await buckets(owner, "syn03-undo")).toEqual({ clean: 3 });
    const original = await sql<{ undone_by_command_id: string | null }>("SELECT undone_by_command_id FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, dirty.receipt.commandId);
    expect(original[0]!.undone_by_command_id).toBe(done[0]!.receipt.commandId);
    expect(await sql("SELECT command_id FROM commands WHERE user_id = ? AND undoes_command_id = ?", owner.userId, dirty.receipt.commandId)).toHaveLength(1);

    // The same undo retried under one key from several clients is one undo as well.
    const again = await submit(owner, "care.mark_dirty", { items: [{ garmentId: "syn03-undo", quantity: 1 }] });
    const key = uid("undo-one-key");
    const retried = await Promise.all(Array.from({ length: 6 }, () => submit(owner, "command.undo", { commandId: again.receipt.commandId }, { idempotencyKey: key })));
    for (const u of retried) expect(u.status, JSON.stringify(u.error)).toBe(200);
    expect(new Set(retried.map((u) => u.receipt.commandId)).size).toBe(1);
    expect(retried.filter((u) => u.receipt.replayed === false)).toHaveLength(1);
    expect(await buckets(owner, "syn03-undo")).toEqual({ clean: 3 });
  });

  it("an undo cannot itself be undone, and replaying the undone command's key does not run it again", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-redo", { quantity: 2 });
    const date = await ownerDay(owner, 0);
    const key = uid("redo-original");
    const wear = await submit(owner, "wear.record", { wearingDate: date, garmentIds: ["syn03-redo"] }, { idempotencyKey: key });
    const undo = await submit(owner, "command.undo", { commandId: wear.receipt.commandId });
    expect(undo.status, JSON.stringify(undo.error)).toBe(200);
    expect(undo.receipt.undo.available).toBe(false);
    expect(await buckets(owner, "syn03-redo")).toEqual({ clean: 2 });
    const afterUndo = await settled(owner);

    const undoOfUndo = await submit(owner, "command.undo", { commandId: undo.receipt.commandId });
    expect(undoOfUndo.status).toBe(409);
    expect(undoOfUndo.error!.code).toBe("not_undoable");
    const twice = await submit(owner, "command.undo", { commandId: wear.receipt.commandId });
    expect(twice.status).toBe(409);
    expect(twice.error!.code).toBe("not_undoable");
    const missing = await submit(owner, "command.undo", { commandId: "cmd_00000000000000000000000000000000" });
    expect(missing.status).toBe(404);
    // The captured original request, replayed: the stored receipt, now saying it was undone; no second wear.
    const replay = await submit(owner, "wear.record", { wearingDate: date, garmentIds: ["syn03-redo"] }, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.receipt).toMatchObject({ commandId: wear.receipt.commandId, replayed: true, undo: { available: false } });
    expect(await fingerprint(owner)).toEqual(afterUndo);
    expect(await sql("SELECT status FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'", owner.userId, "syn03-redo")).toHaveLength(0);

    // Redo is the original action again under a new key; it counts once.
    const redo = await submit(owner, "wear.record", { wearingDate: date, garmentIds: ["syn03-redo"] });
    expect(redo.status, JSON.stringify(redo.error)).toBe(200);
    expect(redo.receipt.result.counted).toEqual(["syn03-redo"]);
    expect(await buckets(owner, "syn03-redo")).toEqual({ clean: 1, dirty: 1 });
    expect(await sql("SELECT observation_count, status FROM daily_wears WHERE user_id = ? AND garment_id = ?", owner.userId, "syn03-redo")).toEqual([{ observation_count: 1, status: "active" }]);
  });

  it("an undo racing new reports about the same garment leaves the counted wear and the stock consistent", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-undo-race");
    const g = "syn03-undo-race";
    const date = await ownerDay(owner, 0);
    const wear = await submit(owner, "wear.record", { wearingDate: date, garmentIds: [g] });
    expect(wear.status, JSON.stringify(wear.error)).toBe(200);
    const results = await Promise.all([
      submit(owner, "command.undo", { commandId: wear.receipt.commandId }),
      submit(owner, "wear.record", { wearingDate: date, garmentIds: [g] }),
      submit(owner, "care.washed", { items: [{ garmentId: g }] }),
      submit(owner, "care.mark_dirty", { items: [{ garmentId: g, quantity: 1 }] }),
      submit(owner, "wear.amend", { wearingDate: date, add: [g] }),
    ]);
    // The undo applies. The owner's new observations are authoritative and are rebased onto whatever the undo left, never
    // discarded for having raced it (the same rule as L03-2): the wear, the wash and the hamper report each answer 200.
    // Only the amendment, which names the day's record it amends, may lose the race, and then only with a conflict.
    expect(results.map((r) => r.status).slice(0, 4), JSON.stringify(results.map((r) => r.error))).toEqual([200, 200, 200, 200]);
    const amend = results[4]!;
    if (amend.status !== 200) expect({ status: amend.status, code: amend.error?.code }, "the racing amendment").toEqual({ status: 409, code: "conflict" });
    const after = await buckets(owner, g);
    expect(units(after)).toBe(1);
    // The counted wear says exactly what the live observations say.
    const live = await sql<{ n: number }>("SELECT COUNT(*) AS n FROM wear_observations WHERE user_id = ? AND garment_id = ? AND wearing_date = ? AND status = 'active'", owner.userId, g, date);
    const daily = await sql<{ observation_count: number; status: string; stock_event_id: string | null }>("SELECT observation_count, status, stock_event_id FROM daily_wears WHERE user_id = ? AND garment_id = ? AND wearing_date = ?", owner.userId, g, date);
    expect(daily).toHaveLength(1);
    // The new wear.record answered 200, so its own observation stands whatever the undo of the earlier one did: the
    // undo retracts only the command it names.
    expect(live[0]!.n, "the racing wear report's observation is live").toBeGreaterThanOrEqual(1);
    expect((await sql<{ undone_by_command_id: string | null }>("SELECT undone_by_command_id FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, results[1]!.receipt.commandId))[0]!.undone_by_command_id).toBeNull();
    expect(daily[0]!.observation_count).toBe(live[0]!.n);
    expect(daily[0]!.status).toBe(live[0]!.n > 0 ? "active" : "retracted");
    // Exactly one live wear event backs an active counted wear; none backs a retracted one.
    expect(await liveEvents(owner, g, "wear")).toHaveLength(live[0]!.n > 0 ? 1 : 0);
    if (live[0]!.n > 0) expect((await liveEvents(owner, g, "wear"))[0]!.event_id).toBe(daily[0]!.stock_event_id);
    expect((await sql<{ undone_by_command_id: string | null }>("SELECT undone_by_command_id FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, wear.receipt.commandId))[0]!.undone_by_command_id).toBe(results[0]!.receipt.commandId);
  });

  it("replaying a wear after its garment was retired returns the stored receipt, and a new wear of it creates no stock", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-retired");
    const g = "syn03-retired";
    const key = uid("before-retire");
    const yesterday = await ownerDay(owner, -1);
    const wear = await submit(owner, "wear.record", { wearingDate: yesterday, garmentIds: [g] }, { idempotencyKey: key });
    expect(wear.status, JSON.stringify(wear.error)).toBe(200);
    const retire = await submit(owner, "garment.retire", { garmentId: g, disposition: "donated" });
    expect(retire.status, JSON.stringify(retire.error)).toBe(200);
    expect(await buckets(owner, g)).toEqual({ gone: 1 });
    const afterRetire = await settled(owner);

    const replay = await submit(owner, "wear.record", { wearingDate: yesterday, garmentIds: [g] }, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.receipt).toMatchObject({ commandId: wear.receipt.commandId, replayed: true });
    const viaBatch = await batch(owner, [queued("wear.record", { wearingDate: yesterday, garmentIds: [g] }, key)]);
    expect(viaBatch.results[0].receipt).toMatchObject({ commandId: wear.receipt.commandId, replayed: true });
    expect(await fingerprint(owner)).toEqual(afterRetire);

    // A genuinely new report about the retired garment: recorded or refused, but no unit comes back from nowhere.
    const today = await ownerDay(owner, 0);
    const late = await submit(owner, "wear.record", { wearingDate: today, garmentIds: [g] });
    if (late.status === 200) expect((late.receipt.repairs as string[]).join(" ")).toMatch(/no owned units|no quantity/i);
    else expect([404, 409]).toContain(late.status);
    const dirty = await submit(owner, "care.mark_dirty", { items: [{ garmentId: g, quantity: 3 }] });
    expect([200, 404, 409]).toContain(dirty.status);
    const washed = await submit(owner, "care.washed", { items: [{ garmentId: g, quantity: 3 }] });
    expect([200, 404, 409]).toContain(washed.status);
    expect(await buckets(owner, g)).toEqual({ gone: 1 });
    // A second retirement has nothing left to dispose of.
    const again = await submit(owner, "garment.retire", { garmentId: g, disposition: "donated" });
    if (again.status === 200) expect(again.receipt.outcome).toBe("noop");
    expect(await buckets(owner, g)).toEqual({ gone: 1 });
  });
});

describe("boards and proposals under parallel edits", () => {
  it("parallel swaps made against one board revision: exactly one wins, the others are refused with a conflict", async () => {
    const owner = world.real;
    const date = await ownerDay(owner, 1);
    const board = await boardFor(owner, date);
    expect(board.options.length).toBeGreaterThanOrEqual(3);
    const swapsBefore = await count("commands", owner.userId, "type = 'board.swap_slot'");
    const attempts = await Promise.all(
      board.options.slice(0, 4).map(async (option: any) => {
        const response = await owner.api.post(`/v1/boards/${board.boardId}/swap`, { clientRequestId: uid("swap"), optionId: option.optionId, role: "top", expectedRevision: board.revision });
        return { status: response.status, body: (await response.json()) as any };
      }),
    );
    const won = attempts.filter((a) => a.status === 200);
    expect(won).toHaveLength(1);
    for (const lost of attempts.filter((a) => a.status !== 200)) {
      expect(lost.status).toBe(409);
      expect(lost.body.error.code).toBe("conflict");
    }
    expect(won[0]!.body.board.revision).toBe(board.revision + 1);
    expect(await count("commands", owner.userId, "type = 'board.swap_slot'")).toBe(swapsBefore + 1);
    const revisions = await sql<{ revision: number; reason: string }>("SELECT revision, reason FROM board_revisions WHERE user_id = ? AND board_id = ? ORDER BY revision", owner.userId, board.boardId);
    expect(revisions.filter((r) => r.reason === "swap")).toHaveLength(1);
    expect(revisions.map((r) => r.revision)).toEqual(revisions.map((_, i) => i + 1));

    // One swap request retransmitted four times at once is one swap.
    const current = (await owner.api.json("GET", `/v1/today?date=${date}`)).board;
    const requestId = uid("swap-retransmitted");
    const retransmitted = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const response = await owner.api.post(`/v1/boards/${board.boardId}/swap`, { clientRequestId: requestId, optionId: current.options[0].optionId, role: "bottom", expectedRevision: current.revision });
        return { status: response.status, body: (await response.json()) as any };
      }),
    );
    for (const r of retransmitted) expect(r.status, JSON.stringify(r.body.error)).toBe(200);
    expect(new Set(retransmitted.map((r) => r.body.receipt.commandId)).size).toBe(1);
    expect(retransmitted.filter((r) => r.body.receipt.replayed === false)).toHaveLength(1);
    expect(await count("commands", owner.userId, "type = 'board.swap_slot'")).toBe(swapsBefore + 2);
  });

  it("a selection made against a board revision that a swap has replaced is refused", async () => {
    const owner = world.real;
    const date = await ownerDay(owner, 3);
    const board = await boardFor(owner, date);
    const key = `board:${board.boardId}`;
    const swapped = await owner.api.post(`/v1/boards/${board.boardId}/swap`, { clientRequestId: uid("swap-then-select"), optionId: board.options[0].optionId, role: "top", expectedRevision: board.revision });
    expect(swapped.status).toBe(200);
    await swapped.text();
    const stale = await submit(owner, "board.select", { boardId: board.boardId, optionId: board.options[1].optionId }, { expectedVersions: { [key]: board.revision } });
    expect(stale.status).toBe(409);
    expect(stale.error!.code).toBe("conflict");
    expect((await owner.api.json("GET", `/v1/today?date=${date}`)).board.selection?.optionId ?? null).toBeNull();
  });

  // Ruled intended by the daily workstream (2026-10-03): a selection is the owner's current choice on a
  // board revision, not a revision of the board. A later choice replaces an earlier one, each with its own
  // receipt and undo; `board:<id>` names the board's revision, which a selection does not advance.
  it("parallel board selections against one revision are each recorded with their own receipt; one of them stands and the board's revision is unchanged", async () => {
    const owner = world.real;
    const date = await ownerDay(owner, 2);
    const board = await boardFor(owner, date);
    const key = `board:${board.boardId}`;
    const offered = board.options.slice(0, 4).map((option: any) => option.optionId as string);
    const results = await Promise.all(offered.map((optionId: string) => submit(owner, "board.select", { boardId: board.boardId, optionId }, { expectedVersions: { [key]: board.revision } })));
    const accepted = results.filter((r) => r.status === 200);
    // Each selection is the owner's choice, recorded on its own: none is refused as a conflict.
    for (const r of results) expect(r.status, JSON.stringify(r.error)).toBe(200);
    expect(accepted).toHaveLength(offered.length);
    expect(new Set(accepted.map((r) => r.receipt.commandId)).size).toBe(accepted.length);
    const stored = await sql<{ command_id: string }>(`SELECT command_id FROM commands WHERE user_id = ? AND type = 'board.select' AND command_id IN (${accepted.map(() => "?").join(",")})`, owner.userId, ...accepted.map((r) => r.receipt.commandId));
    expect(stored).toHaveLength(accepted.length);
    const after = (await owner.api.json("GET", `/v1/today?date=${date}`)).board;
    // A selection does not advance the board's revision.
    expect(after.revision).toBe(board.revision);
    // Exactly one of the offered options is the selection, and no option outside the board ever is.
    expect(offered).toContain(after.selection?.optionId);
    expect(after.options.map((o: any) => o.optionId)).toContain(after.selection.optionId);
    // A selection made against a revision that is no longer current is still refused.
    const stale = await submit(owner, "board.select", { boardId: board.boardId, optionId: offered[0] }, { expectedVersions: { [key]: after.revision + 7 } });
    expect(stale.status).toBe(409);
    expect((await owner.api.json("GET", `/v1/today?date=${date}`)).board.selection.optionId).toBe(after.selection.optionId);
  });

  // Contract of 2026-10-05: a connected assistant's ordinary change now applies at once, so the waiting
  // request these two races need is a section-3 change. `garment.merge` (an irreversible rewrite of two
  // records, packages/assistant/src/policy/classes.ts SECTION3_CONFIRM_TYPES) still waits for the owner.
  it("six parallel confirmations of one waiting garment merge (a section-3 change a connected assistant asked for) run it once, and the assistant's repeat call reads that one receipt", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-merge-source");
    await make(owner, "syn03-merge-target");
    const key = uid("proposal");
    const payload = { sourceGarmentId: "syn03-merge-source", targetGarmentId: "syn03-merge-target", quantityMode: "add_units" };
    const mergedInto = async (garmentId: string) => (await sql<{ merged_into: string | null }>("SELECT merged_into FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, garmentId))[0]!.merged_into;
    const mergesBefore = await count("commands", owner.userId, "type = 'garment.merge'");
    const asked = await viaMcp(syntheticMcp, "garment.merge", payload, { idempotencyKey: key });
    expect(asked.receipt).toBeNull();
    expect(asked.error).toMatchObject({ code: "confirmation_required", details: { reason: "owner_confirmation_required", state: "pending" } });
    const proposalId = String(asked.error!.details.proposalId);
    // Asking again (same key, same body) is the same proposal, not a second one; nothing was merged.
    const askedAgain = await viaMcp(syntheticMcp, "garment.merge", payload, { idempotencyKey: key });
    expect(askedAgain.error?.details.proposalId).toBe(proposalId);
    expect((await pendingProposals(owner)).filter((p) => p.proposalId === proposalId)).toHaveLength(1);
    expect(await count("commands", owner.userId, "type = 'garment.merge'")).toBe(mergesBefore);
    expect(await mergedInto("syn03-merge-source")).toBeNull();
    expect(await buckets(owner, "syn03-merge-target")).toEqual({ clean: 1 });
    // The same key with another body is refused and does not replace what the owner will read.
    const changed = await viaMcp(syntheticMcp, "garment.merge", { ...payload, quantityMode: "same_units" }, { idempotencyKey: key });
    expect(changed.error?.code).toBe("idempotency_key_reuse");
    expect((await pendingProposals(owner)).find((p) => p.proposalId === proposalId).payload.quantityMode).toBe("add_units");

    const decisions = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const response = await owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision: "confirm" });
        return { status: response.status, body: (await response.json()) as any };
      }),
    );
    // Each answer is the receipt (fresh or replayed) or a controlled, retryable refusal while another copy is confirming.
    for (const d of decisions) {
      if (d.status === 409) expect(d.body.error, JSON.stringify(d.body.error)).toMatchObject({ code: "conflict", details: { reason: "being_confirmed" } });
      else expect(d.status, JSON.stringify(d.body.error)).toBe(200);
    }
    const answered = decisions.filter((d) => d.status === 200);
    expect(answered.length, "at least one confirmation answered with the receipt").toBeGreaterThanOrEqual(1);
    expect(new Set(answered.map((d) => d.body.receipt.commandId)).size).toBe(1);
    expect(answered.filter((d) => d.body.replayed === false)).toHaveLength(1);
    // A copy that was told to look again later gets that same receipt, replayed, and nothing runs a second time.
    const retried = await owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision: "confirm" });
    const retriedBody = (await retried.json()) as any;
    expect(retried.status, JSON.stringify(retriedBody.error)).toBe(200);
    expect(retriedBody.receipt.commandId).toBe(answered[0]!.body.receipt.commandId);
    expect(retriedBody.replayed).toBe(true);
    expect(await count("commands", owner.userId, "type = 'garment.merge'")).toBe(mergesBefore + 1);
    // Merged once: the source points at the target, and the target holds both units (add_units), not three.
    expect(await mergedInto("syn03-merge-source")).toBe("syn03-merge-target");
    expect(await buckets(owner, "syn03-merge-target")).toEqual({ clean: 2 });
    expect(await sql("SELECT decision FROM proposal_decisions WHERE user_id = ? AND proposal_id = ?", owner.userId, proposalId)).toEqual([{ decision: "confirmed" }]);
    // The command ran as the owner's tap, not as the assistant.
    const commandId = answered[0]!.body.receipt.commandId as string;
    expect(await sql("SELECT actor, authorization_basis FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, commandId)).toEqual([{ actor: "owner", authorization_basis: "owner_tap" }]);

    const after = await settled(owner);
    for (let i = 0; i < 3; i++) {
      const repeat = await viaMcp(syntheticMcp, "garment.merge", payload, { idempotencyKey: key });
      expect(repeat.error, JSON.stringify(repeat.error)).toBeNull();
      expect(repeat.receipt).toMatchObject({ commandId, replayed: true });
    }
    expect(await fingerprint(owner)).toEqual(after);
  });

  it("a confirmation racing a rejection of one waiting garment merge ends in one decision, and the merge ran once or not at all", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-contested-source");
    await make(owner, "syn03-contested-target");
    const mergedInto = async (garmentId: string) => (await sql<{ merged_into: string | null }>("SELECT merged_into FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, garmentId))[0]!.merged_into;
    const asked = await viaMcp(syntheticMcp, "garment.merge", { sourceGarmentId: "syn03-contested-source", targetGarmentId: "syn03-contested-target", quantityMode: "add_units" }, { idempotencyKey: uid("contested") });
    expect(asked.receipt).toBeNull();
    expect(asked.error?.code).toBe("confirmation_required");
    const proposalId = String(asked.error!.details.proposalId);
    const mergesBefore = await count("commands", owner.userId, "type = 'garment.merge'");
    const decisions = await Promise.all(
      ["confirm", "reject", "confirm", "reject", "confirm", "reject"].map(async (decision) => {
        const response = await owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision });
        return { decision, status: response.status, body: (await response.json()) as any };
      }),
    );
    const stored = await sql<{ decision: string; command_id: string | null }>("SELECT decision, command_id FROM proposal_decisions WHERE user_id = ? AND proposal_id = ?", owner.userId, proposalId);
    expect(stored).toHaveLength(1);
    const outcome = stored[0]!.decision;
    const ran = (await count("commands", owner.userId, "type = 'garment.merge'")) - mergesBefore;
    if (outcome === "confirmed") {
      expect(ran).toBe(1);
      expect(await mergedInto("syn03-contested-source")).toBe("syn03-contested-target");
      expect(await buckets(owner, "syn03-contested-target")).toEqual({ clean: 2 });
      // Each confirmation answers with the one receipt, or with the controlled, retryable refusal while another copy is confirming.
      for (const d of decisions.filter((x) => x.decision === "confirm")) {
        if (d.status === 409) expect(d.body.error, JSON.stringify(d.body.error)).toMatchObject({ code: "conflict", details: { reason: "being_confirmed" } });
        else {
          expect(d.status, JSON.stringify(d.body.error)).toBe(200);
          expect(d.body.receipt.commandId).toBe(stored[0]!.command_id);
        }
      }
      expect(decisions.filter((x) => x.decision === "confirm" && x.status === 200).length, "at least one confirmation answered with the receipt").toBeGreaterThanOrEqual(1);
      for (const d of decisions.filter((x) => x.decision === "reject")) expect(d.status).toBe(409);
      // A copy that was told to look again later gets the one receipt, replayed, and the merge does not run again.
      const retried = await owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision: "confirm" });
      const retriedBody = (await retried.json()) as any;
      expect(retried.status, JSON.stringify(retriedBody.error)).toBe(200);
      expect(retriedBody.receipt.commandId).toBe(stored[0]!.command_id);
      expect(retriedBody.replayed).toBe(true);
      expect((await count("commands", owner.userId, "type = 'garment.merge'")) - mergesBefore).toBe(1);
    } else {
      expect(outcome).toBe("rejected");
      expect(ran).toBe(0);
      expect(await mergedInto("syn03-contested-source")).toBeNull();
      expect(await buckets(owner, "syn03-contested-target")).toEqual({ clean: 1 });
      expect(await buckets(owner, "syn03-contested-source")).toEqual({ clean: 1 });
      for (const d of decisions.filter((x) => x.decision === "confirm")) expect(d.status).toBe(409);
    }
  });

  it("five parallel calls of one assistant command under one key record it once", async () => {
    const owner = world.synthetic;
    await make(owner, "syn03-mcp-parallel", { care: "handwash", quantity: 6 });
    const key = uid("mcp-parallel");
    const payload = { items: [{ garmentId: "syn03-mcp-parallel", quantity: 1 }] };
    const results = await Promise.all(Array.from({ length: 5 }, () => viaMcp(syntheticMcp, "care.mark_dirty", payload, { idempotencyKey: key })));
    for (const r of results) expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(new Set(results.map((r) => r.receipt.commandId)).size).toBe(1);
    expect(results.filter((r) => r.receipt.replayed === false)).toHaveLength(1);
    expect(await rowsForKey(owner, key)).toHaveLength(1);
    expect(await buckets(owner, "syn03-mcp-parallel")).toEqual({ clean: 5, dirty: 1 });
    // The assistant's undo of its own report, retried in parallel under one key, is one undo.
    const undoKey = uid("mcp-undo");
    const undos = await Promise.all(Array.from({ length: 4 }, () => viaMcp(syntheticMcp, "command.undo", { commandId: results[0]!.receipt.commandId }, { idempotencyKey: undoKey })));
    for (const u of undos) expect(u.error, JSON.stringify(u.error)).toBeNull();
    expect(new Set(undos.map((u) => u.receipt.commandId)).size).toBe(1);
    expect(await buckets(owner, "syn03-mcp-parallel")).toEqual({ clean: 6 });
  });
});
