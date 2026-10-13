import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MCP_ORIGIN,
  connectMcp,
  createWorld,
  enableFakeModel,
  fingerprint,
  inventory,
  ownerDay,
  publishBoard,
  scriptOutbound,
  settleRun,
  settledOwnerSnapshot,
  sql,
  submit,
  syntheticOwner,
  tablesContaining,
  toolResult,
  type InventoryItem,
  type McpConnection,
  type TestOwner,
  type World,
} from "../src/harness.ts";
import { dnsAnswer } from "../src/dns.ts";
import { protocolRefusal } from "../src/connected-helpers.ts";

/*
 * THREAT CLASS 1: cross-owner isolation and forged ownership fields.
 *
 * The attacker is the LABELLED SYNTHETIC second owner: a legitimately signed-in owner of this deployment
 * (own account, own session, own connected assistant) who knows the victim's identifiers. The victim is
 * the real owner fixture (the supplied profile and the real 127-garment inventory). Everything goes
 * through the real Worker; the assertions read the real D1 tables.
 *
 * No test prints the victim's data: assertions compare identifiers, hashes and counts.
 */
let world: World;
let victim: TestOwner;
let attacker: TestOwner;
let attackerMcp: McpConnection;
let victimItems: InventoryItem[];
let victimShoe: InventoryItem;
let victimShirt: InventoryItem;
let victimCommandId: string;
let victimKey: string;

/**
 * The victim's state, which an attack must leave exactly as it was: every row (all columns) of every table
 * with a `user_id` column and every stored object under the victim's storage prefixes, read once the
 * victim's own background work has gone quiet (`settledOwnerSnapshot`), plus the ledger fingerprint. A
 * difference names the table or prefix, never its content.
 */
async function victimState() {
  return { rows: await settledOwnerSnapshot(victim, { label: "the victim's stored records" }), ledger: await fingerprint(victim) };
}

const hex = (bytes: number): string => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Asserts that two row sets read with the same ORDER BY are identical. A failure names only the row's
 * position and the columns that differ, never their values (the rows hold the victim's credentials).
 */
function expectSameRows(label: string, after: Record<string, unknown>[], before: Record<string, unknown>[]): void {
  expect(after.length, `${label}: number of rows`).toBe(before.length);
  before.forEach((row, i) => {
    const now: Record<string, unknown> = after[i] ?? {};
    const changed = [...new Set([...Object.keys(row), ...Object.keys(now)])].filter((column) => JSON.stringify(row[column]) !== JSON.stringify(now[column]));
    expect(changed, `${label}: changed columns of row ${i + 1}`).toEqual([]);
  });
}

/**
 * Up to six distinctive passages of the victim's active style document, read from D1: the middle 40
 * characters of long lines, spread across the document. A passage is skipped when it also occurs in the
 * attacker's own style records (so finding one in an attacker's response can only mean the victim's text
 * leaked) or when it holds a character that JSON or HTML would escape (so it reads the same in any body).
 */
async function distinctivePassages(): Promise<string[]> {
  const documents = await sql<{ content: string }>("SELECT content FROM style_documents WHERE user_id = ? AND status = 'active' ORDER BY document_id, version", victim.userId);
  const own = (
    await sql<{ text: string }>(
      "SELECT content AS text FROM style_documents WHERE user_id = ? UNION ALL SELECT interpretation || ' ' || passages_json || ' ' || params_json AS text FROM style_rules WHERE user_id = ?",
      attacker.userId,
      attacker.userId,
    )
  )
    .map((row) => row.text)
    .join("\n");
  const candidates: string[] = [];
  for (const document of documents) {
    for (const line of document.content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length < 48) continue;
      const start = Math.floor((trimmed.length - 40) / 2);
      const passage = trimmed.slice(start, start + 40);
      if (/["\\<>&\u0000-\u001f\u2028\u2029]/.test(passage)) continue;
      if (own.includes(passage) || candidates.includes(passage)) continue;
      candidates.push(passage);
    }
  }
  if (candidates.length <= 6) return candidates;
  const step = candidates.length / 6;
  return Array.from({ length: 6 }, (_, i) => candidates[Math.floor(i * step)]!);
}

interface TranscriptLine {
  messageId: string;
  role: string;
  text: string;
}

/** Every message of an owner's conversation through the real route (newest page first, following `nextBefore`). */
async function transcriptOf(owner: TestOwner): Promise<TranscriptLine[]> {
  const out: TranscriptLine[] = [];
  let before: string | null = null;
  for (let pages = 0; pages < 100; pages++) {
    const query: string = before ? `&before=${encodeURIComponent(before)}` : "";
    const page = (await owner.api.json("GET", `/v1/conversation/messages?limit=100${query}`)) as { messages: TranscriptLine[]; nextBefore: string | null };
    out.push(...page.messages);
    before = page.nextBefore;
    if (!before) break;
  }
  return out;
}

const mcpCall = async (mcp: McpConnection, name: string, args: Record<string, unknown>) => {
  try {
    return toolResult(await mcp.client.callTool({ name, arguments: args }));
  } catch (error) {
    // Only a refusal by the MCP server (a JSON-RPC error answer, an authorization failure) is a refusal; anything else is rethrown.
    const refusal = protocolRefusal(error);
    if (refusal) return { ok: false, data: undefined as any, error: refusal };
    throw error;
  }
};

beforeAll(async () => {
  world = await createWorld();
  victim = world.real;
  attacker = world.synthetic;
  attackerMcp = await connectMcp(attacker, { write: true, clientName: "Attacker assistant (synthetic owner)" });
  victimItems = (await inventory(victim)).items;
  victimShirt = victimItems.find((i) => i.garment.acquisition === "owned" && i.garment.category === "shirt" && i.balances.some((b) => b.bucket === "clean" && b.quantity > 0))!;
  victimShoe = victimItems.find((i) => i.garment.acquisition === "owned" && i.garment.category === "footwear")!;
  // One command of the victim's own, so its receipt identifier and idempotency key exist to be attacked.
  victimKey = `victim-own-${crypto.randomUUID()}`;
  const own = await submit(victim, "care.mark_dirty", { items: [{ garmentId: victimShirt.garment.garmentId, quantity: 1 }] }, { idempotencyKey: victimKey });
  expect(own.status).toBe(200);
  victimCommandId = own.receipt.commandId;
});

describe("the fixture is the real application with two separate owners", () => {
  it("has the real inventory for the victim and only labelled synthetic garments for the attacker", async () => {
    const real = await inventory(victim);
    const synthetic = await inventory(attacker);
    expect(real.total).toBeGreaterThan(100);
    expect(victim.importResult).not.toBeNull();
    expect(synthetic.total).toBeGreaterThan(10);
    const realIds = new Set(real.items.map((i) => i.garment.garmentId));
    for (const item of synthetic.items) expect(realIds.has(item.garment.garmentId)).toBe(false);
    expect(victimShirt).toBeDefined();
    expect(victimShoe).toBeDefined();
  });
});

describe("reading another owner's records by identifier", () => {
  it("answers 404 for the victim's garment on every item route, and never echoes its name", async () => {
    const id = victimShirt.garment.garmentId;
    for (const path of [`/v1/items/${id}`, `/v1/items/${id}/image`]) {
      const response = await attacker.api.get(path);
      const text = await response.text();
      // (The refusal may repeat the identifier the caller sent; it must not reveal anything it did not send.)
      expect(text.includes(victimShirt.garment.name), path).toBe(false);
      expect(response.status, path).toBe(404);
    }
    // Looking the victim's garment up by its exact name finds nothing in the attacker's wardrobe.
    const resolved = await attacker.api.json("GET", `/v1/wardrobe/resolve?phrase=${encodeURIComponent(victimShirt.garment.name)}`);
    expect(resolved.matches).toEqual([]);
    const searched = await attacker.api.json("GET", `/v1/wardrobe?search=${encodeURIComponent(victimShirt.garment.name)}`);
    expect(searched.items.map((i: InventoryItem) => i.garment.garmentId)).not.toContain(id);
    expect(searched.items.every((i: InventoryItem) => i.garment.name !== victimShirt.garment.name)).toBe(true);
  });

  it("answers 404 for the victim's receipt, and the receipt list filtered by the victim's idempotency key is empty", async () => {
    const direct = await attacker.api.get(`/v1/commands/${victimCommandId}`);
    expect(direct.status).toBe(404);
    const byKey = await attacker.api.get(`/v1/commands?idempotencyKey=${encodeURIComponent(victimKey)}`);
    expect(byKey.status).toBe(200);
    expect(((await byKey.json()) as { receipts: unknown[] }).receipts).toEqual([]);
    const byEntity = await attacker.api.get(`/v1/commands?entity=${encodeURIComponent(`garment:${victimShirt.garment.garmentId}`)}`);
    if (byEntity.status === 200) expect(((await byEntity.json()) as { receipts: unknown[] }).receipts).toEqual([]);
    else expect([400, 404]).toContain(byEntity.status);
  });

  it("shows the attacker only its own wardrobe whatever owner the query string names", async () => {
    const own = new Set((await inventory(attacker)).items.map((i) => i.garment.garmentId));
    for (const query of [`userId=${victim.userId}`, `user_id=${victim.userId}`, `owner=${victim.userId}`, `search=${encodeURIComponent("' OR 1=1 --")}`, `category=${encodeURIComponent("shirt' OR user_id != '")}`, `search=%25`, `search=_`]) {
      const response = await attacker.api.get(`/v1/wardrobe?${query}`);
      // An unknown or invalid parameter may be refused; it must never widen the read.
      expect([200, 400], query).toContain(response.status);
      if (response.status !== 200) continue;
      const page = (await response.json()) as { items: InventoryItem[] };
      for (const item of page.items) expect(own.has(item.garment.garmentId), query).toBe(true);
    }
  });

  it("keeps the two style profiles apart: the attacker never receives the victim's document", async () => {
    const victimStyle = await victim.api.json("GET", "/v1/style");
    const hash = victimStyle.document.contentSha256 as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // The hash alone proves little (a response could carry the text without it): look for the text itself.
    const passages = await distinctivePassages();
    expect(passages.length, "distinctive passages of the victim's style document to look for").toBeGreaterThanOrEqual(3);
    // Failures name the response and the passage's number only, never the victim's text.
    const expectAbsent = (label: string, text: string) => {
      expect(text.includes(hash), `${label}: the victim's document hash`).toBe(false);
      passages.forEach((passage, i) => expect(text.includes(passage), `${label}: victim passage #${i + 1}`).toBe(false));
    };
    const response = await attacker.api.get("/v1/style");
    expectAbsent("GET /v1/style", await response.text());
    for (const query of [`documentId=owner-profile&userId=${victim.userId}`, `userId=${victim.userId}`]) {
      const forged = await attacker.api.get(`/v1/style?${query}`);
      expectAbsent(`GET /v1/style?${query}`, await forged.text());
    }
    // The same over the attacker's connected assistant: the profile resource and the style view are its own.
    const view = await mcpCall(attackerMcp, "garderobe_inventory", { view: "style" });
    expectAbsent("MCP style view", JSON.stringify(view));
    const resource = await attackerMcp.client.readResource({ uri: "garderobe://style/profile" }).catch((error: unknown) => {
      // Only the server's own refusal stands for an answer to inspect; anything else fails the test.
      const refusal = protocolRefusal(error);
      if (!refusal) throw error;
      return { error: refusal };
    });
    expectAbsent("MCP style profile resource", JSON.stringify(resource));
  });

  it("does not serve the victim's board, day record, trips, laundry or runs to the attacker", async () => {
    const today = await ownerDay(victim, 0);
    const board = await publishBoard(victim, { date: today });
    const boardId: string = board.board?.boardId ?? board.boardId;
    expect(boardId).toBeTruthy();
    const before = await victimState();
    const optionIds: string[] = (board.board?.options ?? board.options ?? []).map((o: any) => o.optionId);
    for (const path of ["/v1/today", `/v1/days/${today}`, `/board/${today}`, "/v1/laundry", "/v1/trips", "/v1/availability"]) {
      const response = await attacker.api.with(path.startsWith("/board") ? { client: "web" } : {}).get(path);
      const text = await response.text();
      expect(text, path).not.toContain(boardId);
      for (const optionId of optionIds) expect(text, path).not.toContain(optionId);
      expect(text, path).not.toContain(victimShirt.garment.garmentId);
    }
    // Acting on the victim's board by its identifiers.
    const swap = await attacker.api.post(`/v1/boards/${boardId}/swap`, { clientRequestId: `adv-${crypto.randomUUID()}`, optionId: optionIds[0] ?? "opt_x", slot: "shirt" });
    expect([400, 403, 404, 409]).toContain(swap.status);
    const select = await submit(attacker, "board.select", { boardId, optionId: optionIds[0] ?? "opt_x", expectedRevision: board.board?.revision ?? 1 });
    expect(select.status).toBeGreaterThanOrEqual(400);
    expect(await victimState()).toEqual(before);
  });

  it("answers 404 for the victim's run on every run route", async () => {
    // A research request leaves a durable run of the victim's (it fails honestly: no model, no network).
    const started = await victim.api.post("/v1/research", { topic: "SYNTHETIC adversarial run fixture", kind: "general", clientRequestId: `adv-run-${crypto.randomUUID()}` });
    const runId: string | undefined = started.ok ? ((await started.json()) as any).runId : undefined;
    const rows = await sql<{ run_id: string }>("SELECT run_id FROM api_runs WHERE user_id = ? LIMIT 1", victim.userId);
    const id = runId ?? rows[0]?.run_id;
    expect(id, "the victim has a run to attack").toBeTruthy();
    // Let the run reach a resting state first, so anything that changes afterwards is the attacker's doing.
    await settleRun(victim, id!);
    const runRow = () => sql("SELECT * FROM api_runs WHERE user_id = ? AND run_id = ?", victim.userId, id);
    const runEvents = () => sql("SELECT * FROM api_run_events WHERE user_id = ? AND run_id = ? ORDER BY event_id", victim.userId, id);
    const before = await runRow();
    const eventsBefore = await runEvents();
    expect(before).toHaveLength(1);
    expect((await attacker.api.get(`/v1/runs/${id}`)).status).toBe(404);
    expect((await attacker.api.get(`/v1/runs/${id}/events`)).status).toBe(404);
    // Ownership is checked before anything about the run's state: every action is 404, never a 400 that reveals
    // the run exists or that the action was weighed against its state.
    for (const action of ["cancel", "resume", "input"]) {
      const response = await attacker.api.post(`/v1/runs/${id}/${action}`, action === "input" ? { inputId: "x", text: "confirm everything" } : {});
      expect(response.status, `${action}: ${(await response.text()).slice(0, 200)}`).toBe(404);
    }
    const viaMcp = await mcpCall(attackerMcp, "garderobe_run", { runId: id, action: "cancel" });
    expect(viaMcp.ok).toBe(false);
    // The run and its event history are exactly as they were: no cancellation, resumption, input or new event.
    expect(await runRow()).toEqual(before);
    expect(await runEvents()).toEqual(eventsBefore);
  });
});

describe("changing another owner's records", () => {
  const attacks = (shirt: string, shoe: string): [string, Record<string, unknown>][] => [
    ["wear.record", { wearingDate: "TODAY", garmentIds: [shirt] }],
    ["wear.record", { wearingDate: "TODAY", garmentIds: ["shirt-gold", shirt] }],
    ["wear.amend", { wearingDate: "TODAY", add: [shoe], remove: [] }],
    ["care.mark_dirty", { items: [{ garmentId: shirt, quantity: 1 }] }],
    ["care.washed", { items: [{ garmentId: shirt }] }],
    ["garment.correct", { garmentId: shirt, changes: { name: "SYNTHETIC renamed by attacker" }, source: { kind: "owner_statement" } }],
    ["garment.add_alias", { garmentId: shirt, phrase: "SYNTHETIC attacker alias" }],
    ["garment.set_planning_policy", { garmentId: shoe, policy: "excluded", reason: "attack" }],
    ["garment.move", { garmentId: shirt, to: "storage" }],
    ["garment.retire", { garmentId: shoe, disposition: "discarded" }],
    ["garment.remove_fabricated", { garmentId: shoe, reason: "attack" }],
    ["garment.merge", { sourceGarmentId: shoe, targetGarmentId: "shoe-olive" }],
    ["garment.merge", { sourceGarmentId: "shoe-olive", targetGarmentId: shoe }],
    ["garment.receive", { garmentId: shirt, quantity: 5 }],
    ["stock.reconcile", { garmentId: shirt, counts: { clean: 0, total: 0 } }],
    ["laundry.collect", { include: [{ garmentId: shirt, quantity: 1 }] }],
    ["laundry.report_exception", { kind: "lost", garmentId: shirt, quantity: 1 }],
    ["measurement.record", { subject: "garment", garmentId: shirt, key: "chest", value: 1, unit: "in", source: { kind: "owner_statement" } }],
    ["garment.bulk_correct", { selector: { garmentIds: [shirt, shoe] }, changes: { colour: "SYNTHETIC attacker colour" }, source: { kind: "owner_statement" } }],
    ["command.undo", { commandId: "VICTIM_COMMAND" }],
  ];

  it("refuses every command of the attacker's app that names a garment or receipt of the victim, and writes nothing for either owner", async () => {
    const before = await victimState();
    const attackerBefore = await fingerprint(attacker);
    const today = await ownerDay(attacker, 0);
    const outcomes: string[] = [];
    for (const [type, raw] of attacks(victimShirt.garment.garmentId, victimShoe.garment.garmentId)) {
      const payload = JSON.parse(JSON.stringify(raw).replace(/TODAY/g, today).replace(/VICTIM_COMMAND/g, victimCommandId));
      const result = await submit(attacker, type, payload);
      outcomes.push(`${type}:${result.status}:${result.error?.code ?? "committed"}`);
      expect(result.status, `${type} ${JSON.stringify(result.error)}`).toBeGreaterThanOrEqual(400);
      expect(result.status, type).toBeLessThan(500);
      // Each payload is well formed: the refusal is about the garment not being the caller's, not about shape.
      expect(result.error?.code, `${type} ${JSON.stringify(result.error).slice(0, 300)}`).not.toBe("invalid_command");
      // The refusal must not describe the victim's garment.
      expect(JSON.stringify(result.error), type).not.toContain(victimShirt.garment.name);
      expect(JSON.stringify(result.error), type).not.toContain(victimShoe.garment.name);
    }
    expect(await victimState(), outcomes.join(" ")).toEqual(before);
    expect(await fingerprint(attacker), outcomes.join(" ")).toEqual(attackerBefore);
  });

  it("refuses the same attacks from the attacker's connected assistant over MCP", async () => {
    const before = await victimState();
    const attackerBefore = await fingerprint(attacker);
    const today = await ownerDay(attacker, 0);
    for (const [type, raw] of attacks(victimShirt.garment.garmentId, victimShoe.garment.garmentId)) {
      const payload = JSON.parse(JSON.stringify(raw).replace(/TODAY/g, today).replace(/VICTIM_COMMAND/g, victimCommandId));
      const result = await mcpCall(attackerMcp, "garderobe_command", { type, payload, idempotencyKey: `adv-mcp-${crypto.randomUUID()}` });
      // Either refused, or kept as a request for the ATTACKER's own confirmation: never committed.
      expect(result.ok, type).toBe(false);
      expect(JSON.stringify(result.error), type).not.toContain(victimShirt.garment.name);
    }
    expect(await victimState()).toEqual(before);
    // Requests that wait for the attacker's own confirmation must fail when the attacker confirms them.
    const pending = (await attacker.api.json("GET", "/v1/proposals")).proposals as { proposalId: string }[];
    for (const proposal of pending) {
      const decided = await attacker.api.post(`/v1/proposals/${proposal.proposalId}/decision`, { decision: "confirm" });
      expect(decided.status, proposal.proposalId).toBeGreaterThanOrEqual(400);
    }
    expect(await victimState()).toEqual(before);
    const attackerAfter = await fingerprint(attacker);
    expect(attackerAfter.stock_balances).toEqual(attackerBefore.stock_balances);
    expect(attackerAfter.garments).toEqual(attackerBefore.garments);
  });

  it("reads nothing of the victim through the attacker's MCP tools, whatever identifiers and extra owner fields are sent", async () => {
    const id = victimShirt.garment.garmentId;
    const item = await mcpCall(attackerMcp, "garderobe_inventory", { view: "item", garmentId: id });
    expect(item.ok).toBe(false);
    for (const view of ["history", "receipts"]) {
      const result = await mcpCall(attackerMcp, "garderobe_inventory", { view, garmentId: id });
      expect(JSON.stringify(result), view).not.toContain(victimCommandId);
      expect(JSON.stringify(result), view).not.toContain(victimShirt.garment.name);
    }
    const selection = await mcpCall(attackerMcp, "garderobe_inventory", { view: "selection", selector: { garmentIds: [id, victimShoe.garment.garmentId] } });
    expect(JSON.stringify(selection)).not.toContain(victimShirt.garment.name);
    const resolved = await mcpCall(attackerMcp, "garderobe_inventory", { view: "resolve", phrase: victimShirt.garment.name });
    expect(JSON.stringify(resolved)).not.toContain(id);
    // Tool inputs are strict: an owner field is rejected, not ignored-and-served.
    for (const extra of [{ userId: victim.userId }, { user_id: victim.userId }, { owner: victim.userId }, { principal: { userId: victim.userId, actor: "owner" } }]) {
      const forged = await mcpCall(attackerMcp, "garderobe_inventory", { view: "items", ...extra });
      expect(forged.ok, JSON.stringify(extra)).toBe(false);
      const today = await mcpCall(attackerMcp, "garderobe_today", { ...extra });
      expect(today.ok, JSON.stringify(extra)).toBe(false);
    }
    const snapshot = await mcpCall(attackerMcp, "garderobe_inventory", { view: "snapshot" });
    expect(snapshot.ok).toBe(true);
    expect(JSON.stringify(snapshot.data)).not.toContain(id);
  });
});

describe("forged ownership and authority fields in a command", () => {
  it("ignores or refuses an owner named in the envelope or the payload: the command is the caller's or nothing", async () => {
    const before = await victimState();
    const today = await ownerDay(attacker, 0);
    const base = { type: "wear.record", payload: { wearingDate: today, garmentIds: ["shirt-gold"] }, expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios" } };
    const forgeries: Record<string, unknown>[] = [
      { ...base, userId: victim.userId },
      { ...base, user_id: victim.userId, ownerId: victim.userId },
      { ...base, principal: { userId: victim.userId, actor: "owner", channel: "ios", scopes: ["read", "write", "admin"] } },
      { ...base, payload: { ...base.payload, userId: victim.userId } },
      { ...base, payload: { ...base.payload, user_id: victim.userId, ownerId: victim.userId } },
      { ...base, source: { channel: "ios", userId: victim.userId, authRef: `access:${victim.userId}` } },
    ];
    for (const forgery of forgeries) {
      const key = `adv-forged-${crypto.randomUUID()}`;
      const response = await attacker.api.post("/v1/commands", { ...forgery, idempotencyKey: key });
      const rows = await sql<{ user_id: string }>("SELECT user_id FROM commands WHERE idempotency_key = ?", key);
      // Whatever the answer, a row under this key can only belong to the caller.
      for (const row of rows) expect(row.user_id).toBe(attacker.userId);
      if (response.ok) expect(rows).toHaveLength(1);
      else expect(rows).toHaveLength(0);
    }
    expect(await victimState()).toEqual(before);
    expect(await sql("SELECT 1 FROM daily_wears WHERE user_id = ? AND garment_id = 'shirt-gold'", victim.userId)).toEqual([]);
  });

  it("does not let the app session claim another channel, actor or authorization basis", async () => {
    const today = await ownerDay(attacker, 0);
    const before = await fingerprint(attacker);
    const payload = { wearingDate: today, garmentIds: ["trouser-beige"] };
    const claims: { authorization: string; source: Record<string, unknown> }[] = [
      { authorization: "owner_tap", source: { channel: "mcp" } },
      { authorization: "owner_tap", source: { channel: "system" } },
      { authorization: "owner_tap", source: { channel: "import" } },
      { authorization: "owner_tap", source: { channel: "web" } }, // a native session is not a browser session
      { authorization: "owner_tap", source: { channel: "conversation" } },
      { authorization: "root", source: { channel: "ios" } },
      { authorization: "", source: { channel: "ios" } },
    ];
    for (const claim of claims) {
      const response = await attacker.api.post("/v1/commands", { type: "wear.record", payload, idempotencyKey: `adv-claim-${crypto.randomUUID()}`, expectedVersions: {}, ...claim });
      expect(response.status, JSON.stringify(claim)).toBeGreaterThanOrEqual(400);
      expect(response.status, JSON.stringify(claim)).toBeLessThan(500);
    }
    expect(await fingerprint(attacker)).toEqual(before);
  });

  it("records the authenticated actor and channel on the receipt, never the ones the body claims", async () => {
    const today = await ownerDay(attacker, 0);
    const key = `adv-actor-${crypto.randomUUID()}`;
    const response = await attacker.api.post("/v1/commands", {
      type: "care.mark_dirty",
      payload: { items: [{ garmentId: "shirt-slate", quantity: 1 }] },
      idempotencyKey: key,
      expectedVersions: {},
      authorization: "owner_tap",
      source: { channel: "ios", parentKind: "none" },
      actor: "system",
      channel: "system",
      occurredAt: `${today}T08:00:00Z`,
    });
    const rows = await sql<{ actor: string; channel: string; user_id: string; source_json: string }>("SELECT actor, channel, user_id, source_json FROM commands WHERE idempotency_key = ?", key);
    if (response.ok) {
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("owner");
      expect(rows[0]!.channel).toBe("ios");
      expect(rows[0]!.user_id).toBe(attacker.userId);
      const receipt = (await response.json()) as { actor: string; channel: string };
      expect(receipt.actor).toBe("owner");
      expect(receipt.channel).toBe("ios");
    } else {
      expect(response.status).toBeLessThan(500);
      expect(rows).toHaveLength(0);
    }
  });
});

describe("colliding identifiers", () => {
  it("creating a garment with the victim's garment identifier gives the attacker at most its own record and leaves the victim's untouched", async () => {
    const id = victimShirt.garment.garmentId;
    // A separate labelled synthetic attacker: if the collision is allowed it owns a garment under the victim's
    // identifier, which must not leak into the shared attacker's snapshots and recall that later tests read.
    const collider = await syntheticOwner("Synthetic collision attacker (identifier collision fixture)");
    const before = await victimState();
    const victimRow = await sql("SELECT * FROM garments WHERE user_id = ? AND garment_id = ?", victim.userId, id);
    const result = await submit(collider, "garment.create", {
      garmentId: id,
      name: "SYNTHETIC collision garment (attacker)",
      category: victimShirt.garment.category,
      roles: victimShirt.garment.roles,
      careChannel: "service",
      acquisition: "owned",
      quantity: 2,
      isSynthetic: true,
      source: { kind: "owner_statement", note: "synthetic test fixture - not the owner's wardrobe" },
    });
    expect(result.status).toBeLessThan(500);
    expect(await victimState()).toEqual(before);
    expect(await sql("SELECT * FROM garments WHERE user_id = ? AND garment_id = ?", victim.userId, id)).toEqual(victimRow);
    if (result.status === 200) {
      // The attacker now owns a different garment with the same identifier; acting on it must stay on its side.
      const today = await ownerDay(collider, 0);
      const wear = await submit(collider, "wear.record", { wearingDate: today, garmentIds: [id] });
      expect(wear.status).toBe(200);
      const retire = await submit(collider, "garment.retire", { garmentId: id, disposition: "discarded" });
      expect(retire.status).toBeLessThan(500);
      expect(await victimState()).toEqual(before);
      expect(await sql("SELECT 1 FROM daily_wears WHERE user_id = ? AND garment_id = ?", victim.userId, id)).toEqual([]);
    }
    // The victim still reads its own garment under that identifier (read last, so no request of the victim's
    // falls between the snapshots compared above).
    const detail = await victim.api.json("GET", `/v1/items/${id}`);
    expect(detail.detail.garment.name).toBe(victimShirt.garment.name);
  });

  it("keeps two owners whose garment identifiers are all identical completely separate", async () => {
    // Every synthetic owner has the same garment identifiers by construction.
    const twin = await syntheticOwner("Synthetic third owner (identifier collision fixture)");
    const twinState = async () => ({ rows: await settledOwnerSnapshot(twin, { label: "the twin's stored records" }), ledger: await fingerprint(twin) });
    const twinBefore = await twinState();
    const today = await ownerDay(attacker, 0);
    const key = `adv-twin-${crypto.randomUUID()}`;
    const wear = await submit(attacker, "wear.record", { wearingDate: today, garmentIds: ["shirt-moss", "trouser-olive"] }, { idempotencyKey: key });
    expect(wear.status).toBe(200);
    // Both mutations must really happen for the first owner, or the twin's unchanged state proves nothing.
    const dirty = await submit(attacker, "care.mark_dirty", { items: [{ garmentId: "sock-grey", quantity: 1 }] });
    expect(dirty.status, JSON.stringify(dirty.error)).toBe(200);
    const corrected = await submit(attacker, "garment.correct", { garmentId: "shirt-moss", changes: { colour: "SYNTHETIC colour set by the first twin" }, source: { kind: "owner_statement" } });
    expect(corrected.status, JSON.stringify(corrected.error)).toBe(200);
    const attackerColour = await sql<{ colour: string | null }>("SELECT colour FROM garments WHERE user_id = ? AND garment_id = 'shirt-moss'", attacker.userId);
    expect(String(attackerColour[0]?.colour)).toContain("first twin");
    expect(await twinState()).toEqual(twinBefore);
    // The twin cannot read or undo the first owner's command although it names garments the twin also has.
    expect((await twin.api.get(`/v1/commands/${wear.receipt.commandId}`)).status).toBe(404);
    const undo = await submit(twin, "command.undo", { commandId: wear.receipt.commandId });
    expect(undo.status).toBeGreaterThanOrEqual(400);
    // The same idempotency key is the twin's own key: it must not replay the first owner's receipt.
    const replay = await submit(twin, "wear.record", { wearingDate: await ownerDay(twin, 0), garmentIds: ["shirt-moss", "trouser-olive"] }, { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.receipt.commandId).not.toBe(wear.receipt.commandId);
    expect(replay.receipt.replayed).toBe(false);
    const twinWears = await sql<{ garment_id: string }>("SELECT garment_id FROM daily_wears WHERE user_id = ?", twin.userId);
    expect(twinWears.map((w) => w.garment_id).sort()).toEqual(["shirt-moss", "trouser-olive"]);
    const colour = await sql<{ colour: string | null }>("SELECT colour FROM garments WHERE user_id = ? AND garment_id = 'shirt-moss'", twin.userId);
    expect(String(colour[0]?.colour)).not.toContain("first twin");
  });
});

describe("account-level records of another owner", () => {
  it("cannot disconnect, read or reuse the victim's connected assistant", async () => {
    const victimMcp = await connectMcp(victim, { write: false, clientName: "Victim's assistant" });
    const grants = (await victim.api.json("GET", "/v1/assistants")).grants as { grantId: string; status: string }[];
    const grantId = grants.find((g) => g.status === "active")!.grantId;
    expect((await attacker.api.post(`/v1/assistants/${grantId}/disconnect`, {})).status).toBe(404);
    expect(JSON.stringify(await attacker.api.json("GET", "/v1/assistants"))).not.toContain(grantId);
    const still = (await victim.api.json("GET", "/v1/assistants")).grants.find((g: any) => g.grantId === grantId);
    expect(still.status).toBe("active");
    expect(toolResult(await victimMcp.client.callTool({ name: "garderobe_today", arguments: {} })).error?.code).not.toBe("grant_revoked");
    // The attacker's token is bound to the attacker: it reads the attacker's wardrobe, never the victim's.
    const token = attackerMcp.oauth.snapshot().accessToken;
    const raw = await SELF.fetch(`${MCP_ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "X-Garderobe-User": victim.userId, "Cf-Access-Authenticated-User-Email": victim.identity.email! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "garderobe_inventory", arguments: { view: "snapshot" }, _meta: { userId: victim.userId } } }),
    });
    expect(await raw.text()).not.toContain(victimShirt.garment.garmentId);
    await victimMcp.close();
  });

  it("cannot unlink the victim's sign-in, remove its devices or touch its connections by identifier", async () => {
    const me = await victim.api.json("GET", "/v1/me");
    const identityId = me.identities[0].identityId as string;

    // A notification device of the victim's, registered through the real route (synthetic token).
    const deviceId = `adv01-device-${crypto.randomUUID()}`;
    const registered = await victim.api.post("/v1/devices", { deviceId, token: `ad01${hex(30)}`, environment: "development" });
    expect(registered.status, "the victim's device registration").toBe(200);
    await registered.text();

    // A tool-service connection of the victim's, registered through the real route against a LABELLED
    // STAND-IN service (scripted DNS answer and MCP answers; the key is synthetic).
    const host = `tools-${hex(4)}.adv01-isolation.org`;
    const name = "SYNTHETIC victim tool service (isolation fixture)";
    const tools = [{ name: "adv01_lookup", description: "Look a page up.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
    await scriptOutbound(dnsAnswer(host), { match: "host", key: host, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools, content: [{ type: "text", text: "SYNTHETIC lookup result" }] } }) });
    const created = await victim.api.post("/v1/connections", { clientRequestId: `adv01-${crypto.randomUUID()}`, kind: "mcp", name, endpoint: `https://${host}/mcp`, auth: { type: "secret", secret: `adv01-victim-key-${hex(16)}` } });
    expect(created.status, "the victim's connection registration").toBe(200);
    const connection = ((await created.json()) as { connection: { connectionId: string; state: string } }).connection;
    expect(connection.state).toBe("connected");
    const connectionId = connection.connectionId;

    const deviceRows = () => sql("SELECT * FROM notification_devices WHERE user_id = ? ORDER BY device_id", victim.userId);
    const connectionRows = async () => ({
      profiles: await sql("SELECT * FROM connection_profiles WHERE user_id = ? ORDER BY connection_id", victim.userId),
      credentials: await sql("SELECT * FROM connection_credentials WHERE user_id = ? ORDER BY secret_ref", victim.userId),
      registry: await sql("SELECT * FROM connections WHERE user_id = ? ORDER BY connection_id", victim.userId),
    });
    const before = await victimState();
    const devicesBefore = await deviceRows();
    const connectionsBefore = await connectionRows();
    // The fixture exists: the device row, the connection profile, its stored key and the assistant's registry entry.
    expect(devicesBefore.some((row) => row.device_id === deviceId), "the victim's device is stored").toBe(true);
    expect(connectionsBefore.profiles.some((row) => row.connection_id === connectionId), "the victim's connection profile is stored").toBe(true);
    expect(connectionsBefore.registry.some((row) => row.connection_id === connectionId), "the victim's connection is in the assistant's registry").toBe(true);
    const credential = connectionsBefore.credentials.find((row) => row.connection_id === connectionId);
    expect(credential !== undefined && credential.ciphertext !== null, "the victim's connection key is stored").toBe(true);

    // 1. The victim's sign-in.
    expect((await attacker.api.post("/v1/identities/unlink", { identityId })).status).toBe(404);

    // 2. The victim's devices, by their real identifiers: nothing is removed.
    for (const row of devicesBefore) {
      const removed = await attacker.api.post(`/v1/devices/${encodeURIComponent(String(row.device_id))}/remove`, {});
      const text = await removed.text();
      if (removed.status === 200) expect((JSON.parse(text) as { removed: boolean }).removed, "removing one of the victim's devices").toBe(false);
      else expect(removed.status, "removing one of the victim's devices").toBe(404);
    }
    // A device of the attacker's registered under the victim's device identifier is the attacker's own record.
    const sameId = await attacker.api.post("/v1/devices", { deviceId, token: `ad01${hex(30)}`, environment: "development" });
    expect(sameId.status, "the attacker's device under the victim's device identifier").toBeLessThan(500);
    await sameId.text();

    // 3. The victim's connection, by its real identifier, on every route that changes a connection.
    const routes: [string, Record<string, unknown>][] = [
      [`/v1/connections/${connectionId}/disconnect`, {}],
      [`/v1/connections/${connectionId}/reconnect`, { returnTo: "web" }],
      [`/v1/connections/${connectionId}/capabilities`, { enabled: ["tools:search"] }],
    ];
    for (const [path, body] of routes) {
      const response = await attacker.api.post(path, body);
      const text = await response.text();
      expect(response.status, path).toBe(404);
      expect(text.includes(host), `${path}: the victim's endpoint`).toBe(false);
      expect(text.includes(name), `${path}: the victim's connection name`).toBe(false);
    }
    const listed = await attacker.api.get("/v1/connections");
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    const leaks: [string, string][] = [
      ["identifier", connectionId],
      ["endpoint", host],
      ["name", name],
    ];
    for (const [label, value] of leaks) expect(listedText.includes(value), `the attacker's connection list: the victim's ${label}`).toBe(false);
    // The assistant registry's own commands naming the victim's connection, from the attacker's app and assistant.
    const registryCommands: [string, Record<string, unknown>][] = [
      ["connection.set_status", { connectionId, status: "revoked" }],
      ["connection.set_tool_groups", { connectionId, enabledGroups: ["search", "research"] }],
    ];
    for (const [type, payload] of registryCommands) {
      const viaApp = await submit(attacker, type, payload);
      expect(viaApp.status, `${type} from the attacker's app`).toBeGreaterThanOrEqual(400);
      expect(viaApp.status, `${type} from the attacker's app`).toBeLessThan(500);
      const viaAssistant = await mcpCall(attackerMcp, "garderobe_command", { type, payload, idempotencyKey: `adv01-conn-${crypto.randomUUID()}` });
      expect(viaAssistant.ok, `${type} from the attacker's assistant`).toBe(false);
    }

    // Every stored row of the victim is as it was, and the device and connection rows column for column.
    expect(await victimState()).toEqual(before);
    expectSameRows("the victim's device rows", await deviceRows(), devicesBefore);
    const connectionsAfter = await connectionRows();
    expectSameRows("the victim's connection profiles", connectionsAfter.profiles, connectionsBefore.profiles);
    expectSameRows("the victim's connection credentials", connectionsAfter.credentials, connectionsBefore.credentials);
    expectSameRows("the victim's assistant registry entries", connectionsAfter.registry, connectionsBefore.registry);
    expect((await victim.api.get("/v1/me")).status).toBe(200);
  });

  it("never answers an identifier route with a server error or another owner's data for hostile identifiers", async () => {
    const hostile = ["..%2F..%2Fv1%2Fme", "%00", "'%20OR%201=1--", "%25", "a".repeat(4000), `${victimShirt.garment.garmentId}%00`, `${victimShirt.garment.garmentId}%20`, victimShirt.garment.garmentId.toUpperCase(), `${victim.userId}:${victimShirt.garment.garmentId}`, `${victim.userId}%2F${victimShirt.garment.garmentId}`];
    for (const id of hostile) {
      for (const template of ["/v1/items/{id}", "/v1/items/{id}/image", "/v1/commands/{id}", "/v1/runs/{id}", "/v1/trips/{id}", "/v1/exports/{id}", "/v1/uploads/{id}", "/v1/media/assets/{id}", "/v1/media/renditions/{id}", "/v1/studio/compositions/{id}", "/v1/imports/{id}"]) {
        const response = await attacker.api.get(template.replace("{id}", id));
        const text = await response.text();
        expect(response.status, `${template} ${id.slice(0, 40)}`).toBeLessThan(500);
        expect(response.status, `${template} ${id.slice(0, 40)}`).not.toBe(200);
        expect(text).not.toContain(victimShirt.garment.name);
      }
    }
  });
});

describe("conversation and recall", () => {
  it("keeps conversation messages and recall results per owner", async () => {
    // The attacker's turn is answered by the assistant workstream's LABELLED FAKE MODEL (no Gateway); its
    // reply does not matter here, only where the owner's words are stored.
    await enableFakeModel(attacker);
    // One lowercase token, so recall's word matching sees it whole.
    const marker = `advmarker${hex(8)}`;
    const accepted = await attacker.api.post("/v1/conversation/turns", { clientTurnId: `adv01-turn-${crypto.randomUUID()}`, text: `Note for my own records: ${marker}` });
    expect(accepted.status, "the attacker's own turn is accepted").toBe(200);
    const turn = (await accepted.json()) as { runId: string; replayed: boolean };
    expect(turn.replayed).toBe(false);
    const run = await settleRun(attacker, turn.runId);
    expect(["completed", "failed", "cancelled", "needs_input"], "the attacker's turn has finished").toContain(run.state);

    // Positive controls: the marker is stored as the attacker's own words, and the attacker's recall finds it.
    const attackerTranscript = await transcriptOf(attacker);
    expect(attackerTranscript.some((m) => m.role === "user" && m.text.includes(marker)), "the marker is in the attacker's own transcript").toBe(true);
    const ownRecall = (await attacker.api.json("POST", "/v1/recall/search", { text: marker, limit: 50 })) as { hits: unknown[] };
    expect(JSON.stringify(ownRecall.hits).includes(marker), "the attacker's own recall finds the marker").toBe(true);

    // The victim's conversation, recall and stored records hold nothing of it.
    const victimTranscript = await transcriptOf(victim);
    expect(victimTranscript.some((m) => m.text.includes(marker)), "the marker in the victim's transcript").toBe(false);
    const victimRecall = await victim.api.post("/v1/recall/search", { text: marker, limit: 50 });
    const victimRecallText = await victimRecall.text();
    expect(victimRecall.status).toBe(200);
    expect(victimRecallText.includes(marker), "the marker in the victim's recall").toBe(false);
    expect(await tablesContaining(victim, marker), "the victim's tables holding the marker").toEqual([]);

    // And the other way: the attacker searching for the victim's garment finds none of the victim's records.
    const reverse = await attacker.api.post("/v1/recall/search", { text: victimShirt.garment.name, limit: 50 });
    const reverseText = await reverse.text();
    expect(reverse.status).toBe(200);
    expect(reverseText.includes(victimShirt.garment.garmentId), "the victim's garment identifier in the attacker's recall").toBe(false);
    expect(JSON.stringify((JSON.parse(reverseText) as { hits: unknown[] }).hits).includes(victimShirt.garment.name), "the victim's garment name quoted in the attacker's recall").toBe(false);
  });
});
