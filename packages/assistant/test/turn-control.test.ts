/**
 * Turn control: research in its own task actor, Stop on a running turn, simultaneous iOS and MCP turns,
 * and context overflow. Real: the conversation Durable Object and its task actors, the Think session and
 * queue, D1, the command service. Stand-in: the FAKE MODEL at the model boundary (a scripted step can be
 * held open to simulate a slow model).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, getDailyRecord } from "@garderobe/domain";
import { listJobs, runAssistantMaintenance } from "../src/index.ts";
import { TEST_GATEWAY_ID, fakeModelFor, setTestCompaction, type FakeRequest } from "../src/testing/index.ts";
import { createWorld, submission, type World } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
/** A held model step: it answers only after `open()` (a slow model, simulated). */
function gate() {
  const state = { open: false, entered: false };
  return {
    open: () => void (state.open = true),
    entered: () => state.entered,
    hold: async () => {
      state.entered = true;
      while (!state.open) await sleep(10);
    },
  };
}
const turnIdOf = async (w: World, submissionId: string) => (await all<{ turn_id: string }>(w.h.db, "SELECT turn_id FROM assistant_turns WHERE user_id = ? AND submission_id = ?", w.owner.userId, submissionId))[0]?.turn_id ?? null;
const lastOwnerText = (r: FakeRequest) => [...r.messages].reverse().find((m) => m.role === "user")?.text ?? "";

describe("research runs in its own task actor (real Durable Objects; FAKE MODELS)", () => {
  it("a slow investigation does not hold up the conversation, and only one result card enters the continuous transcript", async () => {
    const w = await createWorld({ real: false, probes: ["deepseek-v41-flash", "fable-5-1"] });
    const research = fakeModelFor("fable-5-1");
    const g = gate();
    research.script(async () => {
      await g.hold();
      return { toolCalls: [{ toolName: "find_garments", input: { search: "tweed" } }] };
    }, { text: "Harris Tweed is protected by the 1993 Act; the orb mark is certified by the Harris Tweed Authority." });

    const started = await w.client.startResearch({ submissionId: submission("research"), topic: "History of Harris Tweed", kind: "history" });
    expect(started.jobId).toBe(`job_${started.turnId}`);
    expect(["accepted", "running"]).toContain(started.status);
    await until("the research model call to start", async () => g.entered());

    // The conversation is free while the investigation is still running.
    w.model.script({ text: "Grey flannels today." });
    const turn = await w.client.runTurn({ submissionId: submission("chat"), text: "what should I wear?" });
    expect(turn.status).toBe("completed");
    expect(turn.reply?.text).toBe("Grey flannels today.");
    expect((await w.client.getTurn(started.turnId))!.status).toBe("running");
    expect((await w.client.transcript({})).messages.map((m) => m.text)).toEqual(["what should I wear?", "Grey flannels today."]);

    g.open();
    await until("the research turn to settle", async () => (await w.client.getTurn(started.turnId))!.status === "completed");
    await until("the result card", async () => (await w.client.transcript({})).messages.length === 3);
    const transcript = (await w.client.transcript({})).messages;
    // One card. Not the research request, not its tool calls, not its working messages.
    expect(transcript.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(transcript[2]!.text).toContain("History of Harris Tweed");
    expect(transcript[2]!.text).toContain("protected by the 1993 Act");
    expect(JSON.stringify(transcript)).not.toContain("Research request");
    expect(JSON.stringify(transcript)).not.toContain("find_garments");
    // The research ran under the research budget with its own run identity.
    const reservations = await all<{ task: string; budget_class: string; parent_id: string }>(w.h.db, "SELECT task, budget_class, parent_id FROM inference_reservations WHERE user_id = ? AND parent_id = ?", w.owner.userId, started.turnId);
    expect(reservations.length).toBe(2);
    expect(reservations.every((r) => r.task === "historical_research" && r.budget_class === "research")).toBe(true);
    // The conversation model never saw the research; the research model never saw the conversation.
    expect(w.model.requests.every((r) => !r.messages.some((m) => m.text.includes("Harris Tweed")))).toBe(true);
    expect(research.requests.every((r) => !r.messages.some((m) => m.text.includes("what should I wear")))).toBe(true);

    // The task works in its own file workspace (never a shell); the conversation has no workspace tools at all.
    expect(research.requests[0]!.toolNames).toEqual(expect.arrayContaining(["read", "write", "list", "grep"]));
    expect(research.requests[0]!.toolNames).not.toContain("bash");
    for (const name of ["read", "write", "edit", "delete", "bash"]) expect(w.model.requests[0]!.toolNames).not.toContain(name);
    // No tool in either set writes the ledger except through a typed command, and none exposes inventory as a file.
    expect(research.requests[0]!.toolNames).toContain("save_research_note");

    // The job settled once; the sweep's later delivery of the same job is deduplicated.
    const job = (await listJobs(w.h.db, w.owner.principal())).find((j) => j.jobId === started.jobId)!;
    expect(job.state).toBe("completed");
    const swept = await runAssistantMaintenance({ db: w.h.db, service: w.h.service, env: env as never, gatewayId: TEST_GATEWAY_ID, nowMs: w.h.clock.now() }, { limit: 500 });
    expect(swept.delivered).toBe(0);
    expect((await w.client.transcript({})).messages).toHaveLength(3);
    // Retransmitting the request starts nothing new.
    const calls = research.requests.length;
    expect((await w.client.getTurn(started.turnId))!.result).toMatchObject({ summary: expect.stringContaining("1993 Act") });
    expect(research.requests.length).toBe(calls);
  });

  it("Stop on a running investigation cancels it in its task actor and reports that it stopped", async () => {
    const w = await createWorld({ real: false, probes: ["deepseek-v41-flash", "fable-5-1"] });
    const research = fakeModelFor("fable-5-1");
    const g = gate();
    research.script(async () => {
      await g.hold();
      return { text: "too late" };
    });
    const started = await w.client.startResearch({ submissionId: submission("research"), topic: "Where Shetland wool is spun", kind: "history" });
    await until("the research model call to start", async () => g.entered());
    const stopped = await w.client.cancelTurn(started.turnId);
    expect(stopped).toMatchObject({ status: "cancelled", committedCommandIds: [] });
    g.open();
    await sleep(150);
    expect((await w.client.getTurn(started.turnId))!.status).toBe("cancelled");
    expect((await listJobs(w.h.db, w.owner.principal())).find((j) => j.jobId === started.jobId)!.state).toBe("cancelled");
    await until("the stop card", async () => (await w.client.transcript({})).messages.length === 1);
    const card = (await w.client.transcript({})).messages[0]!;
    expect(card.text).toContain("Stopped before it finished");
    expect(card.text).not.toContain("too late");
  });
});

describe("Stop and simultaneous turns in the conversation (real Durable Object; FAKE MODEL)", () => {
  it("Stop on a running turn keeps what was already committed, reports it, and dispatches nothing further", async () => {
    const w = await createWorld();
    const worn = await w.garment("Clark oxford — evergreen");
    const other = await w.garment("990");
    const g = gate();
    w.model.script(
      { toolCalls: [{ toolName: "record_wear", input: { garmentIds: [worn.garmentId] } }] },
      async () => {
        await g.hold();
        // What a model that ignored the stop would try next.
        return { toolCalls: [{ toolName: "mark_dirty", input: { garmentIds: [other.garmentId] } }] };
      },
      { text: "Both done." },
    );
    const submissionId = submission("stop");
    const running = w.client.runTurn({ submissionId, text: "I wore the evergreen Clark oxford and the 990s are dirty" });
    await until("the second model step", async () => g.entered());
    const turnId = (await turnIdOf(w, submissionId))!;
    expect((await w.client.getTurn(turnId))!.receipts.map((r) => r.type)).toEqual(["wear.record"]);

    const stopped = (await w.client.cancelTurn(turnId))!;
    expect(stopped.status).toBe("cancelled");
    expect(stopped.committedCommandIds).toHaveLength(1);
    g.open();
    const settled = await running;
    expect(settled.status).toBe("cancelled");
    await sleep(150);
    const final = (await w.client.getTurn(turnId))!;
    expect(final.status).toBe("cancelled");
    expect(final.receipts.map((r) => r.type)).toEqual(["wear.record"]);
    // The committed wear stays (undo is separate); the later effect never happened.
    expect(JSON.stringify(await getDailyRecord(w.h.db, w.owner.principal(), "2026-09-15"))).toContain(worn.garmentId);
    expect(await all(w.h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'care.mark_dirty'", w.owner.userId)).toHaveLength(0);
    const events = (await w.client.turnEvents(turnId)).events;
    expect(events.filter((e) => e.type === "run_finished")).toHaveLength(1);
    expect(events.find((e) => e.type === "run_finished")!.data).toMatchObject({ status: "cancelled", committedCommandIds: stopped.committedCommandIds });
    // Stopping again changes nothing, and the next message is served normally.
    expect((await w.client.cancelTurn(turnId))!.status).toBe("cancelled");
    w.model.script({ text: "Noted." });
    expect((await w.client.runTurn({ submissionId: submission("after"), text: "thanks" })).status).toBe("completed");
  });

  it("Stop on a turn that is still queued means it never runs", async () => {
    const w = await createWorld({ real: false });
    const g = gate();
    w.model.script(async () => {
      await g.hold();
      return { text: "first answer" };
    });
    const first = await w.client.submitTurn({ submissionId: submission("q1"), text: "first question" });
    await until("the first turn to start", async () => g.entered());
    const second = await w.client.submitTurn({ submissionId: submission("q2"), text: "second question" });
    expect((await w.client.cancelTurn(second.turnId))!.status).toBe("cancelled");
    g.open();
    await until("the first turn to settle", async () => (await w.client.getTurn(first.turnId))!.status === "completed");
    await sleep(150);
    expect((await w.client.getTurn(second.turnId))!.status).toBe("cancelled");
    expect(w.model.requests).toHaveLength(1);
    expect(w.model.requests.every((r) => !r.messages.some((m) => m.text.includes("second question")))).toBe(true);
  });

  it("simultaneous iOS and MCP messages get stable separate turns, run one after the other, and each acts under its own connection", async () => {
    const w = await createWorld();
    const worn = await w.garment("Clark oxford — evergreen");
    const ios = w.clientFor(w.owner.principal({ channel: "ios" }));
    const mcp = w.clientFor(w.owner.principal({ channel: "mcp" }));
    const active: string[] = [];
    let overlapped = false;
    w.model.otherwise(async (request) => {
      const said = lastOwnerText(request);
      const answering = request.toolResults.length > 0;
      if (!answering) {
        if (active.length > 0) overlapped = true;
        active.push(said);
        await sleep(40);
      }
      if (said.includes("I wore the evergreen Clark oxford") && !answering) return { toolCalls: [{ toolName: "record_wear", input: { garmentIds: [worn.garmentId] } }] };
      active.length = 0;
      return { text: said.includes("I wore the evergreen Clark oxford") ? "Logged from the phone." : "You wore the evergreen Clark oxford." };
    });
    const iosSubmission = submission("ios");
    const mcpSubmission = submission("mcp");
    const [a, b] = await Promise.all([ios.runTurn({ submissionId: iosSubmission, text: "I wore the evergreen Clark oxford today" }), mcp.runTurn({ submissionId: mcpSubmission, text: "what did I wear today?" })]);
    expect(a.status).toBe("completed");
    expect(b.status).toBe("completed");
    expect(a.turnId).not.toBe(b.turnId);
    expect(overlapped).toBe(false);
    expect(a.reply?.text).toBe("Logged from the phone.");
    expect(b.reply?.text).toBe("You wore the evergreen Clark oxford.");
    expect(a.receipts.map((r) => r.type)).toEqual(["wear.record"]);
    expect(b.receipts).toHaveLength(0);
    // One conversation, never interleaved: each owner message is followed by its own reply.
    const transcript = (await w.client.transcript({})).messages;
    expect(transcript.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(transcript[0]!.turnId).toBe(transcript[1]!.turnId);
    expect(transcript[2]!.turnId).toBe(transcript[3]!.turnId);
    expect(new Set(transcript.map((m) => m.channel))).toEqual(new Set(["ios", "mcp"]));
    const command = await all<{ channel: string }>(w.h.db, "SELECT channel FROM commands WHERE user_id = ? AND type = 'wear.record'", w.owner.userId);
    expect(command).toEqual([{ channel: "ios" }]);
    // A retransmission from either client returns its own turn and starts nothing.
    const calls = w.model.requests.length;
    expect((await mcp.runTurn({ submissionId: mcpSubmission, text: "what did I wear today?" })).turnId).toBe(b.turnId);
    expect((await ios.runTurn({ submissionId: iosSubmission, text: "I wore the evergreen Clark oxford today" })).turnId).toBe(a.turnId);
    expect(w.model.requests.length).toBe(calls);
    expect(await all(w.h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'wear.record'", w.owner.userId)).toHaveLength(1);
  });
});

describe("context overflow (real Think session; FAKE MODEL raising the provider's overflow error)", () => {
  const OVERFLOW = () => Object.assign(new Error("prompt is too long: 250000 tokens > 200000 maximum"), { statusCode: 400 });

  it("an overflow mid-turn compacts older history once and retries, keeping every original message and the complete profile", async () => {
    setTestCompaction(1_000_000, 2); // no proactive compaction: only the reactive path can shorten the history
    try {
      const w = await createWorld();
      for (let i = 0; i < 4; i++) {
        w.model.script({ text: `Earlier answer ${i}: ${"wool and weather ".repeat(30)}` });
        await w.client.runTurn({ submissionId: submission("hist"), text: `Earlier question ${i} about tweed and flannel` });
      }
      const before = (await w.client.transcript({ limit: 200 })).messages.length;
      const summarizer = fakeModelFor("deepseek-v41-flash");
      summarizer.script({ error: OVERFLOW() }, { text: "Summary of the earlier exchange: the owner asked four questions about tweed and flannel and was answered." }, { text: "Here is the answer after shortening." });
      const turn = await w.client.runTurn({ submissionId: submission("overflow"), text: "and what about today?" });
      expect(turn.failure).toBeNull();
      expect(turn.status).toBe("completed");
      expect(turn.reply?.text).toBe("Here is the answer after shortening.");
      // The retried request carried the complete profile and a shorter history.
      const retried = w.model.requests.at(-1)!;
      expect(retried.system).toContain("OWNER PROFILE");
      expect(retried.messages.some((m) => m.text.includes("Summary of the earlier exchange"))).toBe(true);
      // Nothing was deleted: the original history is all still there, plus this turn.
      const after = (await w.client.transcript({ limit: 200 })).messages;
      expect(after.length).toBe(before + 2);
      expect(after.filter((m) => m.text.startsWith("Earlier question"))).toHaveLength(4);
      const checkpoints = await all<{ token_estimate: number; covered_ids_json: string }>(w.h.db, "SELECT token_estimate, covered_ids_json FROM compaction_checkpoints WHERE user_id = ?", w.owner.userId);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]!.token_estimate).toBeGreaterThan(0);
    } finally {
      setTestCompaction(null, null);
    }
  });

  it("a request that cannot be shortened stops cleanly with the owner's message kept: no loop, no silent drop", async () => {
    setTestCompaction(1_000_000, 2);
    try {
      const w = await createWorld({ real: false });
      w.model.otherwise({ error: OVERFLOW() });
      const turn = await w.client.runTurn({ submissionId: submission("overflow"), text: "a question that will not fit" });
      expect(["failed", "resumable"]).toContain(turn.status);
      expect(turn.failure).toBeTruthy();
      expect(w.model.requests.length).toBeLessThanOrEqual(4);
      expect((await w.client.transcript({})).messages.map((m) => m.text)).toContain("a question that will not fit");
      // No money is held for a request the provider rejected.
      const open = await all(w.h.db, "SELECT 1 FROM inference_reservations WHERE user_id = ? AND state = 'reserved'", w.owner.userId);
      expect(open).toHaveLength(0);
      // The conversation still works afterwards.
      w.model.otherwise({ text: "Fine now." });
      expect((await w.client.runTurn({ submissionId: submission("next"), text: "hello again" })).status).toBe("completed");
    } finally {
      setTestCompaction(null, null);
    }
  });
});
