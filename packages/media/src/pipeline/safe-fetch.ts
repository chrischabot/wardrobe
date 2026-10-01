/**
 * Fetching untrusted URLs (candidate product pages and images) with destination restrictions, redirect
 * checks, a timeout and a response size limit, so a supplied URL can never reach a private network
 * service or exhaust memory.
 */
import type { ImageFetcher } from "../adapters.ts";

export type UrlRefusal = "not_a_url" | "scheme_not_https" | "credentials_in_url" | "non_default_port" | "private_or_local_host";

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isPrivateV4(p: number[]): boolean {
  const [a, b] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Returns why a URL may not be fetched, or null when it is acceptable. */
export function refuseUrl(raw: string): UrlRefusal | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not_a_url";
  }
  if (url.protocol !== "https:") return "scheme_not_https";
  if (url.username !== "" || url.password !== "") return "credentials_in_url";
  if (url.port !== "" && url.port !== "443") return "non_default_port";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost" || !host.includes(".") || host.startsWith("[") || host.includes(":")) return "private_or_local_host";
  if (/\.(local|localhost|internal|intranet|lan|home|corp|test|invalid|example|onion)$/.test(host)) return "private_or_local_host";
  const v4 = ipv4Parts(host);
  if (v4) return isPrivateV4(v4) ? "private_or_local_host" : null;
  // Numeric-looking hosts in other notations (hex, octal, a single integer) are refused outright.
  if (/^[0-9.x]+$/i.test(host) || /^0x/i.test(host)) return "private_or_local_host";
  return null;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept: string;
  fetchImpl?: typeof fetch;
}

export type SafeFetchResult = { ok: true; bytes: Uint8Array; contentType: string | null; finalUrl: string } | { ok: false; reason: string };

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let current = rawUrl;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const refusal = refuseUrl(current);
    if (refusal) return { ok: false, reason: `refused (${refusal.replace(/_/g, " ")})` };
    let response: Response;
    try {
      // Redirects are followed by hand so every hop is checked; no cookies or credentials are sent.
      response = await doFetch(current, { redirect: "manual", headers: { accept: opts.accept }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    } catch (e) {
      return { ok: false, reason: `request failed: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) return { ok: false, reason: "redirect without a location" };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: "redirect to an invalid location" };
      }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > opts.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "response larger than the size limit" };
    }
    if (!response.body) return { ok: false, reason: "empty response" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "response larger than the size limit" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return { ok: true, bytes, contentType: response.headers.get("content-type"), finalUrl: current };
  }
  return { ok: false, reason: "too many redirects" };
}

/** The default image fetcher: HTTPS only, public hosts only, checked redirects, bounded time and size. */
export function createSafeImageFetcher(fetchImpl?: typeof fetch): ImageFetcher {
  return {
    fetchImage: (url, limits) => safeFetch(url, { maxBytes: limits.maxBytes, accept: "image/jpeg,image/png,image/webp;q=0.8", fetchImpl }),
  };
}
