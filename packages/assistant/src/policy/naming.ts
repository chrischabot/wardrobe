/**
 * Which garments a clause of the owner's own words NAMES.
 *
 * "Named" is decided here, in trusted code, from the wardrobe records: the clause must contain the
 * garment's alias, or enough of the words of its record to single it out. A referring word ("it", "that",
 * "the usual") names nothing, and neither does a category ("my shirts").
 *
 * Naming alone records nothing: policy/report.ts decides whether the clause is the owner's own wear or
 * wash report at all. It is never authority for a sensitive change.
 */
import { all, type Db } from "@garderobe/domain";
import { normalizeText } from "./voice.ts";

const STOP = new Set(
  "the a an and or of in on at to for with from my your his her its our their this that these those it them they is are was were be been am i me we you he she not no yes do does did have has had will would can could should may might just very really also too so as by if then than but about into over under out up down new old one two pair pairs size uk us eu mens men all some any got get put had today yesterday morning evening night again still wore wear wearing worn washed wash clean dirty".split(
    " ",
  ),
);

/** Category nouns: they say what kind of thing, never which one. */
export const CATEGORY_WORDS: Record<string, string[]> = {
  shirt: ["shirt", "oxford", "poplin", "buttondown"],
  tee: ["tee", "tshirt", "t-shirt"],
  knitwear: ["jumper", "sweater", "cardigan", "knit", "knitwear", "crewneck", "pullover", "rollneck"],
  trousers: ["trouser", "pant", "jean", "chino", "flannel", "cord", "slack", "fatigue", "denim"],
  outerwear: ["coat", "jacket", "blazer", "overcoat", "parka", "mac"],
  footwear: ["shoe", "sneaker", "trainer", "boot", "loafer"],
  socks: ["sock"],
  belt: ["belt"],
  tie: ["tie"],
  scarf: ["scarf", "scarve"],
  pocket_square: ["square"],
};
const ALL_CATEGORY_WORDS = new Set(Object.values(CATEGORY_WORDS).flat());

function stem(token: string): string {
  if (/^\d+s$/.test(token)) return token.slice(0, -1); // "990s"
  if (token.length > 3 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokensOf(text: string): string[] {
  return normalizeText(text)
    .replace(/'s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .map(stem);
}

function sameToken(ownerToken: string, garmentToken: string): boolean {
  if (ownerToken === garmentToken) return true;
  // A model number said short: "990" for "990v4".
  if (/\d/.test(ownerToken) && ownerToken.length >= 3 && garmentToken.startsWith(ownerToken)) return true;
  return false;
}

export interface GarmentWords {
  garmentId: string;
  name: string;
  category: string;
  careChannel: string;
  words: Set<string>;
  aliases: string[];
}

/**
 * The garments named in one clause of the owner's own voice, with the words that named each. A garment is
 * named by its alias as a phrase, by two or more words of its record of which at least one is not a
 * category noun, or by one word that at most three records share - within one noun phrase. Two further
 * checks keep a word from naming the wrong piece: when the phrase says what kind of thing it is ("the pink
 * socks"), a piece of another kind is not named by its colour alone; and a record whose matched words are
 * a strict subset of another's is not the one meant.
 */
export function namedInText(wardrobe: GarmentWords[], clause: string): Map<string, string[]> {
  const norm = ` ${normalizeText(clause).replace(/[^\p{L}\p{N}']+/gu, " ")} `;
  const frequency = new Map<string, number>();
  for (const g of wardrobe) for (const w of g.words) frequency.set(w, (frequency.get(w) ?? 0) + 1);
  // One piece is named within one noun phrase: "the Stratton cords and the olive belt" is two.
  const phrases = normalizeText(clause)
    .split(/[,;:()]|\s-\s|\b(?:and|with|over|under|plus|then)\b/)
    .map((part) => tokensOf(part))
    .filter((tokens) => tokens.length > 0);
  const hits: { garmentId: string; by: "alias" | "words"; matched: string[] }[] = [];
  for (const g of wardrobe) {
    const alias = g.aliases.find((a) => a.length >= 3 && norm.includes(` ${a.replace(/[^\p{L}\p{N}']+/gu, " ").trim()} `));
    if (alias) {
      hits.push({ garmentId: g.garmentId, by: "alias", matched: [alias] });
      continue;
    }
    let best: string[] | null = null;
    for (const tokens of phrases) {
      const matched = [...g.words].filter((w) => tokens.some((t) => sameToken(t, w)));
      const specific = matched.filter((w) => !ALL_CATEGORY_WORDS.has(w));
      const distinctive = specific.some((w) => w.length >= 4 && (frequency.get(w) ?? 0) <= 3);
      if (!((matched.length >= 2 && specific.length >= 1) || distinctive)) continue;
      // "The pink socks" does not name the pink shirt: the phrase says a kind, and it is not this piece's.
      const said = Object.entries(CATEGORY_WORDS).filter(([, words]) => words.some((w) => tokens.includes(w))).map(([category]) => category);
      if (said.length > 0 && !said.includes(g.category) && !matched.some((w) => ALL_CATEGORY_WORDS.has(w))) continue;
      if (!best || matched.length > best.length) best = matched;
    }
    if (best) hits.push({ garmentId: g.garmentId, by: "words", matched: best });
  }
  const byWords = hits.filter((h) => h.by === "words");
  const out = new Map<string, string[]>();
  for (const h of hits) {
    const dominated = h.by === "words" && byWords.some((b) => b !== h && b.matched.length > h.matched.length && h.matched.every((w) => b.matched.includes(w)));
    if (!dominated) out.set(h.garmentId, h.matched);
  }
  return out;
}

export const loadWardrobeWords = (db: Db, userId: string): Promise<GarmentWords[]> => wardrobeWords(db, userId);

async function wardrobeWords(db: Db, userId: string): Promise<GarmentWords[]> {
  const rows = await all<{ garment_id: string; name: string; category: string; care_channel: string; maker: string | null; product: string | null; fabric: string | null; colour: string | null; pattern: string | null }>(
    db,
    "SELECT garment_id, name, category, care_channel, maker, product, fabric, colour, pattern FROM garments WHERE user_id = ? AND removed_reason IS NULL AND merged_into IS NULL",
    userId,
  );
  const aliases = await all<{ garment_id: string; normalized: string }>(db, "SELECT garment_id, normalized FROM garment_aliases WHERE user_id = ? AND removed_at IS NULL", userId);
  const byGarment = new Map<string, string[]>();
  for (const a of aliases) byGarment.set(a.garment_id, [...(byGarment.get(a.garment_id) ?? []), a.normalized]);
  return rows.map((g) => ({
    garmentId: g.garment_id,
    name: g.name,
    category: g.category,
    careChannel: g.care_channel,
    words: new Set(tokensOf([g.name, g.maker, g.product, g.fabric, g.colour, g.pattern].filter(Boolean).join(" ")).filter((t) => !STOP.has(t))),
    aliases: byGarment.get(g.garment_id) ?? [],
  }));
}
