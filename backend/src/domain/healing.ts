/**
 * The healing statement (owner profile section 8: sneakers only "until he says his feet have healed").
 *
 * Only the owner's own first-person words count: "My feet have healed", "I've healed", "my foot is
 * fully recovered". Quoted, forwarded, fenced or `>`-prefixed text in his message is someone else's
 * words and is ignored, as are second- or third-person claims ("Your feet have healed"), reported
 * speech ("the clinic says ..."), questions, negations, hedges, conditionals and futures. Elapsed
 * time is never a healing statement. Used by the assistant's turn classifier and by the
 * lift_restriction command handler, so the app and MCP confirmation paths apply the same rule.
 */

const SENTENCE_SPLIT = /(?<=[.!?\n])\s+/;
const SEPARATOR = /^\s*(-{3,}|_{3,}|={3,}|\*{3,}|~{3,}|-{2,}\s*(forwarded|original) message\s*-{2,}|begin forwarded message:?|-{2,}\s*original\s*-{2,})\s*$/i;
const FORWARD_HEADER = /^\s*(from|sent|to|subject|date|cc):\s/i;
const FENCE = /^\s*(```|~~~)/;

/** The owner's own words: the message without quoted, forwarded, fenced or `>`-prefixed blocks and without quotations. */
export function ownWords(text: string): string {
  const kept: string[] = [];
  let inFence = false;
  let inQuotedBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (SEPARATOR.test(line)) {
      inQuotedBlock = !inQuotedBlock;
      continue;
    }
    if (inQuotedBlock || /^\s*>/.test(line) || FORWARD_HEADER.test(line)) continue;
    // A line introducing pasted material ("... wrote:", "Forwarding this:") starts a quoted block.
    if (/(\bwrote|\bsays|\bsaid|forward(ed|ing)?[^:]{0,60}|pasted?[^:]{0,60}|copied[^:]{0,60}|from the [^:]{1,40}):\s*$/i.test(line)) {
      kept.push(line.replace(/:\s*$/, '.'));
      inQuotedBlock = true;
      continue;
    }
    kept.push(line);
  }
  // Quotations inside a sentence are someone else's words (or the owner quoting them).
  return kept.join('\n').replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|«[^»\n]*»/g, ' … ');
}

function sentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
}

const HEDGE = /\b(not|n't|never|yet|if|once|when|until|unless|will|would|might|may|hope|hopefully|soon|almost|nearly|should|could|maybe|probably|perhaps|think|guess|seem|seems|apparently|supposedly)\b/i;
const REPORTED = /\b(says?|said|told|tells|according to|wrote|writes|claims?|reckons?|confirms?|confirmed|reports?|letter|email|portal|message|notes?)\b/i;
const FIRST_PERSON_FEET = /\bmy\s+(feet|foot)\b[^.!?]*?\b(have|has|are|is|'ve|'re|'s|now|fully|finally|all|completely)?\s*(fully\s+|completely\s+|finally\s+)?(healed|recovered)\b/i;
const FIRST_PERSON_SELF = /\b(i|i've|i'm|i have|i am)\s+(now\s+|fully\s+|finally\s+|completely\s+)*(have\s+)?(healed|recovered)\b/i;

/** One sentence that is the owner's explicit, unhedged, first-person statement that his feet have healed. */
export function healingSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (!s || s.endsWith('?')) return false;
  if (!/\b(heal(ed)?|recovered)\b/i.test(s)) return false;
  if (HEDGE.test(s) || REPORTED.test(s)) return false;
  if (FIRST_PERSON_FEET.test(s)) return true;
  // "I've healed" counts only when the sentence is about the feet.
  return FIRST_PERSON_SELF.test(s) && /\b(feet|foot)\b/i.test(s);
}

/**
 * The owner's own healing statement in a message he wrote, or null. `ownMessage: false` treats the
 * whole text as one statement (a command's evidence field), still requiring first person.
 */
export function findHealingStatement(text: string, opts: { ownMessage?: boolean } = {}): string | null {
  const scope = opts.ownMessage === false ? text : ownWords(text);
  for (const s of sentences(scope)) if (healingSentence(s)) return s;
  return null;
}

/** Evidence recorded by the assistant has the form `Owner, <channel>: "<exact words>"`; otherwise it is the owner's own text. */
export function parseOwnerEvidence(evidence: string): { channel: string; words: string } | null {
  const m = /^Owner, ([a-z_]+): "([\s\S]*)"$/.exec(evidence.trim());
  return m ? { channel: m[1]!, words: m[2]! } : null;
}

export function healingEvidence(evidence: string): string | null {
  const parsed = parseOwnerEvidence(evidence);
  return findHealingStatement(parsed ? parsed.words : evidence, { ownMessage: !parsed });
}
