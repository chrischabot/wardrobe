/**
 * The owner's maker-specific sizes and body measurements, read from the CURRENT profile version at
 * request time (so a profile edit changes sizing on the next request) and from newer dated
 * measurements in D1, which supersede profile passages. Every fact carries the verbatim sentence it
 * came from. A fact whose passage is absent from the current profile is simply unknown.
 */

export interface SizeFact {
  key: string;
  maker: string | null;
  category: string;
  value: string | null;
  quote: string;
  source: 'profile' | 'measurement';
  profileVersion?: number;
  measuredOn?: string;
}

function sentenceContaining(text: string, index: number): string {
  const start = Math.max(text.lastIndexOf('\n', index), text.lastIndexOf('. ', index) >= 0 ? text.lastIndexOf('. ', index) + 1 : -1, 0);
  const endDot = text.indexOf('. ', index);
  const endNl = text.indexOf('\n', index);
  const ends = [endDot >= 0 ? endDot + 1 : -1, endNl].filter((x) => x >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).replace(/^[\s\-*]+/, '').trim();
}

const FRACTIONS: Record<string, string> = { '½': '.5', '¼': '.25', '¾': '.75' };
function num(s: string): number {
  return Number(s.replace(/[½¼¾]/g, (m) => FRACTIONS[m] ?? ''));
}

export function profileSizeFacts(body: string, profileVersion?: number): SizeFact[] {
  const facts: SizeFact[] = [];
  const find = (key: string, re: RegExp, build: (m: RegExpMatchArray) => Omit<SizeFact, 'key' | 'quote' | 'source' | 'profileVersion'>) => {
    const m = body.match(re);
    if (!m || m.index === undefined) return;
    facts.push({ key, ...build(m), quote: sentenceContaining(body, m.index), source: 'profile', profileVersion });
  };
  find('body.chest_in', /Chest and waist both (\d+(?:\.\d+)?) inches/i, (m) => ({ maker: null, category: 'body', value: m[1]! }));
  find('body.waist_in', /Chest and waist both (\d+(?:\.\d+)?) inches/i, (m) => ({ maker: null, category: 'body', value: m[1]! }));
  find('body.neck_in', /neck (\d+(?:\.\d+)?) inches/i, (m) => ({ maker: null, category: 'body', value: m[1]! }));
  find('jacket.drakes', /(\d+) at Drake['’]s/i, (m) => ({ maker: "Drake's", category: 'jacket', value: m[1]! }));
  find('jacket.private_white', /Private White chart size (\d+)\s*\/\s*([A-Z]+)/i, (m) => ({ maker: 'Private White V.C.', category: 'jacket', value: `${m[1]} / ${m[2]}` }));
  find('jacket.de_bonne_facture', /De Bonne Facture runs to its own chart[^.]*/i, () => ({ maker: 'De Bonne Facture', category: 'jacket', value: null }));
  find('rugby', /Rugbies:\s*([A-Z]+)/i, (m) => ({ maker: null, category: 'rugby', value: m[1]! }));
  find('shirt.mtm', /made to measure at ([A-Z][\w ]+?) on/i, (m) => ({ maker: m[1]!.trim(), category: 'shirt', value: 'made to measure' }));
  find('shirt.collar', /(\d+[½¼¾]?|\d+\.\d+) collar, occasionally (\d+[½]?)/i, (m) => ({ maker: null, category: 'shirt', value: `${m[1]} (occasionally ${m[2]})` }));
  find('trousers.waist_length', /(\d+) waist, (\d+) length/i, (m) => ({ maker: null, category: 'trousers', value: `${m[1]}x${m[2]}` }));
  find('trousers.low_rise_waist', /dropping to (\d+) for a rise that sits below the waist/i, (m) => ({ maker: null, category: 'trousers', value: m[1]! }));
  find('trousers.rise', /Rise matters more than waist[^.]*/i, () => ({ maker: "Drake's", category: 'trousers', value: 'Drake’s Games rise or higher' }));
  find('footwear.uk', /UK (\d+(?:\.\d+)?) across sneakers and Paraboot/i, (m) => ({ maker: null, category: 'footwear', value: m[1]! }));
  find('footwear.too_small', /UK (\d+(?:\.\d+)?) is too small/i, (m) => ({ maker: null, category: 'footwear', value: m[1]! }));
  return facts;
}

export async function ownerSizeFacts(db: D1Database, userId: string): Promise<{ facts: SizeFact[]; profileVersion: number | null }> {
  const doc = await db
    .prepare("SELECT body, version FROM style_documents WHERE user_id = ? AND is_current = 1 ORDER BY CASE source WHEN 'owner_supplied' THEN 0 WHEN 'owner_edit' THEN 1 ELSE 2 END LIMIT 1")
    .bind(userId)
    .first<{ body: string; version: number }>();
  const facts = doc ? profileSizeFacts(doc.body, doc.version) : [];
  // Newer dated body measurements supersede the profile passage for the same measurement.
  const { results } = await db
    .prepare("SELECT name, value, unit, measured_on, source FROM measurements WHERE user_id = ? AND subject = 'body' ORDER BY measured_on DESC")
    .bind(userId)
    .all<{ name: string; value: number; unit: string; measured_on: string; source: string }>();
  for (const m of results) {
    const key = `body.${m.name}_in`;
    const inches = m.unit === 'cm' ? m.value / 2.54 : m.value;
    if (facts.some((f) => f.key === key && f.source === 'measurement')) continue;
    const idx = facts.findIndex((f) => f.key === key);
    const fact: SizeFact = { key, maker: null, category: 'body', value: String(Math.round(inches * 10) / 10), quote: `${m.name} ${m.value} ${m.unit} measured ${m.measured_on} (${m.source})`, source: 'measurement', measuredOn: m.measured_on };
    if (idx >= 0) facts[idx] = fact;
    else facts.push(fact);
  }
  return { facts, profileVersion: doc?.version ?? null };
}

export function factValue(facts: SizeFact[], key: string): number | null {
  const f = facts.find((x) => x.key === key);
  return f?.value ? num(f.value) : null;
}
