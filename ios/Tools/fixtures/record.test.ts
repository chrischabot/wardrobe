/**
 * Records the fixture cassettes the Swift journey tests and the app's labelled demo mode replay.
 *
 *   bash ios/Tools/fixtures/record.sh        (from wardrobe/)
 *
 * Each journey provisions a fresh owner with the REAL import (the supplied profile and inventory CSV
 * through the ordinary command service) and then talks to the REAL Worker over HTTP exactly as the
 * iOS client does. What is not real is stated in each cassette's `provenance.notes`:
 *   - the weather provider and Calendar are not reachable from a local run, so the board is published
 *     with that limitation stated (the Worker's real behaviour when they are unavailable);
 *   - the assistant's wording comes from the assistant workstream's labelled FAKE MODEL.
 * The Swift tests must send the same state-changing requests in the same order; `FixtureBackend`
 * compares them field by field (apart from client-generated IDs and timestamps).
 */
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "@garderobe/contracts";
import { ownerDocuments } from "@garderobe/domain/testing";
import { connectMcp, enableFakeModel, newIdentity, provisionOwner, publishBoard as publishBoardFor, testPng, toolResult, ApiClient, type TestOwner } from "@garderobe/worker/testing";
import { FAKE_MODEL_LABEL } from "@garderobe/assistant/testing";
import { Recorder, type Provenance } from "./recorder.ts";

const OUT = "../../GarderobeKit/Sources/GarderobeKit/Resources/Fixtures";

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function provenance(notes: string[]): Promise<Provenance> {
  const docs = ownerDocuments();
  return {
    profileSha256: await sha256(docs.profileText),
    inventorySha256: await sha256(docs.inventoryCsv),
    contractVersion: CONTRACT_VERSION,
    generator: "ios/Tools/fixtures/record.test.ts",
    backend: "worker (real Worker in workerd on local D1; real owner import)",
    notes,
  };
}

const LIMITED_SOURCES = "Weather provider and Google Calendar are not reachable from a local run: the board is published with that limitation stated, as the Worker does when they are unavailable.";

async function start(name: string, notes: string[]): Promise<{ owner: TestOwner; rec: Recorder; today: string }> {
  const owner = await provisionOwner({ real: true });
  const rec = new Recorder(name, owner.api, await provenance(notes), "Europe/London");
  const settings = await owner.api.json("GET", "/v1/settings");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.settings.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(rec.startedAt);
  return { owner, rec, today };
}

async function publishBoard(owner: TestOwner, date: string): Promise<void> {
  const response = await publishBoardFor(owner, { date });
  if (response.state !== "completed" || !response.board) throw new Error(`board was not published: ${JSON.stringify(response).slice(0, 400)}`);
}

/** The reads the app makes when it launches and its four destinations open. */
async function launchReads(rec: Recorder): Promise<{ today: any; wardrobe: any }> {
  await rec.get("/v1/me");
  await rec.get("/v1/settings");
  const today = await rec.get("/v1/today");
  const wardrobe = await rec.get("/v1/wardrobe");
  await rec.get("/v1/style");
  await rec.get("/v1/laundry");
  await rec.get("/v1/trips");
  await rec.get("/v1/returns");
  await rec.get("/v1/connections");
  await rec.get("/v1/assistants");
  await rec.get("/v1/media/review");
  await rec.get("/v1/media/photos-needed");
  await rec.get("/v1/recovery");
  await rec.get("/v1/weather");
  await rec.get("/v1/conversation/messages", { limit: 40 });
  await rec.get("/v1/studio", { mode: "for_today" });
  return { today, wardrobe };
}

async function itemReads(rec: Recorder, garmentId: string): Promise<any> {
  const item = await rec.get(`/v1/items/${garmentId}`);
  await rec.get("/v1/feedback", { garmentId });
  await rec.get("/v1/commands", { entity: `garment:${garmentId}`, limit: 50 });
  return item;
}

const ref = (optionId: string) => ({ attachedRefs: [`board_option:${optionId}`] });

describe("iOS fixture cassettes", () => {
  it("owner-morning: Today from the real import; choose, wear the chosen outfit, undo, brief, swap", async () => {
    const { owner, rec, today } = await start("owner-morning", [LIMITED_SOURCES, "This cassette is also the app's labelled demo data."]);
    await publishBoard(owner, today);
    const launched = await launchReads(rec);
    const board = launched.today.board;
    expect(board.options.length).toBeGreaterThanOrEqual(2);
    // Every garment's item page, so the demo can browse the whole wardrobe.
    for (const item of launched.wardrobe.items) await itemReads(rec, item.garment.garmentId);

    const second = board.options[1];
    await rec.command("choose", "board.select", { boardId: board.boardId, optionId: second.optionId }, { [`board:${board.boardId}`]: board.revision }, ref(second.optionId));
    await rec.get("/v1/today");

    const wear = await rec.command("wore", "wear.record", { wearingDate: launched.today.localDate, garmentIds: second.garments.map((g: any) => g.garmentId), timezone: launched.today.timezone }, {}, ref(second.optionId));
    expect(wear.outcome).toBe("committed");
    const worn = await rec.get("/v1/today");
    expect(worn.dayRecord.length).toBeGreaterThan(0);
    await rec.get("/v1/wardrobe");
    await rec.get("/v1/laundry");
    await itemReads(rec, second.garments[0].garmentId);

    const undone = await rec.command("undo-wear", "command.undo", { commandId: wear.commandId });
    expect(undone.outcome).toBe("committed");
    const after = await rec.get("/v1/today");
    await rec.get("/v1/wardrobe");
    await rec.get("/v1/laundry");
    await itemReads(rec, second.garments[0].garmentId);

    const briefSet = await rec.command("brief", "style.set_brief", { localDate: after.localDate, text: "Something a little sharper today", source: { kind: "owner_statement" } });
    const briefed = await rec.get("/v1/today");
    await rec.get("/v1/style");

    const current = briefed.board ?? after.board;
    const first = current.options[0];
    await rec.change("swap-top", "POST", `/v1/boards/${current.boardId}/swap`, { clientRequestId: `fixture-${crypto.randomUUID()}`, optionId: first.optionId, role: "top", expectedRevision: current.revision });
    await rec.get("/v1/today");

    // An explicit request for another outfit (a preview beside the board), then clearing the day's brief.
    const another = await rec.post("/v1/recommendations", { clientRequestId: `fixture-${crypto.randomUUID()}`, date: after.localDate, brief: "Dinner out", mode: "preview" });
    expect(another.state).toBe("completed");
    expect(another.options.length).toBeGreaterThan(0);
    // GET /v1/style lists the day's briefs with their IDs; the app clears the active one.
    const styleNow = await rec.get("/v1/style");
    const activeBrief = styleNow.briefs.find((b: any) => b.localDate === after.localDate && b.status === "active");
    expect(activeBrief?.briefId).toBe(briefSet.result.briefId);
    const cleared = await rec.command("clear-brief", "style.retire_brief", { briefId: briefSet.result.briefId });
    expect(cleared.outcome).toBe("committed");
    await rec.get("/v1/today");
    await rec.get("/v1/style");

    await expect(rec.render()).toMatchFileSnapshot(`${OUT}/owner-morning.json`);
  });

  it("owner-care: item commands, laundry collect and return with an exception, socks, reconcile, storage, feedback, a return", async () => {
    const { rec } = await start("owner-care", []);
    const wardrobe = await rec.get("/v1/wardrobe");
    await rec.get("/v1/laundry");
    await rec.get("/v1/returns");
    const items: any[] = wardrobe.items;
    // The same selection rules as OwnerCareJourney.swift: first matches in the wardrobe's own order.
    const shirts = items.filter((i) => i.garment.category === "shirt" && i.garment.careChannel === "service" && i.availability?.hardExcluded === false).slice(0, 2);
    const socks = items.find((i) => i.garment.category === "socks" && i.garment.careChannel === "handwash" && i.totalOwnedUnits >= 3);
    const coat = items.find((i) => i.garment.category === "outerwear" && i.availability?.hardExcluded === false);
    const shoes = items.find((i) => i.garment.category === "footwear" && i.availability?.hardExcluded === false);
    expect(shirts.length).toBe(2);
    expect(socks && coat && shoes).toBeTruthy();
    const [shirtA, shirtB] = shirts.map((s) => s.garment.garmentId as string);
    const sockId: string = socks.garment.garmentId;
    const coatId: string = coat.garment.garmentId;
    const shoeId: string = shoes.garment.garmentId;
    for (const id of [shirtA!, shirtB!, sockId, coatId, shoeId]) await itemReads(rec, id);
    // Search by an alias the owner uses, answered by the backend.
    const alias: string = shirts[0].aliases[0] ?? shirts[0].garment.name;
    await rec.get("/v1/wardrobe", { search: alias });

    const after = async (id: string) => {
      await itemReads(rec, id);
      await rec.get("/v1/wardrobe");
      await rec.get("/v1/laundry");
    };

    await rec.command("wash-a", "care.mark_dirty", { items: [{ garmentId: shirtA }] });
    await after(shirtA!);
    await rec.command("wash-b", "care.mark_dirty", { items: [{ garmentId: shirtB }] });
    await after(shirtB!);

    await rec.command("collected", "laundry.collect", {});
    const collected = await rec.get("/v1/laundry");
    await rec.get("/v1/wardrobe");
    const batch = collected.batches.find((b: any) => b.returnedAt === null);
    expect(batch.items.map((i: any) => i.garmentId).sort()).toEqual([shirtA, shirtB].sort());

    await rec.command("returned", "laundry.return", { batchId: batch.batchId, stillAway: [{ garmentId: shirtB, quantity: 1 }] });
    await rec.get("/v1/laundry");
    await rec.get("/v1/wardrobe");
    await itemReads(rec, shirtA!);
    await itemReads(rec, shirtB!);

    await rec.command("socks-dirty", "care.mark_dirty", { items: [{ garmentId: sockId, quantity: 2 }] });
    await after(sockId);
    await rec.command("socks-washed", "care.washed", { allOfChannel: "handwash" });
    const washed = await itemReads(rec, sockId);
    const cleanNow = await rec.get("/v1/wardrobe");
    await rec.get("/v1/laundry");

    const sockItem = cleanNow.items.find((i: any) => i.garment.garmentId === sockId);
    const clean = sockItem.balances.filter((b: any) => b.bucket === "clean").reduce((n: number, b: any) => n + b.quantity, 0);
    expect(washed.detail.totalOwnedUnits).toBeGreaterThanOrEqual(3);
    await rec.command("reconcile", "stock.reconcile", { garmentId: sockId, counts: { clean: clean - 1 } });
    await after(sockId);

    await rec.command("to-storage", "garment.move", { garmentId: coatId, to: "storage" });
    await after(coatId);
    await rec.command("from-storage", "garment.move", { garmentId: coatId, to: "clean", from: "storage" });
    await after(coatId);

    await rec.command("feedback", "feedback.record", { text: "These rub after an hour", kind: "pain", garmentIds: [shoeId] });
    await after(shoeId);

    await rec.command("open-return", "return.open_case", { kind: "return", garmentId: shoeId, timezone: "Europe/London" });
    await rec.get("/v1/returns");

    await expect(rec.render()).toMatchFileSnapshot(`${OUT}/owner-care.json`);
  });

  it("owner-studio: validate, suggest with a locked piece, compose, save, plan, wear; a trip; pause and resume; settings and style; a profile save with its fact diff; a bulk edit", async () => {
    const { owner, rec, today } = await start("owner-studio", [LIMITED_SOURCES]);
    await publishBoard(owner, today);
    const studio = await rec.get("/v1/studio", { mode: "for_today" });
    const settings = await rec.get("/v1/settings");
    await rec.get("/v1/style");
    await rec.get("/v1/trips");
    await rec.get("/v1/today");

    // The order StudioModel sends slots in.
    const ROLE_ORDER = ["outer", "mid_layer", "top", "one_piece", "bottom", "belt", "socks", "footwear", "neckwear", "accessory"];
    const ordered = (slots: { role: string; garmentId: string; locked: boolean }[]) => [...slots].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.role.localeCompare(b.role));
    const offered = (role: string, garmentId: string) => studio.selectors.find((s: any) => s.role === role)?.items.some((i: any) => i.garmentId === garmentId);
    let slots = ordered(studio.opening.filter((s: any) => s.garmentId && offered(s.role, s.garmentId)).map((s: any) => ({ role: s.role, garmentId: s.garmentId, locked: false })));
    expect(slots.length).toBeGreaterThanOrEqual(3);

    const verdict = await rec.post("/v1/studio/validate", { mode: "for_today", slots });
    expect(typeof verdict.valid).toBe("boolean");
    await rec.post("/v1/studio/compose", { slots });

    // Lock the top and ask for something that works with it.
    const locked = slots.map((s) => ({ ...s, locked: s.role === "top" }));
    const suggestions = await rec.post("/v1/studio/suggest", { mode: "for_today", slots: locked, limit: 5 });
    expect(suggestions.suggestions.length).toBeGreaterThan(0);
    const first = suggestions.suggestions[0];
    // StudioModel.apply: locked roles keep their piece; unlocked roles take the suggestion where it is offered.
    const applied = new Map<string, string>(locked.filter((s) => s.locked).map((s) => [s.role, s.garmentId]));
    for (const s of first.slots) if (!applied.has(s.role) && s.garmentId && offered(s.role, s.garmentId)) applied.set(s.role, s.garmentId);
    slots = ordered([...applied].map(([role, garmentId]) => ({ role, garmentId, locked: role === "top" })));
    await rec.post("/v1/studio/compose", { slots });

    await rec.command("save", "studio.save_combination", { name: "Fixture combination", slots, mode: "for_today" });
    await rec.get("/v1/studio", { mode: "for_today" });
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await rec.command("plan", "studio.plan_for_day", { localDate: tomorrow, slots });
    await rec.get("/v1/studio", { mode: "for_today" });
    await rec.command("wear", "wear.record", { wearingDate: today, garmentIds: slots.map((s) => s.garmentId), timezone: "Europe/London" });
    await rec.get("/v1/studio", { mode: "for_today" });
    await rec.get("/v1/today");

    // A trip: created, a proposal requested, packed, unpacked.
    const departs = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const returns = new Date(Date.parse(`${today}T12:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10);
    await rec.command("trip", "trip.create", {
      name: "Paris",
      departsOn: departs,
      returnsOn: returns,
      destinations: [{ label: "Paris", timezone: "Europe/Paris", from: departs, to: returns }],
      luggage: { label: "Carry-on only" },
      source: { kind: "owner_statement" },
    });
    const trips = await rec.get("/v1/trips");
    const trip = trips.trips[0];
    await rec.change("proposal", "POST", `/v1/trips/${trip.tripId}/packing-proposal`, { clientRequestId: `fixture-${crypto.randomUUID()}` });
    const proposed = (await rec.get("/v1/trips")).trips[0];
    expect(proposed.proposal.items.length).toBeGreaterThan(0);
    await rec.command("packed", "stock.pack", { tripId: trip.tripId, items: proposed.proposal.items.map((i: any) => ({ garmentId: i.garmentId, quantity: i.quantity })) });
    await rec.get("/v1/trips");
    await rec.command("unpacked", "stock.unpack", { tripId: trip.tripId });
    await rec.get("/v1/trips");

    // Pause with a resume date, then resume.
    await rec.command("pause", "service.pause", { resumeOn: returns });
    await rec.get("/v1/settings");
    await rec.get("/v1/today");
    await rec.command("resume", "service.resume", {});
    const resumed = await rec.get("/v1/settings");
    await rec.get("/v1/today");

    await rec.command("four-options", "settings.update", { patch: { delivery: { defaultOptionCount: 4 } } }, { settings: resumed.version ?? settings.version });
    await rec.get("/v1/settings");
    await rec.command("direction", "style.add_direction", { text: "Stop making navy the default swap", source: { kind: "owner_statement" } });
    const style = await rec.get("/v1/style");

    // Save in My style (contract 1.1.0): a FIXTURE rewording of the sentence the shoe-size measurement
    // quotes. The preview and the save report the affected facts; nothing is decided in the save, and
    // the measurement is then kept as it was, so no fact of the owner's changes value.
    const shoe = style.measurements.find((m: any) => m.key === "shoe_size" && m.passage);
    expect(shoe).toBeTruthy();
    const quote: string = shoe.passage.quote;
    const edited = style.document.content.split(quote).join(`${quote.replace(/\.$/, "")} (fixture rewording).`);
    expect(edited).not.toBe(style.document.content);
    const preview = await rec.post("/v1/style/preview-save", { content: edited, documentId: style.document.documentId });
    expect(preview.conflicts.length).toBeGreaterThan(0);
    const saved = await rec.command("style-save", "style.save_document", { documentId: style.document.documentId, content: edited, source: { kind: "owner_statement" } }, { style: style.styleRevision });
    expect(saved.result.factDiff.conflicts.length).toBe(preview.conflicts.length);
    const afterSave = await rec.get("/v1/style");
    const open = afterSave.factConflicts.find((c: any) => c.fact.id === shoe.measurementId);
    expect(open).toBeTruthy();
    const kept = await rec.command("style-keep", "style.resolve_fact_conflict", { conflictId: open.conflictId, resolution: { action: "keep" } });
    expect(kept.outcome).toBe("committed");
    await rec.get("/v1/style");

    // Bulk edit (contract 1.1.0): the backend says what a category covers, then one command corrects it.
    const selection = await rec.post("/v1/wardrobe/selection", { category: "socks" });
    expect(selection.count).toBeGreaterThan(1);
    const bulk = await rec.command("bulk-correct", "garment.bulk_correct", { selector: { category: "socks" }, changes: { condition: "Fixture check" }, expectedCount: selection.count, source: { kind: "owner_statement" } });
    expect(bulk.outcome).toBe("committed");

    await expect(rec.render()).toMatchFileSnapshot(`${OUT}/owner-studio.json`);
  });

  it("owner-conversation: one continuous transcript, a turn with its event stream, and an attached item identity", async () => {
    const { owner, rec } = await start("owner-conversation", [`The assistant's wording comes from the ${FAKE_MODEL_LABEL}; the turn, run, event stream and transcript are the Worker's.`, "The model route's capability probes are recorded as passed by this fixture (no AI Gateway was contacted)."]);
    // The assistant refuses an unprobed model route. Locally the route is the fake model;
    // `enableFakeModel` writes the labelled fixture probe records through the ordinary command.
    const model = await enableFakeModel(owner);
    const wardrobe = await rec.get("/v1/wardrobe");
    await rec.get("/v1/conversation/messages", { limit: 40 });
    const garment = wardrobe.items.find((i: any) => i.garment.category === "outerwear").garment;

    const turn = async (id: string, body: Record<string, unknown>, reply: string) => {
      model.script({ text: reply });
      const accepted = await rec.change(id, "POST", "/v1/conversation/turns", { clientTurnId: `fixture-${crypto.randomUUID()}`, intent: "chat", ...body });
      expect(accepted.runId).toBeTruthy();
      let run: any;
      for (let i = 0; i < 100; i++) {
        run = await (await rec["api"].get(`/v1/runs/${accepted.runId}`)).json();
        if (["completed", "failed", "cancelled", "needs_input"].includes(run.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(run.state).toBe("completed");
      await rec.stream(`/v1/runs/${accepted.runId}/events`);
      await rec.get(`/v1/runs/${accepted.runId}`);
      await rec.get("/v1/conversation/messages", { limit: 40 });
      return accepted;
    };

    await turn("first-turn", { text: "What goes with the chore coat when it is mild?" }, "The chore coat sits well over an oxford shirt with the dark jeans when it is mild.");
    await turn("ask-about-item", { text: "Is this one warm enough for ten degrees?", attachedRefs: [{ kind: "garment", id: garment.garmentId }] }, "For ten degrees it wants a layer underneath.");

    // Capture, What I wore: authorize, send the bytes to the address the authorization names, finalize,
    // then ONE conversation turn carrying the intent and the finalized photo. (The image is a labelled
    // test PNG, not a photograph; the fake model does not look at it.)
    const png = testPng();
    rec.note("capture-bytes", { fixturePngBase64: btoa(String.fromCharCode(...png)), label: "TEST IMAGE: a generated PNG, not a photograph" });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(rec.startedAt);
    const authorization = await rec.change("upload-authorize", "POST", "/v1/uploads", { clientUploadId: `fixture-${crypto.randomUUID()}`, intent: "selfie", contentType: "image/png", byteLength: png.length, wearingDate: today });
    expect(authorization.url).toBeTruthy();
    await rec.changeRaw("upload-bytes", authorization.method, authorization.url, png, authorization.requiredHeaders, false);
    const completed = await rec.change("upload-complete", "POST", `/v1/uploads/${authorization.uploadId}/complete`, {});
    expect(completed.state).toBe("finalized");
    await turn("capture-turn", { text: "What I wore", attachmentIds: [completed.asset.assetId], imageRoles: { [completed.asset.assetId]: "selfie" }, intent: "what_i_wore" }, "I can see the photo. Tell me what you had on and I will log it.");

    await expect(rec.render()).toMatchFileSnapshot(`${OUT}/owner-conversation.json`);
  });

  it("owner-media: a garment photo and its signed full-size read, a rendered Studio preview requested and read, and this phone registered for notifications and removed", async () => {
    const { rec } = await start("owner-media", [
      "The garment photo is a labelled TEST IMAGE (a generated PNG), attached to one of the owner's real garments in the test database only. A local run has no Images service, so the photo is stored but never becomes the garment's display image.",
      "The notification token is a labelled FIXTURE value, not a token issued by Apple; no notification service is contacted when a device is registered.",
      "The Studio preview is whatever the local Worker's render job produced in the time the recorder waited; its state is recorded as it was.",
    ]);
    const wardrobe = await rec.get("/v1/wardrobe");
    const studio = await rec.get("/v1/studio", { mode: "for_today" });
    await rec.get("/v1/devices");

    // A garment photo: authorize, send the bytes, finalize (the three requests UploadModel makes).
    const top = studio.selectors.find((s: any) => s.role === "top").items.find((i: any) => i.garmentId && i.eligibleToday);
    const garment = wardrobe.items.find((i: any) => i.garment.garmentId === top.garmentId).garment;
    const png = testPng();
    rec.note("photo-bytes", { fixturePngBase64: btoa(String.fromCharCode(...png)), garmentId: garment.garmentId, label: "TEST IMAGE: a generated PNG, not a photograph" });
    const authorization = await rec.change("upload-authorize", "POST", "/v1/uploads", { clientUploadId: `fixture-${crypto.randomUUID()}`, intent: "garment_photo", contentType: "image/png", byteLength: png.length, garmentId: garment.garmentId });
    await rec.changeRaw("upload-bytes", authorization.method, authorization.url, png, authorization.requiredHeaders, false);
    const completed = await rec.change("upload-complete", "POST", `/v1/uploads/${authorization.uploadId}/complete`, {});
    expect(completed.state).toBe("finalized");

    // The item page names the photo; the full-size image is read through a signed address, without the sign-in.
    // The item page lists the photo's stored rendition. Making the cutout that becomes the garment's display
    // image needs the Images service, which a local run does not have, so the display image stays unresolved
    // here; the full-size read below therefore signs the photo's stored rendition.
    const item = await rec.get(`/v1/items/${garment.garmentId}`);
    const asset = item.media?.assets?.find((a: any) => a.assetId === completed.asset.assetId);
    expect(asset?.renditions?.length, JSON.stringify(item.media).slice(0, 600)).toBeGreaterThan(0);
    const renditionId = asset.renditions[0].renditionId;
    expect(item.media.image.hasRealImage).toBe(false);
    const signed = await rec.post(`/v1/media/renditions/${renditionId}/sign`, { width: 1280, ttlSeconds: 60 });
    expect(signed.url).toMatch(/^\/v1\/media\/signed\//);
    const served = await rec.getPublic(signed.url);
    expect(served.status).toBe(200);
    expect(served.bodyBase64).toBeTruthy();

    // Studio: the opening outfit as StudioModel sends it, composed, then a rendered preview asked for and read.
    const ROLE_ORDER = ["outer", "mid_layer", "top", "one_piece", "bottom", "belt", "socks", "footwear", "neckwear", "accessory"];
    const offered = (role: string, garmentId: string) => studio.selectors.find((s: any) => s.role === role)?.items.some((i: any) => i.garmentId === garmentId);
    const slots = studio.opening
      .filter((s: any) => s.garmentId && offered(s.role, s.garmentId))
      .map((s: any) => ({ role: s.role, garmentId: s.garmentId, locked: false }))
      .sort((a: any, b: any) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.role.localeCompare(b.role));
    expect(slots.length).toBeGreaterThanOrEqual(3);
    const composed = await rec.post("/v1/studio/compose", { slots });
    const preview = await rec.change("preview-request", "POST", "/v1/studio/previews", { clientRequestId: `fixture-${crypto.randomUUID()}`, slots });
    expect(preview.manifestHash).toBe(composed.manifestHash);
    let composition: any;
    for (let i = 0; i < 50; i++) {
      composition = await (await rec["api"].get(`/v1/studio/compositions/${preview.manifestHash}`)).json();
      if (["rendered", "failed"].includes(composition.preview.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rec.get(`/v1/studio/compositions/${preview.manifestHash}`);
    if (composition.preview.state === "rendered") await rec.get(`/v1/studio/compositions/${preview.manifestHash}/preview`);
    rec.note("preview-state", { state: composition.preview.state });

    // Notifications: this installation registers the address Apple gave it, then removes it.
    const deviceId = "device-fixture-000001";
    const token = Array.from({ length: 32 }, (_, i) => (0xa0 + i).toString(16).padStart(2, "0")).join("");
    rec.note("device", { deviceId, tokenHex: token, label: "FIXTURE token: not issued by Apple" });
    const registered = await rec.change("device-register", "POST", "/v1/devices", { deviceId, token, environment: "development" });
    expect(registered.status).toBe("active");
    const listed = await rec.get("/v1/devices");
    expect(listed.devices).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token); // the token is never returned
    const removed = await rec.change("device-remove", "POST", `/v1/devices/${deviceId}/remove`, {});
    expect(removed.removed).toBe(true);
    expect((await rec.get("/v1/devices")).devices).toEqual([]);

    await expect(rec.render()).toMatchFileSnapshot(`${OUT}/owner-media.json`);
  });

  it("owner-proposals: a connected assistant's requests are listed for the owner; one is confirmed with its receipt, one is rejected", async () => {
    const { owner, rec } = await start("owner-proposals", [
      `The two requests were relayed through a real MCP connection (garderobe_ask) with the ${FAKE_MODEL_LABEL} scripted to act on them; the proposals, the decision route and the receipt are the Worker's.`,
      "The confirmed garment is a labelled FIXTURE entry in the test database, not one of the owner's garments.",
    ]);
    const model = await enableFakeModel(owner);
    const mcp = await connectMcp(owner, { write: true, clientName: "Connected assistant (fixture)", onElicit: () => ({ action: "accept", content: { confirm: true } }) });
    const relay = async (message: string, toolName: string, input: Record<string, unknown>) => {
      model.script({ toolCalls: [{ toolName, input: { ...input, ownerQuote: message } }] }, { text: "That needs your confirmation in the Garderobe app." });
      const asked = toolResult(await mcp.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `turn-${crypto.randomUUID()}`, mode: "wait" } }));
      expect(asked.ok, JSON.stringify(asked.error)).toBe(true);
      expect(asked.data.receipts).toEqual([]);
    };
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const socks = wardrobe.items.find((i: any) => i.garment.acquisition === "owned" && i.garment.roles.includes("socks")).garment;
    await relay("I bought a navy merino cardigan, add it to my wardrobe", "add_garment", { name: "Navy merino cardigan (FIXTURE, relayed request)", category: "knitwear", quantity: 1, state: "owned" });
    await relay(`I threw away the ${socks.name}`, "retire_garment", { garmentId: socks.garmentId, disposition: "discarded" });

    const listed = await rec.get("/v1/proposals", { state: "all" });
    expect(listed.pending).toBe(2);
    const add = listed.proposals.find((p: any) => p.type === "garment.create");
    const retire = listed.proposals.find((p: any) => p.type === "garment.retire");
    const confirmed = await rec.change("confirm-add", "POST", `/v1/proposals/${add.proposalId}/decision`, { decision: "confirm" });
    expect(confirmed.receipt.outcome).toBe("committed");
    await rec.get("/v1/proposals", { state: "all" });
    const rejected = await rec.change("reject-retire", "POST", `/v1/proposals/${retire.proposalId}/decision`, { decision: "reject" });
    expect(rejected.proposal.state).toBe("rejected");
    expect(rejected.receipt).toBeNull();
    const after = await rec.get("/v1/proposals", { state: "all" });
    expect(after.pending).toBe(0);
    await mcp.close?.();

    await expect(rec.render()).toMatchFileSnapshot(`${OUT}/owner-proposals.json`);
  });

  it("owner-account: recovery kit rotation, a link code, export with a verified download, and recovery from a new sign-in", async () => {
    const { owner, rec } = await start("owner-account", ["Sign-in itself (Cloudflare Access) is not part of a local run: assertions are signed with the test run's key, as @garderobe/worker/testing documents."]);
    await rec.get("/v1/me");
    await rec.get("/v1/exports");
    const issued = await rec.change("rotate-kit", "POST", "/v1/recovery-kit", {});
    expect(issued.kit.recoveryCode.length).toBeGreaterThan(16);
    await rec.get("/v1/me");
    await rec.change("link-code", "POST", "/v1/identities/link", {});

    const job = await rec.change("export", "POST", "/v1/exports", { clientRequestId: `fixture-${crypto.randomUUID()}` });
    let state: any = job;
    for (let i = 0; i < 200 && !["completed", "completed_incomplete", "failed"].includes(state.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await (await rec["api"].get(`/v1/exports/${job.exportId}`)).json();
    }
    await rec.get(`/v1/exports/${job.exportId}`);
    await rec.get("/v1/exports");
    const ticket = await rec.change("ticket", "POST", `/v1/exports/${job.exportId}/ticket`, {});
    const url = new URL(ticket.url, "http://localhost:8787");
    await rec.get(url.pathname, Object.fromEntries(url.searchParams));

    // The owner loses the old sign-in and arrives with a new identity.
    const replacement = new ApiClient(newIdentity("replacement-sign-in"));
    rec.use(replacement);
    await rec.change("recovery-start", "POST", "/auth/recovery/start", {});
    const started = (rec as any).steps.at(-1).response.body;
    const recovered = await rec.change("recovery-complete", "POST", "/auth/recovery/complete", { transactionId: started.transactionId, recoveryCode: issued.kit.recoveryCode, unlinkPreviousIdentities: false });
    expect(recovered.identityLinked).toBe(true);
    const me = await rec.get("/v1/me");
    expect(me.userId).toBe(owner.userId);

    await expect(rec.render()).toMatchFileSnapshot(`${OUT}/owner-account.json`);
  });
});
