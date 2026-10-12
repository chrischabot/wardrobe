import { describe, expect, it } from "vitest";
import { provisionOwner } from "../src/testing/index.ts";

/* Owner settings through the real Worker (workerd, local D1). Stand-in: test-signed Access assertions; synthetic owners. */
describe("settings", () => {
  it("a patch can clear the home location's coordinates, keeping the city, and undo brings them back", async () => {
    const owner = await provisionOwner();
    const home = { label: "London", latitude: 51.5085, longitude: -0.1257 };
    expect((await owner.api.command("settings.update", { patch: { homeLocation: home } })).status).toBe(200);
    expect((await owner.api.json("GET", "/v1/settings")).settings.homeLocation).toEqual(home);
    const cleared = await owner.api.command("settings.update", { patch: { homeLocation: { label: "Paris", latitude: null, longitude: null } } });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const receipt = (await cleared.json()) as { commandId: string; outcome: string };
    expect(receipt.outcome).toBe("committed");
    // Stored without the coordinates (they are optional, not nullable), so the city is geocoded from its label.
    expect((await owner.api.json("GET", "/v1/settings")).settings.homeLocation).toEqual({ label: "Paris" });
    expect((await owner.api.command("command.undo", { commandId: receipt.commandId })).status).toBe(200);
    expect((await owner.api.json("GET", "/v1/settings")).settings.homeLocation).toEqual(home);
    // A coordinate that is neither a number nor null is still refused.
    expect((await owner.api.command("settings.update", { patch: { homeLocation: { latitude: "north" } } })).status).toBe(400);
  });
});
