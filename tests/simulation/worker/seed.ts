/**
 * Seed one local SIMULATION database (bundled and run by lib/local-target.mjs before the Worker starts):
 *
 *  - the primary owner: a copy of the owner's REAL profile and inventory, imported by the product's own
 *    importer through the command service (the same importer the journeys and the local run mode use).
 *    Nothing is added to it here: no garment, no wear, no lifted restriction;
 *  - a second owner, LABELLED SYNTHETIC and empty, used only to prove that owners are isolated;
 *  - one invitation for each, claimed by the simulator through the real `/auth/claim` route.
 *
 * The import is recorded at the simulated starting instant (worker/clock.ts reads SIM_NOW_MS), so the
 * ledger does not begin months before the timeline. Prints one JSON line.
 */
import "./clock.ts"; // first: the import is recorded at the simulated starting instant
import { readFileSync } from "node:fs";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { CommandService, createFoundationRegistry, createPrincipal, createUser, first } from "../../../packages/domain/src/index.ts";
import { importOwnerData } from "../../../packages/domain/src/import/index.ts";
import { codeHash, randomBytes, randomToken, toBase64Url } from "../../../apps/worker/src/crypto.ts";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const configPath = need("SIM_WRANGLER_CONFIG");
const persistPath = need("SIM_PERSIST_PATH");
const repoRoot = need("SIM_REPO_ROOT");
const stateSigningKey = need("STATE_SIGNING_KEY");

const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath, persist: { path: persistPath } });
try {
  const db = proxy.env.DB;
  const invite = async (userId: string): Promise<string> => {
    // The same record `createInvitation` writes (apps/worker/src/identity/service.ts); only the keyed hash is stored.
    const code = `GRDI-${randomToken(32)}`;
    const at = new Date();
    await db
      .prepare("INSERT INTO owner_invitations (invitation_id, user_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`inv_${toBase64Url(randomBytes(9))}`, userId, await codeHash(stateSigningKey, "invitation", code), at.toISOString(), new Date(at.getTime() + 14 * 86_400_000).toISOString())
      .run();
    return code;
  };

  const primaryId = (await createUser(db, { displayName: "Chris (simulation copy of the real profile and inventory)", isSynthetic: false })).userId;
  // The importer only issues foundation commands, so the foundation registry is sufficient here.
  const service = new CommandService({ db, registry: createFoundationRegistry() });
  const principal = createPrincipal({ userId: primaryId, actor: "system", channel: "import", scopes: ["read", "write", "admin"], authRef: "simulation-seed" });
  await importOwnerData(service, principal, {
    profileText: readFileSync(path.join(repoRoot, "requirements/chris-wardrobe-profile.md"), "utf8"),
    inventoryCsv: readFileSync(path.join(repoRoot, "requirements/wardrobe_inventory_clean.csv"), "utf8"),
  });
  const garments = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM garments WHERE user_id = ?", primaryId);

  const secondId = (await createUser(db, { displayName: "SYNTHETIC second owner (simulation isolation check)", isSynthetic: true })).userId;

  console.log(
    JSON.stringify({
      importedAt: new Date().toISOString(),
      primary: { userId: primaryId, garments: garments?.n ?? 0, invitationCode: await invite(primaryId) },
      second: { userId: secondId, invitationCode: await invite(secondId) },
    }),
  );
} finally {
  await proxy.dispose();
}
