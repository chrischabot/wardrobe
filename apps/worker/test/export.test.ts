import { SELF } from "cloudflare:test";
import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptPackage, isEncryptedPackage, sha256Hex } from "../src/crypto.ts";
import { APP_ORIGIN, connectMcp, enableFakeModel, provisionOwner, publishBoard, testApp, uploadImage, type TestOwner } from "../src/testing/index.ts";

/*
 * Portable export and import through the real Worker, starting from the REAL owner fixture (supplied
 * profile and inventory) with activity on every surface. Stand-ins: test-signed Access assertions, the
 * labelled FAKE MODEL for one conversation reply, and the Google fixture for one connection.
 */
let owner: TestOwner;
let job: any;
let zip: Uint8Array;
let files: Record<string, Uint8Array>;
let secrets: string[];
const decoder = new TextDecoder();
const text = (path: string) => decoder.decode(files[path]!);
const jsonFile = (path: string) => JSON.parse(text(path));
const today = new Date().toISOString().slice(0, 10);
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string; details: Record<string, any> } }).error;

async function waitForExport(target: TestOwner, exportId: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const current = await target.api.json("GET", `/v1/exports/${exportId}`);
    if (!["queued", "running"].includes(current.state)) return current;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("export did not finish");
}

async function download(target: TestOwner, exportId: string): Promise<{ response: Response; bytes: Uint8Array; ticket: any }> {
  const ticket = await target.api.json("POST", `/v1/exports/${exportId}/ticket`, {});
  // The download needs no session: only the short-lived ticket.
  const response = await SELF.fetch(`${APP_ORIGIN}${ticket.url}`);
  return { response, bytes: new Uint8Array(await response.clone().arrayBuffer()), ticket };
}

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  const model = await enableFakeModel(owner);
  const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
  const clean = (role: string) => wardrobe.items.find((i: any) => i.garment.acquisition === "owned" && i.garment.roles.includes(role) && i.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0)).garment;
  const top = clean("top");
  // Activity on each surface, so every component of the export has something real in it.
  await owner.api.command("wear.record", { wearingDate: today, garmentIds: [top.garmentId, clean("bottom").garmentId] });
  const dirty = await (await owner.api.command("care.mark_dirty", { items: [{ garmentId: clean("socks").garmentId, quantity: 1 }] })).json() as any;
  await owner.api.command("command.undo", { commandId: dirty.commandId });
  await owner.api.command("style.add_direction", { text: "No suede when rain is forecast", source: { kind: "owner_statement" } });
  await publishBoard(owner, { date: today });
  await uploadImage(owner, { garmentId: top.garmentId });
  model.script({ text: "The oxford cloth shirt suits the meeting." });
  const turn = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text: "Which shirt for the board meeting?" });
  for (let i = 0; i < 80; i++) {
    if ((await owner.api.json("GET", `/v1/runs/${turn.runId}`)).state === "completed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await owner.api.command("feedback.record", { text: "too warm on the train", kind: "too_warm", garmentIds: [top.garmentId], source: { kind: "owner_statement" } });
  // Credentials that must never appear in a package.
  const connectionSecret = "tvly-EXPORT-TEST-SECRET-9f8e7d6c5b4a";
  await owner.api.json("POST", "/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, kind: "tavily", name: "Tavily search", auth: { type: "secret", secret: connectionSecret } });
  const assistant = await connectMcp(owner, { write: true, clientName: "Assistant in export" });
  const tokens = assistant.oauth.snapshot();
  const app = await testApp();
  const verifier = await app.db.prepare("SELECT verifier, salt FROM recovery_credentials WHERE user_id = ? AND status = 'active'").bind(owner.userId).first<{ verifier: string; salt: string }>();
  secrets = [connectionSecret, tokens.accessToken, tokens.refreshToken!, owner.recoveryKit.recoveryCode, owner.recoveryKit.recoveryCode.split("-").slice(2).join(""), verifier!.verifier, verifier!.salt, owner.identity.subject, app.env.CREDENTIAL_KEY, app.env.STATE_SIGNING_KEY];

  const requested = await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}` });
  job = await waitForExport(owner, requested.exportId);
  const got = await download(owner, job.exportId);
  zip = got.bytes;
  files = unzipSync(zip);
});

describe("export my wardrobe", () => {
  it("finishes as a durable run and reports every component complete", async () => {
    expect(job.state).toBe("completed");
    expect(job.complete).toBe(true);
    expect(job.encrypted).toBe(false);
    expect(job.formatVersion).toBe("garderobe-export/1");
    expect(job.components.map((c: any) => `${c.name}:${c.state}`).sort()).toEqual(
      ["account", "assistant", "availability", "conversation", "daily", "inventory", "laundry", "media", "provenance", "quantities", "receipts", "settings", "style", "wear"].map((n) => `${n}:complete`).sort(),
    );
    expect(job.snapshot.wardrobeRevision).toBeGreaterThan(0);
    const run = await owner.api.json("GET", `/v1/runs/${job.runId}`);
    expect(run).toMatchObject({ kind: "export", state: "completed" });
    expect(run.result.exportId).toBe(job.exportId);
    expect(job.sha256).toBe(await sha256Hex(zip));
    expect(job.byteLength).toBe(zip.length);
  });

  it("is one package with a versioned manifest, watermarks and checksums that verify", async () => {
    const manifest = jsonFile("manifest.json");
    expect(manifest.format).toBe("garderobe-export/1");
    expect(manifest.complete).toBe(true);
    expect(manifest.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.snapshot.coherent).toBe(true);
    expect(manifest.watermarks.ledger.wardrobeRevision).toBe(job.snapshot.wardrobeRevision);
    expect(manifest.files.length).toBeGreaterThan(15);
    for (const entry of manifest.files) {
      expect(files[entry.path], entry.path).toBeTruthy();
      expect(await sha256Hex(files[entry.path]!), entry.path).toBe(entry.sha256);
      expect(files[entry.path]!.length).toBe(entry.bytes);
    }
    // Nothing in the package is unlisted.
    const listed = new Set(manifest.files.map((f: any) => f.path));
    for (const path of Object.keys(files)) if (path !== "manifest.json" && path !== "checksums.sha256") expect(listed.has(path), path).toBe(true);
    const lines = text("checksums.sha256").trim().split("\n");
    expect(lines.length).toBe(manifest.files.length + 1);
    for (const line of lines) {
      const [sum, path] = line.split("  ");
      expect(await sha256Hex(files[path!]!), path).toBe(sum);
    }
  });

  it("contains the complete inventory, wears, quantity movements, receipts and the profile word for word", async () => {
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe?includeDisposed=true");
    const garments = jsonFile("records/inventory.json").tables.garments.rows;
    expect(garments.length).toBeGreaterThanOrEqual(wardrobe.total);
    for (const item of wardrobe.items) expect(garments.some((g: any) => g.garment_id === item.garment.garmentId), item.garment.name).toBe(true);
    expect(jsonFile("records/inventory.json").tables.garment_aliases.rows.length).toBeGreaterThan(0);
    expect(jsonFile("records/wear.json").tables.daily_wears.rows.filter((w: any) => w.wearing_date === today)).toHaveLength(2);
    expect(jsonFile("records/quantities.json").tables.stock_events.rows.length).toBeGreaterThan(wardrobe.total / 2);
    const commands = jsonFile("records/receipts.json").tables.commands.rows;
    expect(commands.some((c: any) => c.type === "command.undo")).toBe(true);
    expect(commands.some((c: any) => c.type === "wear.record")).toBe(true);
    const style = jsonFile("records/style.json").tables;
    const profile = style.style_documents.rows.find((d: any) => d.status === "active");
    expect(profile.content_sha256).toBe("e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198");
    expect(await sha256Hex(profile.content)).toBe(profile.content_sha256);
    expect(style.standing_directions.rows.some((d: any) => d.text === "No suede when rain is forecast")).toBe(true);
    expect(jsonFile("records/provenance.json").tables.import_refs.rows.length).toBeGreaterThan(0);
  });

  it("contains boards, the original conversation with dates, feedback, and media with provenance", () => {
    const daily = jsonFile("records/daily.json");
    expect(daily.tables.boards.length).toBeGreaterThan(0);
    expect(daily.tables.board_revisions.length).toBeGreaterThan(0);
    const conversation = JSON.stringify(jsonFile("records/conversation.json"));
    expect(conversation).toContain("Which shirt for the board meeting?");
    expect(conversation).toContain("The oxford cloth shirt suits the meeting.");
    expect(conversation).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(JSON.stringify(jsonFile("records/assistant.json"))).toContain("too warm on the train");
    const media = jsonFile("records/media.json");
    expect(media.assets.length).toBeGreaterThan(0);
    expect(media.missing).toEqual([]);
    for (const asset of media.assets) {
      const path = media.files[asset.file];
      // A package names its files by package-relative paths, never by storage keys.
      expect(asset.file.startsWith("u/"), asset.file).toBe(false);
      expect(asset.file).not.toContain(owner.userId);
      expect(files[path], path).toBeTruthy();
      expect(files[path]!.length).toBe(asset.byteLength);
    }
    expect(Object.keys(files).some((p) => p.startsWith("media/") && p.endsWith(".png"))).toBe(true);
  });

  it("includes readable views and a README that explains the records", async () => {
    const readme = text("README.md");
    for (const phrase of ["How the records relate", "Units and dates", "Estimates that are not facts", "What is not in this package", "wearing date", "never that the piece is unworn"]) expect(readme).toContain(phrase);
    const inventory = text("views/inventory.csv").split("\r\n");
    expect(inventory[0]).toContain("garment_id,name,category");
    expect(inventory.length).toBeGreaterThan(50);
    expect(text("views/wear-history.csv")).toContain(today);
    expect(text("views/quantity-movements.csv").split("\r\n").length).toBeGreaterThan(10);
    expect(text("views/summary.md")).toContain("| Component | State | Records | Note |");
    expect(text("views/conversation.md")).toContain("Which shirt for the board meeting?");
    expect(await sha256Hex(text("views/profile.md"))).toBe("e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198");
  });

  it("contains no credential, session, token hash, recovery verifier or sign-in identity", async () => {
    const everything = Object.values(files).map((bytes) => decoder.decode(bytes)).join("\n");
    for (const secret of secrets) expect(everything.includes(secret), `leaked: ${secret.slice(0, 8)}…`).toBe(false);
    for (const forbidden of ["recovery_credentials", "auth_identities", "connection_credentials", "connection_oauth_states", "owner_invitations", "identity_link_tickets", "auth_session_floors", "export_tickets"]) {
      expect(Object.keys(files).some((p) => p.includes(forbidden))).toBe(false);
      for (const [path, bytes] of Object.entries(files)) if (path.startsWith("records/")) expect(Object.keys(JSON.parse(decoder.decode(bytes)).tables ?? {}), path).not.toContain(forbidden);
    }
    expect(everything).not.toMatch(/"(access_token|refresh_token|token_hash|verifier|ciphertext|client_secret)"/);
    // The connection and the assistant are listed for information, without any credential.
    const account = jsonFile("records/account.json");
    expect(account.connections[0].name).toBe("Tavily search");
    expect(account.connectedAssistants[0].client_name).toBe("Assistant in export");
    expect(jsonFile("manifest.json").excluded.join(" ")).toContain("recovery credential verifiers");
  });

  it("downloads only with a short-lived, single-use ticket for that export", async () => {
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/exports/${job.exportId}/download`)).status).toBe(400);
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/exports/${job.exportId}/download?ticket=guess`)).status).toBe(401);
    const { response, ticket } = await download(owner, job.exportId);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(Date.parse(ticket.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    // Used once.
    expect((await SELF.fetch(`${APP_ORIGIN}${ticket.url}`)).status).toBe(410);
    // Expired.
    const late = await owner.api.json("POST", `/v1/exports/${job.exportId}/ticket`, {});
    const app = await testApp();
    await app.db.prepare("UPDATE export_tickets SET expires_at = ? WHERE used_at IS NULL").bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await SELF.fetch(`${APP_ORIGIN}${late.url}`)).status).toBe(410);
    // Another owner cannot see the job, get a ticket, or use a ticket on another export ID.
    const stranger = await provisionOwner();
    expect((await stranger.api.get(`/v1/exports/${job.exportId}`)).status).toBe(404);
    expect((await stranger.api.post(`/v1/exports/${job.exportId}/ticket`, {})).status).toBe(404);
    expect((await stranger.api.json("GET", "/v1/exports")).exports).toEqual([]);
  });

  it("returns the same job for a repeated request and never reports an interrupted or partial export as complete", async () => {
    const key = `export-${crypto.randomUUID()}`;
    const first = await owner.api.json("POST", "/v1/exports", { clientRequestId: key });
    const again = await owner.api.json("POST", "/v1/exports", { clientRequestId: key });
    expect(again.exportId).toBe(first.exportId);
    expect(again.runId).toBe(first.runId);

    // An interrupted job (its runner died mid-way) is resumed on the next read and finishes.
    const app = await testApp();
    await app.db.prepare("UPDATE export_jobs SET state = 'running', object_key = NULL, sha256 = NULL, finished_at = NULL, progress_json = json_set(progress_json, '$.leaseUntil', '2000-01-01T00:00:00Z') WHERE export_id = ?").bind(first.exportId).run();
    expect((await owner.api.post(`/v1/exports/${first.exportId}/ticket`, {})).status).toBe(409);
    const resumed = await waitForExport(owner, first.exportId);
    expect(resumed.state).toBe("completed");
    expect(resumed.complete).toBe(true);

    // A package missing a stored image is marked incomplete, in the job and in its own manifest.
    const media = jsonFile("records/media.json");
    await app.env.MEDIA_BUCKET!.delete(`u/${owner.userId}/${media.assets[0].file}`);
    const partial = await waitForExport(owner, (await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}` })).exportId);
    expect(partial.state).toBe("completed_incomplete");
    expect(partial.complete).toBe(false);
    expect(partial.components.find((c: any) => c.name === "media")).toMatchObject({ state: "incomplete" });
    const partialFiles = unzipSync((await download(owner, partial.exportId)).bytes);
    const manifest = JSON.parse(decoder.decode(partialFiles["manifest.json"]!));
    expect(manifest.complete).toBe(false);
    expect(decoder.decode(partialFiles["README.md"]!)).toContain("THIS EXPORT IS INCOMPLETE");
  });
});

describe("encrypted export", () => {
  it("produces a package only the passphrase opens, and detects tampering", async () => {
    const passphrase = "correct horse battery staple 42";
    const requested = await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}`, passphrase });
    const done = await waitForExport(owner, requested.exportId);
    expect(done.encrypted).toBe(true);
    const { bytes, ticket } = await download(owner, done.exportId);
    expect(ticket.fileName).toMatch(/\.zip\.enc$/);
    expect(isEncryptedPackage(bytes)).toBe(true);
    expect(() => unzipSync(bytes)).toThrow();
    expect(decoder.decode(bytes)).not.toContain("garment_id");
    const plain = await decryptPackage(passphrase, bytes);
    expect(Object.keys(unzipSync(plain))).toContain("manifest.json");
    await expect(decryptPackage("the wrong passphrase 000", bytes)).rejects.toThrow();
    const tampered = bytes.slice();
    tampered[tampered.length - 20] = tampered[tampered.length - 20]! ^ 0xff;
    await expect(decryptPackage(passphrase, tampered)).rejects.toThrow();
    await expect(decryptPackage(passphrase, bytes.slice(0, bytes.length - 100))).rejects.toThrow();
    // The passphrase is not stored anywhere.
    const app = await testApp();
    const rows = JSON.stringify((await app.db.prepare("SELECT * FROM export_jobs WHERE export_id = ?").bind(done.exportId).all()).results) + JSON.stringify((await app.db.prepare("SELECT * FROM account_audit WHERE user_id = ?").bind(owner.userId).all()).results);
    expect(rows).not.toContain(passphrase);
    expect((await owner.api.post("/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}`, passphrase: "short" })).status).toBe(400);
  });
});

describe("importing into an empty account", () => {
  let target: TestOwner;
  let report: any;

  const post = (to: TestOwner, body: Uint8Array, headers: Record<string, string> = {}) => to.api.request("POST", "/v1/imports", { raw: body, headers: { "Content-Type": "application/zip", ...headers } });

  it("restores the same wardrobe with the same identifiers and replays no external effect", async () => {
    target = await provisionOwner();
    const app = await testApp();
    const response = await post(target, zip);
    report = await response.json();
    expect(response.status, JSON.stringify(report)).toBe(200);
    expect(report.state).toBe("completed");
    expect(report.checksumsVerified).toBe(true);
    expect(report.idsPreserved).toBe(true);
    expect(report.externalEffectsReplayed).toBe(0);

    const source = await owner.api.json("GET", "/v1/wardrobe?includeDisposed=true");
    const restored = await target.api.json("GET", "/v1/wardrobe?includeDisposed=true");
    expect(restored.total).toBe(source.total);
    expect(restored.items.map((i: any) => i.garment.garmentId).sort()).toEqual(source.items.map((i: any) => i.garment.garmentId).sort());
    const pick = source.items.find((i: any) => i.recordedWearCount > 0);
    const twin = restored.items.find((i: any) => i.garment.garmentId === pick.garment.garmentId);
    expect(twin.garment.name).toBe(pick.garment.name);
    expect(twin.balances).toEqual(pick.balances);
    expect(twin.recordedWearCount).toBe(pick.recordedWearCount);
    expect((await target.api.json("GET", `/v1/days/${today}`)).garments.map((g: any) => g.garmentId).sort()).toEqual((await owner.api.json("GET", `/v1/days/${today}`)).garments.map((g: any) => g.garmentId).sort());
    expect((await target.api.json("GET", "/v1/style")).document.contentSha256).toBe("e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198");
    // Receipts keep their command IDs; a board and the conversation came across too.
    const sourceReceipts = await owner.api.json("GET", `/v1/commands?entity=garment:${pick.garment.garmentId}`);
    const restoredReceipts = await target.api.json("GET", `/v1/commands?entity=garment:${pick.garment.garmentId}`);
    expect(restoredReceipts.receipts.map((r: any) => r.commandId).sort()).toEqual(sourceReceipts.receipts.map((r: any) => r.commandId).sort());
    expect((await target.api.json("GET", `/v1/today?date=${today}`)).board).not.toBeNull();
    expect(JSON.stringify(await target.api.json("GET", "/v1/conversation/messages"))).toContain("Which shirt for the board meeting?");
    // The photograph came with it and is served to the new owner.
    const mediaGarment = jsonFile("records/media.json").records.records.garmentMedia[0].garment_id as string;
    const restoredImage = await target.api.get(`/v1/items/${mediaGarment}/image`);
    expect(restoredImage.status).toBe(200);
    expect(await sha256Hex(await restoredImage.arrayBuffer())).toBe(await sha256Hex(await (await owner.api.get(`/v1/items/${mediaGarment}/image`)).arrayBuffer()));

    // No effect is left to dispatch for the imported owner, and nothing was queued for delivery.
    const pending = await app.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND state IN ('pending', 'in_progress')").bind(target.userId).first<{ n: number }>();
    expect(pending!.n).toBe(0);
    const outbox = await app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE user_id = ?").bind(target.userId).first<{ n: number }>();
    expect(outbox!.n).toBe(0);
    // The run and the job are readable afterwards.
    expect((await target.api.json("GET", `/v1/imports/${report.importId}`)).state).toBe("completed");
    expect((await target.api.json("GET", `/v1/runs/${report.runId}`)).state).toBe("completed");
  });

  it("plants no sign-in, session, recovery credential, connection or assistant grant", async () => {
    const app = await testApp();
    const count = async (sql: string) => (await app.db.prepare(sql).bind(target.userId).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) AS n FROM auth_identities WHERE user_id = ?")).toBe(1); // the target's own
    expect(await count("SELECT COUNT(*) AS n FROM recovery_credentials WHERE user_id = ?")).toBe(1); // the target's own kit
    expect(await count("SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM connection_profiles WHERE user_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM connection_credentials WHERE user_id = ?")).toBe(0);
    expect((await target.api.json("GET", "/v1/assistants")).grants).toEqual([]);
    // The source owner's sign-in gained nothing on the target, and the source is unchanged.
    expect((await target.api.json("GET", "/v1/me")).userId).toBe(target.userId);
    expect((await owner.api.json("GET", "/v1/me")).userId).toBe(owner.userId);
    expect(report.components.find((c: any) => c.name === "account").imported).toBe(0);
  });

  it("refuses a second import, a tampered package and a package that tries to carry credentials or another owner", async () => {
    const again = await post(target, zip);
    expect(again.status).toBe(409);

    const { zipSync } = await import("fflate");
    const rebuild = async (mutate: (entries: Record<string, Uint8Array>, manifest: any) => void | Promise<void>, fixChecksums: boolean) => {
      const entries: Record<string, Uint8Array> = { ...files };
      const manifest = JSON.parse(decoder.decode(entries["manifest.json"]!));
      await mutate(entries, manifest);
      if (fixChecksums) {
        for (const entry of manifest.files) {
          entry.bytes = entries[entry.path]!.length;
          entry.sha256 = await sha256Hex(entries[entry.path]!);
        }
        entries["checksums.sha256"] = new TextEncoder().encode(manifest.files.map((f: any) => `${f.sha256}  ${f.path}`).join("\n") + `\n${await sha256Hex(new TextEncoder().encode(JSON.stringify(manifest, null, 1)))}  manifest.json\n`);
      }
      entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 1));
      return zipSync(entries);
    };
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

    // 1. A file changed after export: the checksum check refuses the whole package.
    const tamperedOwner = await provisionOwner();
    const tampered = await rebuild((entries) => {
      const inventory = JSON.parse(decoder.decode(entries["records/inventory.json"]!));
      inventory.tables.garments.rows[0].name = "A garment that was never owned";
      entries["records/inventory.json"] = encode(inventory);
    }, false);
    const refused = await post(tamperedOwner, tampered);
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).details.rejected).toBe(true);
    expect((await tamperedOwner.api.json("GET", "/v1/wardrobe")).total).toBe(0);

    // 2. A crafted package with valid checksums that smuggles credentials, identities, grants and another owner's ID.
    const victim = await provisionOwner();
    const attacker = await provisionOwner();
    const app = await testApp();
    const crafted = await rebuild((entries, manifest) => {
      const inventory = JSON.parse(decoder.decode(entries["records/inventory.json"]!));
      // (a) rows that claim to belong to the victim
      inventory.tables.garments.columns.unshift("user_id");
      for (const row of inventory.tables.garments.rows) row.user_id = victim.userId;
      // (b) tables that are never importable
      inventory.tables.auth_identities = { columns: ["issuer", "subject", "linked_at"], rows: [{ issuer: "https://garderobe-test.cloudflareaccess.com", subject: "attacker-planted-subject", linked_at: new Date().toISOString() }] };
      inventory.tables.mcp_grants = { columns: ["grant_id", "client_id", "client_name", "redirect_host", "scopes_json", "status", "version", "granted_at"], rows: [{ grant_id: "mcg_planted", client_id: "x", client_name: "Planted", redirect_host: "evil.example", scopes_json: '["wardrobe.write"]', status: "active", version: 1, granted_at: new Date().toISOString() }] };
      inventory.tables.recovery_credentials = { columns: ["kit_id", "verifier", "salt", "algorithm", "status", "created_at"], rows: [{ kit_id: "RKPLANTED00", verifier: "x", salt: "y", algorithm: "pbkdf2-sha256-100000", status: "active", created_at: new Date().toISOString() }] };
      inventory.tables.users = { columns: ["user_id", "display_name", "status"], rows: [{ user_id: victim.userId, display_name: "Taken over", status: "active" }] };
      entries["records/inventory.json"] = encode(inventory);
      // (c) a pending external effect that must not be dispatched
      const receipts = JSON.parse(decoder.decode(entries["records/receipts.json"]!));
      const command = receipts.tables.commands.rows[0];
      receipts.tables.effects.rows.push({ ...Object.fromEntries(receipts.tables.effects.columns.map((c: string) => [c, null])), effect_id: "eff_planted", command_id: command.command_id, kind: "calendar.project_board", target_key: "planted", operation_key: "planted-op", desired_revision: 1, payload_json: "{}", state: "pending", attempts: 0, available_at: "2000-01-01T00:00:00Z", created_at: command.recorded_at, updated_at: command.recorded_at });
      entries["records/receipts.json"] = encode(receipts);
      // (d) an account file full of sessions
      entries["records/account.json"] = encode({ sessions: [{ token: "planted-session-token" }], connections: [{ connection_id: "con_planted", secret: "planted" }] });
      // (e) a file the manifest does not list is refused outright, so list everything else honestly
      void manifest;
    }, true);
    const response = await post(attacker, crafted);
    const body = (await response.json()) as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    // Everything landed on the importing owner only.
    expect((await attacker.api.json("GET", "/v1/wardrobe")).total).toBeGreaterThan(50);
    expect((await victim.api.json("GET", "/v1/wardrobe")).total).toBe(0);
    expect(((await victim.api.json("GET", "/v1/me")) as any).displayName).not.toBe("Taken over");
    // None of the forbidden tables was written.
    const n = async (sql: string, ...params: unknown[]) => (await app.db.prepare(sql).bind(...params).first<{ n: number }>())!.n;
    expect(await n("SELECT COUNT(*) AS n FROM auth_identities WHERE subject = 'attacker-planted-subject'")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM mcp_grants WHERE grant_id = 'mcg_planted'")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM recovery_credentials WHERE kit_id = 'RKPLANTED00'")).toBe(0);
    expect(await n("SELECT COUNT(*) AS n FROM connection_profiles WHERE connection_id = 'con_planted'")).toBe(0);
    // The planted pending effect is history, not work to do.
    const effect = await app.db.prepare("SELECT state FROM effects WHERE user_id = ? AND effect_id = 'eff_planted'").bind(attacker.userId).first<{ state: string }>();
    expect(effect!.state).toBe("cancelled");
    expect(await n("SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND state IN ('pending', 'in_progress')", attacker.userId)).toBe(0);

    // 3. A file the manifest does not list, and a path that escapes the package, are refused.
    const extra = await provisionOwner();
    const { zipSync: zipNow } = await import("fflate");
    expect((await post(extra, zipNow({ ...files, "records/extra.json": encode({ tables: {} }) }))).status).toBe(400);
    expect((await post(extra, zipNow({ ...files, "../escape.json": encode({}) }))).status).toBe(400);
    expect((await post(extra, new TextEncoder().encode("this is not a zip file at all"))).status).toBe(400);
    expect((await extra.api.json("GET", "/v1/wardrobe")).total).toBe(0);
  });

  it("imports an encrypted package only with its passphrase", async () => {
    const passphrase = "another long passphrase for import";
    const done = await waitForExport(owner, (await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}`, passphrase })).exportId);
    const { bytes } = await download(owner, done.exportId);
    const fresh = await provisionOwner();
    const octet = { "Content-Type": "application/octet-stream" };
    expect((await fresh.api.request("POST", "/v1/imports", { raw: bytes, headers: octet })).status).toBe(400);
    expect((await fresh.api.request("POST", "/v1/imports", { raw: bytes, headers: { ...octet, "X-Garderobe-Passphrase": "not the passphrase at all" } })).status).toBe(400);
    expect((await fresh.api.json("GET", "/v1/wardrobe")).total).toBe(0);
    const ok = await fresh.api.request("POST", "/v1/imports", { raw: bytes, headers: { ...octet, "X-Garderobe-Passphrase": passphrase } });
    const body = (await ok.json()) as any;
    expect(ok.status, JSON.stringify(body)).toBe(200);
    expect((await fresh.api.json("GET", "/v1/wardrobe")).total).toBeGreaterThan(50);
    expect((await fresh.api.request("POST", "/v1/imports", { raw: bytes, headers: { "Content-Type": "text/plain" } })).status).toBe(415);
  });
});
