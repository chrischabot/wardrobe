/**
 * Request intent and command policy (spec section 3, "Conversation and capture"; section 8).
 *
 * Derived by trusted code from the owner's own message and the client's explicit capture intent,
 * never from model output. Each write tool checks that its command family is allowed for the
 * current turn. The policy errs towards asking: a blocked write returns a structured
 * `not_authorized` result so the assistant can ask one question instead of acting.
 */

import { findHealingStatement as findHealing } from '../domain/healing.js';

export type CommandFamily =
  | 'wear'
  | 'care'
  | 'arrival'
  | 'inventory_location'
  | 'intake_item'
  | 'intake_order'
  | 'restriction_set'
  | 'restriction_lift'
  | 'taste_profile'
  | 'taste_brief'
  | 'selection'
  | 'comfort'
  | 'lifecycle'
  | 'undo';

export type CaptureIntent = 'add_item' | 'identify' | 'what_i_wore';

export interface TurnInputForIntent {
  text: string;
  attachments?: { kind: 'image' | 'link' | 'file' }[];
  captureIntent?: CaptureIntent | null;
  /** Native deterministic actions never reach this classifier; conversation turns only. */
}

export interface TurnIntent {
  version: 'turn-intent/1';
  allowed: CommandFamily[];
  blocked: { family: CommandFamily; reason: string }[];
  flags: {
    photo: boolean;
    askingWhetherWorks: boolean;
    venting: boolean;
    explicitLog: boolean;
    oneDay: boolean;
    standing: boolean;
    /** The owner's own sentence stating that his feet have healed, when present. */
    healingStatement: string | null;
  };
  summary: string;
}

/**
 * The owner's own first-person statement that his feet have healed, ignoring quoted, forwarded or
 * pasted text (domain/healing.ts, shared with the lift_restriction handler).
 */
export function findHealingStatement(text: string): string | null {
  return findHealing(text);
}

const P = {
  strongLog: /\b(log|record)\b(?![^.?!]*\border\b)/i,
  weakLog: /\b(i('m| am) wearing|i wore|wore (the|my|this|that)|just wore|wearing (today|this morning|tonight)|i put on|changed (into|my shirt)|swapped (into|to))\b/i,
  askWorks:
    /\b((does|do|would|will|could|should|can|is|are)\b[^?]{0,80}\b(work|go|goes|look|pair|match|clash|suit|ok|okay|good|right|too much)\b|what do you think|thoughts on|works? with|goes? with|verdict)\b/i,
  vent: /\b(regret|hate|annoy(ed|ing)|wish i (hadn't|had not|never)|waste of money|why did i (buy|get)|can't stand|cannot stand|so disappointed|ugh)\b/i,
  lifecycleExplicit: /\b(sell|consign|list (it|them|these|this)|put (it|them) up for sale|get rid of|return (it|them|this|these)|send (it|them)? ?back|donate|sold|collected|picked up|posted (it|them|the return)|tailor|alter(ation)?|withdraw (it|the listing))\b/i,
  care: /\b(in the (wash|hamper|laundry)|washed|laundry|hamper|dirty|collected|came back|socks (are )?washed|pick(ed)? ?up|still away|didn't come back|missing from the laundry|stain(ed)?)\b/i,
  arrival: /\b(arrived|came today|was delivered|were delivered|got here|turned up|has come|have come|received (it|them|the))\b/i,
  intakeItem: /\b(add (it|this|these|them|that|a|an|the|my)?\b[^.?!]{0,60}\b(to (my |the )?wardrobe|as (a |an )?(new )?item)|new item|create (an? )?(item|garment))\b/i,
  intakeOrder: /\b((log|import|record|add) (the|this|that|my|these) (order|purchase)s?|log (what i bought|my purchases))\b/i,
  location: /\b(tailor|storage|stored|put (it |them )?away|take (it |them )?out|back from|into storage|out of storage|repair)\b/i,
  restrict: /\b((don't|do not|stop) (suggest|offer|use|put)|keep [^.?!]{0,40} out of|exclude|restrict)\b/i,
  standing: /\b(from now on|going forward|in future|always|never (again )?(suggest|offer|put|use)|remember that|update my (style|profile)|stop (making|suggesting|defaulting|using)|as a rule|correction:|that's wrong|that is wrong|actually,? (i|my|it|the))\b/i,
  oneDay: /\b(today|tomorrow|tonight|this (morning|afternoon|evening|weekend|week)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|for (the )?(trip|dinner|wedding|meeting|interview))\b/i,
  onlyOneDay: /\b(just|only) (for )?(today|tomorrow|tonight|this (morning|evening|weekend))\b/i,
  select: /\b(i'll (take|go with|wear)|go with (option|number|the)|pick (option|number)|choose (option|number)|option (one|two|three|four|five|\d)|number (one|two|three|four|five|\d))\b/i,
  comfort: /\b(hurt|hurts|pain(ful)?|scratch(es|y)?|itch(y|es)?|too (warm|hot|cold|tight|loose)|blister|pinch(es)?|uncomfortable|rub(s|bing)?|chafe|dig(s)? in)\b/i,
  undo: /\b(undo|revert|scratch that|take that back|that was a mistake|i didn't wear)\b/i,
};

export function classifyTurnIntent(input: TurnInputForIntent): TurnIntent {
  const text = input.text ?? '';
  const photo = (input.attachments ?? []).some((a) => a.kind === 'image');
  const allowed = new Set<CommandFamily>();
  const blocked: { family: CommandFamily; reason: string }[] = [];
  const block = (family: CommandFamily, reason: string) => {
    allowed.delete(family);
    if (!blocked.some((b) => b.family === family)) blocked.push({ family, reason });
  };

  const askingWhetherWorks = P.askWorks.test(text) && /\?/.test(text);
  const strongLog = P.strongLog.test(text) || input.captureIntent === 'what_i_wore';
  const weakLog = P.weakLog.test(text);
  const venting = P.vent.test(text);
  const healingStatement = findHealingStatement(text);
  const onlyOneDay = P.onlyOneDay.test(text);
  const oneDay = P.oneDay.test(text);
  const standing = P.standing.test(text) && !onlyOneDay;

  // Wear: an explicit log, or a plain statement of wearing that is not a question about the outfit
  // and not merely a photo.
  if (strongLog || (weakLog && !askingWhetherWorks && !(photo && !strongLog))) allowed.add('wear');
  if (askingWhetherWorks && !strongLog) block('wear', 'Asking whether an outfit works does not log it.');
  if (photo && !strongLog && input.captureIntent !== 'what_i_wore') block('wear', 'A photo alone does not authorize logging; unseen pieces stay unknown.');

  if (P.care.test(text)) allowed.add('care');
  if (P.arrival.test(text)) allowed.add('arrival');
  if (P.location.test(text)) allowed.add('inventory_location');
  if (P.intakeItem.test(text) || input.captureIntent === 'add_item') allowed.add('intake_item');
  if (photo && input.captureIntent !== 'add_item' && !P.intakeItem.test(text)) block('intake_item', 'A photo does not create a garment without an explicit Add an item request.');
  if (P.intakeOrder.test(text)) allowed.add('intake_order');
  if (P.restrict.test(text)) allowed.add('restriction_set');
  if (healingStatement) allowed.add('restriction_lift');
  if (standing) allowed.add('taste_profile');
  if (oneDay || onlyOneDay) allowed.add('taste_brief');
  if (onlyOneDay) block('taste_profile', 'A one-day request is a temporary brief; the profile is not rewritten.');
  if (P.select.test(text)) allowed.add('selection');
  if (P.comfort.test(text) || P.restrict.test(text)) allowed.add('comfort');
  if (P.lifecycleExplicit.test(text)) allowed.add('lifecycle');
  if (venting && !P.lifecycleExplicit.test(text)) block('lifecycle', 'Venting about a purchase does not start a disposal or sale.');
  if (P.undo.test(text)) allowed.add('undo');

  const allowedList = [...allowed];
  const summary = [
    allowedList.length ? `changes the owner's words authorize this turn: ${allowedList.join(', ')}` : 'no change is authorized by this message; answer, research or ask',
    ...blocked.map((b) => `${b.family} not authorized (${b.reason})`),
  ].join('; ');
  return {
    version: 'turn-intent/1',
    allowed: allowedList,
    blocked,
    flags: { photo, askingWhetherWorks, venting, explicitLog: strongLog, oneDay: oneDay || onlyOneDay, standing, healingStatement },
    summary,
  };
}

/** True when `quote` appears in the owner's message (whitespace and quote-mark insensitive). */
export function quoteInOwnerText(quote: string, ownerText: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  return q.length >= 3 && norm(ownerText).includes(q);
}
