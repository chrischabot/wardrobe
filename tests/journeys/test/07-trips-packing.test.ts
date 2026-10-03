/**
 * Journey 07: "Three days in Paris, one dinner, carry-on only".
 *
 * Specification covered (requirements/garderobe-replacement-design.md):
 *  - section 10 "Trip and packing mode": a trip records dates, destination, timezone, occasions, luggage
 *    and laundry; the proposal uses destination weather and deliberate reuse under a trip-only repeat
 *    exception; proposed packing is distinct from packed quantities; Packed is an owner observation;
 *    destination recommendations use the packed subset only; a home laundry reset does not wash a
 *    suitcase; Unpacked returns quantities home without declaring them clean; a wash report does.
 *  - section 5 "Quantity and laundry" (scheduled assumptions cannot release a garment from a trip).
 *  - section 3 "Laundry, wear follow-through, and undo" (receipts, undo restores state).
 *  - section 17 acceptance row "Packing"; data-model row "Trips and packing".
 *
 * Everything inside the Worker is real (HTTP API, MCP server, D1 ledger, the owner's real profile and
 * 127-garment inventory). Test doubles relied on, all at the network boundary:
 *  - TEST DOUBLE weather (Open-Meteo wire shape) scripted for a fictional home place and a fictional
 *    "Paris" test place (src/outbound.ts);
 *  - test-signed sign-in (a Cloudflare Access style assertion signed with the test run's key);
 *  - the MCP client is the SDK client over in-process fetch, authorised through the real consent flow.
 * No fake model and no calendar double are used here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcp, provisionOwner, toolResult, type McpConnection, type TestOwner } from "@garderobe/worker/testing";
import { boardTexts, exec, internalCodesIn, mcpCommand, newPlace, quantityIn, realOwnerAt, refused, scriptWeather, wholeWardrobe, type JourneyOwner, type McpCommandOutcome, type TestPlace } from "../src/world.ts";

type Slot = { role: string; garmentId: string };
type DayPlan = { localDate: string; segment: "day" | "evening"; occasion: string | null; slots: Slot[]; reason: string };
type Proposal = { tripId: string; revision: number; items: { garmentId: string; name: string; role: string; quantity: number }[]; days: DayPlan[]; repeatExceptionForTrip: boolean; weather: { localDate: string; label: string; freshness: string; line: string }[]; notes: string[] };
type Packed = { garmentId: string; name: string; clean: number; worn: number };

/** Roles whose units go through laundry in the owner's wardrobe (a wear makes the packed unit worn). */
const REUSED_ROLES = ["bottom", "outer", "footwear", "belt"];

describe("Journey 07: three days in Paris, one dinner, carry-on only", () => {
  let j: JourneyOwner;
  let stranger: TestOwner;
  let paris: TestPlace;
  let mcp: McpConnection;

  /** Clean units at home before the journey touched anything. */
  const cleanBefore = new Map<string, number>();
  let varietyBefore = "";
  let varietyRulesBefore = "";
  let styleRevisionBefore = -1;

  let tripId = "";
  let firstProposal: Proposal;
  let proposal: Proposal;
  let mcpUpdate: McpCommandOutcome;
  let packReceipt: Awaited<ReturnType<typeof exec>>;
  let unpackReceipt: Awaited<ReturnType<typeof exec>>;
  let homeShirt: { garmentId: string; name: string };
  let wornTop = "";
  let wornBottom = "";
  let unwornPackedTop = "";

  const api = () => j.owner.api;
  const trip = () => api().json("GET", `/v1/trips/${tripId}`);
  const item = (garmentId: string) => api().json("GET", `/v1/items/${garmentId}`);
  const packedOf = async (id = tripId): Promise<Map<string, Packed>> => new Map(((await api().json("GET", `/v1/trips/${id}`)).packed as Packed[]).map((p) => [p.garmentId, p]));
  const tripBoard = async (date: string) => (await api().json("GET", `/v1/today?date=${date}&scope=${encodeURIComponent(`trip:${tripId}`)}`)).board;
  const plan = (p: Proposal, date: string, segment: "day" | "evening" = "day") => p.days.find((d) => d.localDate === date && d.segment === segment)!;
  const slot = (p: DayPlan, role: string) => p.slots.find((s) => s.role === role)?.garmentId ?? "";
  const varietyRules = (style: any) => JSON.stringify((style.rules as any[]).filter((r) => String(r.key ?? r.ruleKey ?? "").startsWith("variety.")));

  beforeAll(async () => {
    j = await realOwnerAt("Home for the Paris trip");
    stranger = await provisionOwner();
    // A second fictional place stands for the destination; its forecast differs from home (19 C peak at home).
    paris = await newPlace("Paris", "Europe/Paris");
    const days: Record<string, { morningC: number; peakC: number; eveningC: number }> = {};
    for (let i = -1; i <= 5; i++) days[j.day(i)] = { morningC: 13, peakC: 22, eveningC: 17 };
    await scriptWeather(paris, days);

    for (const i of (await wholeWardrobe(api())).items) cleanBefore.set(i.garment.garmentId, quantityIn(i, "clean"));
    const settings = await api().json("GET", "/v1/settings");
    varietyBefore = JSON.stringify(settings.settings.variety);
    const style = await api().json("GET", "/v1/style");
    varietyRulesBefore = varietyRules(style);
    styleRevisionBefore = style.styleRevision;
    mcp = await connectMcp(j.owner, { write: true, clientName: "Connected assistant (journey 07)" });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("records the trip from one ordinary request: dates, destination and its timezone, the dinner, the luggage", async () => {
    const receipt = await exec(api(), "trip.create", {
      name: "Paris",
      departsOn: j.day(0),
      returnsOn: j.day(2),
      destinations: [{ label: paris.label, latitude: paris.latitude, longitude: paris.longitude, timezone: paris.timezone, from: j.day(0), to: j.day(2) }],
      occasions: [{ localDate: j.day(2), label: "Dinner", register: "smart", segment: "evening" }],
      luggage: { label: "carry-on" },
      source: { kind: "owner_statement", note: "Three days in Paris, one dinner, carry-on only." },
    });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toContain("Paris");
    expect(receipt.summary).toMatch(/nothing is packed/i);
    expect(internalCodesIn(receipt.summary)).toEqual([]);
    expect(receipt.undo.available).toBe(true);
    tripId = receipt.result.tripId;
    expect(receipt.affected).toContainEqual({ kind: "trip", id: tripId, version: 1 });

    const read = await trip();
    expect(read).toMatchObject({ tripId, name: "Paris", departsOn: j.day(0), returnsOn: j.day(2), status: "planned", luggage: { label: "carry-on", maxPieces: null } });
    expect(read.destinations).toEqual([{ label: paris.label, latitude: paris.latitude, longitude: paris.longitude, timezone: "Europe/Paris", from: j.day(0), to: j.day(2) }]);
    expect(read.occasions).toEqual([{ localDate: j.day(2), label: "Dinner", register: "smart", segment: "evening" }]);
    // Honest state: nothing is proposed and nothing is packed yet.
    expect(read.packed).toEqual([]);
    expect(read.proposal).toBeNull();
    expect((await api().json("GET", "/v1/trips")).trips.map((t: any) => t.tripId)).toEqual([tripId]);
  });

  it("proposes a compact list for the destination's weather, with deliberate reuse under a trip-only repeat exception", async () => {
    firstProposal = await api().json("POST", `/v1/trips/${tripId}/packing-proposal`, { clientRequestId: `pack-${crypto.randomUUID()}` });
    const p = firstProposal;
    expect(p.tripId).toBe(tripId);
    expect(p.revision).toBe(1);

    // Destination weather, not home weather (home is scripted at a 19 C peak, the destination at 22 C).
    expect(p.weather.map((w) => w.localDate)).toEqual([j.day(0), j.day(1), j.day(2)]);
    for (const w of p.weather) {
      expect(w.label).toBe(paris.label);
      expect(w.freshness).toBe("fresh");
      expect(w.line).toContain("22 °C");
      expect(w.line).not.toContain("19 °C");
    }

    // One outfit per day and one for the dinner; each is a complete outfit with socks (the owner's rule).
    expect(p.days.map((d) => `${d.localDate}:${d.segment}`)).toEqual([`${j.day(0)}:day`, `${j.day(1)}:day`, `${j.day(2)}:day`, `${j.day(2)}:evening`]);
    expect(plan(p, j.day(2), "evening").occasion).toBe("Dinner");
    for (const d of p.days) for (const role of ["top", "bottom", "socks", "footwear"]) expect(slot(d, role), `${d.localDate} ${d.segment} has no ${role}`).not.toBe("");

    // Only garments the owner actually owns, by the name on the record.
    const owned = new Map((await wholeWardrobe(api())).items.map((i) => [i.garment.garmentId, i]));
    for (const i of p.items) {
      expect(owned.get(i.garmentId)?.garment.name).toBe(i.name);
      expect(i.quantity).toBeLessThanOrEqual(cleanBefore.get(i.garmentId) ?? 0);
    }
    const planned = new Set(p.days.flatMap((d) => d.slots.map((s) => s.garmentId)));
    expect([...planned].sort()).toEqual(p.items.map((i) => i.garmentId).sort());

    // Compact, by deliberate reuse: fewer pieces than slots worn, and at least one piece worn on two different days.
    const slotsWorn = p.days.reduce((n, d) => n + d.slots.length, 0);
    const pieces = p.items.reduce((n, i) => n + i.quantity, 0);
    expect(pieces).toBeLessThan(slotsWorn);
    const reusedAcrossDays = p.items.filter((i) => REUSED_ROLES.includes(i.role) && new Set(p.days.filter((d) => d.slots.some((s) => s.garmentId === i.garmentId)).map((d) => d.localDate)).size >= 2);
    expect(reusedAcrossDays.length).toBeGreaterThan(0);
    expect(p.repeatExceptionForTrip).toBe(true);
    expect(p.notes.join(" ")).toMatch(/this trip only/i);

    for (const text of [...p.notes, ...p.weather.map((w) => w.line), ...p.days.map((d) => d.reason)]) expect(internalCodesIn(text), text).toEqual([]);
  });

  it("proposing packs nothing: the proposal is on the trip, the suitcase is empty and home stock is unchanged", async () => {
    const read = await trip();
    expect(read.proposal.revision).toBe(1);
    expect(read.proposal.items).toEqual(firstProposal.items);
    expect(read.packed).toEqual([]);
    const now = new Map((await wholeWardrobe(api())).items.map((i) => [i.garment.garmentId, i]));
    for (const i of firstProposal.items) {
      expect(quantityIn(now.get(i.garmentId)!, "trip")).toBe(0);
      expect(quantityIn(now.get(i.garmentId)!, "clean")).toBe(cleanBefore.get(i.garmentId));
    }
  });

  it("a connected assistant reads the trip over MCP and adds a laundry opportunity; a new proposal treats it as an estimate", async () => {
    const seen = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "trips" } }));
    expect(seen.ok).toBe(true);
    expect(seen.data.complete).toBe(true);
    expect(seen.data.total).toBe(1);
    const viaApi = await trip();
    expect(seen.data.data.trips).toEqual([viaApi]);

    // Whether the assistant's change runs at once or waits for the owner is the server's answer; the state must be the same.
    mcpUpdate = await mcpCommand(j.owner, mcp, "trip.update", { tripId, changes: { laundry: [{ localDate: j.day(1), note: "hotel laundry service" }] } }, { expectRoute: "owner_confirmed" });
    expect(mcpUpdate.receipt.outcome).toBe("committed");
    expect(mcpUpdate.receipt.type).toBe("trip.update");
    expect(internalCodesIn(mcpUpdate.receipt.summary)).toEqual([]);
    const updated = await trip();
    expect(updated.version).toBe(viaApi.version + 1);
    expect(updated.laundry).toEqual([{ localDate: j.day(1), note: "hotel laundry service" }]);
    expect(updated.packed).toEqual([]);

    proposal = await api().json("POST", `/v1/trips/${tripId}/packing-proposal`, { clientRequestId: `pack-${crypto.randomUUID()}` });
    expect(proposal.revision).toBe(2);
    // A washing opportunity is an estimate until a wash is observed; the list does not count on it.
    expect(proposal.notes.join(" ")).toMatch(/laundry opportunities.*estimates/i);
    expect(proposal.repeatExceptionForTrip).toBe(true);
    const after = await trip();
    expect(after.proposal.revision).toBe(2);
    expect(after.packed).toEqual([]);
  });

  it("the owner's confirmation request for the assistant's trip change is in plain words, without internal identifiers", () => {
    // Was defect D07-1 (identifiers and raw fields); fixed by the API thread in 5db4fd87.
    // Only meaningful when the server asked the owner to confirm; a change that ran at once showed the owner nothing.
    const summary = mcpUpdate.proposal ? String(mcpUpdate.proposal.summary) : "";
    expect(internalCodesIn(summary)).toEqual([]);
  });

  it("Packed is the owner's observation: the proposed quantities move from home to the trip", async () => {
    packReceipt = await exec(api(), "stock.pack", { tripId, items: proposal.items.map((i) => ({ garmentId: i.garmentId, quantity: i.quantity })) });
    expect(packReceipt.outcome).toBe("committed");
    expect(packReceipt.undo.available).toBe(true);
    expect(packReceipt.repairs).toEqual([]);
    expect(packReceipt.affected.map((a) => a.id).sort()).toEqual(proposal.items.map((i) => i.garmentId).sort());

    const packed = await packedOf();
    expect(packed.size).toBe(proposal.items.length);
    for (const i of proposal.items) expect(packed.get(i.garmentId)).toEqual({ garmentId: i.garmentId, name: i.name, clean: i.quantity, worn: 0 });

    const now = new Map((await wholeWardrobe(api())).items.map((w) => [w.garment.garmentId, w]));
    for (const i of proposal.items) {
      expect(quantityIn(now.get(i.garmentId)!, "trip")).toBe(i.quantity);
      expect(quantityIn(now.get(i.garmentId)!, "clean")).toBe((cleanBefore.get(i.garmentId) ?? 0) - i.quantity);
    }
    const sample = await item(proposal.items[0]!.garmentId);
    expect(sample.detail.balances).toContainEqual({ bucket: "trip", ref: tripId, quantity: proposal.items[0]!.quantity });
    // The proposal is still only the proposal.
    expect((await trip()).proposal.revision).toBe(2);
  });

  it("Undo of Packed puts everything back at home; packing again is a fresh observation", async () => {
    const undone = await exec(api(), "command.undo", { commandId: packReceipt.commandId });
    expect(undone.outcome).toBe("committed");
    expect(undone.result.undoneCommandId).toBe(packReceipt.commandId);
    expect((await trip()).packed).toEqual([]);
    const now = new Map((await wholeWardrobe(api())).items.map((w) => [w.garment.garmentId, w]));
    for (const i of proposal.items) {
      expect(quantityIn(now.get(i.garmentId)!, "trip")).toBe(0);
      expect(quantityIn(now.get(i.garmentId)!, "clean")).toBe(cleanBefore.get(i.garmentId));
    }

    packReceipt = await exec(api(), "stock.pack", { tripId, items: proposal.items.map((i) => ({ garmentId: i.garmentId, quantity: i.quantity })) });
    expect(packReceipt.outcome).toBe("committed");
    expect((await packedOf()).size).toBe(proposal.items.length);
  });

  it("a destination board offers only what is in the suitcase: a shirt left at home is not published", async () => {
    const packedIds = new Set(proposal.items.map((i) => i.garmentId));
    const home = (await wholeWardrobe(api())).items.find((i) => i.garment.roles.includes("top") && !packedIds.has(i.garment.garmentId) && quantityIn(i, "clean") > 0)!;
    homeShirt = { garmentId: home.garment.garmentId, name: home.garment.name };
    const dayTwo = plan(proposal, j.day(1));
    const withHomeShirt = dayTwo.slots.map((s) => (s.role === "top" ? { role: "top", garmentId: homeShirt.garmentId } : s));

    // The owner puts two outfits on the trip's board for tomorrow: the planned one, and one with a shirt that stayed at home.
    const published = await exec(api(), "board.publish", {
      localDate: j.day(1),
      scope: `trip:${tripId}`,
      requestedCount: 2,
      options: [
        { slots: dayTwo.slots, reason: "Planned for the second day in Paris." },
        { slots: withHomeShirt, reason: "The same with a shirt from the wardrobe at home." },
      ],
    });
    expect(published.outcome).toBe("committed");
    expect(published.result.scope).toBe(`trip:${tripId}`);
    expect(published.result.offered).toBe(1);
    expect(published.result.dropped).toHaveLength(1);
    expect(String(published.result.dropped[0].violations.join(" "))).toContain(`${homeShirt.name} has no clean packed unit on this trip`);
    expect(internalCodesIn(published.summary)).toEqual([]);

    const board = await tripBoard(j.day(1));
    expect(board.scope).toBe(`trip:${tripId}`);
    expect(board.localDate).toBe(j.day(1));
    expect(board.timezone).toBe("Europe/Paris");
    expect(board.weatherLine).toContain("22 °C");
    // The planned outfit is there; the service may add a second one, but only ever from the suitcase.
    expect(board.options.length).toBeGreaterThanOrEqual(1);
    expect((board.options as any[]).some((o) => dayTwo.slots.every((s) => o.garments.some((g: any) => g.garmentId === s.garmentId)))).toBe(true);
    const onBoard = (board.options as any[]).flatMap((o) => [...o.garments, ...o.footwearAlternatives]);
    expect(onBoard.map((line: any) => line.garmentId)).not.toContain(homeShirt.garmentId);
    for (const line of onBoard) expect(packedIds.has(line.garmentId), `${line.name} is not in the suitcase`).toBe(true);
    for (const text of boardTexts(board)) expect(internalCodesIn(text), text).toEqual([]);

    // The trip board is its own board: nothing was published as the home board for that day.
    expect((await api().json("GET", `/v1/today?date=${j.day(1)}`)).board).toBeNull();
  });

  it("asking for outfits for a day away on the trip offers the packed subset, never clothes left at home", async () => {
    // Was defect D07-2 (home stock was offered); fixed by the daily service in cadc3aeb.
    // The only way to ask for recommendations is this route; the owner is in Paris on that day with a packed suitcase.
    const packedIds = new Set(proposal.items.map((i) => i.garmentId));
    const answer = await api().json("POST", "/v1/recommendations", { clientRequestId: `trip-day-${crypto.randomUUID()}`, date: j.day(1), mode: "preview", count: 3 });
    const leftAtHome = (answer.options as any[]).flatMap((o) => [...o.garments, ...o.footwearAlternatives]).filter((line: any) => !packedIds.has(line.garmentId)).map((line: any) => line.name);
    expect(leftAtHome).toEqual([]);
  });

  it("wearing on the trip uses the packed units: they become worn in the suitcase, and home stock is untouched", async () => {
    const dayOne = plan(proposal, j.day(0));
    wornTop = slot(dayOne, "top");
    wornBottom = slot(dayOne, "bottom");
    const socks = slot(dayOne, "socks");
    const shoes = slot(dayOne, "footwear");
    const socksPacked = proposal.items.find((i) => i.garmentId === socks)!.quantity;

    const receipt = await exec(api(), "wear.record", { wearingDate: j.day(0), garmentIds: [wornTop, wornBottom, socks, shoes], tripId });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.result.counted.sort()).toEqual([wornTop, wornBottom, socks, shoes].sort());
    // Any accounting repair around the observation is a plain statement about the trip board, never a question.
    for (const repair of receipt.repairs) {
      expect(repair).toMatch(/^Board for /);
      expect(repair).not.toContain("?");
      expect(internalCodesIn(repair), repair).toEqual([]);
    }
    expect(receipt.undo.available).toBe(true);
    expect(internalCodesIn(receipt.summary)).toEqual([]);

    const packed = await packedOf();
    expect(packed.get(wornTop)).toMatchObject({ clean: 0, worn: 1 });
    expect(packed.get(wornBottom)).toMatchObject({ clean: 0, worn: 1 });
    expect(packed.get(socks)).toMatchObject({ clean: socksPacked - 1, worn: 1 });
    // Shoes are never laundered: a wear gives them no laundry state.
    expect(packed.get(shoes)).toMatchObject({ clean: 1, worn: 0 });

    const top = await item(wornTop);
    expect(top.detail.recordedWearCount).toBe(1);
    expect(quantityIn(top.detail, "clean")).toBe(0);
    expect(quantityIn(top.detail, "dirty")).toBe(0);
    expect(quantityIn(top.detail, "trip")).toBe(1);

    // Whatever the board for tomorrow now shows, it still shows nothing from home.
    const packedIds = new Set(proposal.items.map((i) => i.garmentId));
    const board = await tripBoard(j.day(1));
    for (const option of board.options) for (const line of [...option.garments, ...option.footwearAlternatives]) expect(packedIds.has(line.garmentId), `${line.name} is not in the suitcase`).toBe(true);
    for (const text of boardTexts(board)) expect(internalCodesIn(text), text).toEqual([]);
  });

  it("the reuse the proposal planned is still offered at the destination after the first day was worn", async () => {
    // Was defect D07-3 (the planned reuse was withdrawn); fixed by the daily service in cadc3aeb.
    // The proposal deliberately plans a piece again on the second day (the trip's repeat exception).
    const dayTwo = plan(proposal, j.day(1));
    const plannedAgain = [wornTop, wornBottom].filter((id) => dayTwo.slots.some((s) => s.garmentId === id));
    const board = await tripBoard(j.day(1));
    const offered = new Set((board.options as any[]).flatMap((o) => o.garments.map((g: any) => g.garmentId)));
    const nameOf = (id: string) => proposal.items.find((i) => i.garmentId === id)!.name;
    expect(plannedAgain.filter((id) => !offered.has(id)).map(nameOf)).toEqual([]);
  });

  it("a home weekly laundry reset does not wash clothes in a suitcase", async () => {
    // The reset only clears wears from before its collection cutoff (days ago), and no API lets that time
    // pass. So the boundary case is built from two labelled SYNTHETIC shirts the owner does not own, with
    // observations reported late through their occurrence dates (ordinary commands with `occurredAt`):
    // both were worn eleven days ago, one at home and one from the suitcase of a SYNTHETIC earlier trip.
    const at = (offset: number) => ({ occurredAt: `${j.day(offset)}T10:00:00.000Z` });
    const synthetic = async (name: string) =>
      (await exec(api(), "garment.create", { name, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic boundary-case garment for journey 07" } }, at(-13))).result.garmentId as string;
    const suitcaseShirt = await synthetic("SYNTHETIC shirt worn from a suitcase (journey 07)");
    const hamperShirt = await synthetic("SYNTHETIC shirt worn at home (journey 07)");
    const earlier = await exec(api(), "trip.create", {
      name: "SYNTHETIC earlier trip (journey 07)",
      departsOn: j.day(-12),
      returnsOn: j.day(-9),
      destinations: [{ label: paris.label, latitude: paris.latitude, longitude: paris.longitude, timezone: paris.timezone, from: j.day(-12), to: j.day(-9) }],
      source: { kind: "system", note: "synthetic boundary-case trip for journey 07" },
    });
    const earlierTripId = earlier.result.tripId as string;
    await exec(api(), "stock.pack", { tripId: earlierTripId, items: [{ garmentId: suitcaseShirt }] }, at(-12));
    await exec(api(), "wear.record", { wearingDate: j.day(-11), garmentIds: [suitcaseShirt], tripId: earlierTripId }, at(-11));
    await exec(api(), "wear.record", { wearingDate: j.day(-11), garmentIds: [hamperShirt] }, at(-11));
    expect(quantityIn((await item(hamperShirt)).detail, "dirty")).toBe(1);
    expect((await packedOf(earlierTripId)).get(suitcaseShirt)).toMatchObject({ clean: 0, worn: 1 });

    const reset = await exec(api(), "laundry.apply_weekly_reset", {});
    expect(reset.outcome).toBe("committed");
    expect(reset.result.cyclesApplied.length).toBeGreaterThan(0);
    expect(reset.result.garmentsReset).toBeGreaterThanOrEqual(1);
    expect((await api().json("GET", "/v1/laundry")).cycles.length).toBeGreaterThan(0);

    // The shirt worn at home is assumed clean again by the weekly baseline...
    const hamper = await item(hamperShirt);
    expect(quantityIn(hamper.detail, "clean")).toBe(1);
    expect(quantityIn(hamper.detail, "dirty")).toBe(0);
    // ...the one worn from a suitcase at the same time is not, and neither is today's shirt in the Paris suitcase.
    expect((await packedOf(earlierTripId)).get(suitcaseShirt)).toMatchObject({ clean: 0, worn: 1 });
    expect(quantityIn((await item(suitcaseShirt)).detail, "clean")).toBe(0);
    const packed = await packedOf();
    expect(packed.get(wornTop)).toMatchObject({ clean: 0, worn: 1 });
    expect(packed.get(wornBottom)).toMatchObject({ clean: 0, worn: 1 });
  });

  it("the trip can be changed; a change that makes no sense is refused in plain words and changes nothing", async () => {
    const before = await trip();
    const bad = await refused(await api().command("trip.update", { tripId, changes: { returnsOn: j.day(-1) } }));
    expect(bad.status).toBe(400);
    expect(bad.error.code).toBe("invalid_command");
    expect(bad.error.message).toMatch(/return date is before the departure/i);
    expect(await trip()).toEqual(before);

    const longer = await exec(api(), "trip.update", {
      tripId,
      changes: { name: "Paris, one day longer", returnsOn: j.day(3), destinations: [{ label: paris.label, latitude: paris.latitude, longitude: paris.longitude, timezone: paris.timezone, from: j.day(0), to: j.day(3) }] },
    });
    expect(longer.outcome).toBe("committed");
    expect(internalCodesIn(longer.summary)).toEqual([]);
    const after = await trip();
    expect(after).toMatchObject({ name: "Paris, one day longer", returnsOn: j.day(3), version: before.version + 1, status: "planned" });
    expect(after.destinations[0].to).toBe(j.day(3));
    // Changing the plan moves no clothes.
    expect(after.packed).toEqual(before.packed);
  });

  it("Unpacked returns the suitcase home without declaring anything clean", async () => {
    const dayOne = plan(proposal, j.day(0));
    const shoes = slot(dayOne, "footwear");
    unwornPackedTop = proposal.items.find((i) => i.role === "top" && i.garmentId !== wornTop)!.garmentId;

    unpackReceipt = await exec(api(), "stock.unpack", { tripId });
    expect(unpackReceipt.outcome).toBe("committed");
    expect(unpackReceipt.result.unpacked).toBe(proposal.items.length);
    expect(unpackReceipt.summary).toMatch(/not marked clean/i);
    expect(unpackReceipt.undo.available).toBe(true);
    expect((await trip()).packed).toEqual([]);

    // What travelled is home again, worn or not, but none of it is asserted clean; a unit that never left stays as it was.
    const travelled = (id: string) => proposal.items.find((i) => i.garmentId === id)!.quantity;
    for (const id of [wornTop, unwornPackedTop, wornBottom]) {
      const read = await item(id);
      const name = read.detail.garment.name;
      const stayedHome = (cleanBefore.get(id) ?? 0) - travelled(id);
      expect(quantityIn(read.detail, "trip"), name).toBe(0);
      expect(quantityIn(read.detail, "dirty"), name).toBe(travelled(id));
      expect(quantityIn(read.detail, "clean"), name).toBe(stayedHome);
      expect(read.availability.cleanObserved, name).toBe(stayedHome);
      if (stayedHome === 0) expect(read.availability.status, name).not.toBe("available");
      expect(read.detail.movements.at(-1), name).toMatchObject({ kind: "unpack", from: "trip", to: "dirty", basis: "observed" });
    }
    const laundry = await api().json("GET", "/v1/laundry");
    const awaiting = new Set([...laundry.awaitingService, ...laundry.awaitingHandwash].map((g: any) => g.garmentId));
    for (const id of [wornTop, unwornPackedTop, wornBottom]) expect(awaiting.has(id)).toBe(true);
    // Shoes have no laundry state: they are simply home.
    const shoe = await item(shoes);
    expect(quantityIn(shoe.detail, "trip")).toBe(0);
    expect(quantityIn(shoe.detail, "clean")).toBe(1);
    expect(awaiting.has(shoes)).toBe(false);
  });

  it("a later wash report from the owner is what makes them clean", async () => {
    const washed = await exec(api(), "care.washed", { items: [{ garmentId: wornTop }, { garmentId: unwornPackedTop }] });
    expect(washed.outcome).toBe("committed");
    expect(washed.result.washed.sort()).toEqual([wornTop, unwornPackedTop].sort());
    expect(internalCodesIn(washed.summary)).toEqual([]);
    for (const id of [wornTop, unwornPackedTop]) {
      const read = await item(id);
      expect(quantityIn(read.detail, "clean")).toBe(cleanBefore.get(id));
      expect(quantityIn(read.detail, "dirty")).toBe(0);
      expect(read.availability.status).toBe("available");
    }
    // The trousers were not in the wash report: the pair that travelled is still awaiting care.
    const trousers = await item(wornBottom);
    expect(quantityIn(trousers.detail, "dirty")).toBe(1);
    expect(quantityIn(trousers.detail, "clean")).toBe((cleanBefore.get(wornBottom) ?? 0) - 1);
  });

  it("the Packed and Unpacked receipts name the trip in the owner's words, not by an internal identifier", () => {
    // Was defect D07-4; fixed by the foundation in a5e6c8fa.
    expect(internalCodesIn(packReceipt.summary)).toEqual([]);
    expect(internalCodesIn(unpackReceipt.summary)).toEqual([]);
  });

  it("a cancelled trip says honestly what is still packed, and a trip created by mistake is undone", async () => {
    // A second trip, with one belt already packed (the owner's own belt, packed and unpacked by the owner here).
    const lisbon = await exec(api(), "trip.create", {
      name: "Lisbon weekend",
      departsOn: j.day(6),
      returnsOn: j.day(8),
      destinations: [{ label: "Lisbon", timezone: "Europe/Lisbon", from: j.day(6), to: j.day(8) }],
      source: { kind: "owner_statement", note: "A weekend in Lisbon." },
    });
    const lisbonId = lisbon.result.tripId as string;
    const belt = proposal.items.find((i) => i.role === "belt")!;
    await exec(api(), "stock.pack", { tripId: lisbonId, items: [{ garmentId: belt.garmentId }] });

    const cancelled = await exec(api(), "trip.cancel", { tripId: lisbonId });
    expect(cancelled.outcome).toBe("committed");
    expect(cancelled.summary).toMatch(/cancelled/i);
    expect(cancelled.summary).toMatch(/stay recorded as packed until you unpack/i);
    expect(internalCodesIn(cancelled.summary)).toEqual([]);
    expect(cancelled.result.stillPacked).toBe(1);
    const read = await api().json("GET", `/v1/trips/${lisbonId}`);
    expect(read.status).toBe("cancelled");
    expect(read.packed).toEqual([{ garmentId: belt.garmentId, name: belt.name, clean: 1, worn: 0 }]);
    // Cancelling again changes nothing, and a cancelled trip takes no new packing proposal.
    expect((await exec(api(), "trip.cancel", { tripId: lisbonId })).outcome).toBe("noop");
    expect((await api().post(`/v1/trips/${lisbonId}/packing-proposal`, { clientRequestId: `pack-${crypto.randomUUID()}` })).status).toBe(404);
    await exec(api(), "stock.unpack", { tripId: lisbonId });
    expect((await api().json("GET", `/v1/trips/${lisbonId}`)).packed).toEqual([]);
    expect(quantityIn((await item(belt.garmentId)).detail, "clean")).toBe(1);

    const mistake = await exec(api(), "trip.create", {
      name: "Entered by mistake",
      departsOn: j.day(20),
      returnsOn: j.day(21),
      destinations: [{ label: "Lisbon", timezone: "Europe/Lisbon", from: j.day(20), to: j.day(21) }],
      source: { kind: "owner_statement", note: "Entered by mistake." },
    });
    const undone = await exec(api(), "command.undo", { commandId: mistake.commandId });
    expect(undone.outcome).toBe("committed");
    expect((await api().json("GET", `/v1/trips/${mistake.result.tripId}`)).status).toBe("cancelled");
    // The Paris trip is untouched by any of this.
    expect((await trip()).status).toBe("planned");
  });

  it("another owner cannot read the trip or ask for its packing list", async () => {
    const read = await refused(await stranger.api.get(`/v1/trips/${tripId}`));
    expect(read.status).toBe(404);
    expect(read.error.code).toBe("not_found");
    expect((await stranger.api.json("GET", "/v1/trips")).trips).toEqual([]);
    expect((await stranger.api.post(`/v1/trips/${tripId}/packing-proposal`, { clientRequestId: `pack-${crypto.randomUUID()}` })).status).toBe(404);
    const pack = await refused(await stranger.api.command("stock.pack", { tripId, items: [{ garmentId: wornTop }] }));
    expect(pack.status).toBe(404);
    expect((await trip()).packed).toEqual([]);
  });

  it("the trip's repeat exception rewrote none of the owner's ordinary rotation preferences", async () => {
    const settings = await api().json("GET", "/v1/settings");
    expect(JSON.stringify(settings.settings.variety)).toBe(varietyBefore);
    const style = await api().json("GET", "/v1/style");
    expect(varietyRules(style)).toBe(varietyRulesBefore);
    expect(varietyRulesBefore).toContain("variety.repeat_horizon");
    expect(style.styleRevision).toBe(styleRevisionBefore);
  });
});
