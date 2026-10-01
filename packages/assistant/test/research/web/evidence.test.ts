import { describe, it, expect } from "vitest";
import {
  classifyExtraction,
  deriveAvailability,
  evidenceEnvelopeSchema,
  isExactVariantMatch,
  isObservationStale,
  requiresRefreshBeforePurchase,
} from "../../../src/research/web/index.ts";

const PRODUCT_PAGE = [
  "# Harris Tweed Overcoat",
  "A single-breasted overcoat cut from handwoven Harris Tweed with a half canvas construction and horn buttons.",
  "Composition: 100% pure new wool. Lining: 100% viscose.",
  "Care: dry clean only. Do not tumble dry.",
  "Made in Scotland. Product code HT-4471.",
].join("\n");

const FIELDS = [
  { name: "composition", pattern: /composition:/i },
  { name: "care", pattern: /care:/i },
];

describe("classifyExtraction", () => {
  it("is complete when every expected field appears", () => {
    const result = classifyExtraction(PRODUCT_PAGE, FIELDS);
    expect(result.completeness).toBe("complete");
    expect(result.missingFields).toEqual([]);
  });

  it("lists missing expected fields instead of inventing them", () => {
    const result = classifyExtraction(PRODUCT_PAGE, [...FIELDS, { name: "size_chart", pattern: /chest \(cm\)/i }]);
    expect(result.completeness).toBe("partial");
    expect(result.missingFields).toEqual(["size_chart"]);
  });

  it("fails bot challenges, cookie walls and access-denied pages even though the response succeeded", () => {
    const challenges = [
      "Just a moment... We are verifying your connection before you can continue to shop.example.com. This may take a few seconds. Ray ID 8a1b2c3d4e5f.",
      "Checking your browser before accessing the site. Please wait while we make sure that your connection is secure and not automated.",
      "Please complete the CAPTCHA below to show us that you are not a robot and continue browsing our online store today. Thank you.",
      "You need to enable JavaScript to run this app. Please enable JavaScript in your browser settings and reload the page to continue.",
      "Access Denied. You don't have permission to access this resource on this server. Reference #18.2f3b1002.1700000000.1a2b3c4d",
      "We use cookies to improve your experience. Accept all cookies or manage your cookie settings to continue to the website you requested.",
    ];
    for (const content of challenges) {
      const result = classifyExtraction(content, FIELDS);
      expect(result.completeness, content).toBe("failed");
      expect(result.missingFields, content).toEqual(["composition", "care"]);
    }
  });

  it("fails very little text and navigation-only content", () => {
    expect(classifyExtraction("Overcoat", []).completeness).toBe("failed");
    const navigation = [
      "[Home](https://shop.example.com/)",
      "[New arrivals](https://shop.example.com/new)",
      "[Coats](https://shop.example.com/coats)",
      "[Knitwear](https://shop.example.com/knitwear)",
      "[Trousers](https://shop.example.com/trousers)",
      "Sign in",
      "Basket",
      "Search",
      "[Stores](https://shop.example.com/stores)",
      "[Help](https://shop.example.com/help)",
    ].join("\n");
    const result = classifyExtraction(navigation, FIELDS);
    expect(result.completeness).toBe("failed");
    expect(result.reason).toContain("navigation");
  });

  it("does not fail a long real page that merely mentions cookies", () => {
    const long = `${PRODUCT_PAGE}\n${"The cloth is woven by hand in the Outer Hebrides and finished in Stornoway. ".repeat(25)}\nWe use cookies.`;
    expect(classifyExtraction(long, FIELDS).completeness).toBe("complete");
  });

  it("works with global patterns repeatedly", () => {
    const fields = [{ name: "composition", pattern: /composition:/gi }];
    expect(classifyExtraction(PRODUCT_PAGE, fields).completeness).toBe("complete");
    expect(classifyExtraction(PRODUCT_PAGE, fields).completeness).toBe("complete");
  });
});

describe("deriveAvailability", () => {
  it("is unknown for a live page without an observed size and colour selection", () => {
    expect(deriveAvailability({ pageLive: true, observedSize: null, observedColour: null, inStockSignal: true })).toEqual({
      state: "unknown",
      size: null,
      colour: null,
    });
    expect(deriveAvailability({ pageLive: true, observedSize: "M", observedColour: null, inStockSignal: true }).state).toBe("unknown");
    expect(deriveAvailability({ pageLive: true, observedSize: " ", observedColour: "Navy", inStockSignal: true }).state).toBe("unknown");
  });

  it("reports the observed variant only when size, colour and a stock signal were all observed", () => {
    expect(deriveAvailability({ pageLive: true, observedSize: "M", observedColour: "Navy", inStockSignal: true })).toEqual({
      state: "available",
      size: "M",
      colour: "Navy",
    });
    expect(deriveAvailability({ pageLive: true, observedSize: "M", observedColour: "Navy", inStockSignal: false }).state).toBe("unavailable");
    expect(deriveAvailability({ pageLive: true, observedSize: "M", observedColour: "Navy", inStockSignal: null }).state).toBe("unknown");
    expect(deriveAvailability({ pageLive: false, observedSize: "M", observedColour: "Navy", inStockSignal: true }).state).toBe("unknown");
  });
});

describe("observation freshness", () => {
  const now = Date.parse("2025-03-10T12:00:00Z");

  it("marks observations older than the maximum age, and unreadable timestamps, as stale", () => {
    expect(isObservationStale("2025-03-10T00:00:00Z", now, 24)).toBe(false);
    expect(isObservationStale("2025-03-09T11:59:59Z", now, 24)).toBe(true);
    expect(isObservationStale("yesterday-ish", now, 24)).toBe(true);
  });

  it("requires a refresh before purchase after 15 minutes by default", () => {
    expect(requiresRefreshBeforePurchase("2025-03-10T11:50:00Z", now)).toBe(false);
    expect(requiresRefreshBeforePurchase("2025-03-10T11:44:59Z", now)).toBe(true);
    expect(requiresRefreshBeforePurchase("2025-03-10T11:50:00Z", now, 5)).toBe(true);
    expect(requiresRefreshBeforePurchase("", now)).toBe(true);
  });
});

describe("isExactVariantMatch", () => {
  const wanted = { productCode: "HT-4471", colour: "Navy", size: "M" };

  it("matches after normalizing case, whitespace and code separators", () => {
    expect(isExactVariantMatch({ productCode: "ht 4471", colour: " navy ", size: "m" }, wanted)).toBe(true);
  });

  it("refuses a similar colour, another size or another product code", () => {
    expect(isExactVariantMatch({ productCode: "HT-4471", colour: "Dark Navy", size: "M" }, wanted)).toBe(false);
    expect(isExactVariantMatch({ productCode: "HT-4471", colour: "Midnight Blue", size: "M" }, wanted)).toBe(false);
    expect(isExactVariantMatch({ productCode: "HT-4471", colour: "Navy", size: "L" }, wanted)).toBe(false);
    expect(isExactVariantMatch({ productCode: "HT-4472", colour: "Navy", size: "M" }, wanted)).toBe(false);
  });

  it("refuses when a value is missing on either side", () => {
    expect(isExactVariantMatch({ productCode: "HT-4471", colour: null, size: "M" }, wanted)).toBe(false);
    expect(isExactVariantMatch({ productCode: "", colour: "", size: "" }, { productCode: "", colour: "", size: "" })).toBe(false);
  });
});

describe("evidenceEnvelopeSchema", () => {
  const envelope = {
    canonicalUrl: "https://shop.example.com/coat",
    finalUrl: "https://shop.example.com/coat",
    retrievedAt: "2025-03-10T12:00:00.000Z",
    content: PRODUCT_PAGE,
    imageCandidates: [{ url: "https://shop.example.com/coat.jpg" }],
    selectedVariant: null,
    method: "tavily_basic",
    completeness: "complete",
    sourceAnchors: [{ label: "composition", quote: "Composition: 100% pure new wool." }],
    failures: [],
    extractor: "tavily-extract",
    missingFields: [],
  };

  it("accepts a well-formed envelope and rejects a non-UTC time or unknown method", () => {
    expect(evidenceEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(evidenceEnvelopeSchema.safeParse({ ...envelope, retrievedAt: "2025-03-10T12:00:00+01:00" }).success).toBe(false);
    expect(evidenceEnvelopeSchema.safeParse({ ...envelope, method: "guess" }).success).toBe(false);
  });
});
