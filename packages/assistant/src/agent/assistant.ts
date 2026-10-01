/**
 * The conversation authority: one Think Durable Object per internal user ID (specification section 4).
 *
 * Think (pinned @cloudflare/think 0.19.0 with agents 0.24.0 and ai 7.0.124) supplies the durable chat loop,
 * the persisted Session, turn queueing and recovery. This class supplies the wardrobe semantics around it:
 *   - turns are accepted durably under a stable turn ID bound to the owner and the request body (D1);
 *   - every model turn gets the mandatory context, rebuilt from current D1 state at turn start, and the
 *     typed tools of this turn's runtime; mutations only happen through the shared command service;
 *   - inference goes through the application model service (reservation, Gateway adapter, fallback);
 *   - `sendReasoning` is off; clients see activity, receipts and text, never raw reasoning;
 *   - the original transcript is addressed through an append-only ID ledger in the actor's own SQLite and
 *     `session.getMessage()`, never through `getHistory()` (which applies compaction overlays);
 *   - compaction runs through the same model service, writes a checkpoint, and never deletes history.
 *
 * The actor trusts only its own name for the owner: `this.name` is the internal user ID chosen by trusted
 * Worker code from the verified identity (see client.ts). Nothing in a request body can name an owner.
 */
import { Think, defaultContextOverflowClassifier, type ChatResponseResult, type Session as ThinkSession, type TurnConfig, type TurnContext } from "@cloudflare/think";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { ClarificationAnswer, ResearchRequest, ResultDelivery, TurnGrant, TurnInput, type TranscriptMessage, type TranscriptPage, type TurnRecord } from "@garderobe/contracts/ext/assistant";
import type { Scope } from "@garderobe/contracts";
import {
  CommandService,
  all,
  canonicalJson,
  createFoundationRegistry,
  createPrincipal,
  first,
  getSettings,
  isCommandError,
  json,
  localDateOf,
  newId,
  prepare,
  sha256Hex,
  stmt,
  systemPrincipalFor,
  toInstant,
  type CommandRegistry,
  type Db,
  type Principal,
} from "@garderobe/domain";
import { registerAssistant } from "../commands/index.ts";
import { ASSISTANT_PROMPT_VERSION, assembleMandatoryContext, estimateTokens } from "../context/mandatory.ts";
import { BudgetExceededError, InferenceFailedError, ModelService, NoSelectableProfileError, type ModelCallMeta } from "../inference/service.ts";
import type { ProfileSpec } from "../inference/registry.ts";
import { redactDeep, redactSecrets } from "../policy/secrets.ts";
import { tombstonedIds } from "../queries.ts";
import { indexMessages, indexWatermark, recall, type CanonicalMessage, type RecallInput } from "../recall/index.ts";
import { wrapUntrusted } from "../research/index.ts";
import { buildReadTools } from "../tools/read.ts";
import { buildWriteTools } from "../tools/write.ts";
import type { AssistantPorts, TurnRuntime } from "../tools/runtime.ts";
import { SubmissionReuseError, acceptTurnRow, emitTurnEvent, findTurn, findTurnBySubmission, readTurnEvents, recordProposal, recordReceipt, recordRefusal, toTurnRecord, updateTurn, type TurnRow } from "./turns.ts";
import { COMPACTION_PROMPT_VERSION, buildCompaction } from "./compaction.ts";

export interface AssistantEnv {
  DB: D1Database;
  AI?: Ai;
  AI_GATEWAY_ID?: string;
  ENVIRONMENT?: string;
  AI_SEARCH?: AiSearchNamespace;
}

export interface AssistantConfiguration {
  /** The composed command registry (foundation + daily + assistant + ...), so commit hooks such as board repair run for assistant commands too. */
  registry?: () => CommandRegistry;
  /** Optional capabilities (outfit validation, search, extraction, AI Search index). */
  ports?: (env: AssistantEnv, userId: string) => AssistantPorts;
}

let configuration: AssistantConfiguration = {};

/** Called once by the composition root (apps/worker) at module load. */
export function configureAssistant(config: AssistantConfiguration): void {
  configuration = config;
}

const FORGOTTEN_TEXT = "[forgotten at the owner's request]";
const MAX_ATTACHMENT_CHARS = 60_000;

interface TurnMeta {
  turnId: string;
  channel: string;
  authoredAt: string;
  kind: string;
}

function metaOf(message: { metadata?: unknown }): TurnMeta | null {
  const g = (message.metadata as { garderobe?: TurnMeta } | undefined)?.garderobe;
  return g && typeof g.turnId === "string" ? g : null;
}

function textOf(parts: { type: string; text?: string }[]): string {
  return parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

export interface RequestRejection {
  rejected: { code: string; message: string };
}

export class RequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export abstract class GarderobeAssistantBase extends Think<any> {
  override sendReasoning = false;
  override maxSteps = 12;
  /** The default shell tool is not part of this product's tool surface. */
  override workspaceBash: any = false;
  /** Outbound MCP tools are exposed only through the connection policy, never merged automatically. */
  override includeMcpTools = false;
  override contextOverflow = { reactive: true, maxRetries: 1 };
  override classifyChatError = defaultContextOverflowClassifier;

  /** Token estimate after which older history is compacted (well under 65% of the smallest candidate context). */
  protected compactAfterTokens = 60_000;
  /** Messages at the tail that are never compacted. */
  protected compactKeepRecent = 8;

  private activeTurnId: string | null = null;
  private turnsInFlight = 0;
  /** Failures seen by onChatError, read synchronously when the turn is finalized. */
  private readonly turnFailures = new Map<string, { code: string; message: string; resumable: boolean }>();
  private modelServiceInstance: ModelService | null = null;
  private commandServiceInstance: CommandService | null = null;

  constructor(ctx: DurableObjectState, env: AssistantEnv) {
    super(ctx, env as any);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS gd_transcript (position INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL, turn_id TEXT, channel TEXT, kind TEXT NOT NULL, authored_at TEXT NOT NULL)`,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Seams                                                                */
  /* ------------------------------------------------------------------ */

  /** The model boundary. Production routes through AI Gateway; tests substitute a labelled deterministic fake. */
  protected abstract createLanguageModel(spec: ProfileSpec, meta: ModelCallMeta): LanguageModelV4;
  /** Named Gateway of this environment (accounting key for probes, breakers and reservations). */
  protected abstract gatewayId(): string;

  protected now(): number {
    return Date.now();
  }
  protected get db(): Db {
    return (this.env as AssistantEnv).DB;
  }
  protected get userId(): string {
    return this.name;
  }
  protected ports(): AssistantPorts {
    return configuration.ports?.(this.env as AssistantEnv, this.userId) ?? {};
  }
  protected commands(): CommandService {
    this.commandServiceInstance ??= new CommandService({ db: this.db, registry: configuration.registry?.() ?? registerAssistant(createFoundationRegistry()), clock: () => this.now() });
    return this.commandServiceInstance;
  }
  protected models(): ModelService {
    this.modelServiceInstance ??= new ModelService({ db: this.db, service: this.commands(), gatewayId: this.gatewayId(), clock: () => this.now(), createLanguageModel: (spec, meta) => this.createLanguageModel(spec, meta) });
    return this.modelServiceInstance;
  }

  /* ------------------------------------------------------------------ */
  /* Think configuration                                                  */
  /* ------------------------------------------------------------------ */

  override getModel(): any {
    return this.models().modelFor({ userId: this.userId, task: "conversation", parent: { kind: "turn", id: this.activeTurnId ?? "unbound" }, promptVersion: ASSISTANT_PROMPT_VERSION });
  }

  /** Fallback only: every real turn replaces this with the mandatory context in beforeTurn. */
  override getSystemPrompt(): string {
    return "Garderobe assistant. No owner turn is bound; do not answer.";
  }

  override configureSession(session: ThinkSession): ThinkSession {
    return session.onCompaction((messages) => this.compact(messages as { id: string; role: string; parts: { type: string; text?: string }[] }[])).compactAfter(this.compactAfterTokens);
  }

  private async compact(messages: { id: string; role: string; parts: { type: string; text?: string }[] }[]) {
    const forgotten = await tombstonedIds(this.db, this.userId, "message");
    try {
      const built = await buildCompaction({
        messages: messages.filter((m) => !forgotten.has(m.id)),
        keepRecent: this.compactKeepRecent,
        summarize: async (system, prompt) => {
          // The compaction model call reserves budget and goes through the Gateway like any other.
          const out = await this.models().generateText({ userId: this.userId, task: "compaction", parent: { kind: "compaction", id: this.userId }, promptVersion: COMPACTION_PROMPT_VERSION, estimatedInputTokens: estimateTokens(system + prompt) }, { system, prompt });
          return { text: out.text, profileId: out.run?.profileId ?? "unknown" };
        },
      });
      if (!built) return null;
      await prepare(
        this.db,
        stmt(
          "INSERT INTO compaction_checkpoints (user_id, checkpoint_id, conversation_id, from_message_id, to_message_id, covered_ids_json, model_profile, prompt_version, summary_sha256, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
          this.userId, newId("cmp"), this.userId, built.fromMessageId, built.toMessageId, JSON.stringify(built.coveredIds), built.profileId, COMPACTION_PROMPT_VERSION, await sha256Hex(built.summary), toInstant(this.now()),
        ),
      ).run();
      return { fromMessageId: built.fromMessageId, toMessageId: built.toMessageId, summary: built.summary };
    } catch (e) {
      // Budget exhausted or no model: keep the full history; never fall back to an unbudgeted request.
      if (e instanceof BudgetExceededError || e instanceof NoSelectableProfileError || e instanceof InferenceFailedError) return null;
      throw e;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Turn hooks                                                           */
  /* ------------------------------------------------------------------ */

  /** The turn the model is about to serve, found from the last owner message in the transcript (survives eviction). */
  private async boundTurn(): Promise<{ row: TurnRow; message: UIMessage } | null> {
    const messages = this.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "user") continue;
      const meta = metaOf(m);
      if (!meta) return null;
      const row = await findTurn(this.db, this.userId, meta.turnId);
      return row ? { row, message: m } : null;
    }
    return null;
  }

  private principalFor(row: TurnRow): Principal {
    return createPrincipal({ userId: this.userId, actor: "assistant", channel: row.channel as "ios" | "web" | "mcp", scopes: json<Scope[]>(row.scopes_json, ["read"]), authRef: `turn:${row.turn_id}` });
  }

  /** Owner text of this turn first, then the most recent earlier owner messages (for confirmations of a prior request). */
  private ownerTexts(current: UIMessage): string[] {
    const out: string[] = [];
    const own = (m: UIMessage) => {
      const first = (m.parts as { type: string; text?: string }[]).find((p) => p.type === "text");
      return first?.text ?? "";
    };
    out.push(own(current));
    const messages = this.messages;
    for (let i = messages.length - 1; i >= 0 && out.length < 4; i--) {
      const m = messages[i]!;
      if (m.role === "user" && m.id !== current.id && metaOf(m)?.kind === "owner") out.push(own(m));
    }
    return out.filter((t) => t && t !== FORGOTTEN_TEXT);
  }

  override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    void ctx;
    await this.reconcileErasures();
    const bound = await this.boundTurn();
    if (!bound) throw new Error("no accepted owner turn is bound to this inference; refusing to run");
    const { row, message } = bound;
    this.activeTurnId = row.turn_id;
    const nowMs = this.now();
    const principal = this.principalFor(row);
    // Re-check the account on every turn (a disabled account stops here).
    await systemPrincipalFor(this.db, this.userId, `turn:${row.turn_id}`);
    const meta = metaOf(message)!;
    this.ledger(message.id, "user", row.turn_id, row.channel, meta.kind, meta.authoredAt);
    if (row.status === "accepted") {
      await updateTurn(this.db, this.userId, row.turn_id, { status: "running" }, nowMs);
      await emitTurnEvent(this.db, this.userId, row.turn_id, "run_started", { channel: row.channel }, nowMs);
    }

    const attachedRefs = ((message.metadata as { garderobe?: { attachedRefs?: string[] } }).garderobe?.attachedRefs ?? []) as string[];
    const context = await assembleMandatoryContext(this.db, principal, { nowMs, attachedRefs, channel: row.channel });
    const readOnly = !principal.scopes.includes("write") && !principal.scopes.includes("admin");
    const userId = this.userId;
    const db = this.db;
    const rt: TurnRuntime = {
      db,
      service: this.commands(),
      principal,
      turnId: row.turn_id,
      userMessageId: message.id,
      channel: row.channel,
      readOnly,
      now: () => this.now(),
      localDate: context.localDate,
      ownerTexts: this.ownerTexts(message),
      attachedRefs,
      conversationId: userId,
      unindexedSource: () => this.unindexedMessages(),
      ports: this.ports(),
      onReceipt: (receipt) => recordReceipt(db, userId, row.turn_id, receipt, this.now()),
      onRefusal: (refusal) => recordRefusal(db, userId, row.turn_id, refusal),
      onProposal: (proposal) => recordProposal(db, userId, row.turn_id, proposal),
      onClarification: async (c) => {
        const clarification = { inputId: newId("inp"), question: c.question, choices: c.choices, actionId: c.actionId };
        await updateTurn(db, userId, row.turn_id, { clarification_json: JSON.stringify(clarification) }, this.now());
        await emitTurnEvent(db, userId, row.turn_id, "needs_input", clarification, this.now());
      },
      onActivity: (label, data) => emitTurnEvent(db, userId, row.turn_id, "activity", { label, ...(data ?? {}) }, this.now()),
    };
    const tools = { ...buildReadTools(rt), ...buildWriteTools(rt) };
    const model = this.models().modelFor({
      userId,
      task: row.kind === "research" ? "historical_research" : "conversation",
      parent: { kind: "turn", id: row.turn_id },
      promptVersion: ASSISTANT_PROMPT_VERSION,
      // The complete profile always goes in: a profile whose window cannot hold it is skipped, never trimmed.
      minContextTokens: context.estimatedTokens + 6_000,
      estimatedInputTokens: context.estimatedTokens + 4_000,
      onAttempt: (info) => void updateTurn(db, userId, row.turn_id, { model_profile: info.profileId }, this.now()),
      // Think reports a failed turn as a string; the typed failure is kept here so the turn can be marked resumable.
      onFailure: (error) => void this.turnFailures.set(row.turn_id, this.describeFailure(error)),
    });
    const instructions = readOnly ? `${context.system}\n\n===== THIS CONNECTION IS READ-ONLY =====\nYou cannot change anything in this turn. If the owner asks for a change, call the tool anyway: it will be recorded as a proposal for the owner to confirm, and you must say it was NOT done.` : context.system;
    return { model: model as any, instructions, tools, activeTools: Object.keys(tools), sendReasoning: false };
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    await this.finalizeTurn(turnId, result.status === "completed" ? null : { code: "turn_failed", message: result.error ?? "the turn did not complete" });
  }

  override onChatError(error: unknown): unknown {
    const turnId = this.activeTurnId;
    if (turnId) this.turnFailures.set(turnId, this.describeFailure(error));
    return error;
  }

  /** A failure that keeps the request for later (budget, no verified profile, provider outage) is resumable, never a silent drop or a loop. */
  private describeFailure(error: unknown): { code: string; message: string; resumable: boolean } {
    const resumable = error instanceof BudgetExceededError || error instanceof NoSelectableProfileError || error instanceof InferenceFailedError;
    return { code: (error as { code?: string })?.code ?? "turn_failed", message: redactSecrets(String((error as Error)?.message ?? error)).text.slice(0, 500), resumable };
  }

  private async failTurn(turnId: string, failure: { code: string; message: string; resumable: boolean }): Promise<void> {
    const row = await findTurn(this.db, this.userId, turnId);
    if (!row || ["completed", "cancelled", "needs_input"].includes(row.status)) return;
    const nowMs = this.now();
    await updateTurn(this.db, this.userId, turnId, { status: failure.resumable ? "resumable" : "failed", failure_json: JSON.stringify(failure), completed_at: toInstant(nowMs) }, nowMs);
    await emitTurnEvent(this.db, this.userId, turnId, "run_finished", { status: failure.resumable ? "resumable" : "failed", failure }, nowMs);
  }

  private async finalizeTurn(turnId: string, failure: { code: string; message: string } | null): Promise<void> {
    const row = await findTurn(this.db, this.userId, turnId);
    if (!row || ["completed", "cancelled", "needs_input", "resumable", "failed"].includes(row.status)) return;
    const seen = this.turnFailures.get(turnId);
    this.turnFailures.delete(turnId);
    if (seen || failure) {
      await this.failTurn(turnId, seen ?? { ...failure!, resumable: false });
      return;
    }
    const nowMs = this.now();
    const messages = this.messages;
    const at = messages.findIndex((m) => m.id === row.user_message_id);
    const replies = at === -1 ? [] : messages.slice(at + 1).filter((m) => m.role === "assistant");
    const reply = replies[replies.length - 1];
    const replyText = redactSecrets(replies.map((m) => textOf(m.parts as { type: string; text?: string }[])).filter(Boolean).join("\n")).text;
    for (const m of replies) this.ledger(m.id, "assistant", turnId, row.channel, "reply", toInstant(nowMs));
    const fresh = (await findTurn(this.db, this.userId, turnId))!;
    const status = fresh.clarification_json ? "needs_input" : "completed";
    const result = row.kind === "research" ? await this.researchResult(fresh, replyText) : null;
    await updateTurn(this.db, this.userId, turnId, { status, reply_message_id: reply?.id ?? null, reply_text: replyText, completed_at: toInstant(nowMs), ...(result ? { result_json: JSON.stringify(result) } : {}) }, nowMs);
    if (result && result.sources.length > 0) await emitTurnEvent(this.db, this.userId, turnId, "sources", { sources: result.sources }, nowMs);
    if (replyText) await emitTurnEvent(this.db, this.userId, turnId, "text_delta", { text: replyText, final: true }, nowMs);
    await emitTurnEvent(this.db, this.userId, turnId, "run_finished", { status, receipts: json<unknown[]>(fresh.receipts_json, []).length }, nowMs);
    await this.projectIndex();
  }

  /**
   * The structured result of a research turn. Verdict, comparison and sources are read back from the records
   * the turn's own commands wrote (fit assessments, product observations, saved notes) - not parsed from prose.
   */
  private async researchResult(row: TurnRow, replyText: string): Promise<{ verdict: string | null; summary: string; comparison: Record<string, unknown>[]; sources: Record<string, unknown>[] }> {
    const commandIds = json<{ commandId: string }[]>(row.receipts_json, []).map((r) => r.commandId);
    const comparison: Record<string, unknown>[] = [];
    const sources: Record<string, unknown>[] = [];
    let verdict: string | null = null;
    for (const commandId of commandIds) {
      for (const o of await all<any>(this.db, "SELECT o.*, p.name FROM product_observations o JOIN products p ON p.user_id = o.user_id AND p.product_id = o.product_id WHERE o.user_id = ? AND o.command_id = ?", this.userId, commandId)) {
        comparison.push({ productId: o.product_id, name: o.name, availability: o.availability, size: o.size, colour: o.colour, priceMinor: o.price_minor, currency: o.currency, observedAt: o.observed_at, owned: false });
        sources.push({ title: o.name, url: o.checked_url, checkedAt: o.observed_at, kind: "product_page", excerpt: null });
      }
      for (const f of await all<any>(this.db, "SELECT verdict FROM fit_assessments WHERE user_id = ? AND command_id = ?", this.userId, commandId)) verdict = String(f.verdict);
      for (const n of await all<any>(this.db, "SELECT claims_json FROM research_notes WHERE user_id = ? AND command_id = ? AND status = 'active'", this.userId, commandId)) {
        for (const claim of json<{ text: string; status: string; support: { url: string; passage: string; date: string | null; sourceClass: string }[] }[]>(n.claims_json, [])) {
          for (const s of claim.support) sources.push({ title: claim.text.slice(0, 120), url: s.url, checkedAt: s.date, kind: s.sourceClass, excerpt: s.passage.slice(0, 500), claimStatus: claim.status });
        }
      }
    }
    return { verdict, summary: replyText, comparison, sources };
  }

  /* ------------------------------------------------------------------ */
  /* Original-message ledger and retrieval projection                     */
  /* ------------------------------------------------------------------ */

  private ledger(messageId: string, role: string, turnId: string | null, channel: string | null, kind: string, authoredAt: string): void {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO gd_transcript (message_id, role, turn_id, channel, kind, authored_at) VALUES (?, ?, ?, ?, ?, ?)", messageId, role, turnId, channel, kind, authoredAt);
  }

  private ledgerRows(where = "", ...params: (string | number)[]): { position: number; message_id: string; role: string; turn_id: string | null; channel: string | null; kind: string; authored_at: string }[] {
    return this.ctx.storage.sql.exec(`SELECT position, message_id, role, turn_id, channel, kind, authored_at FROM gd_transcript ${where}`, ...params).toArray() as never;
  }

  /** What the owner or the assistant actually said in a message: the first text part of an owner message (attachments are data, not speech). */
  private async canonical(row: { position: number; message_id: string; role: string; turn_id: string | null; channel: string | null; kind: string; authored_at: string }): Promise<CanonicalMessage | null> {
    const m = await this.session.getMessage(row.message_id);
    if (!m) return null;
    const parts = m.parts as { type: string; text?: string }[];
    const text = row.role === "user" ? (parts.find((p) => p.type === "text")?.text ?? "") : textOf(parts);
    if (text === FORGOTTEN_TEXT) return null;
    return { messageId: row.message_id, position: row.position, role: row.role as "user" | "assistant", text, authoredAt: row.authored_at, channel: row.channel, turnId: row.turn_id };
  }

  private async unindexedMessages(): Promise<CanonicalMessage[]> {
    const mark = await indexWatermark(this.db, this.userId, this.userId);
    const out: CanonicalMessage[] = [];
    for (const row of this.ledgerRows("WHERE position > ? ORDER BY position", mark.indexedPosition)) {
      const c = await this.canonical(row);
      if (c) out.push(c);
    }
    return out;
  }

  /** Catch the retrieval projection up from its watermark. Safe to call repeatedly and after a crash. */
  async projectIndex(opts: { fromStart?: boolean } = {}): Promise<{ indexed: number; indexedPosition: number }> {
    const { settings } = await getSettings(this.db, await systemPrincipalFor(this.db, this.userId, "index"));
    const pending: CanonicalMessage[] = [];
    if (opts.fromStart) {
      for (const row of this.ledgerRows("ORDER BY position")) {
        const c = await this.canonical(row);
        if (c) pending.push(c);
      }
    } else pending.push(...(await this.unindexedMessages()));
    if (pending.length === 0) return { indexed: 0, indexedPosition: (await indexWatermark(this.db, this.userId, this.userId)).indexedPosition };
    const r = await indexMessages(this.db, this.userId, this.userId, pending, { nowMs: this.now(), timezone: settings.timezone });
    return { indexed: r.indexed, indexedPosition: r.indexedPosition };
  }

  /**
   * Physically remove forgotten messages from the transcript store and report it. Compaction overlays that
   * covered them cannot be deleted through the pinned Session API, so `summaries` stays pending with the
   * retention stated; it is never reported as erased.
   */
  async reconcileErasures(): Promise<{ erased: string[] }> {
    const rows = await all<{ source_id: string; pending_stores_json: string }>(this.db, "SELECT source_id, pending_stores_json FROM source_tombstones WHERE user_id = ? AND source_kind = 'message' AND state = 'suppressed'", this.userId);
    const todo = rows.filter((r) => json<string[]>(r.pending_stores_json, []).includes("transcript"));
    if (todo.length === 0) return { erased: [] };
    const erased: string[] = [];
    for (const r of todo) {
      const m = await this.session.getMessage(r.source_id);
      if (m) {
        const texts = (m.parts as { type: string; text?: string }[]).filter((p) => p.type === "text" && typeof p.text === "string" && p.text.length >= 12 && p.text !== FORGOTTEN_TEXT).map((p) => p.text!);
        await this.session.updateMessage({ ...m, parts: [{ type: "text", text: FORGOTTEN_TEXT }], metadata: { ...(m.metadata as object), garderobe: { ...(metaOf(m) ?? {}), forgotten: true } } });
        // Verbatim copies of the forgotten text elsewhere in the transcript (a recall tool result that quoted it,
        // a reply that repeated it word for word) are removed too. A paraphrase cannot be detected this way.
        if (texts.length > 0) {
          // The whole text first, then its sentences (a tool result may quote a single sentence).
          const sentences = texts.flatMap((t) => t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length >= 20));
          const needles = [...texts, ...sentences].sort((a, b) => b.length - a.length).map((t) => JSON.stringify(t).slice(1, -1));
          for (const row of this.ledgerRows("WHERE message_id != ?", r.source_id)) {
            const other = await this.session.getMessage(row.message_id);
            if (!other) continue;
            const before = JSON.stringify(other.parts);
            let after = before;
            for (const needle of needles) after = after.split(needle).join(FORGOTTEN_TEXT);
            if (after !== before) await this.session.updateMessage({ ...other, parts: JSON.parse(after) });
          }
        }
      }
      erased.push(r.source_id);
    }
    await (this as unknown as { syncMessagesFromStorage(): Promise<unknown> }).syncMessagesFromStorage();
    const system = await systemPrincipalFor(this.db, this.userId, "erasure", "system");
    const confirm = (store: "transcript" | "summaries", ids: string[], outstandingRetention: string | null) =>
      this.commands().execute(system, { type: "conversation.confirm_erasure", payload: { sourceKind: "message", sourceIds: ids, store, outstandingRetention }, idempotencyKey: `erasure:${store}:${(ids[0] ?? "")}:${ids.length}:${outstandingRetention ? "held" : "done"}`, authorization: "system_schedule", source: { channel: "system" } });
    await confirm("transcript", erased, null);
    if ((await this.session.getCompactions()).length === 0) await confirm("summaries", erased, null);
    else await confirm("summaries", erased, "an earlier compaction summary may still contain this text until the session is rebuilt without it");
    return { erased };
  }

  /**
   * Remove compaction summaries that covered forgotten messages. The pinned Session release exposes no
   * overlay deletion, so the session is rebuilt through its supported API: the sanitized original messages
   * are re-imported under their original IDs, parents and dates, and the old rows and overlays are cleared.
   * Runs only between turns. Summaries are regenerated by the ordinary compaction policy afterwards.
   */
  async rebuildSanitizedSession(): Promise<{ rebuilt: boolean; reason?: string }> {
    const held = await all<{ source_id: string; pending_stores_json: string }>(this.db, "SELECT source_id, pending_stores_json FROM source_tombstones WHERE user_id = ? AND source_kind = 'message' AND state = 'suppressed'", this.userId);
    const ids = held.filter((r) => json<string[]>(r.pending_stores_json, []).includes("summaries")).map((r) => r.source_id);
    if (ids.length === 0) return { rebuilt: false, reason: "nothing to remove" };
    if (this.turnsInFlight > 0 || (await this.listSubmissions({ status: ["pending", "running"] })).length > 0) return { rebuilt: false, reason: "a turn is in progress" };
    await this.reconcileErasures();
    const rows = this.ledgerRows("ORDER BY position");
    const kept: { row: (typeof rows)[number]; message: NonNullable<Awaited<ReturnType<ThinkSession["getMessage"]>>> }[] = [];
    for (const row of rows) {
      const message = await this.session.getMessage(row.message_id);
      if (message) kept.push({ row, message });
    }
    await this.session.clearMessages();
    let parentId: string | null = null;
    for (const { row, message } of kept) {
      await this.session.importMessage(message, { parentId, createdAt: Date.parse(row.authored_at) });
      parentId = message.id;
    }
    await (this as unknown as { syncMessagesFromStorage(): Promise<unknown> }).syncMessagesFromStorage();
    if ((await this.session.getCompactions()).length > 0) return { rebuilt: false, reason: "the session still holds compaction overlays after the rebuild" };
    const system = await systemPrincipalFor(this.db, this.userId, "erasure", "system");
    await this.commands().execute(system, { type: "conversation.confirm_erasure", payload: { sourceKind: "message", sourceIds: ids, store: "summaries", outstandingRetention: null }, idempotencyKey: `erasure:summaries:rebuilt:${ids[0]}:${ids.length}`, authorization: "system_schedule", source: { channel: "system" } });
    return { rebuilt: true };
  }

  /* ------------------------------------------------------------------ */
  /* RPC surface (called only by trusted Worker code through client.ts)   */
  /* ------------------------------------------------------------------ */

  private async accept(grantInput: unknown, input: unknown, kind: "conversation" | "research"): Promise<{ row: TurnRow; accepted: boolean; message: UIMessage }> {
    const grant = TurnGrant.parse(grantInput);
    const parsed = TurnInput.parse(input);
    // Rejects an unknown or disabled owner before anything is stored.
    await systemPrincipalFor(this.db, this.userId, grant.authRef);
    // Secrets are removed before the text reaches the transcript, the ledger, the index or a model.
    const text = redactSecrets(parsed.text).text;
    const attachments = parsed.attachments.map((a) => ({ kind: a.kind, source: a.source ? redactSecrets(a.source).text : null, text: redactSecrets(a.text).text.slice(0, MAX_ATTACHMENT_CHARS) }));
    const requestHash = await sha256Hex(canonicalJson({ text, attachments, attachedRefs: parsed.attachedRefs, kind }));
    const turnId = newId("trn");
    const nowMs = this.now();
    const { row, accepted } = await acceptTurnRow(this.db, { userId: this.userId, turnId, submissionId: parsed.submissionId, requestHash, kind, channel: grant.channel, scopes: grant.scopes, authRef: grant.authRef, userMessageId: `msg_${turnId}`, nowMs });
    const kindMap: Record<string, "page" | "document" | "email" | "calendar_event"> = { web_page: "page", email: "email", calendar_event: "calendar_event" };
    const message: UIMessage = {
      id: row.user_message_id,
      role: "user",
      parts: [
        { type: "text", text },
        // Everything that is not the owner's own words travels as delimited, explicitly untrusted data.
        ...attachments.map((a) => ({ type: "text" as const, text: wrapUntrusted(kindMap[a.kind] ?? "document", `${a.kind}${a.source ? `: ${a.source}` : ""}`, a.text) })),
      ],
      metadata: { garderobe: { turnId: row.turn_id, channel: grant.channel, authoredAt: toInstant(nowMs), kind: "owner", attachedRefs: parsed.attachedRefs } },
    };
    return { row, accepted, message };
  }

  /** Request errors are returned as values: an exception thrown across the actor boundary would poison the caller's stub. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T | RequestRejection> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SubmissionReuseError) return { rejected: { code: "submission_reuse", message: e.message } };
      if ((e as { name?: string })?.name === "ZodError") return { rejected: { code: "invalid_request", message: "the request is not valid" } };
      if (isCommandError(e)) return { rejected: { code: (e as { code: string }).code, message: (e as Error).message } };
      if (e instanceof RequestError) return { rejected: { code: e.code, message: e.message } };
      throw e;
    }
  }

  /** Durable acceptance: returns as soon as the turn is admitted; it runs in order behind earlier turns. */
  async submitTurn(grant: unknown, input: unknown): Promise<TurnRecord | RequestRejection> {
    return this.guarded(async () => {
      const { row, accepted, message } = await this.accept(grant, input, "conversation");
      if (row.status === "accepted") await this.runTurn({ mode: "submit", input: [message], submissionId: row.turn_id, idempotencyKey: row.turn_id, metadata: { turnId: row.turn_id } });
      return toTurnRecord((await findTurn(this.db, this.userId, row.turn_id))!, accepted);
    });
  }

  /** Accept and wait for the turn to settle. */
  async runOwnerTurn(grant: unknown, input: unknown): Promise<TurnRecord | RequestRejection> {
    return this.guarded(async () => {
      const { row, accepted, message } = await this.accept(grant, input, "conversation");
      if (row.status === "accepted") await this.execute(row.turn_id, message);
      return toTurnRecord((await findTurn(this.db, this.userId, row.turn_id))!, accepted);
    });
  }

  private async execute(turnId: string, message: UIMessage, onEvent?: (json: string) => void | Promise<void>): Promise<void> {
    this.turnsInFlight++;
    try {
      if (onEvent) {
        await this.runTurn({
          mode: "stream",
          input: [message],
          callback: {
            onStart: () => {},
            // Reasoning never leaves the actor, whatever a provider emits.
            onEvent: async (chunk: string) => {
              if (!/"type"\s*:\s*"reasoning/.test(chunk)) await onEvent(chunk);
            },
            onDone: () => {},
            onError: () => {},
          },
        } as never);
      } else {
        const result = await this.runTurn({ input: [message] });
        if (result.status !== "completed") await this.finalizeTurn(turnId, { code: `turn_${result.status}`, message: result.error ?? `the turn was ${result.status}` });
      }
      await this.finalizeTurn(turnId, null);
    } catch (e) {
      this.turnFailures.delete(turnId);
      await this.failTurn(turnId, this.describeFailure(e));
    } finally {
      this.turnsInFlight--;
    }
    // Between turns: remove summaries that covered forgotten messages.
    await this.rebuildSanitizedSession().catch(() => undefined);
  }

  /** Accept and stream UI message chunks to the callback (the HTTP layer adapts them to SSE). */
  async streamTurn(grant: unknown, input: unknown, onEvent: (json: string) => void | Promise<void>): Promise<TurnRecord | RequestRejection> {
    return this.guarded(async () => {
      const { row, accepted, message } = await this.accept(grant, input, "conversation");
      if (row.status === "accepted") await this.execute(row.turn_id, message, onEvent);
      return toTurnRecord((await findTurn(this.db, this.userId, row.turn_id))!, accepted);
    });
  }

  /** Resume a turn that stopped for budget or provider reasons: the kept request runs again; committed actions are not repeated. */
  async resumeTurn(turnId: string): Promise<TurnRecord | null> {
    const row = await findTurn(this.db, this.userId, turnId);
    if (!row) return null;
    if (row.status === "resumable") {
      const stored = await this.session.getMessage(row.user_message_id);
      if (!stored) return toTurnRecord(row, false);
      await updateTurn(this.db, this.userId, turnId, { status: "accepted", failure_json: null, completed_at: null }, this.now());
      // The kept owner message runs again under its original ID; actions already committed resolve to their receipts.
      await this.execute(turnId, { id: stored.id, role: "user", parts: stored.parts as never, metadata: stored.metadata } as UIMessage);
    }
    return toTurnRecord((await findTurn(this.db, this.userId, turnId))!, false);
  }

  async getTurn(turnId: string): Promise<TurnRecord | null> {
    const row = await findTurn(this.db, this.userId, turnId);
    return row ? toTurnRecord(row, false) : null;
  }

  async getTurnBySubmission(submissionId: string): Promise<TurnRecord | null> {
    const row = await findTurnBySubmission(this.db, this.userId, submissionId);
    return row ? toTurnRecord(row, false) : null;
  }

  async turnEvents(turnId: string, opts: { afterSeq?: number } = {}) {
    return readTurnEvents(this.db, this.userId, turnId, opts.afterSeq ?? 0);
  }

  /** Stop remaining work. Effects already committed stay committed and are listed; undo is a separate command. */
  async cancelTurn(turnId: string): Promise<{ status: string; committedCommandIds: string[] } | null> {
    const row = await findTurn(this.db, this.userId, turnId);
    if (!row) return null;
    const committed = json<{ commandId: string }[]>(row.receipts_json, []).map((r) => r.commandId);
    if (["completed", "failed", "cancelled"].includes(row.status)) return { status: row.status, committedCommandIds: committed };
    await this.cancelSubmission(turnId, "cancelled by the owner").catch(() => undefined);
    const nowMs = this.now();
    await updateTurn(this.db, this.userId, turnId, { status: "cancelled", completed_at: toInstant(nowMs) }, nowMs);
    await emitTurnEvent(this.db, this.userId, turnId, "run_finished", { status: "cancelled", committedCommandIds: committed }, nowMs);
    return { status: "cancelled", committedCommandIds: committed };
  }

  /** Answer the one pending question of a turn. The answer is a new owner message; the original request stays in view. */
  async answerClarification(grant: unknown, turnId: string, answerInput: unknown): Promise<TurnRecord | RequestRejection> {
    return this.guarded(async () => {
      const answer = ClarificationAnswer.parse(answerInput);
      const row = await findTurn(this.db, this.userId, turnId);
      const pending = json<{ inputId: string; choices: { id: string; label: string }[] } | null>(row?.clarification_json, null);
      if (!row || !pending || pending.inputId !== answer.inputId) throw new RequestError("no_pending_question", "there is no pending question with that ID");
      const choice = answer.choiceId ? pending.choices.find((c) => c.id === answer.choiceId) : undefined;
      const text = answer.text ?? choice?.label;
      if (!text) throw new RequestError("invalid_request", "the answer names no choice and has no text");
      await updateTurn(this.db, this.userId, turnId, { status: "completed" }, this.now());
      return this.runOwnerTurn(grant, { submissionId: `clarify:${answer.inputId}`, text, attachedRefs: [] }) as Promise<TurnRecord>;
    });
  }

  /** A research request: a durable job plus a turn that runs under the research budget. */
  async startResearch(grant: unknown, requestInput: unknown): Promise<(TurnRecord & { jobId: string | null }) | RequestRejection> {
    return this.guarded(() => this.startResearchInner(grant, requestInput));
  }

  private async startResearchInner(grant: unknown, requestInput: unknown): Promise<TurnRecord & { jobId: string | null }> {
    const request = ResearchRequest.parse(requestInput);
    const text = `Research request (${request.kind}): ${request.topic}${request.url ? `\nURL: ${request.url}` : ""}`;
    const { row, accepted, message } = await this.accept(grant, { submissionId: request.submissionId, text, attachedRefs: [] }, "research");
    let jobId: string | null = null;
    const g = TurnGrant.parse(grant);
    if (g.scopes.includes("write")) {
      const principal = createPrincipal({ userId: this.userId, actor: "assistant", channel: g.channel, scopes: g.scopes, authRef: g.authRef });
      const receipt = await this.commands().execute(principal, { type: "job.create", payload: { jobId: `job_${row.turn_id}`, kind: request.kind === "history" ? "historical_research" : request.kind === "purchases" ? "email_investigation" : "product_investigation", title: request.topic.slice(0, 180), params: { turnId: row.turn_id, url: request.url ?? null } }, idempotencyKey: `research-job:${row.turn_id}`, authorization: "owner_statement", source: { channel: g.channel, parentKind: "turn", parentId: row.turn_id } });
      jobId = String(receipt.result["jobId"]);
    }
    if (row.status === "accepted") await this.runTurn({ mode: "submit", input: [message], submissionId: row.turn_id, idempotencyKey: row.turn_id });
    return { ...toTurnRecord((await findTurn(this.db, this.userId, row.turn_id))!, accepted), jobId };
  }

  /** Append one settled result card at a message boundary, without an inference turn. Deduplicated by delivery ID. */
  async deliverResult(input: unknown): Promise<{ delivered: boolean; messageId: string }> {
    const d = ResultDelivery.parse(input);
    const messageId = `dlv_${(await sha256Hex(d.deliveryId)).slice(0, 24)}`;
    const existing = await first<{ message_id: string }>(this.db, "SELECT message_id FROM assistant_deliveries WHERE user_id = ? AND delivery_id = ?", this.userId, d.deliveryId);
    if (existing) return { delivered: false, messageId: existing.message_id };
    // Never inject into the middle of a streaming response.
    await (this as unknown as { waitUntilStable?: () => Promise<unknown> }).waitUntilStable?.();
    const at = toInstant(this.now());
    const body = redactSecrets(`${d.title}\n\n${d.body}`).text;
    await this.addMessages([{ id: messageId, role: "assistant", parts: [{ type: "text", text: body }], metadata: { garderobe: { turnId: `delivery:${d.deliveryId}`, channel: "system", authoredAt: at, kind: "result_card", refs: d.refs } } } as UIMessage]);
    this.ledger(messageId, "assistant", null, "system", "result_card", at);
    // The delivery is recorded only after the conversation durably accepted the card.
    await prepare(this.db, stmt("INSERT OR IGNORE INTO assistant_deliveries (user_id, delivery_id, message_id, delivered_at) VALUES (?, ?, ?, ?)", this.userId, d.deliveryId, messageId, at)).run();
    await this.projectIndex();
    return { delivered: true, messageId };
  }

  private async toTranscriptMessage(row: ReturnType<GarderobeAssistantBase["ledgerRows"]>[number], forgotten: Set<string>): Promise<TranscriptMessage> {
    const m = await this.session.getMessage(row.message_id);
    const gone = forgotten.has(row.message_id) || !m;
    const parts = gone ? [] : (m!.parts as unknown as Record<string, unknown>[]).filter((p) => p["type"] !== "reasoning");
    return { messageId: row.message_id, role: row.role as "user" | "assistant", authoredAt: row.authored_at, channel: row.channel, turnId: row.turn_id, text: gone ? "" : textOf(parts as { type: string; text?: string }[]), parts: redactDeep(parts), forgotten: gone };
  }

  /** Original messages (never compaction overlays), paged by stable message ID. */
  async transcript(opts: { before?: string; after?: string; around?: string; limit?: number } = {}): Promise<TranscriptPage> {
    // Pending erasures are applied before anything is read, so a forgotten text is never served from a copy.
    await this.reconcileErasures();
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const pos = (id: string | undefined) => (id ? (this.ledgerRows("WHERE message_id = ?", id)[0]?.position ?? null) : null);
    let rows;
    if (opts.around && pos(opts.around) !== null) {
      const p = pos(opts.around)!;
      const half = Math.floor(limit / 2);
      rows = [...this.ledgerRows("WHERE position < ? ORDER BY position DESC LIMIT ?", p, half).reverse(), ...this.ledgerRows("WHERE position >= ? ORDER BY position LIMIT ?", p, limit - half)];
    } else if (opts.after && pos(opts.after) !== null) rows = this.ledgerRows("WHERE position > ? ORDER BY position LIMIT ?", pos(opts.after)!, limit);
    else if (opts.before && pos(opts.before) !== null) rows = this.ledgerRows("WHERE position < ? ORDER BY position DESC LIMIT ?", pos(opts.before)!, limit).reverse();
    else rows = this.ledgerRows("ORDER BY position DESC LIMIT ?", limit).reverse();
    const forgotten = await tombstonedIds(this.db, this.userId, "message");
    const messages: TranscriptMessage[] = [];
    for (const r of rows) messages.push(await this.toTranscriptMessage(r, forgotten));
    const total = Number((this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM gd_transcript").one() as { n: number }).n);
    const firstPos = rows[0]?.position ?? 0;
    const lastPos = rows[rows.length - 1]?.position ?? 0;
    const older = rows.length > 0 && this.ledgerRows("WHERE position < ? LIMIT 1", firstPos).length > 0;
    const newer = rows.length > 0 && this.ledgerRows("WHERE position > ? LIMIT 1", lastPos).length > 0;
    return { messages, nextBefore: older ? rows[0]!.message_id : null, nextAfter: newer ? rows[rows.length - 1]!.message_id : null, total };
  }

  async recallSearch(grant: unknown, input: RecallInput) {
    const g = TurnGrant.parse(grant);
    const principal = createPrincipal({ userId: this.userId, actor: "assistant", channel: g.channel, scopes: g.scopes, authRef: g.authRef });
    return recall(this.db, principal, input, { nowMs: this.now(), conversationId: this.userId, unindexedSource: () => this.unindexedMessages(), searchIndex: this.ports().searchIndex ?? null });
  }

  /** The complete original history for the portable export: original IDs, parts and dates; forgotten messages excluded. */
  async exportConversation(): Promise<{ version: 1; conversationId: string; exportedAt: string; messages: TranscriptMessage[]; compactions: { id: string; fromMessageId: string; toMessageId: string; createdAt: string }[] }> {
    await this.reconcileErasures();
    const forgotten = await tombstonedIds(this.db, this.userId, "message");
    const messages: TranscriptMessage[] = [];
    for (const r of this.ledgerRows("ORDER BY position")) {
      const m = await this.toTranscriptMessage(r, forgotten);
      if (!m.forgotten) messages.push(m);
    }
    const compactions = (await this.session.getCompactions()).map((c) => ({ id: c.id, fromMessageId: c.fromMessageId, toMessageId: c.toMessageId, createdAt: c.createdAt }));
    return { version: 1, conversationId: this.userId, exportedAt: toInstant(this.now()), messages, compactions };
  }

  /** Restore an exported history into an empty conversation: same IDs and dates, no inference, no commands, no effects. */
  async importConversation(data: { version: number; messages: TranscriptMessage[] }): Promise<{ imported: number }> {
    if (data.version !== 1) throw new Error("unsupported conversation export version");
    const total = Number((this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM gd_transcript").one() as { n: number }).n);
    if (total > 0) throw new Error("conversation import needs an empty conversation");
    const forgotten = await tombstonedIds(this.db, this.userId, "message");
    let parentId: string | null = null;
    let imported = 0;
    for (const m of data.messages) {
      if (m.forgotten || forgotten.has(m.messageId)) continue; // tombstones are replayed before anything is restored
      const at = m.authoredAt ?? toInstant(this.now());
      await this.session.importMessage({ id: m.messageId, role: m.role, parts: redactDeep(m.parts) as never, metadata: { garderobe: { turnId: m.turnId ?? `imported:${m.messageId}`, channel: m.channel ?? "import", authoredAt: at, kind: m.role === "user" ? "owner" : "reply" } } }, { parentId, createdAt: Date.parse(at) });
      this.ledger(m.messageId, m.role, m.turnId, m.channel, m.role === "user" ? "owner" : "reply", at);
      parentId = m.messageId;
      imported++;
    }
    await (this as unknown as { syncMessagesFromStorage(): Promise<unknown> }).syncMessagesFromStorage();
    await this.projectIndex({ fromStart: true });
    return { imported };
  }
}

/** The production conversation actor: inference only through the named AI Gateway. */
export class GarderobeAssistant extends GarderobeAssistantBase {
  protected override gatewayId(): string {
    return assertGatewayId((this.env as AssistantEnv).AI_GATEWAY_ID);
  }
  protected override createLanguageModel(spec: ProfileSpec, meta: ModelCallMeta): LanguageModelV4 {
    const env = this.env as AssistantEnv;
    return createGatewayModel(env, env.AI_GATEWAY_ID, spec, { runId: meta.runId, task: meta.task, attempt: meta.attempt, environment: env.ENVIRONMENT ?? "dev" }) as unknown as LanguageModelV4;
  }
}

import { assertGatewayId, createGatewayModel } from "../inference/gateway.ts";

export { isCommandError, localDateOf, SubmissionReuseError };
