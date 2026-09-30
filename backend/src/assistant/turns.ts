import { canonicalJson, sha256Hex } from '../domain/hash.js';
import { DomainError } from '../domain/errors.js';
import type { TurnIntent } from './intent.js';

/**
 * Stable client turn identity (spec section 8): the client mints a submission id before sending; the
 * backend binds it to the owner and the canonical request body. Resubmitting returns the existing
 * turn; reusing the id with a different body is rejected.
 */
export type TurnStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'deterministic';

export interface TurnRow {
  turn_id: string;
  client_turn_id: string;
  request_hash: string;
  channel: string;
  intent_json: string;
  status: TurnStatus;
  submission_id: string | null;
  user_message_id: string;
  profile_version: number | null;
  context_digest: string | null;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TurnBody {
  text: string;
  channel: string;
  attachments?: unknown[];
  captureIntent?: string | null;
  askAbout?: unknown;
  /** Ask-about-this references as submitted (resolution happens at acceptance, outside the hash). */
  references?: unknown[];
}

export interface StoredTurnMeta {
  intent: TurnIntent;
  body: TurnBody;
  grant: { scopes: string[]; authenticatedBy: string };
}

export class TurnLedger {
  constructor(private readonly db: D1Database) {}

  async accept(userId: string, clientTurnId: string, meta: StoredTurnMeta, now: string): Promise<{ turn: TurnRow; existing: boolean }> {
    const hash = await sha256Hex(canonicalJson(meta.body));
    const prior = await this.byClientId(userId, clientTurnId);
    if (prior) {
      if (prior.request_hash !== hash) throw new DomainError('idempotency_key_reused', 'This turn id was already used for a different message');
      return { turn: prior, existing: true };
    }
    const turnId = `turn_${crypto.randomUUID().replace(/-/g, '')}`;
    const userMessageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`;
    await this.db
      .prepare(
        `INSERT INTO assistant_turns (user_id, turn_id, client_turn_id, request_hash, channel, intent_json, status, user_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT (user_id, client_turn_id) DO NOTHING`,
      )
      .bind(userId, turnId, clientTurnId, hash, meta.body.channel, JSON.stringify(meta), userMessageId, now, now)
      .run();
    const row = await this.byClientId(userId, clientTurnId);
    if (!row) throw new Error('turn not recorded');
    if (row.request_hash !== hash) throw new DomainError('idempotency_key_reused', 'This turn id was already used for a different message');
    return { turn: row, existing: row.turn_id !== turnId };
  }

  byClientId(userId: string, clientTurnId: string): Promise<TurnRow | null> {
    return this.db.prepare('SELECT * FROM assistant_turns WHERE user_id = ? AND client_turn_id = ?').bind(userId, clientTurnId).first<TurnRow>();
  }

  byId(userId: string, turnId: string): Promise<TurnRow | null> {
    return this.db.prepare('SELECT * FROM assistant_turns WHERE user_id = ? AND turn_id = ?').bind(userId, turnId).first<TurnRow>();
  }

  byUserMessageId(userId: string, messageId: string): Promise<TurnRow | null> {
    return this.db.prepare('SELECT * FROM assistant_turns WHERE user_id = ? AND user_message_id = ?').bind(userId, messageId).first<TurnRow>();
  }

  async active(userId: string): Promise<TurnRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM assistant_turns WHERE user_id = ? AND status IN ('queued', 'running') ORDER BY created_at").bind(userId).all<TurnRow>();
    return results;
  }

  async update(userId: string, turnId: string, patch: Partial<Pick<TurnRow, 'status' | 'submission_id' | 'profile_version' | 'context_digest' | 'result_json' | 'error'>>, now: string): Promise<void> {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    // A cancelled turn stays cancelled; late completions from an aborted stream do not overwrite it.
    const guard = patch.status && patch.status !== 'cancelled' ? " AND status <> 'cancelled'" : '';
    await this.db
      .prepare(`UPDATE assistant_turns SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE user_id = ? AND turn_id = ?${guard}`)
      .bind(...keys.map((k) => patch[k] ?? null), now, userId, turnId)
      .run();
  }
}

export function turnMeta(row: TurnRow): StoredTurnMeta {
  return JSON.parse(row.intent_json) as StoredTurnMeta;
}
