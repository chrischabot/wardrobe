import type { Scope } from "@garderobe/contracts";
import type { RouteTrust } from "@garderobe/contracts/ext/api";
import { requireScope } from "@garderobe/domain";
import type { App } from "./app.ts";
import type { VerifiedIdentity } from "./auth/access.ts";
import { authenticateIdentity, authenticateOwner, type OwnerSession } from "./auth/session.ts";
import { ApiException } from "./errors.ts";
import { BASE_HEADERS, Router, errorResponse } from "./http.ts";

export interface Ctx {
  app: App;
  request: Request;
  url: URL;
  params: Record<string, string>;
  exec: ExecutionContext;
}
export interface OwnerCtx extends Ctx {
  session: OwnerSession;
}
export interface IdentityCtx extends Ctx {
  identity: VerifiedIdentity;
}

export type RouteDef =
  | { method: string; path: string; trust: "access"; scope: Scope; handler: (ctx: OwnerCtx) => Promise<Response> }
  | { method: string; path: string; trust: "access_identity"; scope: null; handler: (ctx: IdentityCtx) => Promise<Response> }
  | { method: string; path: string; trust: "one_time_state" | "ticket"; scope: null; handler: (ctx: Ctx) => Promise<Response> };

export const owner = (method: string, path: string, scope: Scope, handler: (ctx: OwnerCtx) => Promise<Response>): RouteDef => ({ method, path, trust: "access", scope, handler });
export const identityOnly = (method: string, path: string, handler: (ctx: IdentityCtx) => Promise<Response>): RouteDef => ({ method, path, trust: "access_identity", scope: null, handler });
export const selfAuthenticated = (method: string, path: string, trust: "one_time_state" | "ticket", handler: (ctx: Ctx) => Promise<Response>): RouteDef => ({ method, path, trust, scope: null, handler });

export class AppRouter {
  private readonly router = new Router<RouteDef>();

  constructor(defs: RouteDef[]) {
    for (const def of defs) this.router.add(def.method, def.path, def);
  }

  /** Method, path template and trust of every mounted route (tested against the published manifest). */
  manifest(): { method: string; path: string; trust: RouteTrust; scope: Scope | null }[] {
    return this.router.list().map((r) => {
      const match = this.router.match(r.method, r.template.replace(/\{[^}]+\}/g, "x"));
      const def = (match as { handler: RouteDef }).handler;
      return { method: r.method, path: r.template, trust: def.trust, scope: def.scope };
    });
  }

  /**
   * Serve an application route. Trust is decided by the route, not by the caller:
   *  - `access` and `access_identity` routes are served only on the app hostname and only with a
   *    verified Access assertion; reaching them through the MCP hostname (which is not behind Access)
   *    is refused before any assertion is looked at;
   *  - `one_time_state` and `ticket` routes authenticate themselves from stored single-use state.
   */
  async handle(app: App, request: Request, exec: ExecutionContext): Promise<Response | null> {
    const url = new URL(request.url);
    const match = this.router.match(request.method, url.pathname);
    if (match === null) return null;
    try {
      if (match === "method_not_allowed") throw new ApiException("not_found", "no such route for this method", { method: request.method });
      const def = match.handler;
      const base: Ctx = { app, request, url, params: match.params, exec };
      if (def.trust === "access" || def.trust === "access_identity") {
        if (url.origin !== app.config.appOrigin) throw new ApiException("unauthenticated", "this route is only served on the app hostname", { reason: "wrong_host" });
      }
      if (def.trust === "access") {
        const session = await authenticateOwner(request, app.env, app.db);
        requireScope(session.principal, def.scope);
        return withBaseHeaders(await def.handler({ ...base, session }));
      }
      if (def.trust === "access_identity") {
        const identity = await authenticateIdentity(request, app.env);
        return withBaseHeaders(await def.handler({ ...base, identity }));
      }
      return withBaseHeaders(await def.handler(base));
    } catch (error) {
      return errorResponse(error, (e) => console.error("request failed", request.method, url.pathname, String((e as Error)?.stack ?? e)));
    }
  }
}

function withBaseHeaders(response: Response): Response {
  if (response.headers.has("X-Garderobe-Api")) return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
