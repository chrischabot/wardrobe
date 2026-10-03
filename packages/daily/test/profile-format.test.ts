/**
 * The profile's composition verdicts and entry format on real boards (profile sections 4, 5, 9 and 11):
 * merino socks by default, the sock echoing a colour from higher up rather than the trouser, no single
 * neutral three times, the belt line's optional flourish, and rebuilding a day under a brief.
 *
 * Real command service, real local D1, the owner's real imported profile and inventory. The forecasts
 * are synthetic values served by the labelled FakeWeatherProvider. These are checks of what the
 * deterministic composer and the validator do; they are not a judgement of taste.
 */
import { describe, expect, it } from "vitest";
import type { BoardDocument } from "@garderobe/contracts/ext/daily";
import { colourFamily, NEUTRAL_FAMILIES } from "../src/model.ts";
import { getBoard, optionLines, rebuildDay, validateOutfit } from "../src/index.ts";
import { COLD_DAY, compose, createDailyHarness, garmentRows, garmentsByName, MILD_DAY, realOwner, syntheticOwner } from "./helpers.ts";

const piece = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role);

describe("profile verdicts on the real owner's boards", () => {
  it("socks are merino by default, echo a colour worn higher up and never repeat the trouser; no neutral appears three times", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const rows = await garmentRows(h, owner);
    const family = (id: string | undefined) => (id ? colourFamily(rows.get(id)!.colour ?? rows.get(id)!.name) : null);
    let options = 0;
    for (const [date, forecast] of [["2026-09-16", MILD_DAY], ["2026-09-17", COLD_DAY], ["2026-09-18", MILD_DAY]] as const) {
      h.weather.setForecast(date, forecast);
      const board = (await compose(h, owner, date)).board!;
      expect(board.options).toHaveLength(5);
      for (const o of board.options) {
        options++;
        const label = `${date} option ${o.number} (${o.name})`;
        const socks = piece(o, "socks")!;
        expect(rows.get(socks.garmentId)!.attributes.fabricClass, label).toBe("merino");
        const upper = [family(piece(o, "outer")?.garmentId), family(piece(o, "top")?.garmentId)].filter(Boolean);
        expect(upper, `${label}: the sock echoes the jacket or the shirt`).toContain(family(socks.garmentId));
        expect(family(socks.garmentId), `${label}: the sock does not repeat the trouser`).not.toBe(family(piece(o, "bottom")!.garmentId));
        const counts = new Map<string, number>();
        for (const role of ["outer", "top", "bottom", "footwear"]) {
          const f = family(piece(o, role)?.garmentId);
          if (f && NEUTRAL_FAMILIES.has(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
        }
        for (const [f, n] of counts) expect(n, `${label}: ${f}`).toBeLessThanOrEqual(2);
      }
    }
    expect(options).toBe(15);
  });

  // SYNTHETIC wardrobes (labelled test owners, not the owner's stock): the outcome does not depend on the
  // seeded tie-breaking, which is why the real-owner test above caught this only about one run in forty.
  const NEUTRAL_RULE = { key: "colour.no_neutral_three_times", kind: "soft", status: "active", params: { maxSameNeutralPerOutfit: 2 }, interpretation: "synthetic: a single neutral appears at most twice in one outfit", origin: "owner_direction" };
  const NAVY_OVER_NAVY = [
    { id: "shirt-navy", name: "navy oxford", colour: "Navy", fabric: "Cotton oxford", category: "shirt", roles: ["top"], careChannel: "service", attributes: { fabricClass: "lightweight_oxford" } },
    { id: "trouser-beige", name: "beige chinos", colour: "Beige", fabric: "Cotton twill", category: "trousers", roles: ["bottom"], careChannel: "service" },
    { id: "jacket-navy", name: "navy work jacket", colour: "Navy", category: "outerwear", roles: ["outer"], careChannel: "none", attributes: { jacketLike: true } },
    { id: "sock-grey", name: "grey merino socks", colour: "Grey", quantity: 3, category: "socks", roles: ["socks"], careChannel: "handwash", fabric: "Merino wool", attributes: { fabricClass: "merino" } },
    { id: "belt-brown", name: "brown woven belt", colour: "Brown", category: "belt", roles: ["belt"], careChannel: "none" },
  ] as const;
  const shoe = (id: string, name: string, colour: string) => ({ id, name, colour, category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker", model: "990v4" } }) as const;

  it("SYNTHETIC: a navy jacket over a navy shirt takes the grey sneaker, not the navy one, although navy echoes a colour higher up", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await syntheticOwner(h, { garments: [...NAVY_OVER_NAVY, shoe("shoe-navy", "navy sneakers", "Navy"), shoe("shoe-grey", "grey sneakers", "Grey")] as never });
    await owner.exec("style.upsert_rule", NEUTRAL_RULE);
    h.weather.setForecast("2026-09-16", MILD_DAY); // 12 C at departure: a jacket is worn
    const board = (await compose(h, owner, "2026-09-16", { count: 1 })).board!;
    expect(board.options).toHaveLength(1);
    const o = board.options[0]!;
    expect(piece(o, "outer")!.garmentId).toBe("jacket-navy");
    expect(piece(o, "top")!.garmentId).toBe("shirt-navy");
    expect(piece(o, "footwear")!.garmentId).toBe("shoe-grey");
    const v = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now(), slots: o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })) as never });
    expect(v.violations.map((x) => x.code)).not.toContain("neutral_three_times");
  });

  it("SYNTHETIC: when the only eligible shoe is the third navy piece the outfit is still offered, and the validator reports the soft verdict", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await syntheticOwner(h, { garments: [...NAVY_OVER_NAVY, shoe("shoe-navy", "navy sneakers", "Navy")] as never });
    await owner.exec("style.upsert_rule", NEUTRAL_RULE);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const board = (await compose(h, owner, "2026-09-16", { count: 1 })).board!;
    expect(board.options).toHaveLength(1);
    const o = board.options[0]!;
    expect(piece(o, "footwear")!.garmentId).toBe("shoe-navy");
    const v = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now(), slots: o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })) as never });
    expect(v.violations.filter((x) => x.severity === "blocking")).toEqual([]);
    // With one jacket and one shoe, the jacket is kept for the cold start and the verdict is advisory.
    expect(piece(o, "outer")!.garmentId).toBe("jacket-navy");
    expect(v.violations.find((x) => x.code === "neutral_three_times")).toMatchObject({ severity: "advisory" });
  });

  it("the validator reports a single neutral worn three times as a soft verdict under the owner's rule, never as a refusal", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    h.weather.setForecast("2026-09-16", MILD_DAY);
    await compose(h, owner, "2026-09-16"); // records the day's forecast
    const navy = [g("ISTO Linen Work Jacket — navy"), g("Pima oxford — navy"), g("Single-pleated Di Sondrio navy")];
    const v = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-16", nowMs: h.clock.now(), slots: [{ role: "outer", garmentId: navy[0]! }, { role: "top", garmentId: navy[1]! }, { role: "bottom", garmentId: navy[2]! }, { role: "socks", garmentId: g("Merino — golden yellow") }, { role: "footwear", garmentId: g("NB 990v4 — grey") }] });
    const verdict = v.violations.find((x) => x.code === "neutral_three_times")!;
    expect(verdict).toMatchObject({ severity: "advisory", ruleKey: "colour.no_neutral_three_times" });
    expect([...verdict.garmentIds].sort()).toEqual([...navy].sort());
    expect(v.violations.filter((x) => x.severity === "blocking")).toEqual([]);
  });

  it("the belt line carries an optional scarf on a cold start and nothing on a mild one", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const rows = await garmentRows(h, owner);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    h.weather.setForecast("2026-09-17", COLD_DAY);
    const mild = (await compose(h, owner, "2026-09-16")).board!;
    for (const o of mild.options) expect(o.flourish, `mild option ${o.number}`).toBeNull();
    const cold = (await compose(h, owner, "2026-09-17")).board!;
    for (const o of cold.options) {
      expect(o.flourish, `cold option ${o.number}`).not.toBeNull();
      expect(rows.get(o.flourish!.garmentId)!.category).toBe("scarf");
      const belt = optionLines(o).find((l) => l.label === "Belt")!;
      expect(belt.text).toBe(`${piece(o, "belt")!.name}; optional: ${o.flourish!.name}`);
      // The flourish is on the belt line only: it is not a garment line of its own.
      expect(optionLines(o).map((l) => l.label)).toEqual(["Jacket", "Shirt", "Trousers", "Belt", "Socks and shoes"]);
    }
  });

  it("rebuilding a day under a brief returns a validated board that carries the brief and its must-include piece", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const before = (await compose(h, owner, "2026-09-16")).board!;
    const mustWear = names.get("Di Sondrio walnut chino")!.garment_id;
    const mustNot = piece(before.options[0]!, "top")!.garmentId;
    const rebuilt = await rebuildDay(h.deps, owner.principal(), { date: "2026-09-16", clientRequestId: "profile-format-rebuild", brief: { text: "walnut chinos, and not that shirt", include: [mustWear], exclude: [mustNot] } as never, nowMs: h.clock.now() });
    const board = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(rebuilt.board!.revision).toBe(board.revision);
    expect(board.revision).toBeGreaterThan(before.revision);
    expect(board.reason).toBe("rebuild");
    expect(board.brief).toMatchObject({ text: "walnut chinos, and not that shirt", include: [mustWear], exclude: [mustNot] });
    expect(board.options.length).toBeGreaterThan(0);
    for (const o of board.options) {
      expect(piece(o, "bottom")!.garmentId, `option ${o.number}`).toBe(mustWear);
      expect(o.garments.map((x) => x.garmentId), `option ${o.number}`).not.toContain(mustNot);
    }
    // A later repair of that day keeps the brief: the must-include piece is still in every option.
    await owner.exec("care.mark_dirty", { items: [{ garmentId: piece(board.options[0]!, "top")!.garmentId }] });
    const repaired = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(repaired.revision).toBeGreaterThan(board.revision);
    expect(repaired.brief).toMatchObject({ include: [mustWear], exclude: [mustNot] });
    for (const o of repaired.options) expect(piece(o, "bottom")!.garmentId).toBe(mustWear);
  });
});
