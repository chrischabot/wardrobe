/**
 * The development environment of the fresh Garderobe build: every name this tooling may create,
 * change or delete, and the guard that refuses anything else.
 *
 * The account also holds resources of an earlier application (`garderobe`, `garderobe-dev`,
 * `garderobe-dev-*`, `garderobe-*-dev`, `garderobe-images`). They are never touched: the fresh build has
 * its own prefix, and the guard only accepts names under that prefix.
 *
 * One exception is declared, not created: the AI Gateway `garderobe-dev` was created by the owner
 * (specification section 19) and the application only accepts `garderobe-dev` or `garderobe-prod`
 * (packages/assistant/src/inference/gateway.ts). This tooling reads it and never writes to it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEPLOY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(DEPLOY_DIR, "..");
export const STATE_FILE = path.join(DEPLOY_DIR, ".wrangler", "state", "dev.json");
/** Evidence is written beside the tooling; tests point it elsewhere. */
export const EVIDENCE_DIR = process.env.GARDEROBE_EVIDENCE_DIR ?? path.join(DEPLOY_DIR, "evidence");
export const GENERATED_DIR = path.join(DEPLOY_DIR, "wrangler");

export const PREFIX = "garderobe-rebuild-dev";
export const ENVIRONMENT = "dev";
export const ZONE = "chabot.dev";
/** Owner-created gateway (declared, read-only for this tooling). */
export const GATEWAY_ID = "garderobe-dev";
export const COMPATIBILITY_DATE = "2026-08-15";

const DEV_NAME = /^garderobe-rebuild-dev(-[a-z0-9]+)*$/;
/** Names that must never be a target even if a future edit loosened the pattern above. */
const FORBIDDEN = /(^|-)(prod|production|live)(-|$)/;

export class GuardError extends Error {
  constructor(message) {
    super(`refused: ${message}`);
    this.name = "GuardError";
  }
}

/** Throws unless `name` is one of this build's development resource names. */
export function assertDevName(name, kind = "resource") {
  if (typeof name !== "string" || !DEV_NAME.test(name) || FORBIDDEN.test(name)) {
    throw new GuardError(`${kind} '${name}' is not a development resource of this build (expected ${PREFIX} or ${PREFIX}-*)`);
  }
  return name;
}

/** Throws unless `host` is a development hostname of this build in the configured zone or on workers.dev. */
export function assertDevHost(host, workersSubdomain = null) {
  const suffixes = [`.${ZONE}`, ...(workersSubdomain ? [`.${workersSubdomain}.workers.dev`] : [])];
  const suffix = suffixes.find((s) => typeof host === "string" && host.endsWith(s));
  if (!suffix) throw new GuardError(`hostname '${host}' is outside ${suffixes.join(" and ")}`);
  assertDevName(host.slice(0, -suffix.length), "hostname");
  return host;
}

/** The per-owner AI Search instances the application itself names (packages/assistant/src/recall/ai-search.ts). */
export function assertDevSearchInstance(name) {
  if (!/^garderobe-dev-usr-[a-z0-9-]+$/.test(name)) throw new GuardError(`AI Search instance '${name}' is not a per-owner development instance`);
  return name;
}

/** The command line may only ever name the development environment. */
export function assertDevEnvironment(argv, env = process.env) {
  const index = argv.findIndex((a) => a === "--env" || a === "-e" || a.startsWith("--env="));
  if (index >= 0) {
    const value = argv[index].includes("=") ? argv[index].split("=")[1] : argv[index + 1];
    if (value !== ENVIRONMENT) throw new GuardError(`environment '${value}' is not '${ENVIRONMENT}'; this tooling deploys development only`);
  }
  for (const key of ["GARDEROBE_ENV", "ENVIRONMENT"]) {
    if (env[key] && env[key] !== ENVIRONMENT) throw new GuardError(`${key}=${env[key]} is not '${ENVIRONMENT}'; this tooling deploys development only`);
  }
}

export const NAMES = Object.freeze({
  worker: PREFIX,
  autoWorker: `${PREFIX}-auto`,
  opsWorker: `${PREFIX}-ops`,
  d1: PREFIX,
  kv: `${PREFIX}-oauth`,
  mediaBucket: `${PREFIX}-media`,
  exportBucket: `${PREFIX}-exports`,
  mediaQueue: `${PREFIX}-media`,
  mediaDlq: `${PREFIX}-media-dlq`,
  searchNamespace: PREFIX,
  workflow: `${PREFIX}-probe`,
  accessApp: `${PREFIX} (app, web board, MCP consent)`,
  accessCallbackApp: `${PREFIX} (connection callback, one-time state)`,
  /** Audience of the automation door's own assertions (not a Cloudflare Access audience). */
  autoAudience: `${PREFIX}-auto`,
});

export const HOSTS = Object.freeze({
  app: `${PREFIX}.${ZONE}`,
  mcp: `${PREFIX}-mcp.${ZONE}`,
  autoApp: `${PREFIX}-auto.${ZONE}`,
  autoMcp: `${PREFIX}-auto-mcp.${ZONE}`,
  ops: `${PREFIX}-ops.${ZONE}`,
});

/**
 * Paths of the app hostname that are not behind Access because they authenticate themselves: the
 * provider callback (one-time state) and signed image delivery (the token in the path). Everything
 * else on the app hostname requires an Access session (specification section 15).
 */
export const ACCESS_BYPASS_PATHS = Object.freeze(["/connections/callback", "/v1/media/signed/*"]);

/** Environment variables the tooling needs. Names only; values are never printed or stored. */
export const MANAGEMENT_ENV = Object.freeze(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);

/** Migrations this deployment must have applied (checked against the migrations directory and the database). */
export const MIGRATIONS_DIR = path.join(REPO_ROOT, "migrations");

/** Media queue consumer settings of the deployed Worker (retry, then dead-letter). */
export const QUEUE_CONSUMER = Object.freeze({ max_batch_size: 5, max_batch_timeout: 2, max_retries: 3 });

/** Everything above, checked once at import: a bad edit of this file fails before any call is made. */
for (const [key, value] of Object.entries(NAMES)) {
  if (key === "accessApp" || key === "accessCallbackApp") {
    if (!value.startsWith(`${PREFIX} `)) throw new GuardError(`Access application name '${value}' must start with ${PREFIX}`);
  } else assertDevName(value, key);
}
for (const host of Object.values(HOSTS)) assertDevHost(host);
