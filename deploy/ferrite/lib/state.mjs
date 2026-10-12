/**
 * Local state of the Ferrite tooling (git-ignored, deploy/ferrite/.state/): the bearer tokens of each deployed target
 * (`<account>/<app>`), one file per target, mode 0600 in a 0700 directory, written atomically. Token generation,
 * the secrets it sets and the deploy that delivers them run under one exclusive lock per target, so two runs never
 * generate different tokens for the same target; a teardown removes only its own target's file.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR, exitPolicy, killTree, localTokens, lockScope } from "./cli.mjs";
import { APP_NAME, GuardRefusal } from "./guard.mjs";

/** An account name: lower-case letters, digits and `_.-`, at most 64 characters, no whitespace or control characters. */
export const ACCOUNT = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** `<account>/wardrobe`: this project's one app (see lib/guard.mjs), in any account; compared part by part. */
export function isTarget(target) {
  if (typeof target !== "string" || /[\s\p{Cc}]/u.test(target)) return false;
  const parts = target.split("/");
  return parts.length === 2 && ACCOUNT.test(parts[0]) && parts[1] === APP_NAME;
}

export function assertTargetName(target) {
  if (!isTarget(target)) throw new Error(`not a target of this project: ${JSON.stringify(target)}`);
  return target;
}

/**
 * Bind a run's remote commands to ONE credential: the CLI reads its account from `$HOME/.config/ferrite/credentials.toml`
 * (and nowhere else), so the document is copied once, byte for byte, into a private 0700 directory under the state
 * directory, and every remote command of the run gets an environment whose HOME is that copy. A `ferrite login` or
 * account switch elsewhere during the run then changes the global document, never the one this run's writes use.
 * CARGO_HOME and RUSTUP_HOME keep pointing at the real toolchain. The copy is removed when `fn` settles, and at exit.
 */
export async function withCredentialSnapshot(fn, { realHome = process.env.HOME || os.homedir(), dir = STATE_DIR } = {}) {
  const source = path.join(realHome, ".config", "ferrite", "credentials.toml");
  if (!existsSync(source)) throw new GuardRefusal(`no Ferrite credential document at ${source}; nothing remote was changed`);
  secureDir(dir);
  const home = mkdtempSync(path.join(dir, "cred-"));
  chmodSync(home, 0o700);
  const remove = () => rmSync(home, { recursive: true, force: true });
  process.once("exit", remove);
  try {
    const config = path.join(home, ".config", "ferrite");
    mkdirSync(config, { recursive: true, mode: 0o700 });
    const copy = path.join(config, "credentials.toml");
    copyFileSync(source, copy);
    chmodSync(copy, 0o600);
    const env = { ...process.env, HOME: home, CARGO_HOME: process.env.CARGO_HOME ?? path.join(realHome, ".cargo"), RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(realHome, ".rustup") };
    return await fn(env);
  } finally {
    remove();
    process.removeListener("exit", remove);
  }
}

export function tokensFile(target, dir = STATE_DIR) {
  return path.join(dir, `${assertTargetName(target).replace("/", "__")}.tokens.json`);
}

/** A new bearer token: 32 random bytes, base64url (43 characters). */
export function newToken() {
  return randomBytes(32).toString("base64url");
}

/** A stored token must be base64url of at least 32 bytes: safe in an Authorization header, nothing else. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43,512}$/;

function valid(t) {
  return t && typeof t.owner === "string" && typeof t.assistant === "string" && TOKEN_SHAPE.test(t.owner) && TOKEN_SHAPE.test(t.assistant) && t.owner !== t.assistant;
}

function secureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The target's stored tokens, or null when there are none. A file that is not two distinct, long tokens is refused. */
export function readTokens(target, dir = STATE_DIR) {
  const file = tokensFile(target, dir);
  if (!existsSync(file)) return null;
  const t = JSON.parse(readFileSync(file, "utf8"));
  if (!valid(t)) throw new Error(`${path.basename(file)} does not hold two distinct base64url tokens of at least 43 characters; remove it and deploy again`);
  chmodSync(file, 0o600);
  return { owner: t.owner, assistant: t.assistant, createdAt: t.createdAt ?? null };
}

/** The target's tokens, created once (temporary file, then rename). Call it while holding the target's lock. */
export function ensureTokens(target, dir = STATE_DIR) {
  secureDir(dir);
  const existing = readTokens(target, dir);
  if (existing) return { tokens: existing, created: false };
  const tokens = { owner: newToken(), assistant: newToken(), createdAt: new Date().toISOString() };
  const file = tokensFile(target, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(tokens, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return { tokens, created: true };
}

export function removeTokens(target, dir = STATE_DIR) {
  rmSync(tokensFile(target, dir), { force: true });
}

/** Every stored token value, for redaction only. */
export function allStoredTokens(dir = STATE_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".tokens.json"))) {
    try {
      const t = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      for (const v of [t.owner, t.assistant]) if (typeof v === "string" && v) out.push(v);
    } catch {
      // an unreadable file holds nothing to redact
    }
  }
  return out;
}

/**
 * Every secret value the tooling may meet, for redaction only: the local dev tokens, every stored target's tokens
 * and the platform tokens in the environment. Deploy, verify and teardown all use this one collector.
 */
export function knownSecrets(dir = STATE_DIR) {
  return [...Object.values(localTokens()), ...allStoredTokens(dir), process.env.FERRITE_OWNER_TOKEN, process.env.FERRITE_PREVIEW_TOKEN].filter((v) => typeof v === "string" && v.length > 0);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Run `fn` holding the target's exclusive lock. The lock file is published atomically with its owner already in it:
 * the owner record (process ID and a random nonce) is written to a private temporary file, which is then hard-linked
 * to the lock path; link() fails if the lock exists, so no reader ever sees an empty or half-written lock. A lock
 * whose holder is gone is NOT taken over automatically (any takeover by rename or unlink can race a newer holder):
 * the call refuses and names the file and the dead process, for the operator to remove. Release removes the lock only
 * while it is still this run's own (same nonce).
 */
export async function withTargetLock(target, fn, dir = STATE_DIR) {
  secureDir(dir);
  const lock = `${tokensFile(target, dir)}.lock`;
  const nonce = randomBytes(16).toString("hex");
  const record = `${process.pid} ${nonce}`;
  const tmp = `${lock}.${process.pid}.${nonce}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, record);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holder = Number(readFileSync(lock, "utf8").split(" ")[0]);
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new Error(`another deploy or teardown of ${target} is running (process ${holder})`);
    throw new Error(`a stale lock for ${target} was left by process ${holder || "unknown"}, which is no longer running; make sure no deploy or teardown is running, then remove ${path.relative(process.cwd(), lock)} and run again`);
  } finally {
    rmSync(tmp, { force: true });
  }
  // Released by the `finally` below; a forced exit (second signal, process.exit) releases it from the exit hook,
  // which may only do synchronous work, and only while the lock is still this run's own.
  // Commands started inside `fn` are registered in this lock's own scope (lib/cli.mjs lockScope).
  const scope = { children: new Set(), keep: false };
  const release = () => {
    // A CLI command of THIS lock still running (a forced exit, or a caller that returned early) may still be changing
    // the target remotely: it is killed and the lock stays, for the operator to remove once `ferrite status` shows it
    // settled (the stale-lock refusal names the file). The same holds after one of its commands timed out or was
    // aborted, or after this process's own abort path set exitPolicy.keepLocks. Other targets are left alone.
    if (scope.children.size > 0) {
      scope.keep = true;
      for (const child of scope.children) killTree(child);
    }
    if (scope.keep || exitPolicy.keepLocks) return;
    try {
      if (readFileSync(lock, "utf8") === record) rmSync(lock, { force: true });
    } catch {
      // the lock is already gone: nothing of ours to release
    }
  };
  process.on("exit", release);
  try {
    return await lockScope.run(scope, fn);
  } finally {
    process.off("exit", release);
    release();
  }
}
