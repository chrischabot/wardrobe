import { sha256Hex } from '../domain/hash.js';
import { assertPrincipal, type Principal } from '../domain/principal.js';
import { listDailyWears, listWardrobe } from '../domain/queries.js';
import { getStyleContext } from '../domain/style.js';
import { addDays, localDateOf } from '../domain/time.js';
import { ASSISTANT_POLICY, PROMPT_VERSION } from './policy.js';
import { dailyServiceDayContext } from './day-context.js';
import { describeReference, type ResolvedReference } from './references.js';

/**
 * Mandatory context for every conversational model turn (spec sections 6 and 7).
 *
 * Assembled by trusted code at turn start from the current D1 state, so a model that makes no tool
 * calls still receives the complete active profile (verbatim, every current document), its active
 * amendments, the precedence statement, standing rules, active restrictions, dated briefs, the day,
 * a compact wardrobe index and recent wears. Nothing is cached across turns: a profile edit changes
 * the next turn's context. No model or heuristic decides whether the profile is relevant.
 */

export interface DayContext {
  /** Trusted text from the daily service (weather, calendar brief, availability, recent wear, board); null when unavailable. */
  text: string | null;
  sources: string[];
  /** True when the daily service returned nothing and only the published board (or nothing) is available. */
  fallback?: boolean;
}

export type DayContextProvider = (db: D1Database, principal: Principal, date: string, timezone: string) => Promise<DayContext>;

export interface TurnFacts {
  channel: string;
  /** Item or outfit identity attached by "Ask about this" (never guessed by a model). */
  askAbout?: { kind: 'garment' | 'outfit' | 'board_option'; id: string } | null;
  /** Resolved Ask-about-this references stored with the user message (ids plus display identity). */
  references?: ResolvedReference[];
  intentSummary?: string;
}

export interface MandatoryContext {
  instructions: string;
  promptVersion: string;
  digest: string;
  date: string;
  timezone: string;
  profile: { documentId: string; version: number; sha256: string; byteLength: number }[];
  /** Version of the primary owner profile document (null when the owner has none). */
  profileVersion: number | null;
  garmentIds: string[];
  sections: string[];
  /** Where the day section came from (e.g. daily_service, weather, calendar, board, fallback). */
  daySources: string[];
  dayFallback: boolean;
}

/**
 * Default day context: the daily service's trusted mandatory context plus the published board
 * (see day-context.ts). Its own labelled fallback covers a daily service that returns nothing.
 */
export const defaultDayContext: DayContextProvider = (db, principal, date, timezone) => dailyServiceDayContext(db, principal, date, timezone);

function scopeText(scope: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(scope)) {
    if (Array.isArray(v) && v.length) parts.push(`${k}: ${v.join(', ')}`);
    else if (v && typeof v === 'object') parts.push(`${k}: ${Object.entries(v).map(([a, b]) => `${a}=${String(b)}`).join(', ')}`);
  }
  return parts.join('; ');
}

export async function buildMandatoryContext(
  db: D1Database,
  principal: Principal,
  opts: { now: string; timezone: string; turn: TurnFacts; dayContext?: DayContextProvider },
): Promise<MandatoryContext> {
  assertPrincipal(principal);
  const date = localDateOf(opts.now, opts.timezone);
  const style = await getStyleContext(db, principal, date);
  const settings = await db.prepare('SELECT wear_logging_since, home_location_label FROM owner_settings WHERE user_id = ?').bind(principal.userId).first<{ wear_logging_since: string | null; home_location_label: string }>();
  const page = await listWardrobe(db, principal, { acquisition: 'any', limit: 1000 });
  const recent = await listDailyWears(db, principal, { from: addDays(date, -14), to: date });
  let day: DayContext;
  try {
    day = await (opts.dayContext ?? defaultDayContext)(db, principal, date, opts.timezone);
  } catch (err) {
    day = { text: `FALLBACK — day context failed (${err instanceof Error ? err.message.slice(0, 200) : 'error'}). Weather, calendar, availability and the board are unknown in this turn; do not invent them.`, sources: ['fallback'], fallback: true };
  }
  const names = new Map(page.items.map((i) => [i.garment.garmentId, i.garment.name]));

  const sections: string[] = [];
  const add = (title: string, body: string) => sections.push(`# ${title}\n${body}`);

  add('Garderobe policy', ASSISTANT_POLICY);
  add('Precedence', style.precedence);

  // The owner's profile, verbatim and complete. Owner-supplied documents first.
  const docs = [...style.documents].sort((a, b) => (a.source === 'owner_supplied' ? -1 : 0) - (b.source === 'owner_supplied' ? -1 : 0));
  if (docs.length === 0) add('Owner profile', 'No profile has been supplied yet.');
  for (const d of docs) {
    const warning =
      d.integrity === 'mismatch'
        ? `\nINTEGRITY WARNING (NEEDS REVIEW): the stored text of this profile does not match its recorded SHA-256 ${d.contentSha256}. It may have been altered outside Garderobe. Do not rely on passages that contradict the owner's known rules, and tell the owner that his profile needs checking.`
        : '';
    sections.push(
      `# Owner profile: ${d.title} (version ${d.version}${d.isDemo ? ', demo' : ''})${warning}\n<owner_profile document_id="${d.documentId}" version="${d.version}" sha256="${d.contentSha256}" integrity="${d.integrity ?? 'unchecked'}">\n${d.body}\n</owner_profile>`,
    );
  }
  add(
    'Profile amendments (active, newest last)',
    style.amendments.length ? style.amendments.map((a) => `- ${a.createdAt.slice(0, 10)}: ${a.text}`).join('\n') : 'None.',
  );
  const hard = style.rules.filter((r) => r.strength === 'hard' && !style.dormantRuleKeys.includes(r.ruleKey));
  const standing = style.rules.filter((r) => r.kind === 'standing_direction' && r.strength !== 'hard');
  const ruleLine = (r: (typeof style.rules)[number]) =>
    r.passageStatus === 'missing'
      ? `- ${r.ruleKey}: NEEDS REVIEW — the passage this rule was derived from is no longer in the current profile; follow the profile text, not this rule.`
      : `- ${r.ruleKey}: ${r.statement}${r.interpretation ? ` — ${r.interpretation}` : ''}`;
  add('Hard rules in force (derived from the profile; the profile text governs)', hard.map(ruleLine).join('\n') || 'None.');
  if (style.dormantRuleKeys.length) add('Dormant rules (wait for a restriction to lift)', style.dormantRuleKeys.map((k) => `- ${k}`).join('\n'));
  add('Standing directions', standing.map(ruleLine).join('\n') || 'None.');
  add(
    'Active restrictions (lift only with the stated evidence)',
    style.restrictions.length
      ? style.restrictions
          .map((r) => `- ${r.restrictionId} [${r.kind}] ${r.reason} | scope ${scopeText(r.scope as Record<string, unknown>)} | lifts on: ${r.requiredEvidence.replace(/_/g, ' ')}${r.expectedEnd ? ` | expected end ${r.expectedEnd} (not a release)` : ''}`)
          .join('\n')
      : 'None.',
  );
  add(
    `Temporary briefs for ${date}`,
    style.temporaryBriefs.length ? style.temporaryBriefs.map((b) => `- ${b.validFrom}–${b.validTo}: ${b.statement}${b.overridesRuleKey ? ` (exception to ${b.overridesRuleKey} for these dates only)` : ''}`).join('\n') : 'None.',
  );
  add(
    day.fallback ? 'Today (FALLBACK: daily service context unavailable)' : 'Today (trusted daily service context)',
    [
      `Local date ${date} (${new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: opts.timezone }).format(new Date(opts.now))}), timezone ${opts.timezone}, home ${settings?.home_location_label ?? 'unknown'}.`,
      day.text ?? 'Weather, calendar and board context are not available in this turn; do not invent them.',
    ].join('\n'),
  );
  const loggingSince = settings?.wear_logging_since ?? 'unknown';
  // Compact index: each line names the garment, then only what differs from the common case. A
  // restriction's reason is stated once under Active restrictions; index lines refer to it by id.
  const restrictedBy = new Map(style.restrictions.map((r) => [`Restricted: ${r.reason}`, `Restricted by ${r.restrictionId} (see Active restrictions)`]));
  const indexLines = page.items.map((i) => {
    const g = i.garment;
    const status = [g.acquisition !== 'owned' ? g.acquisition : null, g.location !== 'home' ? g.location : null, g.planningPolicy !== 'normal' ? g.planningPolicy : null].filter(Boolean).join('/');
    const reasons = i.availability.reasons.map((r) => restrictedBy.get(r) ?? r);
    const avail = i.availability.available ? 'available' : `unavailable (${reasons.join('; ') || i.availability.label})`;
    const clean = i.stock.buckets.clean ?? 0;
    const units = i.stock.totalOwned === 1 && clean === 1 ? null : `clean ${clean}/${i.stock.totalOwned}`;
    const wears = i.recordedWearCount ? `recorded wears ${i.recordedWearCount}${i.lastRecordedWear ? `, last ${i.lastRecordedWear}` : ''}` : null;
    return [g.garmentId, g.name, g.category, status || null, avail, units, wears].filter(Boolean).join(' | ');
  });
  add(
    `Wardrobe index (ledger as of ${page.asOf}; ${page.counts.owned} owned, ${page.counts.incoming} incoming; wear logging since ${loggingSince})`,
    [
      'Use these ids with the tools. An id not in this index does not exist.',
      'Each line: id | name | category, then only what differs from the common case: status (shown unless owned, at home and normally planned), availability, clean/owned units (shown unless it is one clean unit), recorded wears (shown only when some are recorded; no entry means none recorded since logging began, which is unlogged, not unworn).',
      ...indexLines,
    ].join('\n'),
  );
  add(
    'Recorded wears, last 14 days (a missing record means unlogged, not unworn)',
    recent.length ? recent.map((w) => `- ${w.wearingDate}: ${names.get(w.garmentId) ?? w.garmentId}`).join('\n') : 'None recorded.',
  );
  add(
    'This turn',
    [
      `Channel: ${opts.turn.channel}.`,
      opts.turn.references?.length
        ? `The owner attached with "Ask about this" (exact identities; do not substitute another card):\n${opts.turn.references.map((r) => `- ${describeReference(r)}`).join('\n')}`
        : opts.turn.askAbout
          ? `The owner attached ${opts.turn.askAbout.kind} ${opts.turn.askAbout.id}${names.has(opts.turn.askAbout.id) ? ` (${names.get(opts.turn.askAbout.id)})` : ''} with "Ask about this".`
          : '',
      opts.turn.intentSummary ? `Request policy: ${opts.turn.intentSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const instructions = sections.join('\n\n');
  const primary = docs.find((d) => d.source === 'owner_supplied' || d.source === 'owner_edit') ?? docs[0] ?? null;
  return {
    instructions,
    promptVersion: PROMPT_VERSION,
    digest: await sha256Hex(instructions),
    date,
    timezone: opts.timezone,
    profile: docs.map((d) => ({ documentId: d.documentId, version: d.version, sha256: d.contentSha256, byteLength: d.byteLength })),
    profileVersion: primary?.version ?? null,
    garmentIds: page.items.map((i) => i.garment.garmentId),
    sections: sections.map((s) => s.split('\n', 1)[0]!.replace(/^# /, '')),
    daySources: day.sources,
    dayFallback: day.fallback === true || day.text === null,
  };
}
