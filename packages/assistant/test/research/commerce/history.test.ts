import { describe, it, expect } from "vitest";
import { assessClaim, exploreHypothesis } from "../../../src/research/commerce/index.ts";
import type { ClaimSupport, HypothesisClaim } from "../../../src/research/commerce/index.ts";

const makerRecord: ClaimSupport = { url: "https://maker.example/spec/chore-coat", passage: "Cotton moleskin, 410 g/m2.", sourceClass: "maker_record" };
const originStory: ClaimSupport = { url: "https://maker.example/our-story", passage: "Worn by railway workers since 1890.", sourceClass: "maker_origin_story" };
const retailerCopy: ClaimSupport = { url: "https://shop.example/chore-coat", passage: "The original worker's jacket.", sourceClass: "retailer_copy" };
const museum: ClaimSupport = { url: "https://museum.example/object/123", passage: "Bleu de travail jacket, c. 1910.", date: "1910", sourceClass: "museum" };
const archive: ClaimSupport = { url: "https://archive.example/catalogue-1925", passage: "Veste de travail, moleskine bleue.", date: "1925", sourceClass: "archival" };
const blog: ClaimSupport = { url: "https://blog.example/chore-coats", passage: "Students adopted it in 1968.", sourceClass: "secondary" };

describe("assessClaim", () => {
  it("supports a product specification from a maker record", () => {
    expect(assessClaim({ text: "The cloth is 410 g/m2 moleskin.", kind: "product_specification", support: [makerRecord] }))
      .toEqual({ status: "supported", uncertainty: null });
  });

  it("treats a specification found only in retailer copy as a maker claim", () => {
    const result = assessClaim({ text: "The cloth is 410 g/m2 moleskin.", kind: "product_specification", support: [retailerCopy] });
    expect(result.status).toBe("maker_claim_only");
    expect(result.uncertainty).toContain("no maker record");
  });

  it("supports a historical claim from archival, museum, scholarly or primary material", () => {
    for (const sourceClass of ["archival", "museum", "scholarly", "primary"] as const) {
      expect(assessClaim({ text: "Blue work jackets existed by 1910.", kind: "historical", support: [{ ...museum, sourceClass }] }))
        .toEqual({ status: "supported", uncertainty: null });
    }
  });

  it("keeps a maker's origin story apart from independently supported history", () => {
    for (const support of [[originStory], [retailerCopy], [makerRecord], [originStory, blog]]) {
      const result = assessClaim({ text: "Railway workers wore it from 1890.", kind: "historical", support });
      expect(result.status).toBe("maker_claim_only");
      expect(result.uncertainty).toContain("own account");
    }
    expect(assessClaim({ text: "Railway workers wore it from 1890.", kind: "historical", support: [originStory, archive] }).status).toBe("supported");
  });

  it("reports a claim with nothing behind it as unsupported, with the uncertainty stated", () => {
    const none = assessClaim({ text: "Students adopted it in 1968.", kind: "historical", support: [] });
    expect(none.status).toBe("unsupported");
    expect(none.uncertainty).toContain("do not establish");
    const secondaryOnly = assessClaim({ text: "Students adopted it in 1968.", kind: "historical", support: [blog] });
    expect(secondaryOnly.status).toBe("unsupported");
    expect(secondaryOnly.uncertainty).toContain("secondary");
  });

  it("does not count support without a passage, without a URL, or marked unsourced", () => {
    const support: ClaimSupport[] = [{ ...museum, passage: " " }, { ...archive, url: "" }, { ...museum, sourceClass: "unsourced" }];
    expect(assessClaim({ text: "Blue work jackets existed by 1910.", kind: "historical", support }).status).toBe("unsupported");
  });
});

describe("exploreHypothesis", () => {
  const hypothesis = "The French chore coat was a symbol of the 1968 student movement";
  const claims: HypothesisClaim[] = [
    { text: "Students adopted the jacket in 1968.", kind: "historical", support: [blog], period: "1968" },
    { text: "Mail-order catalogues sold blue moleskin work jackets.", kind: "historical", support: [archive], linksHypothesis: false },
    { text: "The maker's jacket was worn by railway workers from 1890.", kind: "historical", support: [originStory], period: "1890" },
    { text: "Blue work jackets were in use by 1910.", kind: "historical", support: [museum, retailerCopy], linksHypothesis: false },
  ];

  it("orders supported claims into a chronology and lists what is not established", () => {
    const result = exploreHypothesis(hypothesis, claims);
    expect(result.chronology.map((c) => [c.date, c.text])).toEqual([
      ["1910", "Blue work jackets were in use by 1910."],
      ["1925", "Mail-order catalogues sold blue moleskin work jackets."],
    ]);
    // Only the establishing source is cited; the retailer copy is not presented as evidence.
    expect(result.chronology[0]?.sources.map((s) => s.sourceClass)).toEqual(["museum"]);
    expect(result.unestablishedLinks.map((l) => [l.text, l.status])).toEqual([
      ["Students adopted the jacket in 1968.", "unsupported"],
      ["The maker's jacket was worn by railway workers from 1890.", "maker_claim_only"],
    ]);
    expect(result.unestablishedLinks.every((l) => l.uncertainty.length > 0)).toBe(true);
    expect(result.premiseEstablished).toBe(false);
    expect(result.summary).toContain("do not establish");
  });

  it("assesses each claim exactly as it would be assessed without the hypothesis", () => {
    const result = exploreHypothesis(hypothesis, claims);
    for (const claim of claims) {
      const alone = assessClaim(claim);
      const inChronology = result.chronology.some((c) => c.text === claim.text);
      expect(inChronology).toBe(alone.status === "supported");
    }
  });

  it("establishes the premise only when every link has independent support", () => {
    const supported: HypothesisClaim[] = [{ text: "Students wore the jacket at the 1968 marches.", kind: "historical", support: [{ ...archive, date: "1968-05" }] }];
    expect(exploreHypothesis(hypothesis, supported).premiseEstablished).toBe(true);
    expect(exploreHypothesis(hypothesis, []).premiseEstablished).toBe(false);
    const backgroundOnly = exploreHypothesis(hypothesis, [{ ...supported[0]!, linksHypothesis: false }]);
    expect(backgroundOnly.premiseEstablished).toBe(false);
    expect(backgroundOnly.chronology).toHaveLength(1);
  });
});
