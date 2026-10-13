import { beforeAll, describe, expect, it } from "vitest";
import { localDay, ownerDay, provisionOwner, type TestOwner } from "../src/testing/index.ts";

/*
 * The owner's day is not the UTC day. These checks hold at any time of day; run the whole suite with
 * GARDEROBE_TEST_CLOCK=23:30 (and 00:30) to exercise the hours in which the two days differ.
 * The owner is the REAL owner fixture (supplied profile and inventory); nothing is written but one board.
 */
let owner: TestOwner;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
});

describe("the day a test names to the Worker", () => {
  it("is the owner's local day at pinned instants on both sides of midnight, in summer and winter time", () => {
    const at = (iso: string) => Date.parse(iso);
    // 23:30 UTC in British Summer Time is already tomorrow for a London owner.
    expect(localDay("Europe/London", at("2026-10-02T23:30:00Z"))).toBe("2026-10-03");
    expect(localDay("Europe/London", at("2026-10-02T22:59:59Z"))).toBe("2026-10-02");
    expect(localDay("Europe/London", at("2026-10-03T00:30:00Z"))).toBe("2026-10-03");
    expect(localDay("Europe/London", at("2026-10-03T01:59:00Z"))).toBe("2026-10-03");
    // In winter London is on UTC and the two days agree.
    expect(localDay("Europe/London", at("2026-12-01T23:30:00Z"))).toBe("2026-12-01");
    // West of UTC the owner's day lags instead: the mirror hours.
    expect(localDay("America/New_York", at("2026-10-03T00:30:00Z"))).toBe("2026-10-02");
    expect(localDay("Europe/London", at("2026-10-02T23:30:00Z"), 1)).toBe("2026-10-04");
    expect(localDay("Europe/London", at("2026-10-02T23:30:00Z"), -1)).toBe("2026-10-02");
  });

  it("is the day the Worker itself calls today, and the Worker refuses a board for the day before it", async () => {
    const today = await ownerDay(owner);
    expect((await owner.api.json("GET", "/v1/today")).localDate).toBe(today);
    const past = await owner.api.post("/v1/recommendations", { clientRequestId: `past-${crypto.randomUUID()}`, mode: "board", date: await ownerDay(owner, -1) });
    expect(past.status).toBe(400);
    expect(((await past.json()) as any).error).toMatchObject({ code: "invalid_command", message: "a board cannot be published for a past day", details: { today } });
    const current = await owner.api.post("/v1/recommendations", { clientRequestId: `today-${crypto.randomUUID()}`, mode: "board", date: today });
    expect(current.status, await current.clone().text()).toBe(200);
  });
});
