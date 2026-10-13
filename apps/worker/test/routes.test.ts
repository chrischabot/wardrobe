import { describe, expect, it } from "vitest";
import { API_ROUTES } from "@garderobe/contracts/ext/api";
import { SELF } from "cloudflare:test";
import { appRouter } from "../src/routes/index.ts";
import { APP_ORIGIN, MCP_ORIGIN, provisionOwner } from "../src/testing/index.ts";

describe("route manifest", () => {
  it("mounts exactly the application routes published in the contract, with the same trust and scope", () => {
    const providerOwned = new Set(["oauth_public", "mcp_oauth"]);
    const published = API_ROUTES.filter((r) => !providerOwned.has(r.trust)).map((r) => `${r.method} ${r.path} ${r.trust} ${r.scope}`).sort();
    const mounted = appRouter().manifest().map((r) => `${r.method} ${r.path} ${r.trust} ${r.scope}`).sort();
    expect(mounted).toEqual(published);
  });

  it("answers an unknown path with a JSON 404 and no route-specific detail", async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}/v1/does-not-exist`);
    expect(response.status).toBe(404);
    expect((await response.json()) as any).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("first request", () => {
  it("lets a claimed owner read their identity and the mounted modules", async () => {
    const owner = await provisionOwner();
    const me = await owner.api.json("GET", "/v1/me");
    expect(me.userId).toBe(owner.userId);
    expect(me.identities).toHaveLength(1);
    expect(me.recoveryKit.present).toBe(true);
    const meta = await owner.api.json("GET", "/v1/meta");
    expect(meta.apiVersion).toBe("v1");
    expect(meta.modules).toEqual([
      { name: "foundation", mounted: true },
      { name: "daily", mounted: true },
      { name: "assistant", mounted: true },
      { name: "media", mounted: true },
    ]);
    expect(meta.mcp.endpoint).toBe(`${MCP_ORIGIN}/mcp`);
  });
});
