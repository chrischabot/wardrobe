import { beforeAll, describe, expect, it } from "vitest";
import { SECTION3_CONFIRM_TYPES } from "@garderobe/assistant";
import { CONNECTED_BULK_LIMIT, connectedDispositionOfType } from "../src/mcp/policy.ts";
import { LABELS } from "../src/proposals/store.ts";
import { connectMcp, provisionOwner, testApp, toolResult, type McpConnection, type TestOwner } from "../src/testing/index.ts";

/*
 * What a connected assistant's typed command (`garderobe_command`) does with every registered command
 * type, through the real Worker's MCP route with the SDK client, under the owner's contract of 2026-10-05
 * ("Changes apply at once with undo on every surface"): a change applies at once with a receipt and an
 * undo; the contract's section 3 list waits for the signed-in owner; a restriction is never lifted by a
 * connection. This surface also keeps for the owner a job that reads the owner's mailbox or files and a
 * change to an unbounded set (mcp/policy.ts).
 *
 * Every owner here is synthetic and every garment is a labelled test fixture: the real owner's records
 * are not touched by this file.
 */

/** Refused outright by the restriction guard. */
const LIFT = ["assistant.lift_restriction", "restriction.resolve"];
/** Not available to a connection at all: system bookkeeping, account-level commands, commands that take no owner statement. */
const INTERNAL = [
  "board.present", "board.publish", "calendar.record_snapshot", "connection.record_discovery", "connection.record_health", "conversation.confirm_erasure",
  "exposure.publish", "exposure.supersede", "import.record_run", "inference.record_probe", "inference.reserve", "inference.settle", "job.update", "laundry.apply_weekly_reset",
  "mail.record_sync", "media.apply_retention", "media.complete_job", "media.discard_composite", "media.expire_uploads", "media.fail_job", "media.import_records",
  "media.reapply_deletions", "media.record_composite", "media.record_discovery", "media.record_normalization", "search.record_instance", "style.import_document",
  "trip.record_packing_proposal", "weather.record_snapshot",
];
/** Waits for the owner whatever the payload: section 3. (With an empty payload a bulk correction states no size: it is refused as a change to an unbounded set.) */
const OWNER_ALWAYS = [...SECTION3_CONFIRM_TYPES];

let owner: TestOwner;
let garmentId: string;
const GARMENT_NAME = "Synthetic scarf (command-class test fixture, not real stock)";
const source = { kind: "owner_statement" };

const call = async (mcp: McpConnection, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type, payload, idempotencyKey: `class-${crypto.randomUUID()}`, ...extra } }));
const commandCount = async (o: TestOwner) => ((await (await testApp()).db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?").bind(o.userId).first<{ n: number }>())!.n);
const pending = async (o: TestOwner) => (await o.api.json("GET", "/v1/proposals")).proposals as any[];
const garment = async (o: TestOwner, id: string) => (await o.api.json("GET", `/v1/items/${id}`)).detail;

async function fixtureGarment(o: TestOwner, name: string, category = "shirt"): Promise<string> {
  const receipt = (await (await o.api.command("garment.create", { name, category, roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 2, isSynthetic: true, source: { kind: "system", note: "synthetic test garment" } })).json()) as any;
  if (!receipt.affected) throw new Error(`garment.create failed: ${JSON.stringify(receipt)}`);
  return receipt.affected.find((a: any) => a.kind === "garment").id;
}

beforeAll(async () => {
  owner = await provisionOwner();
  garmentId = await fixtureGarment(owner, GARMENT_NAME);
});

describe("the class of every command type", () => {
  it("is direct for every owner-facing type except section 3 (and a bulk correction that states no size, which is refused as unbounded); lifts are refused and system types are internal", async () => {
    const { registry } = await testApp();
    const actual: Record<string, string> = {};
    for (const type of registry.types()) actual[type] = connectedDispositionOfType(registry, type, {});
    const expected: Record<string, string> = {};
    for (const type of registry.types()) expected[type] = LIFT.includes(type) ? "lift" : INTERNAL.includes(type) ? "internal" : OWNER_ALWAYS.includes(type) ? "owner" : type === "garment.bulk_correct" ? "bounded" : "direct";
    expect(actual).toEqual(expected);
    for (const type of [...LIFT, ...INTERNAL]) expect(registry.has(type), type).toBe(true);
    // The two bounds of this surface.
    expect(connectedDispositionOfType(registry, "job.create", { kind: "product_investigation" })).toBe("direct");
    expect(connectedDispositionOfType(registry, "job.create", { kind: "email_investigation" })).toBe("owner");
    expect(connectedDispositionOfType(registry, "job.create", { kind: "sheet_import" })).toBe("owner");
    expect(connectedDispositionOfType(registry, "garment.bulk_correct", { expectedCount: CONNECTED_BULK_LIMIT })).toBe("direct");
    expect(connectedDispositionOfType(registry, "garment.bulk_correct", { expectedCount: 43 })).toBe("bounded");
    expect(connectedDispositionOfType(registry, "care.washed", { allOfChannel: "service" })).toBe("bounded");
    expect(connectedDispositionOfType(registry, "wear.record", { garmentIds: Array.from({ length: CONNECTED_BULK_LIMIT + 1 }, (_, i) => `gmt_${i}`) })).toBe("bounded");
    // Every type that can wait for the owner has a plain label, so no request is ever named by its command name.
    for (const [type, disposition] of Object.entries(actual)) if (disposition === "owner") expect(LABELS[type], `label for ${type}`).toBeTruthy();
  });

  it("publishes the same thing in command_types, to the app and to the connection", async () => {
    const { registry } = await testApp();
    const direct = registry.types().filter((t) => connectedDispositionOfType(registry, t, {}) === "direct").sort();
    const types = (await owner.api.json("GET", "/v1/command-types")).types as { type: string; consequential: boolean }[];
    expect(types.filter((t) => !t.consequential).map((t) => t.type).sort()).toEqual(direct);
    const mcp = await connectMcp(owner, { write: true, clientName: "Listing assistant (test)" });
    const listed = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "command_types" } }));
    expect(listed.data.data.types.filter((t: any) => !t.consequential).map((t: any) => t.type).sort()).toEqual(direct);
    await mcp.close();
  });
});

describe("a typed command from a connected assistant", () => {
  it("is refused outright for system and account-level types, even with a payload that would run", async () => {
    const mcp = await connectMcp(owner, { write: true, clientName: "System-minded assistant (test)" });
    const before = await commandCount(owner);
    const cases: [string, Record<string, unknown>][] = [
      ["connection.record_health", { connectionId: "con_fixture", ok: false, authFailure: true }],
      ["conversation.confirm_erasure", { sourceKind: "message", sourceIds: ["msg_fixture"], store: "transcript", outstandingRetention: null }],
      ["job.update", { jobId: "job_fixture", state: "completed" }],
      ["exposure.supersede", { exposureIds: ["exp_fixture"] }],
      ["laundry.apply_weekly_reset", {}],
      ["import.record_run", {}],
      ["media.import_records", { part: "assets", rows: {} }],
    ];
    for (const [type, payload] of cases) {
      const result = await call(mcp, type, payload);
      expect(result.error, type).toMatchObject({ code: "forbidden", details: { reason: "not_available_to_connected_assistant" } });
    }
    expect(await commandCount(owner)).toBe(before);
    expect(await pending(owner)).toEqual([]);
    await mcp.close();
  });

  it("applies a direction at once with a receipt naming the connection, and the connection can undo it", async () => {
    const other = await provisionOwner();
    const id = await fixtureGarment(other, "Synthetic shirt (direction test fixture, not real stock)");
    const mcp = await connectMcp(other, { write: true, clientName: "Directing assistant (test)" });
    const corrected = await call(mcp, "garment.correct", { garmentId: id, changes: { colour: "navy" }, source });
    expect(corrected.ok, JSON.stringify(corrected.error)).toBe(true);
    expect(corrected.data.receipt).toMatchObject({ type: "garment.correct", outcome: "committed", actor: "assistant", channel: "mcp" });
    expect((await garment(other, id)).garment.colour).toBe("navy");
    // The connection can undo its correction (while nothing has changed the piece since: an undo never
    // overwrites a later change, so this comes before the further directions below).
    const undone = await call(mcp, "command.undo", { commandId: corrected.data.receipt.commandId });
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    expect((await garment(other, id)).garment.colour ?? null).not.toBe("navy");
    for (const [type, payload] of [
      ["garment.add_alias", { garmentId: id, phrase: "the synthetic test shirt" }],
      ["reminder.set", { kind: "other", title: "Synthetic reminder (test fixture)", dueAt: "2026-12-01T09:00:00Z" }],
      ["restriction.add", { kind: "other", scope: { garmentIds: [id] }, reason: "Synthetic restriction (test fixture)", source }],
    ] as [string, Record<string, unknown>][]) {
      const result = await call(mcp, type, payload);
      expect(result.ok, `${type}: ${JSON.stringify(result.error)}`).toBe(true);
    }
    expect(await pending(other)).toEqual([]);
    await mcp.close();
  });

  it("records a wear report at once whatever its date and whichever piece it names, a restricted one included: an observation is a fact", async () => {
    const other = await provisionOwner();
    const id = await fixtureGarment(other, "Synthetic restricted shirt (observation test fixture, not real stock)");
    expect((await other.api.command("restriction.add", { kind: "other", scope: { garmentIds: [id] }, reason: "Synthetic restriction (test fixture)", source })).status).toBe(200);
    const mcp = await connectMcp(other, { write: true, clientName: "Reporting assistant (test)" });
    for (const wearingDate of ["2026-01-05", (await other.api.json("GET", "/v1/today")).localDate as string]) {
      const result = await call(mcp, "wear.record", { wearingDate, garmentIds: [id] });
      expect(result.ok, `${wearingDate}: ${JSON.stringify(result.error)}`).toBe(true);
    }
    const occurredAt = new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    expect((await call(mcp, "care.mark_dirty", { items: [{ garmentId: id, quantity: 1 }] }, { occurredAt })).ok).toBe(true);
    expect(await pending(other)).toEqual([]);
    await mcp.close();
  });

  it("never undoes the record of a restriction, and never lifts one", async () => {
    const other = await provisionOwner();
    const id = await fixtureGarment(other, "Synthetic shirt (restriction test fixture, not real stock)");
    const added = (await (await other.api.command("restriction.add", { kind: "other", scope: { garmentIds: [id] }, reason: "Synthetic restriction (test fixture)", source })).json()) as any;
    const mcp = await connectMcp(other, { write: true, clientName: "Lifting assistant (test)" });
    const before = await commandCount(other);
    expect((await call(mcp, "command.undo", { commandId: added.commandId })).error!.code).toBe("forbidden");
    expect(await commandCount(other)).toBe(before);
    expect(await pending(other)).toEqual([]);
    await mcp.close();
  });

  it("keeps section 3 and a job that reads the owner's mailbox or files for the owner; nothing changes until the owner confirms", async () => {
    const mcp = await connectMcp(owner, { write: true, clientName: "Helpful assistant (test)" });
    const before = await commandCount(owner);
    const cases: [string, Record<string, unknown>][] = [
      ["connection.register", { kind: "mcp", label: "Synthetic service (test fixture)", endpoint: "https://service.example.test/mcp", namespace: "fixture" }],
      ["inference.set_routing", { task: "conversation", profileId: "fixture-profile", gatewayId: "fixture-gateway" }],
      ["job.create", { kind: "email_investigation", title: "Synthetic mailbox job (test fixture)" }],
      ["job.create", { kind: "sheet_import", title: "Synthetic spreadsheet import (test fixture)" }],
    ];
    const ids = new Set<string>();
    for (const [type, payload] of cases) {
      const result = await call(mcp, type, payload);
      expect(result.ok, type).toBe(false);
      expect(result.error, `${type}: ${JSON.stringify(result.error)}`).toMatchObject({ code: "confirmation_required", details: { reason: "owner_confirmation_required", state: "pending" } });
      ids.add((result.error!.details as { proposalId: string }).proposalId);
    }
    expect(ids.size).toBe(cases.length);
    expect(await commandCount(owner)).toBe(before);
    expect((await garment(owner, garmentId)).garment.maker ?? null).toBeNull();
    const listed = await pending(owner);
    expect(new Set(listed.map((p) => p.proposalId))).toEqual(ids);
    for (const p of listed) {
      expect(p.summary, p.type).not.toContain(garmentId);
      expect(p.summary, p.type).not.toMatch(/\u201C[a-z_]+\.[a-z_]+\u201D/);
    }
    // The owner confirms the connection registration in the app: it runs once, as the owner's tap.
    const chosen = listed.find((p) => p.type === "connection.register")!;
    const decided = (await (await owner.api.post(`/v1/proposals/${chosen.proposalId}/decision`, { decision: "confirm" })).json()) as any;
    expect(decided).toMatchObject({ proposal: { state: "confirmed" }, receipt: { type: "connection.register", outcome: "committed" } });
    const registered = await (await testApp()).db.prepare("SELECT label FROM connections WHERE user_id = ?").bind(owner.userId).first<{ label: string }>();
    expect(registered?.label).toBe("Synthetic service (test fixture)");
    for (const p of listed) if (p.proposalId !== chosen.proposalId) expect((await owner.api.post(`/v1/proposals/${p.proposalId}/decision`, { decision: "reject" })).status, p.type).toBe(200);
    expect(await pending(owner)).toEqual([]);
    await mcp.close();
  });

  it("refuses a change to an unbounded set outright with a clear message, keeps nothing waiting and changes nothing", async () => {
    const other = await provisionOwner();
    const id = await fixtureGarment(other, "Synthetic shirt (unbounded change test fixture, not real stock)");
    const mcp = await connectMcp(other, { write: true, clientName: "Overreaching assistant (test)" });
    const before = await commandCount(other);
    const cases: [string, Record<string, unknown>][] = [
      // The review's case: one bulk correction setting the maker of every shirt, size unstated, and the same with 43.
      ["garment.bulk_correct", { selector: { category: "shirt" }, changes: { maker: "Gucci" }, source }],
      ["garment.bulk_correct", { selector: { category: "shirt" }, changes: { maker: "Gucci" }, expectedCount: 43, source }],
      ["care.washed", { allOfChannel: "service" }],
      ["wear.record", { wearingDate: "2026-09-01", garmentIds: Array.from({ length: CONNECTED_BULK_LIMIT + 1 }, () => id) }],
    ];
    for (const [type, payload] of cases) {
      const result = await call(mcp, type, payload);
      expect(result.ok, type).toBe(false);
      expect(result.error, `${type}: ${JSON.stringify(result.error)}`).toMatchObject({ code: "invalid_command", details: { reason: "change_exceeds_bound", limit: CONNECTED_BULK_LIMIT } });
      expect(result.error!.message).toContain(`at most ${CONNECTED_BULK_LIMIT}`);
    }
    expect(await commandCount(other)).toBe(before);
    expect(await pending(other)).toEqual([]);
    expect((await garment(other, id)).garment.maker ?? null).toBeNull();
    // Exactly at the bound is applied at once.
    const atBound = await call(mcp, "wear.record", { wearingDate: "2026-09-02", garmentIds: Array.from({ length: CONNECTED_BULK_LIMIT }, () => id) });
    expect(atBound.ok, JSON.stringify(atBound.error)).toBe(true);
    await mcp.close();
  });

  it("applies a bulk correction that states a size within the bound at once, with one undo", async () => {
    const other = await provisionOwner();
    const id = await fixtureGarment(other, "Synthetic shirt (bounded bulk test fixture, not real stock)");
    const mcp = await connectMcp(other, { write: true, clientName: "Bulk assistant (test)" });
    const result = await call(mcp, "garment.bulk_correct", { selector: { category: "shirt" }, changes: { maker: "Synthetic maker" }, expectedCount: 1, source });
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect((await garment(other, id)).garment.maker).toBe("Synthetic maker");
    expect((await call(mcp, "command.undo", { commandId: result.data.receipt.commandId })).ok).toBe(true);
    expect((await garment(other, id)).garment.maker ?? null).toBeNull();
    await mcp.close();
  });

  it("counts only requests the owner has not decided towards a connection's limit, so a decided request makes room for the next", async () => {
    const other = await provisionOwner();
    const mcp = await connectMcp(other, { write: true, clientName: "Busy assistant (test)" });
    const ask = (n: number) => call(mcp, "inference.set_routing", { task: "conversation", profileId: `fixture-profile-${n}`, gatewayId: "fixture-gateway" });
    for (let n = 0; n < 40; n++) expect((await ask(n)).error!.code, `request ${n}`).toBe("confirmation_required");
    expect((await ask(40)).error).toMatchObject({ code: "rate_limited", details: { reason: "too_many_requests_waiting" } });
    const [first, second] = await pending(other);
    expect((await other.api.post(`/v1/proposals/${first.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
    expect((await other.api.post(`/v1/proposals/${second.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
    expect((await ask(41)).error!.code).toBe("confirmation_required");
    expect((await ask(42)).error!.code).toBe("confirmation_required");
    expect((await ask(43)).error!.code).toBe("rate_limited");
    await mcp.close();
  });
});
