import type { Board, BoardDocument, DayBrief, OutfitSlot } from '@garderobe/contracts';
import { getBoard } from '../domain/boards.js';
import { isPreconditionFailure, isUniqueViolation, json, parseJson } from '../domain/db.js';
import { DomainError } from '../domain/errors.js';
import { sha256Hex } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import { assertPrincipal, requireScope, SCOPE_WRITE, type Principal } from '../domain/principal.js';
import { requireGarments } from '../domain/records.js';

/**
 * Atomic publication of a validated board revision (spec section 7 step 6 and section 8, "Concurrent
 * actions and external effects"). One D1 batch whose first statement is a CHECK-constrained
 * precondition evaluating:
 *  - the board is still at the revision the composition started from;
 *  - no availability-changing command committed since the context was built (the revalidation
 *    watermark), so a shirt that went into the wash during composition cannot be published;
 *  - recommendations are not paused for the date;
 *  - a carried selection is still the active one.
 * The batch writes the board, the immutable revision, options and garment slots, the semantic
 * document, the carried selection and the Calendar projection intent together.
 */

export interface PublishOption {
  optionId: string;
  position: number;
  status: 'offerable' | 'reserve';
  explanation: string;
  slots: { garmentId: string; role: OutfitSlot['role']; alternativeGroup?: string | null }[];
  validation: Record<string, unknown>;
}

export interface PublishRevisionInput {
  boardDate: string;
  timezone: string;
  purpose: string;
  expectedRevision: number;
  watermark: number;
  brief: Partial<DayBrief>;
  options: PublishOption[];
  document: BoardDocument;
  context: Record<string, unknown>;
  validation: Record<string, unknown>;
  estimator: Record<string, unknown>;
  carrySelection?: { previousSelectionId: string; toOptionId: string; footwearGarmentId: string | null; reference: string } | null;
  /** Whether this board is the day's Calendar board (home boards and trip boards both are). */
  projectCalendar: boolean;
  now: string;
}

export type PublishConflict = 'board_revision' | 'state_changed' | 'paused' | 'selection_changed' | 'concurrent_publish';

export function newOptionId(): string {
  return newId('opt');
}

/** Stable Google-compatible event ID (base32hex, 5–1024 chars) per owner and local date; no personal data. */
export async function managedEventId(userId: string, boardDate: string): Promise<string> {
  return `garderobe${(await sha256Hex(`garderobe-board|${userId}|${boardDate}`)).slice(0, 40)}`;
}

export async function publishValidatedRevision(db: D1Database, principal: Principal, input: PublishRevisionInput): Promise<Board> {
  assertPrincipal(principal);
  requireScope(principal, SCOPE_WRITE);
  const userId = principal.userId;
  const offerable = input.options.filter((o) => o.status === 'offerable');
  if (!offerable.length) throw new DomainError('validation_failed', 'A published board needs at least one complete, valid option; nothing is padded');
  await requireGarments(db, userId, input.options.flatMap((o) => o.slots.map((s) => s.garmentId)));
  const existing = await db
    .prepare('SELECT board_id, current_revision FROM boards WHERE user_id = ? AND board_date = ? AND purpose = ?')
    .bind(userId, input.boardDate, input.purpose)
    .first<{ board_id: string; current_revision: number }>();
  const boardId = existing?.board_id ?? newId('brd');
  const current = existing?.current_revision ?? 0;
  if (current !== input.expectedRevision) throw new DomainError('conflict', `Board ${input.boardDate} is at revision ${current}, not ${input.expectedRevision}`, { reason: 'board_revision', currentRevision: current });
  const revision = current + 1;
  const brief: DayBrief = { text: null, occasion: null, requestedCount: null, wearingInterval: null, ...input.brief };
  const checkId = newId('pre');
  const eventId = await managedEventId(userId, input.boardDate);
  const carry = input.carrySelection ?? null;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO command_preconditions (check_id, ok) SELECT ?, CASE WHEN
           COALESCE((SELECT current_revision FROM boards WHERE user_id = ? AND board_date = ? AND purpose = ?), 0) = ?
           AND (SELECT COUNT(*) FROM command_effects WHERE user_id = ? AND kind = 'board_revalidation') = ?
           AND NOT EXISTS (SELECT 1 FROM service_pauses WHERE user_id = ? AND ended_at IS NULL AND starts_on <= ? AND (resume_on IS NULL OR resume_on > ?))
           AND (? IS NULL OR EXISTS (SELECT 1 FROM selections WHERE user_id = ? AND selection_id = ? AND status = 'active'))
         THEN 1 ELSE 0 END`,
      )
      .bind(checkId, userId, input.boardDate, input.purpose, current, userId, input.watermark, userId, input.boardDate, input.boardDate, carry?.previousSelectionId ?? null, userId, carry?.previousSelectionId ?? null),
    existing
      ? db
          .prepare("UPDATE boards SET current_revision = ?, brief_json = ?, status = 'published', published_at = ?, version = version + 1 WHERE user_id = ? AND board_id = ?")
          .bind(revision, json(brief), input.now, userId, boardId)
      : db
          .prepare("INSERT INTO boards (user_id, board_id, board_date, timezone, purpose, current_revision, brief_json, status, published_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, 1)")
          .bind(userId, boardId, input.boardDate, input.timezone, input.purpose, revision, json(brief), input.now),
    db
      .prepare('INSERT INTO board_revisions (user_id, board_id, revision, published_at, context_json, validation_json, estimator_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(userId, boardId, revision, input.now, json(input.context), json(input.validation), json(input.estimator)),
  ];
  for (const o of input.options) {
    stmts.push(
      db
        .prepare('INSERT INTO board_options (user_id, option_id, board_id, revision, position, explanation, status, validation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, o.optionId, boardId, revision, o.position, o.explanation, o.status, json(o.validation)),
    );
    for (const s of o.slots) {
      stmts.push(db.prepare('INSERT INTO option_garments (user_id, option_id, garment_id, role, alternative_group) VALUES (?, ?, ?, ?, ?)').bind(userId, o.optionId, s.garmentId, s.role, s.alternativeGroup ?? null));
    }
  }
  stmts.push(db.prepare('INSERT INTO board_documents (user_id, board_id, revision, document_json, created_at) VALUES (?, ?, ?, ?, ?)').bind(userId, boardId, revision, json(input.document), input.now));
  if (carry) {
    stmts.push(db.prepare("UPDATE selections SET status = 'superseded', version = version + 1 WHERE user_id = ? AND selection_id = ? AND status = 'active'").bind(userId, carry.previousSelectionId));
    stmts.push(
      db
        .prepare(
          "INSERT INTO selections (user_id, selection_id, board_id, option_id, board_revision, footwear_garment_id, selected_for_date, status, command_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)",
        )
        .bind(userId, newId('sel'), boardId, carry.toOptionId, revision, carry.footwearGarmentId, input.boardDate, carry.reference, input.now),
    );
  }
  if (input.projectCalendar) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO calendar_projections (user_id, board_date, board_id, purpose, event_id, desired_seq, desired_revision, status, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 1, ?, 'pending', ?, 1)
           ON CONFLICT (user_id, board_date) DO UPDATE SET board_id = excluded.board_id, purpose = excluded.purpose,
             desired_seq = calendar_projections.desired_seq + 1, desired_revision = excluded.desired_revision,
             status = CASE WHEN calendar_projections.status = 'suppressed' THEN 'suppressed' ELSE 'pending' END,
             updated_at = excluded.updated_at, version = calendar_projections.version + 1`,
        )
        .bind(userId, input.boardDate, boardId, input.purpose, eventId, revision, input.now),
    );
  }
  stmts.push(db.prepare('DELETE FROM command_preconditions WHERE check_id = ?').bind(checkId));
  try {
    await db.batch(stmts);
  } catch (err) {
    if (isPreconditionFailure(err)) throw new DomainError('conflict', 'The board inputs changed during composition; the stale revision was not published', { reason: await conflictReason(db, userId, input, current) });
    if (isUniqueViolation(err, 'boards')) throw new DomainError('conflict', 'Another composition published this board first', { reason: 'concurrent_publish' satisfies PublishConflict });
    throw err;
  }
  return getDailyBoard(db, principal, input.boardDate, input.purpose) as Promise<Board>;
}

async function conflictReason(db: D1Database, userId: string, input: PublishRevisionInput, current: number): Promise<PublishConflict> {
  const b = await db.prepare('SELECT current_revision FROM boards WHERE user_id = ? AND board_date = ? AND purpose = ?').bind(userId, input.boardDate, input.purpose).first<{ current_revision: number }>();
  if ((b?.current_revision ?? 0) !== current) return 'board_revision';
  const paused = await db
    .prepare('SELECT 1 AS x FROM service_pauses WHERE user_id = ? AND ended_at IS NULL AND starts_on <= ? AND (resume_on IS NULL OR resume_on > ?)')
    .bind(userId, input.boardDate, input.boardDate)
    .first();
  if (paused) return 'paused';
  const w = await db.prepare("SELECT COUNT(*) AS n FROM command_effects WHERE user_id = ? AND kind = 'board_revalidation'").bind(userId).first<{ n: number }>();
  if ((w?.n ?? 0) !== input.watermark) return 'state_changed';
  return 'selection_changed';
}

/** A board with its semantic document (the read the API/MCP layer serves for GET /v1/today). */
export async function getDailyBoard(db: D1Database, principal: Principal, boardDate: string, purpose = 'day', revision?: number): Promise<Board | null> {
  assertPrincipal(principal);
  const b = await db.prepare('SELECT board_id FROM boards WHERE user_id = ? AND board_date = ? AND purpose = ?').bind(principal.userId, boardDate, purpose).first<{ board_id: string }>();
  if (!b) return null;
  const board = await getBoard(db, principal, b.board_id, revision);
  const rev = revision ?? board.currentRevision;
  const d = await db.prepare('SELECT document_json FROM board_documents WHERE user_id = ? AND board_id = ? AND revision = ?').bind(principal.userId, b.board_id, rev).first<{ document_json: string }>();
  return { ...board, document: d ? parseJson<BoardDocument | null>(d.document_json, null) : null };
}

/** Stored composition request and evidence of a board revision. */
export async function getRevisionRecord(db: D1Database, principal: Principal, boardId: string, revision: number): Promise<{ context: Record<string, unknown>; validation: Record<string, unknown>; estimator: Record<string, unknown> } | null> {
  assertPrincipal(principal);
  const r = await db
    .prepare('SELECT context_json, validation_json, estimator_json FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = ?')
    .bind(principal.userId, boardId, revision)
    .first<{ context_json: string; validation_json: string; estimator_json: string }>();
  return r ? { context: parseJson(r.context_json, {}), validation: parseJson(r.validation_json, {}), estimator: parseJson(r.estimator_json, {}) } : null;
}
