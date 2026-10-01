import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { configOf, type Env } from "../env.ts";
import { ApiException } from "../errors.ts";

/**
 * Cloudflare Access assertion verification (specification section 15).
 *
 * Access authenticates the person (Google as identity provider) and sends a signed JWT to the origin
 * in `Cf-Access-Jwt-Assertion` (and the `CF_Authorization` cookie for browser sessions). The Worker
 * verifies signature, issuer, audience and expiry against the team's public keys and uses ONLY
 * `(iss, sub)` as identity. The email claim is a display attribute. A header that does not verify is
 * worth nothing, whichever hostname the request arrived on.
 */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  /** Display/contact attribute only. */
  email: string | null;
  /** When this session was authenticated (ms). */
  issuedAtMs: number;
  expiresAtMs: number;
  /** Where the assertion was read from. A cookie means a browser session. */
  via: "header" | "cookie";
  hasCookie: boolean;
}

const keySets = new WeakMap<object, JWTVerifyGetKey>();

function keySetFor(env: Env): JWTVerifyGetKey {
  const cached = keySets.get(env);
  if (cached) return cached;
  const config = configOf(env);
  let getKey: JWTVerifyGetKey;
  if (env.ACCESS_JWKS_JSON) {
    // configOf() already refused this outside local/test environments.
    getKey = createLocalJWKSet(JSON.parse(env.ACCESS_JWKS_JSON));
  } else {
    getKey = createRemoteJWKSet(new URL(`${config.accessIssuer}/cdn-cgi/access/certs`), { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  }
  keySets.set(env, getKey);
  return getKey;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Verify the Access assertion of a request. Throws `unauthenticated`; never falls back to another credential. */
export async function verifyAccessAssertion(request: Request, env: Env): Promise<VerifiedIdentity> {
  const config = configOf(env);
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  const cookie = cookieValue(request, "CF_Authorization");
  // Local run mode has no Access edge to turn the app's bearer token into an assertion header, so a
  // bearer value is read as the assertion there. It is verified exactly like the header; outside
  // local/test environments a bearer token is never looked at.
  const bearer = config.isLocal ? (/^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "")?.[1] ?? null) : null;
  const token = header ?? cookie ?? bearer;
  if (!token) throw new ApiException("unauthenticated", "sign in to continue", { reason: "missing_assertion" });
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, keySetFor(env), {
      issuer: config.accessIssuer,
      audience: config.accessAudiences,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["sub", "iat", "exp"],
      clockTolerance: 5,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (error) {
    const reason = (error as { code?: string }).code === "ERR_JWT_EXPIRED" ? "expired" : "invalid_assertion";
    throw new ApiException("unauthenticated", reason === "expired" ? "your session has expired; sign in again" : "sign in to continue", { reason });
  }
  const subject = typeof payload.sub === "string" ? payload.sub : "";
  // Service tokens and other non-identity assertions carry no subject: they are not a person.
  if (!subject) throw new ApiException("unauthenticated", "sign in to continue", { reason: "not_an_identity" });
  return {
    issuer: String(payload.iss),
    subject,
    email: typeof payload.email === "string" ? payload.email : null,
    issuedAtMs: Number(payload.iat) * 1000,
    expiresAtMs: Number(payload.exp) * 1000,
    via: header || bearer ? "header" : "cookie",
    hasCookie: cookie !== null,
  };
}
