import { ApiException } from "../errors.ts";

/**
 * Validation of owner-supplied remote endpoints and provider redirects (specification sections 13
 * and 15): HTTPS only, no embedded credentials, and no loopback, private, link-local or metadata
 * destinations. The Worker also runs with `global_fetch_strictly_public`, so the platform refuses
 * private-network fetches even for a hostname that resolves somewhere it should not.
 */
const SECRET_PARAM = /(api[_-]?key|access[_-]?key|^key$|[_-]key$|token|secret|passw|pwd|credential|signature|^sig$|^auth|[_-]auth)/i;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".test", ".invalid", ".example", ".onion"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes.default.svc"]);

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

function isPublicIpv4(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

export interface EndpointCheck {
  ok: boolean;
  reason?: string;
}

export function checkRemoteUrl(input: string | URL, opts: { allowQuery?: boolean } = {}): EndpointCheck {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "https_required" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials_in_url" };
  if (url.port !== "" && url.port !== "443" && url.port !== "8443") return { ok: false, reason: "port_not_allowed" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) return { ok: false, reason: "ip_literal_not_allowed" }; // IPv6 literals are never needed for a named service
  const v4 = ipv4Octets(host);
  if (v4) return isPublicIpv4(v4) ? { ok: false, reason: "ip_literal_not_allowed" } : { ok: false, reason: "private_address" };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: "private_hostname" };
  if (!host.includes(".")) return { ok: false, reason: "private_hostname" };
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: "invalid_hostname" };
  if (!opts.allowQuery) for (const name of url.searchParams.keys()) if (SECRET_PARAM.test(name)) return { ok: false, reason: "secret_in_query" };
  return { ok: true };
}

const MESSAGES: Record<string, string> = {
  not_a_url: "that is not a valid URL",
  https_required: "the endpoint must use https",
  credentials_in_url: "the endpoint may not contain a username or password",
  port_not_allowed: "the endpoint uses a port that is not allowed",
  ip_literal_not_allowed: "the endpoint must be a named host, not an IP address",
  private_address: "the endpoint points at a private or local address",
  private_hostname: "the endpoint points at a private or local host",
  invalid_hostname: "the endpoint's host name is not valid",
  secret_in_query: "the endpoint contains a key in its address; enter the key as the connection's secret instead",
};

export function assertRemoteUrl(input: string | URL, what = "endpoint"): URL {
  const check = checkRemoteUrl(input);
  if (!check.ok) throw new ApiException("invalid_command", MESSAGES[check.reason!] ?? "the endpoint is not allowed", { what, reason: check.reason });
  return typeof input === "string" ? new URL(input) : input;
}

/** A URL safe to store, show and log: no userinfo and no secret-looking query parameters. */
export function redactUrl(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) if (SECRET_PARAM.test(name)) url.searchParams.set(name, "REDACTED");
    url.hash = "";
    return url.toString();
  } catch {
    return "(invalid URL)";
  }
}

/** Redact anything that looks like a credential from text that may reach a log or a diagnostic. */
export function redactText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, (m) => redactUrl(m))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 REDACTED")
    .replace(/\b(ya29\.|1\/\/|sk-|tvly-)[A-Za-z0-9._-]{8,}/g, "REDACTED");
}

/**
 * `fetch` for provider discovery and token endpoints: every request URL is validated and redirects
 * are not followed, so a provider cannot bounce the Worker to an internal address.
 */
export function guardedFetch(inner: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const check = checkRemoteUrl(url, { allowQuery: true });
    if (!check.ok) throw new ApiException("invalid_command", MESSAGES[check.reason!] ?? "that address is not allowed", { reason: check.reason });
    return inner(input as RequestInfo, { ...init, redirect: "error" });
  }) as typeof fetch;
}
