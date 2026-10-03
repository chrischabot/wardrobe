import { beforeAll, describe, expect, it } from "vitest";
import { connectedDispositionOfType, TYPED_DIRECT_BY_OWNER_DECISION } from "../src/mcp/policy.ts";
import { LABELS } from "../src/proposals/store.ts";
import { connectMcp, provisionOwner, testApp, toolResult, type McpConnection, type TestOwner } from "../src/testing/index.ts";
import { CONSEQUENTIAL_COMMAND_TYPES } from "@garderobe/contracts/ext/api";

/*
 * What a connected assistant's typed command (`garderobe_command`) does with every registered command
 * type, through the real Worker's MCP route with the SDK client. The owner's rule: a connected assistant
 * may propose, but a change runs only after the signed-in owner confirms it in the app; wear and wash
 * reports for garments it names (and research records) are the exception.
 *
 * Every owner here is synthetic and every garment is a labelled test fixture: the real owner's records
 * are not touched by this file.
 */

/** Recorded at once. Everything not named in these three lists waits for the owner. */
const DIRECT = ["board.select", "care.mark_dirty", "care.washed", "laundry.collect", "laundry.return", "product.record", "product.record_fit_assessment", "product.record_observation", "research.save_note", "stock.pack", "stock.unpack", "wear.record"];
/** Refused outright by the restriction guard. */
const LIFT = ["assistant.lift_restriction", "restriction.resolve"];
/** Not available to a connection at all: system bookkeeping, account-level commands, commands that take no owner statement. */
const INTERNAL = [
  "assistant.report_arrival", "board.present", "board.publish", "calendar.record_snapshot", "connection.record_discovery", "connection.record_health", "conversation.confirm_erasure",
  "exposure.publish", "exposure.supersede", "import.record_run", "inference.record_probe", "inference.reserve", "inference.settle", "job.update", "laundry.apply_weekly_reset",
  "mail.record_sync", "media.apply_retention", "media.complete_job", "media.discard_composite", "media.expire_uploads", "media.fail_job", "media.import_records",
  "media.reapply_deletions", "media.record_composite", "media.record_discovery", "media.record_normalization", "search.record_instance", "style.import_document",
  "trip.record_packing_proposal", "weather.record_snapshot",
];

let owner: TestOwner;
let garmentId: string;
let correctedBy: string;
const GARMENT_NAME = "Synthetic scarf (command-class test fixture, not real stock)";

const call = async (mcp: McpConnection, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type, payload, idempotencyKey: `class-${crypto.randomUUID()}`, ...extra } }));
const commandCount = async (o: TestOwner) => ((await (await testApp()).db.prepare("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?").bind(o.userId).first<{ n: number }>())!.n);
const pending = async (o: TestOwner) => (await o.api.json("GET", "/v1/proposals")).proposals as any[];
const garment = async (o: TestOwner, id: string) => (await o.api.json("GET", `/v1/items/${id}`)).detail;
const source = { kind: "owner_statement" };

async function fixtureGarment(o: TestOwner, name: string): Promise<string> {
  const receipt = (await (await o.api.command("garment.create", { name, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 2, isSynthetic: true, source: { kind: "system", note: "synthetic test garment" } })).json()) as any;
  if (!receipt.affected) throw new Error(`garment.create failed: ${JSON.stringify(receipt)}`);
  return receipt.affected.find((a: any) => a.kind === "garment").id;
}

beforeAll(async () => {
  owner = await provisionOwner();
  garmentId = await fixtureGarment(owner, GARMENT_NAME);
  // A correction the owner made in the app, for the undo case below.
  const corrected = (await (await owner.api.command("garment.correct", { garmentId, changes: { colour: "navy" }, source })).json()) as any;
  if (!corrected.commandId) throw new Error(`garment.correct failed: ${JSON.stringify(corrected)}`);
  correctedBy = corrected.commandId;
});

describe("the class of every command type", () => {
  it("is direct only for wear and wash reports, research records and the four routine actions the owner allowed; every other owner-facing type waits for the owner", async () => {
    const { registry } = await testApp();
    const actual: Record<string, string> = {};
    for (const type of registry.types()) actual[type] = connectedDispositionOfType(registry, type, {});
    const expected: Record<string, string> = {};
    for (const type of registry.types()) expected[type] = DIRECT.includes(type) ? "direct" : LIFT.includes(type) ? "lift" : INTERNAL.includes(type) ? "internal" : "owner";
    expect(actual).toEqual(expected);
    // The lists above name only types that exist.
    for (const type of [...DIRECT, ...LIFT, ...INTERNAL]) expect(registry.has(type), type).toBe(true);
    // A research job is the assistant's own bookkeeping; a job that reads the owner's mailbox or files is not.
    expect(connectedDispositionOfType(registry, "job.create", { kind: "product_investigation" })).toBe("direct");
    expect(connectedDispositionOfType(registry, "job.create", { kind: "email_investigation" })).toBe("owner");
    // The contract's list of sensitive types is a floor: each of them waits for the owner or is not available at all.
    for (const type of CONSEQUENTIAL_COMMAND_TYPES) expect(["owner", "internal"], type).toContain(actual[type]);
    // The routine, undoable actions of the owner's decision of 2026-10-03, and nothing else, run from a typed command only.
    // Every type that can wait for the owner has a plain label, so no request is ever named by its command name.
    for (const [type, disposition] of Object.entries(actual)) if (disposition === "owner") expect(LABELS[type], `label for ${type}`).toBeTruthy();
    // (`laundry.return` joined them once a recorded return could be undone.)
    expect([...TYPED_DIRECT_BY_OWNER_DECISION].sort()).toEqual(["board.select", "laundry.collect", "laundry.return", "stock.pack", "stock.unpack"]);
  });

  it("publishes the same thing in command_types, to the app and to the connection", async () => {
    const types = (await owner.api.json("GET", "/v1/command-types")).types as { type: string; consequential: boolean }[];
    expect(types.filter((t) => !t.consequential).map((t) => t.type).sort()).toEqual(DIRECT);
    const mcp = await connectMcp(owner, { write: true, clientName: "Listing assistant (test)" });
    const listed = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "command_types" } }));
    expect(listed.data.data.types.filter((t: any) => !t.consequential).map((t: any) => t.type).sort()).toEqual(DIRECT);
    await mcp.close();
  });
});

describe("a typed command from a connected assistant", () => {
  it("never runs a type outside the direct list: sent with an empty payload, every such type is refused and no command is recorded", async () => {
    // A second synthetic owner, so the requests an empty payload happens to satisfy do not fill the first one's list.
    const other = await provisionOwner();
    const mcp = await connectMcp(other, { write: true, clientName: "Sweeping assistant (test)" });
    const { registry } = await testApp();
    const before = await commandCount(other);
    for (const type of registry.types()) {
      if (DIRECT.includes(type)) continue;
      const result = await call(mcp, type, {});
      expect(result.ok, type).toBe(false);
      if (INTERNAL.includes(type)) expect(result.error, type).toMatchObject({ code: "forbidden", details: { reason: "not_available_to_connected_assistant" } });
      else if (!LIFT.includes(type)) expect(["confirmation_required", "invalid_command"], `${type}: ${result.error!.code}`).toContain(result.error!.code);
    }
    expect(await commandCount(other)).toBe(before);
    await mcp.close();
  });

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
    expect(await pending(owner)).toEqual([]); // nothing is put before the owner either
    await mcp.close();
  });

  it("waits for the owner with a valid request of each kind: the answer names the proposal and carries the summary the owner will read, and nothing changes", async () => {
    const mcp = await connectMcp(owner, { write: true, clientName: "Helpful assistant (test)" });
    const settingsBefore = (await owner.api.json("GET", "/v1/settings")).settings;
    const before = await commandCount(owner);
    const cases: [string, Record<string, unknown>][] = [
      // The six that ran directly before 2026-10-03.
      ["garment.correct", { garmentId, changes: { name: "Renamed by a connected assistant" }, source }],
      ["garment.add_alias", { garmentId, phrase: "the assistant's nickname" }],
      ["garment.move", { garmentId, to: "storage", quantity: 1 }],
      ["settings.update", { patch: { timezone: "Asia/Tokyo" } }],
      ["service.pause", {}],
      ["restriction.add", { kind: "other", scope: { garmentIds: [garmentId] }, reason: "Synthetic restriction (test fixture)", source }],
      // Records of the wardrobe and of the owner.
      ["garment.remove_alias", { garmentId, phrase: "anything" }],
      ["garment.set_planning_policy", { garmentId, policy: "excluded", reason: "test fixture" }],
      ["garment.retire", { garmentId, disposition: "donated" }],
      ["stock.reconcile", { garmentId, counts: { clean: 1, total: 1 } }],
      // Packing for something that is not one of the owner's planned trips is not a packing check.
      ["stock.pack", { tripId: "trp_fixture", items: [{ garmentId, quantity: 1 }] }],
      ["stock.unpack", { tripId: "trp_fixture" }],
      ["measurement.record", { subject: "body", key: "chest", value: 40, unit: "in", source }],
      ["size_experience.record", { maker: "Synthetic maker (test fixture)", sizeLabel: "M" }],
      ["memory.record_conclusion", { kind: "preference", text: "Synthetic preference (test fixture)", speaker: "owner", sourceMessageIds: ["msg_fixture"], status: "active" }],
      ["memory.set_status", { conclusionId: "mem_fixture", status: "retired" }],
      ["feedback.record", { text: "Synthetic comfort note (test fixture)", kind: "scratchy", garmentIds: [garmentId] }],
      ["wear.amend", { wearingDate: "2026-09-01", remove: [garmentId] }],
      // Laundry returns and exceptions, and the hamper as a whole. (A pickup runs directly: mcp-routine-actions.test.ts.)
      ["laundry.return", { stillAway: [{ garmentId, quantity: 1 }] }],
      ["laundry.report_exception", { kind: "delayed" }],
      ["care.washed", { allOfChannel: "service" }],
      // Plans and settings. (Choosing an option on the published board runs directly.)
      ["board.suppress", { localDate: "2026-12-01" }],
      ["service.resume", {}],
      ["style.set_brief", { localDate: "2026-12-01", text: "Synthetic brief (test fixture)", source }],
      ["studio.save_combination", { slots: [{ role: "top", garmentId }] }],
      ["trip.cancel", { tripId: "trp_fixture" }],
      ["reminder.set", { kind: "other", title: "Synthetic reminder (test fixture)", dueAt: "2026-12-01T09:00:00Z" }],
      ["return.open_case", { kind: "return" }],
      ["lifecycle.open_project", { kind: "tailoring", title: "Synthetic project (test fixture)", items: [{ garmentId }] }],
      ["media.request_discovery", {}],
      // Connections, model routing and jobs that read the owner's own accounts.
      ["connection.register", { kind: "mcp", label: "Synthetic service (test fixture)", endpoint: "https://service.example.test/mcp", namespace: "fixture" }],
      ["inference.set_routing", { task: "conversation", profileId: "fixture-profile", gatewayId: "fixture-gateway" }],
      ["job.create", { kind: "email_investigation", title: "Synthetic mailbox job (test fixture)" }],
      // The undo of a change that itself would wait.
      ["command.undo", { commandId: correctedBy }],
    ];
    const ids = new Set<string>();
    for (const [type, payload] of cases) {
      const result = await call(mcp, type, payload);
      expect(result.ok, type).toBe(false);
      expect(result.error, `${type}: ${JSON.stringify(result.error)}`).toMatchObject({ code: "confirmation_required", details: { reason: "owner_confirmation_required", state: "pending" } });
      const { proposalId, summary } = result.error!.details as { proposalId: string; summary: string };
      expect(proposalId, type).toMatch(/^prp_[0-9a-f]{32}$/);
      expect(summary.length, type).toBeGreaterThan(0);
      ids.add(proposalId);
    }
    expect(ids.size).toBe(cases.length);
    // Nothing ran: no command was recorded and the records read as before.
    expect(await commandCount(owner)).toBe(before);
    const detail = await garment(owner, garmentId);
    expect(detail.garment.name).toBe(GARMENT_NAME);
    expect(detail.garment.colour).toBe("navy");
    expect(detail.totalOwnedUnits).toBe(2);
    expect((await owner.api.json("GET", "/v1/settings")).settings).toEqual(settingsBefore);
    expect((await owner.api.json("GET", "/v1/service")).paused).toBe(false);
    expect((await (await testApp()).db.prepare("SELECT COUNT(*) AS n FROM restrictions WHERE user_id = ?").bind(owner.userId).first<{ n: number }>())!.n).toBe(0);
    // The owner sees exactly these requests, each with the summary the connection was given.
    const listed = await pending(owner);
    expect(new Set(listed.map((p) => p.proposalId))).toEqual(ids);
    const correct = listed.find((p) => p.type === "garment.correct")!;
    expect(correct).toMatchObject({ source: { channel: "mcp", assistantName: "Helpful assistant (test)" }, payload: { garmentId, changes: { name: "Renamed by a connected assistant" } } });
    expect(correct.summary).toContain(`Change the record of \u201C${GARMENT_NAME}\u201D: name \u201CRenamed by a connected assistant\u201D`);
    expect(correct.summary).not.toContain(garmentId);
    expect(listed.find((p) => p.type === "command.undo")!.summary).toContain("Undo an earlier change (correct a garment's details) whose receipt read \u201C");
    // No summary shows a record identifier of a record that exists, raw JSON, or a command's machine name.
    for (const p of listed) {
      expect(p.summary, p.type).not.toContain(garmentId);
      expect(p.summary, p.type).not.toMatch(/[{}]|":/);
      expect(p.summary, p.type).not.toMatch(/^Carry out /);
      expect(p.summary, p.type).not.toMatch(/\u201C[a-z_]+\.[a-z_]+\u201D/); // no quoted command name such as “garment.correct”
    }

    // The owner confirms the correction in the app: it runs once, as the owner's tap.
    const decided = (await (await owner.api.post(`/v1/proposals/${correct.proposalId}/decision`, { decision: "confirm" })).json()) as any;
    expect(decided).toMatchObject({ replayed: false, proposal: { state: "confirmed" }, receipt: { type: "garment.correct", outcome: "committed" } });
    expect((await garment(owner, garmentId)).garment.name).toBe("Renamed by a connected assistant");
    const row = await (await testApp()).db.prepare("SELECT actor, channel, authorization_basis FROM commands WHERE user_id = ? AND command_id = ?").bind(owner.userId, decided.receipt.commandId).first();
    expect(row).toEqual({ actor: "owner", channel: "ios", authorization_basis: "owner_tap" });
    // The rest are rejected, and none of them is carried out.
    for (const p of listed) if (p.proposalId !== correct.proposalId) expect((await owner.api.post(`/v1/proposals/${p.proposalId}/decision`, { decision: "reject" })).status, p.type).toBe(200);
    expect(await commandCount(owner)).toBe(before + 1);
    expect(await pending(owner)).toEqual([]);
    await mcp.close();
  });

  it("records a wear report, a wash report naming its garments, a needs-a-wash report and research records at once, and undoes them directly", async () => {
    const other = await provisionOwner();
    const id = await fixtureGarment(other, "Synthetic shirt (direct-report test fixture, not real stock)");
    const mcp = await connectMcp(other, { write: true, clientName: "Reporting assistant (test)" });
    const today = (await other.api.json("GET", "/v1/today")).localDate as string;
    const cases: [string, Record<string, unknown>][] = [
      ["wear.record", { wearingDate: today, garmentIds: [id] }],
      ["care.washed", { items: [{ garmentId: id, quantity: 1 }] }],
      ["care.mark_dirty", { items: [{ garmentId: id, quantity: 1 }] }],
      ["research.save_note", { topic: "Synthetic research topic (test fixture)", body: "Synthetic research note (test fixture)." }],
      ["product.record", { name: "Synthetic product (test fixture)" }],
    ];
    const receipts: Record<string, any> = {};
    for (const [type, payload] of cases) {
      const result = await call(mcp, type, payload);
      expect(result.ok, `${type}: ${JSON.stringify(result.error)}`).toBe(true);
      expect(result.data.receipt, type).toMatchObject({ type, actor: "assistant", channel: "mcp" });
      receipts[type] = result.data.receipt;
    }
    expect(await pending(other)).toEqual([]);
    const undone = await call(mcp, "command.undo", { commandId: receipts["care.mark_dirty"].commandId });
    expect(undone.ok, JSON.stringify(undone.error)).toBe(true);
    await mcp.close();
  });

  it("does not record a wear of a garment that an active restriction excludes: that waits for the owner", async () => {
    const other = await provisionOwner();
    const id = await fixtureGarment(other, "Synthetic restricted shirt (test fixture, not real stock)");
    const added = (await (await other.api.command("restriction.add", { kind: "other", scope: { garmentIds: [id] }, reason: "Synthetic restriction (test fixture)", source })).json()) as any;
    expect(added.outcome, JSON.stringify(added)).toBe("committed");
    const mcp = await connectMcp(other, { write: true, clientName: "Insistent assistant (test)" });
    const today = (await other.api.json("GET", "/v1/today")).localDate as string;
    const result = await call(mcp, "wear.record", { wearingDate: today, garmentIds: [id] });
    expect(result.error).toMatchObject({ code: "confirmation_required", details: { reason: "owner_confirmation_required" } });
    expect((await other.api.json("GET", `/v1/days/${today}`)).garments).toEqual([]);
    await mcp.close();
  });

  it("is refused as stale when the owner changed the garment after the request was made: confirming answers 409 and nothing changes", async () => {
    const other = await provisionOwner();
    const id = await fixtureGarment(other, "Synthetic stale-request shirt (test fixture, not real stock)");
    const version = (await garment(other, id)).garment.version as number;
    const mcp = await connectMcp(other, { write: true, clientName: "Slow assistant (test)" });
    const retire = await call(mcp, "garment.retire", { garmentId: id, disposition: "donated" }, { expectedVersions: { [`garment:${id}`]: version } });
    const rename = await call(mcp, "garment.correct", { garmentId: id, changes: { name: "Renamed against an old version" }, source }, { expectedVersions: { [`garment:${id}`]: version } });
    expect(retire.error!.code).toBe("confirmation_required");
    expect(rename.error!.code).toBe("confirmation_required");
    // The owner corrects the garment in the app, which moves its version on.
    expect((await other.api.command("garment.correct", { garmentId: id, changes: { colour: "white" }, source })).status).toBe(200);
    const before = await commandCount(other);
    for (const proposalId of [(retire.error!.details as any).proposalId, (rename.error!.details as any).proposalId]) {
      const response = await other.api.post(`/v1/proposals/${proposalId}/decision`, { decision: "confirm" });
      expect(response.status).toBe(409);
      expect(((await response.json()) as any).error.code).toBe("conflict");
    }
    expect(await commandCount(other)).toBe(before);
    const after = await garment(other, id);
    expect(after.garment.name).toBe("Synthetic stale-request shirt (test fixture, not real stock)");
    expect(after.totalOwnedUnits).toBe(2);
    // Both requests are still open; the owner can only reject them.
    expect((await pending(other)).map((p) => p.state)).toEqual(["pending", "pending"]);
    await mcp.close();
  });

  it("counts only requests the owner has not decided towards a connection's limit, so a decided request makes room for the next", async () => {
    const other = await provisionOwner();
    const mcp = await connectMcp(other, { write: true, clientName: "Busy assistant (test)" });
    const ask = (n: number) => call(mcp, "reminder.set", { kind: "other", title: `Synthetic reminder ${n} (test fixture)`, dueAt: "2026-12-01T09:00:00Z" });
    for (let n = 0; n < 40; n++) expect((await ask(n)).error!.code, `request ${n}`).toBe("confirmation_required");
    expect((await ask(40)).error).toMatchObject({ code: "rate_limited", details: { reason: "too_many_requests_waiting" } });
    const [first, second] = await pending(other);
    expect((await other.api.post(`/v1/proposals/${first.proposalId}/decision`, { decision: "confirm" })).status).toBe(200);
    expect((await other.api.post(`/v1/proposals/${second.proposalId}/decision`, { decision: "reject" })).status).toBe(200);
    expect((await ask(41)).error!.code).toBe("confirmation_required");
    expect((await ask(42)).error!.code).toBe("confirmation_required");
    expect((await ask(43)).error!.code).toBe("rate_limited");
    await mcp.close();
  });
});
