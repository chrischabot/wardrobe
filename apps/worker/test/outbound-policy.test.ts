import { beforeAll, describe, expect, it } from "vitest";
import { provisionOwner, type ApiClient, type TestOwner } from "../src/testing/index.ts";
import { assertResolvesPublic, checkResolvedHost, guardedFetch } from "../src/connections/endpoints.ts";

/*
 * Where outbound requests may go (adversarial findings D11-1 and D11-2 of tests/adversarial).
 *
 * Stand-ins: the DNS-over-HTTPS resolver and the hosts under `private-dns.example.org` and
 * `mixed-dns.example.org` are the LABELLED FIXTURE in src/testing/vitest-config.ts (not a resolver, not
 * a real service). A host there answers like a tool service and logs every request it receives, so "no
 * request was made" is read from that log. The unit tests of `guardedFetch` use an in-test resolver and
 * an in-test transport; nothing reaches a network.
 */
let owner: TestOwner;

const register = (api: ApiClient, body: Record<string, unknown>) => api.post("/v1/connections", { clientRequestId: `conn-${crypto.randomUUID()}`, ...body });
const reached = async (host: string): Promise<{ httpMethod: string; carriedAuthorization: boolean }[]> =>
  ((await (await fetch(`https://google.fixture.test/__calls?origin=https://${host}`)).json()) as { body: string }[]).map((c) => JSON.parse(c.body));

beforeAll(async () => {
  owner = await provisionOwner();
});

describe("an owner-added tool service whose name resolves to a private address", () => {
  it("is refused when it is added: nothing is stored, and neither a request nor the key reaches the host", async () => {
    for (const [host, auth] of [
      ["tools.private-dns.example.org", { type: "secret", secret: "outbound-policy-key-1" }],
      ["tools.mixed-dns.example.org", { type: "secret", secret: "outbound-policy-key-2" }],
      ["open.private-dns.example.org", { type: "none" }],
      ["signin.private-dns.example.org", { type: "oauth" }],
    ] as const) {
      const response = await register(owner.api, { kind: "mcp", name: "SYNTHETIC service on a private address", endpoint: `https://${host}/mcp`, auth });
      const text = await response.text();
      expect(response.status, `${host}: ${text.slice(0, 200)}`).toBe(400);
      expect(JSON.parse(text).error).toMatchObject({ code: "invalid_command", details: { reason: "resolves_private" } });
      expect(text).not.toContain("outbound-policy-key");
      expect(await reached(host), host).toEqual([]);
    }
    expect((await owner.api.json("GET", "/v1/connections")).connections).toEqual([]);
  });

  it("control: a service whose name resolves to a public address is still added and asked for its tools", async () => {
    const response = await register(owner.api, { kind: "tavily", name: "Page search (LABELLED FIXTURE, not Tavily)", auth: { type: "secret", secret: "tvly-outboundpolicy0001" } });
    const body = (await response.json()) as any;
    expect(response.status, JSON.stringify(body).slice(0, 200)).toBe(200);
    expect(body.connection.issue ?? null).toBeNull();
    expect(body.connection.capabilities.length).toBeGreaterThan(0);
    await owner.api.json("POST", `/v1/connections/${body.connection.connectionId}/disconnect`, {});
  });
});

describe("the transport every connection request goes through", () => {
  const transport = () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const inner = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return { requests, inner };
  };
  const call = (fetchFn: typeof fetch, url: string) => fetchFn(url, { method: "POST", headers: { Authorization: "Bearer secret-key-99" }, body: "{}" });

  it("sends nothing, key included, to a name with a private, local, embedded-private or mixed answer", async () => {
    const answers: Record<string, string[]> = {
      "ten.service-example.com": ["10.0.0.5"],
      "loopback.service-example.com": ["127.0.0.1"],
      "metadata.service-example.com": ["169.254.169.254"],
      "mixed.service-example.com": ["93.184.216.34", "192.168.0.10"],
      "v6-local.service-example.com": ["fd00::1"],
      "v6-mapped.service-example.com": ["::ffff:7f00:1"],
      "v6-nat64.service-example.com": ["64:ff9b::a00:1"],
      "v6-loopback.service-example.com": ["::1"],
    };
    for (const host of Object.keys(answers)) {
      const { requests, inner } = transport();
      const asked: string[] = [];
      const fetchFn = guardedFetch(inner, async (name) => (asked.push(name), answers[name]!));
      await expect(call(fetchFn, `https://${host}/mcp`), host).rejects.toMatchObject({ code: "invalid_command", details: { reason: "resolves_private" } });
      expect(asked, host).toEqual([host]);
      expect(requests, host).toEqual([]);
      expect(await checkResolvedHost(host, async (name) => answers[name]!)).toEqual({ ok: false, reason: "resolves_private" });
      await expect(assertResolvesPublic(new URL(`https://${host}/mcp`), "endpoint", async (name) => answers[name]!)).rejects.toMatchObject({ code: "invalid_command" });
    }
  });

  it("sends nothing to a name that has no address or cannot be looked up, and looks it up again on the next request", async () => {
    for (const failing of [async () => [] as string[], async () => Promise.reject(new Error("DNS lookup failed (HTTP 503)"))]) {
      const { requests, inner } = transport();
      let lookups = 0;
      const fetchFn = guardedFetch(inner, () => (lookups++, failing()));
      await expect(call(fetchFn, "https://gone.service-example.com/mcp")).rejects.toThrow(/could not be resolved/);
      await expect(call(fetchFn, "https://gone.service-example.com/mcp")).rejects.toThrow(/could not be resolved/);
      expect(lookups).toBe(2);
      expect(requests).toEqual([]);
    }
    // Adding such an endpoint is not refused for the outage; nothing can be sent to it meanwhile (above).
    await expect(assertResolvesPublic(new URL("https://gone.service-example.com/mcp"), "endpoint", async () => [])).resolves.toBeUndefined();
  });

  it("control: a name with only public addresses is called, with its key, after resolving the host before each request", async () => {
    const { requests, inner } = transport();
    const asked: string[] = [];
    const fetchFn = guardedFetch(inner, async (name) => (asked.push(name), ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]));
    expect((await call(fetchFn, "https://mcp.service-example.com/mcp")).status).toBe(200);
    expect((await call(fetchFn, "https://mcp.service-example.com/mcp")).status).toBe(200);
    expect(asked).toEqual(["mcp.service-example.com", "mcp.service-example.com"]);
    expect(requests).toEqual([
      { url: "https://mcp.service-example.com/mcp", authorization: "Bearer secret-key-99" },
      { url: "https://mcp.service-example.com/mcp", authorization: "Bearer secret-key-99" },
    ]);
    // An address literal or a local name is refused before any lookup, as before.
    await expect(call(fetchFn, "https://10.0.0.5/mcp")).rejects.toMatchObject({ code: "invalid_command" });
    await expect(call(fetchFn, "https://printer.local/mcp")).rejects.toMatchObject({ code: "invalid_command" });
    expect(asked).toEqual(["mcp.service-example.com", "mcp.service-example.com"]);
    expect(requests.length).toBe(2);
  });
});

describe("the address the Calendar event links to", () => {
  const save = (boardBaseUrl: unknown) => owner.api.command("settings.update", { patch: { extensions: { daily: { calendar: { boardBaseUrl } } } } });
  const stored = async (): Promise<unknown> => (await owner.api.json("GET", "/v1/settings")).settings.extensions?.daily?.calendar?.boardBaseUrl ?? null;

  it("is refused unless it is a plain https address of a public site, and a refused value is never stored", async () => {
    const hostile = [
      "javascript:alert(document.domain)//",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "http://garderobe.service-example.com",
      "http://169.254.169.254/latest/meta-data",
      "https://127.0.0.1:8787",
      "https://10.0.0.5",
      "https://[::1]",
      "https://localhost",
      "https://user:password@garderobe.service-example.com",
      "https://garderobe.service-example.com:22",
      "https://garderobe.service-example.com/?next=javascript:alert(1)",
      "https://garderobe.service-example.com/#x",
      "garderobe.service-example.com",
      "not an address",
    ];
    for (const value of hostile) {
      const response = await save(value);
      const text = await response.text();
      expect(response.status, `${value}: ${text.slice(0, 200)}`).toBe(400);
      expect(JSON.parse(text).error).toMatchObject({ code: "invalid_command", details: { field: "extensions.daily.calendar.boardBaseUrl" } });
      expect(await stored(), value).toBeNull();
    }
  });

  it("control: an https address of a public site is saved, and null clears it", async () => {
    expect((await save("https://garderobe.service-example.com")).status).toBe(200);
    expect(await stored()).toBe("https://garderobe.service-example.com");
    // A refused value leaves the saved one in place.
    expect((await save("javascript:alert(1)")).status).toBe(400);
    expect(await stored()).toBe("https://garderobe.service-example.com");
    expect((await save(null)).status).toBe(200);
    expect(await stored()).toBeNull();
  });
});
