/**
 * Node-side stand-in for everything OUTSIDE the Worker under attack. Nothing inside the Worker is
 * replaced. Each layer is a LABELLED TEST DOUBLE and proves nothing about the real service:
 *
 *  1. A scripted-response layer of this suite (`https://adversarial.fixture.test` is its control
 *     channel): a test plants a hostile page, redirect, DNS answer or file at an exact URL, a URL prefix
 *     or a host, and the Worker's real adapters fetch it.
 *  2. A log of EVERY outbound request the Worker made (method, URL, headers, the whole body up to 4 MiB), so an
 *     attack can assert on what left the Worker: no request to a private address, no secret in a URL,
 *     header or body.
 *  3. Everything not scripted goes to the journey suite's doubles (scripted Open-Meteo forecast,
 *     in-memory Google Calendar) and from there to the Worker package's own fixture (Google OAuth, the
 *     remote MCP stand-in, the push stand-in); any other host answers 503, i.e. an outage. Tests never
 *     reach the network.
 */
import { GOOGLE_FIXTURE_ORIGIN } from "@garderobe/worker/testing/vitest-config";
import { JOURNEY_FIXTURE_ORIGIN, journeyOutbound } from "../../../../journeys/src/outbound.ts";
import type { OutboundScript } from "./dns.ts";

export { DNS_RESOLVER, PUBLIC_ADDRESS, dnsAnswer, type OutboundScript } from "./dns.ts";

export const ADVERSARIAL_FIXTURE_ORIGIN = "https://adversarial.fixture.test";

/**
 * The per-run key of this suite's control channel. It lives in this Node process and is compiled into the test
 * code (vitest.config.ts `define`); the Worker never has it. A request to the control origin without it is
 * the Worker's own request: it is logged like any other and never reaches the script or log endpoints.
 */
export const CONTROL_HEADER = "x-adversarial-control";
export const CONTROL_KEY: string = crypto.randomUUID();

/**
 * Request bodies are kept whole up to this many BYTES (4 MiB); a longer body keeps its first 4 MiB, decoded as
 * text, and is marked `bodyTruncated` so a reader knows a marker past that point could not be seen.
 */
export const BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export interface OutboundLogEntry {
  seq: number;
  method: string;
  url: string;
  host: string;
  headers: Record<string, string>;
  /** The whole request body as text, up to `BODY_LIMIT_BYTES` (see `bodyTruncated`). */
  body: string;
  /** Size of the request body in bytes. */
  bodyBytes: number;
  /** True when the body was longer than `BODY_LIMIT_BYTES` and `body` holds only its first part. */
  bodyTruncated: boolean;
  /** `scripted` when this suite's layer answered, `fixture-control` for another suite's control route, otherwise `passthrough`. */
  answeredBy: "scripted" | "passthrough" | "fixture-control";
  /** True when the request body could not be read: its content is unknown, not empty. */
  bodyUnreadable?: boolean;
  status: number;
}

const scripts: OutboundScript[] = [];

const log: OutboundLogEntry[] = [];
let seq = 0;
/** Entries kept; older ones are dropped, and `evictedThrough` says up to which `seq`, so a reader never trusts a cut log. */
const LOG_LIMIT = 100_000;
let evictedThrough = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function scriptFor(method: string, url: URL): OutboundScript | undefined {
  const full = url.toString();
  // The newest matching script wins, so a test can replace an earlier plant.
  for (let i = scripts.length - 1; i >= 0; i--) {
    const s = scripts[i]!;
    if (s.method && s.method.toUpperCase() !== method) continue;
    if (s.match === "url" && s.key === full) return s;
    if (s.match === "prefix" && full.startsWith(s.key)) return s;
    if (s.match === "host" && s.key === url.host) return s;
  }
  return undefined;
}

async function control(request: Request, url: URL): Promise<Response> {
  if (url.pathname === "/script" && request.method === "POST") {
    const body = (await request.json()) as OutboundScript | OutboundScript[];
    for (const s of Array.isArray(body) ? body : [body]) scripts.push(s);
    return json({ ok: true, scripts: scripts.length });
  }
  if (url.pathname === "/unscript" && request.method === "POST") {
    const { key } = (await request.json()) as { key: string };
    for (let i = scripts.length - 1; i >= 0; i--) if (scripts[i]!.key === key) scripts.splice(i, 1);
    return json({ ok: true });
  }
  if (url.pathname === "/log") {
    // Test files run at the same time against this one log, so a reader filters by something only it uses
    // (a host it made up, or a marker in the URL, headers or body). Reading does not clear the log. An entry
    // whose body could not be read, or was cut at BODY_LIMIT_BYTES, is returned for every `contains` filter:
    // what it carried beyond what was kept is unknown, so the reader sees it and its flags.
    const host = url.searchParams.get("host");
    const contains = url.searchParams.get("contains");
    const after = Number(url.searchParams.get("after") ?? 0);
    const found = log.filter((e) => e.seq > after && (!host || e.host === host) && (!contains || e.bodyUnreadable === true || e.bodyTruncated || e.url.includes(contains) || e.body.includes(contains) || JSON.stringify(e.headers).includes(contains)));
    return json({ seq, evictedThrough, entries: found });
  }
  return json({ error: "not part of the adversarial fixture" }, 404);
}

/**
 * The other suites' control routes: the journey suite's whole control origin, and exactly `/__calls` and
 * `/__reject` of the Worker package's Google fixture. Their callers (the journey helpers) carry no key, so
 * a request there cannot be told apart from one the Worker makes: each is LOGGED like any other outbound
 * request (marked `fixture-control`) and then served, so whatever it carried is visible to the assertions.
 */
function isOtherSuiteControl(url: URL): boolean {
  if (url.origin === JOURNEY_FIXTURE_ORIGIN) return true;
  return url.origin === GOOGLE_FIXTURE_ORIGIN && (url.pathname === "/__calls" || url.pathname === "/__reject");
}

async function bodyOf(request: Request): Promise<{ body: string; bodyBytes: number; bodyTruncated: boolean; bodyUnreadable?: boolean }> {
  if (request.method === "GET" || request.method === "HEAD") return { body: "", bodyBytes: 0, bodyTruncated: false };
  try {
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const bodyTruncated = bytes.byteLength > BODY_LIMIT_BYTES;
    return { body: new TextDecoder().decode(bodyTruncated ? bytes.subarray(0, BODY_LIMIT_BYTES) : bytes), bodyBytes: bytes.byteLength, bodyTruncated };
  } catch {
    // Not inspected, so not known to be empty: flagged, and returned for every `contains` read of the log.
    return { body: "<unreadable body>", bodyBytes: -1, bodyTruncated: true, bodyUnreadable: true };
  }
}

export async function adversarialOutbound(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin === ADVERSARIAL_FIXTURE_ORIGIN && request.headers.get(CONTROL_HEADER) === CONTROL_KEY) return control(request, url);
  const otherControl = isOtherSuiteControl(url);

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
  const read = await bodyOf(request);
  const entry: OutboundLogEntry = { seq: ++seq, method: request.method, url: url.toString(), host: url.host, headers, body: read.body, bodyBytes: read.bodyBytes, bodyTruncated: read.bodyTruncated, ...(read.bodyUnreadable ? { bodyUnreadable: true } : {}), answeredBy: otherControl ? "fixture-control" : "passthrough", status: 0 };
  log.push(entry);
  if (log.length > LOG_LIMIT) {
    const dropped = log.splice(0, log.length - LOG_LIMIT);
    evictedThrough = dropped[dropped.length - 1]!.seq;
  }
  if (otherControl) {
    const response = await journeyOutbound(request);
    entry.status = response.status;
    return response;
  }

  const script = scriptFor(request.method, url);
  if (script) {
    entry.answeredBy = "scripted";
    entry.status = script.status ?? 200;
    const payload = script.bodyBase64 !== undefined ? Buffer.from(script.bodyBase64, "base64") : (script.body ?? "");
    const status = script.status ?? 200;
    return new Response(status === 204 || status === 304 || (status >= 300 && status < 400 && !payload) ? null : payload, { status, headers: script.headers ?? {} });
  }
  const response = await journeyOutbound(request);
  entry.status = response.status;
  return response;
}
