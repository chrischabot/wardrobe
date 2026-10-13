/**
 * URL policy for web research: SSRF guard, canonical form for source
 * de-duplication, and secret redaction for transcripts and telemetry.
 * Web APIs only (URL, URLSearchParams).
 */

export type UrlPolicyErrorCode =
  | "invalid_url"
  | "scheme_not_https"
  | "userinfo_not_allowed"
  | "port_not_allowed"
  | "host_not_public"
  | "ip_not_public";

export class UrlPolicyError extends Error {
  readonly code: UrlPolicyErrorCode;

  constructor(code: UrlPolicyErrorCode, message: string) {
    super(message);
    this.name = "UrlPolicyError";
    this.code = code;
  }
}

const BLOCKED_HOST_NAMES = new Set(["localhost"]);
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost"];

export function parseDottedIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

/** True when the IPv4 address is loopback, private, link-local, CGNAT, metadata or otherwise non-public. */
export function isNonPublicIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local incl. metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Parses the inside of a bracketed IPv6 literal into eight 16-bit groups. */
export function parseIpv6(literal: string): number[] | null {
  let text = literal;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  // An embedded dotted IPv4 tail becomes two hex groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseDottedIpv4(tail);
    if (!v4) return null;
    const high = ((v4[0] << 8) | v4[1]).toString(16);
    const low = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? "");
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] ?? "");
  if (!rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function embeddedIpv4(groups: readonly number[]): [number, number, number, number] {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** True when the IPv6 address (eight groups) is loopback, unique-local, link-local or wraps a non-public IPv4. */
export function isNonPublicIpv6(groups: readonly number[]): boolean {
  const first = groups[0] ?? 0;
  const leadingZero = (count: number): boolean => groups.slice(0, count).every((group) => group === 0);
  if (leadingZero(8)) return true; // :: unspecified
  if (leadingZero(7) && groups[7] === 1) return true; // ::1 loopback
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (leadingZero(5) && groups[5] === 0xffff) return isNonPublicIpv4(embeddedIpv4(groups)); // ::ffff:a.b.c.d
  if (leadingZero(6)) return isNonPublicIpv4(embeddedIpv4(groups)); // deprecated IPv4-compatible
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return isNonPublicIpv4(embeddedIpv4(groups)); // NAT64 64:ff9b::/96
  }
  if (first === 0x2002) {
    const g1 = groups[1] ?? 0;
    const g2 = groups[2] ?? 0;
    return isNonPublicIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]); // 6to4
  }
  return false;
}

/**
 * SSRF guard. Returns the normalized URL string when the URL is a public
 * HTTPS address; throws UrlPolicyError otherwise. Numeric IPv4 spellings
 * (decimal, hex, octal) are normalized by `new URL` before the range check.
 * This validates the literal URL only; DNS resolution is the fetcher's concern.
 */
export function assertPublicHttpsUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlPolicyError("invalid_url", "URL could not be parsed");
  }
  if (parsed.protocol !== "https:") {
    throw new UrlPolicyError("scheme_not_https", "Only https URLs are allowed");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new UrlPolicyError("userinfo_not_allowed", "URLs with user information are not allowed");
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    throw new UrlPolicyError("port_not_allowed", "Only the default HTTPS port is allowed");
  }

  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") {
    throw new UrlPolicyError("invalid_url", "URL has no host");
  }

  if (host.startsWith("[") && host.endsWith("]")) {
    const groups = parseIpv6(host.slice(1, -1));
    if (!groups || isNonPublicIpv6(groups)) {
      throw new UrlPolicyError("ip_not_public", "IPv6 address is not a public address");
    }
    return parsed.toString();
  }

  const v4 = parseDottedIpv4(host);
  if (v4) {
    if (isNonPublicIpv4(v4)) {
      throw new UrlPolicyError("ip_not_public", "IPv4 address is not a public address");
    }
    return parsed.toString();
  }

  if (BLOCKED_HOST_NAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UrlPolicyError("host_not_public", "Host name is reserved for local or internal use");
  }
  if (!host.includes(".")) {
    throw new UrlPolicyError("host_not_public", "Single-label host names are not public");
  }
  return parsed.toString();
}

const TRACKING_PARAMS = new Set(["gclid", "fbclid", "mc_cid", "mc_eid", "ref"]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/**
 * Canonical form used to de-duplicate sources: lowercase host, no fragment,
 * no tracking parameters, remaining parameters sorted, no trailing slash.
 */
export function canonicalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlPolicyError("invalid_url", "URL could not be parsed");
  }
  const kept: [string, string][] = [];
  for (const [name, value] of parsed.searchParams) {
    if (!isTrackingParam(name)) kept.push([name, value]);
  }
  kept.sort((left, right) => {
    if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
    if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
    return 0;
  });
  const query = new URLSearchParams(kept).toString();
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${query === "" ? "" : `?${query}`}`;
}

const SECRET_PARAMS = new Set([
  "api_key",
  "apikey",
  "key",
  "token",
  "access_token",
  "auth",
  "secret",
  "signature",
  "tavilyapikey",
  "exaapikey",
]);

export const REDACTED = "REDACTED";

const SECRET_PARAM_PATTERN = new RegExp(`([?&;](?:${[...SECRET_PARAMS].join("|")})=)[^&#;\\s]*`, "gi");

/**
 * Removes user information and replaces the value of key-bearing query
 * parameters with REDACTED, so a key-bearing URL never reaches a transcript,
 * telemetry or model context. Unparseable input is redacted textually.
 */
export function redactSecretsInUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.replace(/\/\/[^/@\s]*@/, "//").replace(SECRET_PARAM_PATTERN, `$1${REDACTED}`);
  }
  parsed.username = "";
  parsed.password = "";
  const names = new Set<string>();
  for (const name of parsed.searchParams.keys()) names.add(name);
  for (const name of names) {
    if (SECRET_PARAMS.has(name.toLowerCase())) parsed.searchParams.set(name, REDACTED);
  }
  return parsed.toString();
}
