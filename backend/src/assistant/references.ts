import { ConversationReference } from '@garderobe/contracts';
import { z } from 'zod';

/**
 * "Ask about this" references (spec section 3): the exact garment or board option the owner attached
 * to a turn. Trusted code resolves each one against the owner's own records when the turn is accepted
 * and stores it with the Session user message, so the transcript, recall and the app keep what was
 * asked about, not just the text. A reference that does not resolve for this owner is kept and
 * marked not found; it is never guessed or re-pointed.
 */

export const TurnReferences = z.array(ConversationReference).max(20);
export type TurnReference = z.infer<typeof ConversationReference>;

export interface ReferenceDisplay {
  /** What the owner saw on the card: the garment name, or the option's garment names in order. */
  label: string;
  garments: { garmentId: string; name: string; role: string | null }[];
}

export type ResolvedReference = TurnReference & { found: boolean; display: ReferenceDisplay | null };

type AskAbout = { kind: 'garment' | 'outfit' | 'board_option'; id: string } | null | undefined;

/** References from the request, or the single legacy askAbout identity when no references were sent. */
export async function referencesFor(db: D1Database, userId: string, refs: TurnReference[] | undefined, askAbout: AskAbout): Promise<TurnReference[]> {
  if (refs?.length) return refs;
  if (!askAbout) return [];
  if (askAbout.kind === 'garment') return [{ kind: 'garment', garmentId: askAbout.id }];
  if (askAbout.kind === 'board_option') {
    const row = await db.prepare('SELECT board_id, revision FROM board_options WHERE user_id = ? AND option_id = ?').bind(userId, askAbout.id).first<{ board_id: string; revision: number }>();
    if (row) return [{ kind: 'option', boardId: row.board_id, optionId: askAbout.id, boardRevision: row.revision }];
  }
  return [];
}

export async function resolveReferences(db: D1Database, userId: string, refs: TurnReference[]): Promise<ResolvedReference[]> {
  const out: ResolvedReference[] = [];
  for (const ref of refs) {
    if (ref.kind === 'garment') {
      const g = await db.prepare('SELECT garment_id, name FROM garments WHERE user_id = ? AND garment_id = ?').bind(userId, ref.garmentId).first<{ garment_id: string; name: string }>();
      out.push({ ...ref, found: Boolean(g), display: g ? { label: g.name, garments: [{ garmentId: g.garment_id, name: g.name, role: null }] } : null });
      continue;
    }
    const opt = await db.prepare('SELECT option_id FROM board_options WHERE user_id = ? AND option_id = ? AND board_id = ?').bind(userId, ref.optionId, ref.boardId).first<{ option_id: string }>();
    if (!opt) {
      out.push({ ...ref, found: false, display: null });
      continue;
    }
    const { results } = await db
      .prepare(
        `SELECT og.garment_id, og.role, g.name FROM option_garments og JOIN garments g ON g.user_id = og.user_id AND g.garment_id = og.garment_id
         WHERE og.user_id = ? AND og.option_id = ? ORDER BY og.rowid`,
      )
      .bind(userId, ref.optionId)
      .all<{ garment_id: string; role: string; name: string }>();
    const ROLE_ORDER = ['outer_layer', 'mid_layer', 'base_top', 'one_piece', 'bottom', 'belt', 'footwear', 'socks', 'accessory', 'underwear', 'indoor'];
    const garments = results.map((r) => ({ garmentId: r.garment_id, name: r.name, role: r.role })).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    out.push({ ...ref, found: true, display: { label: garments.map((g) => g.name).join(', '), garments } });
  }
  return out;
}

/** One line per reference for the turn context and the recall projection. */
export function describeReference(r: ResolvedReference): string {
  const what = r.kind === 'garment' ? `garment ${r.garmentId}` : `board ${r.boardId} option ${r.optionId} (revision ${r.boardRevision})`;
  if (!r.found || !r.display) return `${what}: not found in this owner's records`;
  return `${what}: ${r.display.label}`;
}

/** Read the stored references back from a Session message's metadata (tolerates older messages). */
export function storedReferences(metadata: unknown): ResolvedReference[] {
  const refs = (metadata as { references?: unknown } | null)?.references;
  if (!Array.isArray(refs)) return [];
  return refs.filter((r): r is ResolvedReference => ConversationReference.safeParse(r).success);
}
