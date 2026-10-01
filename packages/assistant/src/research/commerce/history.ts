// Provenance policy for history and product research. A claim's status comes
// only from the class of sources that carry a supporting passage; it is never
// raised because the claim suits a hypothesis or the owner's interest.

export type SourceClass =
  | "maker_record" | "archival" | "museum" | "scholarly" | "primary"
  | "secondary" | "maker_origin_story" | "retailer_copy" | "unsourced";

export interface ClaimSupport {
  url: string;
  /** The passage in the source that supports the claim. */
  passage: string;
  /** Date of the source or of the passage (ISO date or year), when known. */
  date?: string;
  sourceClass: SourceClass;
}

export type ClaimKind = "product_specification" | "historical";
export interface ClaimInput { text: string; kind: ClaimKind; support: ClaimSupport[] }
export type ClaimStatus = "supported" | "maker_claim_only" | "unsupported";
export interface ClaimAssessment { status: ClaimStatus; uncertainty: string | null }

/** Independent material that can establish a historical claim. */
export const INDEPENDENT_HISTORICAL_CLASSES: readonly SourceClass[] = ["archival", "museum", "scholarly", "primary"];
/** Material that is only the maker's or seller's own account. */
export const MAKER_CLAIM_CLASSES: readonly SourceClass[] = ["maker_record", "maker_origin_story", "retailer_copy"];

/** Support counts only when it names where it is and quotes the passage. */
const usable = (support: ClaimSupport[]): ClaimSupport[] =>
  support.filter((s) => s.sourceClass !== "unsourced" && s.url.trim() !== "" && s.passage.trim() !== "");

export function assessClaim(claim: ClaimInput): ClaimAssessment {
  const support = usable(claim.support);
  const has = (classes: readonly SourceClass[]): boolean => support.some((s) => classes.includes(s.sourceClass));

  if (claim.kind === "product_specification") {
    if (has(["maker_record"])) return { status: "supported", uncertainty: null };
    if (has(["maker_origin_story", "retailer_copy"])) {
      return { status: "maker_claim_only", uncertainty: "Stated only in marketing or retailer copy; no maker record confirms this specification." };
    }
    return {
      status: "unsupported",
      uncertainty: support.length > 0
        ? "Only sources other than the maker's own record mention this specification; it is not confirmed."
        : "No source with a supporting passage was found for this specification.",
    };
  }

  if (has(INDEPENDENT_HISTORICAL_CLASSES)) return { status: "supported", uncertainty: null };
  if (has(MAKER_CLAIM_CLASSES)) {
    return { status: "maker_claim_only", uncertainty: "This is the maker's or retailer's own account; no archival, museum, scholarly or other primary source supports it." };
  }
  return {
    status: "unsupported",
    uncertainty: support.length > 0
      ? "Only secondary sources repeat this; no archival, museum, scholarly or other primary source establishes it."
      : "No source with a supporting passage was found; the sources do not establish this.",
  };
}

export interface HypothesisClaim extends ClaimInput {
  /** When the claimed fact happened (ISO date or year). Falls back to the earliest dated independent support. */
  period?: string;
  /**
   * Whether the hypothesis depends on this claim (default true). Background
   * claims with `false` appear in the chronology but do not decide the premise.
   */
  linksHypothesis?: boolean;
}

export interface ChronologyEntry { date: string | null; text: string; sources: { url: string; passage: string; date: string | null; sourceClass: SourceClass }[] }
export interface UnestablishedLink { text: string; status: Exclude<ClaimStatus, "supported">; uncertainty: string }

export interface HypothesisExploration {
  hypothesis: string;
  /** Supported claims only, oldest first; undated entries last. */
  chronology: ChronologyEntry[];
  /** Every claim the sources do not establish, with why. These belong in the answer. */
  unestablishedLinks: UnestablishedLink[];
  /** True only when there is at least one link claim and every link claim is supported. */
  premiseEstablished: boolean;
  summary: string;
}

const sortableDate = (date: string | null): string => date ?? "\uffff";

/**
 * Explores a hypothesis without endorsing it: each claim is assessed by
 * `assessClaim` exactly as it would be on its own, supported claims form the
 * chronology, and everything else is listed as an unestablished link.
 */
export function exploreHypothesis(hypothesis: string, claims: HypothesisClaim[]): HypothesisExploration {
  const chronology: ChronologyEntry[] = [];
  const unestablishedLinks: UnestablishedLink[] = [];
  let linkClaims = 0;
  let supportedLinks = 0;

  for (const claim of claims) {
    const isLink = claim.linksHypothesis ?? true;
    if (isLink) linkClaims += 1;
    const assessment = assessClaim(claim);
    if (assessment.status !== "supported") {
      unestablishedLinks.push({
        text: claim.text,
        status: assessment.status,
        uncertainty: assessment.uncertainty ?? "The sources do not establish this.",
      });
      continue;
    }
    if (isLink) supportedLinks += 1;
    const establishing = claim.kind === "historical" ? INDEPENDENT_HISTORICAL_CLASSES : (["maker_record"] as const);
    const sources = usable(claim.support)
      .filter((s) => (establishing as readonly SourceClass[]).includes(s.sourceClass))
      .map((s) => ({ url: s.url, passage: s.passage, date: s.date ?? null, sourceClass: s.sourceClass }));
    const sourceDates = sources.map((s) => s.date).filter((d): d is string => d !== null).sort();
    chronology.push({ date: claim.period ?? sourceDates[0] ?? null, text: claim.text, sources });
  }

  // Stable sort: claims with the same date keep the order they were given in.
  chronology.sort((a, b) => {
    const [x, y] = [sortableDate(a.date), sortableDate(b.date)];
    return x < y ? -1 : x > y ? 1 : 0;
  });

  const premiseEstablished = linkClaims > 0 && supportedLinks === linkClaims;
  const summary = premiseEstablished
    ? `Every link examined for "${hypothesis}" has independent support (${supportedLinks} of ${linkClaims}).`
    : linkClaims === 0
      ? `No claim connecting the evidence to "${hypothesis}" was examined; the hypothesis is not established.`
      : `The sources do not establish "${hypothesis}": ${supportedLinks} of ${linkClaims} links are supported and ${unestablishedLinks.length} claim(s) remain unestablished.`;
  return { hypothesis, chronology, unestablishedLinks, premiseEstablished, summary };
}
