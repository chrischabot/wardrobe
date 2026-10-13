/**
 * Whether the owner's own words of this turn SAY that a restriction's condition has ended.
 *
 * A restriction is a hard constraint (specification L318-L320, L332): it ends only when the owner says so
 * (L334). Under the owner's decision of 2026-10-05 such a statement, in the owner's own app conversation,
 * lifts the restriction at once with an undo. Because that removes a hard constraint, the statement is read
 * here by trusted code, and narrowly: a clause must have one of a few forms of a first-person statement
 * that the condition is over ("my feet have healed", "I'm fully recovered", "the podiatrist cleared me",
 * "the doctor told me my feet have healed"), with nothing beside it but small words of time and degree;
 * and nothing in the sentence may deny, doubt, quote, wish, joke or imagine it. A message that only
 * mentions healing, asks about it, says it about somebody else or relays someone's words says nothing
 * here. Failing this refuses nothing: the model's lift is kept as a request for the owner in the app.
 *
 * This is an allow-list on purpose. A message that does say it in other words ("the swelling's gone, back
 * to normal shoes") is not read as a lift and waits for the owner; the cost of that is one tap.
 */
import { normalizeText, ownerAuthoredText, sentencesOf } from "./voice.ts";

/** What a statement may open with without changing what it says. */
const LEAD_IN = /^(?:(?:good news|great news|update|fyi|btw|ok|okay|so|well|yes|finally|right|news)\s*[:,!-]?\s+)+/;
/** Degree and time words that may stand inside or after the statement. */
const DEGREE = "(?:(?:now|finally|fully|properly|completely|all|at\\s+last|officially)\\s+)*";
const TRAILING = "(?:\\s+(?:again|now|at\\s+last|today|this\\s+morning|this\\s+week|officially))*";
const BODY = "(?:(?:my|both\\s+my|both)\\s+)?(?:feet|foot|toes?|ankles?|heels?)";
const HEALED = "(?:healed|recovered|all\\s+good|back\\s+to\\s+normal)";

const ENDED_FORMS: RegExp[] = [
  // "My feet have healed", "Feet are all good again", "My foot is properly healed now".
  new RegExp(`^${BODY}\\s+(?:have|has|are|is|'ve|'s)\\s+(?:now\\s+|finally\\s+)?(?:been\\s+)?${DEGREE}${HEALED}${TRAILING}$`),
  // "I'm fully recovered", "I have healed", "I've been cleared".
  new RegExp(`^(?:i'm|i\\s+am|i've|i\\s+have|i\\s+have\\s+now)\\s+(?:been\\s+)?${DEGREE}(?:healed|recovered|cleared|signed\\s+off)${TRAILING}$`),
  // "The podiatrist cleared me", "My doctor has signed me off".
  new RegExp(`^(?:the|my)\\s+(?:podiatrist|doctor|physio|physiotherapist|surgeon|consultant|gp|specialist)\\s+(?:has\\s+)?(?:just\\s+)?(?:cleared\\s+me(?:\\s+off)?|signed\\s+me\\s+off)(?:\\s+for\\s+normal\\s+shoes)?${TRAILING}$`),
  // "The doctor told me my feet have healed": the owner reporting a professional's word to him.
  new RegExp(`^(?:the|my)\\s+(?:podiatrist|doctor|physio|physiotherapist|surgeon|consultant|gp|specialist)\\s+(?:has\\s+)?(?:told|confirmed\\s+to)\\s+me\\s+(?:that\\s+)?${BODY}\\s+(?:have|has|are|is)\\s+(?:now\\s+)?(?:been\\s+)?${DEGREE}${HEALED}${TRAILING}$`),
];

/** Anything in the sentence that denies, doubts, quotes, wishes, jokes, imagines or reports the statement instead of making it. */
const UNDERMINED = /\b(?:not|never|nobody|no\s+one|hardly|barely|isn't|aren't|haven't|hasn't|don't|doesn't|didn't|won't|wasn't|weren't|can't|cannot|still|yet|limp\w*|hurts?|hurting|pain\w*|sore|swell\w*|worse|lie|lying|sure|joke|joking|kidding|sarcas\w*|story|anything\s+but|far\s+from|wish|hope|hoping|dream|if|would|could|should|might|may|maybe|perhaps|suppose|supposing|imagine|pretend|game|role\W?play|hypothetical\w*|thinks|thought|says|said|apparently|supposedly|according|leaflet|form|note|email|letter|text|pasting|pasted|quote|wife|husband|brother|sister|partner|friend|dog|cat|patient)\b|n't\b/;
/** Anything in the message that turns all of it into play, a hypothetical or someone else's text. */
const PLAY = /\b(?:let's\s+play|a\s+game|pretend|role\W?play|imagine|suppose|hypothetical\w*|what\s+if|for\s+argument's\s+sake|in\s+character)\b/;
/** A later sentence of the same message that takes the statement back ("... That was a joke."). */
const RETRACTED = /\b(?:joke|joking|jk|kidding|lol|sarcas\w*|not\s+(?:really|true|actually)|(?:wasn't|isn't|was\s+not|is\s+not)\s+true|a\s+lie|lying|just\s+testing|testing\s+you|scratch\s+that|ignore\s+(?:that|what\s+i\s+said)|take\s+(?:that|it)\s+back)\b/;

/** Another body part named by the restriction: then a statement about the feet does not speak to it. */
const OTHER_BODY_PART = /\b(?:back|spine|knees?|hips?|shoulders?|neck|wrists?|hands?|arms?|elbows?|skin|chest|eyes?|head|abdom\w*|stomach|belly|hernia|heart|lungs?|bowel|gut|pelvi\w*|groin|ribs?|jaw|teeth|tooth|face)\b/i;

/** A purpose of the restriction other than the foot's healing: then healing does not end the whole of it. */
const OTHER_PURPOSE = /\b(?:for|because|due\s+to|owing\s+to|safety|safe|required|requires?|requirement|policy|rules?|dress\s+code|uniform|work\w*|job|site|office|school|club|event|weather|rain\w*|snow\w*|wet|cold|heat|hot|also|plus|as\s+well|both(?!\s+(?:my\s+|his\s+|the\s+)?(?:feet|foot|toes?|ankles?|heels?)\b)|either|whichever|always|permanent\w*|forever|indefinite\w*|unless|if|and\s+(?:until|while|when|during|after))\b/i;
/** Words that open a condition; a restriction with more than one has more than one condition. */
const CONDITION_MARKER = /\b(?:until|till|while|during|unless|when|whenever|if|after|before)\b/gi;

/** Words that deny, exclude or set aside the injury ("not for a foot injury", "foot injury ruled out", "without injury"). */
const EXCLUDED = /\b(?:not|no|never|nothing|none|neither|nor|unrelated|unconnected|regardless|irrespective|rather\s+than|instead\s+of|without|ruled?\s+out|excluded?|excluding|absent|absence|free\s+of|negative|other\s+than|except|apart\s+from|aside\s+from|no\s+longer|denie[sd]|deny)\b|n't\b/i;

/**
 * The parts of the foot words name: plural ("feet", "toes", "ankles", "heels") and singular ("foot", "toe",
 * "ankle", "heel") are kept distinct so a statement about one foot ("my foot has healed") never lifts a
 * restriction on both feet ("until his feet have healed").
 */
const BOTH_PREFIX = "\\bboth\\s+(?:(?:my|his|the)\\s+)?(?:(?:sprained|broken|fractured|injured|swollen)\\s+)?";

export function footPartsNamed(text: string): string[] {
  const parts = new Set<string>();
  const t = text.toLowerCase();
  if (new RegExp(`\\bfeet\\b|${BOTH_PREFIX}foot\\b`).test(t)) parts.add("feet");
  else if (/\bfoot\b/.test(t)) parts.add("foot");
  if (new RegExp(`\\btoes\\b|${BOTH_PREFIX}toe\\b`).test(t)) parts.add("toes");
  else if (/\btoe\b/.test(t)) parts.add("toe");
  if (new RegExp(`\\bankles\\b|${BOTH_PREFIX}ankle\\b`).test(t)) parts.add("ankles");
  else if (/\bankle\b/.test(t)) parts.add("ankle");
  if (new RegExp(`\\bheels\\b|${BOTH_PREFIX}heel\\b`).test(t)) parts.add("heels");
  else if (/\bheel\b/.test(t)) parts.add("heel");
  return [...parts];
}

const PLURAL_COVER: Record<string, string> = { foot: "feet", toe: "toes", ankle: "ankles", heel: "heels" };

/** The imported profile's parenthetical origin and scope notes on the foot-healing restriction. */
const IMPORTED_HEALING_SUFFIX =
  /\s*\(nerve damage from previously too-small shoes\)(?:;\s*the welted fleet and the 990v6 are out of play)?$/i;

const ALLOWED_RESTRICTION_KINDS: ReadonlySet<string> = new Set([
  "healing",
  "foot_healing",
  "sneakers_only",
  "trainers_only",
]);

const RESTRICTION_LEAD = "(?:(?:sneakers?|trainers?)\\s+only\\s+)?";
const RESTRICTION_PART = "(?:feet|foot|toes?|ankles?|heels?)";
const INJURY_PART = `(?:(?:sprained|broken|fractured|injured|swollen)\\s+${RESTRICTION_PART}|${RESTRICTION_PART}\\s+injur(?:y|ies))`;

/**
 * Closed forms of a restriction reason whose condition is ended when the owner's feet (or the named foot part)
 * have healed:
 *   - "until [the owner says] [his|my|the|both] <part/injury> [have/has/are/is] healed/heals/recovered/recovers"
 *   - "while recovering from [a/an/the/his/my] <injury>"
 *   - "while [the/his/my/both] <injury/part> heals/recovers/is healing/is recovering"
 * Never "while ... healed/recovered" (which would make healing the active trigger rather than the end) and
 * never "until ... surgery/operation" (which waits for surgery rather than ended healing).
 */
const ENTAILED_RESTRICTION_FORMS: readonly RegExp[] = [
  new RegExp(
    `^${RESTRICTION_LEAD}(?:until|till)\\s+(?:the\\s+owner\\s+says\\s+)?(?:(?:his|my|the|both(?:\\s+(?:my|his|the))?)\\s+)?(?:${INJURY_PART}|${RESTRICTION_PART})\\s+(?:(?:have|has|are|is)\\s+)?(?:healed|heals|heal|recovered|recovers|recover)$`,
    "i",
  ),
  new RegExp(
    `^${RESTRICTION_LEAD}(?:while|during)\\s+recover(?:ing|y)\\s+from\\s+(?:(?:a|an|the|his|my|both(?:\\s+(?:my|his|the))?)\\s+)?${INJURY_PART}$`,
    "i",
  ),
  new RegExp(
    `^${RESTRICTION_LEAD}while\\s+(?:(?:the|his|my|both(?:\\s+(?:my|his|the))?)\\s+)?(?:${INJURY_PART}|${RESTRICTION_PART})\\s+(?:heals|heal|recovers|recover|(?:is|are)\\s+(?:healing|recovering))$`,
    "i",
  ),
];

/**
 * Whether an ended statement speaks to this restriction's condition: a foot healing restriction and nothing else.
 * Given the statement, also the same part of the foot: every part the restriction names (both feet when it names
 * none) must be covered by what the owner's words name (both feet when they name none, as in "the podiatrist
 * cleared me"). "My toe is healed" or "My foot has healed" never lifts a rule for both feet or a broken ankle.
 */
export function endedCovers(restriction: { kind: string; reason: string | null }, statement?: { parts: readonly string[] }): boolean {
  const rawKind = restriction.kind.trim().toLowerCase();
  if (!ALLOWED_RESTRICTION_KINDS.has(rawKind)) return false;
  const rawReason = (restriction.reason ?? "").trim();
  const strippedReason = rawReason.replace(IMPORTED_HEALING_SUFFIX, "").replace(/[.!]+$/, "").replace(/\s+/g, " ").trim();
  if (!strippedReason) {
    if (rawKind !== "foot_healing") return false;
  } else {
    // Reject any comma, semicolon, colon, parenthesis, conjunction or negation in the condition reason.
    if (/[,;:()]|\b(?:and|or|plus)\b/i.test(strippedReason)) return false;
    if (EXCLUDED.test(strippedReason) || OTHER_PURPOSE.test(strippedReason) || OTHER_BODY_PART.test(strippedReason)) return false;
    if ((strippedReason.match(CONDITION_MARKER) ?? []).length > 1) return false;
    if (!ENTAILED_RESTRICTION_FORMS.some((re) => re.test(strippedReason))) return false;
  }
  if (!statement) return true;
  const named = footPartsNamed(strippedReason);
  const required = named.length ? named : ["feet"];
  const said = new Set(statement.parts.length ? statement.parts : ["feet"]);
  return required.every((part) => said.has(part) || (Object.hasOwn(PLURAL_COVER, part) && said.has(PLURAL_COVER[part]!)));
}
const QUESTION_START = /^(?:what|which|who|when|where|why|how|should|shall|can|could|would|will|do|does|did|is|are|am|was|were|may|might|have|has)\b/;

/** Where a sentence may be cut into clauses. */
const CLAUSES = /\s*[,;]\s+|\s+(?:and|so)\s+/;

export interface EndedStatement {
  /** The owner's sentence that says it. */
  sentence: string;
  /** The clause of that sentence in one of the accepted forms. */
  clause: string;
  /** The parts of the foot the owner's words of this turn name (footPartsNamed); empty for the foot as a whole. */
  parts: string[];
}

/** The owner's statement in these texts (their own words of this turn) that a restriction's condition has ended, or null. */
export function statesConditionEnded(ownerTexts: string[]): EndedStatement | null {
  let found: EndedStatement | null = null;
  let foundIndex = -1;
  const all: string[] = [];
  for (const raw of ownerTexts) {
    const own = ownerAuthoredText(raw);
    if (PLAY.test(normalizeText(own)) || RETRACTED.test(normalizeText(own))) return null;
    for (const sentence of sentencesOf(own)) all.push(sentence);
  }
  all.forEach((sentence, index) => {
    if (found) return;
    const s = normalizeText(sentence).replace(/["«»]/g, " ");
    if (!s || s.endsWith("?") || QUESTION_START.test(s) || UNDERMINED.test(s) || DOUBTS.test(s)) return;
    for (const part of s.split(CLAUSES)) {
      const clause = part.replace(/[.!]+$/, "").replace(LEAD_IN, "").replace(/\s+/g, " ").trim();
      if (BEEN_BETTER.test(clause)) continue;
      const form = ENDED_FORMS.findIndex((f) => f.test(clause));
      if (form === -1) continue;
      found = { sentence, clause, parts: [] };
      foundIndex = index;
      return;
    }
  });
  if (!found) return null;
  const statement: EndedStatement = found;
  // A generic recovery ("I'm fully recovered", "my doctor cleared me") says nothing about WHICH condition ended:
  // it speaks to the feet only when the owner's words of this turn name the feet or their shoes.
  const text = normalizeText(all.join(" "));
  if (!new RegExp(`\\b${BODY}\\b`).test(statement.clause) && !FEET_REFERENT.test(text)) return null;
  // Every other clause of the owner's words is read too, before or after the statement and in its own sentence:
  // each must be another accepted statement, or a short request about the rule and the shoes made only of the
  // words below ("so please lift the sneakers restriction", "welted shoes back in rotation please"). Anything else
  // ("except the left one", "my ankle is swollen", "nope", "that is false") keeps the restriction and the lift
  // waits for the owner in the app. This is a closed list on purpose: a false refusal costs one tap; a false lift
  // removes a hard constraint.
  const unaccounted = all.some((sentence, index) => {
    const s = normalizeText(sentence).replace(/["«»]/g, " ");
    const clauses = s.split(CLAUSES).map((part) => part.replace(/[.!]+$/, "").replace(LEAD_IN, "").replace(/\s+/g, " ").trim()).filter(Boolean);
    return clauses.some((clause) => {
      if (index === foundIndex && clause === statement.clause) return false;
      if (UNDERMINED.test(clause) || DOUBTS.test(clause) || BEEN_BETTER.test(clause)) return true;
      if (ENDED_FORMS.some((f) => f.test(clause))) return false;
      return !isFollowUp(clause);
    });
  });
  return unaccounted ? null : { ...statement, parts: footPartsNamed(text) };
}

/** The only words a clause beside the statement may use: asking for the rule to go, or for the shoes back. */
const FOLLOW_UP_WORDS = new Set([
  "i", "we", "can", "think", "so", "please", "now", "again", "back", "in", "into", "to", "rotation", "wear", "wearing",
  "drop", "lift", "remove", "end", "scrap", "bring", "put", "the", "my", "no", "more", "only", "rule", "restriction",
  "sneakers", "sneaker", "trainers", "trainer", "welted", "shoes", "shoe", "boots", "boot", "paraboots", "paraboot",
  "loafers", "loafer", "fleet", "normal", "regular", "proper", "thanks", "thank", "you",
]);
/** A follow-up must be about the rule or the shoes. */
const FOLLOW_UP_SUBJECT = /\b(?:sneakers?|trainers?|rule|restriction|shoes?|boots?|paraboots?|loafers?|welted|fleet)\b/;
/** Asking for the rule to go. */
const RELEASE_VERB = /\b(?:drop|lift|remove|end|scrap)\b/;
/** The shoes the rule keeps him in: a clause about them that does not ask for the rule to go keeps it. */
const KEPT_SHOES = /\b(?:sneakers?|trainers?|only)\b/;
function isFollowUp(clause: string): boolean {
  if (RELEASE.test(clause)) return true;
  if (/^no\b/.test(clause)) return false;
  const words = clause.split(/[^a-z']+/).filter(Boolean);
  if (!(words.length > 0 && FOLLOW_UP_SUBJECT.test(clause) && words.every((w) => FOLLOW_UP_WORDS.has(w)))) return false;
  // "I can only wear sneakers" or "I'll keep to trainers" keeps the restriction: a clause naming the kept shoes
  // or "only" must ask for the rule to go ("drop the sneakers rule", "lift the sneakers restriction").
  if (KEPT_SHOES.test(clause) && !RELEASE_VERB.test(clause)) return false;
  // Otherwise it must ask for the rule to go or for other shoes back ("I can wear the Paraboots again").
  return RELEASE_VERB.test(clause) || /\b(?:again|back|rotation)\b/.test(clause);
}

/** The feet or the shoes they wear named anywhere in the owner's words. */
const FEET_REFERENT = /\b(?:feet|foot|toes?|ankles?|heels?|podiatr\w*|shoes?|sneakers?|trainers?|loafers?|boots?|footwear)\b/;
/** The owner asking for the rule to go ("no more sneakers-only", "no more sneakers rule"): not a denial. */
const RELEASE = /^no\s+more\s+(?:sneakers?|trainers?)(?:[\s-]+only)?(?:\s+(?:rule|restriction))?$/;
/** Denial, doubt or hedging anywhere in a sentence ("That is false.", "I doubt it.", "mostly"). */
const DOUBTS = /\b(?:false|untrue|wrong|incorrect|doubt\w*|unsure|uncertain|wonder\w*|probably|possibly|guess\w*|kind\s+of|sort\s+of|almost|nearly|mostly|partly|partially|somewhat|ish|not\s+quite|not\s+yet)\b/;
/** "My feet have been better" says they are worse now: "been" before "better" ends nothing. */
const BEEN_BETTER = /\bbeen\s+(?:\w+\s+)*better\b/;
