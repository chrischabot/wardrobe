import { describe, expect, it } from "vitest";
import { getToday, renderBoardCalendarText, renderBoardHtml } from "../src/index.ts";
import { compose, createDailyHarness, MILD_DAY, realOwner } from "./helpers.ts";

describe("one semantic board document, three surfaces", () => {
  it("renders the same options as Calendar text and as the private web board, with perceptible names and no codes or diagnostics", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z" });
    const owner = await realOwner(h);
    h.weather.setForecast("2026-09-16", MILD_DAY);
    const doc = (await compose(h, owner, "2026-09-16")).board!;

    const text = renderBoardCalendarText(doc, { boardUrl: "https://garderobe.example/board/2026-09-16" });
    const lines = text.split("\n");
    // The day line first: the date, the weather line, the shape of the day.
    expect(lines[0]).toBe("Wednesday 16 September. 12 °C leaving, 19 °C later. Nothing fixed in the calendar.");
    for (const o of doc.options) {
      const at = lines.indexOf(`${o.number}. ${o.name}`);
      expect(at, `option ${o.number} heading`).toBeGreaterThan(0);
      expect(lines[at - 1]).toBe(""); // whitespace between everything
      expect(lines[at + 1]).toBe(o.reason); // each option opens with why it works
      // Then the pieces in the profile's order: jacket, shirt, trousers, belt, socks with shoes.
      const block = lines.slice(at + 2, at + 2 + 6).filter((l) => l.includes(": ")).map((l) => l.split(": ")[0]);
      const order = ["Jacket", "Shirt", "Trousers", "Belt", "Socks and shoes"].filter((label) => block.includes(label));
      expect(block.slice(0, order.length)).toEqual(order);
      expect(block).toContain("Shirt");
      expect(block[block.length - 1] === "Socks and shoes" || block.includes("Socks and shoes")).toBe(true);
      for (const g of o.garments) expect(text).toContain(g.name);
    }
    expect(text).not.toMatch(/gmt_|opt_|brd_|revision|validation|laundry|pAvailable|\d\s?%/i);
    expect(lines[lines.length - 1]).toBe("Open the board: https://garderobe.example/board/2026-09-16");

    const html = await renderBoardHtml(h.db, owner.principal(), { date: "2026-09-16", baseUrl: "https://garderobe.example/", nowMs: h.clock.now() });
    for (const o of doc.options) {
      // Each option resolves to the same stable identity on the web board as in the app.
      expect(html).toContain(`id="option-${o.optionId}"`);
      expect(html).toContain(`https://garderobe.example/board/2026-09-16#option-${o.optionId}`);
    }
    expect(html).toContain("Lightweight oxford");
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("escapes garment and event text on the web board", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T20:00:00Z" });
    const owner = await h.createSyntheticOwner({
      settings: { homeLocation: { label: "London", latitude: 51.5, longitude: -0.12 } } as never,
      garments: [
        { id: "s1", name: 'shirt <script>alert("x")</script>', category: "shirt", roles: ["top"], careChannel: "service" },
        { id: "t1", name: "olive fatigues", category: "trousers", roles: ["bottom"], careChannel: "service" },
        { id: "k1", name: "grey socks", category: "socks", roles: ["socks"], careChannel: "handwash" },
        { id: "f1", name: "navy sneakers", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker" } },
      ],
    });
    h.weather.setForecast("2026-09-16", MILD_DAY);
    await compose(h, owner, "2026-09-16");
    const html = await renderBoardHtml(h.db, owner.principal(), { date: "2026-09-16", baseUrl: "https://garderobe.example", nowMs: h.clock.now() });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    const today = await getToday(h.db, owner.principal(), { date: "2026-09-16", nowMs: h.clock.now() });
    expect(today.board!.options).toHaveLength(1);
  });
});
