/**
 * Regression tests for the independent review of commit 92c5eb21 (findings 1-7 and the low-severity
 * points that were fixed). Each test reproduces the reviewed defect against the REAL command service on
 * REAL local D1, with the owner's real imported profile and inventory unless the name says SYNTHETIC.
 *
 * Stand-ins, all at the adapter boundary and labelled: FakeWeatherProvider / FakeGeocoder (weather
 * service), FakeGoogleCalendar (Google Calendar), and the TEST-FAKE composition models defined here.
 *
 * The healing restriction: the tests that lift it do so in the test's own throwaway local D1 database,
 * on the harness's copy of the owner's data, and reinstate it before they end. No persisted fixture and
 * no import output is touched.
 */
import { describe, expect, it } from "vitest";
import type { BoardDocument, OutfitCandidate } from "@garderobe/contracts/ext/daily";
import { all, first } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import type { CompositionModel } from "../src/ports.ts";
import { managedEventId } from "../src/calendar/event-id.ts";
import { stockWritesRecognized } from "../src/repair.ts";
import { phaseLeaseMs } from "../src/schedule.ts";
import { readCalendarSnapshot } from "../src/snapshots.ts";
import { accessoryVerdict } from "../src/validate.ts";
import { fetchWeatherSnapshot, getBoard, getToday, prepareBoard, projectCalendarEffects, replenishBoards, runDueJobs, runOwnerPhase, validateOutfit } from "../src/index.ts";
import { compose, createDailyHarness, garmentRows, garmentsByName, MILD_DAY, OUTFIT_CALENDAR, realOwner, syntheticOwner, system, type DailyHarness } from "./helpers.ts";

const DAY = "2026-09-16";
const RESTRICTION = "rst_profile_sneakers_only";
const piece = (o: BoardDocument["options"][number], role: string) => o.garments.find((g) => g.role === role);
const shape = (doc: BoardDocument) => doc.options.map((o) => ({ optionId: o.optionId, garments: o.garments.map((g) => `${g.role}:${g.garmentId}`) }));
const blockingCodes = (v: { violations: { code: string; severity: string }[] }) => v.violations.filter((x) => x.severity === "blocking").map((x) => x.code);
const advisoryCodes = (v: { violations: { code: string; severity: string }[] }) => v.violations.filter((x) => x.severity === "advisory").map((x) => x.code);

async function setup(): Promise<{ h: DailyHarness; owner: TestOwner }> {
  const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
  const owner = await realOwner(h);
  h.weather.setForecast(DAY, MILD_DAY);
  return { h, owner };
}

async function restrictionStatus(h: DailyHarness, owner: TestOwner): Promise<string | undefined> {
  return (await first<{ status: string }>(h.db, "SELECT status FROM restrictions WHERE user_id = ? AND restriction_id = ?", owner.userId, RESTRICTION))?.status;
}

describe("review finding 1 (high): the owner reports his feet have healed", () => {
  it("keeps every option, its ID, its pieces and the owner's selection, and adds an eligible welted alternative to each - in the same commit", async () => {
    const { h, owner } = await setup();
    const before = (await compose(h, owner, DAY)).board!;
    expect(before.options).toHaveLength(5);
    for (const o of before.options) expect(o.footwearAlternatives).toEqual([]); // the restriction outranks the paired format
    const chosen = before.options[0]!;
    await owner.exec("board.select", { boardId: before.boardId, optionId: chosen.optionId });
    await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });

    const receipt = await owner.exec("restriction.resolve", { restrictionId: RESTRICTION, evidence: { kind: "owner_statement", note: "my feet have healed" } });
    try {
      const repair = ((receipt.result as any).boardRepairs as any[]).find((r) => r.boardId === before.boardId);
      expect(repair).toMatchObject({ offered: 5, withdrawn: 0, selectionKept: true });
      expect(receipt.repairs.join(" ")).toMatch(/added as the alternative shoe/);
      expect(receipt.repairs.join(" ")).not.toMatch(/withdrawn/);

      const after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
      expect(after.revision).toBe(before.revision + 1);
      expect(shape(after)).toEqual(shape(before)); // same options, same IDs, same pieces, same order
      expect(after.selection).toMatchObject({ optionId: chosen.optionId, footwearGarmentId: piece(chosen, "footwear")!.garmentId });
      const rows = await garmentRows(h, owner);
      for (const o of after.options) {
        expect(rows.get(piece(o, "footwear")!.garmentId)!.attributes.footwearKind, `option ${o.number} keeps its sneaker`).toBe("sneaker");
        expect(o.footwearAlternatives.map((a) => rows.get(a.garmentId)!.attributes.footwearKind), `option ${o.number} names a welted alternative`).toEqual(["welted"]);
        const v = await validateOutfit(h.db, owner.principal(), { forDate: DAY, nowMs: h.clock.now(), slots: [...o.garments.map((g) => ({ role: g.role, garmentId: g.garmentId })), ...(o.flourish ? [{ role: "neckwear" as const, garmentId: o.flourish.garmentId }] : [])], footwearAlternatives: o.footwearAlternatives.map((a) => a.garmentId) });
        expect(v.violations.filter((x) => x.severity === "blocking" || x.code === "paired_footwear_required"), `option ${o.number}`).toEqual([]);
      }

      // The Calendar event is replaced with the same outfits, not emptied.
      await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });
      const live = h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).filter((e) => e.status !== "cancelled");
      expect(live).toHaveLength(1);
      expect(live[0]!.description).toContain(chosen.name);
      expect(live[0]!.description).toContain(after.options[0]!.footwearAlternatives[0]!.name);
      expect(live[0]!.description).not.toMatch(/No complete outfit/);
    } finally {
      // Reinstate the restriction: nothing in this test leaves it lifted.
      await owner.exec("command.undo", { commandId: receipt.commandId });
    }
    expect(await restrictionStatus(h, owner)).toBe("active");
    await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() });
    const reinstated = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(shape(reinstated)).toEqual(shape(before));
    for (const o of reinstated.options) expect(o.footwearAlternatives, `option ${o.number}: welted shoes are excluded again`).toEqual([]);
    expect(reinstated.selection?.optionId).toBe(chosen.optionId);
  });

  it("a later swap on a board published before the format came into force completes the pair instead of failing", async () => {
    const { h, owner } = await setup();
    const before = (await compose(h, owner, DAY)).board!;
    const receipt = await owner.exec("restriction.resolve", { restrictionId: RESTRICTION, evidence: { kind: "owner_statement", note: "my feet have healed" } });
    try {
      const swap = await owner.exec("board.swap_slot", { boardId: before.boardId, optionId: before.options[1]!.optionId, role: "top" });
      expect(swap.outcome).toBe("committed");
      const after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
      expect(after.options).toHaveLength(5);
      for (const o of after.options) expect(o.footwearAlternatives).toHaveLength(1);
    } finally {
      await owner.exec("command.undo", { commandId: receipt.commandId });
    }
    expect(await restrictionStatus(h, owner)).toBe("active");
  });
});

describe("review finding 2 (high): a board whose every option became invalid is never left labelled current", () => {
  it("SYNTHETIC: after a flag-only rule change the board reads as limited at once; the sweep publishes the withdrawn revision with a plain notice, stops recomposing, and refills when the rule allows", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await syntheticOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const before = (await compose(h, owner, DAY, { count: 3 })).board!;
    expect(before.options).toHaveLength(3);
    expect(before.validity).toBe("current");

    // SYNTHETIC rule: no footwear at all is allowed, so nothing on the board is valid and nothing can replace it.
    await owner.exec("style.upsert_rule", { key: "footwear.sneakers_only_until_healed", kind: "hard", status: "active", params: { allowedFootwearKinds: [], excludedModels: [] }, interpretation: "synthetic: no footwear is allowed (review regression)", origin: "owner_direction" });
    const flagged = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(flagged.revision).toBe(before.revision);
    expect(flagged.validity).toBe("limited"); // not yet rechecked against the change: never "current"

    const sweep = await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() });
    expect(sweep).toMatchObject([{ boardId: before.boardId, action: "repaired", revision: before.revision + 1, offered: 0 }]);
    const withdrawn = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(withdrawn.options).toEqual([]);
    expect(withdrawn.validity).toBe("degraded");
    expect(withdrawn.notice).toMatch(/No complete outfit is available for this day/);
    expect(withdrawn.changes.join(" ")).toMatch(/was withdrawn/);
    expect((await getToday(h.db, owner.principal(), { date: DAY, nowMs: h.clock.now() })).emptyReason).toMatch(/No complete outfit/);

    // No five-minute recomposition loop: the next sweeps publish nothing and the flag is cleared.
    h.clock.advanceMinutes(5);
    expect(await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() })).toMatchObject([{ action: "none", revision: before.revision + 1 }]);
    expect(await all(h.db, "SELECT needs_replenishment, current_revision FROM boards WHERE board_id = ?", before.boardId)).toEqual([{ needs_replenishment: 0, current_revision: before.revision + 1 }]);
    h.clock.advanceMinutes(5);
    expect(await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() })).toEqual([]);

    // The rule is relaxed again: the change flags the board and the sweep refills it.
    await owner.exec("style.upsert_rule", { key: "footwear.sneakers_only_until_healed", kind: "hard", status: "active", params: { allowedFootwearKinds: ["sneaker", "welted", "boot", "other"], excludedModels: [] }, interpretation: "synthetic: footwear is allowed again (review regression)", origin: "owner_direction" });
    await replenishBoards(h.deps, await system(h, owner), { nowMs: h.clock.now() });
    const refilled = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(refilled.options).toHaveLength(3);
    expect(refilled.validity).toBe("current");
  });

  it("an empty revision is refused while the board still has a valid outfit", async () => {
    const { h, owner } = await setup();
    const before = (await compose(h, owner, DAY)).board!;
    await expect(owner.exec("board.publish", { localDate: DAY, reason: "repair", options: [], requestedCount: 5 }, { actor: "system", channel: "scheduled", authorization: "system_schedule" })).rejects.toMatchObject({ code: "precondition_failed" });
    expect((await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!.revision).toBe(before.revision);
  });
});

describe("review finding 3 (medium): a selection made while a refresh recomposes is kept", () => {
  it("the scheduled recomposition does not replace the chosen outfit: the board is rechecked around the choice", async () => {
    const { h, owner } = await setup();
    const before = (await compose(h, owner, DAY)).board!;
    const chosen = before.options[2]!;
    let done = false;
    const model: CompositionModel = {
      profile: "TEST-FAKE-interleaving-model",
      async propose(): Promise<OutfitCandidate[]> {
        if (!done) {
          done = true;
          await owner.exec("board.select", { boardId: before.boardId, optionId: chosen.optionId });
        }
        return [];
      },
    };
    h.deps.model = model;
    // What refreshBoard does once it has seen "no selection" and a material change.
    const result = await prepareBoard(h.deps, await system(h, owner), { localDate: DAY, reason: "refresh", purpose: "morning_refresh", idempotencyKey: "regression-f3", nowMs: h.clock.now() });
    expect(done).toBe(true);
    expect(result.note).toMatch(/chosen while the board was being refreshed/);
    const after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(after.selection?.optionId).toBe(chosen.optionId);
    expect(shape(after)).toEqual(shape(before));
    expect(await all(h.db, "SELECT selected_option_id FROM boards WHERE board_id = ?", before.boardId)).toEqual([{ selected_option_id: chosen.optionId }]);
  });

  it("a choice that commits between the publish command's read and its write is not overwritten: the write is conditional on the selection it read", async () => {
    const { h, owner } = await setup();
    const before = (await compose(h, owner, DAY)).board!;
    const chosen = before.options[1]!;
    // TEST interleaving: a commit hook runs after a command has planned and before its batch commits.
    // Here it lets the owner's real `board.select` commit inside that window of the scheduled publish.
    let interleaved = false;
    h.registry.addCommitHook("TEST-interleave-select", async (ctx) => {
      if (interleaved || ctx.envelope.type !== "board.publish" || ctx.userId !== owner.userId) return;
      interleaved = true;
      await owner.exec("board.select", { boardId: before.boardId, optionId: chosen.optionId });
    });
    await prepareBoard(h.deps, await system(h, owner), { localDate: DAY, reason: "refresh", purpose: "morning_refresh", idempotencyKey: "regression-f3-window", nowMs: h.clock.now() });
    expect(interleaved).toBe(true);
    const after = (await getBoard(h.db, owner.principal(), { boardId: before.boardId }))!;
    expect(after.selection?.optionId).toBe(chosen.optionId);
    expect(shape(after)).toEqual(shape(before));
  });
});

describe("review finding 4 (medium): a scheduled first composition never replaces a board the owner made meanwhile", () => {
  it("the owner's board, its options and his selection survive; the scheduled run only rechecks it", async () => {
    const { h, owner } = await setup();
    let inside = false;
    let ownerBoard: BoardDocument | null = null;
    const model: CompositionModel = {
      profile: "TEST-FAKE-interleaving-model",
      async propose(): Promise<OutfitCandidate[]> {
        if (!inside) {
          inside = true;
          ownerBoard = (await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "regression-f4-owner", nowMs: h.clock.now() })).board;
          await owner.exec("board.select", { boardId: ownerBoard!.boardId, optionId: ownerBoard!.options[0]!.optionId });
        }
        return [];
      },
    };
    h.deps.model = model;
    const result = await prepareBoard(h.deps, await system(h, owner), { localDate: DAY, purpose: "evening_compose", idempotencyKey: "regression-f4-system", nowMs: h.clock.now() });
    expect(ownerBoard).not.toBeNull();
    expect(result.note).toMatch(/made or changed while this one was being prepared/);
    const after = (await getBoard(h.db, owner.principal(), { date: DAY }))!;
    expect(after.boardId).toBe(ownerBoard!.boardId);
    expect(after.requestedCount).toBe(3);
    expect(shape(after)).toEqual(shape(ownerBoard!));
    expect(after.selection?.optionId).toBe(ownerBoard!.options[0]!.optionId);
    expect(after.reason).not.toBe("compose");
  });
});

describe("review finding 5 (medium): the 14-16 C jacket rule covers every layer under the jacket and the no-forecast case", () => {
  it("at 15 C a heavier shirt worn as the mid layer under a jacket is refused, explicit or not; the lightweight oxford alone passes", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    const D = "2026-09-19";
    h.weather.setForecast(D, { temperatureByHour: { 0: 15, 8: 15, 14: 20, 19: 15, 23: 15 } });
    await fetchWeatherSnapshot(h.deps, await system(h, owner), { localDate: D, purpose: "adhoc" });
    const base = [{ role: "top" as const, garmentId: g("Lightweight oxford — gold") }, { role: "bottom" as const, garmentId: g("Di Sondrio beige chino") }, { role: "socks" as const, garmentId: g("Merino — inky blue") }, { role: "footwear" as const, garmentId: g("NB 990v4 — grey") }, { role: "outer" as const, garmentId: g("Drake's Olive Jungle Jacket") }];
    const plain = await validateOutfit(h.db, owner.principal(), { forDate: D, nowMs: h.clock.now(), slots: base });
    expect((plain.evidence as any).conditions.departureC).toBe(15);
    expect(blockingCodes(plain)).toEqual([]);

    const mid = g("ISTO denim shirt");
    const layered = [...base, { role: "mid_layer" as const, garmentId: mid }];
    const implicit = await validateOutfit(h.db, owner.principal(), { forDate: D, nowMs: h.clock.now(), slots: layered });
    expect(blockingCodes(implicit)).toContain("jacket_band_requires_lightweight_oxford");
    const explicit = await validateOutfit(h.db, owner.principal(), { forDate: D, nowMs: h.clock.now(), slots: layered, explicitGarmentIds: [mid] });
    expect(blockingCodes(explicit)).toEqual(["jacket_band_requires_lightweight_oxford"]);
    const violation = explicit.violations.find((x) => x.code === "jacket_band_requires_lightweight_oxford")!;
    expect(violation.garmentIds).toEqual([g("Drake's Olive Jungle Jacket"), mid]);
    expect(violation.ruleKey).toBe("thermal.jacket_14_16_lightweight_oxford_only");
    // Without the jacket the same layers are not a jacket-rule matter.
    const noJacket = await validateOutfit(h.db, owner.principal(), { forDate: D, nowMs: h.clock.now(), slots: layered.filter((s) => s.role !== "outer"), explicitGarmentIds: [mid] });
    expect(noJacket.violations.map((x) => x.code)).not.toContain("jacket_band_requires_lightweight_oxford");
  });

  it("with no forecast the band cannot be ruled out: a jacket over a heavier shirt is not offered, and only the owner's own named jacket turns that into a stated advisory", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z", isolate: true });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    const D = "2026-11-20"; // no forecast is recorded for this day
    const jacket = g("Drake's Olive Jungle Jacket");
    const rest = [{ role: "bottom" as const, garmentId: g("Di Sondrio beige chino") }, { role: "socks" as const, garmentId: g("Merino — inky blue") }, { role: "footwear" as const, garmentId: g("NB 990v4 — grey") }, { role: "outer" as const, garmentId: jacket }];
    const heavy = await validateOutfit(h.db, owner.principal(), { forDate: D, nowMs: h.clock.now(), slots: [{ role: "top", garmentId: g("Pima oxford — navy") }, ...rest] });
    expect((heavy.evidence as any).conditions).toMatchObject({ freshness: "unavailable", departureC: null });
    expect(heavy.valid).toBe(false);
    expect(blockingCodes(heavy)).toEqual(["jacket_band_unverified"]);
    const asked = await validateOutfit(h.db, owner.principal(), { forDate: D, nowMs: h.clock.now(), slots: [{ role: "top", garmentId: g("Pima oxford — navy") }, ...rest], explicitGarmentIds: [jacket] });
    expect(blockingCodes(asked)).toEqual([]);
    expect(advisoryCodes(asked)).toContain("jacket_band_unverified");
    const light = await validateOutfit(h.db, owner.principal(), { forDate: D, nowMs: h.clock.now(), slots: [{ role: "top", garmentId: g("Lightweight oxford — gold") }, ...rest] });
    expect(light.violations.map((x) => x.code)).not.toContain("jacket_band_unverified");
    expect(blockingCodes(light)).toEqual([]);

    // A board composed without a forecast never pairs a jacket with anything but a lightweight oxford.
    h.weather.failNext(10);
    const board = (await compose(h, owner, D)).board!;
    expect(board.freshness.weather).toBe("unavailable");
    const rows = await garmentRows(h, owner);
    for (const o of board.options) {
      if (!piece(o, "outer")) continue;
      expect(rows.get(piece(o, "top")!.garmentId)!.attributes.fabricClass, `option ${o.number}`).toBe("lightweight_oxford");
    }
  });
});

describe("review finding 6 (medium): a Calendar restore survives a later revision", () => {
  it("restoring a day whose event was deleted in Calendar, then changing the board before the projector runs, still delivers the event", async () => {
    const { h, owner } = await setup();
    const live = () => h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR).filter((e) => e.status !== "cancelled");
    const doc = (await compose(h, owner, DAY)).board!;
    await projectCalendarEffects(h.deps, { nowMs: h.clock.now() });
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, live()[0]!.eventId);
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[0]!.optionId, role: "top" });
    expect((await projectCalendarEffects(h.deps, { nowMs: h.clock.now() })).map((o) => o.outcome)).toEqual(["suppressed_deleted_externally"]);
    expect((await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!.calendarProjection.state).toBe("suppressed");

    h.clock.advanceMinutes(2);
    await owner.exec("board.restore", { localDate: DAY });
    h.clock.advanceMinutes(1);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[1]!.optionId, role: "top" });
    const outcomes = (await projectCalendarEffects(h.deps, { nowMs: h.clock.now() })).map((o) => o.outcome).sort();
    expect(outcomes).toEqual(["projected", "superseded"]);
    expect(live()).toHaveLength(1);
    expect(h.calendar.allEvents(owner.userId, OUTFIT_CALENDAR)).toHaveLength(1); // the same event, never a second one
    const board = (await getBoard(h.db, owner.principal(), { boardId: doc.boardId }))!;
    expect(board.calendarProjection).toMatchObject({ state: "projected", projectedRevision: board.revision });

    // A deletion after the restore is again the owner's decision and is respected.
    h.calendar.externalDelete(owner.userId, OUTFIT_CALENDAR, live()[0]!.eventId);
    h.clock.advanceMinutes(2);
    await owner.exec("board.swap_slot", { boardId: doc.boardId, optionId: doc.options[2]!.optionId, role: "top" });
    expect((await projectCalendarEffects(h.deps, { nowMs: h.clock.now() })).map((o) => o.outcome)).toEqual(["suppressed_deleted_externally"]);
    expect(live()).toHaveLength(0);
  });
});

describe("review finding 7: watches and jewellery are excluded by classification, not only by name", () => {
  it("SYNTHETIC accessories: a classified watch or ring is refused whatever its name, even on request; an unclassified accessory is never offered; a classified non-jewellery piece with a misleading name is fine", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z" });
    const owner = await realOwner(h);
    const names = await garmentsByName(h, owner);
    const g = (n: string) => names.get(n)!.garment_id;
    const base = [{ role: "top" as const, garmentId: g("Lightweight oxford — gold") }, { role: "bottom" as const, garmentId: g("Di Sondrio beige chino") }, { role: "socks" as const, garmentId: g("Merino — inky blue") }, { role: "footwear" as const, garmentId: g("NB 990v4 — grey") }];
    const create = async (name: string, accessoryKind?: string) => {
      const created = await owner.exec("garment.create", { name, category: "accessory", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, ...(accessoryKind ? { attributes: { accessoryKind } } : {}), source: { kind: "system", note: "synthetic accessory for a rule test; not the owner's" } });
      return created.affected.find((a) => a.kind === "garment")!.id;
    };
    const check = async (id: string, explicit: boolean) => validateOutfit(h.db, owner.principal(), { forDate: DAY, nowMs: h.clock.now(), slots: [...base, { role: "accessory", garmentId: id }], ...(explicit ? { explicitGarmentIds: [id] } : {}) });

    // Classified: the name gives nothing away, the classification decides - also against an explicit request.
    for (const [name, kind] of [["Seiko SKX007 diver (synthetic boundary piece)", "watch"], ["Signet (synthetic boundary piece)", "ring"], ["Silver curb (synthetic boundary piece)", "chain"], ["Tank on a strap (synthetic boundary piece)", "bracelet"]] as const) {
      const id = await create(name, kind);
      for (const explicit of [false, true]) {
        const v = await check(id, explicit);
        expect(blockingCodes(v), `${name} classified ${kind}, explicit ${explicit}`).toEqual(["accessory_excluded"]);
        expect(v.violations.find((x) => x.code === "accessory_excluded")!.ruleKey).toBe("accessories.no_watches_or_jewellery");
      }
    }
    // The review's reproductions: no classification and no keyword in the name. None is ever offered.
    for (const name of ["Seiko SKX007 diver (synthetic boundary piece)", "Signet ring (synthetic boundary piece)", "Silver chain (synthetic boundary piece)", "Steel wristwatch (synthetic boundary piece)"]) {
      const v = await check(await create(name), false);
      expect(v.valid, name).toBe(false);
      expect(["accessory_excluded", "accessory_unclassified"]).toContain(blockingCodes(v)[0]);
    }
    // Classification outranks the name backstop: a watch cap is a hat.
    const cap = await check(await create("Navy watch cap (synthetic boundary piece)", "hat"), false);
    expect(cap.violations.map((x) => x.code).filter((c) => c.startsWith("accessory_"))).toEqual([]);

    // The owner's real accessories are untouched by the rule.
    const square = g("Anglo-Italian pocket square");
    const real = await check(square, true);
    expect(real.violations.map((x) => x.code).filter((c) => c.startsWith("accessory_"))).toEqual([]);
  });

  it("the verdict uses the rule's own excluded words", () => {
    const piece = (name: string, accessoryKind?: string, category = "accessory") => ({ name, category: category as never, roles: ["accessory" as const], attributes: (accessoryKind ? { accessoryKind } : {}) as never });
    expect(accessoryVerdict(piece("Diver", "watch"), ["watch", "jewellery"])).toBe("excluded");
    expect(accessoryVerdict(piece("Diver", "watch"), ["jewellery"])).toBe("allowed");
    expect(accessoryVerdict(piece("Band", "bracelet"), ["watch", "jewellery"])).toBe("excluded");
    // A value older than the contract's enum (stored before it existed) is still read as a watch.
    expect(accessoryVerdict(piece("Speedmaster", "Wristwatch"), ["watch", "jewellery"])).toBe("excluded");
    expect(accessoryVerdict(piece("Diver"), ["watch", "jewellery"])).toBe("unclassified");
    expect(accessoryVerdict(piece("Chain-stitch chino", undefined, "trousers"), ["watch", "jewellery"])).toBe("allowed");
    expect(accessoryVerdict(piece("Field watch", undefined, "other"), ["watch", "jewellery"])).toBe("excluded");
  });
});

describe("review, low severity", () => {
  it("forecast freshness is judged at read time: a board whose refresh never ran stops reading as fresh", async () => {
    const { h, owner } = await setup();
    const before = (await compose(h, owner, DAY)).board!;
    expect(before.freshness.weather).toBe("fresh");
    const soon = (await getToday(h.db, owner.principal(), { date: DAY, nowMs: h.clock.now() })).board!;
    expect(soon).toMatchObject({ validity: "current", freshness: { weather: "fresh" } });
    const late = (await getToday(h.db, owner.principal(), { date: DAY, nowMs: h.clock.now() + 13 * 3600_000 })).board!;
    expect(late.revision).toBe(before.revision);
    expect(late).toMatchObject({ validity: "limited", freshness: { weather: "stale" } });
  });

  it("a phase that runs out of attempts says so once, on the run and on Today, instead of stopping silently", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:30:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const real = h.deps.commands;
    // TEST FAKE: a command service that is down, standing in for a D1 outage during the phase.
    const down = Object.create(real) as typeof real;
    down.execute = async () => {
      throw new Error("TEST-FAKE outage: the command service is unreachable");
    };
    h.deps.commands = down;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const run = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: DAY, phase: "evening_compose", force: true });
      expect(run.status, `attempt ${attempt}`).toBe("failed");
      expect(run.detail.gaveUp).toBeUndefined();
    }
    const sweep = await runDueJobs(h.deps);
    const gaveUp = sweep.runs.find((r) => r.phase === "evening_compose" && r.localDate === DAY)!;
    expect(gaveUp).toMatchObject({ status: "failed", detail: { gaveUp: true, attempts: 5 } });
    expect(String(gaveUp.detail.error)).toMatch(/TEST-FAKE outage/);
    // Reported once, not on every later sweep.
    expect((await runDueJobs(h.deps)).runs.filter((r) => r.phase === "evening_compose" && r.localDate === DAY)).toEqual([]);
    h.deps.commands = real;
    expect((await getToday(h.db, owner.principal(), { date: DAY, nowMs: h.clock.now() })).emptyReason).toMatch(/failed repeatedly and has stopped trying/);
  });

  it("the phase lease covers three model budgets, and never drops below five minutes", () => {
    expect(phaseLeaseMs({})).toBe(3 * 120_000 + 60_000);
    expect(phaseLeaseMs({ modelBudgetMs: 240_000 })).toBe(13 * 60_000);
    expect(phaseLeaseMs({ modelBudgetMs: 1_000 })).toBe(5 * 60_000);
  });

  it("the in-commit overlay only trusts stock writes in the shape it reads; anything else defers the repair to the sweep", () => {
    expect(stockWritesRecognized([{ sql: "DELETE FROM stock_balances WHERE user_id = ? AND garment_id = ?" }, { sql: "INSERT INTO stock_balances (user_id, garment_id, bucket, ref, quantity, held) VALUES (?, ?, ?, ?, ?, ?)" }, { sql: "UPDATE garments SET name = ? WHERE garment_id = ?" }])).toBe(true);
    expect(stockWritesRecognized([{ sql: "UPDATE stock_balances SET quantity = quantity - 1 WHERE user_id = ? AND garment_id = ? AND bucket = 'clean'" }])).toBe(false);
    expect(stockWritesRecognized([{ sql: "INSERT INTO stock_balances (user_id, garment_id, bucket, quantity) VALUES (?, ?, ?, ?)" }])).toBe(false);
    expect(stockWritesRecognized([{ sql: "DELETE FROM stock_balances WHERE user_id = ?" }])).toBe(false);
  });

  it("a Calendar disconnected overnight is carried onto the morning board as not connected, not as last night's successful read", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:30:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const evening = (await compose(h, owner, DAY)).board!;
    expect(evening.freshness.calendar).toBe("ok");
    h.calendar.setConnected(owner.userId, false);
    h.clock.set("2026-09-16T05:41:00Z");
    const run = await runOwnerPhase(h.deps, { userId: owner.userId, localDate: DAY, phase: "morning_refresh", force: true });
    expect(run).toMatchObject({ status: "succeeded", detail: { calendar: "not_connected" } });
    const morning = (await getBoard(h.db, owner.principal(), { boardId: evening.boardId }, { nowMs: h.clock.now() }))!;
    expect(morning.revision).toBeGreaterThan(evening.revision);
    expect(morning.freshness.calendar).toBe("not_connected");
    expect(morning.notice).toMatch(/Calendar is not connected/);
    expect(morning.options).toHaveLength(5);
  });

  it("a managed outfit event is never a commitment, whichever board the calendar is read for", async () => {
    const { h, owner } = await setup();
    const homeEvent = await managedEventId(owner.userId, "home", DAY);
    const eveningEvent = await managedEventId(owner.userId, "home:evening", DAY);
    const raw = (eventId: string, title: string) => ({ eventId, calendarId: "primary", title, startsAt: "2026-09-16T06:00:00Z", endsAt: "2026-09-16T06:15:00Z", allDay: false, location: null, attendance: "accepted" as const, cancelled: false });
    h.calendar.seedReadEvents(owner.userId, "primary", [raw(homeEvent, "Outfits for Wednesday 16 September"), raw(eveningEvent, "Outfits for Wednesday evening"), raw("evt-real-dinner", "Dinner with Sam")]);
    for (const scope of ["home", "home:evening"]) {
      const snapshot = await readCalendarSnapshot(h.deps, owner.principal(), { localDate: DAY, scope, nowMs: h.clock.now(), record: false });
      expect(snapshot.events.map((e) => e.eventId), scope).toEqual(["evt-real-dinner"]);
    }
  });

  it("every harness starts without the shared forecast cache, isolated or not", async () => {
    const first = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z" });
    const owner = await realOwner(first);
    first.weather.setForecast(DAY, MILD_DAY);
    await fetchWeatherSnapshot(first.deps, await system(first, owner), { localDate: DAY, purpose: "adhoc" });
    expect((await all<{ n: number }>(first.db, "SELECT COUNT(*) AS n FROM weather_cache"))[0]!.n).toBeGreaterThan(0);
    const second = await createDailyHarness({ startAt: "2026-09-15T07:30:00Z" });
    expect((await all<{ n: number }>(second.db, "SELECT COUNT(*) AS n FROM weather_cache"))[0]!.n).toBe(0);
  });
});
