/**
 * Journey 11: the owner's one continuous conversation and photo capture.
 *
 * Specification: section 3 "Conversation and capture" and "Laundry, wear follow-through, and undo";
 * section 5 "Probability without status interrogation"; section 8 "A command is a verified change";
 * section 13 "Native and web API" (turns, transcript, recall, runs, event stream, cancel) and "Adapt
 * Think streaming to Swift" (retransmitted turn, replay cursor). Acceptance rows (section 17):
 * Hallucinated items, Visual matching, Personal context (a request waits for the owner). Command classes:
 * packages/assistant/README.md (a report is recorded at once only for garments the owner named; a
 * request waits for the owner's confirmation). Profile section 11 ("verify before asserting", decision-light).
 *
 * Everything inside the Worker is real: HTTP API, conversation actor, command service, local D1/R2/KV, the
 * owner's real profile and the real 127-garment inventory. Stand-ins, at external boundaries only:
 *  - FAKE MODEL (scripted, no inference) in place of the language model behind AI Gateway. Replies whose
 *    text the test scripted prove nothing about a real model's wording; what is asserted is what the
 *    backend did with the model's tool calls.
 *  - test-signed sign-in assertions in place of Cloudflare Access;
 *  - the scripted weather double (src/outbound.ts) for the fictional test place;
 *  - `testPng()` LABELLED TEST IMAGES: they are not photographs of garments, so nothing here proves
 *    visual matching quality, only that a photograph cannot change the wardrobe by itself.
 * Garments named "SYNTHETIC ..." are created by the journey through the ordinary command and marked
 * synthetic; they are used where a step would otherwise invent a fact about a garment the owner owns.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { defect } from "../src/defect.ts";
import { enableFakeModel, provisionOwner, publishBoard, readSse, uploadImage, type FakeModel, type TestOwner } from "@garderobe/worker/testing";
import { exec, internalCodesIn, realOwnerAt, refused, runCron, settleRun, sleep, wholeWardrobe, type JourneyOwner, type WardrobeItem } from "../src/world.ts";

let j: JourneyOwner;
let owner: TestOwner;
let stranger: TestOwner;
let model: FakeModel;
let shoe: WardrobeItem["garment"];
let unnamedTop: WardrobeItem["garment"];
let sock: WardrobeItem["garment"];
let scarf: { garmentId: string; name: string };
let gloves: { garmentId: string; name: string };
let wearTurn: { runId: string; commandId: string };

const KNOWN_EVENTS = ["run_started", "activity", "text_delta", "outfit_board", "product_comparison", "sources", "command_receipt", "needs_input", "run_finished", "snapshot"];
const turnId = () => `turn-${crypto.randomUUID()}`;
const pending = async (target: TestOwner) => (await target.api.json("GET", "/v1/proposals")).proposals as Record<string, any>[];
const decide = (proposalId: string, decision: "confirm" | "reject") => owner.api.post(`/v1/proposals/${proposalId}/decision`, { decision });
const dayGarments = async (date: string) => ((await owner.api.json("GET", `/v1/days/${date}`)).garments as { garmentId: string }[]).map((g) => g.garmentId);
const historyOf = async (garmentId: string) => (await owner.api.json("GET", `/v1/commands?entity=garment:${garmentId}`)).receipts as Record<string, any>[];
const transcript = async (target: TestOwner = owner) => (await target.api.json("GET", "/v1/conversation/messages?limit=100")).messages as Record<string, any>[];

/** One owner message through the app's conversation route, followed to a settled run. */
async function say(text: string, extra: Record<string, unknown> = {}): Promise<any> {
  const accepted = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: turnId(), text, ...extra });
  return settleRun(owner.api, accepted.runId);
}

/** A labelled synthetic accessory created through the ordinary command, as the owner. */
async function syntheticAccessory(name: string, kind: string): Promise<{ garmentId: string; name: string }> {
  const receipt = await exec(owner.api, "garment.create", { name, category: "accessory", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, attributes: { accessoryKind: kind }, source: { kind: "system", note: "synthetic journey test garment" } });
  return { garmentId: String(receipt.result.garmentId), name };
}

beforeAll(async () => {
  j = await realOwnerAt("Conversation");
  owner = j.owner;
  stranger = await provisionOwner();
  model = await enableFakeModel(owner);
  const wardrobe = await wholeWardrobe(owner.api);
  const wearableNow = (i: WardrobeItem) => i.garment.acquisition === "owned" && i.availability && !i.availability.hardExcluded && i.balances.some((b) => b.bucket === "clean" && b.quantity > 0);
  shoe = wardrobe.items.find((i) => i.garment.roles.includes("footwear") && wearableNow(i))!.garment;
  unnamedTop = wardrobe.items.find((i) => i.garment.roles.includes("top") && wearableNow(i))!.garment;
  sock = wardrobe.items.find((i) => i.garment.roles.includes("socks") && wearableNow(i))!.garment;
});

describe("journey 11: one continuous conversation, reports, requests and photo capture", () => {
  it("the real wardrobe is in place: 127 garments, nothing waiting for the owner, an empty conversation", async () => {
    const wardrobe = await wholeWardrobe(owner.api);
    expect(wardrobe.total).toBe(127);
    expect(wardrobe.items).toHaveLength(127);
    expect(await pending(owner)).toEqual([]);
    expect(await transcript()).toEqual([]);
    expect((await owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput).toBe(0);
  });

  it("a turn is accepted once and answers with a durable run to follow, never with 'done'", async () => {
    model.script({ text: "SCRIPTED FAKE MODEL REPLY: the grey flannels." });
    const body = { clientTurnId: turnId(), text: "What goes with the navy blazer for the office?" };
    const response = await owner.api.post("/v1/conversation/turns", body);
    expect(response.status).toBe(200);
    const accepted = (await response.json()) as Record<string, any>;
    // The acceptance carries identifiers and a state only: no reply, no receipts, nothing to render as finished.
    expect(Object.keys(accepted).sort()).toEqual(["replayed", "runId", "state", "turnId"]);
    expect(accepted.replayed).toBe(false);
    expect(["queued", "running", "completed"]).toContain(accepted.state);

    // The run is durable: a client that lost its stream reads the result by polling.
    const run = await settleRun(owner.api, accepted.runId);
    expect(run).toMatchObject({ runId: accepted.runId, kind: "conversation_turn", state: "completed", pendingInput: null, receipts: [], proposals: [], error: null });
    expect(run.result.reply.text).toContain("grey flannels");

    // Retransmitting the same turn returns the same turn and appends nothing.
    const again = await owner.api.json("POST", "/v1/conversation/turns", body);
    expect(again).toMatchObject({ replayed: true, turnId: accepted.turnId, runId: accepted.runId });
    // A different message under the same client ID is refused, not silently swapped in.
    const reused = await refused(await owner.api.post("/v1/conversation/turns", { clientTurnId: body.clientTurnId, text: "A different message under the same ID" }));
    expect(reused.status).toBe(409);
    expect(reused.error.message).not.toBe("");

    const messages = await transcript();
    expect(messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([body.text]);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("A different message under the same ID");
  });

  it("'I wore the <garment> today' is recorded at once, with an ordinary stored receipt shown in the item's history", async () => {
    const before = await owner.api.json("GET", `/v1/items/${shoe.garmentId}`);
    expect(await dayGarments(j.today)).toEqual([]);
    const text = `I wore the ${shoe.name} today`;
    model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shoe.garmentId] } }] }, { text: "SCRIPTED FAKE MODEL REPLY: logged." });
    const run = await say(text);
    expect(run.state).toBe("completed");
    expect(run.proposals).toEqual([]);
    expect(run.receipts).toHaveLength(1);
    const ref = run.receipts[0];
    expect(ref).toMatchObject({ type: "wear.record", outcome: "committed", undoAvailable: true });
    // The receipt's wording is the service's, from the ledger: it names the garment and carries no codes.
    expect(ref.summary).toContain(shoe.name);
    expect(internalCodesIn(ref.summary)).toEqual([]);

    // The same receipt is the ordinary stored one.
    const receipt = await owner.api.json("GET", `/v1/commands/${ref.commandId}`);
    expect(receipt).toMatchObject({ commandId: ref.commandId, type: "wear.record", outcome: "committed", summary: ref.summary, actor: "assistant", channel: "ios", undo: { available: true }, result: { wearingDate: j.today, counted: [shoe.garmentId] } });
    expect(receipt.affected).toEqual([expect.objectContaining({ kind: "garment", id: shoe.garmentId })]);

    // State read back: the day's record, the item's own history and its recorded wear count.
    expect(await dayGarments(j.today)).toEqual([shoe.garmentId]);
    expect((await historyOf(shoe.garmentId)).map((r) => r.commandId)).toContain(ref.commandId);
    const after = await owner.api.json("GET", `/v1/items/${shoe.garmentId}`);
    expect(after.detail.recordedWearCount).toBe(before.detail.recordedWearCount + 1);
    wearTurn = { runId: run.runId, commandId: ref.commandId };
  });

  it("the run's event stream is ordered, resumable after any event, and carries no raw reasoning", async () => {
    const events = await readSse(await owner.api.get(`/v1/runs/${wearTurn.runId}/events?follow=false`));
    const ids = events.map((e) => Number(e.id));
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(events[0]!.event).toBe("run_started");
    expect(events.at(-1)).toMatchObject({ event: "run_finished", data: { data: { state: "completed" } } });
    for (const e of events) {
      expect(KNOWN_EVENTS).toContain(e.event);
      expect(e.data.eventId).toBe(Number(e.id));
      expect(e.data.runId).toBe(wearTurn.runId);
    }
    // The change appears in the stream as its receipt, before the prose that follows it.
    const receiptAt = events.findIndex((e) => e.event === "command_receipt");
    const textAt = events.findIndex((e) => e.event === "text_delta");
    expect(events[receiptAt]!.data.data.receipt).toMatchObject({ commandId: wearTurn.commandId, type: "wear.record", outcome: "committed" });
    expect(receiptAt).toBeLessThan(textAt);

    // A client that dropped after the second event gets exactly what it missed, by header or by query.
    const resumed = await readSse(await owner.api.get(`/v1/runs/${wearTurn.runId}/events?follow=false`, { "Last-Event-ID": String(ids[1]) }));
    expect(resumed.map((e) => Number(e.id))).toEqual(ids.slice(2));
    const byQuery = await readSse(await owner.api.get(`/v1/runs/${wearTurn.runId}/events?follow=false&after=${ids[1]}`));
    expect(byQuery.map((e) => Number(e.id))).toEqual(ids.slice(2));
    expect((await owner.api.json("GET", `/v1/runs/${wearTurn.runId}`)).lastEventId).toBe(ids.at(-1));

    // No reasoning, prompt or model internals in what the phone receives.
    expect(JSON.stringify(events)).not.toMatch(/reasoning|system prompt|chain of thought/i);
    // Another owner can read neither the run nor its events.
    expect((await stranger.api.get(`/v1/runs/${wearTurn.runId}`)).status).toBe(404);
    expect((await stranger.api.get(`/v1/runs/${wearTurn.runId}/events?follow=false`)).status).toBe(404);
  });

  it("Undo on the receipt takes the wear back with a compensating command; the receipt itself stays readable", async () => {
    const undone = await exec(owner.api, "command.undo", { commandId: wearTurn.commandId, reason: null });
    expect(undone.outcome).toBe("committed");
    expect(internalCodesIn(undone.summary)).toEqual([]);
    expect(await dayGarments(j.today)).toEqual([]);
    // Deleting the receipt is never the undo mechanism: the original is still there, beside its undo.
    const original = await owner.api.json("GET", `/v1/commands/${wearTurn.commandId}`);
    expect(original.type).toBe("wear.record");
    expect(undone.result.undoneCommandId).toBe(wearTurn.commandId);
    expect((await historyOf(shoe.garmentId)).map((r) => r.commandId)).toEqual(expect.arrayContaining([wearTurn.commandId, undone.commandId]));
    // A second Undo of the same action is refused in plain words and takes nothing back twice.
    const twice = await refused(await owner.api.command("command.undo", { commandId: wearTurn.commandId, reason: null }));
    expect(twice.status).toBe(409);
    expect(twice.error.code).toBe("not_undoable");
    expect(twice.error.message).toMatch(/already undone/i);
    expect(internalCodesIn(twice.error.message)).toEqual([]);
  });

  it("a request writes nothing: it becomes a proposal the owner sees, with the system's summary of the exact change", async () => {
    scarf = await syntheticAccessory("SYNTHETIC journey scarf", "scarf");
    const before = await wholeWardrobe(owner.api);
    expect(before.total).toBe(128);
    model.script({ toolCalls: [{ toolName: "retire_garment", input: { garmentId: scarf.garmentId, disposition: "donated" } }] }, { text: "SCRIPTED FAKE MODEL REPLY: that is waiting for you in the app." });
    const run = await say(`I gave the ${scarf.name} away to a charity shop`);
    expect(run.state).toBe("completed");
    expect(run.receipts).toEqual([]);
    expect(run.proposals.map((p: any) => p.type)).toEqual(["garment.retire"]);

    // Nothing changed: same garments, same revision, no new receipt on the item.
    const after = await wholeWardrobe(owner.api);
    expect(after.total).toBe(128);
    expect(after.wardrobeRevision).toBe(before.wardrobeRevision);
    expect((await historyOf(scarf.garmentId)).map((r) => r.type)).toEqual(["garment.create"]);

    const list = await owner.api.json("GET", "/v1/proposals");
    expect(list.pending).toBe(1);
    const [proposal] = list.proposals;
    expect(proposal).toMatchObject({ type: "garment.retire", state: "pending", turnId: run.runId, decidedAt: null, commandId: null, source: { channel: "ios", assistantName: null }, payload: { garmentId: scarf.garmentId, disposition: "donated" } });
    // The confirmation shows the exact change in plain words: which piece, and what happens to it.
    expect(proposal.summary).toContain(scarf.name);
    expect(proposal.summary).toMatch(/donated/i);
    expect(proposal.summary).toMatch(/left your wardrobe|no longer be suggested/i);
    expect(internalCodesIn(proposal.summary)).toEqual([]);
    expect(proposal.summary).not.toContain("SCRIPTED FAKE MODEL"); // written by the service, not by the model
    expect(Date.parse(proposal.expiresAt)).toBeGreaterThan(Date.now());
    // Nobody else sees or decides it.
    expect(await pending(stranger)).toEqual([]);
    expect((await stranger.api.post(`/v1/proposals/${proposal.proposalId}/decision`, { decision: "confirm" })).status).toBe(404);
    expect((await wholeWardrobe(owner.api)).total).toBe(128);
  });

  it("confirming the proposal carries out that change once, as the owner's own, with a committed receipt", async () => {
    const [proposal] = await pending(owner);
    const response = await decide(proposal!.proposalId, "confirm");
    const body = (await response.json()) as Record<string, any>;
    expect(response.status, JSON.stringify(body).slice(0, 400)).toBe(200);
    expect(body).toMatchObject({ replayed: false, proposal: { state: "confirmed", commandId: body.receipt.commandId }, receipt: { type: "garment.retire", outcome: "committed", actor: "owner" } });
    expect(body.receipt.summary).toContain(scarf.name);
    expect(internalCodesIn(body.receipt.summary)).toEqual([]);
    expect(body.receipt.affected).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "garment", id: scarf.garmentId })]));

    // State: the piece has left the wardrobe; the real 127 are untouched.
    const wardrobe = await wholeWardrobe(owner.api);
    expect(wardrobe.total).toBe(127);
    expect(wardrobe.items.map((i) => i.garment.garmentId)).not.toContain(scarf.garmentId);
    expect((await owner.api.json("GET", `/v1/commands/${body.receipt.commandId}`)).type).toBe("garment.retire");

    // Confirming again repeats nothing; a confirmed proposal cannot be rejected afterwards.
    const repeat = (await (await decide(proposal!.proposalId, "confirm")).json()) as Record<string, any>;
    expect(repeat).toMatchObject({ replayed: true, receipt: { commandId: body.receipt.commandId } });
    expect((await decide(proposal!.proposalId, "reject")).status).toBe(409);
    expect((await wholeWardrobe(owner.api)).total).toBe(127);
    expect(await pending(owner)).toEqual([]);
    const all = (await owner.api.json("GET", "/v1/proposals?state=all")).proposals as Record<string, any>[];
    expect(all.find((p) => p.proposalId === proposal!.proposalId)!.state).toBe("confirmed");
  });

  it("rejecting a proposal leaves the wardrobe as it was, and the rejection is final", async () => {
    const before = await wholeWardrobe(owner.api);
    model.script({ toolCalls: [{ toolName: "retire_garment", input: { garmentId: sock.garmentId, disposition: "discarded" } }] }, { text: "SCRIPTED FAKE MODEL REPLY: waiting for you." });
    const run = await say(`I threw away the ${sock.name}`);
    expect(run.receipts).toEqual([]);
    const proposal = (await pending(owner)).find((p) => p.turnId === run.runId)!;
    expect(proposal.summary).toContain(sock.name);
    expect(internalCodesIn(proposal.summary)).toEqual([]);

    const rejected = (await (await decide(proposal.proposalId, "reject")).json()) as Record<string, any>;
    expect(rejected).toMatchObject({ receipt: null, proposal: { state: "rejected", commandId: null } });
    const late = await refused(await decide(proposal.proposalId, "confirm"));
    expect(late.status).toBe(409);
    expect(await pending(owner)).toEqual([]);

    const after = await wholeWardrobe(owner.api);
    expect(after.total).toBe(before.total);
    expect(after.wardrobeRevision).toBe(before.wardrobeRevision);
    expect(after.items.map((i) => i.garment.garmentId)).toContain(sock.garmentId);
    expect((await historyOf(sock.garmentId)).some((r) => r.type === "garment.retire")).toBe(false);
  });

  it("a proposal whose garment changed after it was proposed is refused on confirm (409) and overwrites nothing", async () => {
    gloves = await syntheticAccessory("SYNTHETIC journey gloves", "gloves");
    model.script({ toolCalls: [{ toolName: "correct_garment", input: { garmentId: gloves.garmentId, changes: { condition: "loose thread at the cuff (journey test)" } } }] }, { text: "SCRIPTED FAKE MODEL REPLY: waiting for you." });
    const run = await say(`The ${gloves.name} have a loose thread at the cuff now`);
    expect(run.receipts).toEqual([]);
    const proposal = (await pending(owner)).find((p) => p.turnId === run.runId)!;
    expect(proposal.type).toBe("garment.correct");
    // The summary shows the stored value word for word, inside quotation marks.
    expect(proposal.summary).toContain(gloves.name);
    expect(proposal.summary).toContain("\u201Cloose thread at the cuff (journey test)\u201D");
    expect(internalCodesIn(proposal.summary)).toEqual([]);

    // Before looking at the proposal, the owner corrects the same record in the app.
    await exec(owner.api, "garment.correct", { garmentId: gloves.garmentId, changes: { condition: "mended (journey test)" }, source: { kind: "owner_statement" } });
    const receiptsBefore = (await historyOf(gloves.garmentId)).length;

    const stale = await refused(await decide(proposal.proposalId, "confirm"));
    expect(stale.status).toBe(409);
    expect(stale.error.code).toBe("conflict");
    expect(stale.error.message).not.toBe("");
    // The owner's newer fact stands, no command was recorded, and the proposal is still open for a decision.
    expect((await owner.api.json("GET", `/v1/items/${gloves.garmentId}`)).detail.garment.condition).toBe("mended (journey test)");
    expect(await historyOf(gloves.garmentId)).toHaveLength(receiptsBefore);
    expect((await pending(owner)).map((p) => p.proposalId)).toEqual([proposal.proposalId]);
    expect((await decide(proposal.proposalId, "reject")).status).toBe(200);
    expect(await pending(owner)).toEqual([]);
  });

  it("a model that invents a garment ID, or logs a piece the owner did not name, changes nothing in the inventory", async () => {
    const before = await wholeWardrobe(owner.api);
    const topBefore = await owner.api.json("GET", `/v1/items/${unnamedTop.garmentId}`);
    const invented = "gmt_ffffffffffffffffffffffff";

    // 1. An identifier that exists nowhere: nothing is recorded and nothing is offered to confirm.
    model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [invented] } }, { toolName: "retire_garment", input: { garmentId: invented, disposition: "sold" } }] }, { text: "SCRIPTED FAKE MODEL REPLY." });
    const first = await say("I wore my lucky jumper today and sold the other one");
    expect(first.state).toBe("completed");
    expect(first.receipts).toEqual([]);
    expect(first.proposals.filter((p: any) => JSON.stringify(p.payload).includes(invented))).toEqual([]);
    expect((await pending(owner)).filter((p) => JSON.stringify(p.payload).includes(invented))).toEqual([]);

    // 2. The owner names the shoes; the model also "logs" a top that was never mentioned. Only what the
    //    owner said is recorded; the unnamed piece is at most a request, never a counted wear.
    model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [unnamedTop.garmentId] } }] }, { text: "SCRIPTED FAKE MODEL REPLY." });
    const second = await say(`I wore the ${shoe.name} today`);
    expect(second.state).toBe("completed");
    expect(second.receipts).toEqual([]);
    expect(await dayGarments(j.today)).not.toContain(unnamedTop.garmentId);
    expect((await owner.api.json("GET", `/v1/items/${unnamedTop.garmentId}`)).detail.recordedWearCount).toBe(topBefore.detail.recordedWearCount);
    for (const proposal of await pending(owner)) {
      expect(proposal.summary).toContain(unnamedTop.name); // the owner would see exactly which piece is meant
      expect((await decide(proposal.proposalId, "reject")).status).toBe(200);
    }

    // 3. A garment made up to make a request succeed is not created from a message that never said so.
    model.script({ toolCalls: [{ toolName: "add_garment", input: { name: "SYNTHETIC invented overcoat", category: "coat", quantity: 1, state: "owned" } }] }, { text: "SCRIPTED FAKE MODEL REPLY." });
    const third = await say("Is a camel overcoat too much with grey flannels?");
    expect(third.receipts).toEqual([]);
    for (const proposal of await pending(owner)) expect((await decide(proposal.proposalId, "reject")).status).toBe(200);

    const after = await wholeWardrobe(owner.api);
    expect(after.total).toBe(before.total);
    expect(after.wardrobeRevision).toBe(before.wardrobeRevision);
    expect(after.items.some((i) => i.garment.name.includes("invented overcoat"))).toBe(false);
    expect(await dayGarments(j.today)).toEqual([]);
  });

  it("a selfie sent on its own reaches the assistant as an image, but cannot log unseen pieces or create a garment", async () => {
    const before = await wholeWardrobe(owner.api);
    const selfie = await uploadImage(owner, { intent: "selfie" }); // LABELLED TEST IMAGE, not a photograph of clothes
    expect(selfie.complete.state).toBe("finalized");
    const assetId = selfie.complete.asset.assetId as string;
    expect(selfie.complete.asset).toMatchObject({ kind: "selfie", garmentId: null });

    let imagesSeen = 0;
    model.script(
      (request) => {
        imagesSeen = request.images.length;
        return { toolCalls: [{ toolName: "record_wear", input: { garmentIds: [sock.garmentId, shoe.garmentId] } }, { toolName: "add_garment", input: { name: "SYNTHETIC garment seen in a selfie", category: "knitwear", quantity: 1, state: "owned" } }] };
      },
      { text: "SCRIPTED FAKE MODEL REPLY." },
    );
    const run = await say("", { attachmentIds: [assetId], imageRoles: { [assetId]: "selfie" }, intent: "what_i_wore" });
    expect(run.state).toBe("completed");
    expect(imagesSeen).toBe(1);
    // Nothing was written: no wear for the hidden socks and shoes, no new garment.
    expect(run.receipts).toEqual([]);
    expect(await dayGarments(j.today)).toEqual([]);
    const after = await wholeWardrobe(owner.api);
    expect(after.total).toBe(before.total);
    expect(after.wardrobeRevision).toBe(before.wardrobeRevision);
    expect(after.items.some((i) => i.garment.name.includes("seen in a selfie"))).toBe(false);
    // Whatever is left for the owner is a request showing the exact pieces; the owner declines it.
    for (const proposal of await pending(owner)) {
      expect(internalCodesIn(proposal.summary)).toEqual([]);
      expect((await decide(proposal.proposalId, "reject")).status).toBe(200);
    }
    expect(await dayGarments(j.today)).toEqual([]);
    expect((await wholeWardrobe(owner.api)).total).toBe(before.total);

    // An upload that was never finalized is not something a turn can attach.
    const unfinished = await owner.api.json("POST", "/v1/uploads", { clientUploadId: `upload-${crypto.randomUUID()}`, intent: "attachment", contentType: "image/png", byteLength: 500 });
    const attached = await owner.api.post("/v1/conversation/turns", { clientTurnId: turnId(), text: "what is this?", attachmentIds: [unfinished.uploadId] });
    expect(attached.status).toBeGreaterThanOrEqual(400);
    // Another owner cannot attach this owner's photograph to their own conversation.
    const foreign = await stranger.api.post("/v1/conversation/turns", { clientTurnId: turnId(), text: "what is this?", attachmentIds: [assetId] });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
  });

  it("a photo with the words 'log this' still records only the piece the owner named", async () => {
    const photo = await uploadImage(owner, { intent: "attachment" }); // LABELLED TEST IMAGE
    const assetId = photo.complete.asset.assetId as string;
    model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shoe.garmentId] } }] }, { toolCalls: [{ toolName: "record_wear", input: { garmentIds: [sock.garmentId] } }] }, { text: "SCRIPTED FAKE MODEL REPLY." });
    const run = await say(`Log this: I am wearing the ${shoe.name} today`, { attachmentIds: [assetId], imageRoles: { [assetId]: "selfie" }, intent: "what_i_wore" });
    expect(run.state).toBe("completed");
    expect(run.receipts.map((r: any) => r.type)).toEqual(["wear.record"]);
    expect(run.receipts[0].summary).toContain(shoe.name);
    expect(run.receipts[0].undoAvailable).toBe(true);
    // The socks are hidden in any selfie and were not named: they stay unknown.
    expect(await dayGarments(j.today)).toEqual([shoe.garmentId]);
    for (const proposal of await pending(owner)) expect((await decide(proposal.proposalId, "reject")).status).toBe(200);
    expect(await dayGarments(j.today)).toEqual([shoe.garmentId]);
  });

  it("one compact question from the assistant waits durably and is answered through the run's input route", async () => {
    model.script({ toolCalls: [{ toolName: "ask_owner", input: { question: "Which blazer do you mean?", choices: [{ id: "navy", label: "The navy one" }, { id: "grey", label: "The grey one" }] } }] }, { text: "SCRIPTED FAKE MODEL REPLY: one moment." });
    const waiting = await say("Does the blazer work with the brown trousers?");
    expect(waiting.state).toBe("needs_input");
    expect(waiting.pendingInput).toMatchObject({ question: "Which blazer do you mean?", choices: [{ id: "navy", label: "The navy one" }, { id: "grey", label: "The grey one" }] });
    expect(waiting.receipts).toEqual([]);
    const stream = await readSse(await owner.api.get(`/v1/runs/${waiting.runId}/events?follow=false`));
    expect(stream.find((e) => e.event === "needs_input")!.data.data.input.inputId).toBe(waiting.pendingInput.inputId);
    // The recovery screen counts it as something waiting for the owner.
    expect((await owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput).toBe(1);

    // An answer that names the wrong question is refused and the question stays open.
    expect((await owner.api.post(`/v1/runs/${waiting.runId}/input`, { inputId: "inp_00000000000000000000000000000000", choiceId: "navy" })).status).toBeGreaterThanOrEqual(400);
    expect((await stranger.api.post(`/v1/runs/${waiting.runId}/input`, { inputId: waiting.pendingInput.inputId, choiceId: "navy" })).status).toBe(404);
    expect((await owner.api.json("GET", `/v1/runs/${waiting.runId}`)).state).toBe("needs_input");

    model.script({ text: "SCRIPTED FAKE MODEL REPLY: with the navy blazer, yes." });
    const answered = await owner.api.json("POST", `/v1/runs/${waiting.runId}/input`, { inputId: waiting.pendingInput.inputId, choiceId: "navy" });
    const settled = await settleRun(owner.api, answered.runId);
    expect(settled.state).toBe("completed");
    expect(settled.result.reply.text).toContain("navy blazer");
    // The answer is part of the same conversation, in the owner's words for the chosen option.
    expect((await transcript()).filter((m) => m.role === "user").at(-1)!.text).toBe("The navy one");

    // The question is closed: a different answer afterwards is refused.
    expect((await owner.api.post(`/v1/runs/${waiting.runId}/input`, { inputId: waiting.pendingInput.inputId, choiceId: "grey" })).status).toBeGreaterThanOrEqual(400);
    expect((await transcript()).filter((m) => m.role === "user" && m.text === "The grey one")).toEqual([]);
  });

  defect("D11-1", "after the owner has answered the assistant's question, the recovery screen still counts a run waiting for input", async () => {
    // Specification section 15: the recovery screen offers the concrete state of pending work. The question of
    // the previous step was answered and its run completed, so nothing is waiting for the owner.
    expect((await owner.api.json("GET", "/v1/recovery")).pending.runsNeedingInput).toBe(0);
  });

  it("cancelling a turn in flight stops the rest, keeps what was already recorded, and delivers no late answer", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    model.script({ toolCalls: [{ toolName: "mark_dirty", input: { garmentIds: [sock.garmentId] } }] }, async () => {
      await held;
      return { text: "LATE ANSWER that must not be delivered." };
    });
    const accepted = await owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: turnId(), text: `The ${sock.name} are dirty. And what should I wear with the navy blazer?` });
    let running: any;
    for (let i = 0; i < 100; i++) {
      running = await owner.api.json("GET", `/v1/runs/${accepted.runId}`);
      if (running.receipts.length > 0 || !["queued", "running"].includes(running.state)) break;
      await sleep(50);
    }
    expect(running.state).toBe("running");
    expect(running.receipts.map((r: any) => r.type)).toEqual(["care.mark_dirty"]);

    const cancelled = await owner.api.json("POST", `/v1/runs/${accepted.runId}/cancel`);
    release();
    expect(cancelled.run.state).toBe("cancelled");
    // The answer says what stayed committed and, in plain words, what was stopped.
    expect(cancelled.committed.map((r: any) => r.commandId)).toEqual(running.receipts.map((r: any) => r.commandId));
    expect(cancelled.stopped.length).toBeGreaterThan(0);
    for (const line of cancelled.stopped) expect(internalCodesIn(line)).toEqual([]);

    await sleep(400);
    expect((await owner.api.json("GET", `/v1/runs/${accepted.runId}`)).state).toBe("cancelled");
    expect(JSON.stringify(await transcript())).not.toContain("LATE ANSWER");
    const events = await readSse(await owner.api.get(`/v1/runs/${accepted.runId}/events?follow=false`));
    expect(events.at(-1)).toMatchObject({ event: "run_finished", data: { data: { state: "cancelled" } } });
    // What the owner said before cancelling stays recorded, with its own receipt and undo.
    const kept = await owner.api.json("GET", `/v1/commands/${running.receipts[0].commandId}`);
    expect(kept).toMatchObject({ type: "care.mark_dirty", outcome: "committed" });
    expect(kept.summary).toContain(sock.name);
    // Cancelling again is harmless.
    expect((await owner.api.json("POST", `/v1/runs/${accepted.runId}/cancel`)).run.state).toBe("cancelled");
  });

  it("the transcript is one stream: every message once, with its channel and date, and no reasoning", async () => {
    const page = await owner.api.json("GET", "/v1/conversation/messages?limit=100");
    const messages = page.messages as Record<string, any>[];
    expect(page.total).toBe(messages.length);
    expect(new Set(messages.map((m) => m.messageId)).size).toBe(messages.length);
    const ownerTexts = messages.filter((m) => m.role === "user" && m.text).map((m) => `${m.turnId}:${m.text}`);
    expect(new Set(ownerTexts).size).toBe(ownerTexts.length);
    for (const m of messages) {
      expect(m.channel, m.messageId).toBe("ios");
      expect(Number.isNaN(Date.parse(m.authoredAt))).toBe(false);
      expect(m.forgotten).toBe(false);
      expect((m.parts as { type: string }[]).some((p) => /reasoning/i.test(p.type))).toBe(false);
    }
    const times = messages.map((m) => Date.parse(m.authoredAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // Every assistant message answers a turn the owner started: the assistant never opened a topic itself.
    const ownerTurns = new Set(messages.filter((m) => m.role === "user").map((m) => m.turnId));
    for (const m of messages.filter((x) => x.role === "assistant")) expect(ownerTurns.has(m.turnId)).toBe(true);

    // Paging by the stable cursor returns the same messages, none twice and none missing.
    const paged: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 50; i++) {
      const part: any = await owner.api.json("GET", `/v1/conversation/messages?limit=5${before ? `&before=${encodeURIComponent(before)}` : ""}`);
      paged.unshift(...part.messages.map((m: any) => m.messageId));
      before = part.nextBefore;
      if (!before) break;
    }
    expect(paged).toEqual(messages.map((m) => m.messageId));
    // A message can be opened with its surroundings.
    const middle = messages[Math.floor(messages.length / 2)]!;
    const around = await owner.api.json("GET", `/v1/conversation/messages?around=${encodeURIComponent(middle.messageId)}&limit=5`);
    expect(around.messages.map((m: any) => m.messageId)).toContain(middle.messageId);
    // Another owner's conversation is empty.
    expect(await transcript(stranger)).toEqual([]);
  });

  it("recall finds what was said, quotes it exactly with its date, and warns that talk is not ownership", async () => {
    const recall = await owner.api.json("POST", "/v1/recall/search", { text: "blazer", limit: 10 });
    expect(recall.hits.length).toBeGreaterThan(0);
    const said = (await transcript()).map((m) => m.text as string);
    for (const hit of recall.hits) {
      expect(said.some((text) => text.includes(hit.quote))).toBe(true);
      expect(Number.isNaN(Date.parse(hit.authoredAt))).toBe(false);
      expect(hit.channel).toBe("ios");
    }
    expect(recall.hits.some((h: any) => h.speaker === "owner" && /blazer/i.test(h.quote))).toBe(true);
    expect(recall.watermark).toBeTruthy();
    expect(recall.caveat).toMatch(/does not mean it is owned|not mean/i);
    expect(internalCodesIn(recall.caveat)).toEqual([]);
    // Something never discussed yields no invented hit.
    const nothing = await owner.api.json("POST", "/v1/recall/search", { text: "zeppelin upholstery", limit: 5 });
    expect(nothing.hits).toEqual([]);
    expect((await stranger.api.json("POST", "/v1/recall/search", { text: "blazer", limit: 5 })).hits).toEqual([]);
  });
});

describe("journey 11b: a week of boards with nothing reported produces no status interrogation", () => {
  let quiet: JourneyOwner;

  beforeAll(async () => {
    quiet = await realOwnerAt("Quiet week");
    await enableFakeModel(quiet.owner);
  });

  it("seven days of boards are published and the owner reports nothing: no question, no task, no request appears", async () => {
    const api = quiet.owner.api;
    const boards: any[] = [];
    for (let offset = 0; offset < 7; offset++) boards.push((await publishBoard(quiet.owner, { date: quiet.day(offset) })).board);
    // The owner picks one outfit on the first day and never says whether it was worn.
    const first = boards[0];
    await exec(api, "board.select", { boardId: first.boardId, optionId: first.options[0].optionId }, { expectedVersions: { [`board:${first.boardId}`]: first.revision } });
    await runCron();
    await runCron();

    const recovery = await api.json("GET", "/v1/recovery");
    expect(recovery.pending.runsNeedingInput).toBe(0);
    // The assistant did not open the conversation to ask what was worn or washed.
    const page = await api.json("GET", "/v1/conversation/messages?limit=100");
    expect(page.messages.filter((m: any) => m.role === "assistant")).toEqual([]);
    expect(page.messages.filter((m: any) => /\?/.test(m.text ?? ""))).toEqual([]);
    expect((await api.json("GET", "/v1/proposals")).pending).toBe(0);
    // The chosen outfit stayed an intention: nothing was recorded as worn on any of the days.
    for (let offset = 0; offset < 7; offset++) expect((await api.json("GET", `/v1/days/${quiet.day(offset)}`)).garments).toEqual([]);

    // No board asks the owner to confirm anything, and the chosen pieces are not locked out of later days.
    for (const board of boards) {
      const today = await api.json("GET", `/v1/today?date=${board.localDate}`);
      const texts = [today.board.dayLine, today.board.notice, ...(today.board.changes ?? []), ...today.board.options.map((o: any) => o.qualification)].filter((t: unknown): t is string => typeof t === "string");
      for (const text of texts) expect(text).not.toMatch(/did you wear|please confirm|confirm (what|whether)|have you washed/i);
      expect(today.board.options.length).toBeGreaterThanOrEqual(3);
    }
    const chosen = new Set<string>(first.options[0].garments.map((g: any) => g.garmentId));
    const availability = (await wholeWardrobe(api)).items.filter((i) => chosen.has(i.garment.garmentId));
    expect(availability.length).toBe(chosen.size);
    for (const item of availability) expect(item.availability!.hardExcluded, item.garment.name).toBe(false);
  });
});
