import type { Board, CommandOf, DayBrief, OutfitOption, OutfitSlot, Selection } from '@garderobe/contracts';
import { json, parseJson, rawPredicate, versionIs } from './db.js';
import { DomainError, notFound } from './errors.js';
import { newId } from './ids.js';
import { assertPrincipal, type Principal } from './principal.js';
import { requireGarments } from './records.js';
import type { CommandPlan, HandlerContext } from './commands/types.js';

/**
 * Boards, options and selections (spec sections 5 and 7). The daily-service workstream composes and
 * validates boards; `publishBoardRevision` is the storage primitive it calls. A selection records an
 * intention, never a wear.
 */

interface BoardRow {
  board_id: string;
  board_date: string;
  timezone: string;
  purpose: string;
  current_revision: number;
  brief_json: string;
  status: string;
  published_at: string | null;
  version: number;
}

export interface PublishBoardInput {
  boardDate: string;
  timezone: string;
  purpose?: string;
  brief?: Partial<DayBrief>;
  options: { position: number; explanation: string; status?: 'offerable' | 'reserve'; slots: { garmentId: string; role: OutfitSlot['role']; alternativeGroup?: string | null }[]; validation?: Record<string, unknown> }[];
  context?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  estimator?: Record<string, unknown>;
  /** Revision the caller composed against; a stale value is rejected so an old composition cannot overwrite a newer board. */
  expectedRevision: number;
  now?: string;
}

/** Atomically publishes an immutable board revision (all options complete, garments owned by the principal). */
export async function publishBoardRevision(db: D1Database, principal: Principal, input: PublishBoardInput): Promise<Board> {
  assertPrincipal(principal);
  const userId = principal.userId;
  const now = input.now ?? new Date().toISOString();
  const purpose = input.purpose ?? 'day';
  if (!input.options.length) throw new DomainError('validation_failed', 'A published board needs at least one complete option');
  await requireGarments(db, userId, input.options.flatMap((o) => o.slots.map((s) => s.garmentId)));
  const existing = await db.prepare('SELECT * FROM boards WHERE user_id = ? AND board_date = ? AND purpose = ?').bind(userId, input.boardDate, purpose).first<BoardRow>();
  const boardId = existing?.board_id ?? newId('brd');
  const currentRevision = existing?.current_revision ?? 0;
  if (currentRevision !== input.expectedRevision) {
    throw new DomainError('conflict', `Board ${input.boardDate} is at revision ${currentRevision}, not ${input.expectedRevision}`, { currentRevision });
  }
  const revision = currentRevision + 1;
  const brief: DayBrief = { text: null, occasion: null, requestedCount: null, wearingInterval: null, ...input.brief };
  const checkId = newId('pre');
  const statements: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO command_preconditions (check_id, ok) SELECT ?, CASE WHEN COALESCE((SELECT current_revision FROM boards WHERE user_id = ? AND board_id = ?), 0) = ? THEN 1 ELSE 0 END')
      .bind(checkId, userId, boardId, currentRevision),
    existing
      ? db
          .prepare("UPDATE boards SET current_revision = ?, brief_json = ?, status = 'published', published_at = ?, version = version + 1 WHERE user_id = ? AND board_id = ?")
          .bind(revision, json(brief), now, userId, boardId)
      : db
          .prepare("INSERT INTO boards (user_id, board_id, board_date, timezone, purpose, current_revision, brief_json, status, published_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, 1)")
          .bind(userId, boardId, input.boardDate, input.timezone, purpose, revision, json(brief), now),
    db
      .prepare('INSERT INTO board_revisions (user_id, board_id, revision, published_at, context_json, validation_json, estimator_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(userId, boardId, revision, now, json(input.context ?? {}), json(input.validation ?? {}), json(input.estimator ?? {})),
  ];
  for (const o of input.options) {
    const optionId = newId('opt');
    statements.push(
      db
        .prepare('INSERT INTO board_options (user_id, option_id, board_id, revision, position, explanation, status, validation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(userId, optionId, boardId, revision, o.position, o.explanation, o.status ?? 'offerable', json(o.validation ?? {})),
    );
    for (const s of o.slots) {
      statements.push(
        db.prepare('INSERT INTO option_garments (user_id, option_id, garment_id, role, alternative_group) VALUES (?, ?, ?, ?, ?)').bind(userId, optionId, s.garmentId, s.role, s.alternativeGroup ?? null),
      );
    }
  }
  statements.push(db.prepare('DELETE FROM command_preconditions WHERE check_id = ?').bind(checkId));
  await db.batch(statements);
  return getBoard(db, principal, boardId);
}

export async function getBoard(db: D1Database, principal: Principal, boardId: string, revision?: number): Promise<Board> {
  assertPrincipal(principal);
  const userId = principal.userId;
  const b = await db.prepare('SELECT * FROM boards WHERE user_id = ? AND board_id = ?').bind(userId, boardId).first<BoardRow>();
  if (!b) throw notFound('board', boardId);
  const rev = revision ?? b.current_revision;
  const { results: options } = await db
    .prepare('SELECT option_id, board_id, revision, position, explanation, status, validation_json FROM board_options WHERE user_id = ? AND board_id = ? AND revision = ? ORDER BY position')
    .bind(userId, boardId, rev)
    .all<{ option_id: string; board_id: string; revision: number; position: number; explanation: string; status: string; validation_json: string }>();
  const { results: slots } = await db
    .prepare(
      `SELECT og.option_id, og.garment_id, og.role, og.alternative_group FROM option_garments og
       JOIN board_options o ON o.user_id = og.user_id AND o.option_id = og.option_id WHERE og.user_id = ? AND o.board_id = ? AND o.revision = ?`,
    )
    .bind(userId, boardId, rev)
    .all<{ option_id: string; garment_id: string; role: string; alternative_group: string | null }>();
  const rev0 = await db.prepare('SELECT published_at FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = ?').bind(userId, boardId, rev).first<{ published_at: string }>();
  return {
    boardId: b.board_id,
    boardDate: b.board_date,
    timezone: b.timezone,
    purpose: b.purpose,
    currentRevision: b.current_revision,
    brief: parseJson<DayBrief>(b.brief_json, { text: null, occasion: null, requestedCount: null, wearingInterval: null }),
    status: b.status as Board['status'],
    version: b.version,
    publishedAt: rev0?.published_at ?? b.published_at,
    options: options.map(
      (o): OutfitOption => ({
        optionId: o.option_id,
        boardId: o.board_id,
        revision: o.revision,
        position: o.position,
        explanation: o.explanation,
        status: o.status as OutfitOption['status'],
        validation: parseJson<Record<string, unknown>>(o.validation_json, {}),
        slots: slots
          .filter((s) => s.option_id === o.option_id)
          .map((s) => ({ garmentId: s.garment_id, role: s.role as OutfitSlot['role'], alternativeGroup: s.alternative_group })),
      }),
    ),
  };
}

export async function findBoardByDate(db: D1Database, principal: Principal, boardDate: string, purpose = 'day'): Promise<Board | null> {
  assertPrincipal(principal);
  const b = await db.prepare('SELECT board_id FROM boards WHERE user_id = ? AND board_date = ? AND purpose = ?').bind(principal.userId, boardDate, purpose).first<{ board_id: string }>();
  return b ? getBoard(db, principal, b.board_id) : null;
}

interface SelectionRow {
  selection_id: string;
  board_id: string;
  option_id: string;
  board_revision: number;
  footwear_garment_id: string | null;
  selected_for_date: string;
  status: string;
  created_at: string;
  version: number;
}

function rowToSelection(r: SelectionRow): Selection {
  return {
    selectionId: r.selection_id,
    boardId: r.board_id,
    optionId: r.option_id,
    boardRevision: r.board_revision,
    footwearGarmentId: r.footwear_garment_id,
    selectedForDate: r.selected_for_date,
    status: r.status as Selection['status'],
    createdAt: r.created_at,
    version: r.version,
  };
}

export async function getActiveSelection(db: D1Database, principal: Principal, boardId: string): Promise<Selection | null> {
  assertPrincipal(principal);
  const r = await db.prepare("SELECT * FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'").bind(principal.userId, boardId).first<SelectionRow>();
  return r ? rowToSelection(r) : null;
}

export async function selectOption(ctx: HandlerContext<CommandOf<'select_option'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const board = await getBoard(ctx.db, ctx.principal, c.boardId);
  if (board.status !== 'published') throw new DomainError('invalid_state', `That board is ${board.status}`);
  const option = board.options.find((o) => o.optionId === c.optionId);
  if (!option) {
    throw new DomainError('conflict', 'That option is not part of the current board revision; the board changed since it was shown', { boardRevision: board.currentRevision });
  }
  if (option.status !== 'offerable') throw new DomainError('invalid_state', 'That option is not offerable');
  const footwear = option.slots.filter((s) => s.role === 'footwear');
  const groups = new Set(footwear.map((s) => s.alternativeGroup).filter(Boolean));
  const hasAlternatives = footwear.length > 1 && groups.size > 0;
  if (c.footwearGarmentId && !footwear.some((s) => s.garmentId === c.footwearGarmentId)) {
    throw new DomainError('validation_failed', 'The chosen footwear is not part of this option');
  }
  if (hasAlternatives && !c.footwearGarmentId) {
    throw new DomainError('validation_failed', 'This option offers two footwear alternatives; choose one so the outfit never logs both');
  }
  const previous = await getActiveSelection(ctx.db, ctx.principal, c.boardId);
  const selectionId = newId('sel');
  const statements: D1PreparedStatement[] = [];
  if (previous) {
    statements.push(ctx.db.prepare("UPDATE selections SET status = 'superseded', version = version + 1 WHERE user_id = ? AND selection_id = ?").bind(userId, previous.selectionId));
  }
  statements.push(
    ctx.db
      .prepare(
        "INSERT INTO selections (user_id, selection_id, board_id, option_id, board_revision, footwear_garment_id, selected_for_date, status, command_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)",
      )
      .bind(userId, selectionId, board.boardId, option.optionId, board.currentRevision, c.footwearGarmentId ?? (footwear.length === 1 ? footwear[0]!.garmentId : null), board.boardDate, ctx.commandId, ctx.now),
  );
  const garments = await requireGarments(ctx.db, userId, option.slots.map((s) => s.garmentId));
  const names = option.slots.filter((s) => s.role !== 'footwear' || !c.footwearGarmentId || s.garmentId === c.footwearGarmentId).map((s) => garments.get(s.garmentId)!.name);
  return {
    occurredAt: ctx.now,
    guards: [
      versionIs(userId, 'board', board.boardId, board.version),
      rawPredicate(
        "COALESCE((SELECT selection_id FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'), '') = ?",
        [userId, board.boardId, previous?.selectionId ?? ''],
        'active selection unchanged',
      ),
    ],
    statements,
    affected: [
      { entityType: 'selection', entityId: selectionId, version: 1, change: 'created' },
      ...(previous ? [{ entityType: 'selection' as const, entityId: previous.selectionId, version: previous.version + 1, change: 'updated' as const }] : []),
    ],
    summary: `Chosen for ${board.boardDate}: ${names.join(', ')}. This is a plan, not a recorded wear.`,
    facts: { selectionId, boardId: board.boardId, optionId: option.optionId, boardRevision: board.currentRevision, previousSelectionId: previous?.selectionId ?? null },
    undo: { kind: 'restore_selection', selectionId, previousSelectionId: previous?.selectionId ?? null, boardId: board.boardId },
    effects: [
      {
        kind: 'calendar_projection',
        external: true,
        operationKey: `calendar:${board.boardId}:selection:${selectionId}`,
        payload: { boardId: board.boardId, boardDate: board.boardDate, revision: board.currentRevision, selectionId },
      },
    ],
  };
}
