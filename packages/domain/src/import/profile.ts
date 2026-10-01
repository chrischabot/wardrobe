/**
 * The owner's profile as data: machine rules, measurements, size experiences and the healing
 * restriction, each traceable to a passage quoted VERBATIM from the profile. The profile text itself is
 * imported unchanged (hash-verified); nothing here replaces or summarises it.
 *
 * Every `quote` below must occur exactly in the profile; `locatePassage` finds its line range and the
 * importer refuses to run if a quote is missing, so a changed profile can never silently keep stale rules.
 */
import type { FoundationPayload, PassageRef } from "@garderobe/contracts";

/** SHA-256 of the September 14, 2026 second edition, as recorded in specification section 6. */
export const OWNER_PROFILE_SHA256 = "e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198";
export const OWNER_PROFILE_TITLE = "Chris — Taste, Formation, Preferences and Operating Rules (second edition, 14 September 2026)";
export const OWNER_PROFILE_DATE = "2026-09-14";
export const HEALING_RESTRICTION_ID = "rst_profile_sneakers_only";

export function locatePassage(content: string, contentSha256: string, quote: string, section?: string): PassageRef {
  const index = content.indexOf(quote);
  if (index === -1) throw new Error(`profile passage not found verbatim: "${quote.slice(0, 70)}..."`);
  const lineStart = content.slice(0, index).split("\n").length;
  const lineEnd = lineStart + quote.split("\n").length - 1;
  return { documentSha256: contentSha256, ...(section ? { section } : {}), lineStart, lineEnd, quote };
}

export interface ProfileRuleSpec {
  key: string;
  kind: "hard" | "soft";
  status: "active" | "pending_reconciliation" | "dormant";
  params: Record<string, unknown>;
  interpretation: string;
  section?: string;
  quotes: string[];
  origin: "profile" | "specification";
}

export const PROFILE_RULES: ProfileRuleSpec[] = [
  {
    key: "socks.required",
    kind: "hard",
    status: "active",
    params: { defaultFabricClass: "merino", exceptions: "none" },
    interpretation: "Every outfit includes socks; merino is the default; no sockless suggestion in any weather or occasion.",
    section: "8.1",
    quotes: ["**Socks always, wicking merino by default.** No bare-ankle, no sockless, no loafer-without-sock suggestion, in any weather, for any occasion. This is a standing medical rule with no exceptions."],
    origin: "profile",
  },
  {
    key: "footwear.sneakers_only_until_healed",
    kind: "hard",
    status: "active",
    params: { restrictionId: HEALING_RESTRICTION_ID, allowedFootwearKinds: ["sneaker"], excludedModels: ["990v6"], liftedBy: "explicit owner statement only" },
    interpretation: "Only sneakers are offered; every non-sneaker shoe and the 990v6 are excluded by an active healing restriction that only the owner's explicit statement resolves. Elapsed time is not evidence of recovery.",
    section: "8.2",
    quotes: ["**Sneakers only, until he says his feet have healed.** Nerve damage from previously too-small shoes puts the entire welted fleet and the 990v6 out of play; temporary pain would become permanent injury."],
    origin: "profile",
  },
  {
    key: "footwear.name_sneaker_and_welted_alternative",
    kind: "hard",
    status: "dormant",
    params: { activatesWhen: "footwear.sneakers_only_until_healed is resolved" },
    interpretation: "Dormant while the healing restriction is active (the restriction outranks the paired-shoe format). Once resolved, every outfit names a sneaker and a welted alternative.",
    section: "8.3",
    quotes: ["**Every outfit names both a sneaker and a welted alternative** once the fleet returns, so the day's distance and weather decide at the door rather than in the plan."],
    origin: "profile",
  },
  {
    key: "thermal.base_layers_follow_daytime_peak",
    kind: "hard",
    status: "active",
    params: { roles: ["top", "bottom", "socks"], basis: "daytime_peak" },
    interpretation: "Shirts and trousers are assessed against the maximum temperature of the intended wearing interval, never the morning low.",
    section: "8.4",
    quotes: ["Shirts and trousers are chosen against the day's *peak* temperature, never the morning low. A day that starts at 11° and reaches 19° is a 19° outfit."],
    origin: "profile",
  },
  {
    key: "thermal.outerwear_follows_morning",
    kind: "hard",
    status: "active",
    params: { roles: ["outer"], basis: "outdoor_interval" },
    interpretation: "Only outerwear answers the cool start; it is assessed against the outdoor interval in which it is worn, normally departure.",
    section: "8.4",
    quotes: ["Only outerwear answers the morning, because the jacket exists to cover the cool start and then comes off."],
    origin: "profile",
  },
  {
    key: "thermal.jacket_14_16_lightweight_oxford_only",
    kind: "hard",
    status: "active",
    params: { minC: 14, maxC: 16, inclusive: true, basis: "outdoor_interval", requiredShirtFabricClass: "lightweight_oxford" },
    interpretation:
      "Implementation interpretation of the profile's 'roughly' (specification section 7): when a jacket is worn at an outdoor temperature of 14-16 C inclusive, the shirt under it must be a lightweight oxford. Evaluated on the jacket-wearing interval, not the daily maximum; editable as a versioned owner rule.",
    section: "8.4",
    quotes: ["At roughly 14–16° a jacket goes over a lightweight oxford only; a heavy shirt underneath is far too hot."],
    origin: "profile",
  },
  {
    key: "variety.repeat_horizon",
    kind: "hard",
    status: "active",
    params: { days: 7, categories: ["shirt", "trousers"], overridableBy: "explicit scoped exception" },
    interpretation: "A shirt or trousers with a recorded wear in the previous seven days is a repeat and is not ordinarily suggested. Based on recorded wear only.",
    section: "8.5",
    quotes: ["Anything worn in the last seven days is a repeat."],
    origin: "profile",
  },
  {
    key: "variety.nothing_repeats_inside_a_fortnight",
    kind: "soft",
    status: "active",
    params: { days: 14 },
    interpretation: "Broader patterns are checked across fourteen days; the hard repeat check is seven days.",
    section: "8.5",
    quotes: ["He owns twenty-odd trousers and thirty-odd shirts precisely so that nothing repeats inside a fortnight."],
    origin: "profile",
  },
  {
    key: "swap.never_fall_back_to_navy",
    kind: "hard",
    status: "active",
    params: { avoidColourFamilyOnSwap: "navy" },
    interpretation: "When a piece is swapped out, the replacement is not navy by default.",
    section: "8.6",
    quotes: ["**Never fall back to navy** when a piece is swapped out."],
    origin: "profile",
  },
  {
    key: "naming.visible_at_the_wardrobe",
    kind: "hard",
    status: "active",
    params: { jeansNames: ["light", "mid", "dark"], manufacturerWashNamesInOutfitCopy: false },
    interpretation: "Outfit copy and questions use names the owner can see at the wardrobe; manufacturer terminology stays on the item page.",
    section: "8.7",
    quotes: ["**Names must match what he can actually see at the wardrobe.** Manufacturer wash names mean nothing to him, and jeans hang as a narrow side profile. Jeans are light, mid or dark."],
    origin: "profile",
  },
  {
    key: "colour.no_neutral_three_times",
    kind: "soft",
    status: "active",
    params: { maxSameNeutralPerOutfit: 2, footEchoesHigherColour: true },
    interpretation: "A single neutral appears at most twice in one outfit; socks/shoes echo a colour from higher up instead of repeating the trouser.",
    section: "5",
    quotes: ["never let a single neutral appear three times in one outfit, and let the foot echo a colour already present higher up rather than repeating the trouser."],
    origin: "profile",
  },
  {
    key: "board.safe_options_never_lead",
    kind: "soft",
    status: "active",
    params: {},
    interpretation: "Safe permutations can appear on a board but do not lead it. Quiet interest is valid; a loud piece is optional.",
    section: "6",
    quotes: ["Safe options are a fallback, never the lead."],
    origin: "profile",
  },
  {
    key: "board.daily_entry_format",
    kind: "soft",
    status: "active",
    params: { defaultOptionCount: 5, optionOrder: ["jacket", "shirt or jumper", "trousers", "belt with optional flourish", "socks with shoes"] },
    interpretation: "The daily board is a day line, then five outfits by default, each opening with why it works, followed by the garment lines in this order.",
    section: "11",
    quotes: ["The daily entry is one glanceable board: a day line closing on the shape of the day, then five outfits, each opening with a sentence on why it works and what makes it interesting, followed by jacket, shirt or jumper, trousers, belt with its optional flourish, and socks with shoes."],
    origin: "profile",
  },
  {
    key: "accessories.no_watches_or_jewellery",
    kind: "hard",
    status: "active",
    params: { excluded: ["watch", "jewellery"] },
    interpretation: "Watches and jewellery are never suggested as part of an outfit; an older positive watch discussion does not create a requirement.",
    section: "9",
    quotes: ["Watches and jewellery are absent by choice, and the suit-and-watch register is one he has explicitly refused."],
    origin: "profile",
  },
  {
    key: "accessories.belt_line_optional_scarf_or_tie",
    kind: "soft",
    status: "active",
    params: {},
    interpretation: "The belt line may carry an optional scarf or tie suggestion appropriate to the day.",
    section: "9",
    quotes: ["The belt line in any plan should carry an optional scarf or tie suggestion appropriate to the day: often ignored, always welcome."],
    origin: "profile",
  },
  {
    key: "fabric.repels",
    kind: "soft",
    status: "active",
    params: { repels: ["sheen", "dressy drape", "synthetics and synthetic-content blends", "thin linen", "sealed or napped surfaces (moleskin included)", "merino sweaters"], exception: "merino socks" },
    interpretation: "Purchase and styling advice treats these hand-feel dislikes as strong negatives; merino socks are the explicit exception.",
    section: "4",
    quotes: ["**Repels:** sheen of any kind; dressy drape; synthetics and synthetic-content blends; thin linen; sealed or napped surfaces, moleskin included; and merino *sweaters*, which read shiny, flat and smothering. Merino socks are the one working exception and are worn constantly."],
    origin: "profile",
  },
  {
    key: "purchase.construction_gates",
    kind: "hard",
    status: "active",
    params: { collarsAndCuffs: "sewn, never fused", clothWeight: "real weight required", rejectCare: "cool-wash-only, no-tumble-dry shirts", verifyBeforeRecommendingShirtmaker: ["cloth weight", "collar construction"] },
    interpretation: "Purchase verdicts fail a shirt with fused collar or cuffs, insubstantial cloth, or a cool-wash-only care burden; a new shirtmaker is not recommended until cloth weight and collar construction are verified from evidence.",
    section: "4",
    quotes: [
      "Collars and cuffs must be sewn, never fused",
      "Cool-wash-only, no-tumble-dry shirts are not worth the maintenance. Before any new shirtmaker is recommended, cloth weight and collar construction must be verified rather than taken from a listing.",
    ],
    origin: "profile",
  },
  {
    key: "purchase.no_visible_branding",
    kind: "hard",
    status: "active",
    params: { excluded: ["logos", "showy hardware", "business-dress signalling"] },
    interpretation: "Nothing with visible branding is recommended.",
    section: "2",
    quotes: ["No logos, no showy hardware, no business-dress signalling."],
    origin: "profile",
  },
  {
    key: "fit.comfort_outranks_aesthetics_at_the_feet",
    kind: "hard",
    status: "active",
    params: { shoeSizeUk: 8.5, tooSmall: "UK 8" },
    interpretation: "Footwear comfort over distance always outranks appearance; pain is never traded against a styling score.",
    section: "7",
    quotes: ["Comfort over distance always outranks aesthetics at the feet.", "UK 8 is too small and caused real damage."],
    origin: "profile",
  },
  {
    key: "ledger.zero_wear_means_unlogged",
    kind: "hard",
    status: "active",
    params: {},
    interpretation: "A zero wear count is reported as not logged; condition is never inferred from it; inventory facts are read from the ledger, never stated from memory.",
    section: "11",
    quotes: ["Verify before asserting. Never state an inventory fact from memory when the ledger can be queried. A zero wear count means unlogged, never unworn, and condition must never be inferred from it. His direct knowledge of reality outranks the ledger every time."],
    origin: "profile",
  },
  {
    key: "lifecycle.consignment_is_a_size_correction",
    kind: "soft",
    status: "active",
    params: { categoriesWantedBackSmaller: ["Games blazers", "jungle jacket", "rugbies"] },
    interpretation: "A sale of oversized pieces is never read as a reason to steer away from their category.",
    section: "10",
    quotes: ["Nothing in the sale should ever be read as a reason to steer him away from a category."],
    origin: "profile",
  },
  // Initial rules from the usage research listed in specification section 7. They are NOT in the
  // profile, so they keep their source and wait for reconciliation before they are enforced.
  { key: "thermal.cotton_linen_from", kind: "hard", status: "pending_reconciliation", params: { fabricClass: "cotton_linen", minC: 28, basis: "daytime_peak" }, interpretation: "Specification section 7 initial rule from the usage research: cotton-linen from 28 C at the daytime peak. Absent from the profile; reconcile with the owner before activation.", quotes: [], origin: "specification" },
  { key: "thermal.pure_linen_from", kind: "hard", status: "pending_reconciliation", params: { fabricClass: "pure_linen", minC: 30, basis: "daytime_peak" }, interpretation: "Specification section 7 initial rule: pure linen from 30 C at the daytime peak. Absent from the profile (which separately says thin linen repels); reconcile before activation.", quotes: [], origin: "specification" },
  { key: "thermal.lightweight_oxford_floor", kind: "hard", status: "pending_reconciliation", params: { fabricClass: "lightweight_oxford", minC: 10, basis: "daytime_peak" }, interpretation: "Specification section 7 initial rule: lightweight oxford has a lower bound of 10 C. Absent from the profile; reconcile before activation.", quotes: [], origin: "specification" },
  { key: "thermal.outerwear_ceiling", kind: "hard", status: "pending_reconciliation", params: { maxC: 24, basis: "unsettled" }, interpretation: "Specification section 7 initial rule: no outerwear above 24 C. Its weather basis (morning or peak) is explicitly unsettled; it must agree with the morning-outerwear rule before activation.", quotes: [], origin: "specification" },
  { key: "thermal.alpaca_socks_cold_only", kind: "hard", status: "pending_reconciliation", params: { fabricClass: "alpaca", maxC: 12, basis: "daytime_peak" }, interpretation: "Specification section 7 initial rule: alpaca socks at 12 C or colder. Absent from the profile; reconcile before activation.", quotes: [], origin: "specification" },
  { key: "socks.bed_socks_indoors_only", kind: "hard", status: "active", params: { attribute: "indoorOnly" }, interpretation: "Bed socks are indoor-only and are never offered in an ordinary outfit (specification section 7; the inventory sheet marks the item 'Bed sock').", quotes: [], origin: "specification" },
  { key: "care.trousers_single_wear_day", kind: "hard", status: "active", params: { categories: ["trousers", "shirt"], wearsBeforeCare: 1, channels: { service: "shirts, trousers", handwash: "socks" } }, interpretation: "Specification section 5: trousers have a single-wear-day care policy; service and hand-wash channels are separate; footwear, belts and other never-laundered roles cannot acquire a laundry state.", quotes: [], origin: "specification" },
];

export interface ProfileMeasurementSpec {
  key: string;
  value: number;
  unit: "in" | "cm" | "m" | "uk_shoe";
  convention: string | null;
  qualifier: string | null;
  quote: string;
}

/** Dated body facts stated in profile section 7. Never recalculated from context or photographs. */
export const PROFILE_MEASUREMENTS: ProfileMeasurementSpec[] = [
  { key: "height", value: 1.85, unit: "m", convention: "standing height", qualifier: "a little over", quote: "Tall, a little over 1.85 m" },
  { key: "chest", value: 44, unit: "in", convention: "body circumference", qualifier: "unchanged for months", quote: "Chest and waist both 44 inches, unchanged for months; neck 17 inches." },
  { key: "waist", value: 44, unit: "in", convention: "body circumference", qualifier: "unchanged for months", quote: "Chest and waist both 44 inches, unchanged for months; neck 17 inches." },
  { key: "neck", value: 17, unit: "in", convention: "body circumference", qualifier: null, quote: "Chest and waist both 44 inches, unchanged for months; neck 17 inches." },
  { key: "shoe_size", value: 8.5, unit: "uk_shoe", convention: "UK shoe size", qualifier: "across sneakers and Paraboot alike", quote: "Footwear: UK 8.5 across sneakers and Paraboot alike." },
];

export const PROFILE_SIZE_EXPERIENCES: { maker: string; productFamily: string | null; sizeLabel: string; note: string | null; quote: string }[] = [
  { maker: "Drake's", productFamily: "jackets and coats (Games blazers, chores, macs)", sizeLabel: "46", note: null, quote: "Jackets and coats: 46 at Drake's, including Games blazers, chores and macs." },
  { maker: "Private White V.C.", productFamily: "jackets and coats", sizeLabel: "6 / XL", note: "chart size", quote: "Private White chart size 6 / XL." },
  { maker: "De Bonne Facture", productFamily: null, sizeLabel: "own chart", note: "runs to its own chart; never carry Drake's numbers across", quote: "De Bonne Facture runs to its own chart and its numbers must never be carried across from Drake's." },
  { maker: "(any)", productFamily: "rugbies", sizeLabel: "XL", note: "remaining XXLs are layering pieces and read slouchy", quote: "Rugbies: XL. The XXLs that remain are layering pieces and read slouchy." },
  { maker: "Proper Cloth", productFamily: "shirts", sizeLabel: "made to measure (current manual measure)", note: "17½ collar, occasionally 17, at ready-to-wear makers", quote: "Shirts: made to measure at Proper Cloth on the current manual measure; 17½ collar, occasionally 17, at ready-to-wear makers." },
  { maker: "(any)", productFamily: "trousers", sizeLabel: "40 waist, 32 length", note: "38 for a rise that sits below the waist; rise matters more than waist", quote: "Trousers: 40 waist, 32 length, dropping to 38 for a rise that sits below the waist." },
];

export const HEALING_RESTRICTION: Omit<FoundationPayload<"restriction.add">, "source"> & { quote: string } = {
  restrictionId: HEALING_RESTRICTION_ID,
  kind: "healing",
  // "Sneakers only": every shoe that is not a sneaker, plus the named 990v6.
  scope: { anyOf: [{ category: "footwear", footwearKinds: ["welted", "boot", "other"] }, { models: ["990v6"] }] },
  reason: "Sneakers only until the owner says his feet have healed (nerve damage from previously too-small shoes); the welted fleet and the 990v6 are out of play",
  expectedEnd: null,
  requiredEvidence: "owner_statement",
  quote: "**Sneakers only, until he says his feet have healed.** Nerve damage from previously too-small shoes puts the entire welted fleet and the 990v6 out of play; temporary pain would become permanent injury.",
};
