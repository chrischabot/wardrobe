/**
 * Action intent: the owner's sentence must ask for THIS action on THIS target.
 *
 * Verifying that a quote is the owner's own words (policy/authority.ts) is not enough: any sentence the
 * owner typed would then authorize any change a model chose to attach it to. This module ties the quote
 * to the action in trusted code:
 *   1. the owner's sentence must contain wording for the kind of action (per command type);
 *   2. where the action names garments, each one must be named by the owner (a distinguishing word of its
 *      record), be attached to the message by the owner, or - for routine, reversible actions only - be
 *      referred to ("it", "those", "that outfit");
 *   3. where the action stores free text as the owner's rule, profile amendment or remembered statement,
 *      that text must be made of the owner's own words;
 *   4. a measurement's number must be in the owner's sentence.
 * It does not rely on the model choosing an honest quote, and it errs towards refusing: a refusal tells
 * the model to ask the owner to say it plainly.
 */
import { all, type Db } from "@garderobe/domain";
import { ownerAuthoredText } from "./authority.ts";

export interface IntentRule {
  /** Wording the owner's sentence must contain for this kind of action. */
  verbs: RegExp;
  /** What else must be found in the owner's words. */
  target: "garments" | "new_garment" | "owner_text" | "number" | "none";
  /** Payload field holding the free text or number to compare (for owner_text and number). */
  field?: string;
}

const R = (source: string) => new RegExp(`\\b(?:${source})\\b`, "i");

/** Per command type. A type that is absent here needs no intent check (bookkeeping commands carry no owner authority at all). */
export const INTENT_RULES: Record<string, IntentRule> = {
  "wear.record": { verbs: R("wore|wear|wearing|worn|had on|have on|got on|put on|dressed|i'm in|i am in|went with"), target: "garments" },
  "wear.amend": { verbs: R("wore|wear|wearing|worn|didn't|did not|wasn't|was not|not|wrong|mistake|correct|actually|instead|remove|change|swap|swapped"), target: "garments" },
  "care.mark_dirty": { verbs: R("dirty|filthy|grubby|mucky|wash|washing|laundry|hamper|stain|stained|soiled|clean|cleaning|sweaty|spill|spilled|spilt|muddy|smells?|smelly"), target: "garments" },
  "care.washed": { verbs: R("wash|washed|clean|cleaned|laundered|laundry|ironed|pressed|dry[- ]?cleaned|back from"), target: "garments" },
  "garment.receive": { verbs: R("arrived|came|come|got|received|here|delivered|turned up|showed up|collected|picked up|landed|have it|have them"), target: "garments" },
  "garment.create": { verbs: R("bought|buy|own|have|got|picked up|purchased|new|add|arrived|received|gift|given|inherited|found|ordered"), target: "new_garment" },
  "garment.correct": { verbs: R("actually|is|are|it's|its|isn't|not|correct|change|update|wrong|should be|fix|rename|call"), target: "garments" },
  "garment.add_alias": { verbs: R("call|called|name|named|known as|refer|alias|nickname|mean|that's"), target: "garments" },
  "garment.move": { verbs: R("moved|move|put|took|taken|take|store|stored|storage|tailor|packed|unpacked|brought|back|sent|dropped|left|is at|are at|is in|are in"), target: "garments" },
  "garment.retire": { verbs: R("sold|gave|given away|donated|threw|thrown|binned|lost|retire|retired|got rid|discard|discarded|gone|no longer have|no longer own|consigned|destroyed|ruined|returned it|returned them|sent it back|sent them back"), target: "garments" },
  "restriction.add": { verbs: R("only|don't|do not|can't|cannot|avoid|not wearing|until|rest|resting|hold|off limits|stop|restrict|exclude|save|saving|reserve|for sale|selling|out of|no"), target: "none" },
  "style.add_direction": { verbs: R("always|never|from now on|going forward|stop|prefer|don't|do not|no more|no|less|more|only|rule|in future|whenever|every|default"), target: "owner_text", field: "text" },
  "style.set_brief": { verbs: R("today|tonight|tomorrow|this morning|this evening|this afternoon|going|meeting|dinner|lunch|need|want|feel|for the|for a|for my"), target: "none" },
  "style.add_amendment": { verbs: R("profile|actually|no longer|now|changed|update|i am|i'm|i have|i've|i do|i don't|i prefer|i like|i love|i hate|i dislike|i want|i wear|i own|my"), target: "owner_text", field: "text" },
  "measurement.record": { verbs: R("measure|measured|measures|measurement|chest|waist|neck|sleeve|inseam|hips?|weigh|height|inch|inches|in|cm|centimetres|centimeters"), target: "number", field: "value" },
  "purchase.import_order": { verbs: R("order|orders|ordered|bought|purchase|purchased|log|receipt|paid"), target: "none" },
  "return.open_case": { verbs: R("return|returning|send(?:ing)? .{0,60}back|sent .{0,60}back|send back|exchange|exchanging|refund|swap|tak(?:e|ing) .{0,60}back|take back|going back"), target: "none" },
  "return.update_case": { verbs: R("return|returned|posted|sent|shipped|dropped|refund|refunded|received|exchange|exchanged|cancel|cancelled|keep|kept|keeping|label|collected|arrived"), target: "none" },
  "lifecycle.open_project": { verbs: R("sell|selling|consign|consigning|tailor|tailoring|alter|altered|altering|repair|repairing|store|storing|storage|donate|donating|dispose|mend|mending|hem|hemmed|list|resole|clean|cleaning|shorten|shortened|take in|taken in|let out"), target: "garments" },
  "lifecycle.record_event": { verbs: R("sold|dropped|sent|collected|picked|back|listed|paid|received|done|finished|agreed|accepted|returned|took|gave|handed|posted|ready|quoted|booked"), target: "none" },
  "lifecycle.authorize_action": { verbs: R("yes|go ahead|approve|approved|authori[sz]e|list it|send it|send them|do it|accept|agree|agreed|ok|okay|confirm|post it|publish"), target: "none" },
  "job.create": { verbs: R("bought|buy|purchase|purchases|purchased|order|orders|ordered|receipt|receipts|email|emails|mail|inbox|mailbox|spent|spend|shopping"), target: "none" },
  "reminder.set": { verbs: R("remind|reminder|alert|notify|ping|tell me|let me know|forget|nudge"), target: "none" },
  "reminder.cancel": { verbs: R("cancel|remove|delete|forget|stop|drop|no longer|never mind|don't remind"), target: "none" },
  "settings.update": { verbs: R("remind|reminding|reminder|reminders|notification|notifications|notify|alert|alerts"), target: "none" },
  "memory.record_conclusion": { verbs: R("remember|note|keep in mind|forget|for future|going forward|always|never|i like|i love|i prefer|i hate|i dislike|fits?|too"), target: "owner_text", field: "text" },
  "memory.set_status": { verbs: R("yes|right|correct|confirm|remember|true|exactly|that's|keep|no|wrong|forget|not"), target: "none" },
  "conversation.forget_source": { verbs: R("forget|delete|erase|remove|scrub|wipe|strike"), target: "none" },
  "command.undo": { verbs: R("undo|revert|reverse|take that back|take it back|cancel that|didn't mean|did not mean|mistake|wrong|not what"), target: "none" },
  // feedback.record stores the owner's verified sentence itself; nothing a model wrote is kept.
};

const STOP = new Set("the a an and or of in on at to for with from my your his her its our their this that these those it them they is are was were be been am i me we you he she not no yes do does did have has had will would can could should may might just very really also too so as by if then than but about into over under out up down new old one two pair".split(" "));
const DEICTIC = /\b(this|that|these|those|it|them|they|same|outfit|option|everything|all|both|pair|one|ones)\b/i;

const CATEGORY_WORDS: Record<string, string[]> = {
  shirt: ["shirt", "shirts", "oxford", "poplin"],
  tee: ["tee", "tees", "t-shirt", "tshirt"],
  knitwear: ["jumper", "sweater", "cardigan", "knit", "crewneck", "pullover"],
  trousers: ["trousers", "pants", "jeans", "chinos", "flannels", "cords", "slacks"],
  outerwear: ["coat", "jacket", "blazer", "overcoat", "parka", "mac"],
  footwear: ["shoes", "shoe", "sneakers", "trainers", "boots", "loafers"],
  socks: ["socks", "sock"],
  belt: ["belt", "belts"],
  tie: ["tie", "ties"],
  scarf: ["scarf", "scarves"],
  pocket_square: ["pocket", "square"],
};

export function contentTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .map((t) => t.replace(/^'+|'+$/g, "").replace(/'s$/, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

const singular = (t: string) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

/** Two words name the same thing: equal, plural/singular, or one is a model-number prefix of the other ("990s" and "990v4"). */
function sameWord(a: string, b: string): boolean {
  const x = singular(a);
  const y = singular(b);
  if (x === y) return true;
  if (x.length < 3 || y.length < 3) return false;
  return /\d/.test(x + y) && (x.startsWith(y) || y.startsWith(x));
}

export interface IntentInput {
  db: Db;
  userId: string;
  type: string;
  level: "routine" | "sensitive" | "lift_restriction";
  /** The owner's sentence that contained the verified quote. */
  sentence: string;
  /** Owner text of this turn (and of the request a clarification answers). */
  ownerTexts: string[];
  payload: Record<string, unknown>;
  targets: string[];
  /** Identities the owner attached to the message (resolved by trusted code). */
  attachedRefs: string[];
}

export type IntentCheck = { ok: true } | { ok: false; code: "not_what_the_owner_asked" | "target_not_named" | "not_the_owners_words"; message: string };

async function garmentWords(db: Db, userId: string, ids: string[]): Promise<Map<string, { name: string; words: string[] }>> {
  const out = new Map<string, { name: string; words: string[] }>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = await all<{ garment_id: string; name: string; category: string; maker: string | null; product: string | null; fabric: string | null; colour: string | null; pattern: string | null }>(db, `SELECT garment_id, name, category, maker, product, fabric, colour, pattern FROM garments WHERE user_id = ? AND garment_id IN (${marks})`, userId, ...ids);
  const aliases = await all<{ garment_id: string; phrase: string }>(db, `SELECT garment_id, phrase FROM garment_aliases WHERE user_id = ? AND garment_id IN (${marks})`, userId, ...ids);
  for (const r of rows) {
    const text = [r.name, r.maker, r.product, r.fabric, r.colour, r.pattern, ...aliases.filter((a) => a.garment_id === r.garment_id).map((a) => a.phrase)].filter(Boolean).join(" ");
    out.set(r.garment_id, { name: r.name, words: [...new Set([...contentTokens(text), ...(CATEGORY_WORDS[r.category] ?? [r.category])])] });
  }
  return out;
}

export async function verifyIntent(input: IntentInput): Promise<IntentCheck> {
  const rule = INTENT_RULES[input.type];
  if (!rule) return { ok: true };
  const sentence = input.sentence.normalize("NFKC").replace(/[\u2018\u2019]/g, "'");
  if (!rule.verbs.test(sentence)) {
    return { ok: false, code: "not_what_the_owner_asked", message: "the owner's sentence does not ask for this. Do only what the owner asked; if you are unsure, ask them to say it plainly" };
  }
  const authored = input.ownerTexts.map(ownerAuthoredText).join("\n");
  const said = contentTokens(authored);
  const has = (word: string) => said.some((s) => sameWord(s, word));

  if (rule.target === "garments") {
    const ids = [...new Set([...input.targets, ...Object.values(input.payload).flatMap((v) => (Array.isArray(v) ? v : [v]))].filter((v): v is string => typeof v === "string" && v.startsWith("gmt_")))];
    const known = await garmentWords(input.db, input.userId, ids);
    const attached = new Set(input.attachedRefs.map((r) => r.replace(/^garment:/, "")));
    const referred = input.level === "routine" && DEICTIC.test(sentence);
    for (const id of ids) {
      const g = known.get(id);
      if (!g) continue; // an unknown ID is refused by the command itself
      if (attached.has(id) || g.words.some(has) || referred) continue;
      return { ok: false, code: "target_not_named", message: `the owner did not name "${g.name}". Act only on the pieces the owner named or attached; ask which one they mean` };
    }
    return { ok: true };
  }
  if (rule.target === "new_garment") {
    const category = String(input.payload["category"] ?? "");
    const words = [...contentTokens([input.payload["name"], input.payload["maker"], input.payload["colour"], input.payload["fabric"]].filter((v) => typeof v === "string").join(" ")), ...(CATEGORY_WORDS[category] ?? [])];
    const nameWords = contentTokens(String(input.payload["name"] ?? ""));
    const named = nameWords.filter(has).length;
    // The owner must have described the piece: at least half of the record's name is in their words.
    if (words.some(has) && nameWords.length > 0 && named / nameWords.length >= 0.5) return { ok: true };
    return { ok: false, code: "target_not_named", message: "the owner did not describe this piece. A record is created only for a piece the owner says they own or bought, named in their words" };
  }
  if (rule.target === "owner_text") {
    const words = contentTokens(String(input.payload[rule.field ?? "text"] ?? ""));
    const found = words.filter(has).length;
    if (words.length > 0 && found / words.length >= 0.7) return { ok: true };
    return { ok: false, code: "not_the_owners_words", message: "this text is not what the owner said. Record the owner's statement in the owner's own words, or ask them to state it" };
  }
  if (rule.target === "number") {
    const value = Number(input.payload[rule.field ?? "value"]);
    const numbers = [...authored.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")));
    if (Number.isFinite(value) && numbers.some((n) => Math.abs(n - value) < 0.001)) return { ok: true };
    return { ok: false, code: "not_the_owners_words", message: "the owner did not state that number" };
  }
  return { ok: true };
}
