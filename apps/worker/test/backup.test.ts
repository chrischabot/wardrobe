import { SELF } from "cloudflare:test";
import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { runScheduledBackups } from "../src/backup/service.ts";
import { BACKUP_RETENTION_MS } from "../src/export/job.ts";
import { sweepExpired } from "../src/maintenance.ts";
import { APP_ORIGIN, enableFakeModel, provisionOwner, publishBoard, testApp, uploadImage, type TestOwner } from "../src/testing/index.ts";

/*
 * Scheduled backups, the restore manifest and a full restore, through the real Worker with the REAL
 * owner fixture (supplied profile and inventory). Stand-ins: test-signed Access assertions; the labelled
 * FAKE MODEL for the conversation; the labelled tool-service fixture for a stored credential. Local R2
 * and D1 stand for the deployed bucket and database: the drill on real resources is a deployment step
 * (scripts/restore-drill.mjs).
 */
let owner: TestOwner;
let backup: any;
let zip: Uint8Array;
let forgottenText: string;
const today = new Date().toISOString().slice(0, 10);
const connectionSecret = "tvly-BACKUP-TEST-SECRET-4d5e6f7a8b";
const decoder = new TextDecoder();

async function download(target: TestOwner, backupId: string): Promise<Uint8Array> {
  const ticket = await target.api.json("POST", `/v1/backups/${backupId}/ticket`, {});
  return new Uint8Array(await (await SELF.fetch(`${APP_ORIGIN}${ticket.url}`)).arrayBuffer());
}

async function scheduledBackupFor(target: TestOwner): Promise<any> {
  const app = await testApp();
  // The sweep takes a bounded number of owners per run; repeat it as the cron would until this owner is done.
  for (let i = 0; i < 12; i++) {
    await runScheduledBackups(app, Date.now());
    const list = await target.api.json("GET", "/v1/backups");
    if (list.backups.some((b: any) => b.state === "completed")) return list;
  }
  throw new Error("the scheduled sweep did not back this owner up");
}

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  const model = await enableFakeModel(owner);
  const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
  const clean = (role: string) => wardrobe.items.find((i: any) => i.garment.acquisition === "owned" && i.garment.roles.includes(role) && i.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0)).garment;
  await owner.api.command("wear.record", { wearingDate: today, garmentIds: [clean("top").garmentId, clean("bottom").garmentId] });
  await owner.api.command("care.mark_dirty", { items: [{ garmentId: clean("socks").garmentId, quantity: 1 }] });
  await publishBoard(owner, { date: today });
  await uploadImage(owner, { garmentId: clean("top").garmentId });
  for (const [question, reply] of [["Which shirt for the board meeting?", "The oxford cloth shirt suits the meeting."], ["A private note I will want forgotten: FORGET-ME-5521", "Noted."]]) {
    model.script({ text: reply });
    const turn = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: question });
    for (let i = 0; i < 100; i++) {
      if ((await owner.api.json("GET", `/v1/runs/${turn.runId}`)).state === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  forgottenText = "FORGET-ME-5521";
  await owner.api.json("POST", "/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, kind: "tavily", name: "Page search", auth: { type: "secret", secret: connectionSecret } });
});

describe("scheduled backups", () => {
  it("takes one backup per owner per day, complete, with a restore manifest, and not a second one the same day", async () => {
    const list = await scheduledBackupFor(owner);
    expect(list.backups).toHaveLength(1);
    backup = list.backups[0];
    expect(backup).toMatchObject({ state: "completed", complete: true });
    expect(backup.backupId).toMatch(/^bkp_/);
    expect(Date.parse(backup.expiresAt) - Date.parse(backup.finishedAt)).toBe(BACKUP_RETENTION_MS); // bounded retention
    expect(backup.components.map((c: any) => [c.name, c.state])).toEqual(expect.arrayContaining([["inventory", "complete"], ["conversation", "complete"], ["media", "complete"], ["daily", "complete"], ["assistant", "complete"], ["account", "complete"]]));

    const manifest = backup.restoreManifest;
    expect(manifest.format).toBe("garderobe-restore-manifest/1");
    // Snapshot times across stores and projection watermarks.
    expect(manifest.snapshot).toMatchObject({ coherent: true, stores: { ledger: backup.takenAt, records: backup.takenAt } });
    expect(Date.parse(manifest.snapshot.stores.conversation)).toBeGreaterThan(0);
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    expect(manifest.state.inventory.garments).toBe(wardrobe.total);
    expect(manifest.state.ledger.wardrobeRevision).toBe(wardrobe.wardrobeRevision);
    expect(manifest.state.wear.countedWears).toBe(2);
    expect(manifest.state.conversation).toMatchObject({ messageCount: 4 });
    expect(manifest.state.conversation.indexedThrough).toBe(manifest.state.conversation.lastAuthoredAt);
    expect(manifest.state.media.assets).toBeGreaterThan(0);
    expect(manifest.state.notRestored).toMatchObject({ signInIdentities: 1, connections: 1 });

    // Repeating the sweep the same day continues nothing and adds nothing.
    await runScheduledBackups(await testApp(), Date.now());
    await runScheduledBackups(await testApp(), Date.now());
    expect((await owner.api.json("GET", "/v1/backups")).backups).toHaveLength(1);
    // A backup is not an export the owner asked for.
    expect((await owner.api.json("GET", "/v1/exports")).exports).toEqual([]);
  });

  it("holds the ledger, the conversation with its overlays and pending turns, connection metadata and the image bytes, and no credential", async () => {
    zip = await download(owner, backup.backupId);
    const files = unzipSync(zip);
    const json = (path: string) => JSON.parse(decoder.decode(files[path]!));
    expect(json("restore-manifest.json")).toEqual(backup.restoreManifest);
    expect(json("manifest.json").backup).toMatchObject({ ownerRef: backup.restoreManifest.ownerRef, restoreManifest: "restore-manifest.json" });
    const conversation = json("records/conversation.json");
    expect(conversation.kind).toBe("garderobe-conversation-backup");
    expect(Array.isArray(conversation.overlays)).toBe(true);
    expect(Array.isArray(conversation.pendingTurns)).toBe(true);
    expect(JSON.stringify(conversation)).toContain("Which shirt for the board meeting?");
    expect(json("records/account.json").connections).toHaveLength(1); // connector metadata
    expect(Object.keys(files).some((p) => p.startsWith("media/"))).toBe(true); // source assets
    expect(json("records/inventory.json").tables.garments.rows.length).toBe(backup.restoreManifest.state.inventory.garments);
    const everything = Object.values(files).map((bytes) => decoder.decode(bytes)).join("\n");
    for (const secret of [connectionSecret, owner.recoveryKit.recoveryCode, owner.identity.subject, (await testApp()).env.CREDENTIAL_KEY]) expect(everything.includes(secret)).toBe(false);
  });

  it("is readable only by its owner", async () => {
    const stranger = await provisionOwner();
    expect((await stranger.api.json("GET", "/v1/backups")).backups).toEqual([]);
    expect((await stranger.api.post(`/v1/backups/${backup.backupId}/ticket`, {})).status).toBe(404);
  });
});

describe("restoring a backup", () => {
  let target: TestOwner;
  let journal: any;

  it("records what the owner forgot after the backup in the tombstone journal", async () => {
    const messages = (await owner.api.json("GET", "/v1/conversation/messages")).messages;
    const secretMessage = messages.find((m: any) => m.text.includes(forgottenText));
    const forgot = await owner.api.command("conversation.forget_source", { sourceKind: "message", sourceIds: [secretMessage.messageId] });
    expect(forgot.status, await forgot.clone().text()).toBe(200);
    journal = await owner.api.json("GET", "/v1/backups/tombstones");
    expect(journal.tombstones.map((t: any) => t.sourceId)).toEqual([secretMessage.messageId]);
    expect(journal.ownerRef).toBe(backup.restoreManifest.ownerRef);
    // The sweep keeps a copy of the journal beside the backups, outside the database.
    const app = await testApp();
    await runScheduledBackups(app, Date.now());
    const stored = await app.env.EXPORT_BUCKET.get(`backups/${owner.userId}/tombstones.json`);
    expect(((await stored!.json()) as any).tombstones).toHaveLength(1);
  });

  it("recovers quantities, wears, style versions, the conversation, media, pending turns, tombstones and effects into an empty owner, and sends nothing again", async () => {
    target = await provisionOwner();
    const imported = await target.api.request("POST", "/v1/imports", { raw: zip, headers: { "Content-Type": "application/zip" } });
    const report = (await imported.json()) as any;
    expect(imported.status, JSON.stringify(report)).toBe(200);
    expect(report).toMatchObject({ state: "completed", checksumsVerified: true, idsPreserved: true, externalEffectsReplayed: 0 });

    const verified = await target.api.json("POST", "/v1/restore/verify", { restoreManifest: backup.restoreManifest, tombstones: journal });
    expect(verified.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect(verified.complete).toBe(true);
    expect(verified.tombstonesReplayed).toBe(1);
    expect(verified.checks.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(["garments and their identifiers", "quantities by bucket and movement count", "counted wears", "style versions with their content hashes", "media assets and renditions", "pending turns", "recall index rebuilt through the last restored message", "deletion tombstones", "no external effect left to send", "completed effects keep their recorded outcome"]),
    );

    // Seen through the product, not only through counts.
    const source = await owner.api.json("GET", "/v1/wardrobe");
    const restored = await target.api.json("GET", "/v1/wardrobe");
    expect(restored.items.map((i: any) => [i.garment.garmentId, i.balances])).toEqual(source.items.map((i: any) => [i.garment.garmentId, i.balances]));
    expect((await target.api.json("GET", `/v1/days/${today}`)).garments.map((g: any) => g.garmentId).sort()).toEqual((await owner.api.json("GET", `/v1/days/${today}`)).garments.map((g: any) => g.garmentId).sort());
    expect((await target.api.json("GET", "/v1/style")).document.contentSha256).toBe("e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198");
    const transcript = JSON.stringify(await target.api.json("GET", "/v1/conversation/messages"));
    expect(transcript).toContain("Which shirt for the board meeting?");
    // The source forgotten after the backup did not come back, in the transcript or in recall.
    expect(transcript).not.toContain(forgottenText);
    expect(JSON.stringify(await target.api.json("POST", "/v1/recall/search", { query: "private note" }))).not.toContain(forgottenText);
    expect(JSON.stringify(await target.api.json("POST", "/v1/recall/search", { query: "board meeting shirt" }))).toContain("board meeting");

    // Nothing external is queued for the restored owner.
    const app = await testApp();
    expect((await app.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND state IN ('pending', 'in_progress')").bind(target.userId).first<{ n: number }>())!.n).toBe(0);
    expect((await app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND acknowledged_at IS NULL AND topic LIKE 'effect%'").bind(target.userId).first<{ n: number }>().catch(() => ({ n: 0 })))!.n).toBe(0);
    // No sign-in, credential or grant came with it.
    expect((await target.api.json("GET", "/v1/connections")).connections).toEqual([]);
  });

  it("reports a restore as incomplete when the restored state differs from the manifest", async () => {
    const wardrobe = await target.api.json("GET", "/v1/wardrobe");
    const top = wardrobe.items.find((i: any) => i.garment.roles.includes("top") && i.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0)).garment;
    await target.api.command("care.mark_dirty", { items: [{ garmentId: top.garmentId, quantity: 1 }] });
    const verified = await target.api.json("POST", "/v1/restore/verify", { restoreManifest: backup.restoreManifest });
    expect(verified.complete).toBe(false);
    expect(verified.checks.filter((c: any) => !c.ok).map((c: any) => c.name)).toContain("quantities by bucket and movement count");
  });

  it("refuses a tombstone journal that belongs to another owner's backups", async () => {
    const response = await target.api.post("/v1/restore/verify", { restoreManifest: backup.restoreManifest, tombstones: { ...journal, ownerRef: "0".repeat(64) } });
    expect(response.status).toBe(400);
  });
});

describe("retention and deletion", () => {
  it("expires backups past their retention but always keeps the newest complete one", async () => {
    const app = await testApp();
    const second = await owner.api.json("POST", "/v1/backups", { clientRequestId: `manual-${crypto.randomUUID()}` });
    expect(second.state).toBe("completed");
    const firstKey = `backups/${owner.userId}/${backup.backupId}/package`;
    expect(await app.env.EXPORT_BUCKET.head(firstKey)).not.toBeNull();
    await sweepExpired(app, Date.now() + BACKUP_RETENTION_MS + 86_400_000);
    const list = (await owner.api.json("GET", "/v1/backups")).backups;
    expect(list.map((b: any) => [b.backupId, b.state])).toEqual([[second.backupId, "completed"], [backup.backupId, "expired"]]);
    expect(await app.env.EXPORT_BUCKET.head(firstKey)).toBeNull();
    expect(await app.env.EXPORT_BUCKET.head(`backups/${owner.userId}/${second.backupId}/package`)).not.toBeNull();
  });

  it("will not restore a backup of an account that was deleted afterwards", async () => {
    const leaving = await provisionOwner({ real: true });
    const taken = await leaving.api.json("POST", "/v1/backups", { clientRequestId: `manual-${crypto.randomUUID()}` });
    const kept = await download(leaving, taken.backupId); // a copy that left the service before the deletion
    const asked = await leaving.api.json("POST", "/v1/account/delete", {});
    expect((await leaving.api.json("POST", "/v1/account/delete", { confirmationToken: asked.confirmationToken })).state).toBe("erased");
    const app = await testApp();
    expect((await app.env.EXPORT_BUCKET.list({ prefix: `backups/${leaving.userId}/` })).objects).toEqual([]);

    const someoneElse = await provisionOwner();
    const attempt = await someoneElse.api.request("POST", "/v1/imports", { raw: kept, headers: { "Content-Type": "application/zip" } });
    expect(attempt.status).toBe(403);
    expect(((await attempt.json()) as any).error.details.reason).toBe("owner_erased");
    expect((await someoneElse.api.json("GET", "/v1/wardrobe")).total).toBe(0);
  });
});
