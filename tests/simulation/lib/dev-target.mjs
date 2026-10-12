/**
 * The DEVELOPMENT-DEPLOYMENT mode of the simulation: the same simulation Worker (worker/entry.ts) deployed
 * under its own name to development resources only, driven over HTTPS through its authenticated doors.
 *
 * Why a separate simulation Worker and not the product deployment: a four-week timeline cannot elapse in
 * real time inside a run, so the simulator needs the settable clock and the scripted weather and calendar
 * stand-ins, and those must never be part of the product Worker. The simulation Worker serves in this mode
 * only with ENVIRONMENT `development`, SIM_DEPLOYMENT `development-simulation` and a control token of at
 * least 32 characters (worker/entry.ts `servingMode`), and every door needs that token.
 *
 * Nothing here deploys anything or reads a Cloudflare management credential. `devSimulationWranglerConfig`
 * produces the Wrangler configuration the deployment owner applies once hosting is decided; the secrets it
 * names are set with `wrangler secret put`, never written to a file. `resolveTargetDescription` turns a
 * target file into the description the runner takes, reading the control token from the environment.
 *
 * Known limit, checked rather than assumed: the clock and the scripted conditions live in the Worker's
 * isolate. A deployment may serve requests from more than one isolate; the simulator then sees a changed
 * boot ID and voids the run, and a Durable Object restarted in a new isolate makes the clock door answer
 * 409. Such a run reports itself void; it never passes on a half-moved clock.
 */

export const DEV_MODE = "development-simulation";
const NAME_PREFIX = "garderobe-sim-dev";

/** Secrets the development simulation Worker needs; each is set with `wrangler secret put <NAME>`. */
export const DEV_SECRETS = ["SIM_CONTROL_TOKEN", "CREDENTIAL_KEY", "STATE_SIGNING_KEY", "MEDIA_SIGNING_KEY", "GOOGLE_OAUTH_CLIENT_SECRET"];

function httpsOrigin(value, what) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${what} is not a URL: ${String(value).slice(0, 120)}`);
  }
  if (url.protocol !== "https:") throw new Error(`${what} must be https for a development deployment, got ${url.protocol}`);
  return url.origin;
}

const simOnly = (value, what) => {
  if (!/sim/i.test(String(value ?? ""))) throw new Error(`${what} '${value}' must be a simulation-only resource (its name must contain "sim"); the simulation never touches the product's resources`);
  return value;
};

/**
 * The Wrangler configuration of the development simulation Worker. `resources` names resources created for
 * the simulation alone (each name must contain "sim"): `{ d1: { name, id }, kv: { id }, media: name,
 * exports: name, queue: name }`. Origins are the Worker's own HTTPS hostnames behind Cloudflare Access.
 */
export function devSimulationWranglerConfig({ name, main, migrationsDir, appOrigin, mcpOrigin, accessTeamDomain, accessAud, aiGatewayId = "garderobe-dev", resources }) {
  if (!String(name ?? "").startsWith(NAME_PREFIX)) throw new Error(`the development simulation Worker's name must start with '${NAME_PREFIX}', got '${name}'`);
  if (!resources?.d1?.id || !resources?.kv?.id || !resources?.media || !resources?.exports || !resources?.queue) throw new Error("resources must name the simulation's own D1 database, KV namespace, two R2 buckets and queue");
  simOnly(resources.d1.name, "the D1 database");
  simOnly(resources.media, "the media bucket");
  simOnly(resources.exports, "the export bucket");
  simOnly(resources.queue, "the queue");
  return {
    name,
    main,
    compatibility_date: "2026-08-15",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    workers_dev: false,
    d1_databases: [{ binding: "DB", database_name: resources.d1.name, database_id: resources.d1.id, migrations_dir: migrationsDir }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: resources.kv.id }],
    r2_buckets: [
      { binding: "MEDIA_BUCKET", bucket_name: resources.media },
      { binding: "EXPORT_BUCKET", bucket_name: resources.exports },
    ],
    queues: { producers: [{ binding: "MEDIA_QUEUE", queue: resources.queue }], consumers: [{ queue: resources.queue, max_batch_size: 5, max_batch_timeout: 2, max_retries: 3 }] },
    durable_objects: { bindings: [{ name: "ASSISTANT", class_name: "GarderobeAssistant" }, { name: "SIM_REGISTRY", class_name: "SimulationRegistry" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["GarderobeAssistant", "SimulationRegistry"] }],
    vars: {
      ENVIRONMENT: "development",
      SIM_DEPLOYMENT: DEV_MODE,
      APP_ORIGIN: httpsOrigin(appOrigin, "appOrigin"),
      MCP_ORIGIN: httpsOrigin(mcpOrigin, "mcpOrigin"),
      ACCESS_TEAM_DOMAIN: httpsOrigin(accessTeamDomain, "accessTeamDomain"),
      ACCESS_AUD: String(accessAud),
      AI_GATEWAY_ID: aiGatewayId,
      GOOGLE_OAUTH_CLIENT_ID: "simulation-google-client-id",
      GOOGLE_OAUTH_AUTHORIZE_URL: "https://google.simulation.invalid/authorize",
      GOOGLE_OAUTH_TOKEN_URL: "https://google.simulation.invalid/token",
      GOOGLE_OAUTH_REVOKE_URL: "https://google.simulation.invalid/revoke",
      GOOGLE_API_BASE_URL: "https://google.simulation.invalid",
    },
  };
}

/**
 * The runner's description of a target file. A `development-simulation-worker` target must use HTTPS
 * origins, sign the owner in with headers from the environment (Cloudflare Access service credentials, never
 * a management credential), and read its door token from the environment variable named in
 * `doors.controlTokenFromEnvironment`. Local descriptions pass through unchanged.
 */
export function resolveTargetDescription(description, env = process.env) {
  if (description.kind !== "development-simulation-worker") return description;
  const doors = description.doors ?? {};
  if (doors.kind !== "simulation-worker") throw new Error("a development simulation target must describe its simulation doors (doors.kind 'simulation-worker')");
  if (doors.controlToken) throw new Error("a development simulation target must not carry its control token in the file; name the environment variable in doors.controlTokenFromEnvironment");
  const variable = doors.controlTokenFromEnvironment;
  const token = variable ? env[variable] : undefined;
  if (!token) throw new Error(`the environment variable ${variable ?? "(doors.controlTokenFromEnvironment is not set)"} with the simulation control token is not set`);
  if (token.length < 32) throw new Error(`the simulation control token in ${variable} is shorter than 32 characters; the development simulation Worker refuses it`);
  if (description.signIn?.kind !== "headers-from-environment") throw new Error("a development simulation target signs the owner in with headers-from-environment (Cloudflare Access service credentials)");
  return {
    ...description,
    appOrigin: httpsOrigin(description.appOrigin, "appOrigin"),
    mcpOrigin: httpsOrigin(description.mcpOrigin, "mcpOrigin"),
    doors: { ...doors, controlOrigin: httpsOrigin(doors.controlOrigin, "doors.controlOrigin"), controlToken: token, expectMode: DEV_MODE },
  };
}
