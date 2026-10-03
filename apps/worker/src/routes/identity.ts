import { AccountDeleteRequest, ClaimRequest, IdentityLinkCompleteRequest, IdentityUnlinkRequest, RecoveryCompleteRequest } from "@garderobe/contracts/ext/api";
import { all, first, json as parseJson, resolvePrincipal, toInstant } from "@garderobe/domain";
import { z } from "zod";
import type { App } from "../app.ts";
import type { VerifiedIdentity } from "../auth/access.ts";
import { OWNER_SCOPES, identityHash, type OwnerSession } from "../auth/session.ts";
import { json, readJson } from "../http.ts";
import { claimAccount, completeLink, completeRecovery, createLinkTicket, describeMe, issueRecoveryKit, requestAccountDeletion, revokeSessions, startRecovery, unlinkIdentityById } from "../identity/service.ts";
import { disconnectGrant, listGrants } from "../mcp/grants.ts";
import { listDevices, registerDevice, removeDevice } from "../notifications/service.ts";
import { DeviceRegistration } from "@garderobe/contracts/ext/api";
import { identityOnly, owner, type RouteDef } from "../router.ts";
import { runsNeedingInput } from "../runs.ts";

/** A session for an identity that was linked during this very request. */
async function sessionFor(app: App, identity: VerifiedIdentity, userId: string, displayName: string): Promise<OwnerSession> {
  const channel = identity.hasCookie ? "web" : "ios";
  const principal = await resolvePrincipal(app.db, { issuer: identity.issuer, subject: identity.subject }, { actor: "owner", channel, scopes: [...OWNER_SCOPES], authRef: `access:${await identityHash(identity.issuer, identity.subject)}` });
  return { identity, principal, userId, displayName };
}

export function identityRoutes(): RouteDef[] {
  return [
    identityOnly("POST", "/auth/claim", async ({ app, identity, request }) => {
      const { invitationCode } = await readJson(request, ClaimRequest);
      const claimed = await claimAccount(app.db, app.env, identity, invitationCode, app.now());
      return json(await describeMe(app.db, await sessionFor(app, identity, claimed.userId, claimed.displayName), claimed.kit));
    }),

    identityOnly("POST", "/auth/link/complete", async ({ app, identity, request }) => {
      const { linkCode } = await readJson(request, IdentityLinkCompleteRequest);
      const linked = await completeLink(app.db, app.env, identity, linkCode, app.now());
      return json(await describeMe(app.db, await sessionFor(app, identity, linked.userId, linked.displayName)));
    }),

    identityOnly("POST", "/auth/recovery/start", async ({ app, identity }) => json(await startRecovery(app.db, identity, app.now()))),

    identityOnly("POST", "/auth/recovery/complete", async ({ app, identity, request }) => json(await completeRecovery(app.db, app.env, identity, await readJson(request, RecoveryCompleteRequest), app.now()))),

    owner("POST", "/v1/identities/link", "admin", async ({ app, session }) => json(await createLinkTicket(app.db, app.env, session, app.now()))),

    owner("POST", "/v1/identities/unlink", "admin", async ({ app, session, request }) => {
      const { identityId } = await readJson(request, IdentityUnlinkRequest);
      await unlinkIdentityById(app.db, session, identityId, app.now());
      return json(await describeMe(app.db, session));
    }),

    owner("POST", "/v1/recovery-kit", "admin", async ({ app, session }) => json(await issueRecoveryKit(app.db, session, app.now()))),

    owner("POST", "/v1/sessions/revoke", "admin", async ({ app, session }) => json(await revokeSessions(app.db, session, app.now()))),

    owner("POST", "/v1/account/delete", "admin", async ({ app, session, request }) => {
      const { confirmationToken } = await readJson(request, AccountDeleteRequest);
      return json(await requestAccountDeletion(app, session, confirmationToken, app.now()));
    }),

    owner("GET", "/v1/assistants", "read", async ({ app, session }) => json({ grants: await listGrants(app.db, session.userId) })),

    /* Devices that receive notifications. The device token is a delivery credential: stored encrypted, never returned. */
    owner("GET", "/v1/devices", "read", async ({ app, session }) => json(await listDevices(app, session.userId))),

    owner("POST", "/v1/devices", "write", async ({ app, session, request }) => json(await registerDevice(app, session.userId, await readJson(request, DeviceRegistration)))),

    owner("POST", "/v1/devices/{id}/remove", "write", async ({ app, session, params }) => json(await removeDevice(app.db, session.userId, params.id!))),

    owner("POST", "/v1/assistants/{id}/disconnect", "admin", async ({ app, session, params }) => json(await disconnectGrant(app.db, app.env, session, params.id!, app.now()))),

    /*
     * The recovery screen: concrete state instead of a generic error. It reads only this owner's records
     * and is deliberately independent of the modules it reports on: a failed calendar or assistant never
     * prevents it from answering.
     */
    owner("GET", "/v1/recovery", "read", async ({ app, session }) => {
      const userId = session.userId;
      let lastBoard = null;
      let lastCalendarProjection = null;
      const diagnostics: Record<string, unknown> = { environment: app.config.environment, modules: { daily: app.daily !== null, assistant: app.assistant !== null, media: app.media !== null } };
      if (app.daily) {
        try {
          const today = await app.daily.today(session.principal, {});
          if (today.board) {
            lastBoard = { boardId: today.board.boardId, localDate: today.board.localDate, revision: today.board.revision, publishedAt: today.board.publishedAt };
            lastCalendarProjection = today.board.calendarProjection;
          } else diagnostics.noBoardReason = today.emptyReason;
        } catch (error) {
          diagnostics.boardReadError = String((error as Error)?.message ?? error).slice(0, 200);
        }
      }
      const effects = await first<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM effects WHERE user_id = ? AND state IN ('pending', 'in_progress')", userId);
      const waiting = { n: await runsNeedingInput(app, session.principal) };
      const rows = await all<{ connection_id: string; name: string; state: string; issue_json: string | null }>(
        app.db,
        "SELECT connection_id, name, state, issue_json FROM connection_profiles WHERE user_id = ? AND state IN ('needs_reconnect', 'error', 'pending_authorization')",
        userId,
      );
      const issueShape = z.object({ capability: z.string().nullable(), message: z.string(), action: z.enum(["reconnect", "retry", "none"]) });
      const connectionIssues = rows.map((r) => {
        const issue = issueShape.safeParse(parseJson(r.issue_json, null));
        const fallback = r.state === "error" ? { capability: null, message: `${r.name} could not be reached.`, action: "retry" as const } : { capability: null, message: `${r.name} needs to be connected again.`, action: "reconnect" as const };
        return { connectionId: r.connection_id, name: r.name, ...(issue.success ? issue.data : fallback) };
      });
      const actions = new Set<"reconnect" | "retry" | "open_today">();
      for (const issue of connectionIssues) if (issue.action !== "none") actions.add(issue.action);
      if ((effects?.n ?? 0) > 0) actions.add("retry");
      if (lastBoard) actions.add("open_today");
      return json({
        lastBoard,
        lastCalendarProjection,
        pending: { effects: effects?.n ?? 0, runsNeedingInput: waiting?.n ?? 0 },
        connectionIssues,
        actions: [...actions],
        diagnostics,
        readAt: toInstant(app.now()),
      });
    }),
  ];
}
