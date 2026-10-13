/**
 * Explicit allow-list of owner sentence forms that apply a `direction` at once without a confirmation tap.
 *
 * Owner decision (`dec_2530e5cc000e6ef0` / `dec_q84451128ec13537`):
 *   - Apply at once ONLY for a short, explicit allow-list of fully understood single-sentence forms in the
 *     owner's own voice (quotations, pastes, forwarded mail, attachments and relayed speech stripped by
 *     `policy/voice.ts`).
 *   - Every other phrasing or command type returns `{ ok: false }` and becomes a one-tap proposal that the
 *     signed-in owner confirms in the app, still with a receipt and undo.
 *   - Wear/wash observations (`policy/report.ts`) and restriction lifts (`policy/ended.ts`) have their own
 *     dedicated gates.
 */
import { normalizeText, ownerAuthoredText, sentencesOf, isAboutSomeoneElse } from "./voice.ts";
import { CATEGORY_WORDS, NAMING_STOP, namedInText, sameToken, tokensOf, type GarmentWords } from "./naming.ts";

/** What trusted code read about the existing record a change refers to (tools/runtime.ts loads it). */
export interface RecordContext {
  /** The piece the record is about (a return case's piece), when it has one. */
  garmentId?: string | null;
  /** The pieces a project holds, for a project event that names none. */
  garmentIds?: string[];
  /** Words that name the record: a reminder's title, an order's merchant and number, a remembered fact's text, an earlier change's receipt. */
  words: string[];
  /** For an undo: the target is the owner's most recent change, so "undo that" refers to it. */
  mostRecent?: boolean;
}

export interface IntentInput {
  /** The owner's own texts that may stand behind a change in this turn (TurnRuntime.ownerTexts). */
  ownerTexts: string[];
  wardrobe: GarmentWords[];
  /** Pieces the owner attached in the app, or tapped as the answer to the assistant's question. */
  pointedAt: string[];
  /** The owner's local date of this turn (YYYY-MM-DD). */
  localDate?: string;
  /** The existing record a change refers to, as trusted code read it; absent = none was found. */
  record?: RecordContext | null;
  /** The owner's IANA time zone. */
  timezone?: string;
}

export type IntentResult = { ok: true; sentence: string } | { ok: false };

const NO: IntentResult = { ok: false };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Play, sarcasm, retraction, lying or roleplay anywhere in the owner's texts disqualifies the whole turn. */
const PLAY_OR_RETRACTED =
  /\b(?:let's\s+play|play\s+a\s+game|pretend|imagine|suppose|hypothetical\w*|role\s*play|just\s+kidding|only\s+kidding|kidding|only\s+joking|joking|joked|was\s+a\s+joke|that's\s+a\s+joke|a\s+joke|was\s+a\s+lie|that's\s+a\s+lie|a\s+lie|lying|lied|untrue|false|made\s+that\s+up|making\s+that\s+up|said\s+no\s*body|said\s+no\s+one|as\s+if|yeah\s+right|not\s+really|actually\s+no|wait\s+no|scratch\s+that|take\s+that\s+back|disregard|cancel\s+that|never\s+mind|ignore\s+that)\b/i;

const QUESTION_START =
  /^(?:what|which|who|whom|whose|when|where|why|how|should|shall|do|does|did|is|are|am|was|were|may|might|have|has|had|can|could|would|will)\b/;

const NEGATION =
  /\b(?:not|never|no|none|nothing|neither|nor|without|hardly|barely|scarcely|doesn't|don't|dont|didn't|isn't|aren't|wasn't|weren't|won't|wouldn't|can't|cannot|couldn't|shouldn't|haven't|hasn't|hadn't)\b|n't\b/;

const DOUBT_OR_MODAL =
  /\b(?:if|unless|whether|maybe|perhaps|possibly|probably|might|may|could|would|should|wish|hope|hoping|want|wanted|try|tried|trying|fail|failed|attempt\w*|nearly|almost|doubt\w*|unsure|uncertain|wonder\w*|think\w*|thought|suppose|imagine|pretend|someday|tomorrow|next\s+(?:week|month|year)|going\s+to|gonna|plan(?:ning)?\s+to|intend(?:ing)?\s+to)\b|\b(?:i|we)'(?:ll|d)\b/;

/** Clause or conjunction boundary words forbidden inside a single-entity capture slot. */
const SLOT_BOUNDARY =
  /\b(?:and|or|but|if|when|while|because|since|although|though|unless|until|except|without|instead|rather)\b/;

interface CleanSentence {
  raw: string;
  text: string;
}

function cleanSentences(ownerTexts: string[]): CleanSentence[] {
  const nonEmptyTexts = ownerTexts.map((raw) => ownerAuthoredText(raw)).filter((t) => t.trim().length > 0);
  // Across ownerTexts, auto-apply requires a single owner-authored text entry: if there are multiple entries,
  // a second entry can correct, retract, or conflict with the first, so the change becomes a one-tap proposal.
  if (nonEmptyTexts.length !== 1) return [];
  const authored = nonEmptyTexts[0]!;
  if (PLAY_OR_RETRACTED.test(authored)) return [];
  const allParts: CleanSentence[] = [];
  for (const part of sentencesOf(authored)) {
    if (part.includes("?")) return [];
    const text = normalizeText(part)
      .replace(/["«»]/g, " ")
      .replace(/[.!]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (PLAY_OR_RETRACTED.test(text) || QUESTION_START.test(text) || isAboutSomeoneElse(text) || DOUBT_OR_MODAL.test(text)) {
      return [];
    }
    allParts.push({ raw: part.trim(), text });
  }
  // Single-sentence forms only: multi-sentence messages route to a one-tap proposal.
  if (allParts.length !== 1) return [];
  return allParts;
}

function normWords(s: string): string {
  return tokensOf(s).join(" ");
}

/** Normalize a phrase into lowercase space-separated words without stemming (preserves plural endings and collapses 't-shirt' to 'tshirt'). */
function rawWordsOf(s: string): string[] {
  return normalizeText(s)
    .replace(/\bt[\s-]+shirts\b/g, "tshirts")
    .replace(/\bt[\s-]+shirt\b/g, "tshirt")
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

function isNullish(v: unknown): boolean {
  return v === null || v === undefined;
}

/**
 * True iff `phrase` unambiguously resolves to `garmentId` alone in the owner's wardrobe (`namedInText`
 * returns a set of size 1 containing `garmentId`), with no conjunctions, negations, prepositions or
 * unexplained words outside that garment's own words, aliases and category nouns.
 */
const PHRASE_QUALIFIER =
  /\b(?:in|on|at|with|from|to|for|by|during|before|after|since|until|under|over|into|out|yesterday|today|tonight|earlier|already|ago|last|this\s+(?:morning|afternoon|evening|week|month|year)|dream|parallel|universe)\b/i;

function soleNamedPiece(wardrobe: GarmentWords[], phrase: string, garmentId: unknown): boolean {
  if (typeof garmentId !== "string" || !garmentId) return false;
  if (NEGATION.test(phrase) || DOUBT_OR_MODAL.test(phrase) || SLOT_BOUNDARY.test(phrase) || PHRASE_QUALIFIER.test(phrase)) {
    return false;
  }
  const hits = namedInText(wardrobe, phrase);
  if (hits.size !== 1 || !hits.has(garmentId)) return false;
  const g = wardrobe.find((w) => w.garmentId === garmentId);
  if (!g) return false;
  const ownCategoryWords = new Set<string>(
    (Object.hasOwn(CATEGORY_WORDS, g.category) ? (CATEGORY_WORDS[g.category] ?? []) : []).flatMap((w) => [w, ...tokensOf(w)]),
  );
  const allowedWords = new Set<string>([...g.words]);
  for (const alias of g.aliases) {
    for (const t of tokensOf(alias)) {
      if (!NAMING_STOP.has(t)) allowedWords.add(t);
    }
  }
  for (const token of tokensOf(phrase)) {
    if (NAMING_STOP.has(token) || ownCategoryWords.has(token)) continue;
    if ([...allowedWords].some((w) => sameToken(token, w))) continue;
    return false;
  }
  return true;
}

/**
 * Closed map of head nouns for `garment.create`. Countable single-item nouns are singular only; pluralia
 * tantum / pair nouns that denote one wardrobe record (`trousers`, `jeans`, `chinos`, `flannels`, `pants`,
 * `slacks`, `corduroys`, `shorts`, `socks`, `gloves`) are included in their natural form. Plural countable
 * nouns (`shirts`, `jumpers`, `coats`, `boots`, `shoes`, etc.) are excluded so a plural request becomes a
 * proposal.
 */
const GARMENT_NOUN_CATEGORY: Record<string, { category: string; roles: readonly string[]; careChannel: string }> = {
  shirt: { category: "shirt", roles: ["top"], careChannel: "service" },
  oxford: { category: "shirt", roles: ["top"], careChannel: "service" },
  overshirt: { category: "shirt", roles: ["top"], careChannel: "service" },
  polo: { category: "shirt", roles: ["top"], careChannel: "service" },
  flannel: { category: "shirt", roles: ["top"], careChannel: "service" },
  chambray: { category: "shirt", roles: ["top"], careChannel: "service" },
  poplin: { category: "shirt", roles: ["top"], careChannel: "service" },
  tee: { category: "tee", roles: ["top"], careChannel: "service" },
  tshirt: { category: "tee", roles: ["top"], careChannel: "service" },
  henley: { category: "tee", roles: ["top"], careChannel: "service" },
  jumper: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  sweater: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  cardigan: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  knit: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  crewneck: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  rollneck: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  turtleneck: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  pullover: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  waistcoat: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  vest: { category: "knitwear", roles: ["mid_layer"], careChannel: "handwash" },
  trousers: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  trouser: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  jeans: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  chinos: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  chino: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  flannels: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  pants: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  slacks: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  corduroys: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  shorts: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  coat: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  jacket: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  blazer: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  peacoat: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  overcoat: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  parka: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  mac: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  raincoat: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  trench: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  anorak: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  gilet: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  boot: { category: "footwear", roles: ["footwear"], careChannel: "none" },
  shoe: { category: "footwear", roles: ["footwear"], careChannel: "none" },
  loafer: { category: "footwear", roles: ["footwear"], careChannel: "none" },
  sneaker: { category: "footwear", roles: ["footwear"], careChannel: "none" },
  trainer: { category: "footwear", roles: ["footwear"], careChannel: "none" },
  derby: { category: "footwear", roles: ["footwear"], careChannel: "none" },
  brogue: { category: "footwear", roles: ["footwear"], careChannel: "none" },
  socks: { category: "socks", roles: ["socks"], careChannel: "handwash" },
  sock: { category: "socks", roles: ["socks"], careChannel: "handwash" },
  belt: { category: "belt", roles: ["belt"], careChannel: "none" },
  tie: { category: "tie", roles: ["neckwear"], careChannel: "none" },
  necktie: { category: "tie", roles: ["neckwear"], careChannel: "none" },
  scarf: { category: "scarf", roles: ["neckwear"], careChannel: "none" },
  suit: { category: "one_piece", roles: ["one_piece"], careChannel: "service" },
  hat: { category: "accessory", roles: ["accessory"], careChannel: "none" },
  cap: { category: "accessory", roles: ["accessory"], careChannel: "none" },
  beanie: { category: "accessory", roles: ["accessory"], careChannel: "none" },
  gloves: { category: "accessory", roles: ["accessory"], careChannel: "none" },
  watch: { category: "accessory", roles: ["accessory"], careChannel: "none" },
  umbrella: { category: "accessory", roles: ["accessory"], careChannel: "none" },
  bag: { category: "accessory", roles: ["accessory"], careChannel: "none" },
  tote: { category: "accessory", roles: ["accessory"], careChannel: "none" },
};

/**
 * Every number word, quantifier or preposition forbidden inside `garment.create`'s captured name, checked
 * on the raw unstemmed words so any count ("two", "thirteen", "twenty-four", "hundred", "thousand") or
 * multi-item quantifier ("both", "several", "pair", "pairs", "dozen") routes to a proposal.
 */
const FORBIDDEN_CAPTURE_WORDS: ReadonlySet<string> = new Set([
  "from", "in", "on", "at", "with", "for", "by", "to", "of",
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "hundreds", "thousand", "thousands", "million", "millions", "billion", "billions", "trillion", "trillions",
  "both", "several", "multiple", "many", "couple", "few", "pair", "pairs", "dozen", "dozens", "score",
  "single", "double", "triple", "half", "quarter",
]);

/* ------------------------------------------------------------------ */
/* The 8 explicit allow-listed sentence forms                          */
/* ------------------------------------------------------------------ */

function canonicalMeasureKey(word: string): string {
  if (word === "hips") return "hip";
  if (word === "shoulders") return "shoulder";
  return word;
}

const FORM_ADD_GARMENT =
  /^(?:please\s+)?add\s+my\s+(?:new\s+)?([a-z0-9][a-z0-9' -]{1,60}?)(?:\s+to\s+(?:the|my)\s+wardrobe)?$/;
const GARMENT_CREATE_KEYS = [
  "name",
  "category",
  "roles",
  "careChannel",
  "colour",
  "fabric",
  "maker",
  "size",
  "acquisition",
  "quantity",
  "source",
  "pattern",
  "notes",
  "condition",
] as const;

/** Closed set of normalized colour names (single-token and multi-token with hyphen/space normalized to space). */
const KNOWN_COLOURS: ReadonlySet<string> = new Set([
  "black",
  "white",
  "Off White".toLowerCase(),
  "grey",
  "gray",
  "light grey",
  "light gray",
  "dark grey",
  "dark gray",
  "charcoal",
  "slate",
  "silver",
  "navy",
  "blue",
  "light blue",
  "dark blue",
  "sky blue",
  "pale blue",
  "indigo",
  "cobalt",
  "teal",
  "cream",
  "ivory",
  "ecru",
  "beige",
  "stone",
  "oatmeal",
  "sand",
  "camel",
  "tan",
  "khaki",
  "taupe",
  "brown",
  "light brown",
  "dark brown",
  "chocolate",
  "chestnut",
  "cognac",
  "tobacco",
  "rust",
  "terracotta",
  "orange",
  "amber",
  "mustard",
  "yellow",
  "gold",
  "olive",
  "olive green",
  "green",
  "light green",
  "dark green",
  "forest",
  "forest green",
  "bottle green",
  "sage",
  "sage green",
  "emerald",
  "moss",
  "loden",
  "red",
  "burgundy",
  "maroon",
  "wine",
  "crimson",
  "scarlet",
  "oxblood",
  "claret",
  "pink",
  "rose",
  "coral",
  "salmon",
  "purple",
  "plum",
  "violet",
  "lavender",
  "lilac",
]);

const FORM_RETIRE_SOLD =
  /^i\s+sold\s+(?:the|that|my)\s+([a-z0-9][a-z0-9' \u2014-]{1,80}?)(?:\s+on\s+ebay)?$/;
const FORM_RETIRE_DONATED =
  /^i\s+(?:gave\s+(?:the|that|my)\s+([a-z0-9][a-z0-9' \u2014-]{1,80}?)(?:\s+away)?\s+to\s+a\s+charity\s+shop|donated\s+(?:the|that|my)\s+([a-z0-9][a-z0-9' \u2014-]{1,80}?)\s+to\s+a\s+charity\s+shop)$/;
const GARMENT_RETIRE_KEYS = ["garmentId", "disposition", "quantity", "note"] as const;

const FORM_MOVE_STORAGE =
  /^(?:please\s+)?put\s+the\s+([a-z0-9][a-z0-9' \u2014-]{1,80}?)\s+(?:away\s+)?in\s+storage(?:\s+for\s+the\s+(?:summer|winter))?$/;
const FORM_MOVE_TAILOR =
  /^the\s+([a-z0-9][a-z0-9' \u2014-]{1,80}?)\s+(?:is|are)\s+at\s+the\s+tailor$/;
const GARMENT_MOVE_KEYS = ["garmentId", "to", "from", "quantity", "expectedReturn", "note"] as const;

const FORM_ARRIVAL =
  /^the\s+([a-z0-9][a-z0-9' \u2014-]{1,80}?)\s+(?:has\s+)?arrived(?:\s+today)?$/;
const REPORT_ARRIVAL_KEYS = ["garmentId", "deliveredOn"] as const;

const FORM_ADD_ALIAS =
  /^(?:please\s+)?call\s+the\s+([a-z0-9][a-z0-9' \u2014-]{1,80}?)\s+the\s+([a-z0-9][a-z0-9' -]{1,40})$/;
const ADD_ALIAS_KEYS = ["garmentId", "phrase", "kind"] as const;

const FORM_MEASUREMENT =
  /^my\s+(chest|waist|neck|hips?|inseam|thigh|shoulders?|sleeve)\s+(?:is|measures)\s+(\d{1,3}(?:\.\d{1,2})?)\s+(inches|inch|in|cm|centimetres|centimeters)$/;
const MEASUREMENT_KEYS = ["subject", "key", "value", "unit", "convention", "measuredOn", "garmentId", "source", "notes"] as const;
const LINEAR_MEASUREMENT_KEYS: ReadonlySet<string> = new Set(["inseam", "shoulder", "sleeve"]);

const FORM_DIRECTION =
  /^(?:please\s+)?(?:add\s+rule:\s+|rule:\s+)?(never\s+put\s+me\s+in\s+[a-z0-9' -]{2,60}|do\s+not\s+make\s+[a-z0-9' -]{2,60}|always\s+prefer\s+[a-z0-9' -]{2,60})$/;
const DIRECTION_KEYS = ["text", "scope", "source"] as const;
const DIRECTION_FORBIDDEN_WORDS = /\b(?:ignore|bypass|override|restriction|restrictions|healed|welted|sneakers|paraboot|clifford)\b/;

const FORM_UNDO = /^(?:please\s+)?undo\s+that$/;
const UNDO_KEYS = ["commandId", "reason"] as const;

function matchesForm(type: string, payload: Record<string, unknown>, s: CleanSentence, input: IntentInput): boolean {
  if (DOUBT_OR_MODAL.test(s.text)) return false;

  switch (type) {
    case "garment.create": {
      if (NEGATION.test(s.text)) return false;
      if (!hasOnlyKeys(payload, GARMENT_CREATE_KEYS)) return false;
      if (payload["acquisition"] !== "owned") return false;
      if (payload["quantity"] !== undefined && payload["quantity"] !== 1) return false;
      if (!isNullish(payload["fabric"]) || !isNullish(payload["maker"]) || !isNullish(payload["size"])) return false;
      if (!isNullish(payload["pattern"]) || !isNullish(payload["notes"]) || !isNullish(payload["condition"])) return false;
      const m = FORM_ADD_GARMENT.exec(s.text);
      if (!m) return false;
      const captured = m[1]!.trim();
      const rawWords = rawWordsOf(captured);
      if (
        rawWords.length === 0 ||
        NEGATION.test(captured) ||
        SLOT_BOUNDARY.test(captured) ||
        rawWords.some((w) => /\d/.test(w) || FORBIDDEN_CAPTURE_WORDS.has(w))
      ) {
        return false;
      }
      const name = typeof payload["name"] === "string" ? payload["name"] : "";
      const rawNameWords = rawWordsOf(name);
      if (rawNameWords.length !== rawWords.length || rawNameWords.join(" ") !== rawWords.join(" ")) return false;
      // Check the head noun on the raw, unstemmed words so plural countable nouns ("shirts", "jumpers", "boots")
      // never match a singular category entry through token stemming.
      const isPocketSquare = rawWords.slice(-2).join(" ") === "pocket square";
      const headTokenCount = isPocketSquare ? 2 : 1;
      const headNoun = rawWords.at(-1) ?? "";
      const spec = isPocketSquare
        ? { category: "pocket_square", roles: ["accessory"] as const, careChannel: "none" }
        : Object.hasOwn(GARMENT_NOUN_CATEGORY, headNoun)
          ? GARMENT_NOUN_CATEGORY[headNoun]
          : undefined;
      if (!spec || payload["category"] !== spec.category) return false;
      if (
        payload["roles"] !== undefined &&
        (!Array.isArray(payload["roles"]) ||
          payload["roles"].length !== spec.roles.length ||
          payload["roles"].some((r, i) => r !== spec.roles[i]))
      ) {
        return false;
      }
      if (payload["careChannel"] !== undefined && payload["careChannel"] !== spec.careChannel) return false;
      if (!isNullish(payload["colour"])) {
        if (typeof payload["colour"] !== "string") return false;
        const colourWords = rawWordsOf(payload["colour"]);
        const colourPhrase = colourWords.join(" ");
        const prefixWords = rawWords.slice(0, rawWords.length - headTokenCount);
        if (
          colourWords.length === 0 ||
          !KNOWN_COLOURS.has(colourPhrase) ||
          prefixWords.length < colourWords.length ||
          prefixWords.slice(0, colourWords.length).join(" ") !== colourPhrase
        ) {
          return false;
        }
      }
      return true;
    }

    case "garment.retire": {
      if (NEGATION.test(s.text)) return false;
      if (!hasOnlyKeys(payload, GARMENT_RETIRE_KEYS)) return false;
      if (payload["quantity"] !== undefined && payload["quantity"] !== null && payload["quantity"] !== 1) return false;
      if (!isNullish(payload["note"])) return false;
      const disp = payload["disposition"];
      if (disp === "sold") {
        const m = FORM_RETIRE_SOLD.exec(s.text);
        return Boolean(m && soleNamedPiece(input.wardrobe, m[1]!, payload["garmentId"]));
      }
      if (disp === "donated") {
        const m = FORM_RETIRE_DONATED.exec(s.text);
        const phrase = m ? (m[1] ?? m[2] ?? "") : "";
        return Boolean(m && soleNamedPiece(input.wardrobe, phrase, payload["garmentId"]));
      }
      return false;
    }

    case "garment.move": {
      if (NEGATION.test(s.text)) return false;
      if (!hasOnlyKeys(payload, GARMENT_MOVE_KEYS)) return false;
      if (!isNullish(payload["from"]) || !isNullish(payload["expectedReturn"]) || !isNullish(payload["note"])) return false;
      if (payload["quantity"] !== undefined && payload["quantity"] !== null && payload["quantity"] !== 1) return false;
      const to = payload["to"];
      if (to === "storage") {
        const m = FORM_MOVE_STORAGE.exec(s.text);
        return Boolean(m && soleNamedPiece(input.wardrobe, m[1]!, payload["garmentId"]));
      }
      if (to === "tailor") {
        const m = FORM_MOVE_TAILOR.exec(s.text);
        return Boolean(m && soleNamedPiece(input.wardrobe, m[1]!, payload["garmentId"]));
      }
      return false;
    }

    case "assistant.report_arrival": {
      if (NEGATION.test(s.text)) return false;
      if (!hasOnlyKeys(payload, REPORT_ARRIVAL_KEYS)) return false;
      const deliveredOn = payload["deliveredOn"];
      if (!isNullish(deliveredOn) && (!input.localDate || deliveredOn !== input.localDate)) return false;
      const m = FORM_ARRIVAL.exec(s.text);
      return Boolean(m && soleNamedPiece(input.wardrobe, m[1]!, payload["garmentId"]));
    }

    case "garment.add_alias": {
      if (NEGATION.test(s.text)) return false;
      if (!hasOnlyKeys(payload, ADD_ALIAS_KEYS)) return false;
      const kind = payload["kind"];
      if (kind !== undefined && kind !== "owner_name" && kind !== "alias") return false;
      const m = FORM_ADD_ALIAS.exec(s.text);
      if (!m) return false;
      const [, piecePhrase, aliasPhrase] = m;
      if (!soleNamedPiece(input.wardrobe, piecePhrase!, payload["garmentId"])) return false;
      if (NEGATION.test(aliasPhrase!) || SLOT_BOUNDARY.test(aliasPhrase!)) return false;
      const phrase = typeof payload["phrase"] === "string" ? rawWordsOf(payload["phrase"]).join(" ") : "";
      const wanted = rawWordsOf(aliasPhrase!).join(" ");
      return Boolean(phrase && wanted && (phrase === wanted || phrase === `the ${wanted}`));
    }

    case "measurement.record": {
      if (NEGATION.test(s.text)) return false;
      if (!hasOnlyKeys(payload, MEASUREMENT_KEYS)) return false;
      if (payload["subject"] !== "body") return false;
      if (!isNullish(payload["garmentId"]) || !isNullish(payload["notes"])) return false;
      const measuredOn = payload["measuredOn"];
      if (!isNullish(measuredOn) && (!input.localDate || measuredOn !== input.localDate)) return false;
      const m = FORM_MEASUREMENT.exec(s.text);
      if (!m) return false;
      const [, rawKey, rawVal, rawUnit] = m;
      const expectedKey = canonicalMeasureKey(rawKey!);
      const expectedConvention = LINEAR_MEASUREMENT_KEYS.has(expectedKey) ? "body length" : "body circumference";
      if (!isNullish(payload["convention"]) && payload["convention"] !== expectedConvention) return false;
      const expectedVal = Number(rawVal);
      const expectedUnit = rawUnit!.startsWith("c") ? "cm" : "in";
      return payload["key"] === expectedKey && payload["value"] === expectedVal && payload["unit"] === expectedUnit;
    }

    case "style.add_direction": {
      if (!hasOnlyKeys(payload, DIRECTION_KEYS)) return false;
      if (!isNullish(payload["scope"])) return false;
      const m = FORM_DIRECTION.exec(s.text);
      if (!m) return false;
      const rule = m[1]!.trim();
      if (DIRECTION_FORBIDDEN_WORDS.test(rule) || SLOT_BOUNDARY.test(rule)) return false;
      // Only the leading "never put me in ..." or "do not make ..." may contain a negation word;
      // the remainder of the rule must not contain a second negation.
      const remainder = rule.replace(/^(?:never\s+put\s+me\s+in|do\s+not\s+make|always\s+prefer)\s+/, "");
      if (NEGATION.test(remainder)) return false;
      const text = typeof payload["text"] === "string" ? rawWordsOf(payload["text"]).join(" ") : "";
      const wantedRule = rawWordsOf(rule).join(" ");
      return Boolean(text && wantedRule && text === wantedRule);
    }

    case "command.undo": {
      if (NEGATION.test(s.text)) return false;
      if (!hasOnlyKeys(payload, UNDO_KEYS)) return false;
      if (!isNullish(payload["reason"])) return false;
      if (typeof payload["commandId"] !== "string" || !payload["commandId"]) return false;
      if (input.record?.mostRecent !== true) return false;
      return FORM_UNDO.test(s.text);
    }

    default:
      return false;
  }
}

/** Whether the owner's own words of this turn match an explicit allow-listed form for this change. */
export function ownerRequests(type: string, payload: Record<string, unknown>, input: IntentInput): IntentResult {
  if (!isPlainObject(payload)) return NO;
  const sentences = cleanSentences(input.ownerTexts);
  if (sentences.length === 0) return NO;
  for (const s of sentences) {
    if (matchesForm(type, payload, s, input)) return { ok: true, sentence: s.raw };
  }
  return NO;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

/** The numbers said in a clause, digits or words ("forty-two", "26 and a half", "1,250"). */
export function numbersIn(clause: string): number[] {
  const s = normalizeText(clause).replace(/(\d),(\d{3})\b/g, "$1$2").replace(/-/g, " ");
  const out: number[] = [];
  const tokens = [...s.matchAll(/(\d+(?:\.\d+)?)|([a-z]+)/g)].map((m) => m[0]);
  for (let i = 0; i < tokens.length; i++) {
    let value: number | null = null;
    let j = i;
    if (/^\d/.test(tokens[i]!)) value = Number(tokens[i]);
    else if (Object.hasOwn(NUMBER_WORDS, tokens[i]!)) {
      value = NUMBER_WORDS[tokens[i]!]!;
      if (value >= 20 && value % 10 === 0 && tokens[i + 1] && Object.hasOwn(NUMBER_WORDS, tokens[i + 1]!) && NUMBER_WORDS[tokens[i + 1]!]! < 10) {
        value += NUMBER_WORDS[tokens[++j]!]!;
      }
    }
    if (value === null) continue;
    if (tokens[j + 1] === "and" && tokens[j + 2] === "a" && tokens[j + 3] === "half") {
      value += 0.5;
      j += 3;
    }
    out.push(value);
    i = j;
  }
  return out;
}
