import { ProposalDecisionWithRestrictionsRequest } from "@garderobe/contracts";
import { ProposalsQuery } from "@garderobe/contracts/ext/api";
import { toInstant } from "@garderobe/domain";
import { afterCommit } from "../app.ts";
import { rateLimit } from "../auth/session.ts";
import { json, readJson, readQuery } from "../http.ts";
import { decideProposal, listProposals } from "../proposals/service.ts";
import { owner, type RouteDef } from "../router.ts";

/** Changes the assistant proposed and could not make on its own authority; decided by the owner in the app. */
export function proposalRoutes(): RouteDef[] {
  return [
    owner("GET", "/v1/proposals", "read", async ({ app, session, url }) => {
      const proposals = await listProposals(app, session.principal, { state: readQuery(url, ProposalsQuery).state });
      return json({ proposals, pending: proposals.filter((p) => p.state === "pending").length, readAt: toInstant(app.now()) });
    }),

    owner("POST", "/v1/proposals/{id}/decision", "write", async ({ app, session, params, request, exec }) => {
      const body = await readJson(request, ProposalDecisionWithRestrictionsRequest);
      await rateLimit(app.db, `proposal-decision:${session.userId}`, 120, 3600, app.now());
      const result = await decideProposal(app, session.principal, params.id!, body.decision, body.acknowledgedRestrictionIds ? { acknowledgedRestrictionIds: body.acknowledgedRestrictionIds } : {});
      if (result.receipt && !result.replayed) exec.waitUntil(afterCommit(app, session.principal));
      return json(result);
    }),
  ];
}
