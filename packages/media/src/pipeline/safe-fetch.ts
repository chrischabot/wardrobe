/**
 * Fetching untrusted URLs (candidate product pages and images) with destination restrictions, redirect
 * checks, a timeout and a response size limit, so a supplied URL can never reach a private network
 * service or exhaust memory.
 *
 * Destination checks, at every hop: the URL's form (HTTPS, default port, no credentials, no literal
 * private address, no local-only name, no wildcard-DNS service that maps names onto arbitrary addresses),
 * and then the addresses the name actually RESOLVES to, through DNS over HTTPS: a public-looking name that
 * points at a private or local address is refused, and a name that cannot be resolved is refused (fail
 * closed). What this cannot rule out is a name whose answer changes between this check and the platform's
 * own connection (DNS rebinding); whether the Workers runtime itself refuses private destinations for
 * outbound fetch was NOT verified here and is on the live-verification list.
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
  // Public wildcard-DNS services whose names resolve to whatever address is written into them.
  if (/(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me|lacolhost\.com|yoogle\.com)$/.test(host)) return "private_or_local_host";
  const v4 = ipv4Parts(host);
  if (v4) return isPrivateV4(v4) ? "private_or_local_host" : null;
  // Numeric-looking hosts in other notations (hex, octal, a single integer) are refused outright.
  if (/^[0-9.x]+$/i.test(host) || /^0x/i.test(host)) return "private_or_local_host";
  return null;
}

/** Resolves a host name to the addresses it currently points at (IPv4 and IPv6, as text). Throws when it cannot. */
export type HostResolver = (host: string) => Promise<string[]>;

/** An IPv6 address as its eight 16-bit groups, whatever its written form (compressed, hex, dotted IPv4 tail), or null. */
export function parseIpv6(text: string): number[] | null {
  let a = text.trim().toLowerCase();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (a === "" || a.includes("%") || !/^[0-9a-f:.]+$/.test(a)) return null;
  // A dotted IPv4 tail stands for the last two groups.
  const lastColon = a.lastIndexOf(":");
  if (a.includes(".")) {
    const v4 = ipv4Parts(a.slice(lastColon + 1));
    if (!v4 || lastColon < 0) return null;
    a = `${a.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Whether a resolved address is private, local, link-local, shared, multicast or otherwise not a public
 * destination. IPv6 is judged on its parsed groups, so the form an address is written in (DNS answers use
 * the hex form) makes no difference. Only global unicast (2000::/3) is ever public, and within it and
 * around it every range that carries an IPv4 address inside (IPv4-mapped, NAT64, 6to4) is judged by that
 * IPv4 address, while tunnelling and documentation ranges are refused outright.
 */
export function isPrivateAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  const v4 = ipv4Parts(a);
  if (v4) return isPrivateV4(v4);
  if (!a.includes(":")) return true; // not an address at all: never treated as public
  const g = parseIpv6(a);
  if (!g) return true;
  const embedded = (hi: number, lo: number): boolean => isPrivateV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped): judged by the IPv4 address. Everything else under ::/96 (unspecified,
  // loopback, the deprecated IPv4-compatible form) is refused.
  if (zeroThrough(5) && g[5] === 0xffff) return embedded(g[6]!, g[7]!);
  if (zeroThrough(6)) return true;
  // 64:ff9b::/96 (well-known NAT64): judged by the IPv4 address. 64:ff9b:1::/48 (local-use NAT64): refused.
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 ? embedded(g[6]!, g[7]!) : true;
  // Only global unicast is public: this refuses fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64 and the rest.
  if ((g[0]! & 0xe000) !== 0x2000) return true;
  // 2002::/16 (6to4): the IPv4 address is in the next 32 bits.
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!);
  // 2001::/23 (IETF protocol assignments, including Teredo 2001::/32) and 2001:db8::/32 (documentation).
  if (g[0] === 0x2001 && (g[1]! < 0x200 || g[1] === 0xdb8)) return true;
  return false;
}

/**
 * A resolver over DNS-over-HTTPS (JSON form, `application/dns-json`, as served by Cloudflare's public
 * resolver). Asks for A and AAAA records and returns every address in the answers.
 */
export function createDohResolver(opts: { fetchImpl?: typeof fetch; endpoint?: string; timeoutMs?: number } = {}): HostResolver {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? "https://cloudflare-dns.com/dns-query";
  return async (host) => {
    const out: string[] = [];
    for (const type of ["A", "AAAA"] as const) {
      const response = await doFetch(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
      if (!response.ok) throw new Error(`DNS lookup failed (HTTP ${response.status})`);
      const body = (await response.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
      if (body.Status !== 0 && body.Status !== 3) throw new Error(`DNS lookup failed (status ${String(body.Status)})`);
      for (const answer of body.Answer ?? []) if ((answer.type === 1 || answer.type === 28) && typeof answer.data === "string") out.push(answer.data);
    }
    return out;
  };
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept: string;
  fetchImpl?: typeof fetch;
  /**
   * How host names are resolved for the address check. Default: DNS over HTTPS. `null` skips the address
   * check and must only be used where the transport cannot reach a network at all (fixture fetches in tests).
   */
  resolver?: HostResolver | null;
  /** When set, a response whose Content-Type does not match is refused instead of being read. */
  contentTypes?: RegExp;
}

export type SafeFetchResult = { ok: true; bytes: Uint8Array; contentType: string | null; finalUrl: string } | { ok: false; reason: string };

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const resolver = opts.resolver === undefined ? createDohResolver() : opts.resolver;
  let current = rawUrl;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const refusal = refuseUrl(current);
    if (refusal) return { ok: false, reason: `refused (${refusal.replace(/_/g, " ")})` };
    if (resolver) {
      // The name is public in form; now check where it actually points. Checked again at every redirect hop.
      let addresses: string[];
      try {
        addresses = await resolver(new URL(current).hostname.toLowerCase().replace(/\.$/, ""));
      } catch (e) {
        return { ok: false, reason: `refused (the host could not be resolved: ${String((e as Error)?.message ?? e).slice(0, 80)})` };
      }
      if (addresses.length === 0) return { ok: false, reason: "refused (the host does not resolve to any address)" };
      if (addresses.some(isPrivateAddress)) return { ok: false, reason: "refused (private or local host: the name resolves to a private or local address)" };
    }
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
    if (opts.contentTypes) {
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!opts.contentTypes.test(type)) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: `unexpected content type '${type.slice(0, 60) || "none"}'` };
      }
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

/** The default image fetcher: HTTPS only, public hosts only (by name and by resolved address), checked redirects, bounded time and size. */
export function createSafeImageFetcher(fetchImpl?: typeof fetch, resolver?: HostResolver | null): ImageFetcher {
  return {
    // The bytes are identified by sniffing, never by the declared type, so no content type is required here.
    fetchImage: (url, limits) => safeFetch(url, { maxBytes: limits.maxBytes, accept: "image/jpeg,image/png,image/webp;q=0.8", fetchImpl, ...(resolver !== undefined ? { resolver } : {}) }),
  };
}
