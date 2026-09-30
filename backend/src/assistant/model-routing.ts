import { ownWords } from '../domain/healing.js';
import type { ModelRequest } from '../models/types.js';

/**
 * How deeply a conversational turn needs to reason (owner's decision, 2026-09-29): routine turns are
 * served by GPT-6.1 Sol, and deep turns by Claude Opus 5.5 at medium effort (the `research` chain in
 * the model registry; the request's task stays `chat`). Deep means purchase judgments, size-chart and fit
 * work, provenance and construction questions, product research and keep/sell/alter decisions: the
 * work the profile's shopping, sizing and advice sections govern.
 *
 * Decided by trusted code from the owner's submitted message (and its attachment kinds) when the turn
 * starts, never by a model and never from tool output or fetched pages, so nothing the assistant
 * reads mid-turn can move the turn to another model. Only the owner's own words count: quoted text
 * (a calendar title such as "Design review", a product name, a pasted line), forwarded or
 * `>`-quoted blocks are someone else's words and are ignored, the same reading as the healing rule
 * (domain/healing.ts ownWords). Everything else (dressing, logging, laundry, quick questions about
 * the board) stays on the routine model. Routing only chooses between the two allowed models; it
 * grants no command authority (that is intent.ts).
 */
const DEEP: RegExp[] = [
  // Buying and purchase judgment.
  /\b(buy|bought|purchase|should i (get|order|pick up)|worth (it|the money|buying)|add(s)? (anything|nothing)|another (jacket|coat|shirt|blazer|pair)|wishlist|in stock|sold out|restock|discount|sale price)\b/i,
  // Sizing, fit and measurements.
  /\b(size|sizing|size chart|chart|measurement|measure(d|s)?|chest|pit to pit|inseam|rise|waist|sleeve length|shoulder width|fit(s|ting)? (me|right|small|large|big)|true to size|run(s)? (small|large|big))\b/i,
  // Provenance, construction and cloth.
  /\b(provenance|made (in|by)|maker|mill|cloth weight|oz\b|ounce|gsm|fused|canvas(sed)?|sewn|construction|shirtmaker|selvedge)\b/i,
  // Research and comparison. "Review" means product reviews, not a meeting ("design review"):
  // "reviews of/for/on", "any reviews", "Paraboot reviews", "review this jacket".
  /\b(research|compare|comparison|versus|vs\.?|alternatives?|which (is|one is) better|find (me )?(a|an|some)|look (for|into)|reviews? (of|for|on|say)|(read|any|good|bad|online) reviews)\b/i,
  /(?<!\b(design|code|portfolio|performance|annual|quarterly|sprint|team|peer|project|budget|board|weekly|monthly|staff|pipeline) )\breviews\b/i,
  /\breview (this|that|these|those|the|a|an) (?!(outfits?|board|options?|looks?|day|plan|calendar|schedule|morning|evening|week|meeting|agenda|notes|slides|deck)\b)\w/i,
  // Keep, sell, consign, alter or return decisions.
  /\b(keep or|sell|consign(ment)?|get rid of|alter(ation)?|tailor(ing)?|return (it|them|this)|exchange|donate)\b/i,
];

export function reasoningDepthForTurn(input: { text: string; attachments?: { kind: string }[] }): NonNullable<ModelRequest['depth']> {
  if ((input.attachments ?? []).some((a) => a.kind === 'link')) return 'deep';
  // Single-quoted spans too ('Design review'), but not apostrophes inside words (I'll, Drake's).
  const own = ownWords(input.text ?? '').replace(/(^|[\s(])'[^'\n]{1,120}'(?=$|[\s).,!?;:])/g, '$1 … ');
  return DEEP.some((p) => p.test(own)) ? 'deep' : 'routine';
}
