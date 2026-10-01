import { AuthorizationError, CimdFetchError, type AuthRequest, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { MCP_SCOPES, type McpScope } from "@garderobe/contracts/ext/api";
import { prepare, toInstant } from "@garderobe/domain";
import type { z } from "zod";
import { auditStatement, rateLimit } from "../auth/session.ts";
import { randomBytes, toBase64Url } from "../crypto.ts";
import { ApiException } from "../errors.ts";
import { escapeHtml, html } from "../http.ts";
import { owner, type OwnerCtx, type RouteDef } from "../router.ts";
import { recordGrantStatement, supersedeGrantsStatement } from "./grants.ts";

type Scope = z.infer<typeof McpScope>;

/** What the token carries to the MCP endpoint. The owner comes from here, never from a tool argument. */
export interface McpProps {
  userId: string;
  grantId: string;
}

const SCOPE_TEXT: Record<Scope, { title: string; detail: string }> = {
  "wardrobe.read": { title: "Read your wardrobe", detail: "Inventory, availability, daily boards, laundry, style profile, history and conversation answers." },
  "wardrobe.write": { title: "Make changes", detail: "Record what you wore, laundry and arrivals, choose and change outfits, and other wardrobe commands. Every change returns a receipt and most can be undone." },
};

function helpers(ctx: OwnerCtx): OAuthHelpers {
  const oauth = ctx.app.env.OAUTH_PROVIDER;
  if (!oauth) throw new ApiException("internal", "the authorization server is not available");
  return oauth;
}

function requestedScopes(scope: string[]): Scope[] {
  const requested = scope.filter((s): s is Scope => (MCP_SCOPES as readonly string[]).includes(s));
  // Reading is the baseline of every grant; a client that asked for nothing gets read only.
  return requested.includes("wardrobe.write") ? ["wardrobe.read", "wardrobe.write"] : ["wardrobe.read"];
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{font:17px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:28px 20px;color:#111;background:#fff}
main{max-width:36rem;margin:0 auto}h1{font-size:1.45rem;line-height:1.25;margin:0 0 .6rem}
.who{border:1px solid #d9d9d9;border-radius:12px;padding:14px 16px;margin:16px 0}
.warn{border:1px solid #b45309;border-radius:12px;padding:12px 16px;margin:16px 0}
fieldset{border:0;padding:0;margin:20px 0}legend{font-weight:600;padding:0;margin-bottom:8px}
label{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid #e5e5e5;min-height:44px}
label small{display:block;color:#555}input[type=checkbox]{width:22px;height:22px;margin-top:2px}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:24px}
button{font:inherit;min-height:44px;padding:10px 20px;border-radius:10px;border:1px solid #111;background:#fff;color:#111}
button.primary{background:#111;color:#fff}
@media(prefers-color-scheme:dark){body{color:#f2f2f2;background:#111}.who,label{border-color:#3a3a3a}label small{color:#bbb}button{background:#111;color:#f2f2f2;border-color:#f2f2f2}button.primary{background:#f2f2f2;color:#111}}
</style></head><body><main>${body}</main></body></html>`;
}

/** Every client-supplied value is escaped: names, URIs and scope strings come from registration or a metadata document. */
function consentPage(details: ConsentDescription, requested: Scope[], handle: string, ownerName: string): string {
  const name = escapeHtml(details.clientName || "An application");
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This application registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<div class="warn"><strong>This sends access to an application on this device.</strong> Continue only if you just started connecting from it.</div>`
    : "";
  const wantsWrite = requested.includes("wardrobe.write");
  return page(
    `Connect ${details.clientName} to Garderobe`,
    `<h1>Allow ${name} to use ${escapeHtml(ownerName)}'s Garderobe?</h1>
<div class="who"><div>${origin}</div><div>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</div></div>
${loopback}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset><legend>${name} is asking to</legend>
<label><input type="checkbox" name="scope" value="wardrobe.read" checked disabled><span>${SCOPE_TEXT["wardrobe.read"].title}<small>${SCOPE_TEXT["wardrobe.read"].detail}</small></span></label>
<label><input type="checkbox" name="scope" value="wardrobe.write"${wantsWrite ? " checked" : ""}><span>${SCOPE_TEXT["wardrobe.write"].title}${wantsWrite ? "" : " (not requested)"}<small>${SCOPE_TEXT["wardrobe.write"].detail} Leave this off for a read-only connection.</small></span></label>
</fieldset>
<p>You can disconnect it at any time in Settings &rsaquo; Connected assistants. It never receives your Google sign-in or any other connection.</p>
<div class="actions"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div>
</form>`,
  );
}

function localError(message: string, status = 400): Response {
  return html(page("This connection could not be completed", `<h1>This connection could not be completed</h1><p>${escapeHtml(message)}</p><p>Start connecting again from the assistant.</p>`), status);
}

/** Redirect back to the client only when the library validated the client and its exact redirect URI. */
function handleError(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    const redirectTo = (error as AuthorizationError & { redirectTo?: string }).redirectTo;
    if (redirectTo) return new Response(null, { status: 302, headers: { Location: redirectTo, "Cache-Control": "no-store" } });
    return localError((error as AuthorizationError & { description?: string }).description ?? "The request was not valid.");
  }
  if (error instanceof CimdFetchError) return localError("This application could not be verified.");
  throw error;
}

/**
 * The consent endpoint of the MCP authorization server. It lives on the app hostname behind Cloudflare
 * Access, so the person approving is the same verified internal user as in the app; a valid Access
 * identity alone grants nothing: only an explicit Allow on this page, for this client and these
 * capabilities, records a grant.
 */
export function consentRoutes(): RouteDef[] {
  return [
    owner("GET", "/oauth/authorize", "admin", async (ctx) => {
      const oauth = helpers(ctx);
      try {
        const request = await oauth.parseAuthRequest(ctx.request);
        const details = await oauth.describeConsent(request); // first: a failed lookup leaves nothing stored
        const consent = await oauth.beginConsent(request); // one-time, browser-bound, ten-minute transaction
        // No form-action restriction here: after Allow or Deny the browser must follow the redirect to the client.
        if (!consent.headers.has("Content-Security-Policy")) consent.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
        return html(consentPage(details, requestedScopes(request.scope), consent.handle, ctx.session.displayName), 200, consent.headers);
      } catch (error) {
        return handleError(error);
      }
    }),

    owner("POST", "/oauth/authorize", "admin", async (ctx) => {
      const { app, session } = ctx;
      const oauth = helpers(ctx);
      const nowMs = app.now();
      await rateLimit(app.db, `consent:${session.userId}`, 30, 3600, nowMs);
      const form = await ctx.request.formData();
      const handle = String(form.get("handle") ?? "");
      try {
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(ctx.request, handle);
          const audit = await auditStatement({ userId: session.userId, kind: "assistant.consent", outcome: "refused", identity: session.identity, channel: session.principal.channel, detail: { clientId: denied.request.clientId, reason: "owner_denied" }, nowMs });
          await prepare(app.db, audit.statement).run();
          denied.headers.set("Location", denied.redirectTo);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const scopes: Scope[] = form.getAll("scope").map(String).includes("wardrobe.write") ? ["wardrobe.read", "wardrobe.write"] : ["wardrobe.read"];
        const approved = await oauth.approveConsent(ctx.request, handle, { scope: scopes });
        const request: AuthRequest = approved.request; // from the stored transaction, not from the form
        const details = await oauth.describeConsent(request);
        const grantId = `mcg_${toBase64Url(randomBytes(12))}`;
        const props: McpProps = { userId: session.userId, grantId };
        const { redirectTo } = await oauth.completeAuthorization({ request, userId: session.userId, metadata: { grantId, clientName: details.clientName }, scope: scopes, props });
        const now = toInstant(nowMs);
        const audit = await auditStatement({ userId: session.userId, kind: "assistant.consent", outcome: "ok", identity: session.identity, channel: session.principal.channel, detail: { grantId, clientId: request.clientId, scopes, redirectHost: details.redirectHost }, nowMs });
        await app.db.batch(
          [
            // The provider revokes this installation's earlier grants; the application record follows it.
            supersedeGrantsStatement(session.userId, request.clientId, details.redirectHost, now),
            recordGrantStatement({ userId: session.userId, grantId, clientId: request.clientId, clientName: details.clientName || "Application", clientUri: details.clientUri ?? null, clientDomain: details.clientDomain ?? null, redirectHost: details.redirectHost, scopes, now }),
            audit.statement,
          ].map((s) => prepare(app.db, s)),
        );
        approved.headers.set("Location", redirectTo);
        approved.headers.set("Cache-Control", "no-store");
        return new Response(null, { status: 302, headers: approved.headers });
      } catch (error) {
        return handleError(error);
      }
    }),
  ];
}
