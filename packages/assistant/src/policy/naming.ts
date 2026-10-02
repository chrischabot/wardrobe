/**
 * Which garments the owner NAMED in their own words.
 *
 * A wear or wash report is recorded without a confirmation only for garments the owner actually names in
 * the message (or attaches to it). "Named" is decided here, in trusted code, from the wardrobe records:
 * the owner's own voice (policy/voice.ts: attachments are never part of it, and pasted, quoted or relayed
 * passages are removed) must contain the garment's alias, or enough of the words of its record to
 * single it out. A referring word ("it", "that", "the usual") names nothing.
 *
 * This decides only whether an everyday report needs a tap. It is never authority for a sensitive change.
 */
import { all, type Db } from "@garderobe/domain";
import { isDirectReport, normalizeText, ownerAuthoredText, sentencesOf } from "./voice.ts";

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

interface GarmentWords {
  garmentId: string;
  name: string;
  category: string;
  careChannel: string;
  words: Set<string>;
  aliases: string[];
}

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

export interface NamedGarment {
  garmentId: string;
  /** How the owner named it: by its alias, or by these words of its record. */
  by: "alias" | "words";
  matched: string[];
  /** True when a sentence that names it reads as the owner's own direct report. */
  direct: boolean;
}

export interface OwnerNaming {
  /** Garments the owner singled out, by garment ID. */
  named: Map<string, NamedGarment>;
  /** Categories the owner named as a group in a direct report ("washed all my socks"). */
  categories: Set<string>;
  /** True when the owner spoke of hand washing as a group. */
  handwashGroup: boolean;
}

/**
 * Resolve what the owner named in `ownerText` (the owner's own text field of one message; never an
 * attachment). A garment is named when the owner's voice contains its alias as a phrase, two or more
 * words of its record of which at least one is not a category noun, or one word that at most three
 * records share ("Chasseur", "Peacoat").
 */
export async function resolveOwnerNaming(db: Db, userId: string, ownerText: string): Promise<OwnerNaming> {
  const authored = ownerAuthoredText(ownerText);
  const sentences = sentencesOf(authored).map((s) => ({ text: s, norm: ` ${normalizeText(s).replace(/[^\p{L}\p{N}']+/gu, " ")} `, tokens: tokensOf(s), direct: isDirectReport(s) }));
  const out: OwnerNaming = { named: new Map(), categories: new Set(), handwashGroup: false };
  if (sentences.length === 0) return out;
  const wardrobe = await wardrobeWords(db, userId);
  const frequency = new Map<string, number>();
  for (const g of wardrobe) for (const w of g.words) frequency.set(w, (frequency.get(w) ?? 0) + 1);

  for (const g of wardrobe) {
    let best: NamedGarment | null = null;
    for (const s of sentences) {
      let hit: NamedGarment | null = null;
      const alias = g.aliases.find((a) => a.length >= 3 && s.norm.includes(` ${a.replace(/[^\p{L}\p{N}']+/gu, " ").trim()} `));
      if (alias) hit = { garmentId: g.garmentId, by: "alias", matched: [alias], direct: s.direct };
      else {
        const matched = [...g.words].filter((w) => s.tokens.some((t) => sameToken(t, w)));
        const specific = matched.filter((w) => !ALL_CATEGORY_WORDS.has(w));
        const distinctive = specific.some((w) => w.length >= 4 && (frequency.get(w) ?? 0) <= 3);
        if ((matched.length >= 2 && specific.length >= 1) || distinctive) hit = { garmentId: g.garmentId, by: "words", matched, direct: s.direct };
      }
      if (hit && (!best || (hit.direct && !best.direct) || (hit.direct === best.direct && hit.matched.length > best.matched.length))) best = hit;
    }
    if (best) out.named.set(g.garmentId, best);
  }
  // "The camel field Games" names that record, not every record that happens to be camel: a record whose
  // matched words are a strict subset of another's is not the one meant.
  const byWords = [...out.named.values()].filter((n) => n.by === "words");
  for (const a of byWords) {
    const dominated = byWords.some((b) => b !== a && b.matched.length > a.matched.length && a.matched.every((w) => b.matched.includes(w)));
    if (dominated) out.named.delete(a.garmentId);
  }

  for (const s of sentences) {
    if (!s.direct) continue;
    // A category names a group only when the owner spoke of it as one ("my socks", "all the shirts").
    const group = (w: string) => new RegExp(`\\b(?:${w}s|${w}es|(?:all|every)\\b[^.]{0,20}\\b${w})\\b`).test(s.norm);
    for (const [category, words] of Object.entries(CATEGORY_WORDS)) if (words.some((w) => group(w))) out.categories.add(category);
    if (/\bhand[- ]?wash(?:ed|ing)?\b|\bhandwash/.test(s.norm)) out.handwashGroup = true;
  }
  return out;
}

/** The garments of the named categories (for a group wash or hamper report). */
export async function garmentsOfCategories(db: Db, userId: string, categories: string[]): Promise<{ garmentId: string; careChannel: string }[]> {
  if (categories.length === 0) return [];
  const rows = await all<{ garment_id: string; care_channel: string }>(db, `SELECT garment_id, care_channel FROM garments WHERE user_id = ? AND removed_reason IS NULL AND merged_into IS NULL AND category IN (${categories.map(() => "?").join(",")})`, userId, ...categories);
  return rows.map((r) => ({ garmentId: r.garment_id, careChannel: r.care_channel }));
}
