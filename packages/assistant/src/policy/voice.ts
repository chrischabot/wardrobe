/**
 * The owner's own voice inside a message.
 *
 * Even inside the text the owner typed, material the owner is merely relaying is not the owner speaking:
 * block quotes, fenced or indented pastes, forwarded mail, anything in quotation marks (single, double,
 * curly or guillemets, on one line or across lines) and whatever follows a relaying introducer ("my
 * brother wrote: ...", "Review I found online: ..."). This module removes all of that.
 *
 * What the result is used for: deciding which garments the owner NAMED in a wear or wash report, which
 * sentences recall may attribute to the owner, and the text of a comfort note. It is never used to
 * authorize a sensitive change: those are only ever carried out on the owner's confirmation of a proposal
 * (policy/classes.ts), whatever the words were.
 */

export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A line that starts a pasted or forwarded message: everything from it on is relayed. */
const FORWARD_MARKER = /^\s*(?:-{2,}\s*)?(?:forwarded message|original message|begin forwarded message)\b|^\s*on .{4,80} wrote:\s*$|^\s*(?:fwd?|fw)\s*:|^\s*fwd?\b.{0,40}$|^\s*(?:from|subject|to|cc|date|sent)\s*:\s*\S/im;

/** Words that introduce someone else's words; what follows the colon is relayed. */
const RELAY_INTRODUCER =
  /\b(?:wrote|writes|written|texted|messaged|emailed|said|says|saying|replied|told me|tells me|posted|commented|review(?:s|ed)?|quote|quoting|pasting|pasted|copied|copying|forwarding|forwarded|the text|the note|the leaflet|the letter|the email|the message|the label|the page|the site|it reads|it says|reads|according to)\b[^:\n.!?]{0,60}:\s*/i;

/**
 * The part of a message that is the owner's own voice. Relayed material is replaced by a space, so word
 * boundaries around it survive.
 */
export function ownerAuthoredText(raw: string): string {
  let text = raw.normalize("NFKC").replace(/\r\n?/g, "\n").replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D\u201E]/g, '"');
  // Fenced blocks.
  text = text.replace(/```[\s\S]*?(?:```|$)/g, "\n");
  // Everything from a forwarded or pasted message header on.
  const marker = text.search(FORWARD_MARKER);
  if (marker !== -1) text = text.slice(0, marker);
  // Block-quoted and indented (pasted) lines.
  text = text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line) && !/^(?: {4,}|\t)\S/.test(line))
    .join("\n");
  // Quotations of any length: guillemets, double quotes (also across lines), and single quotes that are
  // quotation marks rather than apostrophes (they open after a space or at the start and close before one).
  text = text.replace(/\u00AB[\s\S]*?(?:\u00BB|$)/g, " ");
  text = text.replace(/"[^"]*"/g, " ");
  // An unclosed double quote relays the rest of its paragraph.
  text = text.replace(/"[^"\n]*(?:\n(?!\n)[^"\n]*)*$/g, " ");
  text = text.replace(/(^|[\s(\[:,;\-])'(?=\S)([^'\n]*?\S)'(?=$|[\s.,;:!?)\]\-])/gm, "$1 ");
  // Whatever follows a relaying introducer, to the end of its paragraph.
  text = text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const at = paragraph.search(RELAY_INTRODUCER);
      return at === -1 ? paragraph : paragraph.slice(0, at);
    })
    .join("\n\n");
  return text;
}

export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+|;\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A question without its mark: a question word, or an auxiliary followed by its subject ("did I wear", "is the"). "Had the Chasseur on" is a report. */
const QUESTION_START = /^(?:what|which|who|whom|whose|when|where|why|how)\b|^(?:should|shall|can|could|would|will|do|does|did|is|are|am|was|were|may|might)\s+(?:i|we|you|he|she|it|they|my|the|this|that|these|those|there)\b|^(?:have|has|had)\s+(?:i|we|you|he|she|it|they)\b/;
const NEGATION = /\b(?:not|never|no longer|without|nor|neither|hardly|barely|no)\b|n't\b/;
const NOT_YET = /\b(?:will|won't|tomorrow|going to|gonna|plan(?:ning)? to|intend(?:ing)? to|might|may|if|unless|would|could|should|want to|wanted to|thinking (?:of|about)|imagine|pretend|suppose|supposing|hypothetical(?:ly)?|what if|let's say|next (?:week|month|year|time)|someday|maybe|perhaps|nearly|almost)\b|\b(?:i|we)'ll\b/;
const OTHER_PERSON =
  /\b(?:my|his|her|their|our|the|a)\s+(?:brother|sister|wife|husband|partner|friend|dad|father|mum|mom|mother|son|daughter|colleague|boss|neighbour|neighbor|mate|uncle|aunt|cousin|girlfriend|boyfriend|flatmate|tailor's|physio|doctor|dog|cat)(?:'s)?\b|\b(?:he|she|they)\s+(?:wore|wears|wear|is|are|was|were|had|has|have|washed|bought|put|threw|took|got|said|says|thinks?)\b|\b(?:his|her|their)\s/;

/**
 * Whether a sentence reads as the owner's own direct report of something that happened. A question, a
 * negation, a plan, a hypothetical or a sentence about somebody else does not. Used only as a pre-filter
 * for wear and wash reports and for recall attribution: failing it never refuses anything, it only means
 * the report waits for the owner's confirmation instead of being recorded straight away.
 */
export function isDirectReport(sentence: string): boolean {
  const s = normalizeText(sentence);
  if (!s) return false;
  if (s.endsWith("?") || QUESTION_START.test(s)) return false;
  if (NEGATION.test(s)) return false;
  if (NOT_YET.test(s)) return false;
  if (OTHER_PERSON.test(s)) return false;
  return true;
}

const THIRD_PARTY_SUBJECT = /\b(?:he|she|they|someone|somebody|everyone|everybody|people|reviewers?|the reviews?|customers?|the internet|reddit|the forum|the shop|the brand|the maker|the salesman|the assistant)\b/;

/** A sentence that is about, or reports the words of, somebody other than the owner. */
export function isAboutSomeoneElse(sentence: string): boolean {
  const s = normalizeText(sentence);
  return OTHER_PERSON.test(s) || THIRD_PARTY_SUBJECT.test(s);
}
