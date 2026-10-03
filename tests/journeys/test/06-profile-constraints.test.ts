/**
 * Journey 06: the owner's profile, applied. Every hard constraint of the profile is checked on real
 * boards by a checker written independently of the product's validator (src/profile-checker.ts), over
 * a scripted week of very different days.
 *
 * Profile: section 8 rules 1 to 7 (socks always; sneakers only; sneaker and welted alternative once the
 * fleet returns; the thermal rule and the 14-16 C jacket band; the week as variety horizon; never fall
 * back to navy; names he can see), section 5 (no neutral three times), section 9 (flourish on the belt
 * line, no watches or jewellery), section 11 (five outfits, safe options never lead).
 * Specification: section 6 (apply the supplied profile faithfully), section 7 (composition and
 * validation, insufficient choices); acceptance rows "Availability", "Repair" (fewer valid options, no
 * placeholders), "Personal context".
 *
 * Stand-ins: the scripted Open-Meteo double supplies each day's forecast; test-signed sign-in. No
 * language model: these boards come from the deterministic composer, which is what the owner gets
 * whenever the model is unavailable. Model-composed boards are not exercised here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { defect } from "../src/defect.ts";
import { publishBoard, type TestOwner } from "@garderobe/worker/testing";
import { sheetRowsFor } from "../src/inventory.ts";
import { boardViolations, neutralViolations, profileViolations, shown, type DayFacts } from "../src/profile-checker.ts";
import { boardTexts, exec, internalCodesIn, realOwnerAt, wholeWardrobe, type JourneyOwner, type WardrobeItem } from "../src/world.ts";

/** The scripted week: offset -> forecast. Each day exists to press on one rule. */
const WEEK: Record<number, { morningC: number; peakC: number; eveningC: number; why: string }> = {
  1: { morningC: 11, peakC: 19, eveningC: 14, why: "the profile's own example: starts at 11, reaches 19" },
  2: { morningC: 15, peakC: 15, eveningC: 13, why: "inside the 14-16 jacket band" },
  3: { morningC: 24, peakC: 31, eveningC: 26, why: "a heat-wave day" },
  4: { morningC: 2, peakC: 6, eveningC: 3, why: "a cold day" },
  5: { morningC: 5, peakC: 24, eveningC: 15, why: "cold start, warm peak: shirts follow the peak, not the morning" },
  6: { morningC: 14, peakC: 21, eveningC: 15, why: "lower edge of the jacket band" },
  7: { morningC: 16, peakC: 22, eveningC: 16, why: "upper edge of the jacket band" },
  8: { morningC: 17, peakC: 23, eveningC: 17, why: "just outside the band, just over the 22 degree shirts" },
};

let j: JourneyOwner;
let owner: TestOwner;
let items: WardrobeItem[];
const boards = new Map<number, any>();
const facts = (offset: number, extra: Partial<DayFacts> = {}): DayFacts => ({ departureC: WEEK[offset]!.morningC, peakC: WEEK[offset]!.peakC, sneakersOnly: true, wornInLastSevenDays: [], ...extra });
const idOf = (name: string) => items.find((i) => i.garment.name === name)!.garment.garmentId;
const pieceOf = (option: any, role: string) => option.garments.find((g: any) => g.role === role);

beforeAll(async () => {
  j = await realOwnerAt("Profile", (day) => Object.fromEntries(Object.entries(WEEK).map(([offset, w]) => [day(Number(offset)), { morningC: w.morningC, peakC: w.peakC, eveningC: w.eveningC }])));
  owner = j.owner;
  items = (await wholeWardrobe(owner.api)).items;
  for (const offset of Object.keys(WEEK).map(Number)) boards.set(offset, (await publishBoard(owner, { date: j.day(offset) })).board);
});

describe("every board of a varied week obeys the profile's hard constraints", () => {
  it("the checker itself catches each kind of violation (it is not vacuous)", () => {
    const outfit = (pieces: [string, string][], alternatives: [string, string][] = []) => ({ label: "probe", pieces: pieces.map(([role, name]) => ({ role, name })), footwearAlternatives: alternatives.map(([role, name]) => ({ role, name })), flourish: null });
    const fine: [string, string][] = [["top", "Lightweight oxford — pink"], ["bottom", "Di Sondrio grey chino"], ["socks", "Merino — inky blue"], ["footwear", "NB 990v4 — grey"]];
    const mild: DayFacts = { departureC: 11, peakC: 19, sneakersOnly: true, wornInLastSevenDays: [] };
    expect(profileViolations(outfit(fine), mild)).toEqual([]);
    const swap = (role: string, name: string) => fine.map(([r, n]) => (r === role ? [r, name] : [r, n]) as [string, string]);
    expect(profileViolations(outfit(fine.filter(([r]) => r !== "socks")), mild).join()).toMatch(/0 sock lines/);
    expect(profileViolations(outfit(swap("socks", "Alpaca bed sock — clotted cream")), mild).join()).toMatch(/bed sock/);
    expect(profileViolations(outfit(swap("footwear", "Paraboot Michael Cerf")), mild).join()).toMatch(/not a sneaker/);
    expect(profileViolations(outfit(fine, [["footwear", "Paraboot Reims — noir (black)"]]), mild).join()).toMatch(/welted fleet is out of play/);
    expect(profileViolations(outfit(fine), { ...mild, sneakersOnly: false }).join()).toMatch(/no welted alternative/);
    expect(profileViolations(outfit(swap("top", "Pima oxford — navy")), { ...mild, departureC: 5, peakC: 24 }).join()).toMatch(/peaks at 24/);
    expect(profileViolations(outfit(swap("bottom", "Palermo linen drawstring — tobacco")), mild).join()).toMatch(/peaks at only 19/);
    expect(profileViolations(outfit([["outer", "Drake's Olive Jungle Jacket"], ...swap("top", "Pima oxford — navy")]), { ...mild, departureC: 15 }).join()).toMatch(/lightweight oxford only/);
    expect(profileViolations(outfit([["outer", "Drake's Olive Jungle Jacket"], ...fine]), { ...mild, departureC: 15 })).toEqual([]);
    expect(profileViolations(outfit([["outer", "Drake's Olive Jungle Jacket"], ...fine]), { ...mild, departureC: 4 }).join()).toMatch(/4 °C when he leaves/);
    expect(profileViolations(outfit(fine), { ...mild, wornInLastSevenDays: ["Di Sondrio grey chino"] }).join()).toMatch(/last seven days/);
    expect(profileViolations(outfit([["outer", "DBF Traveler — wool"], ...fine]), mild).join()).toMatch(/benched/);
    expect(profileViolations(outfit(swap("top", "A shirt he does not own")), mild).join()).toMatch(/not a name from his inventory/);
    expect(neutralViolations(outfit([["outer", "ISTO Linen Work Jacket — navy"], ["top", "Pima oxford — navy"], ["bottom", "Cord — navy"], ["socks", "Merino — inky blue"], ["footwear", "NB 990v4 — navy"]])).join()).toMatch(/navy appears 4 times/);
    expect(neutralViolations(outfit(fine))).toEqual([]);
  });

  for (const [offset, weather] of Object.entries(WEEK)) {
    it(`day +${offset} (${weather.morningC} C leaving, ${weather.peakC} C peak; ${weather.why}): five outfits, no violation`, () => {
      const board = boards.get(Number(offset));
      expect(board.freshness.weather).toBe("fresh");
      expect(board.options).toHaveLength(5);
      expect(boardViolations(board, facts(Number(offset)))).toEqual([]);
      for (const text of boardTexts(board)) expect(internalCodesIn(text), text).toEqual([]);
    });
  }

  it("says the day the way the profile reads it: the peak dresses the outfit, the jacket answers the start", () => {
    const board = boards.get(1);
    expect(board.dayLine).toContain("11 °C");
    expect(board.dayLine).toContain("19 °C");
    const jacketed = board.options.filter((o: any) => pieceOf(o, "outer"));
    expect(jacketed.length).toBeGreaterThan(0); // an 11 degree start wants a jacket
    for (const option of jacketed) {
      expect(option.reason).toMatch(/19 °C/);
      expect(option.reason).toContain(pieceOf(option, "outer").name);
    }
  });

  it("on the heat-wave day no jacket is worn and the 30 degree linen is finally allowed", () => {
    const hot = boards.get(3);
    for (const option of hot.options) expect(pieceOf(option, "outer"), option.name).toBeUndefined();
    const everyTrouser = [...boards.entries()].flatMap(([offset, b]) => b.options.map((o: any) => ({ offset, name: pieceOf(o, "bottom").name })));
    for (const { offset, name } of everyTrouser.filter((t) => /^Palermo linen/.test(t.name))) expect(offset, name).toBe(3);
  });

  it("on the cold day every outfit has a jacket and the belt line carries a scarf from his own drawer", () => {
    const cold = boards.get(4);
    for (const option of cold.options) {
      expect(pieceOf(option, "outer"), option.name).toBeTruthy();
      expect(option.flourish, option.name).toBeTruthy();
      expect(sheetRowsFor(option.flourish.name)[0]!.status).toBe("Active");
    }
  });

  defect("D06-1", "on mild days the belt line carries an optional scarf or tie suggestion too", () => {
    // Profile section 9: "The belt line in any plan should carry an optional scarf or tie suggestion
    // appropriate to the day: often ignored, always welcome." He owns four active all-season silk knit
    // ties. The boards for mild and warm days offer no flourish on any option.
    for (const offset of [1, 2, 6, 7, 8]) for (const option of boards.get(offset).options) expect(option.flourish, `day +${offset}, ${option.name}`).toBeTruthy();
  });

  defect("D06-2", "no single neutral appears three times in one outfit", () => {
    // Profile section 5: "A standing colour verdict worth keeping: never let a single neutral appear
    // three times in one outfit". Counted on the owner's own sheet colours across jacket, shirt,
    // trousers, belt, socks and shoes. The composer keeps the jacket and shoes within the limit but not
    // the belt and socks, so combinations such as black chore coat, black belt and black socks are
    // offered although other belts and socks are free. Which board shows it varies from run to run.
    const found = [...boards.entries()].flatMap(([offset, board]) => board.options.flatMap((o: any) => neutralViolations(shown(o)).map((v) => `day +${offset}, ${v}`)));
    expect(found).toEqual([]);
  }, { intermittent: true });

  it("safe options never lead: the first outfit is not the white-or-blue shirt with navy trousers", () => {
    for (const board of boards.values()) {
      const lead = board.options[0];
      const shirt = sheetRowsFor(pieceOf(lead, "top").name)[0]!.colour;
      const trousers = sheetRowsFor(pieceOf(lead, "bottom").name)[0]!.colour;
      expect(/^(white|off-white|blue|light blue)$/i.test(shirt) && /navy/i.test(trousers), `${lead.name}`).toBe(false);
    }
  });

  it("spreads the wardrobe across the week instead of repeating the same favourites", () => {
    const tops = [...boards.values()].flatMap((b) => b.options.map((o: any) => pieceOf(o, "top").name));
    const bottoms = [...boards.values()].flatMap((b) => b.options.map((o: any) => pieceOf(o, "bottom").name));
    expect(new Set(tops).size).toBeGreaterThanOrEqual(20); // forty offered shirts over eight days, from thirty-odd owned
    expect(new Set(bottoms).size).toBeGreaterThanOrEqual(15);
  });
});

describe("the constraints hold when he acts", () => {
  it("a swap never falls back to navy, whichever piece is swapped out (rule 6)", async () => {
    let board = boards.get(1);
    const swappedIn: string[] = [];
    for (const [index, role] of [[0, "top"], [1, "bottom"], [2, "top"], [3, "bottom"], [4, "top"], [0, "bottom"], [1, "top"]] as const) {
      const option = board.options[index];
      if (!pieceOf(option, role)) continue;
      const response = await owner.api.json("POST", `/v1/boards/${board.boardId}/swap`, { clientRequestId: `swap-${crypto.randomUUID()}`, optionId: option.optionId, role });
      board = response.board;
      const replacement = pieceOf(board.options.find((o: any) => o.optionId === option.optionId), role).name;
      swappedIn.push(replacement);
      expect(sheetRowsFor(replacement)[0]!.colour, `${replacement} swapped in for ${pieceOf(option, role).name}`).not.toMatch(/navy/i);
    }
    expect(swappedIn.length).toBeGreaterThanOrEqual(6);
    // The swapped board still obeys everything else.
    expect(board.options.flatMap((o: any) => profileViolations(shown(o), facts(1)))).toEqual([]);
  });

  defect("D06-6", "swapping out a navy jacket does not hand him another navy jacket (rule 6)", async () => {
    // Profile section 8 rule 6: "Never fall back to navy when a piece is swapped out. He calls it
    // boring, and he is right about his own wardrobe." He puts his navy raglan work coat on an outfit
    // himself, then asks for a different jacket: with a dozen non-navy jackets free, the replacement
    // offered is another navy one. Shirt and trouser swaps (the step above) do avoid navy.
    let board = (await publishBoard(owner, { date: j.day(6) })).board; // 14 C leaving: a jacket day
    const optionId = board.options[0].optionId;
    const swap = (role: string, body: Record<string, unknown>) => owner.api.json("POST", `/v1/boards/${board.boardId}/swap`, { clientRequestId: `swap-${crypto.randomUUID()}`, optionId, role, ...body }).then((r: any) => (board = r.board));
    await swap("top", { garmentId: idOf("Lightweight oxford — gold") }); // a jacket at 14 C goes over a lightweight oxford
    await swap("outer", { garmentId: idOf("Drake's Navy Cotton-Linen Raglan Work Coat") });
    await swap("outer", {});
    const replacement = pieceOf(board.options.find((o: any) => o.optionId === optionId), "outer").name;
    expect(sheetRowsFor(replacement)[0]!.colour, `${replacement} was offered in place of the navy raglan work coat`).not.toMatch(/navy/i);
  });

  it("a piece he asks for himself is still checked: a jacket over a heavier shirt at 15 degrees is refused in plain words", async () => {
    let board = (await owner.api.json("GET", `/v1/today?date=${j.day(2)}`)).board;
    const optionId = board.options[0].optionId;
    const current = () => board.options.find((o: any) => o.optionId === optionId);
    const trySwap = (role: string, garmentId: string) => owner.api.post(`/v1/boards/${board.boardId}/swap`, { clientRequestId: `swap-${crypto.randomUUID()}`, optionId, role, garmentId });
    const swap = async (role: string, garmentId: string) => {
      const response = await trySwap(role, garmentId);
      const body = (await response.json()) as any;
      expect(response.status, JSON.stringify(body.error ?? {})).toBe(200);
      board = body.board;
    };
    // Whichever outfit the composer led with: put a shirt that is not a lightweight oxford under a jacket.
    let refusedSwap: Response;
    if (pieceOf(current(), "outer")) {
      refusedSwap = await trySwap("top", idOf("Flannel plaid — grey"));
    } else {
      if (/^Lightweight oxford/.test(pieceOf(current(), "top").name)) await swap("top", idOf("Clark oxford — beige"));
      refusedSwap = await trySwap("outer", idOf("Drake's Olive Jungle Jacket"));
    }
    expect(refusedSwap.status).toBe(409);
    const body = (await refusedSwap.json()) as any;
    expect(body.error.message).toMatch(/jacket goes over a lightweight oxford only/i);
    expect(body.error.message).toMatch(/nothing was changed/i);
    expect(body.error.message).toContain("15 °C");
    expect((await owner.api.json("GET", `/v1/today?date=${j.day(2)}`)).board.revision).toBe(board.revision);
    // A lightweight oxford under the same jacket is his to choose.
    await swap("top", idOf("Lightweight oxford — gold"));
    if (!pieceOf(current(), "outer")) await swap("outer", idOf("Drake's Olive Jungle Jacket"));
    expect(pieceOf(current(), "top").name).toBe("Lightweight oxford — gold");
    expect(pieceOf(current(), "outer")).toBeTruthy();
    expect(profileViolations(shown(current()), facts(2))).toEqual([]);
  });

  it("he cannot be talked into welted shoes by a swap while the restriction holds (rule 2)", async () => {
    const board = (await owner.api.json("GET", `/v1/today?date=${j.day(5)}`)).board;
    const response = await owner.api.post(`/v1/boards/${board.boardId}/swap`, { clientRequestId: `swap-${crypto.randomUUID()}`, optionId: board.options[0].optionId, role: "footwear", garmentId: idOf("Paraboot Michael Cerf") });
    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    expect(body.error.message).toMatch(/sneakers-only|restriction/i);
    expect(internalCodesIn(body.error.message)).toEqual([]);
  });

  it("what he wore today is a repeat for the next seven days and free again on the eighth (rule 5)", async () => {
    const worn = boards.get(8).options[0];
    const shirt = pieceOf(worn, "top").name;
    const trousers = pieceOf(worn, "bottom").name;
    await exec(owner.api, "wear.record", { wearingDate: j.day(0), garmentIds: [idOf(shirt), idOf(trousers)] });
    // The owner washes them the same day: cleanliness is not what keeps them out, the week is.
    await exec(owner.api, "care.washed", { items: [{ garmentId: idOf(shirt) }, { garmentId: idOf(trousers) }] });
    for (const offset of [1, 4, 7]) {
      const board = (await publishBoard(owner, { date: j.day(offset) })).board;
      const violations = boardViolations(board, facts(offset, { wornInLastSevenDays: [shirt, trousers] }));
      expect(violations, `day +${offset}`).toEqual([]);
    }
    // Day +8 is outside the seven days: the pieces are not excluded any more (they may or may not be picked).
    const eighth = (await owner.api.json("GET", `/v1/today?date=${j.day(8)}`)).board;
    const stillOffered = eighth.options.some((o: any) => pieceOf(o, "top").name === shirt || pieceOf(o, "bottom").name === trousers);
    const item = await owner.api.json("GET", `/v1/items/${idOf(shirt)}`);
    expect(item.availability.hardExcluded).toBe(false);
    expect(typeof stillOffered).toBe("boolean");
  });

  defect("D06-3", "an explicit owner override lets one request repeat this week's pieces, without rewriting the week rule", async () => {
    // Specification section 7: "An explicit owner override can relax a repeat preference; it cannot
    // make unavailable stock present." The shirt and trousers are clean (washed above). Naming them as
    // pieces that must stay returns no outfit, and the request has no other way to state the override.
    const settingsBefore = (await owner.api.json("GET", "/v1/settings")).settings.variety;
    const styleBefore = (await owner.api.json("GET", "/v1/style")).styleRevision;
    const worn = (await owner.api.json("GET", `/v1/days/${j.day(0)}`)).garments.map((g: any) => g.garmentId);
    const again = await owner.api.json("POST", "/v1/recommendations", { clientRequestId: `again-${crypto.randomUUID()}`, date: j.day(2), mode: "preview", count: 1, lockedGarmentIds: worn, brief: "the same shirt and trousers again, deliberately" });
    expect(again.options).toHaveLength(1);
    expect(again.options[0].garments.map((g: any) => g.garmentId)).toEqual(expect.arrayContaining(worn));
    expect((await owner.api.json("GET", "/v1/settings")).settings.variety).toEqual(settingsBefore);
    expect((await owner.api.json("GET", "/v1/style")).styleRevision).toBe(styleBefore);
  });
});

describe("availability in ordinary and explicit requests", () => {
  let a: JourneyOwner;
  let wardrobe: WardrobeItem[];
  const id = (name: string) => wardrobe.find((i) => i.garment.name === name)!.garment.garmentId;
  const preview = (body: Record<string, unknown>) => a.owner.api.json("POST", "/v1/recommendations", { clientRequestId: `p-${crypto.randomUUID()}`, date: a.day(1), mode: "preview", ...body });
  const offered = (result: any) => result.options.flatMap((o: any) => [...o.garments, ...o.footwearAlternatives, ...(o.flourish ? [o.flourish] : [])].map((g: any) => g.name));

  beforeAll(async () => {
    a = await realOwnerAt("Availability");
    wardrobe = (await wholeWardrobe(a.owner.api)).items;
  });

  it("an ordinary request offers no restricted, benched, indoor-only or occasional piece", async () => {
    const names = offered(await preview({ count: 8 }));
    for (const name of names) {
      const row = sheetRowsFor(name)[0]!;
      expect(row.status, name).not.toMatch(/benched|occasional/i);
      expect(name).not.toMatch(/bed sock|Paraboot|Clifford/);
    }
  });

  it("a shirt in the wash, a jacket at the tailor and a retired piece are not offered", async () => {
    const first = await preview({ count: 5 });
    const option = first.options.find((o: any) => pieceOf(o, "outer"));
    const shirt = pieceOf(option, "top");
    const jacket = pieceOf(option, "outer");
    const trousers = pieceOf(option, "bottom");
    await exec(a.owner.api, "care.mark_dirty", { items: [{ garmentId: shirt.garmentId, quantity: 1 }] });
    await exec(a.owner.api, "garment.move", { garmentId: jacket.garmentId, to: "tailor" });
    const retired = await exec(a.owner.api, "garment.retire", { garmentId: trousers.garmentId, quantity: wardrobe.find((i) => i.garment.garmentId === trousers.garmentId)!.totalOwnedUnits, disposition: "donated" });
    for (let i = 0; i < 3; i++) {
      const names = offered(await preview({ count: 8 }));
      for (const gone of [shirt.name, jacket.name, trousers.name]) expect(names, gone).not.toContain(gone);
    }
    // The retirement was this journey's own step on a test copy of the wardrobe: put it back.
    await exec(a.owner.api, "command.undo", { commandId: retired.commandId });
    expect((await a.owner.api.json("GET", `/v1/items/${trousers.garmentId}`)).detail.totalOwnedUnits).toBe(wardrobe.find((i) => i.garment.garmentId === trousers.garmentId)!.totalOwnedUnits);
  });

  it("an ordered piece that has not arrived is never wearable; once he says it arrived, it is", async () => {
    // SYNTHETIC boundary case: a labelled garment the owner does not own, created through the ordinary command.
    const created = await exec(a.owner.api, "garment.create", { name: "SYNTHETIC incoming oxford (test fixture)", category: "shirt", roles: ["top"], colour: "Rust", fabric: "Washed cotton oxford", careChannel: "service", acquisition: "incoming", quantity: 1, isSynthetic: true, source: { kind: "owner_statement" } });
    expect(created.summary).toMatch(/not yet arrived/i);
    const incomingId = String(created.result.garmentId);
    const before = await a.owner.api.json("GET", `/v1/items/${incomingId}`);
    expect(before.availability.hardExcluded).toBe(true);
    const locked = await preview({ count: 1, lockedGarmentIds: [incomingId] });
    expect(offered(locked)).not.toContain("SYNTHETIC incoming oxford (test fixture)");
    const arrived = await exec(a.owner.api, "garment.receive", { garmentId: incomingId });
    expect(arrived.summary).toMatch(/arrived/i);
    expect((await a.owner.api.json("GET", `/v1/items/${incomingId}`)).availability.hardExcluded).toBe(false);
    await exec(a.owner.api, "garment.remove_fabricated", { garmentId: incomingId, reason: "synthetic test fixture removed at the end of its step" });
  });

  it("with only three clean shirts he gets three real outfits and one plain sentence why, never a padded board", async () => {
    const shirts = wardrobe.filter((i) => i.garment.category === "shirt" && !i.availability!.hardExcluded);
    const receipt = await exec(a.owner.api, "care.mark_dirty", { items: shirts.slice(3).map((i) => ({ garmentId: i.garment.garmentId, quantity: 1 })) });
    const result = await a.owner.api.json("POST", "/v1/recommendations", { clientRequestId: `few-${crypto.randomUUID()}`, date: a.day(2), mode: "board" });
    expect(result.insufficient).toBe(true);
    expect(result.board.options.length).toBeLessThanOrEqual(3);
    expect(result.board.options.length).toBeGreaterThan(0);
    expect(result.board.requestedCount).toBe(5);
    expect(result.board.validity).toBe("degraded");
    expect(result.board.notice).toMatch(/instead of 5/);
    expect(result.board.notice).toMatch(/shirts/);
    expect(internalCodesIn(result.board.notice)).toEqual([]);
    for (const option of result.board.options) {
      for (const role of ["top", "bottom", "socks", "footwear"]) expect(pieceOf(option, role), role).toBeTruthy();
      expect(option.reason).not.toMatch(/calendar is not connected|instead of 5/i); // the explanation stays outside the outfit copy
    }
    expect(boardViolations(result.board, { departureC: 11, peakC: 19, sneakersOnly: true, wornInLastSevenDays: [] })).toEqual([]);
    await exec(a.owner.api, "command.undo", { commandId: receipt.commandId });
  });

  it("with no wearable shoes at all the board is empty and says so plainly, rather than showing invalid outfits", async () => {
    const sneakers = ["NB 990v4 — grey", "NB 990v4 — navy", "NB 990v4 — olive/cream"];
    for (const name of sneakers) await exec(a.owner.api, "garment.move", { garmentId: id(name), to: "storage" });
    const view = await a.owner.api.json("GET", `/v1/today?date=${a.day(2)}`);
    expect(view.board.options).toEqual([]);
    expect(view.board.notice).toMatch(/no complete outfit/i);
    expect(internalCodesIn(view.board.notice)).toEqual([]);
    // He is not offered the welted shoes as a way out.
    const none = await preview({ count: 3 });
    expect(none.options).toEqual([]);
    expect(none.note).toMatch(/shoes/i);
    for (const name of sneakers) await exec(a.owner.api, "garment.move", { garmentId: id(name), to: "clean", from: "storage" });
    const back = await preview({ count: 3 });
    expect(back.options).toHaveLength(3);
  });

  defect("D06-4", "asking for three outfits around one named shirt gives three, all with that shirt", async () => {
    // Specification section 13: `lockedGarmentIds` are "Garments that must stay". He owns twenty-odd
    // trousers that go with the pink oxford; the product returns one outfit and says no other
    // combination passes every rule.
    const result = await preview({ count: 3, lockedGarmentIds: [id("Lightweight oxford — pink")] });
    expect(result.options.map((o: any) => pieceOf(o, "top").name)).toEqual(Array(3).fill("Lightweight oxford — pink"));
  });

  defect("D06-5", "an occasional piece he asks for by name is admitted to the outfit", async () => {
    // Specification section 17, Availability: "occasional pieces behave correctly in ordinary and
    // explicit requests". The linen pocket square is "Occasional" in his sheet: absent from ordinary
    // boards (checked above), but an explicit request for it returns no outfit at all.
    const result = await preview({ count: 1, lockedGarmentIds: [id("Anglo-Italian pocket square")] });
    expect(offered(result)).toContain("Anglo-Italian pocket square");
  });
});

describe("once he says his feet have healed (a labelled what-if on a test copy of his wardrobe)", () => {
  // SYNTHETIC SCENARIO: the owner has NOT said this. The statement is made here, by the test owner in
  // the app, only to check rule 3 of the profile. Nothing in the owner's real data is changed.
  let h: JourneyOwner;
  let before: any;

  beforeAll(async () => {
    h = await realOwnerAt("Healed");
    before = (await publishBoard(h.owner, { date: h.day(1) })).board;
    await exec(h.owner.api, "board.select", { boardId: before.boardId, optionId: before.options[3].optionId });
  });

  it("until then no option names a welted shoe, even as an alternative", () => {
    for (const option of before.options) expect(profileViolations(shown(option), { departureC: 11, peakC: 19, sneakersOnly: true, wornInLastSevenDays: [] })).toEqual([]);
    expect(before.options.flatMap((o: any) => o.footwearAlternatives)).toEqual([]);
  });

  it("only his own statement in the app lifts it, with a receipt that says what changed and an undo", async () => {
    const shoes = (await wholeWardrobe(h.owner.api)).items.find((i) => i.garment.name === "Paraboot Michael Cerf")!;
    const restrictionId = shoes.availability!.restrictionIds[0];
    const receipt = await exec(h.owner.api, "restriction.resolve", { restrictionId, evidence: { kind: "owner_statement" }, note: "SYNTHETIC SCENARIO: feet healed" });
    expect(receipt.actor).toBe("owner");
    expect(receipt.summary).toMatch(/4 garments are no longer excluded/);
    expect(receipt.undo.available).toBe(true);
    expect(receipt.repairs.join(" ")).toMatch(/alternative shoe/);
    expect((await h.owner.api.json("GET", `/v1/items/${shoes.garment.garmentId}`)).availability.hardExcluded).toBe(false);
  });

  it("every outfit then names both a sneaker and a welted alternative, on the open board and on new ones (rule 3)", async () => {
    const healed: DayFacts = { departureC: 11, peakC: 19, sneakersOnly: false, wornInLastSevenDays: [] };
    const open = (await h.owner.api.json("GET", `/v1/today?date=${h.day(1)}`)).board;
    expect(open.options.map((o: any) => o.optionId)).toEqual(before.options.map((o: any) => o.optionId)); // same options, same identities
    expect(open.selection.optionId).toBe(before.options[3].optionId); // his choice is kept
    expect(boardViolations(open, healed)).toEqual([]);
    const fresh = (await publishBoard(h.owner, { date: h.day(3) })).board;
    expect(boardViolations(fresh, healed)).toEqual([]);
    for (const option of fresh.options) expect(option.footwearAlternatives.length, option.name).toBeGreaterThan(0);
    // The 990v6 stays out, as do the benched pieces: lifting one restriction lifts nothing else.
    for (const text of boardTexts(fresh)) expect(text).not.toMatch(/990v6/);
  });
});
