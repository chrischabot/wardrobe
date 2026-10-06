/**
 * The parts of verification and redeployment that need the Cloudflare management API. Everything here
 * reads, except: pulling and acknowledging this build's own dead-letter queue, and redeploying this
 * build's own product Worker. Both go through the development-name guard.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GATEWAY_ID, NAMES, QUEUE_CONSUMER, assertDevName } from "./config.mjs";
import { accountPath as A, presence, tryRead, write } from "./cf.mjs";
import { sleep, wrangler } from "./run.mjs";
import { autoConfig, opsConfig, primaryConfig, writeConfig } from "./wrangler-config.mjs";

export function managementFor(state) {
  if (!Object.values(presence(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"])).every(Boolean)) return null;
  const queues = state.deployed?.resources?.queues ?? {};
  return {
    async bucketExposure() {
      const out = {};
      for (const bucket of [NAMES.mediaBucket, NAMES.exportBucket]) {
        const managed = await tryRead(A(`/r2/buckets/${bucket}/domains/managed`));
        const custom = await tryRead(A(`/r2/buckets/${bucket}/domains/custom`));
        out[bucket] = { publicAddressEnabled: managed.ok ? Boolean(managed.result?.enabled) : `unreadable (HTTP ${managed.status})`, customDomains: custom.ok ? (custom.result?.domains ?? []).length : `unreadable (HTTP ${custom.status})` };
      }
      return out;
    },

    /** Wait for the probe message on the dead-letter queue (HTTP pull), acknowledge it, release anything else. */
    async awaitDeadLetter(probeId, timeoutMs) {
      const id = queues[NAMES.mediaDlq];
      const started = Date.now();
      const guard = { kind: "queue_pull", target: NAMES.mediaDlq, guard: assertDevName };
      while (id && Date.now() - started < timeoutMs) {
        const pulled = await write("POST", A(`/queues/${id}/messages/pull`), { batch_size: 20, visibility_timeout_ms: 10_000 }, guard);
        const messages = pulled?.messages ?? [];
        const text = (m) => (typeof m.body === "string" ? `${m.body} ${Buffer.from(m.body, "base64").toString("utf8")}` : JSON.stringify(m.body));
        const mine = messages.filter((m) => text(m).includes(probeId));
        const others = messages.filter((m) => !mine.includes(m));
        if (messages.length) await write("POST", A(`/queues/${id}/messages/ack`), { acks: mine.map((m) => ({ lease_id: m.lease_id })), retries: others.map((m) => ({ lease_id: m.lease_id })) }, { ...guard, kind: "queue_ack" });
        if (mine.length) return { found: true, waitedMs: Date.now() - started, attempts: mine[0].attempts ?? null, consumer: QUEUE_CONSUMER };
        await sleep(5000);
      }
      return { found: false, waitedMs: Date.now() - started, consumer: QUEUE_CONSUMER };
    },

    /** The Gateway's own log entry of a probe call (found by the run identifier in its metadata), as billing evidence. */
    async gatewayLogFor(runId) {
      for (let i = 0; i < 6; i++) {
        const logs = await tryRead(A(`/ai-gateway/gateways/${GATEWAY_ID}/logs?per_page=50&order_by=created_at&order_by_direction=desc&meta_info=true`));
        if (!logs.ok) return { found: false, reason: `Gateway logs unreadable (HTTP ${logs.status})` };
        const entry = (logs.result ?? []).find((l) => JSON.stringify(l.metadata ?? l).includes(runId));
        if (entry) {
          const flat = JSON.stringify(entry);
          const source = /"key_?[sS]ource"\s*:\s*"([A-Za-z_]+)"/.exec(flat)?.[1] ?? null;
          return { found: true, logId: entry.id ?? null, success: entry.success ?? null, provider: entry.provider ?? null, model: entry.model ?? null, keySource: source, unified: /^unified$/i.test(source ?? ""), cost: entry.cost ?? null };
        }
        await sleep(3000);
      }
      return { found: false, reason: "no Gateway log entry carried this run's identifier within 18 s (payload logging may be off)" };
    },
  };
}

/** Application secrets for one Worker, written to a 0600 temporary file that is removed as soon as Wrangler has read it. */
function withSecretsFile(secrets, run) {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "garderobe-secrets-"));
  const file = path.join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const versionOf = (stdout) => /Current Version ID:\s*([0-9a-f-]{36})/i.exec(stdout)?.[1] ?? null;

/** Upload the three Workers with their application secrets. Order: the product Worker first (it owns the Durable Object class). */
export function deployWorkers(state, { ids, access, nonce = null }) {
  const applicationSecrets = state.secrets;
  for (const name of Object.keys(applicationSecrets)) {
    if (/CLOUDFLARE|R2_|CF_/i.test(name)) throw new Error(`refusing to bind '${name}': management credentials are never bound to a Worker`);
  }
  const configs = {
    [NAMES.worker]: writeConfig("primary.jsonc", (() => {
      const config = primaryConfig({ ids, access });
      if (nonce) config.vars.DEPLOY_NONCE = nonce;
      return config;
    })()),
    [NAMES.opsWorker]: writeConfig("ops.jsonc", opsConfig({ ids, publicJwk: state.issuer.publicJwk, opsTokenSha256: createHash("sha256").update(state.opsToken).digest("hex") })),
    [NAMES.autoWorker]: writeConfig("auto.jsonc", autoConfig({ ids })),
  };
  const deployed = {};
  for (const [name, config] of Object.entries(configs)) {
    assertDevName(name, "worker");
    const result = withSecretsFile(applicationSecrets, (file) => wrangler(["deploy", "-c", config, "--secrets-file", file]));
    deployed[name] = { versionId: versionOf(result.stdout), ms: result.ms };
  }
  return deployed;
}

/** Redeploy the product Worker alone with a changed variable: a new version, so its Durable Objects are restarted. */
export async function redeployPrimary(state) {
  const { ids, access } = state.deployed.inputs;
  const nonce = Date.now().toString(36);
  const config = primaryConfig({ ids, access });
  config.vars.DEPLOY_NONCE = nonce;
  const file = writeConfig("primary.jsonc", config);
  const result = withSecretsFile(state.secrets, (secrets) => wrangler(["deploy", "-c", file, "--secrets-file", secrets]));
  return { versionId: versionOf(result.stdout), ms: result.ms, nonce };
}
