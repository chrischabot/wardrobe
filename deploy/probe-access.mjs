#!/usr/bin/env node
/**
 * What the credentials in this environment can reach. Read-only by default; writes nothing to the account.
 *
 *   node deploy/probe-access.mjs               names present, and the HTTP status of one list call per service
 *   node deploy/probe-access.mjs --inference   also one 16-token call per model route through the
 *                                              development AI Gateway's REST endpoint (costs a few tokens)
 *
 * It answers one question: can the deploy command run here? It prints and records variable NAMES,
 * HTTP statuses, Cloudflare error codes and counts. Values are never printed or written.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_DIR, GATEWAY_ID, ZONE } from "./lib/config.mjs";
import { isOurs } from "./lib/provision.mjs";

const NAMES = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_AIG_TOKEN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT", "GARDEROBE_OWNER_EMAIL"];
const env = process.env;
const present = Object.fromEntries(NAMES.map((n) => [n, Boolean(env[n])]));
const account = env.CLOUDFLARE_ACCOUNT_ID;
const API = "https://api.cloudflare.com/client/v4";

async function list(token, route) {
  try {
    const r = await fetch(`${API}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => null);
    const result = j?.result;
    const items = Array.isArray(result) ? result : (result?.buckets ?? null);
    return { httpStatus: r.status, cloudflareErrorCodes: (j?.errors ?? []).map((e) => e.code), count: items ? items.length : null };
  } catch (error) {
    return { httpStatus: null, error: String(error.message).slice(0, 120) };
  }
}

const SERVICES = {
  credentialValid: "/tokens/verify", workers: "/workers/scripts", d1: "/d1/database", kv: "/storage/kv/namespaces", r2: "/r2/buckets", queues: "/queues", workflows: "/workflows",
  aiGateway: `/ai-gateway/gateways/${GATEWAY_ID}`, aiSearchNamespaces: "/ai-search/namespaces", accessApps: "/access/apps", accessOrganization: "/access/organizations",
};

const management = {};
// Keyed by role, not by variable name, so the evidence file never pairs a credential's name with a value.
for (const [tokenName, role] of [["CLOUDFLARE_API_TOKEN", "withManagementCredential"], ["CF_AIG_TOKEN", "withGatewayCredential"]]) {
  if (!env[tokenName] || !account) {
    management[role] = "not in the environment";
    continue;
  }
  const out = {};
  for (const [service, route] of Object.entries(SERVICES)) out[service] = await list(env[tokenName], `/accounts/${account}${route}`);
  out.zone = await list(env[tokenName], `/zones?name=${ZONE}`);
  management[role] = out;
}

/** R2's S3 endpoint: ListBuckets with the access key pair (SigV4). Reports counts and this build's bucket names only. */
async function r2Buckets() {
  if (!present.R2_ACCESS_KEY_ID || !present.R2_SECRET_ACCESS_KEY || !present.R2_ENDPOINT) return "R2 key pair or endpoint not in the environment";
  const url = new URL(env.R2_ENDPOINT);
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const emptyHash = createHash("sha256").update("").digest("hex");
  const canonical = `GET\n/\n\nhost:${url.host}\nx-amz-content-sha256:${emptyHash}\nx-amz-date:${amzDate}\n\nhost;x-amz-content-sha256;x-amz-date\n${emptyHash}`;
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonical).digest("hex")}`;
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const signature = createHmac("sha256", hmac(hmac(hmac(hmac(`AWS4${env.R2_SECRET_ACCESS_KEY}`, day), "auto"), "s3"), "aws4_request")).update(toSign).digest("hex");
  const r = await fetch(`${url.origin}/`, { headers: { "x-amz-date": amzDate, "x-amz-content-sha256": emptyHash, Authorization: `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}` } });
  const names = [...(await r.text()).matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
  return { httpStatus: r.status, buckets: names.length, thisBuildsBuckets: names.filter(isOurs), otherBucketsFoundAndLeft: names.filter((n) => !isOurs(n)).length, garderobeNamedOthers: names.filter((n) => !isOurs(n) && n.startsWith("garderobe")) };
}

/** One small call per route through the Gateway's OpenAI-compatible REST endpoint, authenticated to the Gateway only (no provider key). */
async function inference() {
  if (!present.CF_AIG_TOKEN || !account) return "CF_AIG_TOKEN not in the environment";
  const out = {};
  for (const model of ["deepseek/deepseek-flash", "anthropic/claude-fable-5-1", "openai/gpt-6-astra"]) {
    const started = Date.now();
    const r = await fetch(`https://gateway.ai.cloudflare.com/v1/${account}/${GATEWAY_ID}/compat/chat/completions`, { method: "POST", headers: { "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word: ready" }] }), signal: AbortSignal.timeout(90_000) });
    const j = await r.json().catch(() => null);
    out[model] = { httpStatus: r.status, ms: Date.now() - started, gatewayLogged: Boolean(r.headers.get("cf-aig-log-id")), answered: Boolean(j?.choices?.[0]?.message?.content), resolvedModel: j?.model ?? null, promptTokens: j?.usage?.prompt_tokens ?? null, completionTokens: j?.usage?.completion_tokens ?? null };
  }
  return out;
}

const report = {
  checkedAt: new Date().toISOString(),
  what: "Reach of the credentials present in this environment. Names, HTTP statuses, error codes and counts only.",
  environmentVariables: present,
  canDeploy: present.CLOUDFLARE_API_TOKEN && present.CLOUDFLARE_ACCOUNT_ID,
  management,
  r2S3: await r2Buckets().catch((e) => `failed: ${String(e.message).slice(0, 120)}`),
  ...(process.argv.includes("--inference") ? { gatewayRestInference: { note: "REST endpoint from outside a Worker; the application uses the AI binding, which only a deployed Worker can exercise, so nothing here is recorded as a model probe", routes: await inference() } } : {}),
};
mkdirSync(EVIDENCE_DIR, { recursive: true });
writeFileSync(path.join(EVIDENCE_DIR, "access-probe.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(Object.entries(present).map(([n, ok]) => `${ok ? "present" : "ABSENT "}  ${n}`).join("\n"));
console.log(report.canDeploy ? "the deploy command can run here" : "the deploy command CANNOT run here: the management token is not in the environment");
console.log("-> deploy/evidence/access-probe.json");
process.exit(report.canDeploy ? 0 : 2);
