#!/usr/bin/env node
/**
 * Verification of the development deployment over HTTPS.
 *
 *   node deploy/verify.mjs                 run every check against the deployed development Workers
 *   node deploy/verify.mjs --restart       also redeploy the product Worker between two reads of the
 *                                          conversation, to show the Durable Object's state survives it
 *
 * It signs in through the automation door (the application's ordinary assertion check with this
 * tooling's issuer, see lib/wrangler-config.mjs), drives a real MCP client through OAuth, and asks the
 * operations Worker for platform probes. Results are written to deploy/evidence/ as identifiers,
 * statuses, timings and counts; no secret, token, invitation code or personal text is written.
 *
 * A check that could not be run is recorded as `not_run` with its exact reason and the remaining step;
 * it is never reported as passed. The same checks run against the local rehearsal (rehearse.mjs), where
 * the platform-only ones are `not_run`.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ACCESS_BYPASS_PATHS, EVIDENCE_DIR, MIGRATIONS_DIR, NAMES, assertDevEnvironment } from "./lib/config.mjs";
import { callTool, clientFor, rawMcp, targetFor } from "./lib/http.mjs";
import { sleep } from "./lib/run.mjs";
import { readState } from "./lib/state.mjs";

const SYNTHETIC_NOTE = "synthetic deployment-verification garment";

export async function runVerification({ target, state, evidenceFile, management = null, restart = null, commit = null }) {
  const c = clientFor(target, state);
  const deployed = target.kind === "deployed";
  const results = [];
  const record = (group, name, status, detail = {}, ms = null) => {
    results.push({ ...detail, group, name, status, ms });
    console.log(`${status.toUpperCase().padEnd(7)} ${group}: ${name}${detail.reason ? `  (${detail.reason})` : ""}`);
  };
  const check = async (group, name, run) => {
    const started = Date.now();
    try {
      const { pass, ...detail } = await run();
      record(group, name, pass ? "pass" : "fail", detail, Date.now() - started);
      return pass;
    } catch (error) {
      record(group, name, "fail", { reason: String(error?.message ?? error).slice(0, 300) }, Date.now() - started);
      return false;
    }
  };
  const notRun = (group, name, reason, remaining) => record(group, name, "not_run", { reason, remaining });
  const platformOnly = (group, name, what) => notRun(group, name, `local rehearsal: ${what} has no local simulator here`, "run `node deploy/verify.mjs` against the deployment");
  const code = (r) => r.json?.error?.code ?? null;
  const command = (type, payload, key, as) => c.api("POST", "/v1/commands", { type, payload, idempotencyKey: key, expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios" } }, { as });
  const run = Date.now().toString(36);

  // ---- Authentication (the application's own sign-in) ------------------------------------------------
  await check("authentication", "a request without an assertion is refused", async () => {
    const r = await c.api("GET", "/v1/me", undefined, { as: null });
    return { pass: r.status === 401 && code(r) === "unauthenticated", httpStatus: r.status, code: code(r) };
  });
  for (const [tamper, label] of [["other_key", "signed by another key"], ["expired", "that has expired"], ["other_audience", "for another application"], ["other_issuer", "from another issuer"]]) {
    await check("authentication", `an assertion ${label} is refused`, async () => {
      const r = await c.api("GET", "/v1/me", undefined, { tamper });
      return { pass: r.status === 401, httpStatus: r.status, code: code(r) };
    });
  }
  await check("authentication", "a management-style bearer token is not an application login", async () => {
    const r = await c.api("GET", "/v1/me", undefined, { as: null, headers: { Authorization: `Bearer ${await c.assertion("owner")}` } });
    return { pass: r.status === 401, httpStatus: r.status };
  });
  await check("authentication", "a valid identity that is not linked to an account gets nothing", async () => {
    const r = await c.api("GET", "/v1/me", undefined, { as: "stranger" });
    const w = await c.api("GET", "/v1/wardrobe", undefined, { as: "stranger" });
    return { pass: r.status === 403 && code(r) === "identity_not_linked" && w.status === 403, httpStatus: r.status, code: code(r), wardrobeStatus: w.status };
  });
  await check("authentication", "an invitation code that was never issued is refused", async () => {
    const r = await c.api("POST", "/auth/claim", { invitationCode: "GRDI-this-code-was-never-issued-0000000" }, { as: "stranger" });
    return { pass: r.status === 403, httpStatus: r.status, code: code(r) };
  });
  let owner = null;
  let synthetic = null;
  await check("authentication", "the invited owner signs in and reaches the imported account", async () => {
    owner = await c.ensureClaimed("owner", state.invitations?.owner);
    synthetic = await c.ensureClaimed("synthetic", state.invitations?.synthetic);
    const me = await c.api("GET", "/v1/me");
    return { pass: me.status === 200, httpStatus: me.status, claimedNow: owner.claimed };
  });
  await check("authentication", "app routes are refused on the MCP hostname even with a valid assertion", async () => {
    const r = await c.api("GET", "/v1/me", undefined, { origin: target.mcpOrigin });
    return { pass: r.status !== 200, httpStatus: r.status, code: code(r) };
  });
  if (deployed) {
    await check("authentication", "the person's door is behind Cloudflare Access (no session: no application response)", async () => {
      const r = await fetch(`${target.personOrigin}/v1/me`, { redirect: "manual" });
      const location = r.headers.get("Location") ?? "";
      return { pass: (r.status === 302 && /cloudflareaccess\.com/.test(location)) || r.status === 401 || r.status === 403, httpStatus: r.status, redirectsToAccess: /cloudflareaccess\.com/.test(location) };
    });
    for (const p of ACCESS_BYPASS_PATHS) {
      await check("authentication", `the self-authenticating path ${p} reaches the Worker without an Access session and still gives nothing away`, async () => {
        const r = await fetch(`${target.personOrigin}${p.replace("*", "not-a-real-token")}`, { redirect: "manual" });
        return { pass: r.status >= 400 && r.status < 500 && !/cloudflareaccess\.com/.test(r.headers.get("Location") ?? ""), httpStatus: r.status };
      });
    }
    notRun("authentication", "a person signs in through Cloudflare Access with Google and claims the account", "needs the owner's own Google sign-in in a browser", "owner: open the app hostname, sign in, and claim with the invitation code the deploy command stored locally");
  } else {
    platformOnly("authentication", "the person's door behind Cloudflare Access", "Cloudflare Access");
  }

  // ---- The seeded data and profile hard constraints -------------------------------------------------
  let wardrobe = null;
  await check("seed", "the API serves the complete imported inventory", async () => {
    wardrobe = (await c.api("GET", "/v1/wardrobe")).json;
    const reconcile = (await c.ops("/ops/reconcile")).json;
    return { pass: wardrobe.complete === true && wardrobe.total === reconcile.garments, apiTotal: wardrobe.total, databaseGarments: reconcile.garments, units: reconcile.units, wearObservations: reconcile.wearObservations, laundryBatches: reconcile.laundryBatches };
  });
  await check("hard constraints", "the imported sneakers-only restriction is active and no wear or laundry history was invented", async () => {
    const r = (await c.ops("/ops/reconcile")).json;
    return { pass: r.activeRestrictions >= 1 && r.wearObservations === 0 && r.laundryBatches === 0, activeRestrictions: r.activeRestrictions, wearObservations: r.wearObservations, laundryBatches: r.laundryBatches };
  });
  await check("hard constraints", "every recommended outfit for tomorrow is built from the owner's real garments and wears sneakers only", async () => {
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = await c.api("POST", "/v1/recommendations", { clientRequestId: `verify-${run}`, date, count: 3 });
    const options = r.json?.options ?? [];
    const byId = new Map((wardrobe?.items ?? []).map((i) => [i.garment.garmentId, i.garment]));
    const pieces = options.flatMap((o) => [...(o.garments ?? []), ...(o.footwearAlternatives ?? [])]);
    const unknown = pieces.filter((p) => !byId.has(p.garmentId)).length;
    const footwear = pieces.filter((p) => byId.get(p.garmentId)?.category === "footwear");
    const notSneakers = footwear.filter((p) => byId.get(p.garmentId).attributes?.footwearKind !== "sneaker").length;
    const withFootwear = options.filter((o) => (o.garments ?? []).some((p) => byId.get(p.garmentId)?.category === "footwear")).length;
    return { pass: r.status === 200 && r.json?.state === "completed" && options.length > 0 && unknown === 0 && withFootwear === options.length && notSneakers === 0, httpStatus: r.status, state: r.json?.state ?? null, options: options.length, pieces: pieces.length, piecesNotInWardrobe: unknown, optionsWithFootwear: withFootwear, footwearOffered: footwear.length, footwearNotSneakers: notSneakers };
  });

  // ---- Isolation between two owners ------------------------------------------------------------------
  let syntheticGarmentId = null;
  await check("isolation", "the synthetic second owner sees only its own labelled garments", async () => {
    const theirs = (await c.api("GET", "/v1/wardrobe", undefined, { as: "synthetic" })).json;
    const realIds = new Set((wardrobe?.items ?? []).map((i) => i.garment.garmentId));
    const leaked = theirs.items.filter((i) => realIds.has(i.garment.garmentId)).length;
    syntheticGarmentId = theirs.items[0]?.garment.garmentId ?? null;
    return { pass: theirs.total >= 3 && leaked === 0 && theirs.items.every((i) => /synthetic/i.test(i.garment.name)), total: theirs.total, leaked };
  });
  await check("isolation", "one owner cannot read or change the other's garment, in either direction", async () => {
    const realId = wardrobe.items[0].garment.garmentId;
    const read1 = await c.api("GET", `/v1/items/${realId}`, undefined, { as: "synthetic" });
    const read2 = await c.api("GET", `/v1/items/${syntheticGarmentId}`);
    const write = await command("care.mark_dirty", { items: [{ garmentId: realId }] }, `verify-cross-${run}`, "synthetic");
    return { pass: read1.status === 404 && read2.status === 404 && write.status === 404 && code(write) === "not_found", readOfRealBySynthetic: read1.status, readOfSyntheticByReal: read2.status, crossWrite: write.status, crossWriteCode: code(write) };
  });

  // ---- Idempotency (writes go to the synthetic owner only) -----------------------------------------
  await check("idempotency", "a repeated command returns the stored receipt; the same key with a different body is refused", async () => {
    const payload = { name: `Verification shirt ${run} (synthetic, not real stock)`, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: SYNTHETIC_NOTE } };
    const first = await command("garment.create", payload, `verify-idem-${run}`, "synthetic");
    const again = await command("garment.create", payload, `verify-idem-${run}`, "synthetic");
    const other = await command("garment.create", { ...payload, name: `${payload.name} changed` }, `verify-idem-${run}`, "synthetic");
    const stored = await c.api("GET", `/v1/commands/${first.json?.commandId}`, undefined, { as: "synthetic" });
    return { pass: first.ok && again.ok && again.json.replayed === true && again.json.commandId === first.json.commandId && other.status === 409 && stored.json?.commandId === first.json.commandId, first: first.status, replayed: again.json?.replayed ?? null, differentBody: other.status, differentBodyCode: code(other) };
  });

  // ---- MCP: OAuth, scopes, a client session ---------------------------------------------------------
  await check("oauth", "the MCP endpoint refuses a request without a grant and points to its metadata", async () => {
    const r = await rawMcp(target.mcpOrigin, null, "tools/list");
    const meta = await fetch(`${target.mcpOrigin}/.well-known/oauth-protected-resource/mcp`).then((x) => x.status, () => 0);
    const server = await fetch(`${target.mcpOrigin}/.well-known/oauth-authorization-server`).then((x) => x.status, () => 0);
    return { pass: r.status === 401 && r.challenge.includes("resource_metadata") && server === 200, httpStatus: r.status, protectedResourceMetadata: meta, authorizationServerMetadata: server };
  });
  await check("oauth", "an Access assertion is not an MCP credential", async () => {
    const r = await rawMcp(target.mcpOrigin, await c.assertion("owner"), "tools/list");
    return { pass: r.status === 401, httpStatus: r.status };
  });
  let reader = null;
  let writer = null;
  await check("oauth", "a read-only and a writing client register, get the owner's consent and receive tokens", async () => {
    reader = await c.connectMcp({ write: false, as: "synthetic", clientName: `Verification reader ${run}`, redirectUri: "https://verify-reader.garderobe-rebuild-dev.invalid/cb" });
    writer = await c.connectMcp({ write: true, as: "synthetic", clientName: `Verification writer ${run}`, redirectUri: "https://verify-writer.garderobe-rebuild-dev.invalid/cb" });
    return { pass: Boolean(reader.accessToken() && writer.accessToken()) };
  });
  if (reader && writer) {
    await check("scopes", "the read-only connection is not offered the write tool; the writing connection gets all seven", async () => {
      const r = (await reader.client.listTools()).tools.map((t) => t.name);
      const w = (await writer.client.listTools()).tools.map((t) => t.name);
      return { pass: r.length === 6 && !r.includes("garderobe_command") && w.length === 7 && w.includes("garderobe_command"), readerTools: r.length, writerTools: w.length };
    });
    await check("scopes", "the write tool called with a read-only token is refused with a scope challenge", async () => {
      const r = await rawMcp(target.mcpOrigin, reader.accessToken(), "tools/call", { name: "garderobe_command", arguments: { type: "care.mark_dirty", payload: { items: [{ garmentId: syntheticGarmentId }] }, idempotencyKey: `verify-scope-${run}` } });
      return { pass: r.status === 403 && r.challenge.includes("insufficient_scope"), httpStatus: r.status };
    });
    await check("mcp session", "the inventory snapshot over MCP equals the API's for the same owner", async () => {
      const snapshot = await callTool(reader.client, "garderobe_inventory", { view: "snapshot" });
      const api = (await c.api("GET", "/v1/wardrobe", undefined, { as: "synthetic" })).json;
      return { pass: snapshot.ok && snapshot.data.complete === true && snapshot.data.total === api.total, mcpTotal: snapshot.data?.total ?? null, apiTotal: api.total };
    });
    await check("mcp session", "a wash report through the write tool commits once with a receipt the API also serves", async () => {
      const args = { type: "care.mark_dirty", payload: { items: [{ garmentId: syntheticGarmentId }] }, idempotencyKey: `verify-mcp-${run}` };
      const wrote = await callTool(writer.client, "garderobe_command", args);
      const replay = await callTool(writer.client, "garderobe_command", args);
      const stored = wrote.ok ? await c.api("GET", `/v1/commands/${wrote.data.receipt.commandId}`, undefined, { as: "synthetic" }) : null;
      return { pass: wrote.ok && replay.ok && replay.data.receipt.replayed === true && stored?.json?.channel === "mcp", outcome: wrote.data?.receipt?.outcome ?? null, errorCode: wrote.error?.code ?? null, replayed: replay.data?.receipt?.replayed ?? null, storedChannel: stored?.json?.channel ?? null };
    });
    let proposalId = null;
    await check("mcp session", "a correction sent by the connection waits for the owner and changes nothing", async () => {
      const before = (await c.api("GET", `/v1/items/${syntheticGarmentId}`, undefined, { as: "synthetic" })).json.detail.garment.name;
      const r = await callTool(writer.client, "garderobe_command", { type: "garment.correct", payload: { garmentId: syntheticGarmentId, changes: { name: "Renamed by a connected assistant" }, source: { kind: "owner_statement" } }, idempotencyKey: `verify-rename-${run}` });
      proposalId = r.error?.details?.proposalId ?? null;
      const after = (await c.api("GET", `/v1/items/${syntheticGarmentId}`, undefined, { as: "synthetic" })).json.detail.garment.name;
      return { pass: !r.ok && r.error.code === "confirmation_required" && Boolean(proposalId) && before === after, code: r.error?.code ?? null, unchanged: before === after };
    });
    await check("mcp session", "a connected assistant cannot lift a restriction", async () => {
      const r = await callTool(writer.client, "garderobe_command", { type: "restriction.resolve", payload: { restrictionId: "any", evidence: { kind: "owner_statement" } }, idempotencyKey: `verify-lift-${run}` });
      return { pass: !r.ok && ["forbidden", "confirmation_required", "invalid_command", "not_found"].includes(r.error.code), code: r.error?.code ?? null };
    });
    await check("mcp session", "proposals cannot be listed or decided with an MCP token, on either hostname; the owner rejects it in the app", async () => {
      const token = writer.accessToken();
      const tries = [];
      for (const origin of [target.appOrigin, target.mcpOrigin, ...(deployed ? [target.personOrigin, target.personMcpOrigin] : [])]) {
        const list = await fetch(`${origin}/v1/proposals`, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
        const decide = await fetch(`${origin}/v1/proposals/${proposalId}/decision`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "confirm" }), redirect: "manual" });
        tries.push(list.status, decide.status);
      }
      const rejected = await c.api("POST", `/v1/proposals/${proposalId}/decision`, { decision: "reject" }, { as: "synthetic" });
      return { pass: tries.every((s) => s !== 200) && rejected.json?.proposal?.state === "rejected", statuses: tries, ownerDecision: rejected.json?.proposal?.state ?? rejected.status };
    });
    await check("mcp session", "disconnecting an assistant takes effect on its next request; the other keeps working", async () => {
      const grants = (await c.api("GET", "/v1/assistants", undefined, { as: "synthetic" })).json.grants;
      const grant = grants.find((g) => g.clientName === `Verification reader ${run}` && g.status === "active");
      await c.api("POST", `/v1/assistants/${grant.grantId}/disconnect`, {}, { as: "synthetic" });
      const after = await rawMcp(target.mcpOrigin, reader.accessToken(), "tools/list");
      const other = (await writer.client.listTools()).tools.length;
      return { pass: after.status === 401 && other === 7, readerAfterDisconnect: after.status, writerTools: other };
    });
    await reader.close();
  }

  // ---- Platform probes through the operations Worker ----------------------------------------------
  const probe = async (group, name, pathName, body = {}, pick = (j) => j) =>
    check(group, name, async () => {
      const r = await c.ops(`/ops/probe/${pathName}`, body);
      const { ok, probe: _p, ...rest } = r.json ?? {};
      return { pass: r.status === 200 && ok === true, ...pick(rest) };
    });

  await check("platform: D1", "every migration in the repository is applied, in order", async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const r = (await c.ops("/ops/probe/d1")).json;
    const applied = r.migrations ?? [];
    return { pass: files.length === applied.length && files.every((f, i) => applied[i] === f), repository: files.length, applied: applied.length, missing: files.filter((f) => !applied.includes(f)), lateStatementFailure: r.lateStatementFailure, earlierStatementRolledBack: r.earlierStatementRolledBack };
  });
  await probe("platform: D1", "a batch whose last statement fails leaves nothing applied", "d1", {}, (j) => ({ lateStatementFailure: j.lateStatementFailure, earlierStatementRolledBack: j.earlierStatementRolledBack }));
  await probe("platform: D1", "simultaneous commands (checklist S08-029): one command per repeated key, one winner among conflicting writers, no orphan receipts", "concurrency");
  await check("platform: D1", "one bulk correction over the cap of 200 synthetic garments commits inside one invocation", async () => {
    let prepared = null;
    for (let i = 0; i < 40; i++) {
      prepared = (await c.ops("/ops/probe/bulk_prepare", { create: 20 })).json;
      if (prepared.complete) break;
    }
    if (!prepared?.complete) return { pass: false, reason: `only ${prepared?.garments ?? 0} synthetic garments could be prepared`, lastError: prepared?.error ?? null };
    const r = (await c.ops("/ops/probe/bulk_correct")).json;
    return { pass: r.ok === true, garments: r.garments ?? null, changed: r.changed ?? null, commandMs: r.commandMs ?? null, error: r.error ?? null };
  });
  await probe("platform: R2", "an object round-trips and is deleted in each private bucket", "r2");
  if (management) {
    await check("platform: R2", "neither bucket has a public address or a custom domain", async () => {
      const b = await management.bucketExposure();
      return { pass: Object.values(b).every((x) => x.publicAddressEnabled === false && x.customDomains === 0), buckets: b };
    });
  } else notRun("platform: R2", "neither bucket has a public address or a custom domain", deployed ? "no management credential in this run" : "local rehearsal: there is no public address locally", "run verify with the management token in the environment");

  await check("platform: Workflows", "a two-step workflow with a durable sleep runs to completion", async () => {
    const started = (await c.ops("/ops/probe/workflow_start")).json;
    if (!started.ok) return { pass: false, reason: started.reason ?? started.error };
    let status = null;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      status = (await c.ops("/ops/probe/workflow_status", { instanceId: started.instanceId })).json;
      if (status.status === "complete" || status.status === "errored" || status.status === "terminated") break;
    }
    return { pass: status?.status === "complete", instanceId: started.instanceId, workflowStatus: status?.status ?? null, resumedAfterMs: status?.output?.resumedAfterMs ?? null };
  });

  await check("platform: Queues", "a message is accepted by the media queue", async () => {
    const r = (await c.ops("/ops/probe/queue_send", { probeId: `probe-${run}` })).json;
    return { pass: r.ok === true, probeId: r.probeId ?? null, reason: r.reason ?? null };
  });
  if (management) {
    await check("platform: Queues", "a message the consumer cannot process is retried and reaches the dead-letter queue", async () => {
      const found = await management.awaitDeadLetter(`probe-${run}`, 240_000);
      return { pass: found.found, waitedMs: found.waitedMs, attempts: found.attempts ?? null, consumer: found.consumer };
    });
  } else notRun("platform: Queues", "a message the consumer cannot process is retried and reaches the dead-letter queue", deployed ? "no management credential in this run" : "local rehearsal: the dead-letter queue is read through the Queues HTTP pull API", "run verify with the management token in the environment");

  await probe("platform: Images", "the media adapters transcode and segment on the Images binding", "images");

  if (deployed) {
    await probe("platform: outbound", "the runtime refuses private destinations and the DNS-over-HTTPS resolver answers", "outbound");
    await probe("platform: research", "the assistant's MCP client discovers the hosted search providers' tools", "research_mcp", {}, (j) => ({ exa: j.exa, tavily: j.tavily }));
    await probe("platform: AI Search", "an owner's private instance is provisioned, indexes a document and finds it", "ai_search");

    // AI Gateway: every operation of every profile that has a route, then the product's own record of each result.
    const profiles = (await c.ops("/ops/probe/gateway_profiles")).json.profiles ?? [];
    const spend = { calls: 0, inputTokens: 0, outputTokens: 0 };
    for (const profile of profiles) {
      if (!profile.route) {
        notRun("platform: AI Gateway", `${profile.profileId}`, profile.pendingReason ?? "no Gateway route", "the assistant thread verifies the exact model ID before it can be probed");
        continue;
      }
      for (const operation of profile.operations) {
        await check("platform: AI Gateway", `${profile.profileId} / ${operation}: answers through ${profile.route} with Unified Billing, and the result is recorded`, async () => {
          const r = (await c.ops("/ops/probe/gateway", { profileId: profile.profileId, operation })).json;
          spend.calls++;
          spend.inputTokens += r.inputTokens ?? 0;
          spend.outputTokens += r.outputTokens ?? 0;
          // Billing is recorded as Unified only on positive evidence: the response's own key source, or the Gateway's log entry.
          const logged = r.keySource ? null : management ? await management.gatewayLogFor(r.runId) : null;
          const unified = /^unified$/i.test(r.keySource ?? "") || logged?.unified === true;
          const answered = r.ok === true;
          let recorded = null;
          if (answered && unified) recorded = (await c.ops("/ops/probe/gateway_record", { profileId: profile.profileId, operation, result: "passed", billing: "unified_billing", resolvedModel: r.resolvedModel ?? null, reason: "deployment probe" })).json;
          else if (!answered) recorded = (await c.ops("/ops/probe/gateway_record", { profileId: profile.profileId, operation, result: "failed", billing: "ineligible", reason: String(r.error ?? r.reason ?? "no usable answer").slice(0, 200) })).json;
          return { pass: answered && unified && recorded?.ok === true, answered, keySource: r.keySource ?? null, gatewayLog: logged, recorded: recorded?.ok ?? false, resolvedModel: r.resolvedModel ?? null, ms: r.ms ?? null, inputTokens: r.inputTokens ?? null, outputTokens: r.outputTokens ?? null, error: r.error ?? r.reason ?? null };
        });
      }
    }
    record("platform: AI Gateway", "model calls made by this verification run", "info", spend);

    await check("conversation", "a real conversation turn completes on the deployed actor", async () => {
      const turn = await c.api("POST", "/v1/conversation/turns", { clientTurnId: `verify-turn-${run}`, text: "How many shirts do I have? Answer in one short sentence." }, { as: "synthetic" });
      const runId = turn.json?.runId ?? turn.json?.run?.runId;
      if (!runId) return { pass: false, httpStatus: turn.status, code: code(turn) };
      let state = null;
      for (let i = 0; i < 45; i++) {
        await sleep(2000);
        const r = (await c.api("GET", `/v1/runs/${runId}`, undefined, { as: "synthetic" })).json;
        state = r?.run ?? r;
        if (["completed", "failed", "cancelled", "needs_input"].includes(state?.state)) break;
      }
      return { pass: state?.state === "completed" && Boolean(state?.result?.reply), runId, state: state?.state ?? null, errorCode: state?.error?.code ?? null, resumable: state?.error?.resumable ?? null };
    });
  } else {
    for (const [group, name, what] of [
      ["platform: outbound", "the runtime refuses private destinations and the DNS-over-HTTPS resolver answers", "the Workers runtime's outbound policy"],
      ["platform: research", "the assistant's MCP client discovers the hosted search providers' tools", "a call from the deployed Worker to the providers"],
      ["platform: AI Search", "an owner's private instance is provisioned, indexes a document and finds it", "AI Search"],
      ["platform: AI Gateway", "every profile and operation answers with Unified Billing and is recorded", "the AI binding"],
      ["conversation", "a real conversation turn completes on the deployed actor", "a model"],
    ]) platformOnly(group, name, what);
  }

  // ---- Durable Object persistence across a restart --------------------------------------------------
  if (deployed && restart) {
    await check("platform: Durable Object", "the conversation's messages are the same after the product Worker is redeployed", async () => {
      const before = (await c.api("GET", "/v1/conversation/messages", undefined, { as: "synthetic" })).json;
      const redeployed = await restart();
      await sleep(5000);
      const after = (await c.api("GET", "/v1/conversation/messages", undefined, { as: "synthetic" })).json;
      const ids = (j) => (j?.messages ?? []).map((m) => m.messageId ?? m.id).join(",");
      return { pass: (before?.messages ?? []).length > 0 && ids(before) === ids(after), messagesBefore: (before?.messages ?? []).length, messagesAfter: (after?.messages ?? []).length, newVersion: redeployed.versionId ?? null };
    });
  } else {
    notRun("platform: Durable Object", "the conversation's messages are the same after the product Worker is redeployed", deployed ? "--restart was not given" : "local rehearsal: a local restart is not the platform's eviction", "run `node deploy/verify.mjs --restart` against the deployment");
  }

  // ---- What only the owner can provide ------------------------------------------------------------
  notRun("external", "Google Calendar: read events and project the outfit event", "needs the owner's own Google sign-in, a Google OAuth client (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) and a chosen outfit calendar; none exists in this project", "owner: create the OAuth client in the dedicated Google Cloud project, give its ID and secret as Worker secrets, connect Google in the app and choose the outfit calendar");
  notRun("external", "Apple WeatherKit forecast", "needs an Apple Developer team, a WeatherKit key and service ID; none exists in this project", "owner: create the WeatherKit key and give the team ID, key ID, service ID and private key as Worker secrets; Open-Meteo is the forecast source until then");
  notRun("external", "Tavily search with the owner's key", "the Tavily credential is on the owner's own machine (specification section 19) and is not a project secret", "owner: add the Tavily key as a connection in the app, or give it as a project secret to be stored as a connection credential");

  if (writer) await writer.close();
  const count = (s) => results.filter((r) => r.status === s).length;
  const report = {
    target: target.kind === "deployed" ? "development deployment on Cloudflare" : "LOCAL REHEARSAL (Miniflare simulators; not a deployment, not platform evidence)",
    origins: target.kind === "deployed" ? { app: target.appOrigin, mcp: `${target.mcpOrigin}/mcp`, personApp: target.personOrigin } : { app: target.appOrigin },
    commit,
    startedAt: new Date(Number.parseInt(run, 36)).toISOString(),
    finishedAt: new Date().toISOString(),
    signIn: "automation door: the application's assertion check with this tooling's issuer; three labelled test identities",
    worker: NAMES.worker,
    summary: { passed: count("pass"), failed: count("fail"), notRun: count("not_run") },
    results,
  };
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, evidenceFile), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.notRun} not run -> deploy/evidence/${evidenceFile}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  assertDevEnvironment(process.argv.slice(2));
  const state = readState();
  if (!state?.deployed) {
    console.error("nothing is deployed according to the local deployment state (deploy/.wrangler/state/dev.json). Run `node deploy/deploy.mjs` first; for a local run of these checks use `node deploy/rehearse.mjs`.");
    process.exit(2);
  }
  const { managementFor, redeployPrimary } = await import("./lib/management.mjs");
  const management = managementFor(state);
  const report = await runVerification({ target: targetFor("deployed"), state, evidenceFile: "verify-dev.json", management, restart: process.argv.includes("--restart") && management ? () => redeployPrimary(state) : null, commit: state.deployed.commit ?? null });
  process.exit(report.summary.failed === 0 ? 0 : 1);
}
