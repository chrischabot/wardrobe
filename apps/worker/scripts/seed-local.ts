/**
 * Seed the local D1 database (bundled and run by `npm run dev -- setup`):
 * creates the internal owner, imports the REAL supplied profile and inventory through the command
 * service (the same importer the tests and the deployment use), and issues the one-time invitation the
 * local owner identity claims on first sign-in. Prints one JSON line with the result.
 *
 * It talks to the same local D1 file `wrangler dev` uses, through wrangler's platform proxy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { CommandService, createFoundationRegistry, createPrincipal, createUser, first } from "../../../packages/domain/src/index.ts";
import { importOwnerData } from "../../../packages/domain/src/import/index.ts";
import { codeHash, randomBytes, randomToken, toBase64Url } from "../src/crypto.ts";

const workerDir = process.cwd();
const repoRoot = path.resolve(workerDir, "../..");
const stateSigningKey = process.env.STATE_SIGNING_KEY;
if (!stateSigningKey) throw new Error("STATE_SIGNING_KEY is required (the dev script passes the local value)");

const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: path.join(workerDir, "wrangler.jsonc"), persist: true });
try {
  const db = proxy.env.DB;
  if (process.env.SEED_MODE === "empty-owner") {
    // An empty, clearly labelled owner with a one-time invitation: the target of a local restore drill.
    const emptyId = (await createUser(db, { displayName: "Restore drill target (empty test owner)", isSynthetic: true })).userId;
    const code = `GRDI-${randomToken(32)}`;
    const at = new Date();
    await db
      .prepare("INSERT INTO owner_invitations (invitation_id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`inv_${toBase64Url(randomBytes(9))}`, emptyId, await codeHash(stateSigningKey, "invitation", code), at.toISOString(), new Date(at.getTime() + 14 * 86_400_000).toISOString())
      .run();
    console.log(JSON.stringify({ userId: emptyId, invitationCode: code, empty: true }));
    await proxy.dispose();
    process.exit(0);
  }
  const existing = await first<{ user_id: string }>(db, "SELECT user_id FROM users WHERE is_synthetic = 0 ORDER BY created_at LIMIT 1");
  let userId = existing?.user_id ?? null;
  let imported: Record<string, unknown> | null = null;
  if (!userId) {
    userId = (await createUser(db, { displayName: "Chris", isSynthetic: false })).userId;
    // The importer only issues foundation commands, so the foundation registry is sufficient here.
    const service = new CommandService({ db, registry: createFoundationRegistry() });
    const principal = createPrincipal({ userId, actor: "system", channel: "import", scopes: ["read", "write", "admin"], authRef: "local-seed" });
    const result = await importOwnerData(service, principal, {
      profileText: readFileSync(path.join(repoRoot, "requirements/chris-wardrobe-profile.md"), "utf8"),
      inventoryCsv: readFileSync(path.join(repoRoot, "requirements/wardrobe_inventory_clean.csv"), "utf8"),
    });
    imported = JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}...` : v)));
  }
  const garments = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM garments WHERE user_id = ?", userId);
  const linked = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM auth_identities WHERE user_id = ? AND unlinked_at IS NULL", userId);
  let invitationCode: string | null = null;
  if ((linked?.n ?? 0) === 0) {
    // Same record `createInvitation` writes (apps/worker/src/identity/service.ts); only the keyed hash is stored.
    invitationCode = `GRDI-${randomToken(32)}`;
    const now = new Date();
    await db
      .prepare("INSERT INTO owner_invitations (invitation_id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`inv_${toBase64Url(randomBytes(9))}`, userId, await codeHash(stateSigningKey, "invitation", invitationCode), now.toISOString(), new Date(now.getTime() + 14 * 86_400_000).toISOString())
      .run();
  }
  console.log(JSON.stringify({ userId, garments: garments?.n ?? 0, alreadyClaimed: (linked?.n ?? 0) > 0, invitationCode, importedNow: imported !== null }));
} finally {
  await proxy.dispose();
}
