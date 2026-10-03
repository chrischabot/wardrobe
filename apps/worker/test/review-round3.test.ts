import { beforeAll, describe, expect, it } from "vitest";
import { MAX_SUMMARY_CHARS, WAITING_LIMITS } from "../src/proposals/store.ts";
import { connectMcp, enableFakeModel, ownerDay, provisionOwner, testApp, toolResult, type FakeModel, type McpConnection, type TestOwner } from "../src/testing/index.ts";

/*
 * The Worker's part of the third independent review (2026-10-03), through the real routes: the MCP tools
 * with the SDK client, POST /v1/conversation/turns, GET /v1/proposals and the decision route.
 *
 * Every owner here is SYNTHETIC and every garment is a labelled test fixture; the real owner's records
 * are not touched by this file. Stand-ins: test-signed Access assertions in place of Cloudflare Access,
 * and the labelled FAKE MODEL, scripted to call the tools a model acting on the message would call.
 */

const source = { kind: "owner_statement" };
const typed = async (mcp: McpConnection, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  toolResult(await mcp.client.callTool({ name: "garderobe_command", arguments: { type, payload, idempotencyKey: `r3-${crypto.randomUUID()}`, ...extra } }));
const proposals = async (o: TestOwner, state: "pending" | "all" = "pending") => (await o.api.json("GET", `/v1/proposals?state=${state}`)).proposals as any[];
const decide = (o: TestOwner, proposalId: string, decision: "confirm" | "reject") => o.api.post(`/v1/proposals/${proposalId}/decision`, { decision });
const count = async (o: TestOwner, sql: string) => ((await (await testApp()).db.prepare(sql).bind(o.userId).first<{ n: number }>())!.n);
const commandCount = (o: TestOwner) => count(o, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?");
const wearCount = (o: TestOwner) => count(o, "SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND status = 'active'");
const reminder = (n: number | string) => ({ kind: "other", title: `Synthetic reminder ${n} (test fixture)`, dueAt: "2026-12-01T09:00:00Z" });

async function fixtureGarment(o: TestOwner, name: string): Promise<string> {
  const receipt = (await (await o.api.command("garment.create", { name, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 2, isSynthetic: true, source: { kind: "system", note: "synthetic test garment" } })).json()) as any;
  if (!receipt.affected) throw new Error(`garment.create failed: ${JSON.stringify(receipt)}`);
  return receipt.affected.find((a: any) => a.kind === "garment").id;
}

let model: FakeModel;

/** One owner message through the app's conversation route, waited to its end. */
async function say(o: TestOwner, body: Record<string, unknown>, calls: { toolName: string; input: Record<string, unknown> }[]) {
  model.script({ toolCalls: calls }, { text: "Done as far as I may." });
  const turn = await o.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, ...body });
  let run = turn;
  for (let i = 0; i < 200 && !["completed", "failed", "cancelled", "needs_input"].includes(run.state); i++) {
    await new Promise((r) => setTimeout(r, 25));
    run = await o.api.json("GET", `/v1/runs/${turn.runId}`);
  }
  return run as { runId: string; state: string; receipts: { type: string }[]; proposals: { type: string }[] };
}

/** A relayed request through garderobe_ask on which the model asks for `n` garments to be added: `n` requests for the owner. */
async function relayed(mcp: McpConnection, n: number, label: string) {
  const message = `add these ${n} synthetic pieces (${label})`;
  model.script({ toolCalls: Array.from({ length: n }, (_, i) => ({ toolName: "add_garment", input: { name: `Synthetic relayed piece ${label}-${i} (test fixture)`, category: "knitwear", quantity: 1, state: "owned", ownerQuote: message } })) }, { text: "That needs your confirmation in the Garderobe app." });
  return toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
}

describe("the limit on requests waiting for the owner (finding D)", () => {
  it("is shared by all of an owner's connections: a second connection gets no list of its own", async () => {
    const o = await provisionOwner();
    const first = await connectMcp(o, { write: true, clientName: "First connection (test)" });
    for (let n = 0; n < WAITING_LIMITS.perConnection; n++) expect((await typed(first, "reminder.set", reminder(`a${n}`))).error!.code, `request ${n}`).toBe("confirmation_required");
    expect((await typed(first, "reminder.set", reminder("a-over"))).error).toMatchObject({ code: "rate_limited", details: { reason: "too_many_requests_waiting" } });

    const second = await connectMcp(o, { write: true, clientName: "Second connection (test)", redirectUri: "https://second.client.test/cb" });
    const room = WAITING_LIMITS.perOwner - WAITING_LIMITS.perConnection;
    for (let n = 0; n < room; n++) expect((await typed(second, "reminder.set", reminder(`b${n}`))).error!.code, `request ${n}`).toBe("confirmation_required");
    expect((await typed(second, "reminder.set", reminder("b-over"))).error!.code).toBe("rate_limited");
    // A third connection finds the owner's list full from its first request.
    const third = await connectMcp(o, { write: true, clientName: "Third connection (test)", redirectUri: "https://third.client.test/cb" });
    expect((await typed(third, "reminder.set", reminder("c0"))).error!.code).toBe("rate_limited");
    expect(await proposals(o)).toHaveLength(WAITING_LIMITS.perOwner);
    expect(await count(o, "SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?")).toBe(0);

    // Only the owner makes room: one decision, one more request, for whichever connection is under its own share.
    const [newest] = await proposals(o);
    expect((await decide(o, newest.proposalId, "reject")).status).toBe(200);
    expect((await typed(first, "reminder.set", reminder("a-again"))).error!.code).toBe("rate_limited"); // still at its own 40
    expect((await typed(third, "reminder.set", reminder("c1"))).error!.code).toBe("confirmation_required");
    await Promise.all([first.close(), second.close(), third.close()]);
  });

  it("counts what garderobe_ask turns leave for the owner, and stops taking turns from a connection whose share is waiting", async () => {
    const o = await provisionOwner();
    model = await enableFakeModel(o);
    const mcp = await connectMcp(o, { write: true, clientName: "Asking assistant (test)" });
    for (let turn = 0; turn < WAITING_LIMITS.perConnection / 8; turn++) {
      const asked = await relayed(mcp, 8, `t${turn}`);
      expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
      expect(asked.data.receipts).toEqual([]);
      expect(asked.data.proposals).toHaveLength(8);
    }
    expect(await proposals(o)).toHaveLength(WAITING_LIMITS.perConnection);
    // The connection's share is waiting: no further turn is taken, and a typed request is refused as well.
    const turnsBefore = await count(o, "SELECT COUNT(*) AS n FROM assistant_turns WHERE user_id = ?");
    const refused = await relayed(mcp, 8, "over");
    expect(refused.error).toMatchObject({ code: "rate_limited", details: { reason: "too_many_requests_waiting" } });
    expect(await count(o, "SELECT COUNT(*) AS n FROM assistant_turns WHERE user_id = ?")).toBe(turnsBefore);
    expect((await typed(mcp, "reminder.set", reminder("after-turns"))).error!.code).toBe("rate_limited");
    expect(await proposals(o)).toHaveLength(WAITING_LIMITS.perConnection);
    // Reading is not affected.
    expect(toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot" } })).ok).toBe(true);

    // The owner decides one; the connection may ask again.
    const [one] = await proposals(o);
    expect((await decide(o, one.proposalId, "reject")).status).toBe(200);
    model.script({ text: "Nothing to do." });
    expect(toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message: "what is clean?", clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } })).ok).toBe(true);
    // What the owner asked for in the app himself is never limited by what connections left.
    const own = await say(o, { text: "Add my synthetic cardigan (test fixture)." }, [{ toolName: "add_garment", input: { name: "Synthetic cardigan asked for in the app (test fixture)", category: "knitwear", quantity: 1, state: "owned" } }]);
    expect(own.state).toBe("completed");
    await mcp.close();
  });

  it("keeps a waiting request on the owner's list however many newer turns left requests after it", async () => {
    const o = await provisionOwner();
    model = await enableFakeModel(o);
    const app = await testApp();
    const own = await say(o, { text: "Add my synthetic overshirt (test fixture)." }, [{ toolName: "add_garment", input: { name: "Synthetic overshirt, the earlier request (test fixture)", category: "shirt", quantity: 1, state: "owned" } }]);
    expect(own.proposals.map((p) => p.type)).toEqual(["garment.create"]);
    const [earlier] = await proposals(o);
    expect(earlier.payload.name).toBe("Synthetic overshirt, the earlier request (test fixture)");

    // TEST SETUP, not product behaviour: 205 newer turns that each hold one request, written straight into the
    // test database as copies of the real turn above (a real turn each would take minutes).
    const row = (await app.db.prepare("SELECT * FROM assistant_turns WHERE user_id = ? AND turn_id = ?").bind(o.userId, own.runId).first<Record<string, unknown>>())!;
    const columns = Object.keys(row);
    const insert = app.db.prepare(`INSERT INTO assistant_turns (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    const base = Date.parse(String(row.created_at));
    const copies = Array.from({ length: 205 }, (_, i) => {
      const copy = { ...row, turn_id: `${row.turn_id}-copy-${i}`, submission_id: `${row.submission_id}-copy-${i}`, user_message_id: `${row.user_message_id}-copy-${i}`, created_at: new Date(base + (i + 1) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") };
      return insert.bind(...columns.map((c) => (copy as Record<string, unknown>)[c]));
    });
    for (let i = 0; i < copies.length; i += 50) await app.db.batch(copies.slice(i, i + 50));

    const list = await o.api.json("GET", "/v1/proposals");
    expect(list.proposals).toHaveLength(206);
    expect(list.pending).toBe(206);
    expect(list.proposals.at(-1).proposalId).toBe(earlier.proposalId); // the oldest, still listed, newest first
    expect((await proposals(o, "all")).map((p) => p.proposalId)).toContain(earlier.proposalId);
    // And it is the one the owner confirms: found by identifier, carried out once.
    const confirmed = (await (await decide(o, earlier.proposalId, "confirm")).json()) as any;
    expect(confirmed).toMatchObject({ proposal: { state: "confirmed" }, receipt: { type: "garment.create", outcome: "committed" } });
    expect(await proposals(o)).toHaveLength(205);
  });
});

describe("the date of a report sent as a typed command (finding E, typed half)", () => {
  let o: TestOwner;
  let mcp: McpConnection;
  let garmentId: string;
  beforeAll(async () => {
    o = await provisionOwner();
    garmentId = await fixtureGarment(o, "Synthetic shirt (report-date test fixture, not real stock)");
    mcp = await connectMcp(o, { write: true, clientName: "Dating assistant (test)" });
  });

  it("records a wear for today and for seven days ago at once", async () => {
    for (const offset of [0, -7]) {
      const result = await typed(mcp, "wear.record", { wearingDate: await ownerDay(o, offset), garmentIds: [garmentId] });
      expect(result.ok, `${offset}: ${JSON.stringify(result.error)}`).toBe(true);
      expect(result.data.receipt).toMatchObject({ type: "wear.record", outcome: "committed" });
    }
    expect(await wearCount(o)).toBe(2);
  });

  it("does not record a wear dated months back, eight days back or tomorrow: it waits for the owner and nothing changes", async () => {
    const before = await commandCount(o);
    for (const wearingDate of ["2026-01-05", await ownerDay(o, -8), await ownerDay(o, 1)]) {
      const result = await typed(mcp, "wear.record", { wearingDate, garmentIds: [garmentId] });
      expect(result.error, wearingDate).toMatchObject({ code: "confirmation_required", details: { reason: "owner_confirmation_required", state: "pending" } });
      expect(result.error!.details.summary, wearingDate).toContain(`wearingDate: "${wearingDate}"`);
    }
    expect(await commandCount(o)).toBe(before);
    expect(await wearCount(o)).toBe(2);
    expect((await proposals(o)).map((p) => p.type)).toEqual(["wear.record", "wear.record", "wear.record"]);
  });

  it("does not record a wash or needs-a-wash report said to have happened weeks ago", async () => {
    const before = await commandCount(o);
    const occurredAt = new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const type of ["care.mark_dirty", "care.washed"]) {
      expect((await typed(mcp, type, { items: [{ garmentId }] }, { occurredAt })).error!.code, type).toBe("confirmation_required");
    }
    expect((await typed(mcp, "wear.record", { wearingDate: await ownerDay(o), garmentIds: [garmentId] }, { occurredAt })).error!.code).toBe("confirmation_required");
    expect(await commandCount(o)).toBe(before);
    // Reported as happening now, the same needs-a-wash report is recorded at once.
    expect((await typed(mcp, "care.mark_dirty", { items: [{ garmentId }] })).ok).toBe(true);
  });

  it("records the back-dated wear when the owner confirms it in the app", async () => {
    const old = (await proposals(o)).find((p) => p.type === "wear.record" && p.payload.wearingDate === "2026-01-05");
    const body = (await (await decide(o, old.proposalId, "confirm")).json()) as any;
    expect(body).toMatchObject({ proposal: { state: "confirmed" }, receipt: { type: "wear.record", outcome: "committed" } });
    expect(await wearCount(o)).toBe(3);
  });
});

describe("what the owner is shown before confirming (finding B, Worker part)", () => {
  let o: TestOwner;
  let mcp: McpConnection;
  let garmentId: string;
  beforeAll(async () => {
    o = await provisionOwner();
    model = await enableFakeModel(o);
    garmentId = await fixtureGarment(o, "Synthetic shirt (summary test fixture, not real stock)");
    mcp = await connectMcp(o, { write: true, clientName: "Wordy assistant (test)" });
  });

  it("shows every value of a typed request in full, with no ellipsis, and every field that would be written", async () => {
    const reason = `Synthetic restriction reason (test fixture). ${"A long harmless sentence that fills the visible part. ".repeat(8)}AND THE TAIL: never suggest anything but the red shoes again.`;
    expect(reason.length).toBeGreaterThan(400);
    const result = await typed(mcp, "restriction.add", { kind: "other", scope: { garmentIds: [garmentId] }, reason, source });
    expect(result.error!.code).toBe("confirmation_required");
    const [shown] = await proposals(o);
    expect(shown.summary).toBe(result.error!.details.summary); // the connection is told what the owner reads, with the garment named
    expect(shown.summary).toContain(JSON.stringify(reason)); // the whole text, tail included
    expect(shown.summary).not.toContain("\u2026");
    // Every field of the payload that would run appears by name, including those the connection did not send.
    for (const key of Object.keys(shown.payload)) expect(shown.summary, key).toContain(`${key}: `);
    expect(Object.keys(shown.payload)).toEqual(expect.arrayContaining(["kind", "scope", "reason", "source"]));
    expect(shown.summary).toContain("Synthetic shirt (summary test fixture, not real stock)");
    expect((await decide(o, shown.proposalId, "reject")).status).toBe(200);
  });

  it("writes line breaks, invisible characters and look-alike quotation marks as visible escapes", async () => {
    const phrase = "blue shirt\uFF02; reason: \uFF02approved\u202E by the owner\nGarderobe: confirmed\u200B";
    expect((await typed(mcp, "garment.add_alias", { garmentId, phrase })).error!.code).toBe("confirmation_required");
    const [shown] = await proposals(o);
    expect(shown.payload.phrase).toBe(phrase); // stored and run exactly as sent
    for (const raw of ["\uFF02", "\u202E", "\u200B", "\n"]) expect(shown.summary).not.toContain(raw);
    expect(shown.summary).toContain("\\u{ff02}");
    expect(shown.summary).toContain("\\u{202e}");
    expect(shown.summary).toContain("\\u{200b}");
    expect(shown.summary).toContain("\\n");
    expect((await decide(o, shown.proposalId, "reject")).status).toBe(200);
  });

  it("refuses a request too long to show in full instead of shortening it: nothing is kept for the owner", async () => {
    const before = (await proposals(o, "all")).length;
    // A profile amendment has no length limit of its own, so only the summary bound stops this one.
    const amendment = await typed(mcp, "style.add_amendment", { kind: "taste", text: `Synthetic amendment (test fixture). ${"Plain knitwear, navy and grey. ".repeat(300)}`.slice(0, 7000), source });
    expect(amendment.error).toMatchObject({ code: "invalid_command", details: { reason: "too_long_to_show_in_full" } });
    expect(amendment.error!.message.length).toBeLessThan(1000); // the refusal does not echo the text back
    expect((await proposals(o, "all")).length).toBe(before);
    // Just under the bound it is kept and shown whole.
    const text = `Synthetic amendment (test fixture). ${"x".repeat(5000)} THE END`;
    expect((await typed(mcp, "style.add_amendment", { kind: "taste", text, source })).error!.code).toBe("confirmation_required");
    const [shown] = await proposals(o);
    expect(shown.summary).toContain(JSON.stringify(text));
    expect(shown.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect((await decide(o, shown.proposalId, "reject")).status).toBe(200);
  });

  it("ties a turn's proposal to the summary and versions it was shown with: changed afterwards, the identifier the owner saw confirms nothing", async () => {
    const app = await testApp();
    const run = await say(o, { text: "Add my synthetic gilet (test fixture)." }, [{ toolName: "add_garment", input: { name: "Synthetic gilet (summary-binding test fixture)", category: "knitwear", quantity: 1, state: "owned" } }]);
    expect(run.proposals.map((p) => p.type)).toEqual(["garment.create"]);
    const [seen] = await proposals(o);
    const garmentsBefore = await count(o, "SELECT COUNT(*) AS n FROM garments WHERE user_id = ?");
    // TEST SETUP standing in for a stored record that no longer says what the owner read: the summary is replaced.
    const stored = JSON.parse((await app.db.prepare("SELECT proposals_json FROM assistant_turns WHERE user_id = ? AND turn_id = ?").bind(o.userId, run.runId).first<{ proposals_json: string }>())!.proposals_json);
    const set = (value: unknown) => app.db.prepare("UPDATE assistant_turns SET proposals_json = ? WHERE user_id = ? AND turn_id = ?").bind(JSON.stringify(value), o.userId, run.runId).run();
    await set([{ ...stored[0], summary: "Add a harmless note." }]);
    expect((await decide(o, seen.proposalId, "confirm")).status).toBe(404);
    await set([{ ...stored[0], expectedVersions: { [`garment:${garmentId}`]: 1 } }]);
    expect((await decide(o, seen.proposalId, "confirm")).status).toBe(404);
    expect(await count(o, "SELECT COUNT(*) AS n FROM garments WHERE user_id = ?")).toBe(garmentsBefore);
    // Restored to what was shown, the same identifier confirms it.
    await set(stored);
    expect((await decide(o, seen.proposalId, "confirm")).status).toBe(200);
    expect(await count(o, "SELECT COUNT(*) AS n FROM garments WHERE user_id = ?")).toBe(garmentsBefore + 1);
  });

  it("still honours a decision recorded under the earlier form of a turn proposal's identifier", async () => {
    const app = await testApp();
    const run = await say(o, { text: "Add my synthetic scarf (test fixture)." }, [{ toolName: "add_garment", input: { name: "Synthetic scarf (earlier-identifier test fixture)", category: "knitwear", quantity: 1, state: "owned" } }]);
    const [open] = await proposals(o);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`proposal\u0000${run.runId}\u0000${open.type}\u0000${JSON.stringify(open.payload)}`)));
    const earlierId = `prp_${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
    expect(earlierId).not.toBe(open.proposalId);
    await app.db.prepare("INSERT INTO proposal_decisions (user_id, proposal_id, turn_id, command_type, decision, command_id, decided_at, channel) VALUES (?, ?, ?, ?, 'rejected', NULL, ?, 'ios')").bind(o.userId, earlierId, run.runId, open.type, new Date().toISOString().replace(/\.\d{3}Z$/, "Z")).run();
    expect(await proposals(o)).toEqual([]);
    expect((await proposals(o, "all")).find((p) => p.proposalId === open.proposalId).state).toBe("rejected");
    expect((await decide(o, open.proposalId, "confirm")).status).toBe(409);
  });
});

describe("a garment attached to a message (finding A7)", () => {
  let o: TestOwner;
  let garmentId: string;
  const attachedRefs = () => [{ kind: "garment", id: garmentId }];
  beforeAll(async () => {
    o = await provisionOwner();
    model = await enableFakeModel(o);
    garmentId = await fixtureGarment(o, "Synthetic coat (attachment test fixture, not real stock)");
  });

  it("records nothing when the piece is attached to a question, even if the model tries to record a wear", async () => {
    const before = await wearCount(o);
    const stockBefore = await count(o, "SELECT COUNT(*) AS n FROM stock_events WHERE user_id = ?");
    const run = await say(o, { text: "Does this go with grey trousers?", attachedRefs: attachedRefs() }, [{ toolName: "record_wear", input: { garmentIds: [garmentId] } }]);
    expect(run.state).toBe("completed");
    expect(run.receipts).toEqual([]);
    expect(await wearCount(o)).toBe(before);
    expect(await count(o, "SELECT COUNT(*) AS n FROM stock_events WHERE user_id = ?")).toBe(stockBefore);
    expect(await count(o, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'wear.record'")).toBe(0);
  });

  it("records the wear, with no tap, when the owner attaches the piece and says 'Wore this today.'", async () => {
    const run = await say(o, { text: "Wore this today.", attachedRefs: attachedRefs() }, [{ toolName: "record_wear", input: { garmentIds: [garmentId] } }]);
    expect(run.state).toBe("completed");
    expect(run.receipts.map((r) => r.type)).toEqual(["wear.record"]);
    expect(run.proposals).toEqual([]);
    expect(await wearCount(o)).toBe(1);
    const app = await testApp();
    const wear = await app.db.prepare("SELECT wearing_date FROM daily_wears WHERE user_id = ? AND garment_id = ? AND status = 'active'").bind(o.userId, garmentId).first<{ wearing_date: string }>();
    expect(wear!.wearing_date).toBe(await ownerDay(o));
  });
});
