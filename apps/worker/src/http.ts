import { API_VERSION, CONTRACT_VERSION } from "@garderobe/contracts";
import type { z } from "zod";
import { ApiException, normalizeError } from "./errors.ts";

export const BASE_HEADERS: Record<string, string> = {
  "X-Garderobe-Api": API_VERSION,
  "X-Garderobe-Contract": CONTRACT_VERSION,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...BASE_HEADERS, ...headers } });
}

export function html(body: string, status = 200, headers: Record<string, string> | Headers = {}): Response {
  const merged = new Headers(headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) if (!merged.has(k)) merged.set(k, v);
  merged.set("Content-Type", "text/html; charset=utf-8");
  if (!merged.has("Content-Security-Policy")) merged.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (!merged.has("X-Frame-Options")) merged.set("X-Frame-Options", "DENY");
  return new Response(body, { status, headers: merged });
}

export function errorResponse(error: unknown, onInternal?: (e: unknown) => void): Response {
  const n = normalizeError(error);
  if (n.code === "internal") onInternal?.(error);
  return json({ error: { code: n.code, message: n.message, details: n.details } }, n.status, n.headers);
}

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Parse a JSON body against a schema. Bodies are bounded; a parse failure is `invalid_command`. */
export async function readJson<S extends z.ZodType>(request: Request, schema: S, maxBytes = 1_000_000): Promise<z.output<S>> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new ApiException("unsupported_media_type", "the request body must be application/json");
  const text = await readText(request, maxBytes);
  let value: unknown;
  try {
    value = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new ApiException("invalid_command", "the request body is not valid JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiException("invalid_command", "the request body is invalid", { issues: parsed.error.issues });
  return parsed.data;
}

export async function readText(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBytes(request, maxBytes));
}

/** Read a bounded body; more than `maxBytes` is refused without buffering the rest. */
export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new ApiException("payload_too_large", `the request body exceeds ${maxBytes} bytes`);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiException("payload_too_large", `the request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Parse the query string against a schema (values are strings; schemas coerce what they need). */
export function readQuery<S extends z.ZodType>(url: URL, schema: S): z.output<S> {
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams) raw[k] = v;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiException("invalid_command", "the query string is invalid", { issues: parsed.error.issues });
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Router                                                               */
/* ------------------------------------------------------------------ */

export interface RouteMatch<H> {
  handler: H;
  params: Record<string, string>;
  template: string;
}

interface CompiledRoute<H> {
  method: string;
  template: string;
  segments: string[];
  handler: H;
}

/** Exact, segment-wise router over `{name}` templates. There is no wildcard and no prefix matching. */
export class Router<H> {
  private readonly routes: CompiledRoute<H>[] = [];

  add(method: string, template: string, handler: H): this {
    if (this.routes.some((r) => r.method === method && r.template === template)) throw new Error(`duplicate route ${method} ${template}`);
    this.routes.push({ method, template, segments: template.split("/"), handler });
    return this;
  }

  list(): { method: string; template: string }[] {
    return this.routes.map((r) => ({ method: r.method, template: r.template }));
  }

  /** Returns the match, `method_not_allowed` when only the path matches, or null. */
  match(method: string, pathname: string): RouteMatch<H> | "method_not_allowed" | null {
    const parts = pathname.split("/");
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith("{") && seg.endsWith("}")) {
          if (part.length === 0) {
            ok = false;
            break;
          }
          let decoded: string;
          try {
            decoded = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
          params[seg.slice(1, -1)] = decoded;
        } else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method === method) return { handler: route.handler, params, template: route.template };
      pathMatched = true;
    }
    return pathMatched ? "method_not_allowed" : null;
  }
}
