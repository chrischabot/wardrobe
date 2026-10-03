/**
 * Where a host name actually leads. The URL policy (url.ts) judges the address as written; a name that
 * looks public can still resolve to a private, loopback or link-local address. Before a request that
 * carries a credential is sent to an owner-supplied host, the name is resolved here and refused unless
 * every address it resolves to is public. It fails closed: no answer, an unreadable answer or a failed
 * lookup is a refusal.
 *
 * Known limit: the name is resolved here and again by the platform when the request is sent, so a name
 * whose answer changes between the two (DNS rebinding) is not ruled out by this check alone.
 */
import { isNonPublicIpv4, parseDottedIpv4, parseIpv6 } from "./url.ts";

/** Resolves a host name to every address it has (IPv4 and IPv6). Throws when the lookup itself fails. */
export type HostResolver = (host: string) => Promise<string[]>;

/**
 * Whether a RESOLVED address is a public destination. Stricter than the literal check in url.ts: for IPv6
 * only global unicast (2000::/3) is public, every form that carries an IPv4 address inside (IPv4-mapped,
 * NAT64, 6to4) is judged by that IPv4 address, and tunnelling and documentation ranges are refused.
 * Anything that is not an address at all is not public.
 */
export function isPublicResolvedAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  const v4 = parseDottedIpv4(a);
  if (v4) return !isNonPublicIpv4(v4);
  if (!a.includes(":")) return false;
  const g = parseIpv6(a);
  if (!g || g.length !== 8) return false;
  const at = (n: number) => g[n] ?? 0;
  const embedded = (hi: number, lo: number): boolean => !isNonPublicIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped): judged by the IPv4 address. The rest of ::/96 (unspecified, loopback, IPv4-compatible) is refused.
  if (zeroThrough(5) && at(5) === 0xffff) return embedded(at(6), at(7));
  if (zeroThrough(6)) return false;
  // 64:ff9b::/96 (well-known NAT64): judged by the IPv4 address; 64:ff9b:1::/48 (local use) is refused.
  if (at(0) === 0x64 && at(1) === 0xff9b) return g.slice(2, 6).every((x) => x === 0) ? embedded(at(6), at(7)) : false;
  // Only global unicast is public: refuses fc00::/7, fe80::/10, fec0::/10, ff00::/8, 100::/64 and the rest.
  if ((at(0) & 0xe000) !== 0x2000) return false;
  // 2002::/16 (6to4): the IPv4 address is in the next 32 bits.
  if (at(0) === 0x2002) return embedded(at(1), at(2));
  // 2001::/23 (protocol assignments, including Teredo) and 2001:db8::/32 (documentation).
  if (at(0) === 0x2001 && (at(1) < 0x200 || at(1) === 0xdb8)) return false;
  return true;
}

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/**
 * A resolver over DNS-over-HTTPS in its JSON form (`application/dns-json`, as served by Cloudflare's
 * public resolver): asks for A and AAAA records and returns every address in the answers. The same
 * resolver and request form as the image search's (packages/media/src/pipeline/safe-fetch.ts). It carries
 * no credential. NEVER RUN AGAINST THE REAL RESOLVER from this repository; tested with a fake `fetch`.
 */
export function createDohResolver(doFetch: typeof fetch, opts: { endpoint?: string; timeoutMs?: number } = {}): HostResolver {
  const endpoint = opts.endpoint ?? DOH_ENDPOINT;
  return async (host) => {
    const out: string[] = [];
    for (const type of ["A", "AAAA"] as const) {
      const response = await doFetch(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, { method: "GET", redirect: "manual", headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
      if (response.status !== 200) throw new Error(`DNS lookup failed (HTTP ${response.status})`);
      const body = (await response.json()) as { Status?: unknown; Answer?: unknown };
      // 0 is an answer, 3 is "no such name"; anything else is a failed lookup, never "no addresses".
      if (body.Status !== 0 && body.Status !== 3) throw new Error(`DNS lookup failed (status ${String(body.Status)})`);
      for (const answer of Array.isArray(body.Answer) ? (body.Answer as { type?: unknown; data?: unknown }[]) : []) {
        if ((answer?.type === 1 || answer?.type === 28) && typeof answer.data === "string") out.push(answer.data);
      }
    }
    return out;
  };
}

/**
 * Why a host must not be contacted, or null when every address it resolves to is public. A host written
 * as an IP address is not looked up (url.ts has already judged it).
 */
export async function refusalForHost(host: string, resolver: HostResolver): Promise<string | null> {
  const name = host.toLowerCase().replace(/\.+$/, "");
  if (name.startsWith("[") || parseDottedIpv4(name)) return null;
  let addresses: string[];
  try {
    addresses = await resolver(name);
  } catch {
    return "its address could not be looked up";
  }
  if (addresses.length === 0) return "its name does not resolve to any address";
  if (!addresses.every(isPublicResolvedAddress)) return "its name resolves to a private or local address";
  return null;
}
