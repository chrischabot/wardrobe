/**
 * Candidate evaluation for image discovery: pure, deterministic rules. A candidate is adopted only on
 * strong product-identity evidence; a model's self-reported confidence is recorded and ignored.
 * Everything a provider reports about a page is untrusted source material and is only ever compared
 * as data - it can never instruct anything.
 */
import { normalizePhrase } from "@garderobe/domain";
import type { CandidateRejectionReason } from "@garderobe/contracts/ext/media";
import type { DiscoveryCandidatePage, DiscoveryGarment } from "../adapters.ts";

export interface CandidateEvaluation {
  decision: "eligible" | "needs_review" | "rejected";
  rejectionReasons: CandidateRejectionReason[];
  /** The single missing distinction, when the owner must decide. */
  reviewQuestion: string | null;
  exactIdentifier: boolean;
  /** Ranking key: lower is better (exact identifiers first, then source class). */
  rank: number;
  evidence: Record<string, unknown>;
}

function code(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const COLOUR_NOISE = new Set(["and", "with", "the", "colour", "color", "stripe", "striped", "stripes", "plaid", "check", "light", "dark", "wide", "extra", "university", "fancy"]);

function colourTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return normalizePhrase(text.replace(/[+/]/g, " ")).split(" ").filter((t) => t.length > 1 && !COLOUR_NOISE.has(t));
}

/** Model family and generation, e.g. "990v4" -> { family: "990", generation: "v4" }; "Mk.IV" -> { family: "mk", generation: "iv" }. */
export function generationOf(text: string | null | undefined): { family: string; generation: string } | null {
  if (!text) return null;
  const t = text.toLowerCase();
  const v = /\b(\d{3,4})\s?v(\d{1,2})\b/.exec(t);
  if (v) return { family: v[1]!, generation: `v${v[2]}` };
  const mk = /\bmk\.?\s?([ivx]{1,4}|\d{1,2})\b/.exec(t);
  if (mk) return { family: "mk", generation: mk[1]! };
  return null;
}

const SOURCE_RANK: Record<DiscoveryCandidatePage["sourceClass"], number> = { purchase_source: 0, maker: 1, retailer: 2, other: 3 };

export function evaluateCandidate(garment: DiscoveryGarment, page: DiscoveryCandidatePage): CandidateEvaluation {
  const reasons: CandidateRejectionReason[] = [];
  const ids = page.identifiers ?? {};
  const garmentCodes = [...new Set(garment.codes.map(code).filter((c) => c.length >= 4))];
  const pageCodes = (ids.productCodes ?? []).map(code).filter(Boolean);
  const matchedCodes = garmentCodes.filter((c) => pageCodes.includes(c));
  const exactIdentifier = matchedCodes.length > 0;
  // A page that states product codes, none of which is this garment's, is a different product.
  const contradictingCode = garmentCodes.length > 0 && pageCodes.length > 0 && !exactIdentifier;

  const garmentMaker = garment.maker ? normalizePhrase(garment.maker) : "";
  const pageMaker = ids.maker ? normalizePhrase(ids.maker) : "";
  const makerMatch = garmentMaker !== "" && pageMaker !== "" && (pageMaker.includes(garmentMaker) || garmentMaker.includes(pageMaker));
  const makerContradiction = garmentMaker !== "" && pageMaker !== "" && !makerMatch;

  const nameSource = normalizePhrase(garment.product ?? garment.name);
  const nameTokens = nameSource.split(" ").filter((t) => t.length > 2 && !garmentMaker.split(" ").includes(t));
  const pageName = normalizePhrase(`${ids.productName ?? ""} ${page.title ?? ""}`);
  const nameHits = nameTokens.filter((t) => pageName.split(" ").includes(t)).length;
  const productMatch = nameTokens.length > 0 && nameHits / nameTokens.length >= 0.6;

  const want = colourTokens(garment.colour ?? garment.pattern);
  const have = colourTokens(ids.colourway);
  const colourStated = have.length > 0;
  const colourKnown = want.length > 0;
  const colourMatch = colourKnown && colourStated && want.some((t) => have.includes(t));
  if (colourKnown && colourStated && !colourMatch) reasons.push("wrong_colourway");

  const wantGeneration = generationOf(garment.model) ?? generationOf(garment.product) ?? generationOf(garment.name);
  const haveGeneration = generationOf(ids.generation) ?? generationOf(ids.productName) ?? generationOf(page.title);
  if (wantGeneration && haveGeneration && wantGeneration.family === haveGeneration.family && wantGeneration.generation !== haveGeneration.generation) reasons.push("different_generation");

  const wantCut = garment.cut ? normalizePhrase(garment.cut) : "";
  const haveCut = ids.cut ? normalizePhrase(ids.cut) : "";
  if (wantCut && haveCut && wantCut !== haveCut) reasons.push("materially_different_cut");

  if (contradictingCode || makerContradiction) reasons.push("uncertain_lookalike");

  const recordedPurchasePage = page.sourceClass === "purchase_source" && page.recordedPurchaseLink === true && !!garment.purchaseLink;
  const evidence: Record<string, unknown> = {
    matchedCodes,
    recordedPurchasePage,
    makerMatch,
    productMatch,
    colourway: { recorded: garment.colour, stated: ids.colourway ?? null, match: colourStated && colourKnown ? colourMatch : null },
    generation: { recorded: wantGeneration, stated: haveGeneration },
    sourceClass: page.sourceClass,
    pageUrl: page.pageUrl,
    retrievedAt: page.retrievedAt,
    ...(page.modelConfidence !== undefined ? { modelConfidence: page.modelConfidence, modelConfidenceUsed: false } : {}),
  };
  const rank = (exactIdentifier ? 0 : 10) + SOURCE_RANK[page.sourceClass];

  if (reasons.length > 0) return { decision: "rejected", rejectionReasons: [...new Set(reasons)], reviewQuestion: null, exactIdentifier, rank, evidence };

  // Strong identity: an exact product/fabric code (which fixes the colourway), the garment's own recorded
  // purchase page WHEN that page also names the maker or the product, or maker + product together. Without
  // a code the colourway must also be stated and match. The recorded link alone proves nothing about what
  // the page shows today.
  if (exactIdentifier) return { decision: "eligible", rejectionReasons: [], reviewQuestion: null, exactIdentifier, rank, evidence };
  if ((recordedPurchasePage && (makerMatch || productMatch)) || (makerMatch && productMatch)) {
    if (!colourKnown || colourMatch) return { decision: "eligible", rejectionReasons: [], reviewQuestion: null, exactIdentifier, rank, evidence };
    return {
      decision: "needs_review",
      rejectionReasons: [],
      reviewQuestion: `The page matches ${recordedPurchasePage ? "the recorded purchase link" : "the maker and product"} but does not state the colourway. Is this the ${garment.colour} one?`,
      exactIdentifier,
      rank,
      evidence,
    };
  }
  return { decision: "rejected", rejectionReasons: [makerMatch || productMatch ? "uncertain_lookalike" : "insufficient_identity_evidence"], reviewQuestion: null, exactIdentifier, rank, evidence };
}
