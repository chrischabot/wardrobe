/**
 * Journey 09: three unsolicited comfort remarks ("these shoes hurt after an hour", "too warm on the
 * train", "this collar scratches") and what they change.
 *
 * Specification covered (requirements/garderobe-replacement-design.md):
 *  - section 10 "Optional comfort feedback": brief feedback from the item, stored as said; no post-wear
 *    questionnaire or rating prompt; linked only to the garment, wearing date, activity, layer and
 *    conditions that are actually known, missing context stays unknown; a direct statement of discomfort
 *    is applied immediately to the relevant recommendation context; scope stays visible (an overheated
 *    commute does not prove a garment unsuitable elsewhere); pain cannot be outweighed by styling scores.
 *  - section 7 "Mandatory context" (dated comfort constraints are part of every recommendation).
 *  - section 3 "Laundry, wear follow-through, and undo" (receipts, undo).
 *  - section 17 acceptance row "Comfort": one unsolicited report affects the relevant context without a
 *    questionnaire, universal ban, or unsupported medical claim; data-model row "Deadlines and feedback".
 *
 * Everything inside the Worker is real (HTTP API, MCP server, D1 ledger, the daily service's composer,
 * the owner's real profile and 127-garment inventory; the remarks are about the owner's own garments and
 * are the owner's own acts in this journey). Test doubles relied on, all at the network boundary:
 *  - TEST DOUBLE weather (Open-Meteo wire shape) scripted mild for the fictional home place;
 *  - test-signed sign-in; the SDK MCP client over in-process fetch.
 * No fake model is used (feedback given inside a conversation turn is not covered here), no calendar
 * double: boards say plainly that Calendar is not connected.
 *
 * Tests named "DEFECT: ..." state what the specification requires and are left failing where the
 * product does something else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defect } from "../src/defect.ts";
import { connectMcp, provisionOwner, publishBoard, type McpConnection, type TestOwner } from "@garderobe/worker/testing";
import { boardTexts, exec, internalCodesIn, mcpCommand, realOwnerAt, refused, type JourneyOwner } from "../src/world.ts";

type Line = { garmentId: string; role: string; name: string };
type Option = { optionId: string; garments: Line[]; footwearAlternatives: Line[] };

/** Every shoe an option puts in front of the owner: the one in the outfit and any alternative at the door. */
const shoesOf = (option: Option): Line[] => [...option.garments.filter((g) => g.role === "footwear"), ...option.footwearAlternatives];

describe("Journey 09: optional comfort feedback from the item", () => {
  let j: JourneyOwner;
  let stranger: TestOwner;
  let mcp: McpConnection;

  let rulesBefore = "";
  let directionsBefore = "";
  let styleRevisionBefore = -1;

  let leadOption: Option;
  let shoe: Line;
  let jacket: Line;
  let shirt: Line;
  let painReceipt: Awaited<ReturnType<typeof exec>>;
  let painId = "";
  let warmId = "";
  let collarId = "";

  const api = () => j.owner.api;
  const feedback = async (query = ""): Promise<any[]> => (await api().json("GET", `/v1/feedback${query}`)).feedback;
  const one = async (feedbackId: string) => (await feedback()).find((f) => f.feedbackId === feedbackId);
  const item = (garmentId: string) => api().json("GET", `/v1/items/${garmentId}`);
  const boardFor = async (date: string) => (await api().json("GET", `/v1/today?date=${date}`)).board;

  beforeAll(async () => {
    j = await realOwnerAt("Comfort journey home");
    stranger = await provisionOwner();
    const style = await api().json("GET", "/v1/style");
    rulesBefore = JSON.stringify(style.rules);
    directionsBefore = JSON.stringify(style.directions);
    styleRevisionBefore = style.styleRevision;
    mcp = await connectMcp(j.owner, { write: true, clientName: "Connected assistant (journey 09)" });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("tomorrow's board is already prepared, with more than one pair of sneakers on it", async () => {
    const prepared = await publishBoard(j.owner, { date: j.day(1), count: 5 });
    expect(prepared.state).toBe("completed");
    expect(prepared.board.options).toHaveLength(5);
    leadOption = prepared.board.options[0];
    shoe = leadOption.garments.find((g) => g.role === "footwear")!;
    jacket = leadOption.garments.find((g) => g.role === "outer")!;
    shirt = leadOption.garments.find((g) => g.role === "top")!;
    expect(shoe && jacket && shirt).toBeTruthy();
    const pairs = new Set((prepared.board.options as Option[]).flatMap(shoesOf).map((s) => s.garmentId));
    expect(pairs.size).toBeGreaterThan(1);
    expect(await feedback()).toEqual([]);
  });

  it('"these shoes hurt after an hour" is taken from the item as said, with a plain receipt and nothing asked', async () => {
    painReceipt = await exec(api(), "feedback.record", { text: "these shoes hurt after an hour", kind: "pain", garmentIds: [shoe.garmentId] });
    painId = painReceipt.result.feedbackId;
    expect(painReceipt.outcome).toBe("committed");
    expect(painReceipt.summary).toBe(`Noted: ${shoe.name} was painful. Applied to that context only`);
    // A receipt, not a question; no internal codes; no diagnosis the owner did not state.
    expect(painReceipt.summary).not.toContain("?");
    expect(internalCodesIn(painReceipt.summary)).toEqual([]);
    expect(painReceipt.summary).not.toMatch(/injur|medical|diagnos|doctor|blister|condition|treat/i);
    expect(painReceipt.undo.available).toBe(true);
    expect(painReceipt.repairs).toEqual([]);
    expect(painReceipt.effects).toEqual([]);
    expect(painReceipt.result).toMatchObject({ garmentIds: [shoe.garmentId], pain: true, scope: null });

    // Stored verbatim, linked to the shoe and to nothing that was not said.
    expect(await feedback()).toEqual([
      { feedbackId: painId, text: "these shoes hurt after an hour", kind: "pain", pain: true, garmentIds: [shoe.garmentId], wearingDate: null, activity: null, layer: null, conditions: {}, scope: null, status: "active", createdAt: painReceipt.occurredAt },
    ]);
  });

  it("no questionnaire follows: nothing waits for the owner and no conversation was started about it", async () => {
    expect(await api().json("GET", "/v1/proposals")).toMatchObject({ proposals: [], pending: 0 });
    expect(await api().json("GET", "/v1/conversation/messages")).toMatchObject({ messages: [], total: 0 });
    const today = await api().json("GET", "/v1/today");
    expect(today.runId).toBeNull();
    for (const text of boardTexts(await boardFor(j.day(1)))) expect(text).not.toContain("?");
  });

  it("pain is not outweighed by styling: the next board composed leaves those shoes out while other sneakers are there, without banning them", async () => {
    const next = await publishBoard(j.owner, { date: j.day(2), count: 5 });
    expect(next.board.options).toHaveLength(5);
    for (const option of next.board.options as Option[]) {
      const offered = shoesOf(option);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.map((s) => s.name)).not.toContain(shoe.name);
    }
    for (const text of boardTexts(next.board)) expect(internalCodesIn(text), text).toEqual([]);

    // One remark is not a universal ban and not a restriction: the shoes are still his, available, and unrestricted.
    const read = await item(shoe.garmentId);
    expect(read.detail.totalOwnedUnits).toBeGreaterThan(0);
    expect(read.detail.restrictions).toEqual([]);
    expect(read.availability.status).toBe("available");
    expect(read.availability.hardExcluded).toBe(false);
  });

  defect("D09-1", "the board already prepared for tomorrow stops offering the shoes he just said hurt", async () => {
    const tomorrow = await boardFor(j.day(1));
    const stillOffered = (tomorrow.options as Option[]).filter((o) => shoesOf(o).some((s) => s.garmentId === shoe.garmentId)).length;
    expect(stillOffered).toBe(0);
  });

  it('"too warm on the train" keeps the context he actually gave: the day, the activity, the layer, and its scope', async () => {
    const receipt = await exec(api(), "feedback.record", {
      text: "too warm on the train",
      kind: "too_warm",
      garmentIds: [jacket.garmentId],
      wearingDate: j.day(0),
      activity: "train commute",
      layer: "outer",
      conditions: { where: "on the train" },
      scope: "commute by train",
    });
    warmId = receipt.result.feedbackId;
    expect(receipt.summary).toBe(`Noted: ${jacket.name} was too warm (commute by train). Applied to that context only`);
    expect(receipt.summary).not.toContain("?");
    expect(internalCodesIn(receipt.summary)).toEqual([]);
    expect(await one(warmId)).toMatchObject({
      text: "too warm on the train",
      kind: "too_warm",
      pain: false,
      garmentIds: [jacket.garmentId],
      wearingDate: j.day(0),
      activity: "train commute",
      layer: "outer",
      conditions: { where: "on the train" },
      scope: "commute by train",
      status: "active",
    });
  });

  it("an overheated commute does not make the jacket unsuitable everywhere: no ban, no standing rule, and tomorrow's outfit with it stands", async () => {
    const read = await item(jacket.garmentId);
    expect(read.detail.restrictions).toEqual([]);
    expect(read.availability.hardExcluded).toBe(false);
    expect(read.availability.status).not.toBe("unavailable");

    // No remark was turned into a standing rule or direction, and the profile was not touched.
    const style = await api().json("GET", "/v1/style");
    expect(JSON.stringify(style.rules)).toBe(rulesBefore);
    expect(JSON.stringify(style.directions)).toBe(directionsBefore);
    expect(style.styleRevision).toBe(styleRevisionBefore);

    // The outfit with that jacket is still on tomorrow's board: nothing was withdrawn because of one warm commute.
    const tomorrow = await boardFor(j.day(1));
    const withJacket = (tomorrow.options as Option[]).find((o) => o.optionId === leadOption.optionId);
    expect(withJacket?.garments.map((g) => g.garmentId)).toContain(jacket.garmentId);
    expect(tomorrow.validity).not.toBe("degraded");
  });

  it('"this collar scratches" has no further context, and none is invented or asked for; feedback is listed per item', async () => {
    const receipt = await exec(api(), "feedback.record", { text: "this collar scratches", kind: "scratchy", garmentIds: [shirt.garmentId] });
    collarId = receipt.result.feedbackId;
    expect(receipt.summary).toBe(`Noted: ${shirt.name} was scratchy. Applied to that context only`);
    expect(receipt.summary).not.toContain("?");
    expect(await one(collarId)).toMatchObject({ text: "this collar scratches", kind: "scratchy", pain: false, garmentIds: [shirt.garmentId], wearingDate: null, activity: null, layer: null, conditions: {}, scope: null });
    expect(await api().json("GET", "/v1/proposals")).toMatchObject({ pending: 0 });
    expect(await api().json("GET", "/v1/conversation/messages")).toMatchObject({ total: 0 });

    // Newest first in the whole list; each item shows only its own remarks.
    expect((await feedback()).map((f) => f.text)).toEqual(["this collar scratches", "too warm on the train", "these shoes hurt after an hour"]);
    expect((await feedback(`?garmentId=${shirt.garmentId}`)).map((f) => f.feedbackId)).toEqual([collarId]);
    expect((await feedback(`?garmentId=${shoe.garmentId}`)).map((f) => f.feedbackId)).toEqual([painId]);
    expect((await feedback(`?garmentId=${jacket.garmentId}`)).map((f) => f.feedbackId)).toEqual([warmId]);
    // A scratchy collar is discomfort, not a ban: the shirt is as available as before.
    const read = await item(shirt.garmentId);
    expect(read.detail.restrictions).toEqual([]);
    expect(read.availability.hardExcluded).toBe(false);
  });

  it("a remark relayed by a connected assistant is stored in the owner's words, about no garment when none was named", async () => {
    // Whether this runs at once or waits for the owner is the server's answer; the stored remark is the same.
    const outcome = await mcpCommand(j.owner, mcp, "feedback.record", { text: "a bit cold at my desk this afternoon", kind: "too_cold", activity: "desk work" });
    expect(outcome.receipt.outcome).toBe("committed");
    expect(outcome.receipt.summary).toBe("Noted: what you wore was too cold (desk work). Applied to that context only");
    expect(outcome.receipt.summary).not.toContain("?");
    if (outcome.proposal) expect(String(outcome.proposal.summary)).toContain("a bit cold at my desk this afternoon");
    expect(await one(outcome.receipt.result.feedbackId)).toMatchObject({ text: "a bit cold at my desk this afternoon", kind: "too_cold", pain: false, garmentIds: [], wearingDate: null, activity: "desk work", layer: null, scope: null });
    expect(await feedback()).toHaveLength(4);
  });

  it("a remark about something he does not own is refused and nothing is written; a retransmission is stored once", async () => {
    const unknown = await refused(await api().command("feedback.record", { text: "this one itches", kind: "scratchy", garmentIds: ["gmt_000000000000000000000000"] }));
    expect(unknown.status).toBe(404);
    expect(unknown.error.code).toBe("not_found");
    expect(unknown.error.message).toMatch(/nothing was written/);
    expect(await feedback()).toHaveLength(4);

    const key = `feedback-${crypto.randomUUID()}`;
    const first = await exec(api(), "feedback.record", { text: "the waistband digs in when I sit", kind: "tight" }, { idempotencyKey: key });
    const again = await exec(api(), "feedback.record", { text: "the waistband digs in when I sit", kind: "tight" }, { idempotencyKey: key });
    expect(again.commandId).toBe(first.commandId);
    expect(again.replayed).toBe(true);
    expect((await feedback()).filter((f) => f.text === "the waistband digs in when I sit")).toHaveLength(1);
  });

  it("a remark can be withdrawn: it leaves the list and the item, and withdrawing twice changes nothing", async () => {
    const withdrawn = await exec(api(), "feedback.retract", { feedbackId: collarId, reason: "It was the new detergent" });
    expect(withdrawn.outcome).toBe("committed");
    expect(withdrawn.summary).toBe("Comfort note withdrawn; it no longer affects suggestions");
    expect(await one(collarId)).toBeUndefined();
    expect(await feedback(`?garmentId=${shirt.garmentId}`)).toEqual([]);
    const again = await exec(api(), "feedback.retract", { feedbackId: collarId });
    expect(again.outcome).toBe("noop");
    expect(again.summary).toMatch(/already withdrawn/);
    // The other remarks are untouched.
    expect((await one(painId)).status).toBe("active");
    expect((await one(warmId)).status).toBe("active");
  });

  it("Undo of the pain report withdraws it, and the shoes can lead a board again", async () => {
    const undone = await exec(api(), "command.undo", { commandId: painReceipt.commandId });
    expect(undone.outcome).toBe("committed");
    expect(undone.summary).toMatch(/Comfort note withdrawn/);
    expect(undone.result.undoneCommandId).toBe(painReceipt.commandId);
    expect(await one(painId)).toBeUndefined();
    expect(await feedback(`?garmentId=${shoe.garmentId}`)).toEqual([]);
    expect((await api().json("GET", `/v1/commands/${painReceipt.commandId}`)).commandId).toBe(painReceipt.commandId);

    const later = await publishBoard(j.owner, { date: j.day(3), count: 5 });
    const offering = (later.board.options as Option[]).filter((o) => shoesOf(o).some((s) => s.garmentId === shoe.garmentId)).length;
    expect(offering).toBeGreaterThan(0);
  });

  it("another owner sees none of the remarks and cannot attach one to his garments", async () => {
    expect((await stranger.api.json("GET", "/v1/feedback")).feedback).toEqual([]);
    expect((await stranger.api.json("GET", `/v1/feedback?garmentId=${jacket.garmentId}`)).feedback).toEqual([]);
    const attach = await refused(await stranger.api.command("feedback.record", { text: "not mine", kind: "tight", garmentIds: [jacket.garmentId] }));
    expect(attach.status).toBe(404);
    const withdraw = await refused(await stranger.api.command("feedback.retract", { feedbackId: warmId }));
    expect(withdraw.status).toBe(404);
    expect((await one(warmId)).status).toBe("active");
  });
});
