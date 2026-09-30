import { conceptOf, normalize, tokens } from './text.js';

/**
 * Typed judgments with speaker and evidence (spec section 6). The owner's enthusiasm is kept apart
 * from the assistant's recommendation; a later return or fit reversal is its own judgment.
 */
export type JudgmentKind = 'liked' | 'rejected' | 'ordered' | 'returned' | 'worn' | 'recommended' | 'fit_reversal';

export interface ExtractedJudgment {
  kind: JudgmentKind;
  speaker: 'owner' | 'assistant';
  subject: string;
  category: string | null;
  quote: string;
}

const OWNER_PATTERNS: { kind: JudgmentKind; re: RegExp }[] = [
  { kind: 'returned', re: /\b(returned|sent (them|it) back|sending (them|it) back|returning)\b/i },
  { kind: 'fit_reversal', re: /\b(too (small|big|tight|loose|short|long)|doesn't fit|don't fit|didn't fit|no longer fit|size (was|is) wrong|hurt my feet)\b/i },
  { kind: 'rejected', re: /\b(hate|hated|dislike|don't like|do not like|not for me|awful|ugly|terrible)\b/i },
  { kind: 'liked', re: /\b(love|loved|adore|really like|so good|wonderful|fantastic|brilliant|favourite|favorite|gorgeous|beautiful|perfect|obsessed|keeper|superb|great)\b/i },
  { kind: 'ordered', re: /\b(ordered|bought|purchased|just got)\b/i },
  { kind: 'worn', re: /\b(wore|wearing|have on)\b/i },
];

const ASSISTANT_RECOMMEND = /\b(i('d| would) (suggest|recommend|go with)|consider|you might like|worth a look|recommend)\b/i;

/** Subject: the run of capitalised product words (or model numbers) around the concept noun. */
function subjectOf(sentence: string): { subject: string; category: string | null } {
  const words = sentence.replace(/[^\p{L}\p{N}' -]/gu, ' ').split(/\s+/).filter(Boolean);
  const productish = (w: string, i: number) => /^[A-Z0-9]/.test(w) && i > 0 && !/^(I|I'm|I've|The|A|An|And|But|So|My)$/.test(w);
  for (let i = 0; i < words.length; i++) {
    const c = conceptOf(words[i]!.toLowerCase().replace(/'s$/, ''));
    if (!c || !['footwear', 'shirt', 'trousers', 'jacket', 'knit'].includes(c)) continue;
    let start = i;
    let end = i;
    while (start > 0 && productish(words[start - 1]!, start - 1)) start--;
    while (end + 1 < words.length && productish(words[end + 1]!, end + 1)) end++;
    return { subject: words.slice(start, end + 1).join(' '), category: c };
  }
  const caps = sentence.match(/\b([A-Z][\w'.-]+(?:\s+[A-Z0-9][\w'.-]+){0,3})\b/);
  return { subject: caps ? caps[1]! : tokens(sentence).slice(0, 4).join(' '), category: null };
}

export function extractJudgments(text: string, speaker: 'owner' | 'assistant'): ExtractedJudgment[] {
  const out: ExtractedJudgment[] = [];
  const sentences = text.split(/(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (speaker === 'assistant') {
      if (ASSISTANT_RECOMMEND.test(s)) {
        const { subject, category } = subjectOf(s);
        out.push({ kind: 'recommended', speaker, subject, category, quote: s.slice(0, 400) });
      }
      continue;
    }
    if (s.endsWith('?')) continue;
    for (const p of OWNER_PATTERNS) {
      if (p.re.test(s)) {
        // "not great" / "don't love" flips a liking into a rejection
        let kind = p.kind;
        if (kind === 'liked' && /\b(not|don't|didn't|never|no longer)\b\s+\w*\s*(love|like|great|perfect|wonderful)/i.test(s)) kind = 'rejected';
        const { subject, category } = subjectOf(s);
        if (!normalize(subject)) continue;
        out.push({ kind, speaker, subject, category, quote: s.slice(0, 400) });
        break;
      }
    }
  }
  return out;
}
