/**
 * Hard constraints, proven against the REAL owner fixture (the supplied profile and the real inventory
 * imported through the command service) on real local D1. Synthetic owners appear only where a
 * boundary needs a garment or an activated rule the real data does not contain; they are labelled.
 * The only stand-in is the labelled fake weather provider behind the weather port.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@garderobe/contracts";
import type { OutfitValidation } from "@garderobe/contracts/ext/daily";
import type { TestOwner } from "@garderobe/domain/testing";
import { fetchWeatherSnapshot, suggestOutfits, temperaturePreview, validateOutfit } from "../src/index.ts";
import { createDailyHarness, garmentsByName, realOwner, syntheticOwner, system, type DailyHarness } from "./helpers.ts";

let h: DailyHarness;
let owner: TestOwner;
let id: (name: string) => string;
let nextDay = 0;

/** Record a forecast for a fresh date: `departure` at 08:00, `peak` mid-afternoon. Returns the date. */
async function day(departure: number, peak: number, who: TestOwner = owner): Promise<string> {
  const date = `2026-10-${String(1 + nextDay++).padStart(2, "0")}`;
  h.weather.setForecast(date, { temperatureByHour: { 0: departure, 8: departure, 14: peak, 19: Math.min(departure, peak), 23: Math.min(departure, peak) } });
  await fetchWeatherSnapshot(h.deps, await system(h, who), { localDate: date, purpose: "adhoc" });
  return date;
}

const SNEAKER = "NB 990v4 — grey";
const SOCKS = "Merino — inky blue";

function slots(parts: Partial<Record<Role, string>>): { role: Role; garmentId: string }[] {
  const all: Partial<Record<Role, string>> = { footwear: SNEAKER, socks: SOCKS, ...parts };
  return (Object.entries(all) as [Role, string | undefined][]).filter(([, name]) => name).map(([role, name]) => ({ role, garmentId: id(name!) }));
}

const codes = (v: OutfitValidation) => v.violations.filter((x) => x.severity === "blocking").map((x) => x.code).sort();

beforeAll(async () => {
  h = await createDailyHarness({ startAt: "2026-09-15T08:00:00Z" });
  owner = await realOwner(h);
  const byName = await garmentsByName(h, owner);
  id = (name) => {
    const g = byName.get(name);
    if (!g) throw new Error(`no imported garment named "${name}"; names: ${[...byName.keys()].filter((n) => n.startsWith(name.slice(0, 6))).join(" | ")}`);
    return g.garment_id;
  };
});

describe("profile 8.1: socks always", () => {
  it("rejects an outfit without socks, in any weather, and accepts the same outfit with them", async () => {
    for (const [departure, peak] of [[14, 31], [2, 6]] as const) {
      const date = await day(departure, peak);
      const top = peak > 22 ? "Lightweight oxford — gold" : "Lightweight oxford — gold";
      const without = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ top, bottom: "Di Sondrio beige chino", socks: undefined }) });
      expect(codes(without)).toEqual(["socks_required"]);
      expect(without.violations.find((x) => x.code === "socks_required")!.ruleKey).toBe("socks.required");
      const withSocks = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ top, bottom: "Di Sondrio beige chino" }) });
      expect(withSocks.valid).toBe(true);
    }
  });

  it("keeps the indoor-only bed sock out of an ordinary outfit", async () => {
    const date = await day(4, 8);
    const v = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ top: "Lightweight oxford — gold", bottom: "Di Sondrio beige chino", socks: "Alpaca bed sock — clotted cream" }) });
    expect(codes(v)).toEqual(["conditional_not_requested"]);
  });
});

describe("profile 8.2 and 8.3: sneakers only until he says his feet have healed", () => {
  it("rejects every welted shoe and the boot while the restriction is active", async () => {
    const date = await day(12, 18);
    for (const shoe of ["Paraboot Reims — noir (black)", "Paraboot Reims — café/marron", "Paraboot Michael Cerf", "Drake's Clifford boot"]) {
      const v = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ top: "Lightweight oxford — gold", bottom: "Di Sondrio beige chino", footwear: shoe }) });
      expect(v.valid, shoe).toBe(false);
      expect(codes(v), shoe).toContain("restricted");
      expect(codes(v), shoe).toContain("footwear_restricted");
    }
  });

  it("does not lift the restriction for an explicit request, a welted alternative, or Explore-for-today", async () => {
    const date = await day(12, 18);
    const base = { top: "Lightweight oxford — gold", bottom: "Di Sondrio beige chino" };
    const explicit = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ ...base, footwear: "Paraboot Michael Cerf" }), explicitGarmentIds: [id("Paraboot Michael Cerf")] });
    expect(explicit.valid).toBe(false);
    const alternative = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots(base), footwearAlternatives: [id("Paraboot Michael Cerf")] });
    expect(codes(alternative)).toContain("restricted");
    // Explore shows the look but says plainly that it is not wearable today.
    const explore = await validateOutfit(h.db, owner.principal(), { forDate: date, mode: "explore", slots: slots({ ...base, footwear: "Paraboot Michael Cerf" }) });
    expect(explore.valid).toBe(true);
    expect(explore.evidence.wearableToday).toBe(false);
    expect(explore.violations.some((x) => x.code === "restricted" && x.severity === "advisory")).toBe(true);
  });

  it("SYNTHETIC: excludes the 990v6 by model while its sneakers-only rule and restriction are active", async () => {
    const synthetic = await syntheticOwner(h);
    await synthetic.exec("restriction.add", { restrictionId: "rst_syn_heal", kind: "healing", scope: { anyOf: [{ category: "footwear", footwearKinds: ["welted", "boot", "other"] }, { models: ["990v6"] }] }, reason: "synthetic healing restriction", source: { kind: "owner_statement" } });
    const date = await day(12, 18, synthetic);
    const outfit = (shoe: string) => [{ role: "top" as const, garmentId: "shirt-moss" }, { role: "bottom" as const, garmentId: "trouser-olive" }, { role: "socks" as const, garmentId: "sock-grey" }, { role: "footwear" as const, garmentId: shoe }];
    expect((await validateOutfit(h.db, synthetic.principal(), { forDate: date, slots: outfit("shoe-990v6") })).valid).toBe(false);
    expect((await validateOutfit(h.db, synthetic.principal(), { forDate: date, slots: outfit("shoe-welted") })).valid).toBe(false);
    expect((await validateOutfit(h.db, synthetic.principal(), { forDate: date, slots: outfit("shoe-navy") })).valid).toBe(true);
  });

  it("only the owner's explicit statement lifts it; then welted shoes return and boards must pair a sneaker with a welted alternative", async () => {
    const hh = await createDailyHarness({ startAt: "2026-09-15T08:00:00Z" });
    const o = await realOwner(hh);
    const names = await garmentsByName(hh, o);
    const g = (n: string) => names.get(n)!.garment_id;
    const outfit = (shoe: string) => [{ role: "top" as const, garmentId: g("Lightweight oxford — gold") }, { role: "bottom" as const, garmentId: g("Di Sondrio beige chino") }, { role: "socks" as const, garmentId: g(SOCKS) }, { role: "footwear" as const, garmentId: g(shoe) }];
    // A scheduled job cannot resolve it, and time passing does nothing.
    await expect(o.exec("restriction.resolve", { restrictionId: "rst_profile_sneakers_only", evidence: { kind: "system" } }, { actor: "system", channel: "scheduled", authorization: "system_schedule" })).rejects.toMatchObject({ code: "forbidden" });
    hh.clock.set("2027-03-01T08:00:00Z");
    expect((await validateOutfit(hh.db, o.principal(), { forDate: "2027-03-01", slots: outfit("Paraboot Michael Cerf"), nowMs: hh.clock.now() })).valid).toBe(false);

    await o.exec("restriction.resolve", { restrictionId: "rst_profile_sneakers_only", evidence: { kind: "owner_statement", note: "my feet have healed" } });
    const welted = await validateOutfit(hh.db, o.principal(), { forDate: "2027-03-01", slots: outfit("Paraboot Michael Cerf"), nowMs: hh.clock.now() });
    expect(welted.valid).toBe(true);
    // The dormant pairing rule is now in force: a sneaker-only outfit is flagged for lacking the welted option.
    const sneakerOnly = await validateOutfit(hh.db, o.principal(), { forDate: "2027-03-01", slots: outfit(SNEAKER), nowMs: hh.clock.now() });
    expect(sneakerOnly.violations.map((x) => x.code)).toContain("paired_footwear_required");
    const paired = await validateOutfit(hh.db, o.principal(), { forDate: "2027-03-01", slots: outfit(SNEAKER), footwearAlternatives: [g("Paraboot Michael Cerf")], nowMs: hh.clock.now() });
    expect(paired.violations.map((x) => x.code)).not.toContain("paired_footwear_required");
  });
});

describe("profile 8.4: the thermal rule", () => {
  it("judges shirts and trousers on the day's peak, never the morning low", async () => {
    // Pima oxford is kept to 22 C in the sheet. A 5 C start does not rescue it at a 23 C peak...
    const hot = await day(5, 23);
    const tooWarm = await validateOutfit(h.db, owner.principal(), { forDate: hot, slots: slots({ top: "Pima oxford — navy", bottom: "Di Sondrio beige chino" }) });
    expect(codes(tooWarm)).toEqual(["thermal_too_warm"]);
    expect(tooWarm.violations[0]!.ruleKey).toBe("thermal.base_layers_follow_daytime_peak");
    // ...and exactly 22 C at the peak is inside the bound.
    const boundary = await day(5, 22);
    expect((await validateOutfit(h.db, owner.principal(), { forDate: boundary, slots: slots({ top: "Pima oxford — navy", bottom: "Di Sondrio beige chino" }) })).valid).toBe(true);
  });

  it("a day that starts at 11 and reaches 19 is a 19-degree outfit: the 30-degree linen trousers are rejected, and accepted at 30", async () => {
    const mild = await day(11, 19);
    const v = await validateOutfit(h.db, owner.principal(), { forDate: mild, slots: slots({ top: "Lightweight oxford — gold", bottom: "Palermo linen drawstring — neutral" }) });
    expect(codes(v)).toEqual(["thermal_too_cold"]);
    expect(v.evidence.conditions).toMatchObject({ peakC: 19, departureC: 11 });
    const heat = await day(21, 30);
    expect((await validateOutfit(h.db, owner.principal(), { forDate: heat, slots: slots({ top: "Lightweight oxford — gold", bottom: "Palermo linen drawstring — neutral" }) })).valid).toBe(true);
    const justUnder = await day(21, 29.9);
    expect((await validateOutfit(h.db, owner.principal(), { forDate: justUnder, slots: slots({ top: "Lightweight oxford — gold", bottom: "Palermo linen drawstring — neutral" }) })).valid).toBe(false);
  });

  it("only outerwear answers the morning: a 10-22 C jacket is fine for a 12 C start on a 27 C day and rejected for a 23 C start", async () => {
    const coolStart = await day(12, 27);
    const ok = await validateOutfit(h.db, owner.principal(), { forDate: coolStart, slots: slots({ outer: "Drake's Olive Jungle Jacket", top: "Lightweight oxford — gold", bottom: "Di Sondrio beige chino" }) });
    expect(ok.valid).toBe(true);
    const warmStart = await day(23, 27);
    const no = await validateOutfit(h.db, owner.principal(), { forDate: warmStart, slots: slots({ outer: "Drake's Olive Jungle Jacket", top: "Lightweight oxford — gold", bottom: "Di Sondrio beige chino" }) });
    expect(codes(no)).toEqual(["thermal_too_warm"]);
    expect(no.violations[0]!.ruleKey).toBe("thermal.outerwear_follows_morning");
    const tooCold = await day(9.9, 15);
    expect(codes(await validateOutfit(h.db, owner.principal(), { forDate: tooCold, slots: slots({ outer: "Drake's Olive Jungle Jacket", top: "Lightweight oxford — gold", bottom: "Di Sondrio beige chino" }) }))).toEqual(["thermal_too_cold"]);
  });

  it("at 14 to 16 C outdoors a jacket goes over a lightweight oxford only: inclusive boundaries on the jacket interval", async () => {
    const heavy = { outer: "Drake's Olive Jungle Jacket", top: "Pima oxford — navy", bottom: "Di Sondrio beige chino" };
    const light = { ...heavy, top: "Lightweight oxford — gold" };
    const expected: [number, boolean][] = [[13.9, true], [14, false], [15, false], [16, false], [16.1, true]];
    for (const [departure, heavyAllowed] of expected) {
      const date = await day(departure, 20);
      const v = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots(heavy) });
      expect(v.valid, `heavy shirt under a jacket at ${departure} C`).toBe(heavyAllowed);
      if (!heavyAllowed) {
        expect(codes(v)).toEqual(["jacket_band_requires_lightweight_oxford"]);
        expect(v.violations[0]!.ruleKey).toBe("thermal.jacket_14_16_lightweight_oxford_only");
      }
      expect((await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots(light) })).valid, `lightweight oxford under a jacket at ${departure} C`).toBe(true);
    }
  });

  it("a 12 C departure with a 15 C or 17 C peak does not trigger the jacket rule: it is the jacket interval, not the daily maximum", async () => {
    for (const peak of [15, 17]) {
      const date = await day(12, peak);
      const v = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ outer: "Drake's Olive Jungle Jacket", top: "Pima oxford — navy", bottom: "Di Sondrio beige chino" }) });
      expect(v.valid, `peak ${peak}`).toBe(true);
    }
  });

  it("a shirt of unknown weight is not assumed to be a lightweight oxford inside the band, and the heavy shirt alone needs no jacket", async () => {
    const date = await day(15, 20);
    const clark = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ outer: "Drake's Olive Jungle Jacket", top: "Clark oxford — beige", bottom: "Di Sondrio grey chino" }) });
    expect(codes(clark)).toEqual(["jacket_band_requires_lightweight_oxford"]);
    const noJacket = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ top: "Pima oxford — navy", bottom: "Di Sondrio beige chino" }) });
    expect(noJacket.valid).toBe(true);
  });

  it("with no forecast nothing is assumed: bounds are reported as unverified, not as passed-because-warm, and a jacket over a heavier shirt is not offered", async () => {
    const v = await validateOutfit(h.db, owner.principal(), { forDate: "2026-11-20", slots: slots({ outer: "Drake's Olive Jungle Jacket", top: "Pima oxford — navy", bottom: "Di Sondrio beige chino" }) });
    expect(v.evidence.conditions).toMatchObject({ freshness: "unavailable", peakC: null, departureC: null });
    const advisory = v.violations.filter((x) => x.severity === "advisory").map((x) => x.code);
    expect(advisory).toContain("thermal_unverified");
    // The 14-16 C band cannot be ruled out, so the combination is refused rather than waved through.
    expect(codes(v)).toEqual(["jacket_band_unverified"]);
  });

  it("research rules absent from the profile are retained but NOT enforced until reconciled", async () => {
    const date = await day(12, 19);
    const v = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ top: "Cotton-linen oxford — blue stripe", bottom: "Di Sondrio beige chino" }) });
    expect(v.valid).toBe(true);
    const notEnforced = ((v.evidence as any).rulesNotEnforced as { key: string; status: string }[]).filter((r) => r.status === "pending_reconciliation").map((r) => r.key);
    expect(notEnforced).toEqual(expect.arrayContaining(["thermal.cotton_linen_from", "thermal.pure_linen_from", "thermal.lightweight_oxford_floor", "thermal.outerwear_ceiling", "thermal.alpaca_socks_cold_only"]));
  });

  it("SYNTHETIC: the research rules the profile does not contain are enforced at their stated boundaries once activated, and an unsettled basis is still not guessed", async () => {
    const synthetic = await h.createSyntheticOwner({
      settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never,
      garments: [
        { id: "shirt-lwo", name: "synthetic lightweight oxford", category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass: "lightweight_oxford" } },
        { id: "shirt-linen", name: "synthetic pure linen shirt", category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass: "pure_linen" } },
        { id: "trouser", name: "synthetic chinos", category: "trousers", roles: ["bottom"], careChannel: "service" },
        { id: "jacket", name: "synthetic work jacket", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true } },
        { id: "sock-merino", name: "synthetic merino socks", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3, attributes: { fabricClass: "merino" } },
        { id: "sock-alpaca", name: "synthetic alpaca socks", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 2, attributes: { fabricClass: "alpaca" } },
        { id: "shoe", name: "synthetic sneakers", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
      ],
    });
    const activate = (key: string, params: Record<string, unknown>) => synthetic.exec("style.upsert_rule", { key, kind: "hard", status: "active", params, interpretation: "synthetic activation for a boundary test", origin: "owner_direction" });
    await activate("thermal.pure_linen_from", { fabricClass: "pure_linen", minC: 30, basis: "daytime_peak" });
    await activate("thermal.lightweight_oxford_floor", { fabricClass: "lightweight_oxford", minC: 10, basis: "daytime_peak" });
    await activate("thermal.alpaca_socks_cold_only", { fabricClass: "alpaca", maxC: 12, basis: "daytime_peak" });
    await activate("thermal.outerwear_ceiling", { maxC: 24, basis: "unsettled" });
    const outfit = (parts: { top?: string; socks?: string; outer?: boolean }) => [
      { role: "top" as const, garmentId: parts.top ?? "shirt-lwo" },
      { role: "bottom" as const, garmentId: "trouser" },
      { role: "socks" as const, garmentId: parts.socks ?? "sock-merino" },
      { role: "footwear" as const, garmentId: "shoe" },
      ...(parts.outer ? [{ role: "outer" as const, garmentId: "jacket" }] : []),
    ];
    const check = async (departure: number, peak: number, parts: Parameters<typeof outfit>[0]) => codes(await validateOutfit(h.db, synthetic.principal(), { forDate: await day(departure, peak, synthetic), slots: outfit(parts) }));

    expect(await check(20, 29.9, { top: "shirt-linen" })).toEqual(["fabric_rule"]);
    expect(await check(20, 30, { top: "shirt-linen" })).toEqual([]);
    expect(await check(4, 9.9, {})).toEqual(["fabric_rule"]); // lightweight oxford below its 10 C floor
    expect(await check(4, 10, {})).toEqual([]); // and kept in the pool at the boundary
    expect(await check(8, 12, { socks: "sock-alpaca" })).toEqual([]);
    expect(await check(8, 12.1, { socks: "sock-alpaca" })).toEqual(["fabric_rule"]);
    // The ceiling's basis (morning or peak) is unsettled: it is reported, not silently applied either way.
    const unsettled = await validateOutfit(h.db, synthetic.principal(), { forDate: await day(25, 31), slots: outfit({ top: "shirt-linen", outer: true }) });
    expect(unsettled.valid).toBe(true);
    expect((unsettled.evidence as any).rulesNotEnforced).toContainEqual({ key: "thermal.outerwear_ceiling", status: "active_basis_unsettled" });
    // Once the owner settles it on the outdoor interval, 24 C is allowed and 24.1 C is not.
    await activate("thermal.outerwear_ceiling", { maxC: 24, basis: "outdoor_interval" });
    expect(await check(24, 31, { top: "shirt-linen", outer: true })).toEqual([]);
    expect(await check(24.1, 31, { top: "shirt-linen", outer: true })).toEqual(["outerwear_ceiling"]);
  });

  it("SYNTHETIC: an owner's layer-combination rule rejects two individually eligible pieces that are too warm together, and only inside its band", async () => {
    const synthetic = await h.createSyntheticOwner({
      settings: { homeLocation: { label: "London", latitude: 51.5085, longitude: -0.1257 } } as never,
      garments: [
        { id: "shirt-flannel", name: "synthetic flannel shirt", category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass: "flannel" } },
        { id: "shirt-lwo", name: "synthetic lightweight oxford", category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass: "lightweight_oxford" } },
        { id: "trouser", name: "synthetic chinos", category: "trousers", roles: ["bottom"], careChannel: "service" },
        { id: "coat-wool", name: "synthetic heavy wool coat", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true, fabricClass: "wool" } },
        { id: "jacket-twill", name: "synthetic twill jacket", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true, fabricClass: "twill" } },
        { id: "sock", name: "synthetic merino socks", category: "socks", roles: ["socks"], careChannel: "handwash", quantity: 3 },
        { id: "shoe", name: "synthetic sneakers", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
      ],
    });
    await synthetic.exec("style.upsert_rule", { key: "layering.wool_coat_over_flannel", kind: "hard", status: "active", params: { basis: "outdoor_interval", minC: 10, pieces: { outer: { fabricClasses: ["wool"] }, top: { fabricClasses: ["flannel"] } } }, interpretation: "synthetic comfort rule: a heavy wool coat over flannel is too warm from 10 C outdoors", origin: "owner_direction" });
    const outfit = (top: string, outer: string) => [{ role: "top" as const, garmentId: top }, { role: "bottom" as const, garmentId: "trouser" }, { role: "socks" as const, garmentId: "sock" }, { role: "footwear" as const, garmentId: "shoe" }, { role: "outer" as const, garmentId: outer }];
    const at10 = await day(10, 13, synthetic);
    const together = await validateOutfit(h.db, synthetic.principal(), { forDate: at10, slots: outfit("shirt-flannel", "coat-wool") });
    expect(codes(together)).toEqual(["too_warm_together"]);
    expect(together.violations[0]).toMatchObject({ ruleKey: "layering.wool_coat_over_flannel", garmentIds: ["coat-wool", "shirt-flannel"] });
    // Each piece is fine on its own terms the same day.
    expect((await validateOutfit(h.db, synthetic.principal(), { forDate: at10, slots: outfit("shirt-lwo", "coat-wool") })).valid).toBe(true);
    expect((await validateOutfit(h.db, synthetic.principal(), { forDate: at10, slots: outfit("shirt-flannel", "jacket-twill") })).valid).toBe(true);
    // Below the band the same pair is allowed.
    expect((await validateOutfit(h.db, synthetic.principal(), { forDate: await day(9.9, 13, synthetic), slots: outfit("shirt-flannel", "coat-wool") })).valid).toBe(true);
  });

  it("SYNTHETIC: once the owner activates a fabric rule it is enforced at its boundary (cotton-linen from 28 C at the peak)", async () => {
    const synthetic = await syntheticOwner(h);
    await synthetic.exec("style.upsert_rule", { key: "thermal.cotton_linen_from", kind: "hard", status: "active", params: { fabricClass: "cotton_linen", minC: 28, basis: "daytime_peak" }, interpretation: "synthetic activation for a boundary test", origin: "owner_direction" });
    const outfit = [{ role: "top" as const, garmentId: "shirt-blue-stripe-b" }, { role: "bottom" as const, garmentId: "trouser-olive" }, { role: "socks" as const, garmentId: "sock-grey" }, { role: "footwear" as const, garmentId: "shoe-navy" }];
    const under = await day(20, 27.9, synthetic);
    expect(codes(await validateOutfit(h.db, synthetic.principal(), { forDate: under, slots: outfit }))).toEqual(["fabric_rule"]);
    const at = await day(20, 28, synthetic);
    expect((await validateOutfit(h.db, synthetic.principal(), { forDate: at, slots: outfit })).valid).toBe(true);
  });
});

describe("profile 8.5: the variety horizon is the week", () => {
  it("a shirt worn seven days ago is a repeat; eight days ago is not; an explicit exception is scoped to the request", async () => {
    const hh = await createDailyHarness({ startAt: "2026-09-15T08:00:00Z" });
    const o = await realOwner(hh);
    const names = await garmentsByName(hh, o);
    const g = (n: string) => names.get(n)!.garment_id;
    const shirt = g("Lightweight oxford — gold");
    await o.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: [shirt] });
    const nowMs = hh.clock.now();
    const outfit = [{ role: "top" as const, garmentId: shirt }, { role: "bottom" as const, garmentId: g("Di Sondrio beige chino") }, { role: "socks" as const, garmentId: g(SOCKS) }, { role: "footwear" as const, garmentId: g(SNEAKER) }];
    // The override relaxes the repeat preference only: it cannot make a shirt that is still awaiting care present.
    expect(codes(await validateOutfit(hh.db, o.principal(), { forDate: "2026-09-17", slots: outfit, allowRepeat: true, nowMs }))).toEqual(["unavailable"]);
    await o.exec("care.washed", { items: [{ garmentId: shirt }] });
    const onDay7 = await validateOutfit(hh.db, o.principal(), { forDate: "2026-09-22", slots: outfit, nowMs });
    expect(codes(onDay7)).toEqual(["repeat_within_horizon"]);
    expect(onDay7.violations[0]!.ruleKey).toBe("variety.repeat_horizon");
    expect((await validateOutfit(hh.db, o.principal(), { forDate: "2026-09-23", slots: outfit, nowMs })).valid).toBe(true);
    expect((await validateOutfit(hh.db, o.principal(), { forDate: "2026-09-22", slots: outfit, allowRepeat: true, nowMs })).valid).toBe(true);
    // The exception did not rewrite the rule.
    expect((await validateOutfit(hh.db, o.principal(), { forDate: "2026-09-22", slots: outfit, nowMs })).valid).toBe(false);
  });
});

describe("nothing unavailable, restricted or ineligible is accepted", () => {
  it("rejects invented IDs, wrong roles, benched pieces, occasional pieces unless asked for, and duplicates", async () => {
    const date = await day(12, 18);
    const base = { top: "Lightweight oxford — gold", bottom: "Di Sondrio beige chino" };
    const invented = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: [...slots(base).filter((s) => s.role !== "top"), { role: "top", garmentId: "gmt_invented_by_a_model" }] });
    expect(codes(invented)).toEqual(["unknown_garment"]);
    const wrongRole = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ top: "Di Sondrio grey chino", bottom: "Di Sondrio beige chino" }) });
    expect(codes(wrongRole)).toEqual(["role_mismatch"]);
    const benched = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ ...base, outer: "DBF Traveler — wool" }) });
    expect(codes(benched)).toEqual(["unavailable"]);
    const twice = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: [...slots(base), { role: "mid_layer", garmentId: id("Lightweight oxford — gold") }] });
    expect(codes(twice)).toContain("duplicate_garment");

    const square = { ...base, accessory: "Anglo-Italian pocket square" };
    expect(codes(await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots(square) }))).toEqual(["conditional_not_requested"]);
    expect((await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots(square), explicitGarmentIds: [id("Anglo-Italian pocket square")] })).valid).toBe(true);
  });

  it("a layering-tier shirt is not offered as the base shirt", async () => {
    const date = await day(12, 18);
    const v = await validateOutfit(h.db, owner.principal(), { forDate: date, slots: slots({ top: "ISTO denim shirt", bottom: "Di Sondrio beige chino" }) });
    expect(codes(v)).toEqual(["layering_only"]);
  });

  it("watches and jewellery are absent by choice: one in the wardrobe is real inventory but is never part of an outfit", async () => {
    const hh = await createDailyHarness({ startAt: "2026-09-15T08:00:00Z" });
    const o = await realOwner(hh);
    const names = await garmentsByName(hh, o);
    const g = (n: string) => names.get(n)!.garment_id;
    const created = await o.exec("garment.create", { name: "Steel field watch (synthetic boundary piece)", category: "accessory", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic accessory for a rule test; not the owner's" } });
    const watch = created.affected.find((a) => a.kind === "garment")!.id;
    const base = [{ role: "top" as const, garmentId: g("Lightweight oxford — gold") }, { role: "bottom" as const, garmentId: g("Di Sondrio beige chino") }, { role: "socks" as const, garmentId: g(SOCKS) }, { role: "footwear" as const, garmentId: g(SNEAKER) }];
    const v = await validateOutfit(hh.db, o.principal(), { forDate: "2026-09-16", nowMs: hh.clock.now(), slots: [...base, { role: "accessory", garmentId: watch }], explicitGarmentIds: [watch] });
    expect(codes(v)).toEqual(["accessory_excluded"]);
    expect(v.violations.find((x) => x.code === "accessory_excluded")!.ruleKey).toBe("accessories.no_watches_or_jewellery");
  });

  it("follows the ledger: dirty, at the tailor, retired and not-yet-arrived pieces are rejected until an observation changes the fact", async () => {
    const hh = await createDailyHarness({ startAt: "2026-09-15T08:00:00Z" });
    const o = await realOwner(hh);
    const names = await garmentsByName(hh, o);
    const g = (n: string) => names.get(n)!.garment_id;
    const nowMs = hh.clock.now();
    const check = async (top: string, bottom = "Di Sondrio beige chino") =>
      validateOutfit(hh.db, o.principal(), { forDate: "2026-09-16", nowMs, slots: [{ role: "top", garmentId: g(top) }, { role: "bottom", garmentId: g(bottom) }, { role: "socks", garmentId: g(SOCKS) }, { role: "footwear", garmentId: g(SNEAKER) }] });

    await o.exec("care.mark_dirty", { items: [{ garmentId: g("Lightweight oxford — moss") }] });
    expect(codes(await check("Lightweight oxford — moss"))).toEqual(["unavailable"]);
    await o.exec("care.washed", { items: [{ garmentId: g("Lightweight oxford — moss") }] });
    expect((await check("Lightweight oxford — moss")).valid).toBe(true);

    await o.exec("garment.move", { garmentId: g("Lightweight oxford — pink"), to: "tailor" });
    expect(codes(await check("Lightweight oxford — pink"))).toEqual(["unavailable"]);

    await o.exec("garment.retire", { garmentId: g("Lightweight oxford — slate"), disposition: "sold" });
    expect((await check("Lightweight oxford — slate")).valid).toBe(false);

    const ordered = await o.exec("garment.create", { name: "Ordered test oxford (synthetic order line)", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "incoming", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic incoming piece for a boundary test" } });
    const orderedId = ordered.affected.find((a) => a.kind === "garment")!.id;
    const incoming = await validateOutfit(hh.db, o.principal(), { forDate: "2026-09-16", nowMs, slots: [{ role: "top", garmentId: orderedId }, { role: "bottom", garmentId: g("Di Sondrio beige chino") }, { role: "socks", garmentId: g(SOCKS) }, { role: "footwear", garmentId: g(SNEAKER) }] });
    expect(codes(incoming)).toEqual(["unavailable"]);
    await o.exec("garment.receive", { garmentId: orderedId });
    const arrived = await validateOutfit(hh.db, o.principal(), { forDate: "2026-09-16", nowMs, slots: [{ role: "top", garmentId: orderedId }, { role: "bottom", garmentId: g("Di Sondrio beige chino") }, { role: "socks", garmentId: g(SOCKS) }, { role: "footwear", garmentId: g(SNEAKER) }] });
    expect(arrived.valid).toBe(true);
  });

  it("validation of one owner never sees another owner's garments (colliding synthetic IDs)", async () => {
    const a = await syntheticOwner(h);
    const b = await syntheticOwner(h);
    await a.exec("care.mark_dirty", { items: [{ garmentId: "shirt-moss" }] });
    const outfit = [{ role: "top" as const, garmentId: "shirt-moss" }, { role: "bottom" as const, garmentId: "trouser-olive" }, { role: "socks" as const, garmentId: "sock-grey" }, { role: "footwear" as const, garmentId: "shoe-navy" }];
    expect((await validateOutfit(h.db, a.principal(), { forDate: "2026-09-16", slots: outfit, nowMs: h.clock.now() })).valid).toBe(false);
    expect((await validateOutfit(h.db, b.principal(), { forDate: "2026-09-16", slots: outfit, nowMs: h.clock.now() })).valid).toBe(true);
    // The real owner's wardrobe does not contain the synthetic ID at all.
    expect(codes(await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-16", slots: outfit, nowMs: h.clock.now() }))).toContain("unknown_garment");
  });
});

describe("Studio support", () => {
  it("fills the unlocked slots around a locked shirt with valid outfits that all keep the shirt", async () => {
    const date = await day(12, 19);
    const shirt = id("Lightweight oxford — red stripe");
    const suggestions = await suggestOutfits(h.db, owner.principal(), { forDate: date, locked: [{ role: "top", garmentId: shirt }], limit: 4 });
    expect(suggestions.length).toBe(4);
    for (const s of suggestions) {
      expect(s.validation.valid).toBe(true);
      expect(s.slots.find((x) => x.role === "top")!.garmentId).toBe(shirt);
    }
    expect(new Set(suggestions.map((s) => s.slots.find((x) => x.role === "bottom")!.garmentId)).size).toBe(4);
  });

  it("the temperature preview is a labelled simulation that changes nothing", async () => {
    const before = await validateOutfit(h.db, owner.principal(), { forDate: "2026-11-21", slots: slots({ top: "Pima oxford — navy", bottom: "Di Sondrio beige chino" }) });
    const at30 = await temperaturePreview(h.db, owner.principal(), { temperatureC: 30, nowMs: h.clock.now() });
    expect(at30.simulation).toBe(true);
    expect(at30.label).toMatch(/Simulation/);
    expect(at30.wearable.map((g) => g.name)).toContain("Palermo linen drawstring — neutral");
    expect(at30.notWearable.map((g) => g.name)).toContain("Pima oxford — navy");
    const at12 = await temperaturePreview(h.db, owner.principal(), { temperatureC: 12, nowMs: h.clock.now() });
    expect(at12.notWearable.map((g) => g.name)).toContain("Palermo linen drawstring — neutral");
    expect(at12.wearable.map((g) => g.name)).toContain("Pima oxford — navy");
    const after = await validateOutfit(h.db, owner.principal(), { forDate: "2026-11-21", slots: slots({ top: "Pima oxford — navy", bottom: "Di Sondrio beige chino" }) });
    expect(after.violations.map((x) => x.code)).toEqual(before.violations.map((x) => x.code));
  });
});
