#!/usr/bin/env node
/**
 * MCP smoke run against a locally running Worker (`npm run dev` in another terminal):
 *
 *   npm run smoke:mcp            run every step, print one line per check, exit 1 on any failure
 *   npm run smoke:mcp -- --json  print the results as JSON instead
 *
 * What it exercises, with the real owner data the local run mode seeds: sign-in and claim, OAuth
 * discovery/registration/consent/token for a read-only and a writing client, tool listing per
 * permission set, the complete inventory, today's board, a recommendation, a typed command with replay
 * and the same receipt read back through the HTTP API, refusal of the write tool on the read-only
 * connection, a sensitive command that waits for the owner and runs once the owner confirms it in the
 * app (never on the connection's own answer), and immediate revocation.
 * No model is reachable locally, so `garderobe_ask` is only checked to return a durable run.
 */
import { api, ensureClaimed, LOCAL } from "./lib/local.mjs";
import { callTool, connectLocalMcp } from "./lib/mcp-client.mjs";

const asJson = process.argv.includes("--json");
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
  if (!asJson) console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

try {
  const { me, claimed } = await ensureClaimed();
  check("owner signed in", Boolean(me.userId), claimed ? "claimed the seeded account" : "already claimed");

  const wardrobe = (await api("GET", "/v1/wardrobe")).json;
  check("HTTP API returns the complete real inventory", wardrobe.complete === true && wardrobe.total > 50, `${wardrobe.total} garments`);

  const noToken = await fetch(`${LOCAL.mcpOrigin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("MCP endpoint refuses a request without a grant", noToken.status === 401 && (noToken.headers.get("WWW-Authenticate") ?? "").includes("resource_metadata"));

  const reader = await connectLocalMcp({ write: false, clientName: "Smoke reader", redirectUri: "https://smoke-reader.garderobe.local/cb" });
  const confirmations = [];
  const writer = await connectLocalMcp({ write: true, clientName: "Smoke writer", redirectUri: "https://smoke-writer.garderobe.local/cb", onElicit: (params) => (confirmations.push(params.message), { action: "accept", content: { confirm: true } }) });
  check("OAuth: both clients authorized through consent", true);

  const readerTools = (await reader.client.listTools()).tools.map((t) => t.name).sort();
  const writerTools = (await writer.client.listTools()).tools.map((t) => t.name).sort();
  check("read-only connection is not offered the write tool", readerTools.length === 6 && !readerTools.includes("garderobe_command"), readerTools.join(", "));
  check("writing connection is offered all seven tools", writerTools.length === 7 && writerTools.includes("garderobe_command"));

  const snapshot = await callTool(reader.client, "garderobe_inventory", { view: "snapshot" });
  check("garderobe_inventory: complete snapshot equals the API's", snapshot.ok && snapshot.data.complete === true && snapshot.data.total === wardrobe.total, `${snapshot.data?.total} garments`);

  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const recommended = await callTool(reader.client, "garderobe_recommend", { date, count: 3, clientRequestId: `smoke-${Date.now()}` });
  check("garderobe_recommend: validated options from the real wardrobe", recommended.ok && recommended.data.options.length > 0, recommended.ok ? recommended.data.options.map((o) => o.name).join(" | ") : recommended.error?.message);

  const board = await api("POST", "/v1/recommendations", { clientRequestId: `smoke-board-${Date.now()}`, date, mode: "board" });
  const today = await callTool(reader.client, "garderobe_today", { date });
  const viaApi = (await api("GET", `/v1/today?date=${date}`)).json;
  check("garderobe_today: the same board revision as the app", board.ok && today.ok && today.data.board?.boardId === viaApi.board?.boardId && today.data.board?.revision === viaApi.board?.revision, `revision ${today.data?.board?.revision}`);

  // Writes go to a clearly labelled synthetic garment, never to real stock: no wear history is invented.
  const created = await api("POST", "/v1/commands", { type: "garment.create", payload: { name: "Smoke-test shirt (synthetic, not real stock)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic smoke-test garment" } }, idempotencyKey: `smoke-create-${Date.now()}`, authorization: "owner_tap", source: { channel: "ios" } });
  const syntheticId = created.json.affected.find((a) => a.kind === "garment").id;
  const wearingDate = new Date().toISOString().slice(0, 10);
  const args = { type: "wear.record", payload: { wearingDate, garmentIds: [syntheticId] }, idempotencyKey: `smoke-wear-${Date.now()}` };
  const wrote = await callTool(writer.client, "garderobe_command", args);
  check("garderobe_command: verified receipt", wrote.ok && ["committed", "merged"].includes(wrote.data.receipt.outcome), wrote.ok ? wrote.data.receipt.summary : wrote.error?.message);
  const replay = await callTool(writer.client, "garderobe_command", args);
  check("garderobe_command: a retry returns the stored receipt", replay.ok && replay.data.receipt.replayed === true && replay.data.receipt.commandId === wrote.data.receipt.commandId);
  const stored = (await api("GET", `/v1/commands/${wrote.data.receipt.commandId}`)).json;
  check("the HTTP API serves the same receipt", stored.commandId === wrote.data.receipt.commandId && stored.summary === wrote.data.receipt.summary && stored.channel === "mcp");

  const refused = await fetch(`${LOCAL.mcpOrigin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${reader.oauth.tokens().access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "garderobe_command", arguments: args } }),
  });
  check("read-only connection: write tool refused with a scope challenge", refused.status === 403 && (refused.headers.get("WWW-Authenticate") ?? "").includes("insufficient_scope"));

  const forged = await callTool(writer.client, "garderobe_command", { type: "wear.record", payload: { wearingDate, garmentIds: ["gmt_not_a_real_garment"] }, idempotencyKey: `smoke-missing-${Date.now()}` });
  check("an invented garment is refused, nothing is created", !forged.ok && forged.error.code === "not_found");

  // A correction is not a report: it waits for the owner, and the answer names the proposal and its summary.
  const rename = await callTool(writer.client, "garderobe_command", { type: "garment.correct", payload: { garmentId: syntheticId, changes: { name: "Renamed by the smoke test's connection" }, source: { kind: "owner_statement" } }, idempotencyKey: `smoke-rename-${Date.now()}` });
  const renameId = rename.error?.details?.proposalId;
  const unchanged = (await api("GET", `/v1/items/${syntheticId}`)).json.detail.garment.name === "Smoke-test shirt (synthetic, not real stock)";
  const rejected = renameId ? await api("POST", `/v1/proposals/${renameId}/decision`, { decision: "reject" }) : null;
  check("a correction waits for the owner with its proposal identifier and summary, and the owner rejects it", !rename.ok && rename.error.code === "confirmation_required" && Boolean(rename.error.details?.summary) && unchanged && rejected?.json?.proposal?.state === "rejected", rename.error?.details?.summary ?? rename.error?.message);

  const removal = { type: "garment.remove_fabricated", payload: { garmentId: syntheticId, reason: "smoke-test cleanup of a synthetic garment" }, idempotencyKey: `smoke-remove-${Date.now()}` };
  const held = await callTool(writer.client, "garderobe_command", removal);
  const stillThere = (await api("GET", "/v1/wardrobe")).json.items.some((i) => i.garment.garmentId === syntheticId);
  check("sensitive command is not executed for the connection and it is never asked to confirm", !held.ok && held.error.code === "confirmation_required" && stillThere && confirmations.length === 0, held.error?.message);
  const proposal = (await api("GET", "/v1/proposals")).json.proposals.find((p) => p.type === "garment.remove_fabricated" && p.payload.garmentId === syntheticId);
  const decided = proposal ? await api("POST", `/v1/proposals/${proposal.proposalId}/decision`, { decision: "confirm" }) : null;
  const retired = await callTool(writer.client, "garderobe_command", removal);
  const wardrobeAfter = (await api("GET", "/v1/wardrobe")).json;
  check("the owner confirms it in the app, it runs once, and the connection reads the same receipt", Boolean(decided?.json?.receipt?.commandId) && retired.ok && retired.data.receipt.commandId === decided.json.receipt.commandId, proposal ? proposal.summary : "no proposal was listed");
  check("the synthetic garment is gone and the real inventory is unchanged", wardrobeAfter.total === wardrobe.total && !wardrobeAfter.items.some((i) => i.garment.garmentId === syntheticId), `${wardrobeAfter.total} garments`);

  const asked = await callTool(reader.client, "garderobe_ask", { message: "What is in the wash?", clientTurnId: `smoke-ask-${Date.now()}`, mode: "start" });
  check("garderobe_ask: returns a durable run handle", asked.ok ? Boolean(asked.data.runId) : asked.error.code === "module_unavailable", asked.ok ? `run ${asked.data.runId} (${asked.data.state})` : asked.error.message);

  const grants = (await api("GET", "/v1/assistants")).json.grants;
  const grant = grants.find((g) => g.clientName === "Smoke reader" && g.status === "active");
  await api("POST", `/v1/assistants/${grant.grantId}/disconnect`, {});
  const after = await fetch(`${LOCAL.mcpOrigin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${reader.oauth.tokens().access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  check("disconnect takes effect on the next request", after.status === 401);
  check("the other assistant keeps working", (await writer.client.listTools()).tools.length === 7);

  await reader.close();
  await writer.close();
} catch (error) {
  check("smoke run completed without an unexpected error", false, String(error?.stack ?? error).slice(0, 600));
}

const failed = results.filter((r) => !r.pass);
if (asJson) console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
else console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
