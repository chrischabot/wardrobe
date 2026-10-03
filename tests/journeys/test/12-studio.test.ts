/**
 * Journey 12: Studio.
 *
 * Specification: section 3 "Studio" (selectors, locked pieces, For today and Explore, Save combination /
 * Plan for a day / Wear this have distinct effects, authoritative checks come from the backend) and
 * "Laundry, wear follow-through, and undo" (a chosen outfit remains an intention; Undo); section 11
 * "Outfit composition without redrawing the clothes" (a garment without a photograph says so); section 13
 * (`garderobe_recommend`: validated options). Acceptance rows (section 17): Studio ("locked pieces remain
 * locked; chosen combinations persist with the correct IDs"), Hallucinated items (an unknown garment cannot
 * be composed). Profile section 8 (hard constraints: socks always; sneakers only while the toe heals).
 *
 * Everything inside the Worker is real: HTTP API, MCP server, the daily service's validator, local
 * D1/R2/KV, the owner's real profile and the real 127-garment inventory. Stand-ins, at external boundaries:
 *  - test-signed sign-in assertions in place of Cloudflare Access;
 *  - the scripted weather double (src/outbound.ts): mild days at a fictional test place.
 * No model takes part in this file. No image is uploaded: the real inventory has no photographs here, so
 * the journey checks that their absence is stated, not that rendering looks right. "Cached swipes respond
 * without inference" is a property of the phone and is not covered by a backend journey.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { connectMcp, provisionOwner, toolResult, type TestOwner } from "@garderobe/worker/testing";
import { exec, internalCodesIn, realOwnerAt, refused, runCron, wholeWardrobe, type JourneyOwner, type WardrobeItem } from "../src/world.ts";

interface Slot {
  role: string;
  garmentId: string;
  locked?: boolean;
}

let j: JourneyOwner;
let owner: TestOwner;
let stranger: TestOwner;
let wardrobe: Map<string, WardrobeItem>;
let studio: any;
let explore: any;
let outfit: Slot[];
let welted: { garmentId: string; name: string };
let saved: { combinationId: string; commandId: string; manifestHash: string };

const selector = (view: any, role: string) => view.selectors.find((s: any) => s.role === role) as { role: string; primary: boolean; items: any[] };
const recentCommandIds = async () => ((await owner.api.json("GET", "/v1/commands")).receipts as { commandId: string }[]).map((r) => r.commandId);
const revision = async () => (await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision as number;
const dayGarments = async (date: string) => ((await owner.api.json("GET", `/v1/days/${date}`)).garments as { garmentId: string }[]).map((g) => g.garmentId);
const combinations = async () => (await owner.api.json("GET", "/v1/studio")).combinations as any[];
const known = async (garmentId: string) => ((await owner.api.json("GET", `/v1/items/${garmentId}`)).knownCombinations as any[]).map((c) => c.combinationId);
const slotIds = (slots: { role: string; garmentId: string | null }[]) => slots.map((s) => `${s.role}:${s.garmentId}`).sort();
const blocking = (validation: any) => (validation.violations as any[]).filter((v) => v.severity === "blocking");
/** Identity of today's plan as the app shows it (board, revision, chosen option), or "none". */
const planMark = async () => {
  const today = await owner.api.json("GET", `/v1/today?date=${j.today}`);
  return today.board ? `${today.board.boardId}:${today.board.revision}:${today.board.selection?.optionId ?? "nothing chosen"}` : "none";
};

beforeAll(async () => {
  j = await realOwnerAt("Studio");
  owner = j.owner;
  stranger = await provisionOwner();
  wardrobe = new Map((await wholeWardrobe(owner.api)).items.map((i) => [i.garment.garmentId, i]));
});

describe("journey 12: composing, checking and saving outfits in Studio", () => {
  it("For today opens with selectors that hold only the owner's real, eligible garments", async () => {
    expect(wardrobe.size).toBe(127);
    studio = await owner.api.json("GET", "/v1/studio?mode=for_today");
    expect(studio.mode).toBe("for_today");
    expect(studio.forDate).toBe(j.today);
    // Top, bottom, footwear and outer layer are the selectors always shown; accessories expand on demand.
    expect(studio.selectors.filter((s: any) => s.primary).map((s: any) => s.role).sort()).toEqual(["bottom", "footwear", "outer", "top"]);
    for (const role of ["top", "bottom", "footwear", "outer", "socks"]) expect(selector(studio, role).items.length, role).toBeGreaterThan(0);

    for (const s of studio.selectors) {
      for (const item of s.items) {
        // Every entry is a garment from the ledger, under the name the owner knows, in a role it can fill.
        const real = wardrobe.get(item.garmentId);
        expect(real, `${s.role}: ${item.name}`).toBeTruthy();
        expect(item.name).toBe(real!.garment.name);
        expect(real!.garment.roles).toContain(s.role);
        expect(real!.garment.acquisition).toBe("owned");
        expect(item.shoppingCandidate).toBeNull();
        expect(item.marker).toBe("owned");
        // For today offers eligible pieces only.
        expect(item.eligibleToday, item.name).toBe(true);
        expect(real!.availability!.hardExcluded, item.name).toBe(false);
      }
    }
    // Sneakers only while the restriction is active: every shoe offered for today is one the ledger allows.
    const shoes = selector(studio, "footwear").items;
    expect(shoes.length).toBeGreaterThan(0);
    for (const shoe of shoes) expect(wardrobe.get(shoe.garmentId)!.availability!.restrictionIds).toEqual([]);

    // The opening outfit on the canvas is itself a valid outfit of real garments.
    expect(studio.opening.length).toBeGreaterThanOrEqual(4);
    for (const slot of studio.opening) expect(wardrobe.has(slot.garmentId)).toBe(true);
    const opening = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: studio.opening });
    expect(opening.valid).toBe(true);
  });

  it("a garment without a photograph says 'No photo yet'; no picture is invented for it", async () => {
    for (const s of studio.selectors) {
      for (const item of s.items) {
        expect(item.image.garmentId).toBe(item.garmentId);
        if (item.image.hasRealImage) {
          expect(item.image.renditionId).toBeTruthy();
          expect(item.image.missingImageNote).toBeNull();
        } else {
          expect(item.image).toMatchObject({ assetId: null, renditionId: null, renditionSha256: null, isDemo: false, missingImageNote: "No photo yet" });
        }
      }
    }
    // The real inventory was imported without photographs, and the item page says so too.
    const shoe = selector(studio, "footwear").items[0];
    expect(shoe.image.hasRealImage).toBe(false);
    const item = await owner.api.json("GET", `/v1/items/${shoe.garmentId}`);
    expect(item.media.image).toMatchObject({ hasRealImage: false, missingImageNote: "No photo yet" });
    expect(item.media.assets).toEqual([]);
    const image = await refused(await owner.api.get(`/v1/items/${shoe.garmentId}/image`));
    expect(image.status).toBe(404);
    expect(image.error.message).toBe("No photo yet");
  });

  it("Explore shows more of the wardrobe, with pieces that cannot be worn today marked and never offered as eligible", async () => {
    explore = await owner.api.json("GET", "/v1/studio?mode=explore");
    expect(explore.mode).toBe("explore");
    const count = (view: any) => view.selectors.reduce((n: number, s: any) => n + s.items.length, 0);
    expect(count(explore)).toBeGreaterThan(count(studio));
    // Everything For today offers is in Explore as well, still eligible.
    for (const s of studio.selectors) {
      const there = new Map(selector(explore, s.role).items.map((i: any) => [i.garmentId, i]));
      for (const item of s.items) expect((there.get(item.garmentId) as any)?.eligibleToday, item.name).toBe(true);
    }
    // What Explore adds is real, marked as not for today, and says why.
    const added = explore.selectors.flatMap((s: any) => s.items.filter((i: any) => !i.eligibleToday));
    expect(added.length).toBeGreaterThan(0);
    for (const item of added) {
      expect(wardrobe.get(item.garmentId)?.garment.name, item.name).toBe(item.name);
      expect(item.marker).not.toBe("owned");
      expect(item.availabilityStatus).not.toBe("available");
      expect(item.reasons.length, item.name).toBeGreaterThan(0);
    }

    // The welted shoes are in Explore, marked unavailable because of the restriction; they are not in For today.
    const restrictedShoes = selector(explore, "footwear").items.filter((i: any) => !i.eligibleToday);
    expect(restrictedShoes.length).toBeGreaterThan(0);
    const offeredToday = new Set(selector(studio, "footwear").items.map((i: any) => i.garmentId));
    for (const shoe of restrictedShoes) {
      expect(shoe.availabilityStatus).toBe("unavailable");
      expect(shoe.reasons).toContain("restricted");
      expect(wardrobe.get(shoe.garmentId)!.availability!.restrictionIds.length).toBeGreaterThan(0);
      expect(offeredToday.has(shoe.garmentId)).toBe(false);
    }
    welted = { garmentId: restrictedShoes[0].garmentId, name: restrictedShoes[0].name };
  });

  it("the backend validates the finished combination: a complete outfit passes, one without socks does not", async () => {
    const pick = (role: string) => selector(studio, role).items[0].garmentId as string;
    outfit = ["top", "bottom", "socks", "footwear"].map((role) => ({ role, garmentId: pick(role) }));
    const ok = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: outfit });
    expect(ok).toMatchObject({ valid: true, wearableOn: j.today, validator: "daily-service" });
    expect(blocking(ok)).toEqual([]);

    const sockless = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: outfit.filter((s) => s.role !== "socks") });
    expect(sockless.valid).toBe(false);
    expect(sockless.validator).toBe("daily-service");
    const reasons = blocking(sockless).map((v) => v.message as string);
    expect(reasons.some((m) => /socks/i.test(m))).toBe(true);
    for (const message of reasons) expect(internalCodesIn(message)).toEqual([]);

    // A garment that does not exist cannot be composed at all.
    const invented = await refused(await owner.api.post("/v1/studio/validate", { mode: "for_today", slots: [...outfit.slice(0, 3), { role: "footwear", garmentId: "gmt_ffffffffffffffffffffffff" }] }));
    expect(invented.status).toBe(404);
    // Another owner cannot validate with this owner's garments.
    expect((await stranger.api.post("/v1/studio/validate", { mode: "for_today", slots: outfit })).status).toBe(404);
  });

  it("a combination with a welted shoe is refused for today with a plain reason, and only flagged in Explore", async () => {
    const withWelted = outfit.map((s) => (s.role === "footwear" ? { role: "footwear", garmentId: welted.garmentId } : s));
    const today = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: withWelted });
    expect(today.valid).toBe(false);
    const reasons = blocking(today);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason.garmentIds).toEqual([welted.garmentId]);
      expect(reason.message).toContain(welted.name);
      expect(internalCodesIn(reason.message)).toEqual([]);
    }
    expect(reasons.some((r) => /sneakers-only restriction/i.test(r.message))).toBe(true);

    // In Explore the same combination may be looked at, but it is not called wearable on any day and still says why.
    const exploring = await owner.api.json("POST", "/v1/studio/validate", { mode: "explore", slots: withWelted });
    expect(exploring.wearableOn).toBeNull();
    expect(exploring.violations.some((v: any) => v.garmentIds.includes(welted.garmentId) && /restriction/i.test(v.message))).toBe(true);

    // "Find something that works with this" around the welted shoe finds nothing for today, instead of bending the rule.
    const around = await owner.api.json("POST", "/v1/studio/suggest", { mode: "for_today", slots: [{ role: "footwear", garmentId: welted.garmentId, locked: true }], limit: 3 });
    expect(around.suggestions).toEqual([]);
    // Neither saving it for today nor planning it for tomorrow is accepted, and both say why.
    const save = await refused(await owner.api.command("studio.save_combination", { name: "Welted today", mode: "for_today", slots: withWelted }));
    expect(save.status).toBe(409);
    expect(save.error.message).toContain(welted.name);
    expect(save.error.message).toMatch(/nothing was written/i);
    expect(internalCodesIn(save.error.message)).toEqual([]);
    const plan = await refused(await owner.api.command("studio.plan_for_day", { localDate: j.day(1), slots: withWelted }));
    expect(plan.status).toBe(409);
    expect(plan.error.message).toContain(welted.name);
    const view = await owner.api.json("GET", "/v1/studio");
    expect(view.combinations).toEqual([]);
    expect(view.dayPlans).toEqual([]);
  });

  it("locked pieces stay locked in every suggestion, and every suggestion is a valid outfit for today", async () => {
    const top = outfit.find((s) => s.role === "top")!;
    const bottom = outfit.find((s) => s.role === "bottom")!;
    const { suggestions } = await owner.api.json("POST", "/v1/studio/suggest", { mode: "for_today", slots: [{ ...top, locked: true }, { ...bottom, locked: true }, outfit.find((s) => s.role === "socks")!, outfit.find((s) => s.role === "footwear")!], limit: 4 });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(4);
    const eligibleShoes = new Set(selector(studio, "footwear").items.map((i: any) => i.garmentId));
    for (const suggestion of suggestions) {
      const byRole = new Map<string, any>(suggestion.slots.map((s: any) => [s.role, s]));
      expect(byRole.get("top")).toMatchObject({ garmentId: top.garmentId, locked: true });
      expect(byRole.get("bottom")).toMatchObject({ garmentId: bottom.garmentId, locked: true });
      // The unlocked slots are filled with real, eligible pieces: socks always, an allowed shoe.
      expect(wardrobe.has(byRole.get("socks").garmentId)).toBe(true);
      expect(eligibleShoes.has(byRole.get("footwear").garmentId)).toBe(true);
      for (const slot of suggestion.slots) expect(wardrobe.has(slot.garmentId)).toBe(true);
      expect(suggestion.validation).toMatchObject({ valid: true, wearableOn: j.today, validator: "daily-service" });
      // The reason is a sentence about the clothes, by the names the owner knows.
      expect(suggestion.reason).toContain(wardrobe.get(top.garmentId)!.garment.name);
      expect(internalCodesIn(suggestion.reason)).toEqual([]);
    }
    // The suggestions differ from one another in what was left unlocked.
    expect(new Set(suggestions.map((s: any) => slotIds(s.slots).join("|"))).size).toBe(suggestions.length);

    // Locking only the shoe changes everything else around it and leaves the shoe alone.
    const shoe = outfit.find((s) => s.role === "footwear")!;
    const aroundShoe = await owner.api.json("POST", "/v1/studio/suggest", { mode: "for_today", slots: [{ ...shoe, locked: true }], limit: 3 });
    expect(aroundShoe.suggestions.length).toBeGreaterThan(0);
    for (const suggestion of aroundShoe.suggestions) expect(suggestion.slots.find((s: any) => s.role === "footwear")).toMatchObject({ garmentId: shoe.garmentId, locked: true });
  });

  it("composing the same outfit always gives the same manifest; a different outfit gives a different one", async () => {
    const first = await owner.api.json("POST", "/v1/studio/compose", { slots: outfit });
    const again = await owner.api.json("POST", "/v1/studio/compose", { slots: [...outfit].reverse() });
    expect(first.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(again.manifestHash).toBe(first.manifestHash);
    expect(again.manifest).toEqual(first.manifest);
    // The canvas is white and holds exactly the chosen garments, by their ledger names.
    expect(first.manifest.canvas.background.toUpperCase()).toBe("#FFFFFF");
    expect(slotIds(first.manifest.layers)).toEqual(slotIds(outfit));
    for (const layer of first.manifest.layers) expect(layer.name).toBe(wardrobe.get(layer.garmentId)!.garment.name);
    // No photograph exists for these pieces: each is a labelled text tile, not an invented picture.
    for (const layer of first.manifest.layers) expect(layer).toMatchObject({ imageLabel: "missing", assetId: null, renditionId: null });
    expect([...first.missingImages].sort()).toEqual(outfit.map((s) => s.garmentId).sort());
    expect(first.labels).toContain("No photo yet");
    expect(first.manifest.caption).toMatch(/no photo yet/i);
    expect(internalCodesIn(first.manifest.caption)).toEqual([]);
    expect(first.preview.state).toBe("none");

    const otherShoe = selector(studio, "footwear").items[1].garmentId as string;
    const different = await owner.api.json("POST", "/v1/studio/compose", { slots: outfit.map((s) => (s.role === "footwear" ? { ...s, garmentId: otherShoe } : s)) });
    expect(different.manifestHash).not.toBe(first.manifestHash);
  });

  it("browsing, validating, asking for suggestions and composing changed nothing", async () => {
    const before = { revision: await revision(), commands: await recentCommandIds(), day: await dayGarments(j.today), plan: await planMark() };
    await owner.api.json("GET", "/v1/studio?mode=for_today");
    await owner.api.json("GET", "/v1/studio?mode=explore");
    await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: outfit });
    await owner.api.json("POST", "/v1/studio/suggest", { mode: "for_today", slots: [{ ...outfit[0]!, locked: true }], limit: 2 });
    await owner.api.json("POST", "/v1/studio/compose", { slots: outfit });
    expect(await revision()).toBe(before.revision);
    expect(await recentCommandIds()).toEqual(before.commands);
    expect(await dayGarments(j.today)).toEqual(before.day);
    expect(before.day).toEqual([]);
    expect(await planMark()).toBe(before.plan); // no plan was made or changed
    expect(before.plan).toBe("none");
    expect(await combinations()).toEqual([]);
    // Availability of the pieces that were looked at is what it was.
    const now = new Map((await wholeWardrobe(owner.api)).items.map((i) => [i.garment.garmentId, i]));
    for (const slot of outfit) expect(now.get(slot.garmentId)!.availability).toEqual(wardrobe.get(slot.garmentId)!.availability);
  });

  it("a rendered preview is asked for as a job and is never shown as ready before it is rendered", async () => {
    const composed = await owner.api.json("POST", "/v1/studio/compose", { slots: outfit });
    const asked = await owner.api.json("POST", "/v1/studio/previews", { clientRequestId: `preview-${crypto.randomUUID()}`, slots: outfit });
    expect(asked.manifestHash).toBe(composed.manifestHash);
    expect(asked.receipt).toMatchObject({ type: "media.request_composite_preview", outcome: "committed" });
    // The receipt says it is queued, not that it is ready.
    expect(asked.receipt.summary).toMatch(/queued|background/i);
    expect(asked.receipt.summary).not.toMatch(/\b(ready|done|rendered)\b/i);
    expect(internalCodesIn(asked.receipt.summary)).toEqual([]);
    expect(asked.receipt.result.previewState).toBe("queued");

    const queued = await owner.api.json("GET", `/v1/studio/compositions/${asked.manifestHash}`);
    expect(queued.preview).toMatchObject({ state: "queued", sha256: null, renderedAt: null });
    expect((await owner.api.get(`/v1/studio/compositions/${asked.manifestHash}/preview`)).status).toBe(404);

    // After the scheduled work has had a turn, the state is whatever really happened; an image is served only when rendered.
    await runCron();
    const later = await owner.api.json("GET", `/v1/studio/compositions/${asked.manifestHash}`);
    expect(["queued", "rendered", "failed"]).toContain(later.preview.state);
    const image = await owner.api.get(`/v1/studio/compositions/${asked.manifestHash}/preview`);
    if (later.preview.state === "rendered") {
      expect(image.status).toBe(200);
      expect(image.headers.get("Content-Type")).toBe("image/png");
      expect(later.preview.sha256).toMatch(/^[0-9a-f]{64}$/);
    } else {
      expect(image.status).toBe(404);
      expect(later.preview.sha256).toBeNull();
    }
    if (later.preview.state === "failed") expect(later.preview.failure).toBeTruthy();
    // Another owner can read neither the composition nor its preview.
    expect((await stranger.api.get(`/v1/studio/compositions/${asked.manifestHash}`)).status).toBe(404);
    expect((await stranger.api.get(`/v1/studio/compositions/${asked.manifestHash}/preview`)).status).toBe(404);
    // Asking for a preview is not a wear and not a saved combination.
    expect(await dayGarments(j.today)).toEqual([]);
    expect(await combinations()).toEqual([]);
  });

  it("Save combination is an explicit command: it persists with the right garments and is not a wear", async () => {
    // The backend, not the phone, decides: a sockless combination is refused and nothing is saved.
    const sockless = await refused(await owner.api.command("studio.save_combination", { name: "No socks", mode: "for_today", slots: outfit.filter((s) => s.role !== "socks") }));
    expect(sockless.status).toBe(409);
    expect(sockless.error.message).toMatch(/socks/i);
    expect(sockless.error.message).toMatch(/nothing was written/i);
    expect(await combinations()).toEqual([]);

    const wearsBefore = (await owner.api.json("GET", `/v1/items/${outfit[0]!.garmentId}`)).detail.recordedWearCount;
    const planBefore = await planMark(); // the scheduled service may have prepared today's board by now
    const receipt = await exec(owner.api, "studio.save_combination", { name: "Office default", mode: "for_today", slots: outfit });
    expect(receipt).toMatchObject({ type: "studio.save_combination", outcome: "committed", undo: { available: true } });
    for (const slot of outfit) expect(receipt.summary).toContain(wardrobe.get(slot.garmentId)!.garment.name);
    expect(internalCodesIn(receipt.summary)).toEqual([]);
    expect([...receipt.result.garmentIds].sort()).toEqual(outfit.map((s) => s.garmentId).sort());
    saved = { combinationId: receipt.result.combinationId, commandId: receipt.commandId, manifestHash: receipt.result.manifestHash };

    // Read back: listed in Studio with exactly these garments in these roles, and on each garment's own page.
    const listed = (await combinations()).find((c) => c.combinationId === saved.combinationId);
    expect(listed).toMatchObject({ name: "Office default", status: "active", containsShoppingCandidate: false, validation: { valid: true } });
    expect(slotIds(listed.slots)).toEqual(slotIds(outfit));
    expect(listed.manifestHash).toBe((await owner.api.json("POST", "/v1/studio/compose", { slots: outfit })).manifestHash);
    for (const slot of outfit) expect(await known(slot.garmentId), slot.role).toContain(saved.combinationId);
    // A garment that is not part of it does not list it.
    expect(await known(selector(studio, "top").items[1].garmentId)).not.toContain(saved.combinationId);

    // Saving is not wearing and not planning.
    expect(await dayGarments(j.today)).toEqual([]);
    expect((await owner.api.json("GET", `/v1/items/${outfit[0]!.garmentId}`)).detail.recordedWearCount).toBe(wearsBefore);
    expect((await owner.api.json("GET", "/v1/studio")).dayPlans).toEqual([]);
    expect(await planMark()).toBe(planBefore);
  });

  it("Plan for a day records an intention for that date, not a wear, and can be removed", async () => {
    const tomorrow = j.day(1);
    const receipt = await exec(owner.api, "studio.plan_for_day", { localDate: tomorrow, combinationId: saved.combinationId });
    expect(receipt).toMatchObject({ type: "studio.plan_for_day", outcome: "committed", undo: { available: true } });
    // The receipt itself says this is an intention.
    expect(receipt.summary).toMatch(/not a recorded wear|intention/i);
    for (const slot of outfit) expect(receipt.summary).toContain(wardrobe.get(slot.garmentId)!.garment.name);

    const plans = (await owner.api.json("GET", "/v1/studio")).dayPlans as any[];
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ planId: receipt.result.planId, localDate: tomorrow, combinationId: saved.combinationId, status: "planned", needsRevalidation: false, validation: { valid: true, wearableOn: tomorrow } });
    expect(slotIds(plans[0].slots)).toEqual(slotIds(outfit));
    // Neither today nor the planned day has a recorded wear, and the pieces were not taken out of availability.
    expect(await dayGarments(j.today)).toEqual([]);
    expect(await dayGarments(tomorrow)).toEqual([]);
    const now = new Map((await wholeWardrobe(owner.api)).items.map((i) => [i.garment.garmentId, i]));
    for (const slot of outfit) expect(now.get(slot.garmentId)!.availability!.hardExcluded).toBe(false);

    const removed = await exec(owner.api, "studio.remove_day_plan", { planId: receipt.result.planId });
    expect(removed.outcome).toBe("committed");
    expect(((await owner.api.json("GET", "/v1/studio")).dayPlans as any[]).filter((p) => p.status === "planned")).toEqual([]);
    // The saved combination is untouched by planning and unplanning.
    expect((await combinations()).map((c) => c.combinationId)).toEqual([saved.combinationId]);
  });

  it("Wear this is the third, distinct effect: only an explicit wear puts the pieces on the day's record", async () => {
    const receipt = await exec(owner.api, "wear.record", { wearingDate: j.today, garmentIds: outfit.map((s) => s.garmentId) });
    expect(receipt.outcome).toBe("committed");
    expect((await dayGarments(j.today)).sort()).toEqual(outfit.map((s) => s.garmentId).sort());
    // The saved combination is still one combination; wearing it did not save or plan anything more.
    expect((await combinations()).map((c) => c.combinationId)).toEqual([saved.combinationId]);
    // Undo takes the wear back and leaves the combination.
    await exec(owner.api, "command.undo", { commandId: receipt.commandId, reason: null });
    expect(await dayGarments(j.today)).toEqual([]);
    expect((await combinations()).map((c) => c.combinationId)).toEqual([saved.combinationId]);
  });

  it("a saved combination can be taken back with Undo, or removed, and then leaves the garments' pages", async () => {
    const undone = await exec(owner.api, "command.undo", { commandId: saved.commandId, reason: null });
    expect(undone.outcome).toBe("committed");
    expect(internalCodesIn(undone.summary)).toEqual([]);
    expect((await combinations()).filter((c) => c.status === "active")).toEqual([]);
    for (const slot of outfit) expect(await known(slot.garmentId)).not.toContain(saved.combinationId);

    // Saved again under another name, then removed with its own command.
    const second = await exec(owner.api, "studio.save_combination", { name: "Friday", mode: "for_today", slots: outfit });
    expect((await combinations()).filter((c) => c.status === "active").map((c) => c.name)).toEqual(["Friday"]);
    const removed = await exec(owner.api, "studio.remove_combination", { combinationId: second.result.combinationId });
    expect(removed.outcome).toBe("committed");
    expect(internalCodesIn(removed.summary)).toEqual([]);
    expect((await combinations()).filter((c) => c.status === "active")).toEqual([]);
    expect(await known(outfit[0]!.garmentId)).not.toContain(second.result.combinationId);
    // The garments themselves are untouched: all 127 are still there.
    expect((await wholeWardrobe(owner.api)).total).toBe(127);
  });

  it("another owner sees none of it: no garments, combinations or plans of this wardrobe", async () => {
    await exec(owner.api, "studio.save_combination", { name: "Kept", mode: "for_today", slots: outfit });
    const other = await stranger.api.json("GET", "/v1/studio?mode=explore");
    expect(other.combinations).toEqual([]);
    expect(other.dayPlans).toEqual([]);
    expect(other.selectors.flatMap((s: any) => s.items)).toEqual([]);
    expect(other.opening).toEqual([]);
    // Nor can they save or plan with this owner's garments.
    expect((await stranger.api.command("studio.save_combination", { name: "Borrowed", mode: "explore", slots: outfit })).status).toBe(404);
    expect((await stranger.api.json("GET", "/v1/studio")).combinations).toEqual([]);
  });

  it("a connected assistant reaches the same validator through garderobe_recommend: validated options only, nothing published", async () => {
    const mcp = await connectMcp(owner, { write: false, clientName: "Studio reader (test)" });
    const before = { revision: await revision(), commands: await recentCommandIds(), plan: await planMark() };
    const recommended = toolResult(await mcp.client.callTool({ name: "garderobe_recommend", arguments: { date: j.today, count: 3, clientRequestId: `rec-${crypto.randomUUID()}` } }));
    expect(recommended.ok, JSON.stringify(recommended.error)).toBe(true);
    expect(recommended.data.state).toBe("completed");
    expect(recommended.data.board).toBeNull();
    expect(recommended.data.options.length).toBeGreaterThan(0);
    expect(recommended.data.options.length).toBeLessThanOrEqual(3);
    const offeredToday = new Set(selector(studio, "footwear").items.map((i: any) => i.garmentId));
    for (const option of recommended.data.options) {
      // Every garment is real and named from the ledger; the option passes Studio's own validation for today.
      for (const line of option.garments) expect(wardrobe.get(line.garmentId)?.garment.name, line.name).toBe(line.name);
      const roles = option.garments.map((g: any) => g.role);
      expect(roles).toContain("socks");
      for (const shoe of option.garments.filter((g: any) => g.role === "footwear")) expect(offeredToday.has(shoe.garmentId), shoe.name).toBe(true);
      const verdict = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots: option.garments.map((g: any) => ({ role: g.role, garmentId: g.garmentId })) });
      // Every rule must agree with the recommendation.
      expect(blocking(verdict), option.name).toEqual([]);
      expect(internalCodesIn(option.reason)).toEqual([]);
    }
    // Asking published nothing and changed nothing: today's plan is the one the app already had.
    expect(await planMark()).toBe(before.plan);
    expect(await revision()).toBe(before.revision);
    expect(await recentCommandIds()).toEqual(before.commands);
    await mcp.close();
  });

  // Was defect D12-1 (Studio said "the forecast is unavailable" for a day nobody had asked a board for);
  // fixed by the visual wardrobe thread in e94af8fb. Kept as two steps: the first proves the situation
  // (the garments exist, the request is accepted, the forecast for that day is fresh), the second holds
  // the assertion that used to fail.
  let laterDayVerdict: any;

  it("for a later day the forecast can be fetched and is fresh, and Studio answers a check of a jacket over an oxford", async () => {
    const idByName = (name: string) => {
      const found = [...wardrobe.values()].find((w) => w.garment.name === name);
      expect(found, name).toBeTruthy();
      return found!.garment.garmentId as string;
    };
    const slots = [
      { role: "outer", garmentId: idByName("Drake's Olive Jungle Jacket") },
      { role: "top", garmentId: idByName("Pima oxford — navy") },
      { role: "bottom", garmentId: idByName("Stratton stretch corduroy") },
      { role: "socks", garmentId: idByName("Merino — deep earth brown") },
      { role: "footwear", garmentId: idByName("NB 990v4 — olive/cream") },
    ];
    // The order matters: Studio is asked first, while nothing has asked for that day's forecast yet.
    // Reading the forecast afterwards shows it could be fetched (a read before would record it and hide the defect).
    laterDayVerdict = await owner.api.json("POST", "/v1/studio/validate", { mode: "explore", date: j.day(7), slots });
    expect(Array.isArray(laterDayVerdict.violations)).toBe(true);
    expect(laterDayVerdict.validator).toBe("daily-service");
    const weather = await owner.api.json("GET", `/v1/weather?date=${j.day(7)}`);
    expect(weather.freshness).toBe("fresh");
  });

  it("Studio checks an outfit against the day's forecast instead of saying the forecast is unavailable", () => {
    // Specification section 7: the forecast is mandatory context for validating an outfit for a date and
    // is fetched by the backend; section 3 (Studio): a combination is validated by the backend for the
    // day it is planned for. That day starts at 11 C and reaches 19 C, where the 14-16 C jacket rule
    // does not apply, so a jacket over an oxford is not blocked for want of a forecast.
    expect(laterDayVerdict).toBeTruthy();
    expect((laterDayVerdict.violations as any[]).map((v) => v.message).filter((m) => /forecast is unavailable/.test(m))).toEqual([]);
  });
});
