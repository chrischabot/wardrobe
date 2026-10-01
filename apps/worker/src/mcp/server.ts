import { CONTRACT_VERSION, type CommandReceipt } from "@garderobe/contracts";
import {
  MCP_TOOL_CONTRACTS,
  McpAskOutput,
  McpCommandOutput,
  McpInventoryOutput,
  McpRecommendOutput,
  McpResearchOutput,
  McpRunOutput,
  McpTodayOutput,
  type McpToolName,
} from "@garderobe/contracts/ext/api";
import {
  addDays,
  canonicalJson,
  getAvailability,
  getDailyRecord,
  getLaundryState,
  getOwnerState,
  getStyleContext,
  listCountedWears,
  listInventory,
  localDateOf,
  registerActionIntent,
  resolveAlias,
  toInstant,
  type Principal,
} from "@garderobe/domain";
import { McpServer, acceptedContent, createRequestStateCodec, inputRequired, type RequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { requireAssistant, requireDaily, type App } from "../app.ts";
import { sha256Hex } from "../crypto.ts";
import { ApiException, normalizeError } from "../errors.ts";
import type { ApiRun } from "../ports.ts";
import { startResearch, submitTurn, toSubmission } from "../routes/conversation.ts";
import { describeCommandTypes, executeCommand, isConsequential, listReceipts, readItem } from "../routes/core.ts";
import { readToday, runRecommendation } from "../routes/daily.ts";
import { answerRunInput, cancelRun, getRun, registerAssistantRun } from "../runs.ts";

/** Who is calling, established by the OAuth grant before any tool runs. */
export interface McpCaller {
  principal: Principal;
  grantId: string;
  clientId: string;
  canWrite: boolean;
  exec: ExecutionContext;
}

interface ConfirmationState {
  /** Hash of the exact command the confirmation was requested for. */
  h: string;
  /** Backend-issued action intent: the durable pending-action record. */
  a: string;
}

const codecs = new WeakMap<object, RequestStateCodec<ConfirmationState>>();

/**
 * HMAC codec for multi-round-trip request state. The state is bound to the method and to the grant,
 * so a confirmation minted for one connection or one tool call cannot be replayed on another, and it
 * expires after ten minutes.
 */
export function confirmationCodec(app: App): RequestStateCodec<ConfirmationState> {
  let codec = codecs.get(app);
  if (!codec) {
    codec = createRequestStateCodec<ConfirmationState>({
      key: app.env.STATE_SIGNING_KEY,
      ttlSeconds: 600,
      bind: (ctx) => `${ctx.mcpReq.method}\u0000${String(ctx.http?.authInfo?.extra?.grantId ?? "")}`,
    });
    codecs.set(app, codec);
  }
  return codec;
}

const GUIDE = `# Using the Garderobe tools

Garderobe is one person's private wardrobe companion. Every tool acts for the owner who connected this
assistant; there is no owner or user parameter anywhere.

- \`garderobe_today\`: the prepared outfit board for a date, exactly as the owner's app shows it.
- \`garderobe_recommend\`: validated outfit options for a brief, date and count. Never invent garments:
  only the options returned here exist.
- \`garderobe_inventory\`: read the wardrobe. Views: items (paged), snapshot (complete), item, availability,
  history, laundry, style, resolve (turn the owner's phrase into garment IDs), receipts, command_types,
  trips, returns, orders. Always check \`complete\` and \`nextCursor\` before saying how many things exist.
- \`garderobe_command\`: make one typed change (needs the write permission). Use view \`command_types\` for
  the types and payload schemas. Send a stable \`idempotencyKey\` per intended change; repeating it never
  repeats the change. The result is a verified receipt: report what the receipt says, nothing more.
- \`garderobe_ask\`: an open request to Garderobe's own assistant, which knows the owner's full style
  profile and history.
- \`garderobe_research\`: investigate a product, a fit question or the owner's history.
- \`garderobe_run\`: follow, answer or cancel a long operation by its run ID.

Rules that matter: availability is an estimate with a stated basis, not a fact to argue with; what the
owner says they wore, washed or own is recorded as said; choosing an outfit is an intention, not a wear;
a receipt with \`replayed: true\` means the change was already made earlier.
`;

function textOf(value: unknown, limit = 6000): string {
  const text = JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}… (truncated; the structured result is complete)` : text;
}

function ok<T extends Record<string, unknown>>(structured: T, summary: string) {
  return { content: [{ type: "text" as const, text: summary }], structuredContent: structured };
}

/** A refused or failed tool call: an MCP tool error carrying the same error body the HTTP API returns. */
function failure(error: unknown) {
  const n = normalizeError(error);
  if (n.code === "internal") console.error("mcp tool failed", String((error as Error)?.stack ?? error));
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify({ error: { code: n.code, message: n.message, details: n.details } }) }] };
}

function receiptLine(receipt: CommandReceipt): string {
  return `${receipt.replayed ? "Already recorded" : receipt.outcome === "noop" ? "No change" : "Recorded"}: ${receipt.summary} (command ${receipt.commandId})`;
}

function askOutput(run: ApiRun) {
  return { runId: run.runId, state: run.state, answer: run.result?.reply?.text ?? null, receipts: run.receipts, proposals: run.proposals, pendingInput: run.pendingInput };
}

function annotations(name: McpToolName, title: string) {
  const c = MCP_TOOL_CONTRACTS[name];
  return { title, readOnlyHint: c.readOnly, destructiveHint: c.destructive, idempotentHint: c.idempotent, openWorldHint: c.openWorld };
}

/**
 * Build the MCP server for one request. Tools are thin: each calls the same read interfaces and the
 * same command service as the HTTP API. The tool list depends on the grant's permission set (a
 * read-only connection is not offered `garderobe_command`), and the permission is enforced again at
 * call time by the command service's scope check.
 */
export function buildMcpServer(app: App, caller: McpCaller): McpServer {
  const codec = confirmationCodec(app);
  const { principal } = caller;
  const server = new McpServer(
    { name: "garderobe", title: "Garderobe", version: CONTRACT_VERSION },
    {
      instructions: "Garderobe: the connected owner's private wardrobe. The owner is fixed by this connection. Read the resource garderobe://guide for how the tools fit together.",
      // Lists depend on the connection's permission set, so they are cacheable only privately.
      cacheHints: { "tools/list": { ttlMs: 300_000, cacheScope: "private" }, "resources/list": { ttlMs: 300_000, cacheScope: "private" }, "resources/read": { ttlMs: 0, cacheScope: "private" } },
      requestState: { verify: (state: string, ctx: ServerContext) => codec.verify(state, ctx) },
    },
  );

  /* ---------------- resources (helpful, never required) ---------------- */
  server.registerResource("guide", "garderobe://guide", { title: "Using the Garderobe tools", mimeType: "text/markdown", cacheHint: { ttlMs: 3_600_000, cacheScope: "public" } }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }));
  server.registerResource("style-profile", "garderobe://style/profile", { title: "Owner style profile (current version)", mimeType: "text/markdown" }, async (uri) => {
    const style = await getStyleContext(app.db, principal);
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: style.document.content }] };
  });
  server.registerResource("commands", "garderobe://commands", { title: "Command types and payload schemas", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(describeCommandTypes(app.registry)) }],
  }));

  /* ---------------- garderobe_today ---------------- */
  server.registerTool(
    "garderobe_today",
    { title: "Today's outfit board", description: "Read the prepared outfit board for today (or a date): the same board revision the owner's app shows, with source freshness.", inputSchema: MCP_TOOL_CONTRACTS.garderobe_today.input, outputSchema: McpTodayOutput, annotations: annotations("garderobe_today", "Today's outfit board") },
    async (args) => {
      try {
        const today = await readToday(app, principal, args.date ? { date: args.date } : {});
        const summary = today.board ? `Board for ${today.localDate}, revision ${today.board.revision}: ${today.board.options.map((o) => `${o.number}. ${o.name}`).join("; ")}` : `No board for ${today.localDate}: ${today.emptyReason ?? today.status}`;
        return ok(today, summary);
      } catch (error) {
        return failure(error);
      }
    },
  );

  /* ---------------- garderobe_recommend ---------------- */
  server.registerTool(
    "garderobe_recommend",
    { title: "Recommend outfits", description: "Request validated outfit options for a brief, date and count. Returns only options that passed validation against the current wardrobe; nothing is published or logged.", inputSchema: MCP_TOOL_CONTRACTS.garderobe_recommend.input, outputSchema: McpRecommendOutput, annotations: annotations("garderobe_recommend", "Recommend outfits") },
    async (args) => {
      try {
        const result = await runRecommendation(app, principal, { clientRequestId: `mcp:${caller.grantId}:${args.clientRequestId}`, ...(args.date ? { date: args.date } : {}), ...(args.brief ? { brief: args.brief } : {}), ...(args.count ? { count: args.count } : {}), lockedGarmentIds: [], occasionOnly: false, mode: "preview" });
        return ok(result, result.options.length > 0 ? `${result.options.length} validated option(s) for ${result.localDate}: ${result.options.map((o) => o.name).join("; ")}${result.note ? `. ${result.note}` : ""}` : `No valid option for ${result.localDate}. ${result.note ?? ""}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  /* ---------------- garderobe_inventory ---------------- */
  server.registerTool(
    "garderobe_inventory",
    { title: "Read the wardrobe", description: "Read items, availability, wear history, laundry, style, receipts, command types, trips, returns or orders. `complete` and `nextCursor` say explicitly whether the data is the whole result.", inputSchema: MCP_TOOL_CONTRACTS.garderobe_inventory.input, outputSchema: McpInventoryOutput, annotations: annotations("garderobe_inventory", "Read the wardrobe") },
    async (args) => {
      try {
        const nowMs = app.now();
        const state = await getOwnerState(app.db, principal);
        const envelope = (data: Record<string, unknown>, extra: { complete?: boolean; total?: number | null; nextCursor?: string | null } = {}) => ({ view: args.view, complete: extra.complete ?? true, total: extra.total ?? null, nextCursor: extra.nextCursor ?? null, wardrobeRevision: state.wardrobeRevision, readAt: toInstant(nowMs), data });
        const need = (value: string | undefined, name: string): string => {
          if (!value) throw new ApiException("invalid_command", `view '${args.view}' needs '${name}'`);
          return value;
        };
        switch (args.view) {
          case "items":
          case "snapshot": {
            const page = await listInventory(
              app.db,
              principal,
              {
                ...(args.search ? { search: args.search } : {}),
                ...(args.category ? { category: args.category } : {}),
                ...(args.colour ? { colour: args.colour } : {}),
                ...(args.availability ? { availability: args.availability } : {}),
                ...(args.location ? { location: args.location } : {}),
                ...(args.date ? { forDate: args.date } : {}),
                ...(args.view === "items" ? { limit: args.limit ?? 50, ...(args.cursor ? { cursor: args.cursor } : {}) } : {}),
              },
              { nowMs },
            );
            const out = envelope(page as unknown as Record<string, unknown>, { complete: page.complete, total: page.total, nextCursor: page.nextCursor });
            return ok(out, `${page.items.length} of ${page.total} item(s)${page.complete ? " (complete)" : " (more pages: pass nextCursor)"}; owned ${page.counts.owned}, available ${page.counts.available}, incoming ${page.counts.incoming}, retired ${page.counts.retired}.`);
          }
          case "item": {
            const item = await readItem(app, principal, need(args.garmentId, "garmentId"));
            return ok(envelope(item as unknown as Record<string, unknown>), `${item.detail.garment.name}: ${item.detail.totalOwnedUnits} owned unit(s); ${item.detail.recordedWearCount} recorded wear(s). ${item.detail.wearCountCaveat}`);
          }
          case "availability": {
            const snapshot = await getAvailability(app.db, principal, { ...(args.date ? { forDate: args.date } : {}), nowMs });
            return ok(envelope(snapshot as unknown as Record<string, unknown>, { total: snapshot.garments.length }), `Availability estimates for ${snapshot.forDate} (${snapshot.garments.length} garments; parameters are hypotheses, not measurements).`);
          }
          case "history": {
            if (args.date) {
              const record = await getDailyRecord(app.db, principal, args.date);
              return ok(envelope(record as unknown as Record<string, unknown>, { total: record.garments.length }), record.garments.length > 0 ? `Worn on ${args.date}: ${record.garments.map((g) => g.name).join(", ")}.` : `No wear recorded for ${args.date} (not recorded does not mean nothing was worn).`);
            }
            const to = args.to ?? localDateOf(nowMs, state.settings.timezone);
            const from = args.from ?? addDays(to, -30);
            const wears = (await listCountedWears(app.db, principal, { from, to })).filter((w) => !args.garmentId || w.garmentId === args.garmentId);
            return ok(envelope({ from, to, wears, caveat: "Recorded wears only; a day without a record is unknown, not unworn." }, { total: wears.length }), `${wears.length} recorded wear(s) from ${from} to ${to}.`);
          }
          case "laundry": {
            const laundry = await getLaundryState(app.db, principal);
            return ok(envelope(laundry as unknown as Record<string, unknown>), `Awaiting service laundry: ${laundry.awaitingService.length} item(s); awaiting hand-wash: ${laundry.awaitingHandwash.length}; batches: ${laundry.batches.length}.`);
          }
          case "style": {
            const style = await getStyleContext(app.db, principal, args.date ? { forDate: args.date } : {});
            return ok(envelope(style as unknown as Record<string, unknown>), `Style profile version ${style.document.version} with ${style.amendments.length} amendment(s), ${style.rules.length} rule(s), ${style.directions.length} standing direction(s). ${style.precedence}`);
          }
          case "resolve": {
            const resolution = await resolveAlias(app.db, principal, need(args.phrase, "phrase"));
            return ok(envelope(resolution as unknown as Record<string, unknown>, { total: resolution.matches.length }), resolution.matches.length === 0 ? `Nothing in the wardrobe matches "${resolution.phrase}". Do not create an item to make it match.` : resolution.ambiguous ? `"${resolution.phrase}" matches ${resolution.matches.length} garments; ask which one: ${resolution.matches.map((m) => `${m.name} (${m.distinguishing})`).join("; ")}` : `"${resolution.phrase}" is ${resolution.matches[0]!.name} (${resolution.matches[0]!.garmentId}).`);
          }
          case "receipts": {
            const receipts = await listReceipts(app, principal, { ...(args.garmentId ? { entity: `garment:${args.garmentId}` } : {}), limit: Math.min(args.limit ?? 50, 200) });
            return ok(envelope(receipts, { total: receipts.receipts.length }), `${receipts.receipts.length} receipt(s), newest first.`);
          }
          case "command_types": {
            const types = describeCommandTypes(app.registry);
            return ok(envelope(types as unknown as Record<string, unknown>, { total: types.types.length }), `${types.types.length} command types. Owner-facing types have class observation or edit; system types cannot be used from this connection.`);
          }
          case "trips": {
            const trips = await requireDaily(app, "trips").trips(principal);
            return ok(envelope({ trips }, { total: trips.length }), `${trips.length} trip(s).`);
          }
          case "returns": {
            const returns = await requireAssistant(app, "returns and exchanges").returns(principal);
            return ok(envelope({ returns }, { total: returns.length }), `${returns.length} return or exchange case(s).`);
          }
          case "orders": {
            const orders = await requireAssistant(app, "orders").orders(principal);
            return ok(envelope({ orders }, { total: orders.length }), `${orders.length} order(s).`);
          }
        }
      } catch (error) {
        return failure(error);
      }
    },
  );

  /* ---------------- garderobe_command (write grants only) ---------------- */
  if (caller.canWrite) {
    server.registerTool(
      "garderobe_command",
      { title: "Change the wardrobe", description: "Execute one typed, constrained change (see view command_types of garderobe_inventory). Returns the verified receipt. Irreversible or identity-changing commands ask for confirmation first.", inputSchema: MCP_TOOL_CONTRACTS.garderobe_command.input, outputSchema: McpCommandOutput, annotations: annotations("garderobe_command", "Change the wardrobe") },
      async (args, ctx) => {
        try {
          const envelope = {
            type: args.type,
            payload: args.payload,
            idempotencyKey: args.idempotencyKey,
            expectedVersions: args.expectedVersions,
            ...(args.occurredAt ? { occurredAt: args.occurredAt } : {}),
            authorization: "owner_statement" as const,
            source: { channel: "mcp" as const, clientSubmissionId: args.idempotencyKey },
          };
          let actionId: string | null = null;
          if (isConsequential(args.type)) {
            // The hash covers everything that defines the change, so a confirmation applies to this exact request only.
            const requestHash = await sha256Hex(canonicalJson({ type: args.type, payload: args.payload, idempotencyKey: args.idempotencyKey, expectedVersions: args.expectedVersions, occurredAt: args.occurredAt ?? null }));
            const state = ctx.mcpReq.requestState<ConfirmationState>();
            const answer = acceptedContent<{ confirm?: boolean }>(ctx.mcpReq.inputResponses, "confirm");
            if (!state || ctx.mcpReq.inputResponses === undefined) {
              // Validate before asking, so the owner is never asked to confirm something that cannot run.
              app.registry.get(args.type);
              const parsed = app.registry.get(args.type).schema.safeParse(args.payload);
              if (!parsed.success) throw new ApiException("invalid_command", `invalid payload for '${args.type}'`, { issues: parsed.error.issues });
              // The durable pending-action record: a retry resolves to this same action, never a second one.
              const intent = await registerActionIntent(app.db, principal, { parentKind: "job", parentId: `mcp:${caller.grantId}:${args.idempotencyKey}`, operation: args.type, targets: [], effect: args.payload, expectedVersions: args.expectedVersions, nowMs: app.now() });
              return inputRequired({
                inputRequests: {
                  confirm: inputRequired.elicit({
                    message: `Confirm this change to the wardrobe: ${args.type}. It cannot be undone automatically.`,
                    requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Make this change" } }, required: ["confirm"] },
                  }),
                },
                requestState: await codec.mint({ h: requestHash, a: intent.actionId }, ctx),
              });
            }
            if (state.h !== requestHash) throw new ApiException("confirmation_required", "the request changed after confirmation was asked for; nothing was changed. Ask again with the new request.", { reason: "request_altered" });
            if (!answer || answer.confirm !== true) throw new ApiException("confirmation_required", "the change was not confirmed; nothing was changed", { reason: "not_confirmed" });
            actionId = state.a;
          }
          const receipt = await executeCommand(app, principal, actionId ? { ...envelope, source: { ...envelope.source, actionId, parentKind: "job", parentId: `mcp:${caller.grantId}:${args.idempotencyKey}` } } : envelope, caller.exec);
          return ok({ receipt }, receiptLine(receipt));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }

  /* ---------------- garderobe_ask ---------------- */
  server.registerTool(
    "garderobe_ask",
    { title: "Ask Garderobe's assistant", description: "Send an open request to Garderobe's own assistant (it has the owner's full style profile and history). A read-only connection gets facts and proposals; a write connection can also get committed changes with receipts.", inputSchema: MCP_TOOL_CONTRACTS.garderobe_ask.input, outputSchema: McpAskOutput, annotations: annotations("garderobe_ask", "Ask Garderobe's assistant") },
    async (args) => {
      try {
        const assistant = requireAssistant(app, "the assistant");
        // Natural language is not an authorization bypass: the turn runs under this connection's principal and scopes.
        const submission = toSubmission({ clientTurnId: `mcp:${caller.grantId}:${args.clientTurnId}`, text: args.message, attachmentIds: [], attachedRefs: args.attachedRefs, intent: "chat", ...(args.pastedText ? { pastedText: args.pastedText } : {}) });
        if (args.mode === "start") {
          const accepted = await submitTurn(app, principal, submission);
          const run = await getRun(app, principal, accepted.runId);
          return ok(askOutput(run), `Accepted as run ${run.runId} (${run.state}). Use garderobe_run to follow it.`);
        }
        const run = await assistant.runTurn(principal, submission);
        await registerAssistantRun(app.db, principal, { runId: run.runId, kind: "conversation_turn", state: run.state, clientRequestId: submission.submissionId }, app.now());
        const out = askOutput({ ...run, kind: "conversation_turn" });
        return ok(out, out.answer ?? (out.pendingInput ? `Garderobe needs an answer: ${out.pendingInput.question} (use garderobe_run with action respond)` : `Run ${out.runId} is ${out.state}.`));
      } catch (error) {
        return failure(error);
      }
    },
  );

  /* ---------------- garderobe_research ---------------- */
  server.registerTool(
    "garderobe_research",
    { title: "Research for the wardrobe", description: "Investigate a product, a fit question or the owner's purchase and conversation history. Returns a durable run; its result carries sources, a verdict and a structured comparison.", inputSchema: MCP_TOOL_CONTRACTS.garderobe_research.input, outputSchema: McpResearchOutput, annotations: annotations("garderobe_research", "Research for the wardrobe") },
    async (args) => {
      try {
        const started = await startResearch(app, principal, { clientRequestId: `mcp:${caller.grantId}:${args.clientRequestId}`, topic: args.topic, kind: args.kind, ...(args.url ? { url: args.url } : {}) });
        return ok({ runId: started.runId, state: started.state, result: started.result }, started.result ? `${started.result.verdict ?? "Research finished"}: ${started.result.summary}` : `Research run ${started.runId} is ${started.state}. Use garderobe_run to follow it.`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  /* ---------------- garderobe_run ---------------- */
  server.registerTool(
    "garderobe_run",
    { title: "Follow a long operation", description: "Read the durable state of a run, answer the question it is waiting on, or cancel what remains. Committed changes stay committed after a cancel.", inputSchema: MCP_TOOL_CONTRACTS.garderobe_run.input, outputSchema: McpRunOutput, annotations: annotations("garderobe_run", "Follow a long operation") },
    async (args) => {
      try {
        if (args.action === "cancel") {
          const result = await cancelRun(app, principal, args.runId);
          return ok({ run: result.run, stopped: result.stopped }, `Run ${args.runId} is ${result.run.state}. ${result.stopped.join(" ")}`);
        }
        if (args.action === "respond") {
          if (!args.inputId) throw new ApiException("invalid_command", "action 'respond' needs inputId");
          const run = await answerRunInput(app, principal, args.runId, { inputId: args.inputId, ...(args.choiceId ? { choiceId: args.choiceId } : {}), ...(args.text ? { text: args.text } : {}) });
          return ok({ run, stopped: [] }, `Run ${args.runId} is ${run.state}.`);
        }
        const run = await getRun(app, principal, args.runId);
        return ok({ run, stopped: [] }, `Run ${args.runId} is ${run.state}${run.activity ? `: ${run.activity}` : ""}${run.pendingInput ? `. Waiting for: ${run.pendingInput.question}` : ""}`);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export { textOf };
export type { z };
