/**
 * Destination policy for every outbound URL: owner-added MCP endpoints, OAuth redirects, product
 * URLs, extraction targets (spec sections 13 and 15). Blocks loopback, private and link-local
 * ranges, cloud metadata endpoints, internal hostnames, embedded credentials, non-HTTPS schemes and
 * numeric IP encodings that disguise those ranges. Redirects are re-validated hop by hop.
 */

export class UrlPolicyError extends Error {
  readonly code = 'url_blocked';
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'UrlPolicyError';
  }
}

const BLOCKED_HOSTS = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal', 'metadata.azure.com', 'kubernetes.default', 'kubernetes.default.svc']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.localdomain', '.home.arpa'];

/** Parse dotted, decimal, hex and octal IPv4 forms (inet_aton semantics). */
export function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!p.length) return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  // Expand shorthand (a, a.b, a.b.c) to four octets.
  const last = nums.pop()!;
  const head = nums;
  const lastBytes = 4 - head.length;
  if (head.some((x) => x > 255) || last >= 2 ** (8 * lastBytes)) return null;
  const tail: number[] = [];
  for (let i = lastBytes - 1; i >= 0; i--) tail.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return [...head, ...tail];
}

function ipv4Blocked(o: number[]): string | null {
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return 'unspecified address';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private network';
  if (a === 172 && b >= 16 && b <= 31) return 'private network';
  if (a === 192 && b === 168) return 'private network';
  if (a === 169 && b === 254) return 'link-local / metadata';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT';
  if (a === 192 && b === 0 && o[2] === 0) return 'IETF protocol assignments';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark network';
  if (a >= 224) return 'multicast or reserved';
  return null;
}

/** Parse an IPv6 literal (with :: compression and an optional trailing dotted quad) to eight 16-bit groups. */
export function parseIpv6(host: string): number[] | null {
  let h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(h)) return null;
  let tail: number[] = [];
  const dotted = h.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const o = dotted[2]!.split('.').map(Number);
    if (o.some((x) => !Number.isInteger(x) || x > 255)) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    h = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string) => (s ? s.split(':') : []).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...rest].some((g) => Number.isNaN(g))) return null;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...tail];
}

const v4Of = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function ipv6Blocked(host: string): string | null {
  const g = parseIpv6(host);
  if (!g) return 'invalid IPv6 address';
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return 'unspecified address';
  if (zero(0, 7) && g[7] === 1) return 'loopback';
  const embedded = (o: number[], form: string): string | null => {
    const why = ipv4Blocked(o);
    return why ? `${why} (${form})` : null;
  };
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d, IPv4-compatible ::a.b.c.d.
  if (zero(0, 5) && g[5] === 0xffff) return embedded(v4Of(g[6]!, g[7]!), 'IPv4-mapped');
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return embedded(v4Of(g[6]!, g[7]!), 'IPv4-translated');
  if (zero(0, 6)) return embedded(v4Of(g[6]!, g[7]!), 'IPv4-compatible');
  // NAT64 well-known prefix 64:ff9b::/96; the local-use prefix 64:ff9b:1::/48 is private by definition.
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embedded(v4Of(g[6]!, g[7]!), 'NAT64');
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'local-use NAT64';
  // 6to4 2002:a.b.c.d::/48.
  if (g[0] === 0x2002) return embedded(v4Of(g[1]!, g[2]!), '6to4');
  // Teredo 2001:0::/32: server IPv4 in groups 2-3, client IPv4 obfuscated (bitwise NOT) in groups 6-7.
  if (g[0] === 0x2001 && g[1] === 0) return embedded(v4Of(g[2]!, g[3]!), 'Teredo server') ?? embedded(v4Of(~g[6]! & 0xffff, ~g[7]! & 0xffff), 'Teredo client');
  if (g[0] === 0x2001 && g[1] === 0xdb8) return 'documentation range';
  if (g[0] === 0x100 && zero(1, 4)) return 'discard-only range';
  if ((g[0]! & 0xfe00) === 0xfc00) return 'unique local address';
  if ((g[0]! & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0]! & 0xffc0) === 0xfec0) return 'site-local';
  if ((g[0]! & 0xff00) === 0xff00) return 'multicast';
  return null;
}

export interface UrlPolicyOptions {
  /** Allow http: (never for credentials-bearing connections). Default false. */
  allowHttp?: boolean;
}

export function validateOutboundUrl(raw: string, opts: UrlPolicyOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlPolicyError('Not a valid URL', 'invalid');
  }
  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) throw new UrlPolicyError('Only HTTPS destinations are allowed', 'scheme');
  if (url.username || url.password) throw new UrlPolicyError('URLs with embedded credentials are not allowed', 'credentials');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new UrlPolicyError('Missing host', 'invalid');
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw new UrlPolicyError(`Destination ${host} is an internal host`, 'internal_host');
  if (host.startsWith('[') || host.includes(':')) {
    const why = ipv6Blocked(host);
    if (why) throw new UrlPolicyError(`Destination is a ${why} address`, why);
    return url;
  }
  const v4 = parseIpv4(host);
  if (v4) {
    const why = ipv4Blocked(v4);
    if (why) throw new UrlPolicyError(`Destination is a ${why} address`, why);
  } else if (/^[0-9.x]+$/i.test(host)) {
    throw new UrlPolicyError('Unparseable numeric host', 'invalid');
  }
  if (!host.includes('.')) throw new UrlPolicyError('Single-label hosts are not allowed', 'internal_host');
  return url;
}

export interface SafeFetchOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  init?: RequestInit;
}

/** Fetch with destination checks on every redirect hop, a timeout and a response size cap. */
export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<{ url: string; status: number; headers: Headers; body: string; truncated: boolean }> {
  const doFetch = opts.fetch ?? fetch;
  let current = validateOutboundUrl(raw).toString();
  const maxRedirects = opts.maxRedirects ?? 5;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await doFetch(current, { ...(opts.init ?? {}), redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = validateOutboundUrl(new URL(res.headers.get('location')!, current).toString()).toString();
      continue;
    }
    const max = opts.maxBytes ?? 2_000_000;
    const text = await res.text();
    return { url: current, status: res.status, headers: res.headers, body: text.slice(0, max), truncated: text.length > max };
  }
  throw new UrlPolicyError('Too many redirects', 'redirects');
}
