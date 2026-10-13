/**
 * Board requests are identified by their request ID AND what they ask for (a fingerprint of the date, scope,
 * reason, brief, count, purpose, destination, kept options and shirts to avoid). On real local D1 with the
 * REAL owner's profile and imported inventory; the weather HTTP service is the labelled FakeWeatherProvider.
 *
 * Before the fingerprint, a retried request composed again (composition is not deterministic) and its
 * publication collided with its own earlier one, so the retry came back with no receipt; and the same
 * request ID sent with a different request silently returned the other request's board.
 */
import { describe, expect, it } from "vitest";
import { all, CommandError, first } from "@garderobe/domain";
import { DayBrief } from "@garderobe/contracts/ext/daily";
import { prepareBoard } from "../src/index.ts";
import { createDailyHarness, MILD_DAY, realOwner, syntheticOwner, system } from "./helpers.ts";

const DAY = "2026-09-16";

describe("one ownership rule: a request's key is claimed by the command that changes the board, and any other holder refuses it unchanged", () => {
  const TRIP = (tripId: string) => ({ tripId, name: "Synthetic trip holding the key", departsOn: "2026-09-20", returnsOn: "2026-09-21", destinations: [{ label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-20", to: "2026-09-21" }], source: { kind: "owner_statement", note: "synthetic" } });

  it("normal path: the publication itself claims `${id}:1` with the request's fingerprint", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const result = await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "rule-normal", nowMs: h.clock.now() });
    const row = await first<{ command_id: string; idempotency_key: string; payload_json: string }>(h.db, "SELECT command_id, idempotency_key, payload_json FROM commands WHERE user_id = ? AND idempotency_key LIKE 'rule-normal%'", owner.userId);
    expect(row!.idempotency_key).toBe("rule-normal:1");
    expect(row!.command_id).toBe(result.receipt!.commandId);
    expect(JSON.parse(row!.payload_json).requestFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a command of another kind under the request's later attempt key `${id}:2` does not claim a free request ID", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    await owner.exec("trip.create", TRIP("rule-second"), { idempotencyKey: "rule-second:2" });
    const result = await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "rule-second", nowMs: h.clock.now() });
    expect(result.receipt).not.toBeNull();
    const row = await first<{ idempotency_key: string }>(h.db, "SELECT idempotency_key FROM commands WHERE command_id = ?", result.receipt!.commandId);
    expect(row!.idempotency_key).toBe("rule-second:1");
  });

  it("key held by another kind of command before start: refused before anything is composed or recorded", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    await owner.exec("trip.create", TRIP("rule-before"), { idempotencyKey: "rule-before:1" });
    const commands = async () => (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n;
    const before = await commands();
    let forecasts = 0;
    // TEST FAKE wrapper over the labelled FakeWeatherProvider: counts forecast fetches (none may happen).
    const p = h.deps.weather!.provider;
    const weather = { ...h.deps.weather!, provider: Object.assign(Object.create(p), { forecast: (r: any) => { forecasts++; return p.forecast(r); } }) };
    await expect(prepareBoard({ ...h.deps, weather }, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "rule-before", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    expect(forecasts).toBe(0);
    expect(await commands()).toBe(before);
  });

  it("empty composition: a key claimed by another kind of command while composing is refused, not answered as an empty board", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    // Labelled synthetic owner with no garments: composition has nothing to offer.
    const owner = await syntheticOwner(h, { garments: [] as never });
    h.weather.setForecast(DAY, MILD_DAY);
    // TEST FAKE wrapper over the labelled FakeWeatherProvider: another command claims the key during the forecast fetch.
    const p = h.deps.weather!.provider;
    const weather = { ...h.deps.weather!, provider: Object.assign(Object.create(p), { forecast: async (r: any) => { await owner.exec("trip.create", TRIP("rule-empty"), { idempotencyKey: "rule-empty:1" }).catch(() => undefined); return p.forecast(r); } }) };
    await expect(prepareBoard({ ...h.deps, weather }, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "rule-empty", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'board.publish'", owner.userId))!.n).toBe(0);
  });

  it("a claim taken while the owner's board is being kept and rechecked: refused, and the owner's board is not revised", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const owners = await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "rule-keep-owner", nowMs: h.clock.now() });
    const real = h.deps.commands;
    let claimed = false;
    // TEST FAKE at the command-service boundary: just before the keep-and-recheck publication, another kind of command claims its key.
    const commands = Object.assign(Object.create(real), {
      execute: async (principal: Parameters<typeof real.execute>[0], cmd: Parameters<typeof real.execute>[1]) => {
        if (cmd.type === "board.publish" && (cmd.payload as any).reason === "refresh" && cmd.idempotencyKey === "rule-keep:1" && !claimed) {
          claimed = true;
          await owner.exec("trip.create", TRIP("rule-keep"), { idempotencyKey: "rule-keep:1" });
        }
        return real.execute(principal, cmd);
      },
    });
    await expect(prepareBoard({ ...h.deps, commands }, await system(h, owner), { localDate: DAY, purpose: "evening_compose", expectedBoardRevision: 0, idempotencyKey: "rule-keep", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    expect(claimed).toBe(true);
    const board = await first<{ current_revision: number }>(h.db, "SELECT current_revision FROM boards WHERE user_id = ? AND local_date = ?", owner.userId, DAY);
    expect(board!.current_revision).toBe(owners.board!.revision);
  });
});

describe("board request fingerprints", () => {
  it("a retried request is answered from what it published: the same board revision, its receipt marked replayed, no second publication", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const request = { localDate: DAY, purpose: "adhoc" as const, count: 3, idempotencyKey: "fingerprint-retry", nowMs: h.clock.now() };
    const firstRun = await prepareBoard(h.deps, owner.principal(), request);
    expect(firstRun.receipt).not.toBeNull();
    expect(firstRun.board!.options.length).toBeGreaterThan(0);
    const publications = async () => (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'board.publish'", owner.userId))!.n;
    const before = await publications();

    const retry = await prepareBoard(h.deps, owner.principal(), request);
    expect(retry.receipt?.commandId).toBe(firstRun.receipt!.commandId);
    expect(retry.receipt?.replayed).toBe(true);
    expect(retry.board!.revision).toBe(firstRun.board!.revision);
    expect(retry.board!.options.map((o) => o.optionId)).toEqual(firstRun.board!.options.map((o) => o.optionId));
    expect(retry.requestedCount).toBe(firstRun.requestedCount);
    expect(await publications()).toBe(before);
  });

  it("a retry after another request revised the board is answered with the board its own publication made, not the newer one", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const request = { localDate: DAY, purpose: "adhoc" as const, count: 3, idempotencyKey: "fingerprint-snapshot", nowMs: h.clock.now() };
    const firstRun = await prepareBoard(h.deps, owner.principal(), request);
    const newer = await prepareBoard(h.deps, owner.principal(), { ...request, count: 4, idempotencyKey: "fingerprint-snapshot-newer" });
    expect(newer.board!.revision).toBeGreaterThan(firstRun.board!.revision);

    const retry = await prepareBoard(h.deps, owner.principal(), request);
    expect(retry.receipt?.replayed).toBe(true);
    expect(retry.board!.revision).toBe(firstRun.board!.revision);
    expect(retry.board!.options.map((o) => o.optionId)).toEqual(firstRun.board!.options.map((o) => o.optionId));
  });

  it("two different requests sent at once under one request ID: exactly one publishes, the other is refused", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const results = await Promise.allSettled([3, 5].map((count) => prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count, idempotencyKey: "fingerprint-race", nowMs: h.clock.now() })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: "idempotency_key_reuse" });
    const published = (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'board.publish' AND idempotency_key LIKE 'fingerprint-race:%'", owner.userId))!.n;
    expect(published).toBe(1);
  });

  it("a different request that wins the request ID while this one's first attempt is refused as stale: this one's next attempt is refused, never published under another key", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const real = h.deps.commands;
    let injected = false;
    // TEST FAKE at the command-service boundary: on this request's first publication, the other request runs
    // to completion first, and this publication is then refused as if every candidate had gone stale.
    const commands = Object.assign(Object.create(real), {
      execute: async (principal: Parameters<typeof real.execute>[0], cmd: Parameters<typeof real.execute>[1]) => {
        if (cmd.type === "board.publish" && !injected && (cmd.payload as any).requestedCount === 3) {
          injected = true;
          await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 5, idempotencyKey: "fingerprint-stale-race", nowMs: h.clock.now() });
          throw new CommandError("precondition_failed", "TEST FAKE: every candidate went stale", { dropped: [{ violations: ["TEST FAKE"] }] });
        }
        return real.execute(principal, cmd);
      },
    });
    await expect(prepareBoard({ ...h.deps, commands }, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "fingerprint-stale-race", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    expect(injected).toBe(true);
    const keys = (await all<{ idempotency_key: string }>(h.db, "SELECT idempotency_key FROM commands WHERE user_id = ? AND type = 'board.publish' AND idempotency_key LIKE 'fingerprint-stale-race:%'", owner.userId)).map((r) => r.idempotency_key);
    expect(keys).toEqual(["fingerprint-stale-race:1"]);
  });

  it("a request whose every attempt is refused as stale while a different request wins the request ID ends refused, not as an ordinary empty result", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const real = h.deps.commands;
    let attempts = 0;
    // TEST FAKE at the command-service boundary: every publication of this request is refused as if all its
    // candidates had gone stale; during the first, the other request runs to completion.
    const commands = Object.assign(Object.create(real), {
      execute: async (principal: Parameters<typeof real.execute>[0], cmd: Parameters<typeof real.execute>[1]) => {
        if (cmd.type === "board.publish" && (cmd.payload as any).requestedCount === 3) {
          if (attempts++ === 0) await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 5, idempotencyKey: "fingerprint-stale-all", nowMs: h.clock.now() });
          throw new CommandError("precondition_failed", "TEST FAKE: every candidate went stale", { dropped: [{ violations: ["TEST FAKE"] }] });
        }
        return real.execute(principal, cmd);
      },
    });
    await expect(prepareBoard({ ...h.deps, commands }, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "fingerprint-stale-all", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    expect(attempts).toBe(3);
  });

  it("a request ID whose publication key is already held by another kind of command is refused, never answered with the current board", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    await owner.exec("trip.create", { tripId: "fingerprint-foreign", name: "Synthetic trip holding the key", departsOn: "2026-09-20", returnsOn: "2026-09-21", destinations: [{ label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-20", to: "2026-09-21" }], source: { kind: "owner_statement", note: "synthetic" } }, { idempotencyKey: "fingerprint-foreign:1" });
    await expect(prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "fingerprint-foreign", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'board.publish'", owner.userId))!.n).toBe(0);
  });

  it("a request ID taken by another kind of command while every attempt is refused as stale ends refused, not as an ordinary empty result", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const real = h.deps.commands;
    let attempts = 0;
    // TEST FAKE at the command-service boundary: every publication of this request is refused as stale; during
    // the first, a different kind of command commits under this request's first publication key.
    const commands = Object.assign(Object.create(real), {
      execute: async (principal: Parameters<typeof real.execute>[0], cmd: Parameters<typeof real.execute>[1]) => {
        if (cmd.type === "board.publish") {
          if (attempts++ === 0) await owner.exec("trip.create", { tripId: "fingerprint-foreign-late", name: "Synthetic trip taking the key", departsOn: "2026-09-20", returnsOn: "2026-09-21", destinations: [{ label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris", from: "2026-09-20", to: "2026-09-21" }], source: { kind: "owner_statement", note: "synthetic" } }, { idempotencyKey: "fingerprint-foreign-late:1" });
          throw new CommandError("precondition_failed", "TEST FAKE: every candidate went stale", { dropped: [{ violations: ["TEST FAKE"] }] });
        }
        return real.execute(principal, cmd);
      },
    });
    await expect(prepareBoard({ ...h.deps, commands }, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "fingerprint-foreign-late", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    expect(attempts).toBe(3);
  });

  it("keeping the owner's board publishes under the request's own key and fingerprint, so a retry is answered from it", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const owners = await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "fingerprint-owner-board", nowMs: h.clock.now() });
    expect(owners.receipt).not.toBeNull();
    // A scheduled run that composed over "no board yet": its publication is refused and the owner's board is kept and rechecked.
    const request = { localDate: DAY, purpose: "evening_compose" as const, expectedBoardRevision: 0, idempotencyKey: "fingerprint-keep", nowMs: h.clock.now() };
    const kept = await prepareBoard(h.deps, await system(h, owner), request);
    expect(kept.note).toMatch(/existing board was kept/);
    const rows = await all<{ command_id: string; payload_json: string }>(h.db, "SELECT command_id, payload_json FROM commands WHERE user_id = ? AND type = 'board.publish' AND idempotency_key LIKE 'fingerprint-keep%'", owner.userId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json).requestFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const keyed = await first<{ idempotency_key: string }>(h.db, "SELECT idempotency_key FROM commands WHERE command_id = ?", rows[0]!.command_id);
    expect(keyed!.idempotency_key).toBe("fingerprint-keep:1");
    expect(kept.receipt?.commandId).toBe(rows[0]!.command_id);
    expect(kept.board!.revision).toBe(Number((kept.receipt!.result as any).revision));

    const retry = await prepareBoard(h.deps, await system(h, owner), request);
    expect(retry.receipt?.commandId).toBe(rows[0]!.command_id);
    expect(retry.receipt?.replayed).toBe(true);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'board.publish' AND idempotency_key LIKE 'fingerprint-keep%'", owner.userId))!.n).toBe(1);
  });

  it("the same request ID with a different expected board revision is refused", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const request = { localDate: DAY, purpose: "evening_compose" as const, expectedBoardRevision: 0, idempotencyKey: "fingerprint-expected", nowMs: h.clock.now() };
    const firstRun = await prepareBoard(h.deps, await system(h, owner), request);
    expect(firstRun.receipt).not.toBeNull();
    await expect(prepareBoard(h.deps, await system(h, owner), { ...request, expectedBoardRevision: firstRun.board!.revision })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
  });

  it("a request answers with the revision it published even when another request publishes before it reads the board back", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const real = h.deps.commands;
    let injected = false;
    // TEST FAKE at the command-service boundary: right after this request's publication commits, another request publishes.
    const commands = Object.assign(Object.create(real), {
      execute: async (principal: Parameters<typeof real.execute>[0], cmd: Parameters<typeof real.execute>[1]) => {
        const receipt = await real.execute(principal, cmd);
        if (cmd.type === "board.publish" && !injected) {
          injected = true;
          await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 5, idempotencyKey: "fingerprint-pin-other", nowMs: h.clock.now() });
        }
        return receipt;
      },
    });
    const mine = await prepareBoard({ ...h.deps, commands }, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "fingerprint-pin", nowMs: h.clock.now() });
    expect(injected).toBe(true);
    const own = Number((mine.receipt!.result as any).revision);
    expect(mine.board!.revision).toBe(own);
    const current = await first<{ current_revision: number }>(h.db, "SELECT current_revision FROM boards WHERE user_id = ? AND local_date = ?", owner.userId, DAY);
    expect(current!.current_revision).toBeGreaterThan(own);
  });

  it("a publication recorded without a fingerprint is never taken for a request: reusing its ID is refused", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const real = h.deps.commands;
    // TEST FAKE at the command-service boundary: publishes as a build before fingerprints did (no requestFingerprint).
    const legacy = Object.assign(Object.create(real), {
      execute: async (principal: Parameters<typeof real.execute>[0], cmd: Parameters<typeof real.execute>[1]) => {
        if (cmd.type !== "board.publish") return real.execute(principal, cmd);
        const { requestFingerprint: _omitted, ...payload } = cmd.payload as Record<string, unknown>;
        return real.execute(principal, { ...cmd, payload });
      },
    });
    const request = { localDate: DAY, purpose: "adhoc" as const, count: 3, idempotencyKey: "fingerprint-legacy", nowMs: h.clock.now() };
    expect((await prepareBoard({ ...h.deps, commands: legacy }, owner.principal(), request)).receipt).not.toBeNull();
    await expect(prepareBoard(h.deps, owner.principal(), { ...request, location: { label: "Paris", latitude: 48.8534, longitude: 2.3488, timezone: "Europe/Paris" } as never })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
  });

  it("the same request ID with a different request is refused and changes nothing", async () => {
    const h = await createDailyHarness({ startAt: "2026-09-15T18:00:00Z", isolate: true });
    const owner = await realOwner(h);
    h.weather.setForecast(DAY, MILD_DAY);
    const firstRun = await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, idempotencyKey: "fingerprint-reuse", nowMs: h.clock.now() });
    expect(firstRun.receipt).not.toBeNull();
    const commands = async () => (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n;
    const before = await commands();

    await expect(prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 5, idempotencyKey: "fingerprint-reuse", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    await expect(prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 3, brief: DayBrief.parse({ text: "Dinner with friends tonight" }), idempotencyKey: "fingerprint-reuse", nowMs: h.clock.now() })).rejects.toMatchObject({ code: "idempotency_key_reuse" });
    expect(await commands()).toBe(before);

    // A new request ID for the different request is composed and published as usual.
    const other = await prepareBoard(h.deps, owner.principal(), { localDate: DAY, purpose: "adhoc", count: 5, idempotencyKey: "fingerprint-other", nowMs: h.clock.now() });
    expect(other.receipt).not.toBeNull();
    expect(other.board!.revision).toBeGreaterThan(firstRun.board!.revision);
  });
});
