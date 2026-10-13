/**
 * Profile-versus-inventory conflicts. The profile (September 14, 2026) and the inventory sheet
 * ("clean master, May 2026") disagree in places. Nothing here resolves a disagreement: each finding quotes
 * the profile, names the sheet rows, and states what the importer did (always the conservative, non-inventing
 * choice). The owner settles them with ordinary commands.
 */
import type { InventoryImportPlan, PlannedGarment } from "./inventory.ts";

export interface ConflictFinding {
  id: string;
  severity: "info" | "conflict" | "needs_owner";
  title: string;
  profileQuote: string | null;
  inventoryEvidence: string;
  sourceRows: number[];
  garmentIds: string[];
  importerAction: string;
}

export function detectConflicts(plan: InventoryImportPlan, profileText: string): ConflictFinding[] {
  const out: ConflictFinding[] = [];
  const quote = (q: string): string => {
    if (!profileText.includes(q)) throw new Error(`conflict report: profile passage not found verbatim: "${q.slice(0, 60)}..."`);
    return q;
  };
  const where = (pred: (g: PlannedGarment) => boolean) => plan.garments.filter(pred);
  const rowsOf = (gs: PlannedGarment[]) => gs.flatMap((g) => g.sourceRows).sort((a, b) => a - b);
  const names = (gs: PlannedGarment[]) => gs.map((g) => `${g.payload.name}${g.payload.size ? ` (size ${g.payload.size})` : ""} [${g.statusText}]`).join("; ");
  const add = (f: Omit<ConflictFinding, "id" | "sourceRows" | "garmentIds"> & { garments?: PlannedGarment[] }) => {
    const gs = f.garments ?? [];
    const { garments: _g, ...rest } = f;
    out.push({ ...rest, id: `C${String(out.length + 1).padStart(2, "0")}`, sourceRows: rowsOf(gs), garmentIds: gs.map((g) => g.garmentId) });
  };
  const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

  // 1. Sneakers the profile names that the sheet does not contain.
  const sneakers = where((g) => g.payload.category === "footwear" && g.payload.attributes?.footwearKind === "sneaker");
  const models = new Set(sneakers.map((g) => String(g.payload.attributes?.model ?? "")));
  const missingModels = ["990v6", "993"].filter((m) => !models.has(m));
  if (missingModels.length > 0) {
    add({
      severity: "needs_owner",
      title: `Profile names New Balance ${missingModels.join(" and ")}; the inventory has none`,
      profileQuote: quote("New Balance is the spine: the 990v4 and 990v6 chosen on their merits rather than by habit, with the 993 a genuine complement."),
      inventoryEvidence: `Sneakers in the sheet: ${names(sneakers) || "none"}.`,
      garments: sneakers,
      importerAction: `No ${missingModels.join(" or ")} was created: a garment exists only when the inventory or the owner says so. The 990v6 exclusion is still recorded in the healing restriction, so one added later is excluded automatically.`,
    });
  }

  // 2. Non-sneaker footwear is owned and marked "Breaking in" but is excluded by the active restriction.
  const nonSneakers = where((g) => g.payload.category === "footwear" && g.payload.attributes?.footwearKind !== "sneaker");
  if (nonSneakers.length > 0) {
    add({
      severity: "conflict",
      title: "Sheet shows welted shoes and a boot in rotation (\"Breaking in\"); the profile's sneakers-only restriction is newer",
      profileQuote: quote("**Sneakers only, until he says his feet have healed.**"),
      inventoryEvidence: names(nonSneakers),
      garments: nonSneakers,
      importerAction: "All are imported as owned and kept out of every recommendation by the active healing restriction. The restriction is lifted only by the owner's explicit statement; the sheet's older status does not lift it.",
    });
  }

  // 3. Shoe size.
  const offSize = where((g) => g.payload.category === "footwear" && g.payload.size !== null && g.payload.size !== "UK 8.5");
  if (offSize.length > 0) {
    add({
      severity: "info",
      title: "A shoe is not the profile's UK 8.5",
      profileQuote: quote("Footwear: UK 8.5 across sneakers and Paraboot alike."),
      inventoryEvidence: names(offSize) + ". The sheet's own note explains the boot runs small.",
      garments: offSize,
      importerAction: "Sizes imported as stated per garment; the profile's 8.5 is kept as the dated body fact. A maker-specific size is not treated as a contradiction of the body fact.",
    });
  }

  // 4. Drake's outerwear sizes versus "46 at Drake's".
  const drakesOuter = where((g) => g.payload.category === "outerwear" && g.payload.maker === "Drake's");
  const drakesNot46 = drakesOuter.filter((g) => g.payload.size !== "46");
  if (drakesNot46.length > 0) {
    add({
      severity: "conflict",
      title: "Drake's jackets in sizes other than the profile's 46",
      profileQuote: quote("Jackets and coats: 46 at Drake's, including Games blazers, chores and macs."),
      inventoryEvidence: names(drakesNot46),
      garments: drakesNot46,
      importerAction: "Imported with their stated sizes and the sheet's planning status. Nothing was benched or retired on the strength of the profile's size alone.",
    });
  }

  // 5. Private White sizes versus "chart size 6 / XL".
  const pw = where((g) => lower(g.payload.maker).startsWith("private white"));
  const pwNot6 = pw.filter((g) => g.payload.size !== "6");
  if (pwNot6.length > 0) {
    add({
      severity: "conflict",
      title: "Private White pieces are sizes 7 and 8; the profile's current size is 6 / XL",
      profileQuote: quote("Private White chart size 6 / XL."),
      inventoryEvidence: names(pwNot6),
      garments: pwNot6,
      importerAction: "Imported as stated: the size 8 pieces keep the sheet's 'Benched (too large)' exclusion; the size 7 pieces stay active as the sheet says. Whether the 7s still fit is the owner's call.",
    });
  }

  // 6. Pieces the profile says were sold.
  const games = where((g) => lower(g.payload.name).includes("games"));
  const jungle = where((g) => lower(g.payload.name).includes("jungle"));
  if (games.length + jungle.length > 0) {
    add({
      severity: "needs_owner",
      title: "Profile says Games blazers, a jungle jacket and rugbies were sold; the sheet still lists Games blazers and a jungle jacket",
      profileQuote: quote("He sold Games blazers, a jungle jacket and rugbies because they no longer fit, and he wants those same categories back in the smaller size."),
      inventoryEvidence: names([...games, ...jungle]) + ". The sheet lists no rugby shirts at all.",
      garments: [...games, ...jungle],
      importerAction: "All listed pieces are imported as owned with the sheet's status, because the profile does not say WHICH pieces left and the sheet may predate or postdate the sale. No disposal was recorded and no rugby was created. The owner retires whatever has actually gone.",
    });
  }

  // 7. Moleskin.
  const moleskin = where((g) => lower(g.payload.fabric).includes("moleskin") || lower(g.payload.name).includes("moleskin"));
  if (moleskin.length > 0) {
    add({
      severity: "conflict",
      title: "An active moleskin jacket; the profile lists moleskin among the surfaces that repel",
      profileQuote: quote("sealed or napped surfaces, moleskin included"),
      inventoryEvidence: names(moleskin),
      garments: moleskin,
      importerAction: "Imported as stated (active). The hand-feel passage stays in the profile for the assistant; no planning policy was changed on its strength.",
    });
  }

  // 8. Fused cuffs.
  const fused = where((g) => (g.payload.facts ?? []).some((f) => f.attribute === "import_notes" && lower(String(f.value)).includes("fused")));
  if (fused.length > 0) {
    add({
      severity: "info",
      title: "A shirt with fused cuffs; the profile requires sewn collars and cuffs",
      profileQuote: quote("Collars and cuffs must be sewn, never fused"),
      inventoryEvidence: names(fused),
      garments: fused,
      importerAction: "Imported as the sheet has it (layering tier). Consistent with the profile's verdict rather than contrary to it; recorded so purchase advice can cite the experience.",
    });
  }

  // 9. Categories and pieces the profile describes that the sheet does not contain.
  const has = (pred: (g: PlannedGarment) => boolean) => where(pred).length > 0;
  const absent: string[] = [];
  if (!has((g) => lower(g.payload.name).includes("rugby"))) absent.push("rugby shirts");
  if (!has((g) => g.payload.category === "knitwear")) absent.push("knitwear (Shetland, cardigan, cashmere)");
  if (!has((g) => g.payload.category === "tee")) absent.push("a white tee");
  const denim = where((g) => g.payload.category === "trousers" && lower(g.payload.fabric) === "denim");
  if (!has((g) => g.payload.category === "trousers" && lower(g.payload.fabric) === "denim" && /(blue|indigo|light wash|mid|dark)/.test(lower(g.payload.colour)))) absent.push("light, mid or dark blue jeans");
  if (!has((g) => g.payload.category === "outerwear" && /(tweed|houndstooth|donegal)/.test(`${lower(g.payload.name)} ${lower(g.payload.fabric)}`) && g.payload.planningPolicy === "normal")) absent.push("an active tweed, houndstooth or Donegal academic blazer");
  if (!has((g) => /(loden|mac\b)/.test(lower(g.payload.name)) && g.payload.planningPolicy === "normal")) absent.push("an active loden or mac");
  if (absent.length > 0) {
    add({
      severity: "needs_owner",
      title: "Garments and categories the profile describes that are not in the inventory",
      profileQuote: quote("The range runs from a white tee, jeans and a cardigan at the quiet end to a panelled rugby at the loud end, and both are him."),
      inventoryEvidence: `Not found in the sheet: ${absent.join("; ")}. Denim trousers present: ${names(denim) || "none"}.`,
      garments: denim,
      importerAction: "Nothing was created for them. The profile's prose is kept in full as taste context; recommendations can only use garments that exist in the ledger. Items acquired after the May 2026 sheet enter through ordinary intake.",
    });
  }

  // 10. Counts.
  const shirts = where((g) => g.payload.category === "shirt");
  const trousers = where((g) => g.payload.category === "trousers");
  const trouserUnits = trousers.reduce((n, g) => n + (g.payload.quantity ?? 1), 0);
  add({
    severity: "info",
    title: "Counts differ from the profile's round numbers",
    profileQuote: quote("He owns twenty-odd trousers and thirty-odd shirts precisely so that nothing repeats inside a fortnight."),
    inventoryEvidence: `The sheet has ${shirts.length} shirts and ${trouserUnits} pairs of trousers (${trousers.length} distinct garments).`,
    garments: [],
    importerAction: "The sheet's rows are imported exactly; the profile's figures are treated as prose, not as a count to reconcile to.",
  });

  // 11. Sheet age.
  add({
    severity: "info",
    title: "The inventory is a May 2026 snapshot; the profile is dated 14 September 2026",
    profileQuote: quote("Second edition, 14 September 2026, superseding the first draft of 30 August."),
    inventoryEvidence: `Sheet title: "${plan.title ?? ""}". Latest acquisition date in the sheet: ${latestAcquired(plan) ?? "none stated"}.`,
    garments: [],
    importerAction: "Rows are imported as historical evidence of ownership. Cleanliness was never observed, so every laundered garment starts as an estimate; no wear history is imported or invented; purchases and disposals after the snapshot are unknown until the owner reports them.",
  });

  // 12. An item the sheet itself flags as mislabelled.
  const mislabelled = where((g) => (g.payload.facts ?? []).some((f) => f.attribute === "import_notes" && lower(String(f.value)).includes("mislabels")));
  if (mislabelled.length > 0) {
    add({
      severity: "info",
      title: "The sheet flags one of its own rows as mislabelled",
      profileQuote: null,
      inventoryEvidence: mislabelled.map((g) => `${g.payload.name}: item says waxed cotton; source detail says "${g.payload.product}"`).join("; "),
      garments: mislabelled,
      importerAction: "Imported under the sheet's corrected name; the mislabelled product name is kept as an alias so either phrase finds the same garment.",
    });
  }

  // 13. Temperature guidance without a stated basis.
  const thermal = where((g) => g.payload.thermal !== null && g.payload.thermal !== undefined);
  add({
    severity: "info",
    title: "Sheet temperature ranges do not say whether they mean the morning or the daytime peak",
    profileQuote: quote("Shirts and trousers are chosen against the day's *peak* temperature, never the morning low."),
    inventoryEvidence: `${thermal.length} garments carry a numeric range in the Season column (for example "To 22°C", "10-24°C", "30°C+ only").`,
    garments: thermal,
    importerAction: "The numbers are stored with basis 'unsettled' rather than silently choosing morning or peak. The research-derived thresholds in specification section 7 (cotton-linen 28, pure linen 30, oxford floor 10, outerwear ceiling 24, alpaca 12) are recorded as rules pending reconciliation, not enforced.",
  });

  return out;
}

function latestAcquired(plan: InventoryImportPlan): string | null {
  let latest: string | null = null;
  for (const g of plan.garments) {
    for (const f of g.payload.facts ?? []) {
      if (f.attribute === "acquired_on" && typeof f.value === "string" && (latest === null || f.value > latest)) latest = f.value;
    }
  }
  return latest;
}
