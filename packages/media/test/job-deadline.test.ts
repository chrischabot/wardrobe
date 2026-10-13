import { describe, expect, it } from "vitest";
import { all, first } from "@garderobe/domain";
import type { BackgroundRemover } from "../src/index.ts";
import { runMediaJob } from "../src/jobs.ts";
import { execSystem } from "../src/exec.ts";
import type { Raster } from "../src/image/index.ts";
import { createMediaHarness } from "../src/testing/index.ts";

// A job whose provider never answers is given up at the runner deadline and reclaimed. SYNTHETIC TEST IMAGE
// on a synthetic fixture garment. The background remover is a TEST DOUBLE that never resolves; the lease is
// shortened to one second (TEST SETUP) so the normalization deadline (two lease periods) is two seconds.

/** SYNTHETIC TEST IMAGE: a block of colour on a patterned background, so the background remover is asked. */
function onPatternedBackground(size: number): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = x > size / 4 && x < (3 * size) / 4 && y > size / 4 && y < (3 * size) / 4;
      const v = ((x * 37 + y * 91) % 160) + 40;
      data[i] = inside ? 30 : v;
      data[i + 1] = inside ? 90 : (v * 3) % 255;
      data[i + 2] = inside ? 60 : (v * 7) % 255;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

describe("a job whose provider never answers", () => {
  it("is given up at its deadline, stops holding the lease, and is reclaimed by the next run", async () => {
    let asked = 0;
    const hanging: BackgroundRemover = { name: "test-double-hanging-remover", version: "0", remove: () => { asked++; return new Promise(() => undefined); } };
    const h = await createMediaHarness({ adapters: { backgroundRemover: hanging } });
    h.deps.limits = { jobLeaseSeconds: 1 };
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (job deadline)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    const job = () => first<{ state: string; attempts: number; lease_until: string | null; last_error: string | null }>(h.db, "SELECT state, attempts, lease_until, last_error FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId);

    const started = Date.now();
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(asked).toBe(1);
    const afterFirst = (await job())!;
    expect(afterFirst).toMatchObject({ state: "queued", attempts: 1, lease_until: null });
    expect(afterFirst.last_error).toMatch(/normalize job ran past its 2-second time limit/);

    // The next run reclaims it (a new attempt) rather than finding it held for ever.
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
    expect(asked).toBe(2);
    expect((await job())!).toMatchObject({ state: "queued", attempts: 2, lease_until: null });
  }, 30_000);

  it("a provider that answers only after the deadline changes nothing: the stale work can start no effect", async () => {
    let answer: (() => void) | undefined;
    // TEST DOUBLE: a background remover that answers (with something that is not a PNG) only when released.
    const late: BackgroundRemover = { name: "test-double-late-remover", version: "0", remove: () => new Promise((resolve) => (answer = () => resolve({ ok: true, png: new Uint8Array([1, 2, 3]) }))) };
    const h = await createMediaHarness({ adapters: { backgroundRemover: late } });
    h.deps.limits = { jobLeaseSeconds: 1 };
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (late provider)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    const snapshot = async () => ({
      commands: (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n,
      renditions: (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM media_renditions WHERE user_id = ?", owner.userId))!.n,
      objects: (await h.deps.bucket.list({ prefix: `u/${owner.userId}/` })).objects.length,
    });
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
    const before = await snapshot();
    answer!(); // the provider answers now, after the run was given up
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await snapshot()).toEqual(before);
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "queued", attempts: 1 });
  }, 30_000);

  it("a write whose run loses its lease while the write's intent is being registered never starts, and its intent is settled", async () => {
    const h = await createMediaHarness();
    h.deps.limits = { jobLeaseSeconds: 3 }; // renewal every second
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (paused intent registration)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached: () => void = () => undefined;
    const registering = new Promise<void>((resolve) => (reached = resolve));
    // TEST DOUBLE around the real local D1: the run's first write-intent insert waits until released, then runs for real.
    let paused = false;
    const realDb = h.rt.db;
    const db = new Proxy(realDb, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === "prepare") {
          return (sql: string) => {
            if (paused || !sql.includes("INSERT INTO media_write_intents")) return realDb.prepare(sql);
            paused = true;
            return { bind: (...params: unknown[]) => ({ run: async () => { reached(); await released; return realDb.prepare(sql).bind(...params).run(); } }) };
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    // TEST DOUBLE around the real local R2 bucket: records every put that starts.
    const puts: string[] = [];
    const bucket = new Proxy(h.deps.bucket, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === "put") return (k: string, ...rest: unknown[]) => { puts.push(String(k)); return (value as (...a: unknown[]) => unknown).call(target, k, ...rest); };
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const run = runMediaJob({ ...h.rt, db: db as typeof realDb, deps: { ...h.rt.deps, bucket } }, owner.userId, jobId);
    await registering; // the run is registering its first write
    // TEST SETUP: another runner reclaims the job meanwhile; the paused run's next renewal (within a second) finds it gone.
    await h.db.prepare("UPDATE media_jobs SET attempts = 2 WHERE user_id = ? AND job_id = ?").bind(owner.userId, jobId).run();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    release();
    await run;
    const intents = await all<{ object_key: string; settled_at: string | null }>(h.db, "SELECT object_key, settled_at FROM media_write_intents WHERE user_id = ? AND job_id = ? AND job_attempt = 1", owner.userId, jobId);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.settled_at).not.toBeNull(); // settled at once: it can never land later
    expect(puts).not.toContain(intents[0]!.object_key); // the write was never started
    expect(puts).toEqual([]);
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "running", attempts: 2 });
  }, 30_000);

  it("a run whose lease renewal finds the job reclaimed stops at once and changes nothing afterwards", async () => {
    let answer: (() => void) | undefined;
    let started: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => (started = resolve));
    // TEST DOUBLE: a background remover that says when it was asked and answers (with something that is not a PNG) only when released.
    const late: BackgroundRemover = { name: "test-double-late-remover", version: "0", remove: () => new Promise((resolve) => { answer = () => resolve({ ok: true, png: new Uint8Array([1, 2, 3]) }); started(); }) };
    const h = await createMediaHarness({ adapters: { backgroundRemover: late } });
    h.deps.limits = { jobLeaseSeconds: 3 };
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (lost lease)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    const run = runMediaJob(h.rt, owner.userId, jobId);
    await asked; // the run is waiting on its provider
    // TEST SETUP: another runner reclaimed the job (attempt 2) while this run waits on its provider.
    await h.db.prepare("UPDATE media_jobs SET attempts = 2 WHERE user_id = ? AND job_id = ?").bind(owner.userId, jobId).run();
    const commandsBefore = (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n;
    expect(await run).toBe("skipped"); // the next renewal (after a third of the lease) matched no row
    answer!();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", owner.userId))!.n).toBe(commandsBefore);
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "running", attempts: 2 });
  }, 30_000);

  it("a completion already under way when the deadline fires stands: a final attempt is not failed afterwards", async () => {
    const h = await createMediaHarness();
    h.deps.limits = { jobLeaseSeconds: 1 }; // normalization deadline: two seconds
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (completion at the deadline)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    // TEST SETUP: this is the job's last attempt, and its result command commits only after the deadline has fired.
    await h.db.prepare("UPDATE media_jobs SET max_attempts = 1 WHERE user_id = ? AND job_id = ?").bind(owner.userId, jobId).run();
    const execute = h.service.execute.bind(h.service);
    (h.service as { execute: typeof execute }).execute = async (principal, request) => {
      if (request.type === "media.record_normalization") await new Promise((resolve) => setTimeout(resolve, 2500));
      return execute(principal, request);
    };
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "succeeded", attempts: 1 });
    expect(await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'media.fail_job'", owner.userId)).toEqual({ n: 0 });
  }, 30_000);

  it("no effect starts once the clock has passed the deadline, even before the deadline's timer has fired", async () => {
    let answer: (() => void) | undefined;
    let started: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => (started = resolve));
    // TEST DOUBLE: a background remover that says when it was asked and answers (with something that is not a PNG) only when released.
    const late: BackgroundRemover = { name: "test-double-late-remover", version: "0", remove: () => new Promise((resolve) => { answer = () => resolve({ ok: true, png: new Uint8Array([1, 2, 3]) }); started(); }) };
    const h = await createMediaHarness({ adapters: { backgroundRemover: late } });
    h.deps.limits = { jobLeaseSeconds: 3 }; // normalization deadline: six seconds; renewal every second
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (deadline by the clock)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    const resultCommands = async () => (await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type IN ('media.record_normalization', 'media.complete_job')", owner.userId))!.n;
    const commandsBefore = await resultCommands();
    const renditionsBefore = await first(h.db, "SELECT COUNT(*) AS n FROM media_renditions WHERE user_id = ?", owner.userId);
    const run = runMediaJob(h.rt, owner.userId, jobId);
    await asked; // the run is waiting on its provider (so the lease stays held), until it reaches the
    // deadline, while far less real time passes, so the deadline's timer has not fired (as when work starves the timers).
    for (let i = 0; i < 3; i++) {
      h.clock.advance(1500);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    h.clock.advance(1500);
    answer!();
    expect(await run).toBe("retry");
    const row = await first<{ state: string; attempts: number; last_error: string | null }>(h.db, "SELECT state, attempts, last_error FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId);
    expect(row).toMatchObject({ state: "queued", attempts: 1 });
    expect(row!.last_error).toMatch(/time limit/);
    // The late answer led to no result command (recording the failed attempt is allowed) and no stored rendition.
    expect(await resultCommands()).toBe(commandsBefore);
    expect(await first(h.db, "SELECT COUNT(*) AS n FROM media_renditions WHERE user_id = ?", owner.userId)).toEqual(renditionsBefore);
  }, 30_000);

  it("a result command from an attempt that no longer holds the job is refused in its own commit and writes nothing", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (stale attempt)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    // TEST SETUP: the job is running under attempt 2; a runner of attempt 1 (whose lease lapsed) tries to finish it.
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 2, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(new Date(h.clock.now() + 60_000).toISOString(), owner.userId, jobId).run();
    for (const [type, payload] of [["media.fail_job", { jobId, attempt: 1, error: "stale" }], ["media.complete_job", { jobId, attempt: 1, result: {} }]] as const) {
      await expect(execSystem(h.rt, owner.userId, type, payload, `stale:${type}`)).rejects.toMatchObject({ code: "precondition_failed" });
    }
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "running", attempts: 2 });
    // The holder of the job's current attempt can still finish it.
    await execSystem(h.rt, owner.userId, "media.fail_job", { jobId, attempt: 2, error: "current" }, "current:fail");
    expect(await first(h.db, "SELECT state FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toMatchObject({ state: expect.stringMatching(/failed|dead/) });
  });

  it("a result command that names no attempt is refused: there is no unfenced form", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (no attempt)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 1, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(new Date(h.clock.now() + 60_000).toISOString(), owner.userId, jobId).run();
    for (const [type, payload] of [["media.fail_job", { jobId, error: "unfenced" }], ["media.complete_job", { jobId, result: {} }]] as const) {
      await expect(execSystem(h.rt, owner.userId, type, payload, `unfenced:${type}`)).rejects.toMatchObject({ code: "invalid_command" });
    }
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "running", attempts: 1 });
  });

  it("an effect that never settles holds the run for at most one lease after the deadline; the job is then reclaimed", async () => {
    const h = await createMediaHarness();
    h.deps.limits = { jobLeaseSeconds: 1 }; // normalization deadline two seconds, drain bound one second
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (effect that never settles)" });
    const jobId = (await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true })).jobId!;
    // TEST DOUBLE: storage whose writes never answer while the job runs.
    const real = h.deps.bucket;
    let hung = 0;
    h.deps.bucket = new Proxy(real, {
      get(target, key) {
        if (key === "put") return () => { hung++; return new Promise(() => undefined); };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const started = Date.now();
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("skipped");
    const took = Date.now() - started;
    expect(hung).toBeGreaterThan(0);
    expect(took).toBeGreaterThanOrEqual(2900);
    expect(took).toBeLessThan(8000);
    // Nothing was written to finish the job: it is left running under the lapsing lease, and the next run reclaims it.
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "running", attempts: 1 });
    h.deps.bucket = real;
    h.clock.advance(5_000);
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "succeeded", attempts: 2 });
  }, 30_000);
});
