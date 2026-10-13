import { describe, it, expect } from "vitest";
import {
  BROWSER_CAPABILITIES,
  BrowserPolicyError,
  BrowserService,
  BrowserSessionExpiredError,
  CapabilityRegistry,
  INFERENCE_BEARING_FACILITIES,
  classifyAction,
} from "../../../src/research/web/index.ts";
import type { AccessWall, BackendActResult, BackendObservation, BrowserAction, BrowserBackend } from "../../../src/research/web/index.ts";

/** FAKE Browser Run backend (test double): in-memory sessions with counters; no browser is started. */
class FakeBrowserBackend implements BrowserBackend {
  created: string[] = [];
  closed: string[] = [];
  acted: { sessionId: string; action: BrowserAction }[] = [];
  expired = new Set<string>();
  observeWall: AccessWall | null = null;
  actWall: AccessWall | null = null;
  private urls = new Map<string, string>();
  private tokenCounter = 0;

  async createSession(req: { url: string }): Promise<{ sessionId: string }> {
    const sessionId = `session-${this.created.length + 1}`;
    this.created.push(req.url);
    this.urls.set(sessionId, req.url);
    return { sessionId };
  }
  async observe(sessionId: string): Promise<BackendObservation> {
    if (this.expired.has(sessionId)) throw new BrowserSessionExpiredError(sessionId);
    this.tokenCounter += 1;
    return { pageStateToken: `token-${this.tokenCounter}`, url: this.urls.get(sessionId) ?? "", snapshot: "button 'Add to basket'", wall: this.observeWall };
  }
  async act(sessionId: string, action: BrowserAction): Promise<BackendActResult> {
    if (this.expired.has(sessionId)) throw new BrowserSessionExpiredError(sessionId);
    this.acted.push({ sessionId, action });
    if (action.kind === "navigate" && action.value) this.urls.set(sessionId, action.value);
    return this.actWall ? { outcome: "blocked", wall: this.actWall } : { outcome: "done" };
  }
  async closeSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }
}

const URL_A = "https://shop.example.com/coat?colour=navy";

async function setup() {
  const time = { now: 1_000_000 };
  const backend = new FakeBrowserBackend();
  const service = new BrowserService({ backend, clock: () => time.now });
  const { sessionId } = await service.openSession({ taskId: "task-1", url: URL_A });
  const observeToken = async (id: string = sessionId): Promise<string> => {
    const seen = await service.observe(id);
    if (seen.status !== "observed") throw new Error("expected an observation");
    return seen.pageStateToken;
  };
  return { time, backend, service, sessionId, observeToken };
}

describe("CapabilityRegistry", () => {
  it("has one entry per capability family in the design", () => {
    expect(BROWSER_CAPABILITIES.map((entry) => entry.id)).toEqual([
      "readable_extraction",
      "captures_documents",
      "structured_extraction",
      "multi_page_crawl",
      "browser_sessions",
      "interactive_actions",
      "files_inspection",
      "owner_assistance",
      "page_provided_tools",
    ]);
    const tools: readonly string[] = BROWSER_CAPABILITIES.flatMap((entry) => [...entry.tools]);
    for (const tool of ["crawl_cancel", "live_view", "human_handoff", "webmcp_call"]) expect(tools).toContain(tool);
  });

  it("keeps a capability disabled until a probe passes, and disables it again on a failed probe", () => {
    const registry = new CapabilityRegistry();
    expect(registry.statuses().every((status) => !status.enabled && status.reason === "not probed on this deployment")).toBe(true);

    registry.recordProbe("owner_assistance", { passed: false, detail: "Live View returned 404", at: "2025-03-10T12:00:00Z" });
    expect(registry.status("owner_assistance")).toMatchObject({ enabled: false, reason: "probe failed: Live View returned 404" });

    registry.recordProbe("owner_assistance", { passed: true, detail: "handoff round trip ok", at: "2025-03-10T12:05:00Z" });
    expect(registry.isEnabled("owner_assistance")).toBe(true);
    expect(registry.status("owner_assistance").reason).toBeNull();
    expect(registry.isEnabled("page_provided_tools")).toBe(false);
  });

  it("describes the catalogue as one compact line per capability", () => {
    const registry = new CapabilityRegistry();
    const lines = registry.describeCatalogue();
    expect(lines).toHaveLength(BROWSER_CAPABILITIES.length);
    expect(lines.every((line) => !line.includes("\n") && line.length < 240)).toBe(true);
    expect(lines[3]).toContain("multi_page_crawl");
    expect(lines[3]).toContain("disabled (not probed on this deployment)");
    expect(registry.describeCapability("multi_page_crawl").tools).toContain("crawl_cancel");
  });

  it("keeps inference-bearing facilities disabled with the Gateway reason", () => {
    expect(INFERENCE_BEARING_FACILITIES.map((facility) => facility.id)).toEqual(["json_endpoint_extraction", "stagehand", "visual_action_models", "crawl_extraction"]);
    for (const facility of INFERENCE_BEARING_FACILITIES) {
      expect(facility.enabled).toBe(false);
      expect(facility.reason).toContain("not proven to go through Garderobe's AI Gateway");
    }
  });
});

describe("BrowserService page state", () => {
  it("accepts an action carrying the latest token and then requires a new observation", async () => {
    const { backend, service, sessionId, observeToken } = await setup();
    const token = await observeToken();
    expect(await service.act(sessionId, { kind: "click", pageStateToken: token, target: "size M" })).toMatchObject({ status: "done" });
    expect(backend.acted).toHaveLength(1);
    await expect(service.act(sessionId, { kind: "click", pageStateToken: token, target: "colour navy" })).rejects.toMatchObject({ code: "stale_page_state" });
    expect(backend.acted).toHaveLength(1);
  });

  it("rejects a token from an earlier observation, from no observation, or from another session", async () => {
    const { backend, service, sessionId, observeToken } = await setup();
    await expect(service.act(sessionId, { kind: "scroll", pageStateToken: "token-0" })).rejects.toBeInstanceOf(BrowserPolicyError);
    const first = await observeToken();
    await observeToken();
    await expect(service.act(sessionId, { kind: "scroll", pageStateToken: first })).rejects.toMatchObject({ code: "stale_page_state" });

    const other = await service.openSession({ taskId: "task-2", url: "https://other.example.com/" });
    const otherToken = await observeToken(other.sessionId);
    await expect(service.act(sessionId, { kind: "scroll", pageStateToken: otherToken })).rejects.toMatchObject({ code: "stale_page_state" });
    expect(backend.acted).toHaveLength(0);
  });

  it("refuses to open or navigate to a non-public URL", async () => {
    const { backend, service, sessionId, observeToken } = await setup();
    await expect(service.openSession({ taskId: "task-3", url: "https://127.0.0.1/admin" })).rejects.toMatchObject({ code: "ip_not_public" });
    const token = await observeToken();
    await expect(service.act(sessionId, { kind: "navigate", pageStateToken: token, value: "http://shop.example.com/" })).rejects.toMatchObject({ code: "scheme_not_https" });
    expect(backend.created).toEqual([URL_A]);
    expect(backend.acted).toHaveLength(0);
  });
});

describe("BrowserService sessions and tasks", () => {
  it("reconstructs an expired session from the saved URL without restoring the variant", async () => {
    const { backend, service, sessionId, observeToken } = await setup();
    await observeToken();
    service.addEvidence("task-1", "evidence/coat-navy-m.png");
    backend.expired.add(sessionId);
    await expect(service.observe(sessionId)).rejects.toMatchObject({ code: "session_expired" });
    expect(service.getTask("task-1")).toMatchObject({ sessionId: null, urls: [URL_A], evidence: ["evidence/coat-navy-m.png"] });

    const rebuilt = await service.reconstruct("task-1");
    expect(rebuilt).toEqual({ sessionId: "session-2", url: URL_A, variantRestored: false, mustRecheck: ["size", "colour", "login", "cart", "region"] });
    expect(backend.created).toEqual([URL_A, URL_A]);
    await expect(service.act(rebuilt.sessionId, { kind: "click", pageStateToken: "token-1" })).rejects.toMatchObject({ code: "stale_page_state" });
    await expect(service.observe(sessionId)).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("closes idle sessions but keeps the task record", async () => {
    const { time, backend, service, sessionId } = await setup();
    time.now += 60_000;
    const busy = await service.openSession({ taskId: "task-2", url: "https://other.example.com/" });
    time.now += 240_000;
    expect(await service.closeIdle(time.now, 300_000)).toEqual([sessionId]);
    expect(backend.closed).toEqual([sessionId]);
    expect(service.getTask("task-1")).toMatchObject({ sessionId: null, urls: [URL_A] });
    expect(service.getTask("task-2")?.sessionId).toBe(busy.sessionId);
    await expect(service.observe(sessionId)).rejects.toMatchObject({ code: "unknown_session" });
  });
});

describe("BrowserService action policy", () => {
  it("classifies actions and fails closed on unknown kinds", () => {
    expect(classifyAction({ kind: "scroll" })).toBe("read_only");
    expect(classifyAction({ kind: "type" })).toBe("form_preparation");
    for (const kind of ["send_message", "submit_listing", "purchase", "commit_service", "paid_booking", "something_new"]) {
      expect(classifyAction({ kind }), kind).toBe("external_commitment");
    }
  });

  it("needs a matching retained authorization before an external commitment reaches the backend", async () => {
    const { backend, service, sessionId, observeToken } = await setup();
    const purchase = { kind: "purchase", scope: "shop.example.com/basket/991" } as const;
    let token = await observeToken();
    expect(await service.act(sessionId, { ...purchase, pageStateToken: token })).toEqual({ status: "needs_authorization", action: { ...purchase, pageStateToken: token } });

    service.retainAuthorization({ action: "purchase", scope: "shop.example.com/basket/555" });
    service.retainAuthorization({ action: "send_message", scope: purchase.scope });
    expect((await service.act(sessionId, { ...purchase, pageStateToken: token })).status).toBe("needs_authorization");
    expect(backend.acted).toHaveLength(0);

    service.retainAuthorization({ action: "purchase", scope: purchase.scope });
    expect((await service.act(sessionId, { ...purchase, pageStateToken: token })).status).toBe("done");
    expect(backend.acted).toHaveLength(1);

    service.revokeAuthorization({ action: "purchase", scope: purchase.scope });
    token = await observeToken();
    expect((await service.act(sessionId, { ...purchase, pageStateToken: token })).status).toBe("needs_authorization");
  });

  it("returns a prepared step for owner handoff when the backend reports a login or challenge wall", async () => {
    const { backend, service, sessionId, observeToken } = await setup();
    const token = await observeToken();
    backend.actWall = "login";
    const action: BrowserAction = { kind: "click", pageStateToken: token, target: "Checkout" };
    expect(await service.act(sessionId, action)).toMatchObject({ status: "handoff_required", preparedStep: { taskId: "task-1", sessionId, wall: "login", action, url: URL_A } });

    backend.observeWall = "challenge";
    expect(await service.observe(sessionId)).toMatchObject({ status: "handoff_required", preparedStep: { wall: "challenge", action: null } });
  });
});
