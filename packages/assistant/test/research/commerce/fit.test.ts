import { describe, it, expect } from "vitest";
import { assessFit, computeEase, toCm, toIn, DEFAULT_EASE_RANGES } from "../../../src/research/commerce/index.ts";
import type { BodyCircumference, FlatHalf, GarmentCircumference } from "../../../src/research/commerce/index.ts";

const body42: BodyCircumference = { kind: "body_circumference", value: 42, unit: "in", measuredOn: "2025-05-01" };
const halfChest56cm: FlatHalf = { kind: "flat_half", value: 56, unit: "cm" };

describe("unit conversion", () => {
  it("uses exactly 2.54 cm per inch in both directions", () => {
    expect(toCm(10, "in")).toBe(25.4);
    expect(toIn(25.4, "cm")).toBe(10);
    expect(toCm(7, "cm")).toBe(7);
    expect(toIn(7, "in")).toBe(7);
  });
});

describe("computeEase", () => {
  it("doubles a flat half-chest and normalizes units before subtracting", () => {
    const ease = computeEase({ body: body42, garment: halfChest56cm });
    expect(ease.doubledFlatHalf).toBe(true);
    expect(ease.garmentCircumferenceCm).toBe(112);
    expect(ease.garmentCircumferenceIn).toBe(44.09);
    expect(ease.bodyCm).toBe(106.68);
    expect(ease.easeIn).toBe(2.09);
    expect(ease.easeCm).toBe(5.32);
  });

  it("does not double a garment circumference", () => {
    const garment: GarmentCircumference = { kind: "garment_circumference", value: 112, unit: "cm" };
    const ease = computeEase({ body: body42, garment });
    expect(ease.doubledFlatHalf).toBe(false);
    expect(ease.easeIn).toBe(2.09);
  });
});

describe("assessFit", () => {
  it("returns a verdict together with the numbers for each separate dimension", () => {
    const result = assessFit({
      asOf: "2025-06-01",
      sizeLabel: "42R",
      chest: { body: body42, garment: halfChest56cm },
      shoulder: { body: { kind: "linear", value: 18, unit: "in" }, garment: { kind: "linear", value: 47, unit: "cm" } },
    });
    expect(result.verdict).toBe("likely_fits");
    expect(result.computation.chest.differenceIn).toBe(2.09);
    expect(result.computation.chest.garmentIn).toBe(44.09);
    expect(result.computation.chest.desiredRangeIn).toEqual(DEFAULT_EASE_RANGES.chest);
    expect(result.computation.shoulder.differenceIn).toBe(0.5);
    expect(result.computation.shoulder.outcome).toBe("within");
  });

  it("keeps a missing measurement missing and lists it as an uncertainty", () => {
    const result = assessFit({ asOf: "2025-06-01", chest: { body: body42, garment: halfChest56cm } });
    expect(result.computation.waist.status).toBe("missing");
    expect(result.computation.waist.differenceIn).toBeNull();
    expect(result.computation.waist.missing).toEqual(["body", "garment"]);
    expect(result.uncertainties.some((u) => u.startsWith("waist:"))).toBe(true);
    expect(result.uncertainties.some((u) => u.startsWith("sleeve:"))).toBe(true);
  });

  it("cannot determine fit when the decisive garment chest is missing", () => {
    const result = assessFit({
      asOf: "2025-06-01",
      chest: { body: body42 },
      length: { body: { kind: "linear", value: 30, unit: "in" }, garment: { kind: "linear", value: 30, unit: "in" } },
    });
    expect(result.verdict).toBe("cannot_determine");
    expect(result.computation.chest.status).toBe("missing");
    expect(result.computation.chest.bodyIn).toBe(42);
    expect(result.uncertainties.some((u) => u.includes("chest: decisive garment measurement missing"))).toBe(true);
    expect(result.computation.length.outcome).toBe("within");
  });

  it("does not turn a size label alone into a verdict", () => {
    const result = assessFit({ asOf: "2025-06-01", sizeLabel: "L", chest: { body: body42 } });
    expect(result.verdict).toBe("cannot_determine");
    expect(result.reason).toContain("not interchangeable");
    expect(result.uncertainties.some((u) => u.includes("not interchangeable"))).toBe(true);
  });

  it("reports tight and loose against the desired range", () => {
    const tight = assessFit({ asOf: "2025-06-01", chest: { body: body42, garment: { kind: "flat_half", value: 21.5, unit: "in" } } });
    expect(tight.verdict).toBe("likely_tight");
    expect(tight.computation.chest.differenceIn).toBe(1);
    const loose = assessFit({ asOf: "2025-06-01", chest: { body: body42, garment: { kind: "flat_half", value: 24, unit: "in" } } });
    expect(loose.verdict).toBe("likely_loose");
    expect(loose.computation.chest.differenceIn).toBe(6);
  });

  it("applies overridden ranges, stretch and layering to the desired range and notes them", () => {
    const result = assessFit({
      asOf: "2025-06-01",
      chest: { body: body42, garment: { kind: "flat_half", value: 24, unit: "in" } },
      easeRanges: { chest: { minIn: 4, maxIn: 5 } },
      stretch: "some",
      layering: { description: "over knitwear", extraEaseIn: 1 },
      cut: "boxy",
    });
    expect(result.computation.chest.desiredRangeIn).toEqual({ minIn: 4.5, maxIn: 6 });
    expect(result.verdict).toBe("likely_fits");
    expect(result.notes).toHaveLength(3);
  });

  it("flags a stale body measurement only when the ease is near a limit", () => {
    const oldBody: BodyCircumference = { ...body42, measuredOn: "2023-01-01" };
    const near = assessFit({ asOf: "2025-06-01", chest: { body: oldBody, garment: halfChest56cm } });
    expect(near.staleBodyMeasurement).toBe(true);
    expect(near.computation.chest.staleBodyMeasurement).toBe(true);
    expect(near.verdict).toBe("likely_fits");
    expect(near.uncertainties.some((u) => u.includes("days old"))).toBe(true);

    const fresh = assessFit({ asOf: "2025-06-01", chest: { body: body42, garment: halfChest56cm } });
    expect(fresh.staleBodyMeasurement).toBe(false);

    const oldButClear = assessFit({
      asOf: "2025-06-01",
      staleToleranceIn: 0.25,
      chest: { body: oldBody, garment: { kind: "garment_circumference", value: 45, unit: "in" } },
    });
    expect(oldButClear.computation.chest.differenceIn).toBe(3);
    expect(oldButClear.staleBodyMeasurement).toBe(false);

    const withinCustomAge = assessFit({ asOf: "2025-06-01", maxAgeDays: 1000, chest: { body: oldBody, garment: halfChest56cm } });
    expect(withinCustomAge.staleBodyMeasurement).toBe(false);
  });
});
