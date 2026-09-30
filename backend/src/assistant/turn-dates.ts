import type { ModelMessage } from 'ai';
import { localDateOf } from '../domain/time.js';

/**
 * Date stamps on the owner's messages in the model's view of the conversation (simulation finding
 * D4). The conversation is one continuous stream across days, and the model's history carried no day
 * boundaries, so on 6 October it read its own correct 5 October weather answer as today's and
 * "corrected" it. Each owner message the model sees now starts with a separate text part saying when
 * he sent it, in his home time zone. The owner's stored message and transcript are unchanged: the
 * stamp is added only to the model's copy, at turn start.
 *
 * Times come from the turn ledger (assistant_turns.created_at), matched to the model's messages by
 * the owner's exact stored (already redacted) text, newest first, so a compaction summary or any other
 * message that is not an owner turn is left unstamped rather than given someone else's date. Stamps
 * are never stored, so every stamp the model sees was added here: an owner message that merely looks
 * like a stamp is treated as his text, never as a date.
 */

/** A date stamp part, e.g. `[Sent Monday 2026-10-05 07:10 Europe/London]`. */
export const DATE_STAMP = /^\[Sent [A-Z][a-z]+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Za-z_/+-]+\]$/;

export function dateStamp(atIso: string, timezone: string): string {
  const at = new Date(atIso);
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: timezone }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone }).format(at);
  return `[Sent ${weekday} ${localDateOf(atIso, timezone)} ${time} ${timezone}]`;
}

export interface LedgerTurnText {
  /** When the owner sent it (ISO). */
  at: string;
  /** The stored (redacted) text of his message. */
  text: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function textOf(m: ModelMessage): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as { type: string; text?: string }[])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
}

/**
 * Returns the messages with each owner message prefixed by its date stamp. `turns` must be newest
 * first. Matching walks both lists from the newest end and needs the exact stored text, so repeated
 * questions ("What should I wear today?") each get their own day and "Yes please" never takes the
 * date of a later "Yes".
 */
export function stampOwnerMessageDates(messages: ModelMessage[], turns: LedgerTurnText[], timezone: string): ModelMessage[] {
  const out = [...messages];
  let j = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== 'user') continue;
    const text = norm(textOf(m));
    if (!text) continue;
    let k = j;
    while (k < turns.length && norm(turns[k]!.text) !== text) k++;
    if (k >= turns.length) continue; // not an owner turn (for example a compaction summary)
    const stamp = { type: 'text' as const, text: dateStamp(turns[k]!.at, timezone) };
    const parts = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    out[i] = { ...m, content: [stamp, ...parts] } as ModelMessage;
    j = k + 1;
  }
  return out;
}
