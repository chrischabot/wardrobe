/**
 * Journey 01: the morning. Today, choosing an outfit, a one-slot swap, and recording what was worn.
 *
 * Specification: section 3 (Today; Laundry, wear follow-through and undo), section 7 (weather context,
 * insufficient choices), section 8 (a command is a verified change), section 9 (reading the board needs
 * no inference); acceptance rows "Morning independence" (reading side), "Wear correction" (duplicates).
 * Profile: section 11 (one glanceable board: a day line, five outfits, each opening with why it works,
 * then jacket, shirt, trousers, belt, socks with shoes), section 8 rule 7 (names he can see).
 *
 * Real: the Worker, its HTTP API and MCP server, local D1/KV/R2, the owner's real profile and inventory.
 * Stand-ins (external boundaries only): the scripted Open-Meteo double (src/outbound.ts) and test-signed
 * sign-in assertions. No language model is enabled in this file: nothing here may need one.
 */
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, connectMcp, provisionOwner, publishBoard, toolResult, type TestOwner } from "@garderobe/worker/testing";
import { sheetRowsFor } from "../src/inventory.ts";
import { boardTexts, exec, internalCodesIn, mcpCommand, quantityIn, realOwnerAt, refused, weatherDown, wholeWardrobe, type JourneyOwner } from "../src/world.ts";

let j: JourneyOwner;
let owner: TestOwner;
let stranger: TestOwner;
let board: any;

beforeAll(async () => {
  j = await realOwnerAt("Today");
  owner = j.owner;
  stranger = await provisionOwner();
});

const today = (date: string) => owner.api.json("GET", `/v1/today?date=${date}`);

describe("the morning: Today, choose, swap, record", () => {
  it("says plainly that nothing is prepared yet, instead of showing an empty board", async () => {
    const view = await today(j.day(0));
    expect(view.status).toBe("none");
    expect(view.board).toBeNull();
    expect(view.emptyReason).toBeTruthy();
    expect(internalCodesIn(view.emptyReason)).toEqual([]);
    expect(view.dayRecord).toEqual([]);
  });

  it("previews options without publishing anything", async () => {
    const before = (await wholeWardrobe(owner.api)).wardrobeRevision;
    const preview = await owner.api.json("POST", "/v1/recommendations", { clientRequestId: `preview-${crypto.randomUUID()}`, date: j.day(0), count: 3, mode: "preview" });
    expect(preview.state).toBe("completed");
    expect(preview.options).toHaveLength(3);
    expect(preview.board).toBeNull();
    expect((await today(j.day(0))).board).toBeNull();
    expect((await wholeWardrobe(owner.api)).wardrobeRevision).toBe(before);
  });

  it("publishes one glanceable board: a day line and five outfits of the owner's own garments", async () => {
    const published = await publishBoard(owner, { date: j.day(0) });
    board = published.board;
    expect(published.state).toBe("completed");
    expect(board.localDate).toBe(j.day(0));
    expect(board.timezone).toBe("Europe/London");
    expect(board.revision).toBe(1);
    expect(board.options).toHaveLength(5); // the profile: "then five outfits"
    expect(board.requestedCount).toBe(5);
    expect(board.options.map((o: any) => o.number)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(board.options.map((o: any) => o.optionId)).size).toBe(5);
    // The day line opens the board and carries the day's shape (date and the scripted forecast).
    expect(board.dayLine).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{1,2} [A-Z][a-z]+\./);
    expect(board.dayLine).toContain("11 °C");
    expect(board.dayLine).toContain("19 °C");
    for (const option of board.options) {
      // Each outfit opens with a sentence on why it works, never a bare inventory.
      expect(option.reason.length).toBeGreaterThan(30);
      expect(option.reason).toMatch(/[.!]$/);
      const roles = option.garments.map((g: any) => g.role);
      for (const role of ["top", "bottom", "socks", "footwear"]) expect(roles.filter((r: string) => r === role), `${role} in option ${option.number}`).toHaveLength(1);
      // Every line is one of the owner's real garments, named as his own sheet names it.
      for (const line of option.garments) expect(sheetRowsFor(line.name).length, `"${line.name}" is in the owner's inventory sheet`).toBeGreaterThan(0);
    }
  });

  it("shows nothing but owner-readable words on the board", () => {
    for (const text of boardTexts(board)) expect(internalCodesIn(text), text).toEqual([]);
  });

  it("states source freshness honestly: a fresh forecast, and a calendar that is not connected", async () => {
    const view = await today(j.day(0));
    expect(view.status).toBe("ready");
    expect(view.board.revision).toBe(1);
    const freshness = Object.fromEntries(view.freshness.map((f: any) => [f.source, f]));
    expect(freshness.weather.state).toBe("fresh");
    expect(freshness.wardrobe.state).toBe("fresh");
    expect(freshness.calendar.state).toBe("not_connected");
    expect(freshness.board.revision).toBe(1);
    // The missing calendar is said once, outside the outfit copy; it is not read as "a free day".
    expect(`${view.board.notice ?? ""} ${view.board.dayLine}`).toMatch(/calendar/i);
    expect(view.board.dayLine).not.toMatch(/nothing (fixed|on|planned)|free day/i);
    for (const option of view.board.options) expect(option.reason).not.toMatch(/calendar is not connected/i);
    const weather = await owner.api.json("GET", `/v1/weather?date=${j.day(0)}`);
    expect(weather.freshness).toBe("fresh");
    expect(weather.conditions.peakC).toBe(19);
    expect(weather.conditions.departureC).toBe(11);
    expect(weather.attribution).toBeTruthy();
  });

  it("Choose records an intention with a receipt and an undo, never a wear", async () => {
    const option = board.options[1];
    const receipt = await exec(owner.api, "board.select", { boardId: board.boardId, optionId: option.optionId }, { expectedVersions: { [`board:${board.boardId}`]: board.revision } });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toMatch(/option 2/i);
    expect(receipt.summary).toMatch(/not a recorded wear|intention/i);
    expect(receipt.undo.available).toBe(true);
    const view = await today(j.day(0));
    expect(view.board.selection.optionId).toBe(option.optionId);
    expect(view.board.revision).toBe(1); // choosing does not rewrite the board
    expect(view.dayRecord).toEqual([]);
    expect((await owner.api.json("GET", `/v1/days/${j.day(0)}`)).garments).toEqual([]);
    // Nothing left the wardrobe: no garment is awaiting care because of a choice.
    const laundry = await owner.api.json("GET", "/v1/laundry");
    expect(laundry.awaitingService).toEqual([]);
    expect(laundry.awaitingHandwash).toEqual([]);

    const undone = await exec(owner.api, "command.undo", { commandId: receipt.commandId });
    expect(undone.summary).toMatch(/^Undone/);
    expect((await today(j.day(0))).board.selection).toBeNull();
    // The original receipt is kept; undo is a further receipt, not a deletion.
    expect((await owner.api.json("GET", `/v1/commands/${receipt.commandId}`)).commandId).toBe(receipt.commandId);
    await exec(owner.api, "board.select", { boardId: board.boardId, optionId: option.optionId });
  });

  it("refuses a plan edit made against an old board revision in plain words, and writes nothing", async () => {
    const stale = await refused(await owner.api.command("board.select", { boardId: board.boardId, optionId: board.options[3].optionId }, { expectedVersions: { [`board:${board.boardId}`]: 99 } }));
    expect(stale.status).toBe(409);
    expect(stale.error.code).toBe("conflict");
    expect(stale.error.message).toMatch(/nothing was written/i);
    expect((await today(j.day(0))).board.selection.optionId).toBe(board.options[1].optionId);
  });

  it("a morning correction is a swap of one piece, not a rebuild: one new revision, the rest untouched", async () => {
    const option = board.options[1];
    const swapped = await owner.api.json("POST", `/v1/boards/${board.boardId}/swap`, { clientRequestId: `swap-${crypto.randomUUID()}`, optionId: option.optionId, role: "top" });
    expect(swapped.receipt.type).toBe("board.swap_slot");
    expect(swapped.board.revision).toBe(board.revision + 1);
    expect(swapped.board.reason).toBe("swap");
    const after = swapped.board.options.find((o: any) => o.optionId === option.optionId);
    const pieceOf = (o: any, role: string) => o.garments.find((g: any) => g.role === role)?.garmentId;
    expect(pieceOf(after, "top")).not.toBe(pieceOf(option, "top"));
    for (const role of ["outer", "bottom", "belt", "socks", "footwear"]) expect(pieceOf(after, role), role).toBe(pieceOf(option, role));
    // The other four options are exactly as they were, under the same identities.
    for (const other of board.options.filter((o: any) => o.optionId !== option.optionId)) {
      const same = swapped.board.options.find((o: any) => o.optionId === other.optionId);
      expect(same.garments.map((g: any) => g.garmentId)).toEqual(other.garments.map((g: any) => g.garmentId));
      expect(same.changedInRevision).toBe(false);
    }
    expect(after.changedInRevision).toBe(true);
    // The receipt names both pieces in the owner's words; the selection survives the swap.
    const oldName = option.garments.find((g: any) => g.role === "top").name;
    const newName = after.garments.find((g: any) => g.role === "top").name;
    expect(swapped.receipt.summary).toContain(oldName);
    expect(swapped.receipt.summary).toContain(newName);
    expect(internalCodesIn(swapped.receipt.summary)).toEqual([]);
    expect(swapped.board.selection.optionId).toBe(option.optionId);
    // Profile rule 6: a swapped-in piece is never the navy fallback.
    expect(sheetRowsFor(newName)[0]!.colour).not.toMatch(/navy/i);
    board = swapped.board;
  });

  it("a connected assistant reads the same board revision the app shows", async () => {
    const mcp = await connectMcp(owner, { write: false, clientName: "Morning reader" });
    const viaMcp = toolResult(await mcp.client.callTool({ name: "garderobe_today", arguments: { date: j.day(0) } }));
    expect(viaMcp.ok).toBe(true);
    expect(viaMcp.data.board.boardId).toBe(board.boardId);
    expect(viaMcp.data.board.revision).toBe(board.revision);
    expect(viaMcp.data.board.options.map((o: any) => o.optionId)).toEqual(board.options.map((o: any) => o.optionId));
    expect(viaMcp.data.board.selection.optionId).toBe(board.selection.optionId);
    await mcp.close();
  });

  it("\"I am wearing it\" records the outfit once, with a receipt that names every piece", async () => {
    const worn = board.options.find((o: any) => o.optionId === board.selection.optionId);
    const ids = worn.garments.map((g: any) => g.garmentId);
    const before = await wholeWardrobe(owner.api);
    const receipt = await exec(owner.api, "wear.record", { wearingDate: j.day(0), garmentIds: ids });
    expect(receipt.outcome).toBe("committed");
    expect(receipt.summary).toMatch(/^Recorded for today: /);
    for (const line of worn.garments) expect(receipt.summary).toContain(line.name);
    expect(internalCodesIn(receipt.summary)).toEqual([]);
    expect(receipt.undo.available).toBe(true);
    expect(receipt.actor).toBe("owner");
    expect([...receipt.result.counted].sort()).toEqual([...ids].sort());

    const view = await today(j.day(0));
    expect(view.dayRecord.map((g: any) => g.garmentId).sort()).toEqual([...ids].sort());
    expect(view.board.validity).toBe("worn");
    // The outfit being worn is not silently rewritten: same options, same identities.
    expect(view.board.options.map((o: any) => o.optionId)).toEqual(board.options.map((o: any) => o.optionId));
    expect(view.board.options.find((o: any) => o.optionId === worn.optionId).garments.map((g: any) => g.garmentId)).toEqual(ids);

    // Follow-through: the shirt and trousers await the service laundry, the socks their hand wash;
    // the jacket, belt and shoes are not sent to the wash by a day's wear.
    const laundry = await owner.api.json("GET", "/v1/laundry");
    const nameOf = (role: string) => worn.garments.find((g: any) => g.role === role)?.name;
    expect(laundry.awaitingService.map((i: any) => i.name).sort()).toEqual([nameOf("top"), nameOf("bottom")].sort());
    expect(laundry.awaitingHandwash.map((i: any) => i.name)).toEqual([nameOf("socks")]);
    const after = await wholeWardrobe(owner.api);
    const item = (list: typeof after, role: string) => list.items.find((i) => i.garment.garmentId === worn.garments.find((g: any) => g.role === role).garmentId)!;
    expect(quantityIn(item(after, "footwear"), "clean")).toBe(quantityIn(item(before, "footwear"), "clean"));
    expect(quantityIn(item(after, "socks"), "clean")).toBe(quantityIn(item(before, "socks"), "clean") - 1);
    expect(quantityIn(item(after, "top"), "dirty")).toBe(1);
    // Units are conserved: nothing was created or lost by wearing.
    for (const role of ["top", "bottom", "socks", "footwear"]) expect(item(after, role).totalOwnedUnits, role).toBe(item(before, role).totalOwnedUnits);
  });

  it("tapping Wear again, or telling a connected assistant the same thing, counts nothing twice", async () => {
    const worn = board.options.find((o: any) => o.optionId === board.selection.optionId);
    const ids = worn.garments.map((g: any) => g.garmentId);
    const again = await exec(owner.api, "wear.record", { wearingDate: j.day(0), garmentIds: ids });
    expect(again.outcome).toBe("merged");
    expect(again.summary).toMatch(/nothing was counted twice/i);
    expect(again.result.counted).toEqual([]);

    const mcp = await connectMcp(owner, { write: true, clientName: "Morning writer", redirectUri: "https://morning-writer.client.test/cb" });
    const top = worn.garments.find((g: any) => g.role === "top");
    const relayed = await mcpCommand(owner, mcp, "wear.record", { wearingDate: j.day(0), garmentIds: [top.garmentId] }, { expectRoute: "direct" });
    expect(relayed.receipt.outcome).toBe("merged");
    expect(relayed.receipt.channel).toBe("mcp");
    await mcp.close();

    const item = await owner.api.json("GET", `/v1/items/${top.garmentId}`);
    expect(item.detail.recordedWearCount).toBe(1);
    expect(item.detail.lastRecordedWear).toBe(j.day(0));
    const day = await owner.api.json("GET", `/v1/days/${j.day(0)}`);
    expect(day.garments).toHaveLength(ids.length);
    // Every report is kept as a source, on both channels, behind the single counted wear.
    const reports = day.observations.filter((o: any) => o.garmentId === top.garmentId);
    expect(reports.length).toBe(3);
    expect(new Set(reports.map((o: any) => o.channel))).toEqual(new Set(["ios", "mcp"]));
    // A second pair of socks was not consumed by the duplicate report.
    const sock = await owner.api.json("GET", `/v1/items/${worn.garments.find((g: any) => g.role === "socks").garmentId}`);
    expect(quantityIn(sock.detail, "dirty")).toBe(1);
  });

  it("undoing the wear report restores the day and the stock exactly", async () => {
    const fresh = await realOwnerAt("Today undo");
    const published = (await publishBoard(fresh.owner, { date: fresh.day(0) })).board;
    const ids = published.options[0].garments.map((g: any) => g.garmentId);
    const before = await wholeWardrobe(fresh.owner.api);
    const receipt = await exec(fresh.owner.api, "wear.record", { wearingDate: fresh.day(0), garmentIds: ids });
    const undone = await exec(fresh.owner.api, "command.undo", { commandId: receipt.commandId });
    expect(undone.outcome).toBe("committed");
    expect((await fresh.owner.api.json("GET", `/v1/days/${fresh.day(0)}`)).garments).toEqual([]);
    const after = await wholeWardrobe(fresh.owner.api);
    for (const id of ids) {
      const was = before.items.find((i) => i.garment.garmentId === id)!;
      const is = after.items.find((i) => i.garment.garmentId === id)!;
      expect(quantityIn(is, "clean"), was.garment.name).toBe(quantityIn(was, "clean"));
      expect(is.recordedWearCount).toBe(0);
    }
    const laundry = await fresh.owner.api.json("GET", "/v1/laundry");
    expect(laundry.awaitingService).toEqual([]);
    expect(laundry.awaitingHandwash).toEqual([]);
    expect((await fresh.owner.api.json("GET", `/v1/today?date=${fresh.day(0)}`)).board.validity).not.toBe("worn");
  });

  it("renders the same board on the private web page, in the profile's order, for the signed-in owner only", async () => {
    const page = await owner.api.with({ client: "web" }).get(`/board/${j.day(0)}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const html = (await page.text()).replace(/<style[\s\S]*?<\/style>/g, "");
    const text = html.replace(/<[^>]+>/g, "\n").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    expect(text).toContain(board.dayLine);
    for (const option of board.options) {
      expect(text).toContain(option.name);
      for (const line of option.garments) expect(text).toContain(line.name);
    }
    // Jacket, shirt, trousers, belt, then socks with shoes: the order the profile asks for.
    const first = html.slice(html.indexOf("<section"), html.indexOf("</section>"));
    const labels = [...first.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]);
    const order = ["Jacket", "Shirt", "Trousers", "Belt", "Socks and shoes"].filter((l) => labels.includes(l));
    expect(labels).toEqual(order);
    expect(labels.slice(-1)).toEqual(["Socks and shoes"]);
    expect(html).not.toMatch(/\b(gmt|brd|cmd)_[0-9a-f]{8,}/);
    expect(internalCodesIn(text.replace(/option-opt_[0-9a-f]+/g, ""))).toEqual([]);
    expect((await SELF.fetch(`${APP_ORIGIN}/board/${j.day(0)}`)).status).toBe(401);
    const other = await (await stranger.api.with({ client: "web" }).get(`/board/${j.day(0)}`)).text();
    expect(other).not.toContain(board.options[0].name);
  });

  it("when the forecast cannot be fetched the board says so and assumes nothing about the weather", async () => {
    await weatherDown(j.place, true);
    const published = await publishBoard(owner, { date: j.day(3) });
    await weatherDown(j.place, false);
    const dark = published.board;
    expect(dark.freshness.weather).toBe("unavailable");
    expect(dark.validity).toBe("limited");
    expect(dark.notice).toMatch(/forecast|weather/i);
    expect(internalCodesIn(dark.notice)).toEqual([]);
    // No invented temperature anywhere in the copy, and still real outfits to wear.
    for (const text of boardTexts(dark)) expect(text, text).not.toMatch(/\d+ ?°C/);
    expect(dark.options.length).toBeGreaterThan(0);
    const view = await today(j.day(3));
    expect(view.freshness.find((f: any) => f.source === "weather").state).toBe("unavailable");
  });

  it("another owner sees none of this", async () => {
    expect((await stranger.api.json("GET", `/v1/today?date=${j.day(0)}`)).board).toBeNull();
    expect((await stranger.api.json("GET", `/v1/days/${j.day(0)}`)).garments).toEqual([]);
    const theft = await stranger.api.command("board.select", { boardId: board.boardId, optionId: board.options[0].optionId });
    expect(theft.status).toBe(404);
  });
});
