/**
 * Cassette recorder for the iOS client's fixtures.
 *
 * Every exchange is a real request to the real Worker through `SELF.fetch` (see
 * `@garderobe/worker/testing`). The recorder only writes down what was asked and what was
 * answered, in the format `GarderobeKit/Fixture/FixtureBackend.swift` replays. It never edits a
 * response.
 */
import { SELF } from "cloudflare:test";
import { APP_ORIGIN, type ApiClient } from "@garderobe/worker/testing";

export interface Exchange {
  status: number;
  body?: unknown;
  bodyBase64?: string;
  contentType?: string;
}

interface Step {
  id: string;
  request?: { method: string; path: string; body?: unknown };
  response?: Exchange;
  reads: Record<string, Exchange>;
  posts?: { path: string; body?: unknown; response: Exchange }[];
}

export interface Provenance {
  profileSha256: string;
  inventorySha256: string;
  contractVersion: string;
  generator: string;
  backend: string;
  notes: string[];
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

async function capture(response: Response): Promise<Exchange> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("json")) {
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) return { status: response.status, body: null };
  return { status: response.status, bodyBase64: toBase64(bytes), contentType };
}

/** `GET /path?a=1&b=2` with the query sorted: the key FixtureBackend.key() computes. */
export function readKey(method: string, path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
  const items = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return `${method} ${path}${items.length > 0 ? `?${items.join("&")}` : ""}`;
}

function withQuery(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const text = params.toString();
  return text.length > 0 ? `${path}?${text}` : path;
}

export class Recorder {
  private steps: Step[] = [{ id: "start", reads: {} }];
  readonly startedAt = new Date();

  constructor(
    readonly name: string,
    private api: ApiClient,
    private provenance: Provenance,
    private timezone: string,
  ) {}

  private get current(): Step {
    return this.steps[this.steps.length - 1]!;
  }

  /** Use another signed-in client from here on (for example a new identity during recovery). */
  use(api: ApiClient): void {
    this.api = api;
  }

  /** Records a GET as it is answered at this point of the journey. Returns the parsed body. */
  async get<T = any>(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const exchange = await capture(await this.api.get(withQuery(path, query)));
    this.current.reads[readKey("GET", path, query)] = exchange;
    return exchange.body as T;
  }

  /** Records a GET made WITHOUT the sign-in (a signed image address carries its own authority). */
  async getPublic(pathWithQuery: string): Promise<Exchange> {
    const exchange = await capture(await SELF.fetch(`${APP_ORIGIN}${pathWithQuery}`));
    const [path, query = ""] = pathWithQuery.split("?");
    const items = query.length > 0 ? query.split("&").map((item) => decodeURIComponent(item)).sort() : [];
    this.current.reads[`GET ${path}${items.length > 0 ? `?${items.join("&")}` : ""}`] = exchange;
    return exchange;
  }

  /** Records a POST that changes nothing (validation, suggestion, search). */
  async post<T = any>(path: string, body: unknown): Promise<T> {
    const exchange = await capture(await this.api.post(path, body));
    (this.current.posts ??= []).push({ path, body, response: exchange });
    return exchange.body as T;
  }

  /** Records a state-changing request as the next step of the journey. Returns the parsed answer. */
  async change<T = any>(id: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.api.request(method, path, body === undefined ? {} : { body });
    const exchange = await capture(response);
    this.steps.push({ id, request: { method, path, ...(body === undefined ? {} : { body }) }, response: exchange, reads: {} });
    return exchange.body as T;
  }

  /** A command through POST /v1/commands, shaped exactly like the envelope the iOS client sends. */
  async command<T = any>(id: string, type: string, payload: Record<string, unknown>, expectedVersions: Record<string, number> = {}, source: Record<string, unknown> = {}): Promise<T> {
    const key = `ios-fixture-${crypto.randomUUID()}`;
    const envelope: Record<string, unknown> = {
      type,
      payload,
      idempotencyKey: key,
      occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      authorization: "owner_tap",
      source: { channel: "ios", clientSubmissionId: key, ...source },
    };
    if (Object.keys(expectedVersions).length > 0) envelope.expectedVersions = expectedVersions;
    return this.change<T>(id, "POST", "/v1/commands", envelope);
  }

  /** Records a run's retained server-sent events (the stream is read to its end with follow=false). */
  async stream(path: string): Promise<{ id: number; event: string; data: any }[]> {
    const response = await this.api.get(`${path}?follow=false`, { Accept: "text/event-stream" });
    const text = await response.text();
    const events: { id: number; event: string; data: any }[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      let id = 0;
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("id:")) id = Number(line.slice(3).trim());
        else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length > 0) events.push({ id, event, data: JSON.parse(data.join("\n")) });
    }
    this.current.reads[`STREAM ${path}`] = { status: response.status, body: events };
    return events;
  }

  /** Records a state-changing request with a binary body (an upload). The query is part of the address, not of the step identity. */
  async changeRaw<T = any>(id: string, method: string, pathWithQuery: string, bytes: Uint8Array, headers: Record<string, string>, authenticated: boolean): Promise<T> {
    const response = authenticated
      ? await this.api.request(method, pathWithQuery, { raw: bytes, headers })
      : await SELF.fetch(`${APP_ORIGIN}${pathWithQuery}`, { method, headers, body: bytes });
    const exchange = await capture(response);
    this.steps.push({ id, request: { method, path: pathWithQuery.split("?")[0]! }, response: exchange, reads: {} });
    return exchange.body as T;
  }

  /** Adds a step that only carries data the replaying test needs (never sent to or answered by the backend). */
  note(id: string, body: unknown): void {
    this.steps.push({ id, response: { status: 0, body }, reads: {} });
  }

  /** The cassette as JSON, one step per line. */
  render(): string {
    const head = JSON.stringify({ format: 1, name: this.name, provenance: this.provenance, clock: this.startedAt.toISOString().replace(/\.\d{3}Z$/, "Z"), timezone: this.timezone });
    return `${head.slice(0, -1)},"steps":[\n${this.steps.map((s) => JSON.stringify(s)).join(",\n")}\n]}\n`;
  }
}
