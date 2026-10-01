/**
 * Boards: composed, validated, published and revised through the shared command service, on real
 * local D1, for the REAL owner (supplied profile and imported inventory). Labelled fakes stand in only
 * for the weather HTTP service, the Google Calendar HTTP service and the AI Gateway composition model.
 */
import { describe, expect, it } from "vitest";
import type { BoardDocument, OutfitCandidate } from "@garderobe/contracts/ext/daily";
import { all, first, type Principal } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import { assembleContext, colourFamily, composeBoard, fetchWeatherSnapshot, getBoard, getToday, readCalendarSnapshot, recommend, rebuildOption, validateOutfit, type CompositionModel } from "../src/index.ts";
import type { CompositionRequest } from "../src/ports.ts";
import { compose, createDailyHarness, garmentRows, garmentsByName, MILD_DAY, realOwner, syntheticOwner, system, type DailyHarness } from "./helpers.ts";

const TOMORROW = "2026-09-16";

async function setup(opts: { model?: CompositionModel | null } = {}): Promise<{ h: DailyHarness; owner: TestOwner }> {
  const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", model: opts.model ?? null, isolate: true });
  const owner = await realOwner(h);
  h.weather.setForecast(TOMORROW, MILD_DAY);
  return { h, owner };
}

const idsOf = (o: BoardDocument["options"][number]) => [...o.garments.map((g) => g.garmentId), ...o.footwearAlternatives.map((g) => g.garmentId), ...(o.flourish ? [o.flourish.garmentId] : [])];
const pieceOf = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role);

/** Every offered option must be a valid outfit against the ledger as it is NOW. */
async function expectEveryOptionValid(h: DailyHarness, owner: TestOwner, doc: BoardDocument): Promise<void> {
  for (const o of doc.options) {
    const v = await validateOutfit(h.db, owner.principal(), {
      forDate: doc.localDate,
      nowMs: h.clock.now(),
      slots: [...o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })), ...(o.flourish ? [{ role: "neckwear" as const, garmentId: o.flourish.garmentId }] : [])],
      footwearAlternatives: o.footwearAlternatives.map((g) => g.garmentId),
    });
    expect(v.violations.filter((x) => x.severity === "blocking"), `option ${o.number} (${o.name})`).toEqual([]);
  }
}

/** TEST FAKE: stands in for the AI Gateway composition model only. */
class FakeCompositionModel implements CompositionModel {
  readonly profile = "TEST-FAKE-composition-model";
  readonly requests: CompositionRequest[] = [];
  constructor(private readonly respond: (request: CompositionRequest, call: number) => Promise<unknown[]> | unknown[]) {}
  async propose(request: CompositionRequest): Promise<OutfitCandidate[]> {
    this.requests.push(request);
    return (await this.respond(request, this.requests.length)) as OutfitCandidate[];
  }
}

describe("a board for the real owner", () => {
  it("publishes five complete, distinct, valid outfits through the command service, with receipt, evidence, exposure and Calendar effect", async () => {
    const { h, owner } = await setup();
    const result = await compose(h, owner, TOMORROW);
    const doc = result.board!;
    const rows = await garmentRows(h, owner);

    expect(doc.options).toHaveLength(5);
    expect(doc.validity).toBe("current");
    expect(new Set(doc.options.map((o) => pieceOf(o, "top")!.garmentId)).size).toBe(5);
    expect(new Set(doc.options.map((o) => pieceOf(o, "bottom")!.garmentId)).size).toBe(5);
    for (const o of doc.options) {
      expect(pieceOf(o, "socks"), `option ${o.number} has socks`).toBeTruthy();
      const shoe = rows.get(pieceOf(o, "footwear")!.garmentId)!;
      expect(shoe.attributes.footwearKind, `option ${o.number} shoe ${shoe.name}`).toBe("sneaker");
      expect(o.footwearAlternatives).toEqual([]); // the pairing rule is dormant while the restriction is active
      expect(o.reason.length).toBeGreaterThan(10);
      // Names come from records; no item codes anywhere in the copy.
      expect(`${o.name} ${o.reason} ${o.garments.map((g) => g.name).join(" ")}`).not.toMatch(/gmt_[0-9a-f]+/);
      for (const g of o.garments) expect(rows.get(g.garmentId)!.name).toBe(g.name);
    }
    await expectEveryOptionValid(h, owner, doc);

    // The receipt is the stored record of what was written.
    const receipt = result.receipt!;
    expect(receipt).toMatchObject({ type: "board.publish", outcome: "committed", actor: "system", channel: "scheduled", externalEffectState: "projection_pending" });
    expect(receipt.effects.map((e) => e.kind)).toEqual(["calendar.project_board"]);
    expect(receipt.affected).toContainEqual({ kind: "board", id: doc.boardId, version: 1 });
    expect(await h.service.getReceipt(owner.principal(), receipt.commandId)).toMatchObject({ commandId: receipt.commandId, result: { boardId: doc.boardId, revision: 1, offered: 5 } });

    // Validation evidence and the probability model are stored with the revision and each option.
    const revision = await first<{ context_json: string; conditions_json: string }>(h.db, "SELECT context_json, conditions_json FROM board_revisions WHERE user_id = ? AND board_id = ? AND revision = 1", owner.userId, doc.boardId);
    const context = JSON.parse(revision!.context_json);
    expect(context.availabilityModel).toMatch(/availability-estimator/);
    expect(context.estimatorParameters.parameterStatus).toBe("hypothesis");
    expect(context.rules.map((r: any) => r.key)).toContain("socks.required");
    expect(JSON.parse(revision!.conditions_json)).toMatchObject({ peakC: 19, departureC: 12, freshness: "fresh" });
    const optionRows = await all<{ state: string; evidence_json: string }>(h.db, "SELECT state, evidence_json FROM board_options WHERE user_id = ? AND board_id = ? AND revision = 1", owner.userId, doc.boardId);
    expect(optionRows.filter((o) => o.state === "reserve").length).toBeGreaterThan(0);
    for (const o of optionRows) {
      const evidence = JSON.parse(o.evidence_json);
      expect(evidence.validation.valid).toBe(true);
      expect(evidence.jointAvailability).toBeGreaterThan(0);
    }

    // Unselected options are registered as one exposure set: a probability, not five reservations.
    const exposure = await first<{ option_count: number; status: string; local_date: string }>(h.db, "SELECT option_count, status, local_date FROM exposure_sets WHERE user_id = ? AND exposure_id = ?", owner.userId, (receipt.result as any).exposureId);
    expect(exposure).toEqual({ option_count: 5, status: "open", local_date: TOMORROW });
    const stillClean = await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM stock_balances WHERE user_id = ? AND bucket = 'dirty' AND quantity > 0", owner.userId);
    expect(stillClean!.n).toBe(0);
  });

  it("offers nothing benched, restricted, indoor-only, occasional or layering-only", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, TOMORROW)).board!;
    const policies = await all<{ garment_id: string; name: string; planning_policy: string; attributes_json: string; category: string }>(h.db, "SELECT garment_id, name, planning_policy, attributes_json, category FROM garments WHERE user_id = ?", owner.userId);
    const byId = new Map(policies.map((p) => [p.garment_id, p]));
    const stored = await all<{ garment_id: string }>(h.db, "SELECT garment_id FROM board_option_garments WHERE user_id = ? AND board_id = ?", owner.userId, doc.boardId);
    expect(stored.length).toBeGreaterThan(30);
    for (const { garment_id } of stored) {
      const g = byId.get(garment_id)!;
      const a = JSON.parse(g.attributes_json);
      expect(g.planning_policy, g.name).toBe("normal");
      expect(a.indoorOnly, g.name).not.toBe(true);
      expect(a.layeringOnly, g.name).not.toBe(true);
      if (g.category === "footwear") expect(a.footwearKind, g.name).toBe("sneaker");
    }
  });

  it("unreported boards make pieces estimated, never excluded, and the next days' boards rotate to other shirts and trousers", async () => {
    const { h, owner } = await setup();
    const monday = (await compose(h, owner, "2026-09-16")).board!;
    h.clock.set("2026-09-16T20:00:00Z"); // no wear was reported for the 16th
    h.weather.setForecast("2026-09-17", MILD_DAY);
    const tuesday = (await compose(h, owner, "2026-09-17")).board!;
    h.clock.set("2026-09-17T20:00:00Z");
    h.weather.setForecast("2026-09-18", MILD_DAY);
    const wednesday = (await compose(h, owner, "2026-09-18")).board!;
    for (const doc of [tuesday, wednesday]) expect(doc.options).toHaveLength(5);
    const tops = [monday, tuesday, wednesday].flatMap((d) => d.options.map((o) => pieceOf(o, "top")!.garmentId));
    const bottoms = [monday, tuesday, wednesday].flatMap((d) => d.options.map((o) => pieceOf(o, "bottom")!.garmentId));
    expect(new Set(tops).size).toBeGreaterThanOrEqual(14); // the week's boards keep reaching for other shirts
    expect(new Set(bottoms).size).toBeGreaterThanOrEqual(10); // far more than one board's five
    expect(new Set([monday, tuesday, wednesday].flatMap((d) => d.options.map((o) => pieceOf(o, "footwear")!.garmentId))).size).toBe(3); // the three sneakers all take turns

    // A piece offered on an unreported day is only possibly worn: still offerable, with the estimate in evidence.
    const o = monday.options[0]!;
    const v = await validateOutfit(h.db, owner.principal(), { forDate: "2026-09-18", nowMs: h.clock.now(), slots: o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })) });
    expect(v.violations.filter((x) => x.severity === "blocking")).toEqual([]);
    const availability = (v.evidence as any).availability;
    const shirt = availability.garments.find((g: any) => g.garmentId === pieceOf(o, "top")!.garmentId);
    expect(shirt.status).toBe("estimated");
    expect(shirt.pAvailable).toBeGreaterThan(0);
    expect(shirt.pAvailable).toBeLessThan(1);
    expect(availability.jointAvailability).toBeLessThan(shirt.pAvailable + 1e-9);
    // No status question was raised and nothing was marked dirty on the strength of a suggestion.
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM stock_balances WHERE user_id = ? AND bucket = 'dirty' AND quantity > 0", owner.userId))!.n).toBe(0);
    // The published copy never carries a percentage.
    for (const doc of [monday, tuesday, wednesday]) expect(JSON.stringify(doc.options.map((x) => [x.reason, x.qualification]))).not.toMatch(/\d\s?%/);
  });

  it("three, four or five options on request, and a direct request can ask for more", async () => {
    const { h, owner } = await setup();
    for (const [date, count] of [["2026-09-16", 3], ["2026-09-17", 4], ["2026-09-18", 6]] as const) {
      h.weather.setForecast(date, MILD_DAY);
      const r = await recommend(h.deps, owner.principal(), { clientRequestId: `count-${count}`, date, count, mode: "board", nowMs: h.clock.now() });
      expect(r.options).toHaveLength(count);
      expect(r.insufficient).toBe(false);
      expect(r.board!.requestedCount).toBe(count);
    }
  });

  it("Today is read from the prepared board with no inference call, and a preview writes nothing", async () => {
    const model = new FakeCompositionModel(() => {
      throw new Error("TEST FAKE: the model must not be called to read Today");
    });
    const { h, owner } = await setup();
    await compose(h, owner, TOMORROW);
    h.deps.model = model;
    h.clock.set("2026-09-16T06:05:00Z");
    const today = await getToday(h.db, owner.principal(), { nowMs: h.clock.now() });
    expect(today.localDate).toBe(TOMORROW);
    expect(today.board!.options).toHaveLength(5);
    expect(today.emptyReason).toBeNull();
    expect(model.requests).toHaveLength(0);

    h.deps.model = null;
    h.weather.setForecast("2026-09-19", MILD_DAY);
    const before = await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId);
    const preview = await recommend(h.deps, owner.principal({ scopes: ["read"] }), { clientRequestId: "p1", date: "2026-09-19", count: 3, mode: "preview", nowMs: h.clock.now() });
    expect(preview.options).toHaveLength(3);
    expect(preview.board).toBeNull();
    const after = await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId);
    expect(after!.n).toBe(before!.n);
    expect(await getBoard(h.db, owner.principal(), { date: "2026-09-19" })).toBeNull();
  });
});

describe("weather, comfort and the day's record on the board", () => {
  const outerCount = (doc: BoardDocument) => doc.options.filter((o) => pieceOf(o, "outer")).length;

  it("heavy rain on a short commute or strong wind puts a layer on every option; a calm mild morning does not; neither overrides a hard rule", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await realOwner(h);
    const mild = { temperatureByHour: { 0: 17, 8: 19, 14: 22, 23: 17 } };
    h.weather.setForecast("2026-09-16", mild);
    h.weather.setForecast("2026-09-17", { ...mild, rainProbabilityByHour: { 0: 5, 7: 90, 9: 90, 10: 5, 23: 5 }, rainMmByHour: { 0: 0, 7: 6, 9: 6, 10: 0, 23: 0 } });
    h.weather.setForecast("2026-09-18", { ...mild, gustByHour: () => 65 });
    const calm = (await compose(h, owner, "2026-09-16")).board!;
    const wet = (await compose(h, owner, "2026-09-17")).board!;
    const windy = (await compose(h, owner, "2026-09-18")).board!;
    expect(outerCount(calm)).toBeLessThan(5);
    expect(outerCount(wet)).toBe(5);
    expect(outerCount(windy)).toBe(5);
    expect(wet.weatherLine).toMatch(/rain/);
    expect(windy.weatherLine).toMatch(/gusts to 65 km\/h/);
    for (const doc of [wet, windy]) {
      await expectEveryOptionValid(h, owner, doc);
      for (const o of doc.options) {
        expect(pieceOf(o, "socks")).toBeTruthy();
        expect(pieceOf(o, "footwear")!.name).toMatch(/^NB 990v4/); // rain does not bring back the welted shoes
        expect(o.reason).not.toMatch(/waterproof/i); // nothing is claimed about water resistance
      }
    }
  });

  it("a cold start with a warm afternoon dresses the base for the peak and the jacket for the start", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(TOMORROW, { temperatureByHour: { 0: 6, 8: 8, 15: 21, 23: 9 } });
    const doc = (await compose(h, owner, TOMORROW)).board!;
    expect(doc.weatherLine).toBe("8 °C leaving, 21 °C later.");
    expect(outerCount(doc)).toBe(5);
    for (const o of doc.options) expect(pieceOf(o, "bottom")!.name, "no 30-degree linen for a 21 C peak").not.toMatch(/Palermo linen/);
    await expectEveryOptionValid(h, owner, doc);
  });

  it("shoes that hurt are not reached for while any other eligible pair exists, whatever they would add to the outfit", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z" });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const painful = names.get("NB 990v4 — navy")!.garment_id;
    h.deps.comfort = async () => [{ feedbackId: "cf_1", text: "these hurt after an hour", kind: "pain", pain: true, garmentIds: [painful], wearingDate: "2026-09-12", scope: null, createdAt: "2026-09-12T18:00:00Z" }];
    for (const date of ["2026-09-16", "2026-09-17", "2026-09-18"]) {
      h.weather.setForecast(date, MILD_DAY);
      const doc = (await compose(h, owner, date)).board!;
      expect(doc.options).toHaveLength(5);
      expect(doc.options.map((o) => pieceOf(o, "footwear")!.garmentId)).not.toContain(painful);
    }
    // It is an observation about comfort, not a ban: the owner can still choose them himself.
    const doc = (await getBoard(h.db, owner.principal(), { date: "2026-09-16" }))!;
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "footwear", garmentId: painful });
  });

  it("once the day's wear is recorded the board is the day's record; an explicit request still gets a separate evening outfit", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z" });
    const owner = await realOwner(h);
    h.weather.setForecast("2026-09-15", { temperatureByHour: { 0: 10, 8: 12, 14: 19, 18: 16, 21: 13, 23: 12 } });
    const day = (await compose(h, owner, "2026-09-15")).board!;
    const worn = day.options[0]!;
    await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: worn.garments.map((g) => g.garmentId) });

    h.clock.set("2026-09-15T16:00:00Z");
    const again = await recommend(h.deps, owner.principal(), { clientRequestId: "again", date: "2026-09-15", mode: "board", nowMs: h.clock.now() });
    expect(again.options).toEqual([]);
    expect(again.note).toMatch(/already recorded/);
    expect(again.board!.validity).toBe("worn");
    expect(again.board!.revision).toBe(1);

    const dinner = await recommend(h.deps, owner.principal(), { clientRequestId: "dinner", date: "2026-09-15", count: 3, brief: { text: "dinner out", segment: "evening" }, mode: "board", nowMs: h.clock.now() });
    expect(dinner.board!.scope).toBe("home:evening");
    expect(dinner.options).toHaveLength(3);
    const wornIds = new Set(worn.garments.filter((g) => g.role === "top" || g.role === "bottom").map((g) => g.garmentId));
    for (const o of dinner.options) for (const g of o.garments) expect(wornIds.has(g.garmentId), `${g.name} is already worn today`).toBe(false);
    // The evening outfit is judged on the evening interval, not the afternoon peak.
    const conditions = await first<{ conditions_json: string }>(h.db, "SELECT conditions_json FROM board_revisions WHERE user_id = ? AND board_id = ?", owner.userId, dinner.board!.boardId);
    expect(JSON.parse(conditions!.conditions_json)).toMatchObject({ segment: "evening", peakC: 16, peakInterval: "18:00-23:00 Europe/London" });
    // The day's record is untouched.
    expect((await getToday(h.db, owner.principal(), { date: "2026-09-15", nowMs: h.clock.now() })).board!.validity).toBe("worn");
  });
});

describe("insufficient choices", () => {
  it("SYNTHETIC: a requested count never justifies unavailable garments: two eligible shirts give two outfits and one brief explanation, never padding", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z" });
    const owner = await syntheticOwner(h);
    h.weather.setForecast(TOMORROW, MILD_DAY);
    await owner.exec("care.mark_dirty", { items: ["shirt-gold", "shirt-red-stripe", "shirt-slate", "shirt-blue-stripe-a"].map((garmentId) => ({ garmentId })) });
    const result = await compose(h, owner, TOMORROW);
    const doc = result.board!;
    expect(doc.options).toHaveLength(2);
    expect(doc.requestedCount).toBe(5);
    expect(doc.validity).toBe("degraded");
    expect(doc.notice).toMatch(/Two valid outfits today instead of 5: only 2 eligible shirts\./);
    const used = doc.options.flatMap(idsOf);
    for (const dirty of ["shirt-gold", "shirt-red-stripe", "shirt-slate", "shirt-blue-stripe-a", "shirt-ordered"]) expect(used).not.toContain(dirty);
    // The explanation sits outside the outfit copy.
    for (const o of doc.options) expect(o.reason).not.toMatch(/instead of|eligible/);
  });

  it("SYNTHETIC: with no eligible socks there is no board at all, and Today says why instead of showing a placeholder", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z" });
    const owner = await syntheticOwner(h);
    h.weather.setForecast(TOMORROW, MILD_DAY);
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "sock-navy", quantity: 2 }, { garmentId: "sock-grey", quantity: 3 }] });
    const result = await compose(h, owner, TOMORROW);
    expect(result.board).toBeNull();
    expect(result.note).toMatch(/No complete outfit is available.*0 eligible pairs of socks/);
    const today = await getToday(h.db, owner.principal(), { date: TOMORROW, nowMs: h.clock.now() });
    expect(today.board).toBeNull();
    expect(today.emptyReason).toBe("No board has been prepared for this day yet.");
  });
});

describe("the composition model proposes; code decides", () => {
  it("rejects invented IDs, welted shoes and sockless candidates, strips an unsupported claim, and still hands the model the full mandatory context", async () => {
    let ids: Map<string, { garment_id: string }>;
    const model = new FakeCompositionModel((request, call) => {
      if (call > 1) return [];
      const g = (n: string) => ids.get(n)!.garment_id;
      const base = (top: string, bottom: string, shoe = "NB 990v4 — navy") => [{ role: "top", garmentId: g(top) }, { role: "bottom", garmentId: g(bottom) }, { role: "socks", garmentId: g("Merino — inky blue") }, { role: "footwear", garmentId: g(shoe) }];
      void request;
      return [
        { slots: [{ role: "top", garmentId: "gmt_the_perfect_shirt_i_imagined" }, ...base("Lightweight oxford — gold", "Di Sondrio beige chino").slice(1)], principle: "An imagined shirt." },
        { slots: base("Lightweight oxford — pink", "Di Sondrio grey chino", "Paraboot Michael Cerf"), principle: "The deerskin moc finishes it." },
        { slots: base("Lightweight oxford — slate", "Cord — beige").filter((s) => s.role !== "socks"), principle: "Bare ankles for a continental air." },
        { slots: [{ role: "top", garmentId: "Lightweight oxford — moss" }], principle: "A display name instead of an ID." },
        { slots: base("Lightweight oxford — gold", "Olive reverse sateen fatigue"), principle: "Gold against olive, a quiet autumn chord.", claims: [{ garmentId: g("Lightweight oxford — gold"), attribute: "colour", value: "Gold" }] },
        { slots: base("Lightweight oxford — red stripe", "Di Sondrio walnut chino"), principle: "The cashmere stripe warms the walnut.", claims: [{ garmentId: g("Lightweight oxford — red stripe"), attribute: "fabric", value: "cashmere" }] },
      ];
    });
    const { h, owner } = await setup({ model });
    ids = await garmentsByName(h, owner);
    const result = await compose(h, owner, TOMORROW);
    const doc = result.board!;

    expect(result.diagnostics).toMatchObject({ modelProfile: "TEST-FAKE-composition-model", modelAccepted: 2 });
    expect(result.diagnostics!.modelRejected.map((r) => r.violations.join(" "))).toEqual([
      expect.stringMatching(/unknown_garment/),
      expect.stringMatching(/restricted/),
      expect.stringMatching(/socks_required/),
      expect.stringMatching(/unknown_garment/),
    ]);
    expect(doc.options).toHaveLength(5);
    const gold = doc.options.find((o) => pieceOf(o, "top")!.name === "Lightweight oxford — gold")!;
    expect(gold.reason).toBe("Gold against olive, a quiet autumn chord.");
    const stripe = doc.options.find((o) => pieceOf(o, "top")!.name === "Lightweight oxford — red stripe")!;
    expect(stripe.reason).not.toMatch(/cashmere/i);
    const evidence = await all<{ evidence_json: string }>(h.db, "SELECT evidence_json FROM board_options WHERE user_id = ? AND board_id = ? AND option_id = ?", owner.userId, doc.boardId, stripe.optionId);
    expect(JSON.parse(evidence[0]!.evidence_json)).toMatchObject({ source: "model", explanationSource: "factual", removedClaims: ["fabric: cashmere"] });
    const used = doc.options.flatMap(idsOf);
    expect(used).not.toContain(ids.get("Paraboot Michael Cerf")!.garment_id);
    await expectEveryOptionValid(h, owner, doc);

    // The model made no tool calls, yet it was given the complete context by trusted code.
    const request = model.requests[0]!;
    const profile = (await first<{ content: string }>(h.db, "SELECT content FROM style_documents WHERE user_id = ? AND status = 'active'", owner.userId))!.content;
    expect(request.contextText).toContain(profile);
    const inventory = await all<{ garment_id: string }>(h.db, "SELECT garment_id FROM garments WHERE user_id = ? AND merged_into IS NULL", owner.userId);
    for (const { garment_id } of inventory) expect(request.contextText).toContain(garment_id);
    expect(request.contextText).toMatch(/DBF Traveler — wool .*unavailable \(planning_excluded\)/);
    expect(request.contextText).toContain("12 °C leaving, 19 °C later");
    expect(request.contextText).toMatch(/Calendar was|The calendar was read and is empty/);
    expect(request.count).toBeGreaterThan(5);
    // The second attempt carried the rejections back for repair.
    expect(model.requests[1]!.rejections.length).toBe(4);
  });

  it("with inference unavailable the board is still complete, with factual explanations and no invented rationale", async () => {
    const model = new FakeCompositionModel(() => {
      throw new Error("TEST FAKE: gateway timeout");
    });
    const { h, owner } = await setup({ model });
    const result = await compose(h, owner, TOMORROW);
    expect(result.board!.options).toHaveLength(5);
    expect(result.diagnostics!.modelError).toMatch(/gateway timeout/);
    const sources = await all<{ evidence_json: string }>(h.db, "SELECT evidence_json FROM board_options WHERE user_id = ? AND board_id = ? AND state = 'offered'", owner.userId, result.board!.boardId);
    for (const s of sources) expect(JSON.parse(s.evidence_json)).toMatchObject({ source: "deterministic", explanationSource: "factual" });
  });

  it("a combination the owner chose before is revalidated and offered again when inference is unavailable, with its stored explanation", async () => {
    const { h, owner } = await setup();
    const first1 = (await compose(h, owner, TOMORROW)).board!;
    const chosen = first1.options[3]!;
    await owner.exec("board.select", { boardId: first1.boardId, optionId: chosen.optionId });
    // A fortnight later (outside the repeat horizon), without a model.
    h.clock.set("2026-09-30T20:00:00Z");
    h.weather.setForecast("2026-10-01", MILD_DAY);
    const later = (await compose(h, owner, "2026-10-01")).board!;
    const again = later.options.find((o) => pieceOf(o, "top")!.garmentId === pieceOf(chosen, "top")!.garmentId && pieceOf(o, "bottom")!.garmentId === pieceOf(chosen, "bottom")!.garmentId);
    expect(again, "the approved combination is on the later board").toBeTruthy();
    expect(again!.reason).toBe(chosen.reason);
  });
});

describe("publication rechecks state", () => {
  it("a shirt that went into the wash during composition cannot commit: the stale candidate is dropped and a complete reserve takes its place", async () => {
    const { h, owner } = await setup();
    const principal: Principal = await system(h, owner);
    const weather = await fetchWeatherSnapshot(h.deps, principal, { localDate: TOMORROW, purpose: "evening_compose" });
    const calendar = await readCalendarSnapshot(h.deps, principal, { localDate: TOMORROW });
    const rc = await assembleContext(h.db, principal, { localDate: TOMORROW, nowMs: h.clock.now(), weather, calendar });
    const composed = await composeBoard(rc);
    const staleShirt = composed.options[1]!.slots.find((s) => s.role === "top")!.garmentId;

    // The laundry update lands between composition and publication.
    await owner.exec("care.mark_dirty", { items: [{ garmentId: staleShirt }] });

    const strip = (o: (typeof composed.options)[number]) => ({ slots: o.slots, footwearAlternatives: o.footwearAlternatives, reason: o.reason, explanationSource: o.explanationSource, removedClaims: o.removedClaims, source: o.source, suitsEventIds: o.suitsEventIds });
    const receipt = await owner.exec("board.publish", { localDate: TOMORROW, options: composed.options.map(strip), reserves: composed.reserves.map(strip), requestedCount: 5, weatherSnapshotId: weather.snapshotId, calendarSnapshotId: calendar.snapshotId }, { actor: "system", channel: "scheduled", authorization: "system_schedule" });
    const result = receipt.result as any;
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].violations.join(" ")).toMatch(/unavailable/);
    expect(result.offered).toBe(5);
    const doc = (await getBoard(h.db, owner.principal(), { date: TOMORROW }))!;
    expect(doc.options.flatMap(idsOf)).not.toContain(staleShirt);
    await expectEveryOptionValid(h, owner, doc);
  });

  it("when every candidate is stale nothing is written: no board, no receipt, no effect", async () => {
    const { h, owner } = await setup();
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    const welted = { slots: [{ role: "top", garmentId: g("Lightweight oxford — gold") }, { role: "bottom", garmentId: g("Di Sondrio beige chino") }, { role: "socks", garmentId: g("Merino — inky blue") }, { role: "footwear", garmentId: g("Paraboot Michael Cerf") }], reason: "A client asked for it." };
    const commandsBefore = (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n;
    await expect(owner.exec("board.publish", { localDate: TOMORROW, options: [welted], requestedCount: 1 })).rejects.toMatchObject({ code: "precondition_failed" });
    expect(await getBoard(h.db, owner.principal(), { date: TOMORROW })).toBeNull();
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n).toBe(commandsBefore);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM effects WHERE user_id = ?", owner.userId))!.n).toBe(0);
  });

  it("refuses to publish for a past day", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, TOMORROW)).board!;
    const o = doc.options[0]!;
    await expect(owner.exec("board.publish", { localDate: "2026-09-10", options: [{ slots: o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })), reason: o.reason }], requestedCount: 1 })).rejects.toMatchObject({ code: "invalid_command" });
  });
});

describe("choosing and swapping", () => {
  it("choosing records an intention, not a wear, and raises that option's probability only", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, TOMORROW)).board!;
    const receipt = await owner.exec("board.select", { boardId: doc.boardId, optionId: doc.options[1]!.optionId }, { expectedVersions: { [`board:${doc.boardId}`]: 1 } });
    expect(receipt.summary).toMatch(/an intention, not a recorded wear/);
    const after = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!;
    expect(after.selection).toMatchObject({ optionId: doc.options[1]!.optionId });
    expect(after.revision).toBe(1);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ?", owner.userId))!.n).toBe(0);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM stock_balances WHERE user_id = ? AND bucket = 'dirty' AND quantity > 0", owner.userId))!.n).toBe(0);
    const exposure = await first<{ status: string; selected_option_id: string }>(h.db, "SELECT status, selected_option_id FROM exposure_sets WHERE user_id = ? AND status IN ('open', 'selected')", owner.userId);
    expect(exposure).toEqual({ status: "selected", selected_option_id: doc.options[1]!.optionId });

    await expect(owner.exec("board.select", { boardId: doc.boardId, optionId: "opt_from_another_revision" })).rejects.toMatchObject({ code: "not_found" });
    // Undo restores the previous (empty) selection through a compensating command.
    await owner.exec("command.undo", { commandId: receipt.commandId });
    expect((await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!.selection).toBeNull();
  });

  it("swapping a shirt changes the shirt: one slot, one option, a new immutable revision, and never navy by default", async () => {
    const { h, owner } = await setup();
    const doc = (await compose(h, owner, TOMORROW)).board!;
    const target = doc.options[2]!;
    const receipt = await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: target.optionId, role: "top" }, { expectedVersions: { [`board:${doc.boardId}`]: 1 } });
    const after = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!;
    expect(after.revision).toBe(2);
    expect(after.reason).toBe("swap");
    const swapped = after.options.find((o) => o.optionId === target.optionId)!;
    expect(swapped.changedInRevision).toBe(true);
    expect(pieceOf(swapped, "top")!.garmentId).not.toBe(pieceOf(target, "top")!.garmentId);
    for (const role of ["bottom", "socks", "footwear", "belt", "outer"]) expect(pieceOf(swapped, role)?.garmentId, role).toBe(pieceOf(target, role)?.garmentId);
    for (const o of after.options.filter((x) => x.optionId !== target.optionId)) {
      expect(o.changedInRevision).toBe(false);
      expect(idsOf(o)).toEqual(idsOf(doc.options.find((x) => x.optionId === o.optionId)!));
    }
    // The replacement is not another option's shirt, and navy is not the fallback.
    const otherTops = after.options.filter((o) => o.optionId !== target.optionId).map((o) => pieceOf(o, "top")!.garmentId);
    expect(otherTops).not.toContain(pieceOf(swapped, "top")!.garmentId);
    if (colourFamily(pieceOf(target, "top")!.colour) !== "navy") expect(colourFamily(pieceOf(swapped, "top")!.colour)).not.toBe("navy");
    expect(after.changes.join(" ")).toMatch(/replaced by/);
    expect(receipt.summary).toMatch(/the rest of the outfit is unchanged/);
    await expectEveryOptionValid(h, owner, after);
    // The earlier revision is history, unchanged.
    const original = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }, { revision: 1 }))!;
    expect(original.options.map(idsOf)).toEqual(doc.options.map(idsOf));
  });

  it("swapping trousers on several options never falls back to navy while anything else validates", async () => {
    const { h, owner } = await setup();
    let doc = (await compose(h, owner, TOMORROW)).board!;
    for (const option of doc.options) {
      if (colourFamily(pieceOf(option, "bottom")!.colour) === "navy") continue;
      await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: option.optionId, role: "bottom" });
      doc = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!;
      expect(colourFamily(pieceOf(doc.options.find((o) => o.optionId === option.optionId)!, "bottom")!.colour), option.name).not.toBe("navy");
    }
  });

  it("the owner's own pick is validated: a valid shirt is accepted as given, a too-warm or restricted piece changes nothing, and a stale version is a clean conflict", async () => {
    const { h, owner } = await setup();
    const names = await garmentsByName(h, owner);
    const doc = (await compose(h, owner, TOMORROW)).board!;
    const target = doc.options[0]!;
    const used = new Set(doc.options.map((o) => pieceOf(o, "top")!.name));
    const free = ["Lightweight oxford — yellow stripe", "Lightweight oxford — laurel", "Lightweight oxford — off-white"].find((n) => !used.has(n))!;
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: target.optionId, role: "top", garmentId: names.get(free)!.garment_id });
    let now = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!;
    expect(pieceOf(now.options[0]!, "top")!.name).toBe(free);

    await expect(owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: target.optionId, role: "footwear", garmentId: names.get("Paraboot Michael Cerf")!.garment_id })).rejects.toMatchObject({ code: "precondition_failed" });
    await expect(owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: target.optionId, role: "bottom", garmentId: names.get("Palermo linen drawstring — neutral")!.garment_id })).rejects.toMatchObject({ code: "precondition_failed" });
    await expect(owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: target.optionId, role: "top" }, { expectedVersions: { [`board:${doc.boardId}`]: 1 } })).rejects.toMatchObject({ code: "conflict" });
    now = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!;
    expect(now.revision).toBe(2);
    expect(pieceOf(now.options[0]!, "footwear")!.garmentId).toBe(pieceOf(target, "footwear")!.garmentId);
  });

  it("rebuilding one option replaces only that option and keeps the brief", async () => {
    const { h, owner } = await setup();
    const names = await garmentsByName(h, owner);
    const mustWear = names.get("Di Sondrio walnut chino")!.garment_id;
    const r = await recommend(h.deps, owner.principal(), { clientRequestId: "brief-1", date: TOMORROW, count: 3, brief: { text: "walnut chinos today", exclude: [names.get("Denim — white")!.garment_id] }, lockedGarmentIds: [mustWear], mode: "board", nowMs: h.clock.now() });
    const doc = r.board!;
    expect(doc.options).toHaveLength(3);
    for (const o of doc.options) expect(pieceOf(o, "bottom")!.garmentId).toBe(mustWear);
    const rebuilt = await rebuildOption(h.deps, owner.principal(), { boardId: doc.boardId, optionId: doc.options[1]!.optionId, clientRequestId: "rb-1", nowMs: h.clock.now() });
    expect(rebuilt.board.revision).toBe(2);
    expect(rebuilt.board.brief).toMatchObject({ text: "walnut chinos today", include: [mustWear] });
    expect(rebuilt.board.options.map((o) => o.optionId).filter((id) => doc.options.some((x) => x.optionId === id))).toEqual([doc.options[0]!.optionId, doc.options[2]!.optionId]);
    const fresh = rebuilt.board.options[1]!;
    expect(pieceOf(fresh, "bottom")!.garmentId).toBe(mustWear);
    expect(pieceOf(fresh, "top")!.garmentId).not.toBe(pieceOf(doc.options[1]!, "top")!.garmentId);
    await expectEveryOptionValid(h, owner, rebuilt.board);
  });
});
