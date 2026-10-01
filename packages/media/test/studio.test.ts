import { beforeAll, describe, expect, it } from "vitest";
import { outfitValidator, registerDaily } from "@garderobe/daily";
import { all, first, isCommandError } from "@garderobe/domain";
import type { TestOwner } from "@garderobe/domain/testing";
import type { Role } from "@garderobe/contracts";
import {
  composeOutfit, getStudioSelectors, knownCombinationsForGarment, listStudioCombinations, listStudioDayPlans, suggestStudioOutfits, validateStudioOutfit,
} from "../src/index.ts";
import { createMediaHarness, type MediaHarness } from "../src/testing/index.ts";

// Studio with the DAILY SERVICE'S REAL validator injected (the same `outfitValidator` the Worker mounts) and the
// daily commands and board-repair hook registered beside the Studio hook. Owners here are labelled synthetic
// fixtures; the owner's real inventory is exercised in test/real-inventory.test.ts.

type Slot = { role: Role; garmentId: string };

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string; details: any }> {
  try {
    await p;
    return { code: "ok", message: "", details: null };
  } catch (e) {
    if (isCommandError(e)) return { code: e.code, message: e.message, details: (e as { details?: unknown }).details ?? null };
    throw e;
  }
}

const OUTFIT: Slot[] = [{ role: "top", garmentId: "shirt-moss" }, { role: "bottom", garmentId: "trouser-olive" }, { role: "footwear", garmentId: "shoe-navy" }, { role: "socks", garmentId: "sock-navy" }];
const SECOND: Slot[] = [{ role: "top", garmentId: "shirt-gold" }, { role: "bottom", garmentId: "trouser-beige" }, { role: "footwear", garmentId: "shoe-olive" }, { role: "socks", garmentId: "sock-grey" }];
const TODAY = "2026-09-15";
const TOMORROW = "2026-09-16";

describe("Studio: browsing, saving, planning and removing through the command service (daily service validator)", () => {
  let h: MediaHarness;
  let owner: TestOwner;
  let bob: TestOwner;
  const counts = async (o: TestOwner) => ({
    commands: (await all(h.db, "SELECT 1 FROM commands WHERE user_id = ?", o.userId)).length,
    wears: (await all(h.db, "SELECT 1 FROM daily_wears WHERE user_id = ?", o.userId)).length,
    combinations: (await all(h.db, "SELECT 1 FROM studio_combinations WHERE user_id = ?", o.userId)).length,
    plans: (await all(h.db, "SELECT 1 FROM studio_day_plans WHERE user_id = ?", o.userId)).length,
    exposures: (await all(h.db, "SELECT 1 FROM exposure_sets WHERE user_id = ?", o.userId)).length,
  });

  beforeAll(async () => {
    h = await createMediaHarness({ adapters: { validator: outfitValidator }, extend: (registry) => registerDaily(registry) });
    owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (Studio)" });
    bob = await h.createSyntheticOwner({ displayName: "Synthetic owner B (Studio)" });
  });

  it("browsing is read-only: selectors, validation, suggestions and composition write nothing", async () => {
    const before = await counts(owner);
    const today = await getStudioSelectors(h.rt, owner.principal(), { mode: "for_today" });
    expect(today).toMatchObject({ mode: "for_today", forDate: TODAY });
    expect(today.selectors.filter((s) => s.primary).map((s) => s.role)).toEqual(["top", "bottom", "footwear", "outer"]);
    const items = (sel: typeof today, role: Role) => sel.selectors.find((s) => s.role === role)!.items;
    // For today: only eligible owned pieces. The ordered shirt has not arrived, so it is not offered.
    expect(items(today, "top").every((i) => i.eligibleToday && i.marker === "owned")).toBe(true);
    expect(items(today, "top").map((i) => i.garmentId)).not.toContain("shirt-ordered");
    expect(items(today, "top").map((i) => i.garmentId)).toContain("shirt-moss");
    // Every tile says honestly that there is no picture; nothing is invented for it.
    expect(items(today, "top")[0]!.image).toMatchObject({ hasRealImage: false, renditionId: null, missingImageNote: "No photo yet" });
    // The opening outfit comes from the validator's own suggestion and is itself valid to wear today.
    expect(today.opening.map((s) => s.role).sort()).toEqual(["bottom", "footwear", "socks", "top"]);
    expect((await validateStudioOutfit(h.rt, owner.principal(), { slots: today.opening, mode: "for_today" })).valid).toBe(true);

    // Explore: also incoming pieces and supplied shopping candidates, each clearly marked and never "owned".
    const explore = await getStudioSelectors(h.rt, owner.principal(), { mode: "explore", shoppingCandidates: [{ role: "outer", candidateId: "cand-waxed", label: "Waxed jacket (considering)", sourceUrl: "https://shop.example.org/waxed" }] });
    expect(items(explore, "top").find((i) => i.garmentId === "shirt-ordered")).toMatchObject({ marker: "incoming", eligibleToday: false });
    expect(items(explore, "outer").find((i) => i.shoppingCandidate?.candidateId === "cand-waxed")).toMatchObject({ garmentId: null, marker: "shopping_candidate", eligibleToday: false, reasons: ["not_owned"], image: null });
    expect(items(today, "outer").some((i) => i.marker === "shopping_candidate")).toBe(false);

    const verdict = await validateStudioOutfit(h.rt, owner.principal(), { slots: OUTFIT, mode: "for_today" });
    expect(verdict).toMatchObject({ valid: true, wearableOn: TODAY, validator: "daily-service" });
    await suggestStudioOutfits(h.rt, owner.principal(), { slots: [], mode: "for_today", limit: 2 });
    await composeOutfit(h.rt, owner.principal(), { slots: OUTFIT });
    expect(await counts(owner)).toEqual(before);
    // Reads need an authenticated owner with read scope.
    expect((await refusal(getStudioSelectors(h.rt, owner.principal({ scopes: [] }), { mode: "for_today" }))).code).toBe("forbidden");
    expect((await refusal(validateStudioOutfit(h.rt, owner.principal({ scopes: [] }), { slots: OUTFIT, mode: "for_today" }))).code).toBe("forbidden");
  });

  it("applies the owner's rules through the daily service: no sockless outfit, nothing not yet arrived, one piece per slot", async () => {
    const noSocks = await validateStudioOutfit(h.rt, owner.principal(), { slots: OUTFIT.slice(0, 3), mode: "for_today" });
    expect(noSocks.valid).toBe(false);
    expect(noSocks.violations.find((v) => v.severity === "blocking")).toMatchObject({ code: "socks_required", message: "Every outfit includes socks; there is no sockless option" });

    const incoming: Slot[] = [{ role: "top", garmentId: "shirt-ordered" }, ...OUTFIT.slice(1)];
    const wearToday = await validateStudioOutfit(h.rt, owner.principal(), { slots: incoming, mode: "for_today" });
    expect(wearToday.valid).toBe(false);
    expect(wearToday.violations.find((v) => v.garmentIds.includes("shirt-ordered"))).toMatchObject({ severity: "blocking", message: expect.stringMatching(/ordered but not arrived/) });
    // Exploring with it is allowed, and the same fact is shown as an advisory; the verdict is never "wearable today".
    const exploring = await validateStudioOutfit(h.rt, owner.principal(), { slots: incoming, mode: "explore" });
    expect(exploring).toMatchObject({ valid: true, wearableOn: null });
    expect(exploring.violations.find((v) => v.garmentIds.includes("shirt-ordered"))).toMatchObject({ severity: "advisory" });

    const twoTops = await validateStudioOutfit(h.rt, owner.principal(), { slots: [...OUTFIT, { role: "top", garmentId: "shirt-gold" }], mode: "for_today" });
    expect(twoTops.valid).toBe(false);
    const asShoes = await validateStudioOutfit(h.rt, owner.principal(), { slots: [OUTFIT[0]!, OUTFIT[1]!, { role: "footwear", garmentId: "shirt-gold" }, OUTFIT[3]!], mode: "for_today" });
    expect(asShoes.valid).toBe(false); // a shirt is not footwear
    expect((await refusal(validateStudioOutfit(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "not-a-garment" }], mode: "for_today" }))).code).toBe("not_found");
    expect((await refusal(validateStudioOutfit(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "shirt-moss", shoppingCandidate: { candidateId: "c", label: "both" } }], mode: "explore" }))).code).toBe("invalid_command");
  });

  it("suggestions keep locked pieces exactly and fill only the open slots with valid outfits", async () => {
    const suggestions = await suggestStudioOutfits(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "shirt-gold", locked: true }, { role: "footwear", garmentId: "shoe-olive", locked: true }], mode: "for_today", limit: 3 });
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(s.slots.filter((x) => x.role === "top")).toEqual([{ role: "top", garmentId: "shirt-gold", shoppingCandidate: null, locked: true }]);
      expect(s.slots.filter((x) => x.role === "footwear")).toEqual([{ role: "footwear", garmentId: "shoe-olive", shoppingCandidate: null, locked: true }]);
      expect(s.slots.filter((x) => !x.locked).map((x) => x.role).sort()).toEqual(["bottom", "socks"]);
      expect(s.validation).toMatchObject({ valid: true, validator: "daily-service" });
      expect(s.reason.length).toBeGreaterThan(0);
    }
    // A validator that moves a locked piece or names a garment the owner does not have is not believed.
    const real = h.deps.validator;
    h.deps.validator = { // TEST DOUBLE: a misbehaving suggestion source
      validate: outfitValidator.validate,
      async suggest() {
        return [
          { slots: [{ role: "top", garmentId: "shirt-slate" }, OUTFIT[1]!, OUTFIT[2]!, OUTFIT[3]!], reason: "swapped the locked shirt" },
          { slots: [{ role: "top", garmentId: "shirt-gold" }, { role: "bottom", garmentId: "someone-elses-trousers" }, OUTFIT[2]!, OUTFIT[3]!], reason: "unknown garment" },
          { slots: [{ role: "top", garmentId: "shirt-gold" }, OUTFIT[1]!, OUTFIT[2]!], reason: "sockless" },
          { slots: [{ role: "top", garmentId: "shirt-gold" }, OUTFIT[1]!, OUTFIT[2]!, OUTFIT[3]!], reason: "fine" },
        ];
      },
    };
    const filtered = await suggestStudioOutfits(h.rt, owner.principal(), { slots: [{ role: "top", garmentId: "shirt-gold", locked: true }], mode: "for_today" });
    h.deps.validator = real;
    expect(filtered.map((s) => s.reason)).toEqual(["fine"]);
  });

  it("saves a combination with a receipt, keeps one identity for the same pieces, and refuses what cannot be worn", async () => {
    const before = await counts(owner);
    const receipt = await owner.exec("studio.save_combination", { name: "Moss and olive", favourite: true, slots: OUTFIT, mode: "for_today" });
    expect(receipt).toMatchObject({ type: "studio.save_combination", outcome: "committed", actor: "owner", summary: "Saved combination: moss lightweight oxford, olive fatigues, navy 990v4 sneakers, navy merino socks" });
    const id = String(receipt.result.combinationId);
    expect(receipt.affected).toEqual([{ kind: "studio_combination", id, version: 1 }]);
    expect(receipt.result).toMatchObject({ garmentIds: ["shirt-moss", "trouser-olive", "shoe-navy", "sock-navy"], validation: { valid: true, validator: "daily-service", wearableOn: TODAY } });
    expect(receipt.undo.available).toBe(true);
    // Saving is not planning and not wearing.
    expect(await counts(owner)).toEqual({ ...before, commands: before.commands + 1, combinations: before.combinations + 1 });

    const saved = await listStudioCombinations(h.rt, owner.principal());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ combinationId: id, name: "Moss and olive", favourite: true, containsShoppingCandidate: false, status: "active", version: 1, manifestHash: (await composeOutfit(h.rt, owner.principal(), { slots: OUTFIT })).manifestHash });
    expect(saved[0]!.slots.every((s) => s.locked === false)).toBe(true); // locks are presentation state, not stored
    expect((await knownCombinationsForGarment(h.rt, owner.principal(), "shoe-navy")).map((c) => c.combinationId)).toEqual([id]);
    expect(await knownCombinationsForGarment(h.rt, owner.principal(), "shoe-olive")).toEqual([]);
    expect((await h.service.listReceipts(owner.principal(), { kind: "studio_combination", entityId: id })).map((r) => r.type)).toEqual(["studio.save_combination"]);

    // The same pieces in another order are the same combination, not a duplicate.
    const again = await owner.exec("studio.save_combination", { slots: [...OUTFIT].reverse(), mode: "for_today" });
    expect(again).toMatchObject({ outcome: "noop", result: { combinationId: id, alreadySaved: true } });
    // A retried request with the same idempotency key returns the stored receipt and writes nothing.
    const key = "studio-save-retry-0001";
    const one = await owner.exec("studio.save_combination", { slots: SECOND, mode: "for_today" }, { idempotencyKey: key });
    const two = await owner.exec("studio.save_combination", { slots: SECOND, mode: "for_today" }, { idempotencyKey: key });
    expect(two).toMatchObject({ commandId: one.commandId, replayed: true });
    expect(await listStudioCombinations(h.rt, owner.principal())).toHaveLength(2);

    // Refused, with the validator's own reason, and nothing written.
    const stored = (await counts(owner)).combinations;
    const sockless = await refusal(owner.exec("studio.save_combination", { slots: OUTFIT.slice(0, 3).map((s, i) => (i === 0 ? { role: "top", garmentId: "shirt-slate" } : s)), mode: "for_today" }));
    expect(sockless).toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/^This combination cannot be saved: Every outfit includes socks.*nothing was written$/) });
    expect(sockless.details.validator).toBe("daily-service");
    expect((await refusal(owner.exec("studio.save_combination", { slots: [{ role: "top", garmentId: "not-a-garment" }], mode: "explore" }))).code).toBe("not_found");
    expect((await refusal(owner.exec("studio.save_combination", { slots: [], mode: "explore" }))).code).toBe("invalid_command");
    expect((await refusal(owner.exec("studio.save_combination", { slots: OUTFIT, mode: "for_today" }, { scopes: ["read"] }))).code).toBe("forbidden");
    expect((await counts(owner)).combinations).toBe(stored);
  });

  it("updates, removes and undoes a saved combination; another owner can neither see nor touch it", async () => {
    const [first_] = (await listStudioCombinations(h.rt, owner.principal())).filter((c) => c.name === "Moss and olive");
    const id = first_!.combinationId;
    const renamed = await owner.exec("studio.save_combination", { combinationId: id, name: "Moss, olive, grey socks", favourite: false, slots: [...OUTFIT.slice(0, 3), { role: "socks", garmentId: "sock-grey" }], mode: "for_today" });
    expect(renamed).toMatchObject({ outcome: "committed", affected: [{ kind: "studio_combination", id, version: 2 }] });
    expect((await knownCombinationsForGarment(h.rt, owner.principal(), "sock-navy")).map((c) => c.combinationId)).not.toContain(id);
    await owner.exec("command.undo", { commandId: renamed.commandId });
    const restored = (await listStudioCombinations(h.rt, owner.principal())).find((c) => c.combinationId === id)!;
    expect(restored).toMatchObject({ name: "Moss and olive", favourite: true, version: 3 });
    expect(restored.slots.map((s) => s.garmentId)).toContain("sock-navy");
    expect((await knownCombinationsForGarment(h.rt, owner.principal(), "sock-navy")).map((c) => c.combinationId)).toContain(id);

    // The other owner has garments with the very same IDs, and still sees and reaches nothing.
    expect(await listStudioCombinations(h.rt, bob.principal())).toEqual([]);
    expect(await knownCombinationsForGarment(h.rt, bob.principal(), "shoe-navy")).toEqual([]);
    expect((await refusal(bob.exec("studio.remove_combination", { combinationId: id }))).code).toBe("not_found");
    expect((await refusal(bob.exec("studio.plan_for_day", { localDate: TOMORROW, combinationId: id }))).code).toBe("not_found");
    expect((await refusal(bob.exec("command.undo", { commandId: renamed.commandId }))).code).toBe("not_found");
    // Bob updating "that ID" creates nothing of the first owner's: it becomes his own combination of his own garments.
    const his = await bob.exec("studio.save_combination", { combinationId: id, slots: OUTFIT, mode: "for_today" });
    expect(his.outcome).toBe("committed");
    expect((await listStudioCombinations(h.rt, owner.principal())).find((c) => c.combinationId === id)).toMatchObject({ name: "Moss and olive", version: 3 });
    expect(await all(h.db, "SELECT 1 FROM studio_combinations WHERE combination_id = ?", id)).toHaveLength(2);

    const removed = await owner.exec("studio.remove_combination", { combinationId: id });
    expect(removed).toMatchObject({ outcome: "committed", summary: "Removed the saved combination" });
    expect((await listStudioCombinations(h.rt, owner.principal())).map((c) => c.combinationId)).not.toContain(id);
    expect((await listStudioCombinations(h.rt, owner.principal(), { includeRemoved: true })).find((c) => c.combinationId === id)!.status).toBe("removed");
    expect(await knownCombinationsForGarment(h.rt, owner.principal(), "shoe-navy")).toEqual([]);
    expect((await owner.exec("studio.remove_combination", { combinationId: id })).outcome).toBe("noop");
    expect((await refusal(owner.exec("studio.save_combination", { combinationId: id, slots: OUTFIT, mode: "for_today" }))).code).toBe("precondition_failed"); // a removed one is not silently revived
    await owner.exec("command.undo", { commandId: removed.commandId });
    expect((await listStudioCombinations(h.rt, owner.principal())).map((c) => c.combinationId)).toContain(id);
    // Undoing the original save removes it again, through the ledger.
    const fresh = await owner.exec("studio.save_combination", { slots: [{ role: "top", garmentId: "shirt-red-stripe" }, { role: "bottom", garmentId: "trouser-navy" }, { role: "footwear", garmentId: "shoe-navy" }, { role: "socks", garmentId: "sock-grey" }], mode: "for_today" });
    await owner.exec("command.undo", { commandId: fresh.commandId });
    expect((await listStudioCombinations(h.rt, owner.principal())).map((c) => c.combinationId)).not.toContain(String(fresh.result.combinationId));
  });

  it("a shopping candidate can be explored and saved as such, and can never be planned or worn", async () => {
    const withCandidate = [...OUTFIT, { role: "outer" as Role, shoppingCandidate: { candidateId: "cand-waxed", label: "Waxed jacket (considering)", sourceUrl: "https://shop.example.org/waxed" } }];
    const explore = await validateStudioOutfit(h.rt, owner.principal(), { slots: withCandidate, mode: "explore" });
    expect(explore).toMatchObject({ valid: true, wearableOn: null });
    expect(explore.violations.find((v) => v.code === "shopping_candidate_not_owned")).toMatchObject({ severity: "advisory" });
    expect((await validateStudioOutfit(h.rt, owner.principal(), { slots: withCandidate, mode: "for_today" })).violations.find((v) => v.code === "shopping_candidate_not_owned")).toMatchObject({ severity: "blocking" });

    const garmentsBefore = (await all(h.db, "SELECT 1 FROM garments WHERE user_id = ?", owner.userId)).length;
    const saved = await owner.exec("studio.save_combination", { name: "With the waxed jacket", slots: withCandidate, mode: "explore" });
    expect(saved.summary).toMatch(/\(includes a shopping candidate that is not owned\)$/);
    const combination = (await listStudioCombinations(h.rt, owner.principal())).find((c) => c.combinationId === saved.result.combinationId)!;
    expect(combination).toMatchObject({ containsShoppingCandidate: true, validation: { valid: true, wearableOn: null } });
    // The candidate did not become a garment, and the composition labels it.
    expect((await all(h.db, "SELECT 1 FROM garments WHERE user_id = ?", owner.userId)).length).toBe(garmentsBefore);
    const composition = await composeOutfit(h.rt, owner.principal(), { slots: withCandidate });
    expect(composition.labels).toContain("Shopping candidate");
    expect(composition.manifest.layers.find((l) => l.role === "outer")).toMatchObject({ garmentId: null, shoppingCandidateId: "cand-waxed", imageLabel: "shopping_candidate", renditionId: null });

    expect((await refusal(owner.exec("studio.save_combination", { slots: withCandidate, mode: "for_today" }))).code).toBe("precondition_failed");
    const plan = await refusal(owner.exec("studio.plan_for_day", { localDate: TOMORROW, combinationId: saved.result.combinationId }));
    expect(plan).toMatchObject({ code: "precondition_failed", message: expect.stringMatching(/shopping candidate, which is not owned and cannot be worn or planned/) });
    expect((await refusal(owner.exec("studio.plan_for_day", { localDate: TOMORROW, slots: [{ role: "outer", shoppingCandidate: { candidateId: "cand-waxed", label: "Waxed jacket" } }] }))).code).toBe("precondition_failed");
    expect(await all(h.db, "SELECT 1 FROM studio_day_plans WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("plans a day as an intention (never a wear), replaces and removes plans, and keeps the availability estimator informed", async () => {
    const before = await counts(owner);
    const planned = await owner.exec("studio.plan_for_day", { localDate: TOMORROW, slots: OUTFIT });
    expect(planned).toMatchObject({ type: "studio.plan_for_day", outcome: "committed", summary: `Planned for ${TOMORROW}: moss lightweight oxford, olive fatigues, navy 990v4 sneakers, navy merino socks (an intention, not a recorded wear)` });
    const planId = String(planned.result.planId);
    expect(planned.result).toMatchObject({ localDate: TOMORROW, replacedPlanId: null, validation: { valid: true, wearableOn: TOMORROW, validator: "daily-service" } });
    expect(planned.affected).toContainEqual({ kind: "studio_day_plan", id: planId, version: 1 });
    // An intention: no wear, no stock movement, nothing dirty.
    const after = await counts(owner);
    expect(after).toEqual({ ...before, commands: before.commands + 1, plans: before.plans + 1, exposures: before.exposures + 1 });
    expect(await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'wear.record'", owner.userId)).toHaveLength(0);
    // It is registered with the availability estimator as the chosen option for that date.
    const exposure = await first<{ local_date: string; source_kind: string; source_ref: string; selected_option_id: string; status: string }>(h.db, "SELECT local_date, source_kind, source_ref, selected_option_id, status FROM exposure_sets WHERE user_id = ? AND exposure_id = ?", owner.userId, String(planned.result.exposureId));
    expect(exposure).toEqual({ local_date: TOMORROW, source_kind: "plan", source_ref: `studio:${planId}`, selected_option_id: "plan", status: "selected" });
    expect((await all<{ garment_id: string }>(h.db, "SELECT garment_id FROM exposure_items WHERE user_id = ? AND exposure_id = ? ORDER BY garment_id", owner.userId, String(planned.result.exposureId))).map((r) => r.garment_id)).toEqual(["shirt-moss", "shoe-navy", "sock-navy", "trouser-olive"]);

    const plans = await listStudioDayPlans(h.rt, owner.principal());
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ planId, localDate: TOMORROW, status: "planned", needsRevalidation: false, combinationId: null });

    // Refusals: a past day, an empty plan, an outfit that breaks a rule on that date.
    expect(await refusal(owner.exec("studio.plan_for_day", { localDate: "2026-09-14", slots: OUTFIT }))).toMatchObject({ code: "invalid_command", message: expect.stringMatching(/a day that has passed cannot be planned/) });
    expect((await refusal(owner.exec("studio.plan_for_day", { localDate: TOMORROW }))).code).toBe("invalid_command");
    expect(await refusal(owner.exec("studio.plan_for_day", { localDate: TOMORROW, slots: OUTFIT.slice(0, 3) }))).toMatchObject({ code: "precondition_failed", message: expect.stringMatching(new RegExp(`^This outfit cannot be planned for ${TOMORROW}: Every outfit includes socks`)) });
    expect((await refusal(owner.exec("studio.plan_for_day", { localDate: TOMORROW, slots: [{ role: "top", garmentId: "shirt-ordered" }, ...OUTFIT.slice(1)] }))).code).toBe("precondition_failed");
    expect(await listStudioDayPlans(h.rt, owner.principal())).toHaveLength(1);

    // Planning the same day again replaces the plan: one plan per day, the old exposure superseded.
    const combination = (await listStudioCombinations(h.rt, owner.principal())).find((c) => c.slots.some((s) => s.garmentId === "shirt-gold") && !c.containsShoppingCandidate)!;
    const replaced = await owner.exec("studio.plan_for_day", { localDate: TOMORROW, combinationId: combination.combinationId });
    expect(replaced.result).toMatchObject({ replacedPlanId: planId });
    expect(replaced.summary).toMatch(/it replaces the earlier plan for that day$/);
    const now = await listStudioDayPlans(h.rt, owner.principal(), { includeRemoved: true });
    expect(now.map((p) => [p.planId, p.status])).toEqual(expect.arrayContaining([[planId, "removed"], [String(replaced.result.planId), "planned"]]));
    expect((await listStudioDayPlans(h.rt, owner.principal())).map((p) => p.combinationId)).toEqual([combination.combinationId]);
    expect((await first<{ status: string }>(h.db, "SELECT status FROM exposure_sets WHERE user_id = ? AND exposure_id = ?", owner.userId, String(planned.result.exposureId)))!.status).toBe("superseded");
    // Removing the combination a plan was made from keeps the plan.
    const gone = await owner.exec("studio.remove_combination", { combinationId: combination.combinationId });
    expect(gone.summary).toBe("Removed the saved combination; 1 day plan(s) made from it are kept");
    expect(await listStudioDayPlans(h.rt, owner.principal())).toHaveLength(1);

    // Another owner cannot see or remove the plan.
    expect(await listStudioDayPlans(h.rt, bob.principal())).toEqual([]);
    expect((await refusal(bob.exec("studio.remove_day_plan", { planId: String(replaced.result.planId) }))).code).toBe("not_found");

    // Remove, then undo the removal: the plan returns flagged for a fresh check.
    const removal = await owner.exec("studio.remove_day_plan", { planId: String(replaced.result.planId) });
    expect(removal.summary).toBe(`Removed the plan for ${TOMORROW}; nothing was worn or reserved by it`);
    expect(await listStudioDayPlans(h.rt, owner.principal())).toEqual([]);
    expect((await first<{ status: string }>(h.db, "SELECT status FROM exposure_sets WHERE user_id = ? AND exposure_id = ?", owner.userId, String(replaced.result.exposureId)))!.status).toBe("superseded");
    expect((await owner.exec("studio.remove_day_plan", { planId: String(replaced.result.planId) })).outcome).toBe("noop");
    await owner.exec("command.undo", { commandId: removal.commandId });
    const back = await listStudioDayPlans(h.rt, owner.principal());
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ planId: String(replaced.result.planId), needsRevalidation: true, revalidationReason: "restored by undo", validation: { valid: true } });
    // Undoing the plan itself removes it.
    await owner.exec("command.undo", { commandId: replaced.commandId });
    expect(await listStudioDayPlans(h.rt, owner.principal())).toEqual([]);
    expect((await counts(owner)).wears).toBe(0);
  });

  it("flags an upcoming plan in the same commit when a planned garment's availability changes, and re-checks it on read", async () => {
    const fresh = await h.createSyntheticOwner({ displayName: "Synthetic owner (Studio, availability)" });
    const planned = await fresh.exec("studio.plan_for_day", { localDate: TOMORROW, slots: SECOND });
    const untouched = await fresh.exec("studio.plan_for_day", { localDate: "2026-09-17", slots: OUTFIT });
    // The gold shirt (one unit) is found dirty: it will not be clean tomorrow.
    const dirty = await fresh.exec("care.mark_dirty", { items: [{ garmentId: "shirt-gold", quantity: 1 }] });
    expect(dirty.repairs).toContain(`The Studio plan for ${TOMORROW} uses a garment whose availability changed; it will be re-checked`);
    const plans = await listStudioDayPlans(h.rt, fresh.principal());
    const hit = plans.find((p) => p.planId === planned.result.planId)!;
    expect(hit).toMatchObject({ status: "planned", needsRevalidation: true, revalidationReason: "availability changed after 'care.mark_dirty'" });
    // The owner's plan is not rewritten; the read shows the current verdict and why.
    expect(hit.slots.map((s) => s.garmentId)).toEqual(SECOND.map((s) => s.garmentId));
    expect(hit.validation.valid).toBe(false);
    expect(hit.validation.violations.find((v) => v.severity === "blocking")).toMatchObject({ garmentIds: ["shirt-gold"] });
    expect(Date.parse(hit.validation.checkedAt)).toBe(h.clock.now());
    // The plan that does not use the shirt is left alone.
    expect(plans.find((p) => p.planId === untouched.result.planId)).toMatchObject({ needsRevalidation: false, validation: { valid: true } });
    // Planning the dirty shirt afresh is refused by the same validator.
    expect((await refusal(fresh.exec("studio.plan_for_day", { localDate: "2026-09-18", slots: SECOND }))).code).toBe("precondition_failed");

    // Washing it makes the plan valid again on the next read (still flagged as re-checked).
    await fresh.exec("care.washed", { items: [{ garmentId: "shirt-gold" }] });
    expect((await listStudioDayPlans(h.rt, fresh.principal())).find((p) => p.planId === planned.result.planId)!.validation.valid).toBe(true);

    // "Wear this" is the foundation's wear.record: wearing today's plan records a wear and leaves that day's plan alone.
    const todayPlan = await fresh.exec("studio.plan_for_day", { localDate: TODAY, slots: [{ role: "top", garmentId: "shirt-slate" }, { role: "bottom", garmentId: "trouser-navy" }, { role: "footwear", garmentId: "shoe-990v6" }, { role: "socks", garmentId: "sock-grey" }] });
    expect((await all(h.db, "SELECT 1 FROM daily_wears WHERE user_id = ?", fresh.userId)).length).toBe(0);
    const wear = await fresh.exec("wear.record", { wearingDate: TODAY, garmentIds: ["shirt-slate", "trouser-navy", "shoe-990v6", "sock-grey"] });
    expect(wear.type).toBe("wear.record");
    expect((await all(h.db, "SELECT 1 FROM daily_wears WHERE user_id = ? AND status = 'active'", fresh.userId)).length).toBe(4);
    expect((await listStudioDayPlans(h.rt, fresh.principal())).find((p) => p.planId === todayPlan.result.planId)).toMatchObject({ needsRevalidation: false });
  });
});
