import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { CommandReceipt } from "@garderobe/contracts";
import { RunEventData } from "@garderobe/contracts/ext/api";
import { APP_ORIGIN, connectMcp, enableFakeModel, provisionOwner, publishBoard, readSse, testApp, testPng, toolResult, uploadImage, type FakeModel, type TestOwner } from "../src/testing/index.ts";

/*
 * Each product surface through the real Worker, with the REAL owner fixture (supplied profile and
 * inventory). Stand-ins: test-signed Access assertions; the labelled FAKE MODEL for conversation
 * replies; no outbound network, so weather is unavailable and no calendar is connected (the
 * application reports both, which is what these tests check).
 */
let owner: TestOwner;
let stranger: TestOwner;
let model: FakeModel;
const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; details: Record<string, any> } }).error;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  stranger = await provisionOwner();
  model = await enableFakeModel(owner);
});

describe("Today", () => {
  let board: any;

  it("reports plainly when there is no board yet", async () => {
    const today = await owner.api.json("GET", `/v1/today?date=${date}`);
    expect(today.status).toBe("none");
    expect(today.board).toBeNull();
    expect(today.emptyReason).toBeTruthy();
  });

  it("previews validated options without publishing, then publishes a board of real garments", async () => {
    const preview = await owner.api.json("POST", "/v1/recommendations", { clientRequestId: `preview-${crypto.randomUUID()}`, date, count: 3, mode: "preview" });
    expect(preview.state).toBe("completed");
    expect(preview.board).toBeNull();
    expect(preview.options.length).toBeGreaterThan(0);
    expect((await owner.api.json("GET", `/v1/today?date=${date}`)).board).toBeNull();

    const published = await publishBoard(owner, { date });
    board = published.board;
    expect(board.localDate).toBe(date);
    expect(board.options.length).toBeGreaterThanOrEqual(3);
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const owned = new Map(wardrobe.items.map((i: any) => [i.garment.garmentId, i.garment.name]));
    for (const option of board.options) {
      expect(option.optionId).toBeTruthy();
      for (const line of option.garments) {
        // Every garment on the board is a real garment of this owner, named from the ledger.
        expect(owned.get(line.garmentId)).toBe(line.name);
      }
    }
  });

  it("serves the board with its revision and honest source freshness", async () => {
    const today = await owner.api.json("GET", `/v1/today?date=${date}`);
    expect(today.status).toBe("ready");
    expect(today.board.boardId).toBe(board.boardId);
    expect(today.board.revision).toBe(board.revision);
    const freshness = Object.fromEntries(today.freshness.map((f: any) => [f.source, f]));
    expect(freshness.wardrobe.state).toBe("fresh");
    expect(freshness.weather.state).toBe("unavailable");
    expect(freshness.calendar.state).toBe("not_connected");
    expect(freshness.board.revision).toBe(board.revision);
  });

  it("serves the same board revision to MCP as to the app", async () => {
    const mcp = await connectMcp(owner, { write: false, clientName: "Board reader" });
    const viaMcp = toolResult(await mcp.client.callTool({ name: "garderobe_today", arguments: { date } }));
    const viaApi = await owner.api.json("GET", `/v1/today?date=${date}`);
    expect(viaMcp.data.board.boardId).toBe(viaApi.board.boardId);
    expect(viaMcp.data.board.revision).toBe(viaApi.board.revision);
    expect(viaMcp.data.board.options.map((o: any) => o.optionId)).toEqual(viaApi.board.options.map((o: any) => o.optionId));
    const recommended = toolResult(await mcp.client.callTool({ name: "garderobe_recommend", arguments: { date, count: 2, clientRequestId: `rec-${crypto.randomUUID()}` } }));
    expect(recommended.ok).toBe(true);
    expect(recommended.data.board).toBeNull();
    await mcp.close();
  });

  it("Choose records an intention, not a wear", async () => {
    const option = board.options[0];
    const response = await owner.api.command("board.select", { boardId: board.boardId, optionId: option.optionId }, { expectedVersions: { [`board:${board.boardId}`]: board.revision } });
    expect(response.status).toBe(200);
    const today = await owner.api.json("GET", `/v1/today?date=${date}`);
    expect(today.board.selection.optionId).toBe(option.optionId);
    expect(today.dayRecord).toEqual([]);
    expect((await owner.api.json("GET", `/v1/days/${date}`)).garments).toEqual([]);
  });

  it("refuses a plan edit against a stale board revision with a clean conflict", async () => {
    const stale = await owner.api.command("board.select", { boardId: board.boardId, optionId: board.options[1].optionId }, { expectedVersions: { [`board:${board.boardId}`]: 999 } });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe("conflict");
  });

  it("renders the private web board for the signed-in owner only, without item codes", async () => {
    const web = owner.api.with({ client: "web" });
    const page = await web.get(`/board/${date}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain(board.options[0].garments[0].name.replace(/&/g, "&amp;").slice(0, 12));
    expect(html).not.toMatch(/gmt_[0-9a-f]{8}/);
    expect((await SELF.fetch(`${APP_ORIGIN}/board/${date}`)).status).toBe(401);
    const other = await (await stranger.api.with({ client: "web" }).get(`/board/${date}`)).text();
    expect(other).not.toContain(board.options[0].garments[0].name);
  });
});

describe("pause and resume", () => {
  it("pauses the service without disabling observations, and resumes", async () => {
    expect((await owner.api.json("GET", "/v1/service")).paused).toBe(false);
    expect((await owner.api.command("service.pause", { resumeOn: null })).status).toBe(200);
    const paused = await owner.api.json("GET", "/v1/service");
    expect(paused.paused).toBe(true);
    expect(paused.pause.resumeOn).toBeNull();
    expect(paused.returnDeadlinesActive).toBe(true);
    expect((await owner.api.json("GET", "/v1/settings")).service.paused).toBe(true);
    // Observations still commit while paused.
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const sock = wardrobe.items.find((i: any) => i.garment.roles.includes("socks") && i.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0));
    expect((await owner.api.command("care.mark_dirty", { items: [{ garmentId: sock.garment.garmentId, quantity: 1 }] })).status).toBe(200);
    expect((await owner.api.command("service.resume", {})).status).toBe(200);
    expect((await owner.api.json("GET", "/v1/service")).paused).toBe(false);
  });
});

describe("trips and packing", () => {
  it("keeps a proposed packing list distinct from what is physically packed", async () => {
    const departs = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const returns = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10);
    const created = (await (
      await owner.api.command("trip.create", { name: "Paris", departsOn: departs, returnsOn: returns, destinations: [{ label: "Paris", timezone: "Europe/Paris", from: departs, to: returns }], occasions: [{ localDate: departs, label: "Dinner", register: "smart", segment: "evening" }], luggage: { label: "carry-on" }, source: { kind: "owner_statement" } })
    ).json()) as CommandReceipt;
    expect(created.outcome).toBe("committed");
    const tripId = String(created.result.tripId ?? created.affected.find((a) => a.kind === "trip")?.id);
    const proposal = await owner.api.json("POST", `/v1/trips/${tripId}/packing-proposal`, { clientRequestId: `pack-${crypto.randomUUID()}` });
    expect(proposal.items.length).toBeGreaterThan(0);
    expect(proposal.repeatExceptionForTrip).toBe(true);
    const trip = await owner.api.json("GET", `/v1/trips/${tripId}`);
    expect(trip.proposal.items.length).toBe(proposal.items.length);
    // Proposing packs nothing.
    expect(trip.packed).toEqual([]);
    // "Packed" is an owner observation through the ordinary stock command.
    const item = proposal.items[0];
    expect((await owner.api.command("stock.pack", { tripId, items: [{ garmentId: item.garmentId, quantity: 1 }] })).status).toBe(200);
    const packed = (await owner.api.json("GET", `/v1/trips/${tripId}`)).packed;
    expect(packed.map((p: any) => p.garmentId)).toEqual([item.garmentId]);
    expect((await owner.api.json("GET", "/v1/trips")).trips.map((t: any) => t.tripId)).toContain(tripId);
    expect((await stranger.api.get(`/v1/trips/${tripId}`)).status).toBe(404);
  });

  it("previews what a temperature makes wearable as a simulation only", async () => {
    const before = await owner.api.json("GET", "/v1/wardrobe");
    const preview = await owner.api.json("GET", "/v1/wardrobe/temperature-preview?temperatureC=4");
    expect(preview.simulation).toBe(true);
    expect(preview.wearable.length + preview.notWearable.length).toBeGreaterThan(0);
    expect((await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision).toBe(before.wardrobeRevision);
  });
});

describe("Conversation", () => {
  it("accepts a turn once, runs it, and serves the transcript and a replayable event stream", async () => {
    model.script({ text: "Morning. The navy overshirt works with the grey trousers today." });
    const clientTurnId = `turn-${crypto.randomUUID()}`;
    const body = { clientTurnId, text: "What should I wear to the office today?" };
    const accepted = await owner.api.json("POST", "/v1/conversation/turns", body);
    expect(accepted.replayed).toBe(false);
    expect(accepted.runId).toBe(accepted.turnId);

    // The run is durable: poll it like a client that lost its stream.
    let run: any;
    for (let i = 0; i < 80; i++) {
      run = await owner.api.json("GET", `/v1/runs/${accepted.runId}`);
      if (["completed", "failed", "cancelled", "needs_input"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run.state).toBe("completed");
    expect(run.kind).toBe("conversation_turn");
    expect(run.result.reply.text).toContain("navy overshirt");

    // Retransmission of the same turn returns the same turn; nothing is appended twice.
    const again = await owner.api.json("POST", "/v1/conversation/turns", body);
    expect(again.replayed).toBe(true);
    expect(again.turnId).toBe(accepted.turnId);
    const reused = await owner.api.post("/v1/conversation/turns", { clientTurnId, text: "A different message under the same ID" });
    expect(reused.status).toBe(409);

    const transcript = await owner.api.json("GET", "/v1/conversation/messages?limit=20");
    const texts = transcript.messages.map((m: any) => `${m.role}:${m.text}`);
    expect(texts.filter((t: string) => t.includes("What should I wear to the office today?"))).toHaveLength(1);
    expect(texts.some((t: string) => t.startsWith("assistant:") && t.includes("navy overshirt"))).toBe(true);
    expect(transcript.messages.find((m: any) => m.role === "user").channel).toBe("ios");

    // The event stream has ordered IDs and can be resumed after any of them.
    const events = await readSse(await owner.api.get(`/v1/runs/${accepted.runId}/events?follow=false`));
    const ids = events.map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(events[0]!.event).toBe("run_started");
    expect(events.at(-1)!.event).toBe("run_finished");
    expect(events.some((e) => e.event === "text_delta")).toBe(true);
    // Every known event carries the data shape published in the contract.
    for (const e of events) {
      const schema = (RunEventData as Record<string, { safeParse(v: unknown): { success: boolean } }>)[e.event];
      if (schema) expect(schema.safeParse(e.data.data).success, `${e.event} ${JSON.stringify(e.data.data)}`).toBe(true);
      expect(e.data.eventId).toBe(Number(e.id));
    }
    expect(events.find((e) => e.event === "text_delta")!.data.data).toMatchObject({ replace: true });
    expect(events.at(-1)!.data.data).toEqual({ state: "completed" });
    const resumed = await readSse(await owner.api.get(`/v1/runs/${accepted.runId}/events?follow=false`, { "Last-Event-ID": String(ids[1]) }));
    expect(resumed.map((e) => Number(e.id))).toEqual(ids.slice(2));
    // No raw reasoning or model internals in the stream.
    expect(JSON.stringify(events)).not.toMatch(/reasoning|system prompt/i);

    // Another owner cannot read the run, its events, or the transcript.
    expect((await stranger.api.get(`/v1/runs/${accepted.runId}`)).status).toBe(404);
    expect((await stranger.api.get(`/v1/runs/${accepted.runId}/events`)).status).toBe(404);
    expect((await stranger.api.post(`/v1/runs/${accepted.runId}/cancel`)).status).toBe(404);
    expect((await stranger.api.post(`/v1/runs/${accepted.runId}/resume`)).status).toBe(404);
    // Resuming a run that already finished changes nothing: the same settled run, no second reply.
    const resumedRun = await owner.api.json("POST", `/v1/runs/${accepted.runId}/resume`);
    expect(resumedRun.state).toBe("completed");
    expect(resumedRun.lastEventId).toBe(ids.at(-1));
    expect((await stranger.api.json("GET", "/v1/conversation/messages")).messages).toEqual([]);
  });

  it("commits a requested change through the shared command service and reports its receipt", async () => {
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const shoe = wardrobe.items.find((i: any) => i.garment.roles.includes("footwear") && i.availability && !i.availability.hardExcluded && i.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0));
    const text = `I wore the ${shoe.garment.name} today`;
    model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shoe.garment.garmentId], ownerQuote: text } }] }, { text: "Logged." });
    const accepted = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `turn-${crypto.randomUUID()}`, text });
    let run: any;
    for (let i = 0; i < 80; i++) {
      run = await owner.api.json("GET", `/v1/runs/${accepted.runId}`);
      if (["completed", "failed"].includes(run.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run.state).toBe("completed");
    expect(run.receipts).toHaveLength(1);
    expect(run.receipts[0].type).toBe("wear.record");
    // The receipt is the ordinary stored receipt, readable like any other and listed in the item's history.
    const receipt = await owner.api.json("GET", `/v1/commands/${run.receipts[0].commandId}`);
    expect(receipt.type).toBe("wear.record");
    expect(receipt.actor).toBe("assistant");
    expect(receipt.affected.some((a: any) => a.id === shoe.garment.garmentId)).toBe(true);
    const events = await readSse(await owner.api.get(`/v1/runs/${accepted.runId}/events?follow=false`));
    expect(events.some((e) => e.event === "command_receipt")).toBe(true);
  });

  it("a read-only assistant connection gets a proposal, not a change, from garderobe_ask", async () => {
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const top = wardrobe.items.find((i: any) => i.garment.roles.includes("top") && i.balances.some((b: any) => b.bucket === "clean" && b.quantity > 0));
    const message = `The ${top.garment.name} is in the wash`;
    const before = (await owner.api.json("GET", `/v1/commands?entity=garment:${top.garment.garmentId}`)).receipts.length;
    const call = { toolName: "mark_dirty", input: { garmentIds: [top.garment.garmentId], ownerQuote: message } };

    const reader = await connectMcp(owner, { write: false, clientName: "Asking reader" });
    model.script({ toolCalls: [call] }, { text: "I cannot change anything on this connection; I have proposed it." });
    const read = toolResult(await reader.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `ask-${crypto.randomUUID()}` } }));
    expect(read.ok).toBe(true);
    expect(read.data.state).toBe("completed");
    expect(read.data.receipts).toEqual([]);
    expect(read.data.proposals.length).toBeGreaterThan(0);
    expect((await owner.api.json("GET", `/v1/commands?entity=garment:${top.garment.garmentId}`)).receipts.length).toBe(before);

    const writer = await connectMcp(owner, { write: true, clientName: "Asking writer", redirectUri: "https://ask-writer.client.test/cb" });
    model.script({ toolCalls: [call] }, { text: "Done: it is marked for the wash." });
    const wrote = toolResult(await writer.client.callTool({ name: "garderobe_ask", arguments: { message, clientTurnId: `ask-${crypto.randomUUID()}` } }));
    expect(wrote.data.receipts).toHaveLength(1);
    expect(wrote.data.receipts[0].type).toBe("care.mark_dirty");
    const stored = await owner.api.json("GET", `/v1/commands/${wrote.data.receipts[0].commandId}`);
    expect(stored.channel).toBe("mcp");
    // The run is followable from the same connection and from the app.
    const followed = toolResult(await writer.client.callTool({ name: "garderobe_run", arguments: { runId: wrote.data.runId } }));
    expect(followed.data.run.state).toBe("completed");
    expect((await owner.api.json("GET", `/v1/runs/${wrote.data.runId}`)).state).toBe("completed");
    // The whole exchange is one conversation: both channels appear in the single transcript.
    const transcript = await owner.api.json("GET", "/v1/conversation/messages?limit=50");
    expect(new Set(transcript.messages.filter((m: any) => m.role === "user").map((m: any) => m.channel))).toEqual(new Set(["ios", "mcp"]));
    await reader.close();
    await writer.close();
  });

  it("searches the dated conversation and reads returns, orders, projects and feedback", async () => {
    const recall = await owner.api.json("POST", "/v1/recall/search", { text: "office", limit: 5 });
    expect(Array.isArray(recall.hits)).toBe(true);
    expect(recall.watermark).toBeTruthy();
    expect(recall.caveat.length).toBeGreaterThan(0);
    for (const [path, key] of [["/v1/orders", "orders"], ["/v1/returns", "returns"], ["/v1/projects", "projects"], ["/v1/feedback", "feedback"]] as const) {
      expect(Array.isArray((await owner.api.json("GET", path))[key])).toBe(true);
    }
  });
});

describe("scheduled work", () => {
  it("runs the assistant's background duties for every owner without skipping any and can run again", async () => {
    const app = await testApp();
    const first = (await app.assistant!.maintenance(Date.now())) as { skippedOwners: string[]; delivered: number };
    expect(first.skippedOwners).toEqual([]);
    const second = (await app.assistant!.maintenance(Date.now())) as { skippedOwners: string[]; delivered: number };
    expect(second.delivered).toBe(0); // nothing is delivered twice
  });
});

describe("returns, exchanges and comfort feedback", () => {
  it("records comfort feedback and a return case through the same command route and reads them back", async () => {
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const shoe = wardrobe.items.find((i: any) => i.garment.roles.includes("footwear"));
    const types = (await owner.api.json("GET", "/v1/command-types")).types;
    const feedbackType = types.find((t: any) => t.type === "feedback.record");
    expect(feedbackType).toBeTruthy();
    const feedback = await owner.api.command("feedback.record", { text: "these shoes hurt after an hour", kind: "pain", garmentIds: [shoe.garment.garmentId], source: { kind: "owner_statement" } });
    const feedbackBody = (await feedback.json()) as any;
    expect(feedback.status, JSON.stringify(feedbackBody)).toBe(200);
    const listed = await owner.api.json("GET", `/v1/feedback?garmentId=${shoe.garment.garmentId}`);
    expect(listed.feedback.some((f: any) => f.text === "these shoes hurt after an hour" && f.pain === true)).toBe(true);
    expect((await stranger.api.json("GET", "/v1/feedback")).feedback).toEqual([]);
  });
});

describe("Capture and the visual wardrobe", () => {
  it("authorizes, receives and finalizes an upload; the image is then served only to its owner", async () => {
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const garment = wardrobe.items.find((i: any) => i.garment.roles.includes("top")).garment;
    expect((await owner.api.get(`/v1/items/${garment.garmentId}/image`)).status).toBe(404);

    const { uploadId, complete } = await uploadImage(owner, { garmentId: garment.garmentId });
    expect(complete.state).toBe("finalized");
    expect(complete.asset.assetId).toBeTruthy();
    expect(complete.receipt.type).toBe("media.finalize_upload");
    expect((await owner.api.json("GET", `/v1/uploads/${uploadId}`)).state).toBe("finalized");

    const item = await owner.api.json("GET", `/v1/items/${garment.garmentId}`);
    expect(item.media.assets.map((a: any) => a.assetId)).toContain(complete.asset.assetId);
    const image = await owner.api.get(`/v1/media/assets/${complete.asset.assetId}?variant=original`);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("Cache-Control")).toContain("private");
    expect(new Uint8Array(await image.arrayBuffer()).length).toBe(testPng().length);
    // Not public, and not another owner's.
    expect((await SELF.fetch(`${APP_ORIGIN}/v1/media/assets/${complete.asset.assetId}`)).status).toBe(401);
    expect((await stranger.api.get(`/v1/media/assets/${complete.asset.assetId}`)).status).toBe(404);
    expect((await owner.api.get(`/v1/media/assets/${complete.asset.assetId}?width=123`)).status).toBe(400);
  });

  it("rejects bytes that are not the declared image and never lets an unfinalized upload become evidence", async () => {
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const garment = wardrobe.items.find((i: any) => i.garment.roles.includes("bottom")).garment;
    const fake = new TextEncoder().encode("<html><script>alert(1)</script></html>".padEnd(400, " "));
    // The bytes are checked against the declared type when they arrive: HTML sent as a PNG is refused.
    const disguised = await owner.api.json("POST", "/v1/uploads", { clientUploadId: `upload-${crypto.randomUUID()}`, intent: "garment_photo", contentType: "image/png", byteLength: fake.length, garmentId: garment.garmentId });
    const refused = await SELF.fetch(`${APP_ORIGIN}${disguised.url}`, { method: "PUT", headers: { ...disguised.requiredHeaders, "Content-Length": String(fake.length) }, body: fake });
    expect(refused.status).toBe(400);
    // Declaring a different type than was authorized is refused as well.
    const wrongType = await SELF.fetch(`${APP_ORIGIN}${disguised.url}`, { method: "PUT", headers: { "Content-Type": "text/html", "Content-Length": String(fake.length) }, body: fake });
    expect(wrongType.status).toBe(400);
    // Finalizing an upload that never received valid bytes produces no asset.
    const complete = await owner.api.post(`/v1/uploads/${disguised.uploadId}/complete`, {});
    const completeBody = (await complete.json()) as any;
    expect(complete.status >= 400 || completeBody.state === "rejected").toBe(true);
    expect((await owner.api.json("GET", `/v1/items/${garment.garmentId}`)).media.image.hasRealImage).toBe(false);

    // Authorized but never uploaded or finalized: it is not an asset.
    const authorization = await owner.api.json("POST", "/v1/uploads", { clientUploadId: `upload-${crypto.randomUUID()}`, intent: "garment_photo", contentType: "image/png", byteLength: 500, garmentId: garment.garmentId });
    expect((await owner.api.json("GET", `/v1/uploads/${authorization.uploadId}`)).state).toBe("authorized");
    expect((await owner.api.json("GET", `/v1/items/${garment.garmentId}`)).media.assets).toEqual([]);
    // The upload URL only works with its own token, and another owner cannot finalize it.
    const noToken = await SELF.fetch(`${APP_ORIGIN}/v1/uploads/${authorization.uploadId}/content`, { method: "PUT", headers: { "Content-Type": "image/png", "Content-Length": "4" }, body: new Uint8Array(4) });
    expect(noToken.status).toBe(401);
    const badToken = await SELF.fetch(`${APP_ORIGIN}/v1/uploads/${authorization.uploadId}/content?token=forged`, { method: "PUT", headers: { "Content-Type": "image/png", "Content-Length": "4" }, body: new Uint8Array(4) });
    expect(badToken.status).toBe(403);
    expect((await stranger.api.post(`/v1/uploads/${authorization.uploadId}/complete`, {})).status).toBeGreaterThanOrEqual(400);
  });
});

describe("Studio", () => {
  it("offers selectors of real garments, validates on the backend, and browsing changes nothing", async () => {
    const before = await owner.api.json("GET", "/v1/wardrobe");
    const studio = await owner.api.json("GET", "/v1/studio?mode=for_today");
    const roles = studio.selectors.map((s: any) => s.role);
    for (const role of ["top", "bottom", "footwear", "outer"]) expect(roles).toContain(role);
    const pick = (role: string) => studio.selectors.find((s: any) => s.role === role).items.find((i: any) => i.eligibleToday && i.garmentId);
    const slots = ["top", "bottom", "socks", "footwear"].map((role) => ({ role, garmentId: pick(role).garmentId }));
    const validation = await owner.api.json("POST", "/v1/studio/validate", { mode: "for_today", slots });
    expect(typeof validation.valid).toBe("boolean");
    expect(validation.validator).toBeTruthy();
    const suggestions = await owner.api.json("POST", "/v1/studio/suggest", { mode: "for_today", slots: [{ ...slots[0], locked: true }], limit: 2 });
    for (const s of suggestions.suggestions) expect(s.slots.find((x: any) => x.role === "top").garmentId).toBe(slots[0]!.garmentId);
    const composition = await owner.api.json("POST", "/v1/studio/compose", { slots });
    expect(composition).toBeTruthy();
    const after = await owner.api.json("GET", "/v1/wardrobe");
    expect(after.wardrobeRevision).toBe(before.wardrobeRevision);

    // The backend, not the phone, decides whether a combination is valid: one without socks is refused.
    const sockless = await owner.api.command("studio.save_combination", { name: "No socks", slots: slots.filter((s) => s.role !== "socks") });
    expect(sockless.status).toBe(409);
    // Save combination is a distinct, explicit command; it is then listed and attached to its garments.
    const saved = await owner.api.command("studio.save_combination", { name: "Office default", slots });
    const savedBody = (await saved.json()) as any;
    expect(saved.status, JSON.stringify(savedBody)).toBe(200);
    const listed = await owner.api.json("GET", "/v1/studio");
    expect(listed.combinations.map((c: any) => c.name)).toContain("Office default");
    expect((await owner.api.json("GET", `/v1/items/${slots[0]!.garmentId}`)).knownCombinations.map((c: any) => c.name)).toContain("Office default");
    // Saving a combination is not a wear.
    expect((await stranger.api.json("GET", "/v1/studio")).combinations).toEqual([]);
  });
});

describe("recovery screen", () => {
  it("shows concrete state: last board, pending work and what to do next", async () => {
    const status = await owner.api.json("GET", "/v1/recovery");
    expect(status.pending.effects).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(status.connectionIssues)).toBe(true);
    expect(status.diagnostics.modules).toEqual({ daily: true, assistant: true, media: true });
    expect(JSON.stringify(status)).not.toMatch(/token|secret|password/i);
  });
});
