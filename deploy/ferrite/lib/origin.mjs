/**
 * Origins the Ferrite tooling accepts, and the form evidence may hold. The raw text must BE the origin, exactly as a
 * URL parser serialises it (optionally with one trailing slash): any userinfo (even an empty `@`), path (even one
 * that normalises away, such as `/x/..`), query or fragment (even an empty `?` or `#`), whitespace or line break, and
 * any non-canonical spelling is refused rather than silently normalised, so a token can never travel in an origin to
 * a request log or an evidence file. Every valid origin is accepted in its canonical form (IPv6 and fully qualified
 * names included).
 */

function canonical(raw, message) {
  const text = typeof raw === "string" ? raw : "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(message);
  }
  // Credentials in any spelling are refused outright, whatever the raw text looked like.
  if (url.username || url.password || text.includes("@")) throw new Error(message);
  const bare = text.endsWith("/") ? text.slice(0, -1) : text;
  if (url.origin === "null" || bare !== url.origin) throw new Error(message);
  return url;
}

const isLoopback = (hostname) => hostname === "localhost" || hostname === "localhost." || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);

/** The deployed app's origin: a bare https origin in canonical form. */
export function deployedOrigin(raw) {
  const message = "the deployed origin must be a bare https origin in canonical form (no userinfo, path, query or fragment)";
  const url = canonical(raw, message);
  if (url.protocol !== "https:") throw new Error(message);
  return url.origin;
}

/** A local origin for `verify.mjs --local --origin`: a bare http(s) origin on a loopback host, in canonical form. */
export function localOrigin(raw) {
  const message = "a local origin must be a bare http(s) origin on a loopback host in canonical form (no userinfo, path, query or fragment)";
  const url = canonical(raw, message);
  if (!/^https?:$/.test(url.protocol) || !isLoopback(url.hostname)) throw new Error(message);
  return url.origin;
}

/**
 * An origin as evidence records it: never the raw string, only `{ scheme, host, port }` taken from the parsed URL, and
 * only when the parsed URL carries no username or password (and the raw text no `@`); otherwise "unrecognised".
 */
export function originForEvidence(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (text.includes("@")) return "unrecognised";
  try {
    const url = new URL(text);
    if (url.origin === "null" || url.username || url.password) return "unrecognised";
    return { scheme: url.protocol.slice(0, -1), host: url.hostname, port: url.port ? Number(url.port) : null };
  } catch {
    return "unrecognised";
  }
}
