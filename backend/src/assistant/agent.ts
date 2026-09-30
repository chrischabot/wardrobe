import { Think, type Session as ThinkSessionType } from '@cloudflare/think';
import type { TurnConfig, TurnContext } from '@cloudflare/think';
import type { UIMessage } from 'ai';
import { z } from 'zod';
import { SourceChannel } from '@garderobe/contracts';
import { DomainError } from '../domain/errors.js';
import { sha256Hex } from '../domain/hash.js';
import { findForgedOwnerFields, ownerPrincipal, SCOPE_READ, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { GarderobeLanguageModel } from '../models/language-model.js';
import type { ModelService } from '../models/service.js';
import { actionIntentsFor, reconcilePendingIntents } from './actions.js';
import { createGarderobeCompaction } from './compaction.js';
import { buildMandatoryContext, type DayContextProvider, type MandatoryContext } from './context.js';
import { classifyTurnIntent } from './intent.js';
import { PROMPT_VERSION } from './policy.js';
import { createModelService, createRecallService, usesSimulatedModel } from './runtime.js';
import { reasoningDepthForTurn } from './model-routing.js';
import { stampOwnerMessageDates } from './turn-dates.js';
import { buildToolSet, type AssistantServices, type ToolContext } from './tools.js';
import type { OutfitCard } from './day-context.js';
import { TurnLedger, turnMeta, type TurnRow } from './turns.js';
import { describeReference, referencesFor, resolveReferences, storedReferences, TurnReferences } from './references.js';
import { createResearchService } from '../research/index.js';
import { createConnectorToolSource } from '../connectors/index.js';
import { redactionNotice, redactPastedSecrets, withoutPastedSecrets, type Redaction } from './secrets.js';

/**
 * GarderobeAssistant: the one continuous conversation per internal user, on @cloudflare/think
 * (SQLite Durable Object). Actor name = `${ENVIRONMENT}:${userId}`; only trusted backend code (API,
 * MCP server, scheduler) obtains a stub after authenticating the owner. The Worker never routes
 * public requests to this object.
 *
 * Per turn (beforeTurn): fresh mandatory context from D1 with the full verbatim profile, typed domain
 * tools bound to the owner's message and grant, reasoning hidden, MCP auto-merge off, workspace
 * tools hidden. Inference goes only through GarderobeLanguageModel -> ModelService -> AI Gateway.
 */

export const SubmitTurnInput = z.strictObject({
  clientTurnId: z.string().min(8).max(200).regex(/^[A-Za-z0-9:._\-]+$/),
  text: z.string().min(1).max(20_000),
  channel: SourceChannel.default('conversation'),
  attachments: z.array(z.strictObject({ kind: z.enum(['image', 'link', 'file']), ref: z.string().max(2000), mediaType: z.string().max(100).optional() })).max(10).optional(),
  captureIntent: z.enum(['add_item', 'identify', 'what_i_wore']).nullable().optional(),
  askAbout: z.strictObject({ kind: z.enum(['garment', 'outfit', 'board_option']), id: z.string().min(3).max(80) }).nullable().optional(),
  /** Ask-about-this references (garment or board option), kept with the stored user message. */
  references: TurnReferences.optional(),
  /** Set by the trusted caller from the authenticated grant (e.g. a read-only MCP grant). */
  grant: z.strictObject({ scopes: z.array(z.string().max(60)).max(20), authenticatedBy: z.string().max(40) }).optional(),
});
export type SubmitTurnInput = z.input<typeof SubmitTurnInput>;

export interface TurnReceipt {
  turnId: string;
  clientTurnId: string;
  status: TurnRow['status'];
  existing: boolean;
  submissionId: string | null;
  intent: { allowed: string[]; blocked: { family: string; reason: string }[] };
  /** Pasted secrets removed from the text before it was stored (ADV-17); absent when none. */
  redacted?: Redaction[];
  error?: { code: string; message: string };
}

export interface ResultCard {
  kind: string;
  title: string;
  summary: string;
  jobRef: string;
  data?: Record<string, unknown>;
}

const USER_ID = /^usr_[A-Za-z0-9_-]{4,64}$/;

function textOf(m: UIMessage | undefined): string {
  return (m?.parts ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
}

export class GarderobeAssistant extends Think {
  override sendReasoning = false;
  override includeMcpTools = false;
  override workspaceBash = false;
  override maxSteps = 8;

  /** Optional injected day context (daily service); defaults to the published board summary. */
  static dayContext: DayContextProvider | undefined;

  private current: { turn: TurnRow; context: MandatoryContext; cards: OutfitCard[]; references: string[]; depth: 'routine' | 'deep' } | null = null;
  private modelService: ModelService | null = null;

  get userId(): string {
    const name = this.name;
    const userId = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    if (!USER_ID.test(userId)) throw new DomainError('unauthenticated', 'Assistant actor is not bound to an internal user id');
    return userId;
  }

  private now(): string {
    return new Date().toISOString();
  }

  private models(): ModelService {
    this.modelService ??= createModelService(this.env, this.userId);
    return this.modelService;
  }

  private ledger(): TurnLedger {
    return new TurnLedger(this.env.DB);
  }

  private principal(turn: TurnRow | null): Principal {
    const grant = turn ? turnMeta(turn).grant : { scopes: [SCOPE_READ, SCOPE_WRITE], authenticatedBy: 'assistant' };
    return ownerPrincipal(this.userId, grant.authenticatedBy, grant.scopes);
  }

  private services(principal: Principal): AssistantServices {
    const recall = createRecallService(this.env);
    return {
      recall: { search: (p, q) => recall.search(p, q as never) },
      research: createResearchService(this.env, this.userId, () => this.models()),
      connectors: createConnectorToolSource(this.env, principal),
    };
  }

  private async timezone(): Promise<string> {
    const row = await this.env.DB.prepare('SELECT timezone FROM owner_settings WHERE user_id = ?').bind(this.userId).first<{ timezone: string }>();
    return row?.timezone ?? this.env.DEFAULT_TIMEZONE ?? 'Europe/London';
  }

  override getModel() {
    return new GarderobeLanguageModel(this.models(), {
      task: 'chat',
      // Routine turns on GPT-6.1 Sol, deeper-reasoning turns on Opus 5.5 medium (assistant/model-routing.ts).
      depth: () => this.current?.depth ?? 'routine',
      runRef: () => (this.current ? `turn:${this.current.turn.turn_id}` : 'turn:unbound'),
      promptVersion: PROMPT_VERSION,
      profileVersion: () => this.current?.context.profileVersion ?? null,
      dataClasses: ['profile', 'wardrobe', 'conversation'],
    });
  }

  override getSystemPrompt(): string {
    // Never used for inference: beforeTurn always supplies the assembled mandatory context.
    return 'Garderobe assistant. Mandatory context is assembled for every turn.';
  }

  override configureSession(session: ThinkSessionType) {
    return session
      .onCompaction(createGarderobeCompaction({ db: this.env.DB, userId: this.userId, models: () => this.models() }))
      .compactAfter(60_000);
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    // Bind the turn to the newest user message in the Session (the cached `messages` view can lag
    // behind a just-applied submission).
    let lastUser: UIMessage | undefined;
    for await (const m of this.session.history({ newestFirst: true })) {
      if ((m as unknown as UIMessage).role === 'user') {
        lastUser = m as unknown as UIMessage;
        break;
      }
    }
    let turn = lastUser ? await this.ledger().byUserMessageId(this.userId, lastUser.id) : null;
    if (!turn) {
      // A turn that did not come through submitTurn (should not happen: the Worker does not route
      // public traffic here). Treat it as an ordinary conversation turn with no special grant.
      const text = textOf(lastUser);
      const accepted = await this.ledger().accept(
        this.userId,
        `internal:${lastUser?.id ?? crypto.randomUUID()}`,
        { intent: classifyTurnIntent({ text }), body: { text, channel: 'conversation' }, grant: { scopes: [SCOPE_READ], authenticatedBy: 'internal' } },
        this.now(),
      );
      turn = accepted.turn;
    }
    await reconcilePendingIntents(this.env.DB, this.userId, this.now());
    const meta = turnMeta(turn);
    const principal = this.principal(turn);
    const timezone = await this.timezone();
    const references = storedReferences((lastUser as { metadata?: unknown } | undefined)?.metadata);
    const context = await buildMandatoryContext(this.env.DB, principal, {
      now: this.now(),
      timezone,
      turn: { channel: meta.body.channel, askAbout: (meta.body.askAbout as never) ?? null, references, intentSummary: meta.intent.summary },
      dayContext: GarderobeAssistant.dayContext,
    });
    const cards: OutfitCard[] = [];
    this.current = { turn, context, cards, references: references.map(describeReference), depth: reasoningDepthForTurn({ text: meta.body.text, attachments: meta.body.attachments as { kind: string }[] | undefined }) };
    await this.ledger().update(this.userId, turn.turn_id, { status: 'running', profile_version: context.profileVersion, context_digest: context.digest }, this.now());
    const services = this.services(principal);
    const toolCtx: ToolContext = {
      db: this.env.DB,
      principal,
      turnId: turn.turn_id,
      channel: meta.body.channel as ToolContext['channel'],
      ownerText: meta.body.text,
      intent: meta.intent,
      timezone,
      now: () => this.now(),
      services,
      cards,
    };
    const tools = { ...buildToolSet(toolCtx), ...(services.connectors ? await services.connectors.toolSet(principal, turn.turn_id) : {}) };
    return {
      instructions: context.instructions,
      tools,
      activeTools: Object.keys(tools),
      sendReasoning: false,
      maxSteps: 8,
      messages: await this.stampTurnDates(await this.withdrawInvalidSummaries(ctx.messages), timezone),
    };
  }

  /**
   * Each owner message in the model's view starts with when he sent it (turn-dates.ts), so an answer
   * from an earlier day is never read as today's (simulation finding D4). The stored transcript is
   * unchanged.
   */
  private async stampTurnDates(messages: TurnContext['messages'], timezone: string): Promise<TurnContext['messages']> {
    const { results } = await this.env.DB.prepare('SELECT created_at, intent_json FROM assistant_turns WHERE user_id = ? ORDER BY created_at DESC LIMIT 500')
      .bind(this.userId)
      .all<{ created_at: string; intent_json: string }>();
    const turns = results.map((r) => ({ at: r.created_at, text: turnMeta(r as unknown as TurnRow).body.text ?? '' }));
    return stampOwnerMessageDates(messages, turns, timezone);
  }

  /** Replace summaries whose checkpoint was invalidated by a deletion (read-time suppression). */
  private async withdrawInvalidSummaries(messages: TurnContext['messages']): Promise<TurnContext['messages']> {
    const { results } = await this.env.DB.prepare("SELECT summary_sha256 FROM compaction_checkpoints WHERE user_id = ? AND status = 'invalidated'").bind(this.userId).all<{ summary_sha256: string }>();
    const tombstoned = await createRecallService(this.env).tombstones(this.userId);
    if (!results.length && !tombstoned.length) return messages;
    const bad = new Set(results.map((r) => r.summary_sha256));
    const out: TurnContext['messages'] = [];
    for (const m of messages) {
      const content = (m as { content: unknown }).content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p.text ?? '').join('') : '';
      let withdrawn = false;
      for (const candidate of [text, text.replace(/^[^\n]*\n/, '')]) if (candidate && bad.has(await sha256Hex(candidate))) withdrawn = true;
      if (!withdrawn && bad.size) {
        // Summaries may carry a prefix; compare every suffix after the first line break too.
        const idx = text.indexOf('\n');
        if (idx >= 0 && bad.has(await sha256Hex(text.slice(idx + 1)))) withdrawn = true;
      }
      out.push(withdrawn ? ({ ...m, content: '[An earlier summary was withdrawn because a source it covered was deleted; it is being regenerated.]' } as never) : m);
    }
    return out;
  }

  override async onChatResponse(result: { message: UIMessage; status: 'completed' | 'error' | 'aborted'; error?: string }): Promise<void> {
    const cur = this.current;
    this.current = null;
    if (cur) {
      const status = result.status === 'completed' ? 'completed' : result.status === 'aborted' ? 'cancelled' : 'failed';
      await this.ledger().update(
        this.userId,
        cur.turn.turn_id,
        {
          status,
          result_json: JSON.stringify({
            messageId: result.message.id,
            text: withoutPastedSecrets(textOf(result.message)).slice(0, 4000),
            // Outfit cards are shown from here; `actionable` comes only from the daily service's validator.
            cards: cur.cards,
            day: { sources: cur.context.daySources, fallback: cur.context.dayFallback },
          }),
          error: result.error ?? null,
        },
        this.now(),
      );
      const recall = createRecallService(this.env);
      await recall.project(this.userId, [
        {
          messageId: cur.turn.user_message_id,
          role: 'user',
          // Recall keeps what was asked about, with the names the owner saw.
          text: [turnMeta(cur.turn).body.text, ...(cur.references.length ? [`Asked about: ${cur.references.join('; ')}`] : [])].join('\n'),
          authoredAt: cur.turn.created_at,
          channel: cur.turn.channel,
        },
        { messageId: result.message.id, role: 'assistant', text: textOf(result.message), authoredAt: this.now(), channel: cur.turn.channel },
      ]);
      await recall.catchUp(this.userId).catch(() => undefined);
    }
    await this.flushDeliveries();
  }

  override onChatError(error: unknown): unknown {
    const cur = this.current;
    if (cur) {
      const e = error as { code?: string; kind?: string; name?: string } | null;
      // A TransportError that no fallback absorbed names its class; its message carries the provider's status and text.
      const code = e?.code ?? (e?.name === 'TransportError' && e.kind ? `model_${e.kind}` : 'turn_failed');
      void this.ledger().update(this.userId, cur.turn.turn_id, { status: 'failed', error: `${code}: ${error instanceof Error ? error.message : String(error)}` }, this.now());
    }
    return error;
  }

  // ------------------------------------------------------------------ RPC surface (trusted callers only)

  /** Accept a conversational turn durably with its stable client id, then queue inference in order. */
  async submitTurn(raw: SubmitTurnInput): Promise<TurnReceipt> {
    try {
      return await this.acceptTurn(raw);
    } catch (err) {
      // Refusals cross the RPC boundary as structured results, never as thrown errors.
      const code = err instanceof DomainError ? err.code : err instanceof z.ZodError ? 'validation_failed' : 'turn_rejected';
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : err instanceof Error ? err.message : String(err);
      const clientTurnId = typeof (raw as { clientTurnId?: unknown })?.clientTurnId === 'string' ? (raw as { clientTurnId: string }).clientTurnId : '';
      return { turnId: '', clientTurnId, status: 'failed', existing: false, submissionId: null, intent: { allowed: [], blocked: [] }, error: { code, message } };
    }
  }

  private async acceptTurn(raw: SubmitTurnInput): Promise<TurnReceipt> {
    const forged = findForgedOwnerFields(raw);
    if (forged.length) throw new DomainError('forbidden_owner_field', 'Owner identity comes from the authenticated connection', { fields: forged });
    const input = SubmitTurnInput.parse(raw);
    // Pasted recovery codes, tokens and keys never enter the ledger, the Session, recall, the model
    // context or an export: everything below sees only the redacted text.
    const { text, redactions } = redactPastedSecrets(input.text);
    const attachments = (input.attachments ?? []).map((a) => (a.kind === 'link' ? { ...a, ref: withoutPastedSecrets(a.ref) } : a));
    const intent = classifyTurnIntent({ text, attachments, captureIntent: input.captureIntent ?? null });
    const grant = input.grant ?? { scopes: [SCOPE_READ, SCOPE_WRITE], authenticatedBy: 'access' };
    const body = {
      text,
      channel: input.channel,
      attachments,
      captureIntent: input.captureIntent ?? null,
      askAbout: input.askAbout ?? null,
      // Only present when sent, so turns accepted before references existed keep their request hash.
      ...(input.references?.length ? { references: input.references } : {}),
    };
    const { turn, existing } = await this.ledger().accept(this.userId, input.clientTurnId, { intent, body, grant }, this.now());
    if (existing) return this.receipt(turn, true, redactions);
    // Resolved against the owner's own records now, so the stored message shows what the owner saw.
    const references = await resolveReferences(this.env.DB, this.userId, await referencesFor(this.env.DB, this.userId, input.references, input.askAbout));
    const message: UIMessage = {
      id: turn.user_message_id,
      role: 'user',
      parts: [{ type: 'text', text }],
      metadata: {
        turnId: turn.turn_id,
        clientTurnId: input.clientTurnId,
        sourceChannel: input.channel,
        attachments,
        ...(references.length ? { references } : {}),
        ...(input.askAbout ? { askAbout: input.askAbout } : {}),
        ...(redactions.length ? { redactions } : {}),
      },
    } as UIMessage;
    const sub = await this.submitMessages([message], { idempotencyKey: `turn:${input.clientTurnId}`, metadata: { turnId: turn.turn_id } });
    await this.ledger().update(this.userId, turn.turn_id, { submission_id: sub.submissionId }, this.now());
    // The owner's note: a settled card after the reply, without an inference turn. Its jobRef names the
    // turn as `message:<owner message id>`, the id the turn response and transcript give the app, so a
    // client can tie the card to exactly this turn (the internal turn id is never exposed).
    if (redactions.length) await this.deliverResult({ deliveryId: `redaction:${turn.turn_id}`, card: { kind: 'notice', ...redactionNotice(redactions), jobRef: `message:${turn.user_message_id}`, data: { redactions } } });
    return this.receipt({ ...turn, submission_id: sub.submissionId }, false, redactions);
  }

  private receipt(turn: TurnRow, existing: boolean, redacted: Redaction[] = []): TurnReceipt {
    const meta = turnMeta(turn);
    return {
      turnId: turn.turn_id,
      clientTurnId: turn.client_turn_id,
      status: turn.status,
      existing,
      submissionId: turn.submission_id,
      intent: { allowed: meta.intent.allowed, blocked: meta.intent.blocked },
      ...(redacted.length ? { redacted } : {}),
    };
  }

  async getTurn(clientTurnId: string): Promise<(TurnReceipt & { result: unknown; failure: string | null; profileVersion: number | null; contextDigest: string | null }) | null> {
    const t = await this.ledger().byClientId(this.userId, clientTurnId);
    if (!t) return null;
    return { ...this.receipt(t, true), result: t.result_json ? JSON.parse(t.result_json) : null, failure: t.error, profileVersion: t.profile_version, contextDigest: t.context_digest };
  }

  /** Stop: cancel queued and running inference; report effects that already committed (undo is separate). */
  async stop(reason = 'stopped by owner'): Promise<{ cancelledTurns: string[]; committedEffects: { turnId: string; operation: string; commandId: string | null }[] }> {
    const active = await this.listSubmissions({ status: ['pending', 'running'] });
    for (const s of active) await this.cancelSubmission(s.submissionId, reason);
    const turns = await this.ledger().active(this.userId);
    const committedEffects: { turnId: string; operation: string; commandId: string | null }[] = [];
    for (const t of turns) {
      await this.ledger().update(this.userId, t.turn_id, { status: 'cancelled', error: reason }, this.now());
      for (const a of await actionIntentsFor(this.env.DB, this.userId, t.turn_id)) if (a.status === 'committed') committedEffects.push({ turnId: t.turn_id, operation: a.operation, commandId: a.commandId });
    }
    return { cancelledTurns: turns.map((t) => t.turn_id), committedEffects };
  }

  /** Stop and send: cancel remaining inference, then accept the new message as the next turn. */
  async stopAndSend(raw: SubmitTurnInput): Promise<TurnReceipt & { stopped: Awaited<ReturnType<GarderobeAssistant['stop']>> }> {
    const stopped = await this.stop('stop and send');
    const receipt = await this.submitTurn(raw);
    return { ...receipt, stopped };
  }

  /**
   * Background result delivery (Workflows, research jobs): deduplicated by delivery id, ownership
   * rechecked, appended as one settled card at a message boundary without an inference turn.
   */
  async deliverResult(input: { deliveryId: string; card: ResultCard }): Promise<{ status: 'appended' | 'pending' | 'duplicate' }> {
    const forged = findForgedOwnerFields(input);
    if (forged.length) return { status: 'duplicate' };
    const res = await this.env.DB.prepare(
      `INSERT INTO assistant_deliveries (user_id, delivery_id, job_ref, card_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT (user_id, delivery_id) DO NOTHING`,
    )
      .bind(this.userId, input.deliveryId, input.card.jobRef, JSON.stringify(input.card), this.now())
      .run();
    if (!res.meta.changes) return { status: 'duplicate' };
    const busy = await this.listSubmissions({ status: ['pending', 'running'] });
    if (busy.length || this.current) return { status: 'pending' };
    await this.flushDeliveries();
    return { status: 'appended' };
  }

  private async flushDeliveries(): Promise<void> {
    const { results } = await this.env.DB.prepare("SELECT delivery_id, card_json FROM assistant_deliveries WHERE user_id = ? AND status = 'pending' ORDER BY created_at").bind(this.userId).all<{ delivery_id: string; card_json: string }>();
    for (const d of results) {
      const card = JSON.parse(d.card_json) as ResultCard;
      const messageId = `delivery_${d.delivery_id}`;
      await this.addMessages([{ id: messageId, role: 'assistant', parts: [{ type: 'text', text: `${card.title}\n${card.summary}` }], metadata: { kind: 'result_card', card } } as UIMessage]);
      await this.env.DB.prepare("UPDATE assistant_deliveries SET status = 'appended', appended_message_id = ?, appended_at = ? WHERE user_id = ? AND delivery_id = ?").bind(messageId, this.now(), this.userId, d.delivery_id).run();
      await createRecallService(this.env).project(this.userId, [{ messageId, role: 'assistant', text: `${card.title}. ${card.summary}`, authoredAt: this.now(), channel: 'system' }]);
    }
  }

  /** Wait until no submission is pending or running (tests and synchronous API callers). */
  async waitForIdle(timeoutMs = 20_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const busy = await this.listSubmissions({ status: ['pending', 'running'] });
      if (!busy.length && !this.current) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  /**
   * Original transcript (not the compacted view): message ids in Session order, each read with
   * getMessage(), which returns the stored message byte-for-byte regardless of overlays.
   */
  async rawTranscript(limit = 500): Promise<{ id: string; role: string; text: string; metadata: unknown }[]> {
    const rows = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM cf_agents_session_messages WHERE session_id = '' ORDER BY seq LIMIT ?", limit).toArray();
    const out: { id: string; role: string; text: string; metadata: unknown }[] = [];
    for (const r of rows) {
      const m = (await this.session.getMessage(r.id)) as unknown as UIMessage | null;
      if (m) out.push({ id: m.id, role: m.role, text: textOf(m), metadata: (m as { metadata?: unknown }).metadata ?? null });
    }
    return out;
  }

  /** Compacted working view (what the next model call sees before mandatory context). */
  async workingHistory(): Promise<{ id: string; role: string; text: string }[]> {
    const msgs = await this.session.getHistory();
    return msgs.map((m) => ({ id: m.id, role: (m as unknown as UIMessage).role, text: textOf(m as unknown as UIMessage) }));
  }

  async compactNow(): Promise<{ compacted: boolean }> {
    const r = await this.session.compact();
    return { compacted: Boolean(r) };
  }

  /** Forget one source message: tombstone, projection/index removal, checkpoint invalidation, Session deletion. */
  async forgetMessage(messageId: string, reason = 'owner request'): Promise<{ invalidatedCheckpoints: string[]; erased: boolean }> {
    const recall = createRecallService(this.env);
    const { invalidatedCheckpoints } = await recall.forget(this.userId, messageId, reason);
    let erased = false;
    try {
      await this.session.deleteMessages([messageId]);
      erased = (await this.session.getMessage(messageId)) === null;
    } catch {
      erased = false;
    }
    if (erased) await recall.markErased(this.userId, messageId);
    return { invalidatedCheckpoints, erased };
  }

  async runtimeInfo(): Promise<{ userId: string; simulatedModel: boolean; promptVersion: string }> {
    return { userId: this.userId, simulatedModel: usesSimulatedModel(this.env), promptVersion: PROMPT_VERSION };
  }
}
