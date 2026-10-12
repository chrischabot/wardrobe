/**
 * The one inference route of an evaluation run: the application's own AI Gateway (`garderobe-dev` unless
 * EVAL_GATEWAY_ID names another of the application's gateways), reached over HTTP.
 *
 * Why HTTP: the product calls the gateway through the Worker's `AI` binding, which exists only on Cloudflare.
 * A local workerd has no such binding, so the harness sends the SAME gateway the SAME `{provider}/{model}`
 * routes of the product's registry through the gateway's OpenAI-compatible endpoint
 *   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions
 * authenticated as an authenticated gateway requires, with `cf-aig-authorization: Bearer <CF_AIG_TOKEN>`,
 * and with NO provider key on the request, so the gateway's own credential precedence applies (a key stored
 * on the gateway under the default alias, else Unified Billing). Checked against Cloudflare's documentation
 * on 2026-10-05 (ai-gateway/usage/chat-completion, ai-gateway/features/unified-billing). Whether a route
 * answers is established only by the probes of a run (`probeRoutes`), never assumed.
 *
 * The token is read from the environment variable CF_AIG_TOKEN and is never written to a file or a log.
 * Provider keys (PROVIDER_KEY_*) are not read anywhere in this harness.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const TOKEN_ENV = "CF_AIG_TOKEN";
export const ACCOUNT_ENV = "CLOUDFLARE_ACCOUNT_ID";
/** Variables a phase process needs to reach the gateway. Nothing else of the orchestrator's environment is passed on. */
export const GATEWAY_VARS = [TOKEN_ENV, ACCOUNT_ENV, "EVAL_GATEWAY_ID", "EVAL_GATEWAY_BASE_URL", "EVAL_GATEWAY_TIMEOUT_MS"];

export function gatewayRoute(env = process.env) {
  const gatewayId = env.EVAL_GATEWAY_ID || "garderobe-dev";
  const account = env[ACCOUNT_ENV] || "";
  const baseUrl = (env.EVAL_GATEWAY_BASE_URL || (account ? `https://gateway.ai.cloudflare.com/v1/${account}/${gatewayId}/compat` : "")).replace(/\/+$/, "");
  const missing = [];
  if (!env[TOKEN_ENV]) missing.push(TOKEN_ENV);
  if (!baseUrl) missing.push(ACCOUNT_ENV);
  let host = null;
  try {
    host = baseUrl ? new URL(baseUrl).host : null;
  } catch {
    missing.push("EVAL_GATEWAY_BASE_URL is not a URL");
  }
  return { ready: missing.length === 0, missing, gatewayId, baseUrl: baseUrl || null, host };
}

/** Request headers for the gateway. `role` is short accounting metadata (candidate, judge, probe); no personal data. */
export function gatewayHeaders(role, env = process.env) {
  return {
    "content-type": "application/json",
    "cf-aig-authorization": `Bearer ${env[TOKEN_ENV] ?? ""}`,
    "cf-aig-metadata": JSON.stringify({ garderobe_env: "evals", garderobe_role: role }),
  };
}

/** The longest a gateway call may take, request and response body together (EVAL_GATEWAY_TIMEOUT_MS overrides). */
export function gatewayTimeoutMs(env = process.env) {
  const value = Number(env.EVAL_GATEWAY_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

/** One non-streaming chat completion. Never throws: a transport failure or an expired deadline is a result with status 0. */
export async function chat(route, role, body, env = process.env) {
  const started = Date.now();
  const deadline = new AbortController();
  const timeoutMs = gatewayTimeoutMs(env);
  const timer = setTimeout(() => deadline.abort(new Error(`no complete answer within ${timeoutMs} ms`)), timeoutMs);
  try {
    // Never follow a redirect: it would carry the cf-aig-authorization credential to another origin.
    const response = await fetch(`${route.baseUrl}/chat/completions`, { method: "POST", headers: gatewayHeaders(role, env), body: JSON.stringify(body), signal: deadline.signal, redirect: "error" });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* reported through errorBody */
    }
    const message = parsed?.choices?.[0]?.message ?? null;
    const usage = parsed?.usage ?? {};
    return {
      status: response.status,
      ok: response.ok,
      text: typeof message?.content === "string" ? message.content : "",
      toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
      resolvedModel: typeof parsed?.model === "string" ? parsed.model : null,
      inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
      outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
      elapsedMs: Date.now() - started,
      errorBody: response.ok ? null : text.slice(0, 1200),
    };
  } catch (error) {
    const reason = deadline.signal.aborted ? String(deadline.signal.reason?.message ?? "the deadline expired") : String(error?.message ?? error);
    return { status: 0, ok: false, text: "", toolCalls: 0, resolvedModel: null, inputTokens: null, outputTokens: null, elapsedMs: Date.now() - started, errorBody: `request failed: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The product's registry, read from its source (`packages/assistant/src/inference/registry.ts`) so the
 * harness holds no copy of a model name: every profile with its gateway route, and the candidate order of
 * the conversation task. Throws when the source no longer has the shape this reader expects.
 */
export function readRegistry(repo) {
  return parseRegistry(readFileSync(path.join(repo, "packages/assistant/src/inference/registry.ts"), "utf8"));
}

/**
 * Parses the registry source. A value is either a string literal or the name of a top-level
 * `const NAME = "value"` in the same file; any other expression makes the reader refuse.
 */
export function parseRegistry(source) {
  const constants = new Map();
  for (const m of source.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*"([^"]*)"\s*;/gm)) constants.set(m[1], m[2]);
  const value = (literal, name, what) => {
    if (literal !== undefined) return literal;
    if (name === undefined || name === "null") return null;
    if (!constants.has(name)) throw new Error(`the model registry source could not be read: ${what} names ${name}, which is not a string constant in the file`);
    return constants.get(name);
  };
  const VALUE = String.raw`(?:"([^"]*)"|([A-Za-z_$][\w$]*))`;
  const profiles = [];
  const pattern = new RegExp(String.raw`profileId:\s*${VALUE}\s*,[\s\S]*?apiModelId:\s*${VALUE}\s*,\s*gatewayRoute:\s*${VALUE}`, "g");
  for (const match of source.matchAll(pattern)) {
    profiles.push({ profileId: value(match[1], match[2], "profileId"), apiModelId: value(match[3], match[4], "apiModelId"), gatewayRoute: value(match[5], match[6], "gatewayRoute") });
  }
  const conversation = /conversation:\s*\{[^}]*?candidates:\s*\[([^\]]*)\]/.exec(source);
  if (profiles.length === 0 || !conversation) throw new Error("the model registry source could not be read: its shape changed");
  if (profiles.some((p) => p.profileId === null)) throw new Error("the model registry source could not be read: a profile has no id");
  const conversationCandidates = conversation[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = /^(?:"([^"]*)"|([A-Za-z_$][\w$]*))$/.exec(item);
      if (!m) throw new Error(`the model registry source could not be read: conversation candidate ${item} is not a string or constant`);
      return value(m[1], m[2], "a conversation candidate");
    });
  for (const id of conversationCandidates) if (!profiles.some((p) => p.profileId === id)) throw new Error(`the conversation task names profile ${id}, which the registry reader did not find`);
  return { profiles, conversationCandidates };
}

/**
 * Real probes of the conversation task's candidate profiles on the gateway: one plain text call and one
 * tool call each. The result is what the application is told (`inference.record_probe`), so the product's
 * own routing then selects among the profiles that really answered, in its own order.
 */
export async function probeRoutes(route, registry, env = process.env) {
  const out = [];
  for (const profileId of registry.conversationCandidates) {
    const spec = registry.profiles.find((p) => p.profileId === profileId);
    if (!spec?.gatewayRoute) {
      out.push({ profileId, gatewayRoute: null, operations: {} });
      continue;
    }
    const text = await chat(route, "probe", { model: spec.gatewayRoute, max_tokens: 64, messages: [{ role: "user", content: "Reply with the single word: ready" }] }, env);
    const tools = text.ok
      ? await chat(
          route,
          "probe",
          {
            model: spec.gatewayRoute,
            max_tokens: 128,
            messages: [{ role: "user", content: "Call the report_ready tool with ready set to true." }],
            tools: [{ type: "function", function: { name: "report_ready", description: "Report readiness.", parameters: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"] } } }],
          },
          env,
        )
      : null;
    const describe = (call, passed, why) => ({ result: passed ? "passed" : "failed", status: call?.status ?? null, resolvedModel: call?.resolvedModel ?? null, elapsedMs: call?.elapsedMs ?? null, reason: passed ? null : why });
    out.push({
      profileId,
      gatewayRoute: spec.gatewayRoute,
      operations: {
        text: describe(text, text.ok && text.text.length > 0, text.ok ? "the route answered without text" : `the route answered ${text.status}: ${text.errorBody}`),
        tools: describe(tools, Boolean(tools?.ok && tools.toolCalls > 0), !tools ? "not probed: the text probe failed" : tools.ok ? "the route answered without calling the tool" : `the route answered ${tools.status}: ${tools.errorBody}`),
      },
    });
  }
  return { gatewayId: route.gatewayId, gatewayHost: route.host, probedAt: new Date().toISOString(), profiles: out };
}
