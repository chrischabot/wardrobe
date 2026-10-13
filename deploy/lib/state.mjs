/**
 * Local deployment state (git-ignored, mode 0600): the application secrets this tooling generated for
 * the development Worker, the automation door's signing key, the operations token and one-time codes.
 * None of it is a Cloudflare management credential, and nothing here is ever written to evidence.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { STATE_FILE } from "./config.mjs";

export function readState() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

export function writeState(state) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function updateState(patch) {
  const next = { ...(readState() ?? {}), ...patch };
  writeState(next);
  return next;
}

const secret = (bytes) => randomBytes(bytes).toString("base64");

/** Generate once; later runs reuse the same values so a redeploy never invalidates stored credentials. */
export async function ensureState() {
  let state = readState() ?? {};
  let changed = false;
  if (!state.secrets) {
    state.secrets = { CREDENTIAL_KEY: secret(32), STATE_SIGNING_KEY: secret(48), MEDIA_SIGNING_KEY: secret(48) };
    changed = true;
  }
  if (!state.opsToken) {
    state.opsToken = randomBytes(32).toString("base64url");
    changed = true;
  }
  if (!state.issuer) {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true, modulusLength: 2048 });
    const kid = `auto-${randomBytes(4).toString("hex")}`;
    state.issuer = {
      privateJwk: { ...(await exportJWK(privateKey)), kid, alg: "RS256" },
      publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
    };
    changed = true;
  }
  if (!state.identities) {
    // Subjects of the automation door. They are labelled test identities, not people.
    const tag = randomBytes(5).toString("hex");
    state.identities = {
      owner: { subject: `auto-owner-${tag}`, email: "owner@automation.garderobe-rebuild-dev.invalid" },
      synthetic: { subject: `auto-synthetic-${tag}`, email: "synthetic@automation.garderobe-rebuild-dev.invalid" },
      stranger: { subject: `auto-stranger-${tag}`, email: "stranger@automation.garderobe-rebuild-dev.invalid" },
    };
    changed = true;
  }
  if (changed) writeState(state);
  return state;
}
