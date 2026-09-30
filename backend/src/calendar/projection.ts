import { assertPrincipal, type Principal } from '../domain/principal.js';
import { addDays, zonedInstant } from '../domain/time.js';
import { getDailyBoard, managedEventId } from '../recommend/publish.js';
import { maskStandaloneCodes } from '../recommend/document.js';
import { CalendarApiError, type ManagedEvent, type ManagedEventStore } from './types.js';

/**
 * Calendar as a dependable presentation (spec section 9). One managed event per owner and local date
 * in the dedicated outfit calendar, with a stable caller-supplied ID. New board revisions (and
 * selections) raise `desired_seq`; the projector:
 *  - serialises work per event with a lease and rechecks the desired content before each write;
 *  - never creates a second event (a lost insert response is resolved by reading the stable ID);
 *  - updates conditionally on the event's etag and refuses to write content older than the event's;
 *  - preserves unmanaged description text and replaces only the managed block;
 *  - marks the newest content projected only after a read-back verifies it;
 *  - records failures visibly; an externally deleted event becomes a suppressed delivery.
 * Outfit delivery never adds attendees or sends invitations.
 */

export const MANAGED_START = '—— Garderobe board (managed; edits inside this block are replaced) ——';
export const MANAGED_END = '—— end of Garderobe board ——';

export type CalendarPresentation = { kind: 'timed'; start: string; end: string } | { kind: 'all_day' };

export interface ProjectorDeps {
  db: D1Database;
  principal: Principal;
  store: ManagedEventStore | null;
  /** The dedicated outfit calendar. */
  calendarId: string;
  clock?: () => string;
  presentation?: CalendarPresentation;
  /** HTTPS base for the private web board (opens the app when installed). */
  boardBaseUrl?: string;
  leaseMs?: number;
}

export interface ProjectionRow {
  board_date: string;
  board_id: string;
  purpose: string;
  event_id: string;
  desired_seq: number;
  desired_revision: number;
  projected_seq: number;
  projected_revision: number;
  status: 'pending' | 'projected' | 'failed' | 'suppressed';
  suppressed_reason: string | null;
  etag: string | null;
  attempts: number;
  last_error: string | null;
  lease_until: string | null;
  projected_at: string | null;
  version: number;
}

export interface ProjectionResult {
  boardDate: string;
  status: 'projected' | 'up_to_date' | 'failed' | 'suppressed' | 'not_connected' | 'busy' | 'no_board';
  desiredSeq: number;
  projectedSeq: number;
  error: string | null;
}

export function replaceManagedBlock(existing: string, block: string): string {
  const s = existing.indexOf(MANAGED_START);
  const e = existing.indexOf(MANAGED_END);
  const managed = `${MANAGED_START}\n${block.trim()}\n${MANAGED_END}`;
  if (s >= 0 && e > s) return `${existing.slice(0, s)}${managed}${existing.slice(e + MANAGED_END.length)}`;
  return existing.trim() ? `${managed}\n\n${existing.trim()}` : managed;
}

export function managedBlockOf(description: string): string | null {
  const s = description.indexOf(MANAGED_START);
  const e = description.indexOf(MANAGED_END);
  return s >= 0 && e > s ? description.slice(s + MANAGED_START.length, e).trim() : null;
}

export class CalendarProjector {
  private readonly clock: () => string;
  constructor(private readonly deps: ProjectorDeps) {
    assertPrincipal(deps.principal);
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  private get userId(): string {
    return this.deps.principal.userId;
  }

  async row(boardDate: string): Promise<ProjectionRow | null> {
    return this.deps.db.prepare('SELECT * FROM calendar_projections WHERE user_id = ? AND board_date = ?').bind(this.userId, boardDate).first<ProjectionRow>();
  }

  /** Content change without a new board revision (e.g. a selection): bump the desired sequence. */
  async requestReprojection(boardDate: string): Promise<void> {
    await this.deps.db
      .prepare("UPDATE calendar_projections SET desired_seq = desired_seq + 1, status = CASE WHEN status = 'suppressed' THEN 'suppressed' ELSE 'pending' END, updated_at = ?, version = version + 1 WHERE user_id = ? AND board_date = ?")
      .bind(this.clock(), this.userId, boardDate)
      .run();
  }

  private async setStatus(boardDate: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    await this.deps.db
      .prepare(`UPDATE calendar_projections SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE user_id = ? AND board_date = ?`)
      .bind(...keys.map((k) => fields[k]), this.clock(), this.userId, boardDate)
      .run();
  }

  private async content(row: ProjectionRow, timezone: string): Promise<{ summary: string; block: string; start: ManagedEvent['start']; end: ManagedEvent['end'] } | null> {
    const board = await getDailyBoard(this.deps.db, this.deps.principal, row.board_date, row.purpose);
    if (!board || board.status !== 'published' || !board.document) return null;
    const sel = await this.deps.db
      .prepare("SELECT option_id FROM selections WHERE user_id = ? AND board_id = ? AND status = 'active'")
      .bind(this.userId, board.boardId)
      .first<{ option_id: string }>();
    const chosen = sel ? board.document.options.find((o) => o.optionId === sel.option_id) : null;
    const n = board.document.options.filter((o) => o.status === 'offerable').length;
    const link = `${this.deps.boardBaseUrl ?? 'https://garderobe.invalid'}/b/${board.boardId}`;
    const block = `${board.document.text.trim()}\n\n${chosen ? `Chosen: outfit ${chosen.position}.\n` : ''}Open the board: ${link}`;
    const p = this.deps.presentation ?? { kind: 'timed', start: '07:00', end: '07:15' };
    const start = p.kind === 'timed' ? { dateTime: zonedInstant(row.board_date, p.start, timezone), timeZone: timezone } : { date: row.board_date };
    const end = p.kind === 'timed' ? { dateTime: zonedInstant(row.board_date, p.end, timezone), timeZone: timezone } : { date: addDays(row.board_date, 1) };
    const summary = chosen ? `Outfit ${chosen.position} of ${n} chosen` : `${n} outfit${n === 1 ? '' : 's'} for today`;
    // The event's own labels and title pass the same final code guard as the board text (spec: no item codes in Calendar text).
    const codes = await this.makerCodes();
    const names = [...new Set(board.document.options.flatMap((o) => o.garments.map((g) => g.name)))];
    return { summary: maskStandaloneCodes(summary, codes, names), block: maskStandaloneCodes(block, codes, names), start, end };
  }

  /** Every registered maker code of the owner's garments (product codes and maker-code aliases). */
  private async makerCodes(): Promise<string[]> {
    const { results } = await this.deps.db
      .prepare("SELECT product_code AS code FROM garments WHERE user_id = ? AND product_code IS NOT NULL UNION SELECT phrase AS code FROM garment_aliases WHERE user_id = ? AND kind = 'maker_code' AND retired_at IS NULL")
      .bind(this.userId, this.userId)
      .all<{ code: string }>();
    return results.map((r) => r.code).filter((c) => typeof c === 'string' && c.trim());
  }

  async projectDay(boardDate: string): Promise<ProjectionResult> {
    const initial = await this.row(boardDate);
    if (!initial) return { boardDate, status: 'no_board', desiredSeq: 0, projectedSeq: 0, error: null };
    const result = (status: ProjectionResult['status'], r: ProjectionRow, error: string | null = null): ProjectionResult => ({ boardDate, status, desiredSeq: r.desired_seq, projectedSeq: r.projected_seq, error });
    if (initial.status === 'suppressed') return result('suppressed', initial, initial.suppressed_reason);
    if (!this.deps.store) {
      await this.setStatus(boardDate, { status: 'failed', last_error: 'Calendar not connected', attempts: initial.attempts + 1 });
      return result('not_connected', initial, 'Calendar not connected');
    }
    if (initial.projected_seq >= initial.desired_seq) return result('up_to_date', initial);
    const now = this.clock();
    const lease = await this.deps.db
      .prepare('UPDATE calendar_projections SET lease_until = ?, version = version + 1 WHERE user_id = ? AND board_date = ? AND (lease_until IS NULL OR lease_until < ?)')
      .bind(new Date(Date.parse(now) + (this.deps.leaseMs ?? 60_000)).toISOString(), this.userId, boardDate, now)
      .run();
    if (!lease.meta.changes) return result('busy', initial);
    const store = this.deps.store;
    const cal = this.deps.calendarId;
    const tz = (await this.deps.db.prepare('SELECT timezone FROM boards WHERE user_id = ? AND board_id = ?').bind(this.userId, initial.board_id).first<{ timezone: string }>())?.timezone ?? 'Europe/London';
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const row = (await this.row(boardDate))!;
        if (row.status === 'suppressed') return result('suppressed', row, row.suppressed_reason);
        if (row.projected_seq >= row.desired_seq) return result('up_to_date', row);
        const desired = row.desired_seq;
        const content = await this.content(row, tz);
        if (!content) {
          await this.setStatus(boardDate, { status: 'failed', last_error: 'No published board to project', attempts: row.attempts + 1 });
          return result('failed', row, 'No published board to project');
        }
        const props = { garderobeBoard: row.board_id, garderobeSeq: String(desired), garderobeRevision: String(row.desired_revision) };
        let ev: ManagedEvent | null = await store.getEvent(cal, row.event_id);
        if (ev && ev.status === 'cancelled' && row.suppressed_reason !== 'restore_requested') {
          await this.setStatus(boardDate, { status: 'suppressed', suppressed_reason: 'deleted_externally', lease_until: null });
          return result('suppressed', row, 'deleted_externally');
        }
        const restoring = Boolean(ev && ev.status === 'cancelled');
        const eventSeq = ev ? Number(ev.privateProperties.garderobeSeq ?? 0) : 0;
        if (ev && eventSeq > desired) {
          // A newer projection already reached the event; never overwrite it with older content.
          return result('up_to_date', row);
        }
        try {
          if (!ev) {
            await store.insertEvent(cal, { id: row.event_id, summary: content.summary, description: replaceManagedBlock('', content.block), start: content.start, end: content.end, transparency: 'transparent', privateProperties: props });
          } else if (!restoring && eventSeq === desired && managedBlockOf(ev.description) === content.block.trim()) {
            // Already written (e.g. a lost response); fall through to verification.
          } else {
            const fresh = await this.row(boardDate);
            if (!fresh || fresh.desired_seq !== desired) continue; // newer content requested: recompute before writing
            await store.patchEvent(cal, row.event_id, { summary: content.summary, description: replaceManagedBlock(ev.description, content.block), start: content.start, end: content.end, transparency: 'transparent', privateProperties: props, ...(restoring ? { status: 'confirmed' as const } : {}) }, ev.etag);
          }
        } catch (err) {
          if (err instanceof CalendarApiError && (err.status === 409 || err.status === 412 || err.status === 0)) continue; // re-read the stable ID and retry
          throw err;
        }
        // Read-back verification before reporting success.
        const back = await store.getEvent(cal, row.event_id);
        if (!back || back.status === 'cancelled' || back.privateProperties.garderobeSeq !== String(desired) || managedBlockOf(back.description) !== content.block.trim()) continue;
        await this.deps.db
          .prepare(
            `UPDATE calendar_projections SET projected_seq = ?, projected_revision = ?, status = CASE WHEN desired_seq = ? THEN 'projected' ELSE 'pending' END,
               etag = ?, projected_at = ?, attempts = attempts + 1, last_error = NULL, suppressed_reason = NULL, updated_at = ?, version = version + 1
             WHERE user_id = ? AND board_date = ? AND projected_seq < ?`,
          )
          .bind(desired, row.desired_revision, desired, back.etag, this.clock(), this.clock(), this.userId, boardDate, desired)
          .run();
        const after = (await this.row(boardDate))!;
        if (after.desired_seq > after.projected_seq) continue; // newer content arrived meanwhile
        return result('projected', after);
      }
      const r = (await this.row(boardDate))!;
      await this.setStatus(boardDate, { status: 'failed', last_error: 'Projection did not verify after retries', attempts: r.attempts + 1 });
      return result('failed', r, 'Projection did not verify after retries');
    } catch (err) {
      const r = (await this.row(boardDate))!;
      const message = err instanceof Error ? err.message : String(err);
      await this.setStatus(boardDate, { status: 'failed', last_error: message, attempts: r.attempts + 1 });
      return { ...result('failed', r, message), status: 'failed' };
    } finally {
      await this.deps.db.prepare('UPDATE calendar_projections SET lease_until = NULL WHERE user_id = ? AND board_date = ?').bind(this.userId, boardDate).run();
    }
  }

  /** Projects every pending or failed day from `fromDate` on (the scheduled sweep). */
  async projectPending(fromDate: string): Promise<ProjectionResult[]> {
    const { results } = await this.deps.db
      .prepare("SELECT board_date FROM calendar_projections WHERE user_id = ? AND board_date >= ? AND status IN ('pending', 'failed') AND projected_seq < desired_seq ORDER BY board_date")
      .bind(this.userId, fromDate)
      .all<{ board_date: string }>();
    const out: ProjectionResult[] = [];
    for (const r of results) out.push(await this.projectDay(r.board_date));
    return out;
  }

  /** Pause or explicit removal: suppress so retries cannot recreate it, and cancel the managed event. */
  async suppress(boardDate: string, reason: 'paused' | 'owner_removed'): Promise<void> {
    const row = await this.row(boardDate);
    if (!row) return;
    await this.setStatus(boardDate, { status: 'suppressed', suppressed_reason: reason });
    if (!this.deps.store) return;
    try {
      const ev = await this.deps.store.getEvent(this.deps.calendarId, row.event_id);
      if (ev && ev.status !== 'cancelled') await this.deps.store.deleteEvent(this.deps.calendarId, row.event_id, ev.etag);
    } catch (err) {
      await this.setStatus(boardDate, { last_error: `Suppressed, but the managed event could not be removed yet: ${(err as Error).message}` });
    }
  }

  /** An explicit owner request restores a suppressed day (an externally deleted event is un-cancelled). */
  async restore(boardDate: string): Promise<void> {
    await this.deps.db
      .prepare("UPDATE calendar_projections SET status = 'pending', suppressed_reason = 'restore_requested', desired_seq = desired_seq + 1, updated_at = ?, version = version + 1 WHERE user_id = ? AND board_date = ? AND status = 'suppressed'")
      .bind(this.clock(), this.userId, boardDate)
      .run();
  }

  static eventIdFor = managedEventId;
}
