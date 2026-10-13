/**
 * Generated Wrangler configurations of the development deployment. Three Workers share one set of
 * development resources:
 *
 *  - the product Worker (`apps/worker/src/index.ts`, unchanged) on the app and MCP hostnames, behind the
 *    account's Cloudflare Access team: the door a person uses;
 *  - the automation door: the SAME product entry and the same resources on two further hostnames, whose
 *    sign-in issuer is this tooling's own key (served by the operations Worker at the standard
 *    `/cdn-cgi/access/certs` path). It exists so that verification can sign in as labelled test identities
 *    over HTTPS without a person and without any management credential. It is development-only and is
 *    removed by teardown;
 *  - the operations Worker (`deploy/ops`): seeds through the real importer, runs platform probes, and
 *    serves the automation issuer's public key. Every operation needs the operations token.
 *
 * Binding NAMES are the product Worker's contract (apps/worker/wrangler.jsonc) and are not changed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COMPATIBILITY_DATE, ENVIRONMENT, GATEWAY_ID, GENERATED_DIR, HOSTS, NAMES, QUEUE_CONSUMER, REPO_ROOT, assertDevHost, assertDevName } from "./config.mjs";

const rel = (target) => path.relative(GENERATED_DIR, path.join(REPO_ROOT, target)).split(path.sep).join("/");

/** Resources every Worker of the deployment binds. `ids` comes from provisioning (or local names in a rehearsal). */
function sharedBindings(ids, { local }) {
  return {
    d1_databases: [{ binding: "DB", database_name: NAMES.d1, database_id: ids.d1, migrations_dir: rel("migrations") }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: ids.kv }],
    r2_buckets: [
      { binding: "MEDIA_BUCKET", bucket_name: NAMES.mediaBucket },
      { binding: "EXPORT_BUCKET", bucket_name: NAMES.exportBucket },
    ],
    // Platform services that have no local simulator are bound only on the real platform; the product
    // reports a part without its binding as unavailable.
    ...(local
      ? { images: { binding: "IMAGES" } }
      : {
          ai: { binding: "AI" },
          images: { binding: "IMAGES" },
          browser: { binding: "BROWSER" },
          ...(ids.searchNamespace ? { ai_search_namespaces: [{ binding: "AI_SEARCH", namespace: ids.searchNamespace }] } : {}),
        }),
  };
}

function productVars({ appOrigin, mcpOrigin, issuer, audience }) {
  return { ENVIRONMENT, APP_ORIGIN: appOrigin, MCP_ORIGIN: mcpOrigin, ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience, AI_GATEWAY_ID: GATEWAY_ID };
}

const base = (name) => ({
  name: assertDevName(name, "worker"),
  compatibility_date: COMPATIBILITY_DATE,
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  workers_dev: false,
  preview_urls: false,
  observability: { enabled: true },
});

const routes = (hosts) => hosts.map((host) => ({ pattern: assertDevHost(host), custom_domain: true }));

/** The product Worker behind the account's Access team. Owns the conversation Durable Object, the queue consumer and the cron sweep. */
export function primaryConfig({ ids, access, local = false, origins = null }) {
  return {
    ...base(NAMES.worker),
    main: rel("apps/worker/src/index.ts"),
    ...(local ? {} : { routes: routes([HOSTS.app, HOSTS.mcp]) }),
    ...sharedBindings(ids, { local }),
    queues: {
      producers: [{ binding: "MEDIA_QUEUE", queue: NAMES.mediaQueue }],
      consumers: [{ queue: NAMES.mediaQueue, ...QUEUE_CONSUMER, dead_letter_queue: NAMES.mediaDlq }],
    },
    durable_objects: { bindings: [{ name: "ASSISTANT", class_name: "GarderobeAssistant" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["GarderobeAssistant"] }],
    triggers: { crons: ["*/5 * * * *"] },
    vars: productVars({
      appOrigin: origins?.app ?? `https://${HOSTS.app}`,
      mcpOrigin: origins?.mcp ?? `https://${HOSTS.mcp}`,
      issuer: access.teamDomain,
      audience: access.audience,
    }),
  };
}

/** The automation door: the product entry again, with this tooling's issuer. No cron and no queue consumer (the primary Worker has them). */
export function autoConfig({ ids }) {
  return {
    ...base(NAMES.autoWorker),
    main: rel("apps/worker/src/index.ts"),
    routes: routes([HOSTS.autoApp, HOSTS.autoMcp]),
    ...sharedBindings(ids, { local: false }),
    queues: { producers: [{ binding: "MEDIA_QUEUE", queue: NAMES.mediaQueue }] },
    // The one conversation actor namespace lives in the primary Worker.
    durable_objects: { bindings: [{ name: "ASSISTANT", class_name: "GarderobeAssistant", script_name: NAMES.worker }] },
    vars: productVars({ appOrigin: `https://${HOSTS.autoApp}`, mcpOrigin: `https://${HOSTS.autoMcp}`, issuer: `https://${HOSTS.ops}`, audience: NAMES.autoAudience }),
  };
}

/** The operations Worker. `rehearsal` puts it in front of the product Worker in one local session (see rehearse.mjs). */
export function opsConfig({ ids, publicJwk, opsTokenSha256, rehearsal = null }) {
  const local = rehearsal !== null;
  return {
    ...base(NAMES.opsWorker),
    main: rel("deploy/ops/src/index.ts"),
    ...(local ? {} : { routes: routes([HOSTS.ops]) }),
    // The owner's documents are read from the repository at build time, byte for byte; the importer checks the profile hash itself.
    rules: [{ type: "Text", globs: ["**/chris-wardrobe-profile.md", "**/wardrobe_inventory_clean.csv"], fallthrough: true }],
    ...sharedBindings(ids, { local }),
    queues: { producers: [{ binding: "MEDIA_QUEUE", queue: NAMES.mediaQueue }] },
    workflows: [{ name: NAMES.workflow, binding: "PROBE_WORKFLOW", class_name: "OpsProbeWorkflow" }],
    ...(local ? { services: [{ binding: "PRODUCT", service: NAMES.worker }] } : {}),
    vars: {
      // The operations Worker composes the product application to run its commands, so it carries the same configuration.
      ...productVars({
        appOrigin: rehearsal?.app ?? `https://${HOSTS.autoApp}`,
        mcpOrigin: rehearsal?.mcp ?? `https://${HOSTS.autoMcp}`,
        issuer: rehearsal?.issuer ?? `https://${HOSTS.ops}`,
        audience: NAMES.autoAudience,
      }),
      AUTO_JWKS_JSON: JSON.stringify({ keys: [publicJwk] }),
      OPS_TOKEN_SHA256: opsTokenSha256,
      ...(local ? { REHEARSAL: "1" } : {}),
    },
  };
}

export function writeConfig(fileName, config) {
  mkdirSync(GENERATED_DIR, { recursive: true });
  const file = path.join(GENERATED_DIR, fileName);
  writeFileSync(file, `// Generated by deploy/lib/wrangler-config.mjs. Do not edit; rerun the deploy command.\n${JSON.stringify(config, null, 2)}\n`);
  return file;
}
