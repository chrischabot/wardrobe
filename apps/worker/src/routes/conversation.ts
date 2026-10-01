import { FeedbackQuery, MessagesQuery, RunEventsQuery, RunInputRequest, StartResearchRequest, TurnRequest, type AttachedRef } from "@garderobe/contracts/ext/api";
import { RecallQuery } from "@garderobe/contracts/ext/assistant";
import type { Principal } from "@garderobe/domain";
import type { z } from "zod";
import { requireAssistant, type App } from "../app.ts";
import { ApiException } from "../errors.ts";
import { json, readJson, readQuery } from "../http.ts";
import type { TurnSubmission } from "../ports.ts";
import { owner, type RouteDef } from "../router.ts";
import { answerRunInput, cancelRun, getRun, registerAssistantRun, streamRunEvents } from "../runs.ts";

type Ref = z.infer<typeof AttachedRef>;

/** Attached identities travel as `kind:id` (plus board and revision for an option): never guessed by a model. */
export function encodeRefs(refs: Ref[]): string[] {
  return refs.map((r) => (r.kind === "board_option" && r.boardId ? `board_option:${r.boardId}:${r.revision ?? ""}:${r.id}` : `${r.kind}:${r.id}`));
}

const INTENT_NOTES: Record<string, string | null> = {
  chat: null,
  add_item: "Capture intent selected by the owner: Add an item.",
  identify: "Capture intent selected by the owner: Identify this. Identification only; nothing is to be logged.",
  what_i_wore: "Capture intent selected by the owner: What I wore.",
  product_investigation: "Capture intent selected by the owner: investigate this product.",
};

/**
 * Build the assistant's turn input from a client turn. Only the owner's own words go into `text`;
 * a shared link, pasted text and photographs arrive as attachments, which the assistant treats as
 * data and which can never authorize a change.
 */
export function toSubmission(input: { clientTurnId: string; text: string; attachmentIds: string[]; attachedRefs: Ref[]; intent: string; sharedUrl?: string; pastedText?: string }): TurnSubmission {
  const attachments: TurnSubmission["attachments"] = [];
  if (input.sharedUrl) attachments.push({ kind: "web_page", source: input.sharedUrl, text: `Shared link: ${input.sharedUrl}` });
  if (input.pastedText) attachments.push({ kind: "pasted_text", source: null, text: input.pastedText });
  const note = INTENT_NOTES[input.intent] ?? null;
  if (note) attachments.push({ kind: "other", source: "capture-sheet", text: note });
  return {
    submissionId: input.clientTurnId,
    text: input.text,
    attachments,
    attachedRefs: [...encodeRefs(input.attachedRefs), ...input.attachmentIds.map((id) => `upload:${id}`)],
  };
}

/** Accept a turn durably and bind its run to the owner. Retransmission returns the same turn. */
export async function submitTurn(app: App, principal: Principal, submission: TurnSubmission) {
  const assistant = requireAssistant(app, "the conversation");
  const accepted = await assistant.submitTurn(principal, submission);
  await registerAssistantRun(app.db, principal, { runId: accepted.runId, kind: "conversation_turn", state: accepted.state, clientRequestId: submission.submissionId }, app.now());
  return { turnId: accepted.runId, runId: accepted.runId, state: accepted.state, replayed: accepted.replayed };
}

export async function startResearch(app: App, principal: Principal, input: { clientRequestId: string; topic: string; kind: "product" | "history" | "purchases" | "general"; url?: string }) {
  const assistant = requireAssistant(app, "research");
  const started = await assistant.startResearch(principal, { submissionId: input.clientRequestId, topic: input.topic, kind: input.kind, ...(input.url ? { url: input.url } : {}) });
  await registerAssistantRun(app.db, principal, { runId: started.runId, kind: "research", state: started.state, clientRequestId: input.clientRequestId }, app.now());
  const run = await getRun(app, principal, started.runId);
  return { runId: started.runId, state: run.state, result: run.result?.research ?? null, replayed: started.replayed };
}

export function conversationRoutes(): RouteDef[] {
  return [
    owner("POST", "/v1/conversation/turns", "write", async ({ app, session, request }) => {
      const body = await readJson(request, TurnRequest);
      return json(await submitTurn(app, session.principal, toSubmission(body)));
    }),

    owner("GET", "/v1/conversation/messages", "read", async ({ app, session, url }) => {
      const q = readQuery(url, MessagesQuery);
      if ([q.before, q.after, q.around].filter((v) => v !== undefined).length > 1) throw new ApiException("invalid_command", "use only one of before, after and around");
      return json(await requireAssistant(app, "the conversation").transcript(session.principal, q));
    }),

    owner("POST", "/v1/recall/search", "read", async ({ app, session, request }) => json(await requireAssistant(app, "recall").recall(session.principal, await readJson(request, RecallQuery)))),

    owner("POST", "/v1/research", "write", async ({ app, session, request }) => json(await startResearch(app, session.principal, await readJson(request, StartResearchRequest)))),

    owner("GET", "/v1/orders", "read", async ({ app, session }) => json({ orders: await requireAssistant(app, "orders").orders(session.principal) })),
    owner("GET", "/v1/returns", "read", async ({ app, session }) => json({ returns: await requireAssistant(app, "returns and exchanges").returns(session.principal) })),
    owner("GET", "/v1/projects", "read", async ({ app, session }) => json({ projects: await requireAssistant(app, "lifecycle projects").projects(session.principal) })),
    owner("GET", "/v1/feedback", "read", async ({ app, session, url }) => json({ feedback: await requireAssistant(app, "comfort feedback").feedback(session.principal, readQuery(url, FeedbackQuery).garmentId) })),

    owner("GET", "/v1/runs/{id}", "read", async ({ app, session, params }) => json(await getRun(app, session.principal, params.id!))),

    owner("GET", "/v1/runs/{id}/events", "read", async ({ app, session, params, url, request }) => {
      const q = readQuery(url, RunEventsQuery);
      const header = request.headers.get("Last-Event-ID");
      const after = q.after ?? (header !== null && /^\d+$/.test(header) ? Number(header) : 0);
      // Ownership and existence are checked before the stream opens, so a wrong ID is a plain 404.
      await getRun(app, session.principal, params.id!);
      return streamRunEvents(app, session.principal, params.id!, { after, follow: q.follow !== "false" });
    }),

    owner("POST", "/v1/runs/{id}/cancel", "write", async ({ app, session, params }) => {
      const result = await cancelRun(app, session.principal, params.id!);
      return json({ run: result.run, committed: result.run.receipts, stopped: result.stopped });
    }),

    owner("POST", "/v1/runs/{id}/input", "write", async ({ app, session, params, request }) => json(await answerRunInput(app, session.principal, params.id!, await readJson(request, RunInputRequest)))),
  ];
}
