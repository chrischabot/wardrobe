/**
 * Text normalization and paraphrase expansion for local recall. Production retrieval uses AI Search
 * hybrid (keyword + vector) search; this local implementation keeps deterministic, testable matching
 * with a small concept lexicon so "shoes I loved" finds "those Paraboot Michaels are wonderful".
 */

const STOP = new Set('a an and are as at be but by did do for from had has have i in is it its me my of on or so that the them these they this those to was were what which with you your we our so very really just'.split(' '));

export const CONCEPTS: Record<string, string[]> = {
  footwear: ['shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers', 'boot', 'boots', 'loafer', 'loafers', 'derby', 'derbies', 'moc', 'mocs', 'paraboot', 'michael', 'michaels', 'avignon', 'chambord', 'weejun', 'weejuns', 'nb', '990', '990v4', '990v6', '993', 'new balance', 'footwear', 'welted', 'brogue', 'brogues'],
  shirt: ['shirt', 'shirts', 'ocbd', 'oxford', 'oxfords', 'button-down', 'buttondown', 'western'],
  trousers: ['trouser', 'trousers', 'chino', 'chinos', 'jeans', 'fatigues', 'cords', 'corduroy', 'pants'],
  jacket: ['jacket', 'jackets', 'blazer', 'blazers', 'coat', 'coats', 'chore', 'mac', 'overshirt', 'games'],
  knit: ['jumper', 'jumpers', 'sweater', 'sweaters', 'cardigan', 'knit', 'knitwear', 'shetland', 'rugby', 'rugbies'],
  positive: ['love', 'loved', 'loving', 'like', 'liked', 'adore', 'adored', 'great', 'perfect', 'wonderful', 'fantastic', 'brilliant', 'favourite', 'favorite', 'gorgeous', 'beautiful', 'lovely', 'superb', 'excellent', 'keeper', 'obsessed'],
  negative: ['hate', 'hated', 'dislike', 'disliked', 'awful', 'terrible', 'horrible', 'ugly', 'wrong', 'returned', 'return', 'sending back', 'regret'],
};

const CONCEPT_OF = new Map<string, string>();
for (const [concept, words] of Object.entries(CONCEPTS)) for (const w of words) CONCEPT_OF.set(w, concept);

export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(text: string): string[] {
  return normalize(text)
    .split(' ')
    .map((t) => t.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Index terms: tokens plus the concepts they belong to (concept terms are prefixed with '@'). */
export function indexTerms(text: string): string[] {
  const out = new Set<string>();
  const norm = normalize(text);
  for (const t of tokens(text)) {
    out.add(t);
    const c = CONCEPT_OF.get(t);
    if (c) out.add(`@${c}`);
  }
  for (const [phrase, concept] of CONCEPT_OF) if (phrase.includes(' ') && norm.includes(phrase)) out.add(`@${concept}`);
  return [...out];
}

export function queryTerms(query: string): { terms: string[]; concepts: string[] } {
  const terms = indexTerms(query);
  return { terms: terms.filter((t) => !t.startsWith('@')), concepts: terms.filter((t) => t.startsWith('@')) };
}

export function conceptOf(word: string): string | undefined {
  return CONCEPT_OF.get(word.toLowerCase());
}
