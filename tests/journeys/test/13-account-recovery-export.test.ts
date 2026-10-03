/**
 * Journey 13: the account itself: losing the sign-in, taking the wardrobe elsewhere, deleting the account.
 *
 * Specification: section 15 "Recovery after losing Google access", "Portable owner export", "Stable users
 * and Google-backed login" (email is never a linking proof), "Ownership across every service" (unlinking is
 * not deletion; account deletion is a separate operation) and the recovery screen paragraph; section 13
 * ("accepted is not rendered as done": the export is a run). Acceptance rows (section 17): Lost identity,
 * Portability, Identity recovery (an MCP disconnection has a phone recovery path and does not disable
 * unrelated functions).
 *
 * Everything inside the Worker is real: HTTP API, MCP server and its OAuth provider, export and import,
 * local D1/R2/KV, the owner's real profile and the real 127-garment inventory. Stand-ins, at external
 * boundaries only:
 *  - test-signed sign-in assertions in place of Cloudflare Access with Google (so "a different Google
 *    account" is a different test identity; real Access was not exercised);
 *  - the Worker package's labelled Google OAuth fixture and this suite's Google Calendar double
 *    (src/outbound.ts): they prove the Worker's side of a connection, not Google's;
 *  - the scripted weather double; the FAKE MODEL for one scripted conversation reply.
 * Not covered here: push notifications are judged only by state the API shows (no device registered, no
 * pending effect); the push provider stand-in is not inspected. The encrypted export variant is not part of
 * this journey. Secrets (recovery codes, tokens, the profile text) are compared, never printed.
 */
import { SELF } from "cloudflare:test";
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, ApiClient, MCP_ORIGIN, connectMcp, enableFakeModel, newIdentity, provisionOwner, publishBoard, toolResult, type McpConnection, type TestOwner } from "@garderobe/worker/testing";
import suppliedProfile from "../../../requirements/chris-wardrobe-profile.md?raw";
import checksumList from "../../../requirements/SHA256SUMS?raw";
import { sheetRowsFor } from "../src/inventory.ts";
import { calendarState, connectGoogle, exec, internalCodesIn, realOwnerAt, refused, runCron, settleRun, wholeWardrobe, type JourneyOwner } from "../src/world.ts";

/** The profile's checksum as the owner's own requirements bundle lists it. */
const PROFILE_SHA256 = /^([0-9a-f]{64})\s+chris-wardrobe-profile\.md$/m.exec(checksumList as string)![1]!;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const sha256 = async (data: Uint8Array | string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? encoder.encode(data) : data))].map((b) => b.toString(16).padStart(2, "0")).join("");
const garmentIds = async (api: ApiClient) => (await wholeWardrobe(api)).items.map((i) => i.garment.garmentId).sort();
const profileHash = async (api: ApiClient) => (await api.json("GET", "/v1/style")).document.contentSha256 as string;
/** One raw MCP request with a bearer token, as the assistant's next request would be. */
const mcpWithToken = (token: string) => SELF.fetch(`${MCP_ORIGIN}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
/** True when `text` contains the secret (kept as a boolean so a failure never prints the secret). */
const leaks = (text: string, secret: string) => secret.length > 0 && text.includes(secret);
const WRONG_CODE = `GRD1-RKAAAAAAAAAA-${"0000-".repeat(12)}0000`;

describe("journey 13a: the owner loses the sign-in and recovers the same wardrobe", () => {
  let j: JourneyOwner;
  let owner: TestOwner;
  let assistant: McpConnection;
  let assistantToken: string;
  let connectionId: string;
  let before: { ids: string[]; total: number; profile: string; wornToday: string[] };
  let replacement: ApiClient;
  let transactionId: string;
  let done: Record<string, any>;

  beforeAll(async () => {
    j = await realOwnerAt("Recovery");
    owner = j.owner;
  });

  it("the recovery kit was issued once, when the account was claimed, with a clear storage instruction", async () => {
    const kit = owner.recoveryKit;
    expect(kit.recoveryCode.length).toBeGreaterThanOrEqual(40);
    expect(leaks(kit.downloadText, kit.recoveryCode)).toBe(true); // the downloadable kit carries the code
    expect(kit.downloadFileName).toMatch(/\.txt$/);
    expect(kit.storageInstruction).toMatch(/without your Google account/i);
    expect(kit.storageInstruction).toMatch(/works once/i);
    expect(internalCodesIn(kit.storageInstruction)).toEqual([]);
    // It is not shown again: later reads say only that a kit exists.
    const me = await owner.api.json("GET", "/v1/me");
    expect(me.issuedRecoveryKit).toBeNull();
    expect(me.recoveryKit.present).toBe(true);
    expect(leaks(JSON.stringify(me), kit.recoveryCode)).toBe(false);
    expect(me.identities).toHaveLength(1);
  });

  it("everyday state before the loss: the real wardrobe, a connected assistant, a Google connection, a wear", async () => {
    const wardrobe = await wholeWardrobe(owner.api);
    expect(wardrobe.total).toBe(127);
    const shoe = wardrobe.items.find((i) => i.garment.roles.includes("footwear") && i.availability && !i.availability.hardExcluded)!;
    await exec(owner.api, "wear.record", { wearingDate: j.today, garmentIds: [shoe.garment.garmentId] });
    expect(await profileHash(owner.api)).toBe(PROFILE_SHA256);
    before = { ids: wardrobe.items.map((i) => i.garment.garmentId).sort(), total: wardrobe.total, profile: PROFILE_SHA256, wornToday: [shoe.garment.garmentId] };

    assistant = await connectMcp(owner, { write: true, clientName: "Assistant before recovery (test)" });
    assistantToken = assistant.oauth.snapshot().accessToken;
    expect((await mcpWithToken(assistantToken)).status).toBe(200);
    const grants = (await owner.api.json("GET", "/v1/assistants")).grants as any[];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ clientName: "Assistant before recovery (test)", status: "active", access: "read_write" });

    connectionId = (await connectGoogle(owner)).connectionId;
    const connections = (await owner.api.json("GET", "/v1/connections")).connections as any[];
    expect(connections.map((c) => `${c.connectionId}:${c.state}`)).toEqual([`${connectionId}:connected`]);
  });

  it("the recovery screen shows concrete state and next actions, and no secret", async () => {
    const board = (await publishBoard(owner, { date: j.today })).board;
    const status = await owner.api.json("GET", "/v1/recovery");
    expect(status.lastBoard).toMatchObject({ boardId: board.boardId, localDate: j.today });
    expect(status.lastBoard.revision).toBeGreaterThanOrEqual(board.revision);
    expect(status.pending.runsNeedingInput).toBe(0);
    expect(status.pending.effects).toBeGreaterThanOrEqual(0);
    expect(status.connectionIssues).toEqual([]);
    expect(status.actions).toContain("open_today");
    for (const action of status.actions) expect(["reconnect", "retry", "open_today"]).toContain(action);
    const text = JSON.stringify(status);
    expect(text).not.toMatch(/token|secret|password|bearer/i);
    for (const secret of [owner.recoveryKit.recoveryCode, assistantToken, owner.identity.subject]) expect(leaks(text, secret)).toBe(false);
  });

  it("a different sign-in has no access, and matching the owner's email address proves nothing", async () => {
    replacement = new ApiClient(newIdentity("replacement"));
    const locked = await refused(await replacement.get("/v1/wardrobe"));
    expect(locked.status).toBe(403);
    expect(locked.error.code).toBe("identity_not_linked");
    // Same email, different account at the identity provider: still a stranger.
    const sameEmail = new ApiClient({ subject: newIdentity("same-email").subject, email: owner.identity.email });
    expect((await sameEmail.get("/v1/wardrobe")).status).toBe(403);
    expect((await sameEmail.get("/v1/me")).status).toBe(403);
  });

  it("recovery starts as an expiring transaction; a wrong code is refused and counted", async () => {
    const tx = await replacement.json("POST", "/auth/recovery/start", {});
    transactionId = tx.transactionId;
    expect(tx.attemptsRemaining).toBe(5);
    expect(Date.parse(tx.expiresAt)).toBeGreaterThan(Date.now());

    const wrong = await refused(await replacement.post("/auth/recovery/complete", { transactionId, recoveryCode: WRONG_CODE }));
    expect(wrong.status).toBe(403);
    expect(wrong.error.details.attemptsRemaining).toBe(4);
    expect(wrong.error.message).not.toBe("");
    // Still locked out, and the owner's account is untouched.
    expect((await replacement.get("/v1/wardrobe")).status).toBe(403);
    expect((await owner.api.json("GET", "/v1/me")).identities).toHaveLength(1);
    // Somebody else cannot finish this transaction, even with the right code.
    const thief = new ApiClient(newIdentity("thief"));
    expect((await thief.post("/auth/recovery/complete", { transactionId, recoveryCode: owner.recoveryKit.recoveryCode })).status).toBe(404);
    expect((await thief.get("/v1/me")).status).toBe(403);
  });

  it("the right code binds the new sign-in to the SAME account: same garments, same profile, same history", async () => {
    done = await replacement.json("POST", "/auth/recovery/complete", { transactionId, recoveryCode: owner.recoveryKit.recoveryCode, unlinkPreviousIdentities: true });
    expect(done).toMatchObject({ userId: owner.userId, identityLinked: true, previousIdentitiesUnlinked: 1, connectionsUnchanged: true });
    expect(done.receiptId).toBeTruthy(); // an audit receipt exists for the recovery

    const me = await replacement.json("GET", "/v1/me");
    expect(me.userId).toBe(owner.userId);
    expect(me.identities).toHaveLength(1);
    expect(me.identities[0].current).toBe(true);

    const wardrobe = await wholeWardrobe(replacement);
    expect(wardrobe.total).toBe(before.total);
    expect(wardrobe.items.map((i) => i.garment.garmentId).sort()).toEqual(before.ids);
    expect(await profileHash(replacement)).toBe(before.profile);
    // Nothing was deleted or reset on the way: today's wear and today's board are still there.
    expect(((await replacement.json("GET", `/v1/days/${j.today}`)).garments as any[]).map((g) => g.garmentId)).toEqual(before.wornToday);
    expect((await replacement.json("GET", `/v1/today?date=${j.today}`)).board).not.toBeNull();
    // The recovered owner can act again at once.
    const sock = wardrobe.items.find((i) => i.garment.roles.includes("socks") && i.balances.some((b) => b.bucket === "clean" && b.quantity > 0))!;
    const receipt = await exec(replacement, "care.mark_dirty", { items: [{ garmentId: sock.garment.garmentId, quantity: 1 }] });
    expect(receipt.outcome).toBe("committed");
    await exec(replacement, "command.undo", { commandId: receipt.commandId, reason: null });
  });

  it("the used recovery credential and the lost sign-in cannot be used again", async () => {
    // The lost sign-in no longer opens the account.
    const old = await refused(await owner.api.get("/v1/me"));
    expect(old.status).toBe(403);
    expect((await owner.api.get("/v1/wardrobe")).status).toBe(403);
    // The finished transaction cannot be replayed.
    expect((await replacement.post("/auth/recovery/complete", { transactionId, recoveryCode: owner.recoveryKit.recoveryCode })).status).toBeGreaterThanOrEqual(400);
    // The spent code opens nothing in a new transaction either, for anyone.
    const again = new ApiClient(newIdentity("again"));
    const tx = await again.json("POST", "/auth/recovery/start", {});
    const reuse = await refused(await again.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: owner.recoveryKit.recoveryCode }));
    expect(reuse.status).toBe(403);
    expect((await again.get("/v1/me")).status).toBe(403);
    expect((await replacement.json("GET", "/v1/me")).identities).toHaveLength(1);
  });

  it("connected assistants were disconnected by the recovery; connecting again needs the owner's new consent", async () => {
    expect(done.assistantGrantsRevoked).toBe(1);
    // The assistant's very next request is refused.
    expect((await mcpWithToken(assistantToken)).status).toBe(401);
    const grants = (await replacement.json("GET", "/v1/assistants")).grants as any[];
    expect(grants).toHaveLength(1);
    expect(grants[0].status).toBe("revoked");
    expect(grants[0].revokedAt).toBeTruthy();
    await assistant.close();

    // The phone recovery path for MCP: the recovered owner approves a new connection, which then works.
    const fresh = await connectMcp({ api: replacement }, { write: false, clientName: "Assistant after recovery (test)", redirectUri: "https://after-recovery.client.test/oauth/callback" });
    const today = toolResult(await fresh.client.callTool({ name: "garderobe_today", arguments: { date: j.today } }));
    expect(today.ok, JSON.stringify(today.error)).toBe(true);
    expect(today.data.board.localDate).toBe(j.today);
    expect(((await replacement.json("GET", "/v1/assistants")).grants as any[]).filter((g) => g.status === "active").map((g) => g.clientName)).toEqual(["Assistant after recovery (test)"]);
    await fresh.close();
  });

  it("third-party connections are left exactly as they were", async () => {
    const connections = (await replacement.json("GET", "/v1/connections")).connections as any[];
    expect(connections.map((c) => `${c.connectionId}:${c.kind}:${c.state}`)).toEqual([`${connectionId}:google_workspace:connected`]);
    expect(connections[0].issue).toBeNull();
    expect(connections[0].capabilities.filter((c: any) => c.enabled).map((c: any) => c.key).sort()).toEqual(["calendar.read", "calendar.write_outfit_calendar"]);
  });

  it("a replacement kit was issued; it works for a later loss and signs older sessions out", async () => {
    const kit = done.replacementKit;
    expect(kit.recoveryCode).not.toBe(owner.recoveryKit.recoveryCode);
    expect(kit.kitId).not.toBe(owner.recoveryKit.kitId);
    expect(leaks(kit.downloadText, kit.recoveryCode)).toBe(true);
    expect(kit.storageInstruction.length).toBeGreaterThan(40);
    expect((await replacement.json("GET", "/v1/me")).recoveryKit.present).toBe(true);

    // A session of the current sign-in that would have begun five minutes ago predates the first recovery,
    // which signed every earlier session out: it is refused.
    const olderSession = replacement.with({ issuedAgoSeconds: 300 });
    expect((await olderSession.get("/v1/me")).status).toBe(401);
    // A later loss: another sign-in recovers with the replacement code, keeping the earlier sign-in linked.
    const later = new ApiClient(newIdentity("later"));
    const tx = await later.json("POST", "/auth/recovery/start", {});
    const second = await later.json("POST", "/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: kit.recoveryCode });
    expect(second).toMatchObject({ userId: owner.userId, identityLinked: true, previousIdentitiesUnlinked: 0 });
    expect(leaks(JSON.stringify(second.replacementKit), kit.recoveryCode)).toBe(false);
    expect(await garmentIds(later)).toEqual(before.ids);
    expect(await profileHash(later)).toBe(before.profile);
    // The earlier sign-in is still linked and works with a fresh session; its older session is refused by name.
    expect((await replacement.json("GET", "/v1/me")).identities).toHaveLength(2);
    const stale = await refused(await olderSession.get("/v1/me"));
    expect(stale.status).toBe(401);
    expect(stale.error.code).toBe("session_revoked");

    // The recovery screen for the recovered owner: concrete state, still no secret.
    const status = await later.json("GET", "/v1/recovery");
    expect(status.lastBoard.localDate).toBe(j.today);
    expect(status.pending.runsNeedingInput).toBe(0);
    const text = JSON.stringify(status);
    for (const secret of [owner.recoveryKit.recoveryCode, kit.recoveryCode, second.replacementKit.recoveryCode, assistantToken]) expect(leaks(text, secret)).toBe(false);
  });
});

describe("journey 13b: export my wardrobe, verify it, and import it into an empty account", () => {
  let j: JourneyOwner;
  let owner: TestOwner;
  let stranger: TestOwner;
  let target: TestOwner;
  let assistant: McpConnection;
  let calendarId: string;
  let job: any;
  let zip: Uint8Array;
  let files: Record<string, Uint8Array>;
  let manifest: any;
  let worn: string[];
  let journeyCommands: string[];
  let report: any;
  const said = "Which shirt goes with the grey flannels on Thursday?";
  const text = (path: string) => decoder.decode(files[path]!);
  const jsonFile = (path: string) => JSON.parse(text(path));
  const importInto = (to: TestOwner, body: Uint8Array) => to.api.request("POST", "/v1/imports", { raw: body, headers: { "Content-Type": "application/zip" } });
  const calendarWrites = async () => (await calendarState(calendarId)).log.filter((entry) => !["get", "list"].includes(entry.op)).length;

  async function exportOnce(): Promise<any> {
    const requested = await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}` });
    let current = requested;
    for (let i = 0; i < 150 && ["queued", "running"].includes(current.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      current = await owner.api.json("GET", `/v1/exports/${requested.exportId}`);
    }
    return current;
  }

  beforeAll(async () => {
    j = await realOwnerAt("Export");
    owner = j.owner;
    stranger = await provisionOwner();
    const model = await enableFakeModel(owner);
    const wardrobe = await wholeWardrobe(owner.api);
    const clean = (role: string) => wardrobe.items.find((i) => i.garment.acquisition === "owned" && i.garment.roles.includes(role) && i.availability && !i.availability.hardExcluded && i.balances.some((b) => b.bucket === "clean" && b.quantity > 0))!.garment;
    // The owner's own activity on this journey, so the package has history from more than the import.
    const opening = (await owner.api.json("GET", "/v1/studio?mode=for_today")).opening as { role: string; garmentId: string }[];
    const combination = await exec(owner.api, "studio.save_combination", { name: "Thursday", mode: "for_today", slots: opening.map((slot) => ({ role: slot.role, garmentId: slot.garmentId })) });
    worn = [clean("top").garmentId, clean("bottom").garmentId].sort();
    const wear = await exec(owner.api, "wear.record", { wearingDate: j.today, garmentIds: worn });
    const dirty = await exec(owner.api, "care.mark_dirty", { items: [{ garmentId: clean("socks").garmentId, quantity: 1 }] });
    const undo = await exec(owner.api, "command.undo", { commandId: dirty.commandId, reason: null });
    journeyCommands = [wear.commandId, dirty.commandId, undo.commandId, combination.commandId];
    model.script({ text: "SCRIPTED FAKE MODEL REPLY: the blue oxford." });
    const turn = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: said });
    await settleRun(owner.api, turn.runId);
    // An external effect that really happened: today's board written to the owner's outfit calendar (calendar double).
    const google = await connectGoogle(owner);
    const calendar = await owner.api.json("POST", `/v1/connections/${google.connectionId}/outfit-calendar`, { clientRequestId: `cal-${crypto.randomUUID()}`, name: `Outfits export journey ${crypto.randomUUID().slice(0, 6)}` });
    calendarId = calendar.calendar.calendarId;
    await publishBoard(owner, { date: j.today });
    let writes = -1;
    for (let i = 0; i < 6; i++) {
      await runCron();
      const now = await calendarWrites();
      const projected = (await owner.api.json("GET", `/v1/today?date=${j.today}`)).board.calendarProjection.state === "projected";
      if (projected && now === writes) break; // projected, and a further scheduled run wrote nothing more
      writes = now;
    }
    assistant = await connectMcp(owner, { write: true, clientName: "Assistant in export (test)" });
  });

  it("before exporting: the calendar projection really happened, so there is an external effect that could be replayed", async () => {
    const today = await owner.api.json("GET", `/v1/today?date=${j.today}`);
    expect(today.board.calendarProjection.state).toBe("projected");
    const calendar = await calendarState(calendarId);
    expect(calendar.events.filter((e) => e.status !== "cancelled")).toHaveLength(1);
    expect(await calendarWrites()).toBeGreaterThan(0);
    expect((await owner.api.json("GET", "/v1/recovery")).pending.effects).toBe(0);
  });

  it("Export my wardrobe runs as a job to follow and says honestly whether the package is complete", async () => {
    // The product reports a package as incomplete when the wardrobe changed while it was read and says
    // "Export again"; the owner does exactly that (at most three times).
    for (let attempt = 0; attempt < 3; attempt++) {
      job = await exportOnce();
      if (job.complete) break;
      expect(job.state).toBe("completed_incomplete");
      expect(job.components.filter((c: any) => c.state !== "complete").every((c: any) => typeof c.note === "string" && c.note.length > 0)).toBe(true);
    }
    expect(job.state).toBe("completed");
    expect(job.complete).toBe(true);
    expect(job.encrypted).toBe(false);
    expect(job.formatVersion).toBe("garderobe-export/1");
    expect(job.components.length).toBeGreaterThanOrEqual(10);
    for (const component of job.components) expect(component.state, component.name).toBe("complete");
    for (const name of ["inventory", "quantities", "wear", "style", "receipts", "daily", "conversation", "media"]) expect(job.components.map((c: any) => c.name)).toContain(name);
    expect(job.snapshot.wardrobeRevision).toBe((await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision);
    expect(Date.parse(job.expiresAt)).toBeGreaterThan(Date.now());
    // It is a durable run like any other long operation, and it is listed.
    const run = await owner.api.json("GET", `/v1/runs/${job.runId}`);
    expect(run).toMatchObject({ kind: "export", state: "completed" });
    expect(run.result.exportId).toBe(job.exportId);
    expect(((await owner.api.json("GET", "/v1/exports")).exports as any[]).map((e) => e.exportId)).toContain(job.exportId);
    // Another owner cannot see it or get a download ticket for it.
    expect((await stranger.api.get(`/v1/exports/${job.exportId}`)).status).toBe(404);
    expect((await stranger.api.post(`/v1/exports/${job.exportId}/ticket`, {})).status).toBe(404);
  });

  it("the package downloads with a short-lived ticket that works exactly once", async () => {
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/exports/${job.exportId}/download`)).status).toBeGreaterThanOrEqual(400);
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/exports/${job.exportId}/download?ticket=not-a-ticket`)).status).toBe(401);
    const ticket = await owner.api.json("POST", `/v1/exports/${job.exportId}/ticket`, {});
    expect(ticket.fileName).toMatch(/^garderobe-export-.*\.zip$/);
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(Date.parse(ticket.expiresAt)).toBeGreaterThan(Date.now());
    // The ticket alone authorizes the download (no session is sent).
    const response = await SELF.fetch(`${APP_ORIGIN}${ticket.url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toContain(ticket.fileName);
    zip = new Uint8Array(await response.arrayBuffer());
    expect((await SELF.fetch(`${APP_ORIGIN}${ticket.url}`)).status).toBe(410);
    // What was downloaded is the package the job describes.
    expect(zip.length).toBe(job.byteLength);
    expect(await sha256(zip)).toBe(job.sha256);
    files = unzipSync(zip);
    manifest = jsonFile("manifest.json");
  });

  it("the manifest is versioned and every checksum verifies when recomputed from the files", async () => {
    expect(manifest.format).toBe("garderobe-export/1");
    expect(manifest.exportId).toBe(job.exportId);
    expect(manifest.complete).toBe(true);
    expect(manifest.snapshot.coherent).toBe(true);
    expect(Number.isNaN(Date.parse(manifest.exportedAt))).toBe(false);
    expect(manifest.watermarks.ledger.wardrobeRevision).toBe(job.snapshot.wardrobeRevision);
    expect(Object.keys(manifest.watermarks.components).length).toBeGreaterThanOrEqual(10);
    expect(manifest.files.length).toBeGreaterThan(15);
    for (const entry of manifest.files) {
      expect(files[entry.path], entry.path).toBeTruthy();
      expect(files[entry.path]!.length, entry.path).toBe(entry.bytes);
      expect(await sha256(files[entry.path]!), entry.path).toBe(entry.sha256);
    }
    // Nothing in the package is unlisted, and the checksum file agrees line by line (manifest included).
    const listed = new Set<string>(manifest.files.map((f: any) => f.path));
    for (const path of Object.keys(files)) if (path !== "manifest.json" && path !== "checksums.sha256") expect(listed.has(path), path).toBe(true);
    const lines = text("checksums.sha256").trim().split("\n");
    expect(lines.length).toBe(manifest.files.length + 1);
    for (const line of lines) {
      const [sum, path] = line.split("  ");
      expect(await sha256(files[path!]!), path).toBe(sum);
    }
    expect(lines.some((line) => line.endsWith("  manifest.json"))).toBe(true);
  });

  it("it holds the whole inventory (127 garments, same identifiers) and the profile word for word", async () => {
    const wardrobe = await wholeWardrobe(owner.api);
    const inventory = jsonFile("records/inventory.json").tables;
    expect(inventory.garments.rows).toHaveLength(127);
    expect(inventory.garments.rows.map((g: any) => g.garment_id).sort()).toEqual(wardrobe.items.map((i) => i.garment.garmentId).sort());
    expect(inventory.garment_aliases.rows.length).toBeGreaterThan(0);
    // The active restriction travels with the wardrobe: it is not lifted by moving.
    expect(inventory.restrictions.rows.filter((r: any) => r.status === "active").length).toBeGreaterThan(0);
    // Every exported garment is one the owner's own sheet lists.
    for (const garment of inventory.garments.rows) expect(sheetRowsFor(garment.name).length, garment.name).toBeGreaterThan(0);
    expect(jsonFile("records/quantities.json").tables.stock_balances.rows.length).toBeGreaterThanOrEqual(127);

    const documents = jsonFile("records/style.json").tables.style_documents.rows as any[];
    const active = documents.filter((d) => d.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].content_sha256).toBe(PROFILE_SHA256);
    expect(await sha256(active[0].content)).toBe(PROFILE_SHA256);
    expect(active[0].content === suppliedProfile).toBe(true); // word for word (compared, not printed)
    expect(await sha256(text("views/profile.md"))).toBe(PROFILE_SHA256);
    expect(jsonFile("records/style.json").tables.style_rules.rows.length).toBeGreaterThan(0);
  });

  it("it holds what happened on this journey: the wears, the receipts, the board, the conversation with its dates", async () => {
    const wears = jsonFile("records/wear.json").tables.daily_wears.rows.filter((w: any) => w.wearing_date === j.today);
    expect(wears.map((w: any) => w.garment_id).sort()).toEqual(worn);
    const commands = jsonFile("records/receipts.json").tables.commands.rows as any[];
    const exported = new Set(commands.map((c) => c.command_id));
    for (const commandId of journeyCommands) expect(exported.has(commandId), commandId).toBe(true);
    expect(commands.some((c) => c.type === "command.undo")).toBe(true);
    const daily = jsonFile("records/daily.json").tables;
    expect(daily.boards.length).toBeGreaterThan(0);
    expect(daily.board_revisions.length).toBeGreaterThan(0);
    const conversation = jsonFile("records/conversation.json");
    const ownerMessage = JSON.stringify(conversation.messages.find((m: any) => JSON.stringify(m).includes(said)));
    expect(ownerMessage).toContain(said);
    expect(ownerMessage).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(JSON.stringify(conversation)).toContain("SCRIPTED FAKE MODEL REPLY: the blue oxford.");
    expect(JSON.stringify(conversation)).not.toMatch(/"type":\s*"reasoning"/);
  });

  it("it can be read without Garderobe: CSV views and a README that explains the records", async () => {
    const inventory = text("views/inventory.csv").trim().split("\r\n");
    expect(inventory[0]).toContain("garment_id,name,category");
    expect(inventory.length).toBe(128); // header + 127 garments
    const wearHistory = text("views/wear-history.csv");
    expect(wearHistory).toContain(j.today);
    for (const garmentId of worn) expect(wearHistory).toContain(garmentId);
    expect(text("views/quantity-movements.csv").trim().split("\r\n").length).toBeGreaterThan(100);
    expect(text("views/conversation.md")).toContain(said);
    expect(text("views/summary.md")).toMatch(/inventory/i);
    const readme = text("README.md");
    expect(readme.length).toBeGreaterThan(1500);
    // Relationships, units, date semantics, estimates and what is missing are explained.
    expect(readme).toMatch(/relate/i);
    expect(readme).toMatch(/units/i);
    expect(readme).toMatch(/wearing date/i);
    expect(readme).toMatch(/estimate/i);
    expect(readme).toMatch(/not in this package/i);
    expect(readme).toContain("views/inventory.csv");
  });

  it("it contains no credential, token, recovery verifier or sign-in identity", async () => {
    const tokens = assistant.oauth.snapshot();
    const secrets = [owner.recoveryKit.recoveryCode, owner.recoveryKit.recoveryCode.split("-").slice(2).join(""), owner.identity.subject, owner.identity.email ?? "", tokens.accessToken, tokens.refreshToken ?? ""];
    for (const [path, bytes] of Object.entries(files)) {
      if (path.startsWith("media/")) continue;
      const content = decoder.decode(bytes);
      secrets.forEach((secret, index) => expect(leaks(content, secret), `secret #${index} in ${path}`).toBe(false));
      expect(/"(access_token|refresh_token|token_hash|verifier|ciphertext|client_secret|recovery_code|password)"/.test(content), path).toBe(false);
    }
    for (const forbidden of ["recovery_credentials", "auth_identities", "connection_credentials", "connection_oauth_states", "owner_invitations", "identity_link_tickets", "export_tickets"]) {
      expect(Object.keys(files).some((path) => path.includes(forbidden)), forbidden).toBe(false);
      for (const path of Object.keys(files).filter((p) => p.startsWith("records/"))) expect(Object.keys(jsonFile(path).tables ?? {}), `${path} ${forbidden}`).not.toContain(forbidden);
    }
    // The manifest says what was left out, and the account file lists connections for information only.
    expect(manifest.excluded.join(" ")).toMatch(/recovery/i);
    const account = jsonFile("records/account.json");
    expect(account.note).toMatch(/never creates sign-ins/i);
    expect(account.connectedAssistants.map((a: any) => a.client_name)).toEqual(["Assistant in export (test)"]);
  });

  it("importing into an empty account restores the same wardrobe with the same identifiers", async () => {
    target = await provisionOwner();
    expect((await target.api.json("GET", "/v1/wardrobe")).total).toBe(0);
    const response = await importInto(target, zip);
    report = await response.json();
    expect(response.status, JSON.stringify(report).slice(0, 400)).toBe(200);
    expect(report).toMatchObject({ state: "completed", checksumsVerified: true, idsPreserved: true, externalEffectsReplayed: 0, formatVersion: "garderobe-export/1", error: null });
    expect((await target.api.json("GET", `/v1/imports/${report.importId}`)).state).toBe("completed");
    expect(await target.api.json("GET", `/v1/runs/${report.runId}`)).toMatchObject({ kind: "import", state: "completed" });

    const source = await wholeWardrobe(owner.api);
    const restored = await wholeWardrobe(target.api);
    expect(restored.total).toBe(127);
    expect(restored.items.map((i) => i.garment.garmentId).sort()).toEqual(source.items.map((i) => i.garment.garmentId).sort());
    const sourceById = new Map(source.items.map((i) => [i.garment.garmentId, i]));
    for (const item of restored.items) {
      const twin = sourceById.get(item.garment.garmentId)!;
      expect(item.garment.name).toBe(twin.garment.name);
      expect(item.balances, item.garment.name).toEqual(twin.balances);
      expect(item.recordedWearCount, item.garment.name).toBe(twin.recordedWearCount);
      expect(item.availability!.hardExcluded, item.garment.name).toBe(twin.availability!.hardExcluded);
    }
    // Profile, today's wears, receipts (same command IDs), saved combination and conversation came across.
    expect(await profileHash(target.api)).toBe(PROFILE_SHA256);
    expect(((await target.api.json("GET", `/v1/days/${j.today}`)).garments as any[]).map((g) => g.garmentId).sort()).toEqual(worn);
    for (const commandId of journeyCommands) expect((await target.api.json("GET", `/v1/commands/${commandId}`)).commandId).toBe(commandId);
    expect(((await target.api.json("GET", "/v1/studio")).combinations as any[]).map((c) => c.name)).toContain("Thursday");
    expect(JSON.stringify(await target.api.json("GET", "/v1/conversation/messages"))).toContain(said);
    // The sneakers-only restriction was not lifted by the move: restricted shoes are still excluded.
    expect(restored.items.filter((i) => i.garment.roles.includes("footwear") && i.availability!.restrictionIds.length > 0).length).toBeGreaterThan(0);
    // The source account is unchanged.
    expect((await wholeWardrobe(owner.api)).wardrobeRevision).toBe(source.wardrobeRevision);
  });

  it("the import replays no external effect: no calendar write, nothing pending, nothing to notify", async () => {
    const writesBefore = await calendarWrites();
    await runCron();
    await runCron();
    expect(await calendarWrites()).toBe(writesBefore);
    expect((await calendarState(calendarId)).events.filter((e) => e.status !== "cancelled")).toHaveLength(1);
    const status = await target.api.json("GET", "/v1/recovery");
    expect(status.pending.effects).toBe(0);
    expect(status.connectionIssues).toEqual([]);
    // The imported board is there to read, but it is not projected to anybody's calendar for the new account.
    const today = await target.api.json("GET", `/v1/today?date=${j.today}`);
    expect(today.board).not.toBeNull();
    expect(today.board.calendarProjection.state).not.toBe("projected");
    expect((await target.api.json("GET", "/v1/devices")).devices).toEqual([]);
  });

  it("the import plants no sign-in, connection or assistant grant in the new account", async () => {
    const me = await target.api.json("GET", "/v1/me");
    expect(me.userId).toBe(target.userId);
    expect(me.identities).toHaveLength(1); // the new account's own sign-in only
    expect((await target.api.json("GET", "/v1/connections")).connections).toEqual([]);
    expect((await target.api.json("GET", "/v1/assistants")).grants).toEqual([]);
    expect(report.components.find((c: any) => c.name === "account").imported).toBe(0);
    // The source owner's sign-in and assistant still belong to the source account only.
    expect((await owner.api.json("GET", "/v1/me")).userId).toBe(owner.userId);
    const viaAssistant = toolResult(await assistant.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot" } }));
    expect(viaAssistant.ok, JSON.stringify(viaAssistant.error)).toBe(true);
    // The source's recovery code does not open the new account.
    const visitor = new ApiClient(newIdentity("visitor"));
    const tx = await visitor.json("POST", "/auth/recovery/start", {});
    const recovered = await visitor.json("POST", "/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: owner.recoveryKit.recoveryCode });
    expect(recovered.userId).toBe(owner.userId);
    expect(recovered.userId).not.toBe(target.userId);
  });

  it("a package changed after export is refused whole, and a second import into the same account is refused", async () => {
    const entries: Record<string, Uint8Array> = { ...files };
    const inventory = jsonFile("records/inventory.json");
    inventory.tables.garments.rows[0].name = "SYNTHETIC garment that was never owned";
    entries["records/inventory.json"] = encoder.encode(JSON.stringify(inventory));
    const tampered = zipSync(entries);

    const victim = await provisionOwner();
    const refusal = await refused(await importInto(victim, tampered));
    expect(refusal.status).toBe(400);
    expect(refusal.error.message).not.toBe("");
    expect((await victim.api.json("GET", "/v1/wardrobe")).total).toBe(0);
    expect((await victim.api.json("GET", "/v1/conversation/messages")).messages).toEqual([]);
    // Bytes that are not a package at all are refused too.
    expect((await importInto(victim, encoder.encode("this is not a wardrobe package".padEnd(200, ".")))).status).toBeGreaterThanOrEqual(400);
    expect((await victim.api.json("GET", "/v1/wardrobe")).total).toBe(0);

    // The account that already received the wardrobe does not take it a second time.
    const again = await importInto(target, zip);
    expect(again.status).toBe(409);
    expect((await wholeWardrobe(target.api)).total).toBe(127);
  });
});

describe("journey 13c: deleting an account is its own, confirmed operation", () => {
  it("asks for confirmation first, refuses a wrong confirmation, and only then erases the account", async () => {
    // A throwaway synthetic owner with one labelled synthetic garment and a connected assistant.
    const owner = await provisionOwner();
    await exec(owner.api, "garment.create", { name: "SYNTHETIC scarf of a deleted account", category: "scarf", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, attributes: { accessoryKind: "scarf" }, source: { kind: "system", note: "synthetic journey test garment" } });
    const assistant = await connectMcp(owner, { write: false, clientName: "Assistant of a deleted account (test)" });
    const token = assistant.oauth.snapshot().accessToken;

    // Asking does not delete anything: it explains the consequence in plain words and hands back a confirmation step.
    const asked = await owner.api.json("POST", "/v1/account/delete", {});
    expect(asked.state).toBe("confirmation_required");
    expect(typeof asked.confirmationToken).toBe("string");
    expect(Date.parse(asked.expiresAt)).toBeGreaterThan(Date.now());
    expect(asked.consequence).toMatch(/cannot be undone/i);
    expect(asked.consequence).toMatch(/export your wardrobe first/i);
    expect(asked.consequence).toMatch(/not the same as unlinking/i);
    expect(internalCodesIn(asked.consequence)).toEqual([]);
    expect((await owner.api.json("GET", "/v1/wardrobe")).total).toBe(1);
    expect((await mcpWithToken(token)).status).toBe(200);

    // A wrong confirmation deletes nothing; neither can another owner confirm with this owner's token.
    expect((await owner.api.post("/v1/account/delete", { confirmationToken: "GRDD-not-the-confirmation" })).status).toBe(409);
    const other = await provisionOwner();
    expect((await other.api.post("/v1/account/delete", { confirmationToken: asked.confirmationToken })).status).toBe(409);
    expect((await owner.api.json("GET", "/v1/wardrobe")).total).toBe(1);
    expect((await other.api.get("/v1/me")).status).toBe(200);

    const confirmed = await owner.api.json("POST", "/v1/account/delete", { confirmationToken: asked.confirmationToken });
    expect(["erased", "disabled_pending_deletion"]).toContain(confirmed.state);
    // The sign-in opens nothing any more and the assistant's next request is refused.
    expect((await owner.api.get("/v1/me")).status).toBe(403);
    expect((await owner.api.get("/v1/wardrobe")).status).toBe(403);
    expect((await mcpWithToken(token)).status).toBe(401);
    // The recovery kit of a deleted account recovers nothing.
    const visitor = new ApiClient(newIdentity("after-deletion"));
    const tx = await visitor.json("POST", "/auth/recovery/start", {});
    expect((await visitor.post("/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: owner.recoveryKit.recoveryCode })).status).toBeGreaterThanOrEqual(400);
    expect((await visitor.get("/v1/me")).status).toBe(403);
    // The other account is untouched.
    expect((await other.api.get("/v1/me")).status).toBe(200);
    await assistant.close();
  });
});
