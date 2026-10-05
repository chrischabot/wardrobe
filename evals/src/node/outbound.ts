/**
 * Node-side boundary of the candidate phase. Everything inside the Worker is real; this file answers what
 * leaves it. It runs in the vitest (Node) process, never in workerd.
 *
 *  1. `model.eval-harness.test`: the GATEWAY RELAY. The conversation actor's model request (an OpenAI-format
 *     chat completion naming one of the product registry's `{provider}/{model}` routes) is forwarded to the
 *     application's AI Gateway (src/node/gateway.mjs), adding the gateway token from CF_AIG_TOKEN. The token
 *     never enters the Worker, a result file or a log; no provider key is sent. A request must name a route
 *     that this run's probes found on the gateway; anything else is refused. Each call is logged under
 *     `<run>/raw/model-calls/` (request, response, resolved model, usage). `raw/` is candidate-side only:
 *     the judge phase never reads it, so the judge sees no tool trace, no reasoning and no model identity.
 *     With no gateway configured it answers 503, which the application reports as the model being unavailable.
 *  2. `harness.eval-harness.test`: the CASE SERVER and RECORDER. `/cases` returns the candidate input the
 *     orchestrator wrote for this process: identifier, request, scenario and world of the cases of ONE split,
 *     and nothing else (no criteria, no evidence, no expected state, no title, no case of the other split).
 *     `/probes` returns the gateway probes the orchestrator made before the phase. `/record` writes what the
 *     adapter observed into the run directory.
 *  3. Everything else goes to the journey suite's labelled doubles (scripted Open-Meteo forecast, in-memory
 *     Google Calendar, the Worker package's fixture). They are stand-ins and prove nothing about the real
 *     services; see tests/journeys/src/outbound.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { journeyOutbound } from "../../../tests/journeys/src/outbound.ts";
import { gatewayHeaders, gatewayRoute, type ProbeReport } from "./gateway.mjs";

export const MODEL_HOST = "model.eval-harness.test";
export const HARNESS_HOST = "harness.eval-harness.test";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const runDir = () => {
  const dir = process.env.EVAL_RUN_DIR;
  if (!dir) throw new Error("EVAL_RUN_DIR is not set: the candidate phase is started by evals/run.mjs");
  return dir;
};
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const probesFile = () => path.join(runDir(), "raw", "probes.json");

/** The probes of this run, as the orchestrator recorded them; empty when no gateway was configured. */
export function probes(): ProbeReport | null {
  return existsSync(probesFile()) ? (JSON.parse(readFileSync(probesFile(), "utf8")) as ProbeReport) : null;
}

let callCounter = 0;

/** Token usage and the model the route says answered, from either a JSON body or an event stream. */
export function usageOf(text: string): { resolvedModel: string | null; inputTokens: number | null; outputTokens: number | null; stopReason: string | null } {
  const out = { resolvedModel: null as string | null, inputTokens: null as number | null, outputTokens: null as number | null, stopReason: null as string | null };
  const take = (o: any) => {
    if (!o || typeof o !== "object") return;
    const m = o.model ?? o.message?.model;
    if (typeof m === "string") out.resolvedModel = m;
    const u = o.usage ?? o.message?.usage;
    if (u) {
      if (typeof (u.input_tokens ?? u.prompt_tokens) === "number") out.inputTokens = u.input_tokens ?? u.prompt_tokens;
      if (typeof (u.output_tokens ?? u.completion_tokens) === "number") out.outputTokens = u.output_tokens ?? u.completion_tokens;
    }
    const s = o.stop_reason ?? o.delta?.stop_reason ?? o.choices?.[0]?.finish_reason;
    if (typeof s === "string") out.stopReason = s;
  };
  try {
    take(JSON.parse(text));
    return out;
  } catch {
    /* an event stream */
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      take(JSON.parse(line.slice(5).trim()));
    } catch {
      /* [DONE] or a partial line */
    }
  }
  return out;
}

async function gatewayRelay(request: Request, url: URL): Promise<Response> {
  const route = gatewayRoute();
  if (!route.ready) return json({ error: { type: "harness_no_gateway", message: `the AI Gateway route is not configured: ${route.missing.join(", ")}` } }, 503);
  if (url.pathname !== "/chat/completions") return json({ error: { type: "invalid_request_error", message: `gateway relay: only chat completions are relayed, not ${url.pathname}` } }, 400);
  const bodyText = await request.text();
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return json({ error: { type: "invalid_request_error", message: "gateway relay: request body is not JSON" } }, 400);
  }
  const allowed = (probes()?.profiles ?? []).map((p) => p.gatewayRoute).filter(Boolean);
  if (!allowed.includes(body.model)) return json({ error: { type: "invalid_request_error", message: `gateway relay: ${String(body.model)} is not a registry route probed for this run` } }, 400);
  const n = ++callCounter;
  const runId = safe(request.headers.get("x-eval-run") ?? "unbound");
  const started = Date.now();
  const dir = path.join(runDir(), "raw", "model-calls", runId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(n).padStart(5, "0")}-${process.pid}.json`);
  const meta = { role: "candidate", gatewayId: route.gatewayId, requestedModel: body.model, profileId: request.headers.get("x-eval-profile"), task: request.headers.get("x-eval-task"), attempt: request.headers.get("x-eval-attempt"), applicationRunId: runId, startedAt: new Date(started).toISOString() };
  let upstream: Response;
  try {
    upstream = await fetch(`${route.baseUrl}/chat/completions`, { method: "POST", headers: gatewayHeaders("candidate"), body: bodyText });
  } catch (error) {
    writeFileSync(file, JSON.stringify({ ...meta, request: body, error: String((error as Error)?.message ?? error), elapsedMs: Date.now() - started }, null, 1));
    return json({ error: { type: "harness_gateway_unreachable", message: "the AI Gateway could not be reached" } }, 502);
  }
  const copy = upstream.clone();
  void copy
    .text()
    .then((text) => writeFileSync(file, JSON.stringify({ ...meta, request: body, status: upstream.status, ...usageOf(text), elapsedMs: Date.now() - started, response: text }, null, 1)))
    .catch((error) => writeFileSync(file, JSON.stringify({ ...meta, request: body, status: upstream.status, error: `response could not be read: ${String(error)}` }, null, 1)));
  const headers = new Headers();
  for (const name of ["content-type", "retry-after"]) if (upstream.headers.get(name)) headers.set(name, upstream.headers.get(name)!);
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function harness(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/cases") {
    const file = process.env.EVAL_CASES_FILE;
    if (!file) return json({ error: "EVAL_CASES_FILE is not set" }, 500);
    return new Response(readFileSync(file, "utf8"), { headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/probes") return json(probes() ?? { gatewayId: gatewayRoute().gatewayId, gatewayHost: null, probedAt: null, profiles: [] });
  if (url.pathname === "/record" && request.method === "POST") {
    const dir = path.join(runDir(), "cases", safe(url.searchParams.get("case") ?? ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, safe(url.searchParams.get("name") ?? "record.json")), await request.text());
    return json({ ok: true });
  }
  return json({ error: "not part of the harness" }, 404);
}

export async function evalOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.host === MODEL_HOST) return gatewayRelay(request, url);
  if (url.host === HARNESS_HOST) return harness(request, url);
  return journeyOutbound(request);
}
