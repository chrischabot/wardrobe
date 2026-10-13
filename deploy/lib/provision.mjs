/**
 * Idempotent provisioning of the development resources, through the Cloudflare management API.
 *
 * Every step reads first and creates only what is missing; nothing is ever renamed, emptied or deleted
 * here. Every write goes through `write()` in cf.mjs with a guarded development name. Request shapes
 * follow the published Cloudflare API schema (checked 2026-10-03): D1 `POST /d1/database {name}`, KV
 * `POST /storage/kv/namespaces {title}`, R2 `POST /r2/buckets {name}` and `PUT
 * /r2/buckets/{name}/domains/managed {enabled}`, Queues `POST /queues {queue_name}` and `POST
 * /queues/{id}/consumers {type}`, AI Search `POST /ai-search/namespaces {name}`, Access `POST
 * /access/apps`. The AI Gateway is read and never written.
 */
import { ACCESS_BYPASS_PATHS, GATEWAY_ID, GuardError, HOSTS, NAMES, PREFIX, ZONE, assertDevHost, assertDevName } from "./config.mjs";
import { accountPath as A, read, readAll, tryRead, write } from "./cf.mjs";

const assertAccessAppName = (name) => {
  if (typeof name !== "string" || !name.startsWith(`${PREFIX} `)) throw new GuardError(`Access application '${name}' is not one of this build's development applications`);
  return name;
};

/** Read-only: what exists on the account, split into this build's development resources and everything else (names only). */
export async function inventory() {
  const section = async (label, load, nameOf) => {
    try {
      const names = (await load()).map(nameOf).filter(Boolean).sort();
      return { label, ok: true, ours: names.filter(isOurs), others: names.filter((n) => !isOurs(n)) };
    } catch (error) {
      return { label, ok: false, error: String(error.message).slice(0, 300), ours: [], others: [] };
    }
  };
  return Promise.all([
    section("workers", () => readAll(A("/workers/scripts")), (x) => x.id),
    section("d1", () => readAll(A("/d1/database")), (x) => x.name),
    section("kv", () => readAll(A("/storage/kv/namespaces")), (x) => x.title),
    section("r2", () => readAll(A("/r2/buckets")), (x) => x.name),
    section("queues", () => readAll(A("/queues")), (x) => x.queue_name),
    section("ai_search_namespaces", () => readAll(A("/ai-search/namespaces")), (x) => x.name),
    section("ai_search_instances", () => readAll(A("/ai-search/instances")), (x) => x.id),
    section("ai_gateways", () => readAll(A("/ai-gateway/gateways")), (x) => x.id),
    section("access_apps", () => readAll(A("/access/apps")), (x) => x.name),
    section("workflows", () => readAll(A("/workflows")), (x) => x.name),
  ]);
}

export const isOurs = (name) => typeof name === "string" && (name === PREFIX || name.startsWith(`${PREFIX}-`) || name.startsWith(`${PREFIX} `));

async function ensure(kind, name, find, create, dryRun, steps) {
  const existing = await find();
  if (existing) {
    steps.push({ kind, name, action: "exists" });
    return existing;
  }
  const created = await create();
  steps.push({ kind, name, action: dryRun ? "would_create" : "created" });
  return created;
}

/**
 * Create what is missing and return the identifiers the Wrangler configurations need.
 * `ownerEmail` (optional) is the one identity the Access application admits; without it the application
 * is created with no allow policy, so the person's door admits nobody until the owner adds one.
 */
export async function provision({ dryRun = false, ownerEmail = null } = {}) {
  const steps = [];
  const notes = [];
  const w = (method, path, body, kind, target, guard = assertDevName) => write(method, path, body, { kind, target, guard, dryRun });

  const zone = await tryRead(`/zones?name=${ZONE}`);
  const zoneId = zone.ok && Array.isArray(zone.result) && zone.result[0] ? zone.result[0].id : null;
  if (!zoneId) notes.push(`zone ${ZONE} is not readable with this token (HTTP ${zone.status}); custom hostnames cannot be attached`);

  const d1 = await ensure("d1", NAMES.d1, async () => (await readAll(A(`/d1/database?name=${NAMES.d1}`))).find((x) => x.name === NAMES.d1), () => w("POST", A("/d1/database"), { name: NAMES.d1 }, "d1", NAMES.d1), dryRun, steps);
  const kv = await ensure("kv", NAMES.kv, async () => (await readAll(A("/storage/kv/namespaces"))).find((x) => x.title === NAMES.kv), () => w("POST", A("/storage/kv/namespaces"), { title: NAMES.kv }, "kv", NAMES.kv), dryRun, steps);

  const buckets = {};
  for (const bucket of [NAMES.mediaBucket, NAMES.exportBucket]) {
    await ensure("r2", bucket, async () => ((await tryRead(A(`/r2/buckets/${bucket}`))).ok ? { name: bucket } : null), () => w("POST", A("/r2/buckets"), { name: bucket }, "r2", bucket), dryRun, steps);
    // Private buckets: the public r2.dev address stays off and no custom domain is attached.
    const managed = await tryRead(A(`/r2/buckets/${bucket}/domains/managed`));
    if (managed.ok && managed.result?.enabled) {
      await w("PUT", A(`/r2/buckets/${bucket}/domains/managed`), { enabled: false }, "r2_public_address", bucket);
      steps.push({ kind: "r2_public_address", name: bucket, action: dryRun ? "would_disable" : "disabled" });
    }
    const custom = await tryRead(A(`/r2/buckets/${bucket}/domains/custom`));
    buckets[bucket] = { publicAddressEnabled: managed.ok ? Boolean(managed.result?.enabled) && dryRun : null, customDomains: custom.ok ? (custom.result?.domains ?? []).length : null };
  }

  const queues = {};
  for (const queue of [NAMES.mediaDlq, NAMES.mediaQueue]) {
    const q = await ensure("queue", queue, async () => (await readAll(A("/queues"))).find((x) => x.queue_name === queue), () => w("POST", A("/queues"), { queue_name: queue }, "queue", queue), dryRun, steps);
    queues[queue] = q?.queue_id ?? null;
  }
  // The dead-letter queue is read by the verification run over HTTP pull, so a dead-lettered message can be observed.
  if (queues[NAMES.mediaDlq]) {
    const consumers = await tryRead(A(`/queues/${queues[NAMES.mediaDlq]}/consumers`));
    if (consumers.ok && !(consumers.result ?? []).some((c) => c.type === "http_pull")) {
      await w("POST", A(`/queues/${queues[NAMES.mediaDlq]}/consumers`), { type: "http_pull" }, "queue_pull_consumer", NAMES.mediaDlq);
      steps.push({ kind: "queue_pull_consumer", name: NAMES.mediaDlq, action: dryRun ? "would_create" : "created" });
    }
  }

  let searchNamespace = null;
  try {
    await ensure("ai_search_namespace", NAMES.searchNamespace, async () => (await readAll(A("/ai-search/namespaces"))).find((x) => x.name === NAMES.searchNamespace), () => w("POST", A("/ai-search/namespaces"), { name: NAMES.searchNamespace, description: "Garderobe rebuild, development: one private instance per internal user" }, "ai_search_namespace", NAMES.searchNamespace), dryRun, steps);
    searchNamespace = NAMES.searchNamespace;
  } catch (error) {
    notes.push(`AI Search namespace not provisioned: ${String(error.message).slice(0, 300)}`);
  }

  // Declared, never created or changed: the owner's development gateway (specification section 19).
  const gw = await tryRead(A(`/ai-gateway/gateways/${GATEWAY_ID}`));
  const gateway = gw.ok
    ? { id: GATEWAY_ID, found: true, authentication: gw.result.authentication ?? null, collectLogs: gw.result.collect_logs ?? null, cacheTtl: gw.result.cache_ttl ?? null, rateLimitingLimit: gw.result.rate_limiting_limit ?? null, retryMaxAttempts: gw.result.retry_max_attempts ?? null, spendLimitsConfigured: gw.result.spend_limits != null, workersAiBillingMode: gw.result.workers_ai_billing_mode ?? null }
    : { id: GATEWAY_ID, found: false, status: gw.status };
  if (!gw.ok) notes.push(`AI Gateway ${GATEWAY_ID} could not be read (HTTP ${gw.status}); it is not created by this tooling`);

  const access = await provisionAccess({ dryRun, ownerEmail, steps, notes, w });
  return { ids: { d1: d1?.uuid ?? d1?.id ?? null, kv: kv?.id ?? null, searchNamespace, queues, zoneId }, buckets, gateway, access, steps, notes };
}

/** The person's door: one Access application on the app hostname, and a bypass for each self-authenticating path. */
async function provisionAccess({ dryRun, ownerEmail, steps, notes, w }) {
  const org = await tryRead(A("/access/organizations"));
  if (!org.ok || !org.result?.auth_domain) {
    notes.push(`no Cloudflare Access organization is readable (HTTP ${org.status}); the person's door is deployed closed. Owner step: set up Zero Trust with Google as identity provider, then rerun deploy.`);
    return { configured: false, teamDomain: "https://access-not-configured.invalid", audience: "access-not-configured" };
  }
  const teamDomain = `https://${org.result.auth_domain}`;
  const apps = await readAll(A("/access/apps"));
  const host = assertDevHost(HOSTS.app);
  const main = await ensure(
    "access_app",
    NAMES.accessApp,
    async () => apps.find((a) => a.name === NAMES.accessApp),
    () =>
      w("POST", A("/access/apps"), {
        type: "self_hosted", name: NAMES.accessApp, domain: host, session_duration: "24h", app_launcher_visible: false,
        policies: ownerEmail ? [{ name: `${PREFIX} owner`, decision: "allow", include: [{ email: { email: ownerEmail } }] }] : [],
      }, "access_app", NAMES.accessApp, assertAccessAppName),
    dryRun,
    steps,
  );
  if (!ownerEmail && !(main?.policies ?? []).length) notes.push("the Access application has no allow policy (GARDEROBE_OWNER_EMAIL was not given): nobody can sign in at the person's door until the owner adds their identity");
  for (const p of ACCESS_BYPASS_PATHS) {
    const name = `${PREFIX} (bypass ${p})`;
    await ensure(
      "access_bypass",
      name,
      async () => apps.find((a) => a.name === name),
      () => w("POST", A("/access/apps"), { type: "self_hosted", name, domain: `${host}${p}`, session_duration: "24h", app_launcher_visible: false, policies: [{ name: `${PREFIX} self-authenticating path`, decision: "bypass", include: [{ everyone: {} }] }] }, "access_bypass", name, assertAccessAppName),
      dryRun,
      steps,
    );
  }
  return { configured: true, teamDomain, audience: main?.aud ?? "pending-dry-run", appId: main?.id ?? null };
}

/** Everything teardown would remove, found by name. Read-only. */
export async function findOurs() {
  const out = [];
  const add = (kind, name, id, extra = {}) => out.push({ kind, name, id, ...extra });
  const safe = async (load) => {
    try {
      return await load();
    } catch {
      return [];
    }
  };
  for (const s of await safe(() => readAll(A("/workers/scripts")))) if ([NAMES.opsWorker, NAMES.autoWorker, NAMES.worker].includes(s.id)) add("worker", s.id, s.id);
  for (const a of await safe(() => readAll(A("/access/apps")))) if (isOurs(a.name)) add("access_app", a.name, a.id);
  for (const q of await safe(() => readAll(A("/queues")))) if ([NAMES.mediaQueue, NAMES.mediaDlq].includes(q.queue_name)) add("queue", q.queue_name, q.queue_id);
  for (const k of await safe(() => readAll(A("/storage/kv/namespaces")))) if (k.title === NAMES.kv) add("kv", k.title, k.id);
  for (const d of await safe(() => readAll(A(`/d1/database?name=${NAMES.d1}`)))) if (d.name === NAMES.d1) add("d1", d.name, d.uuid ?? d.id);
  for (const b of [NAMES.mediaBucket, NAMES.exportBucket]) if ((await tryRead(A(`/r2/buckets/${b}`))).ok) add("r2", b, b);
  for (const n of await safe(() => readAll(A("/ai-search/namespaces")))) {
    if (n.name !== NAMES.searchNamespace) continue;
    for (const i of await safe(() => readAll(A(`/ai-search/namespaces/${n.name}/instances`)))) add("ai_search_instance", i.id, i.id, { namespace: n.name });
    add("ai_search_namespace", n.name, n.name);
  }
  for (const wf of await safe(() => readAll(A("/workflows")))) if (wf.name === NAMES.workflow) add("workflow", wf.name, wf.name);
  return out;
}

export { read };
