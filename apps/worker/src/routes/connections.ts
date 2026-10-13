import { ConnectionCallbackQuery, ConnectionCapabilitiesRequest, OutfitCalendarRequest, ReconnectRequest, RegisterConnectionRequest } from "@garderobe/contracts/ext/api";
import { toInstant } from "@garderobe/domain";
import { rateLimit } from "../auth/session.ts";
import { completeAuthorizationCallback, disconnectConnection, ensureOutfitCalendar, listCalendars, listConnections, reconcileRegistry, reconnectConnection, registerConnection, setCapabilities } from "../connections/service.ts";
import { escapeHtml, html, json, readJson } from "../http.ts";
import { owner, selfAuthenticated, type RouteDef } from "../router.ts";

function callbackPage(title: string, message: string, returnUrl: string | null): string {
  const link = returnUrl ? `<p><a href="${escapeHtml(returnUrl)}">Return to Garderobe</a></p>` : "<p>You can close this page and return to Garderobe.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:32px 20px;color:#111;background:#fff}main{max-width:34rem;margin:0 auto}h1{font-size:1.4rem}a{color:#0a58ca}@media(prefers-color-scheme:dark){body{color:#f2f2f2;background:#111}a{color:#8ab4ff}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${link}</main></body></html>`;
}

export function connectionRoutes(): RouteDef[] {
  return [
    owner("GET", "/v1/connections", "read", async ({ app, session }) => {
      await reconcileRegistry(app, session.principal);
      return json({ connections: await listConnections(app.db, session.userId), readAt: toInstant(app.now()) });
    }),

    owner("POST", "/v1/connections", "admin", async ({ app, session, request }) => {
      await rateLimit(app.db, `connection-register:${session.userId}`, 30, 3600, app.now());
      return json(await registerConnection(app, session, await readJson(request, RegisterConnectionRequest)));
    }),

    owner("POST", "/v1/connections/{id}/reconnect", "admin", async ({ app, session, params, request }) => {
      const { returnTo } = await readJson(request, ReconnectRequest);
      return json(await reconnectConnection(app, session, params.id!, returnTo));
    }),

    owner("POST", "/v1/connections/{id}/capabilities", "admin", async ({ app, session, params, request }) => json(await setCapabilities(app, session, params.id!, await readJson(request, ConnectionCapabilitiesRequest)))),

    owner("POST", "/v1/connections/{id}/disconnect", "admin", async ({ app, session, params }) => json(await disconnectConnection(app, session, params.id!))),

    owner("GET", "/v1/connections/{id}/calendars", "read", async ({ app, session, params }) => json(await listCalendars(app, session, params.id!))),

    owner("POST", "/v1/connections/{id}/outfit-calendar", "admin", async ({ app, session, params, request }) => json(await ensureOutfitCalendar(app, session, params.id!, await readJson(request, OutfitCalendarRequest)))),

    /* Authenticated by its one-time state only (see completeAuthorizationCallback). Always answers with a page, never JSON errors. */
    selfAuthenticated("GET", "/connections/callback", "one_time_state", async ({ app, url }) => {
      const raw: Record<string, string> = {};
      for (const [k, v] of url.searchParams) raw[k] = v;
      const parsed = ConnectionCallbackQuery.safeParse(raw);
      if (!parsed.success) return html(callbackPage("This link cannot be used", "This connection link is incomplete. Start again from Settings.", null), 400);
      const outcome = await completeAuthorizationCallback(app, { ...parsed.data, ...(raw.iss ? { iss: raw.iss } : {}) });
      const returnUrl = outcome.returnTo === "web" ? `${app.config.appOrigin}/board` : (app.env.APP_RETURN_URL ?? null);
      return html(callbackPage(outcome.title, outcome.message, returnUrl), outcome.ok ? 200 : 400);
    }),
  ];
}
