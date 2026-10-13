import { describe, expect, it } from "vitest";
import { all, first, isCommandError, toInstant } from "@garderobe/domain";
import { execSystem } from "../src/exec.ts";
import type { DiscoveryProvider } from "../src/index.ts";
import { runMediaJob } from "../src/jobs.ts";
import { ABANDONED_WRITE_WATCH_MS, recordWriteIntent, settleWriteIntent, sweepAbandonedWrites, WriteCleanupInProgressError, writeSettleMs } from "../src/write-intents.ts";
import type { Raster } from "../src/image/index.ts";
import { createMediaHarness, syntheticShirt } from "../src/testing/index.ts";

// Review findings on the bounded drain and on browser-session accounting. SYNTHETIC TEST IMAGES on synthetic
// fixture garments, and test-record garments. The storage wrapper is a TEST DOUBLE around the real local R2
// bucket that only changes WHEN one write lands; the background remover and the search providers are TEST DOUBLES.

/** SYNTHETIC TEST IMAGE: a block of colour on a patterned background, so normalization writes several files. */
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

describe("a file write that lands after its run let the lease go", () => {
  it("is removed by the maintenance sweep even after the image was deleted and purged", async () => {
    const h = await createMediaHarness();
    h.deps.limits = { jobLeaseSeconds: 1 }; // TEST SETUP: normalization deadline two seconds, drain one second
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (late write)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true });
    const jobId = up.jobId!;

    // TEST DOUBLE: the first write of the run hangs until released, then lands for real.
    const real = h.deps.bucket;
    let release: (() => void) | undefined;
    let lateKey: string | undefined;
    let landed: Promise<unknown> | undefined;
    let hung = false;
    h.deps.bucket = new Proxy(real, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === "put" && !hung) {
          return (...args: Parameters<R2Bucket["put"]>) => {
            hung = true;
            lateKey = String(args[0]);
            const gate = new Promise<void>((resolve) => (release = resolve));
            landed = gate.then(() => real.put(...args));
            return landed;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    // The run is stopped at its deadline with the write still under way, waits one lease for it, then lets go.
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("skipped");
    expect(lateKey).toBeTruthy();
    expect(await all(h.db, "SELECT job_id, job_attempt, settled_at FROM media_write_intents WHERE user_id = ? AND object_key = ?", owner.userId, lateKey)).toEqual([{ job_id: jobId, job_attempt: 1, settled_at: null }]);

    // A newer attempt completes the image, the owner deletes it, and its files are purged.
    h.clock.advance(10_000);
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(await h.deps.bucket.head(lateKey!)).not.toBeNull(); // the newer attempt wrote the same file
    await owner.exec("media.delete_asset", { assetId: up.asset!.assetId });
    await h.settle(owner);
    expect(await real.head(lateKey!)).toBeNull();

    // The stopped run's write lands now: the deleted image's file is back in storage.
    release!();
    await landed;
    expect(await real.head(lateKey!)).not.toBeNull();
    h.deps.bucket = real;

    // Before any run could still be writing, the sweep leaves it; afterwards it removes it.
    expect((await sweepAbandonedWrites(h.rt)).removed).toBe(0);
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    expect((await sweepAbandonedWrites(h.rt)).removed).toBeGreaterThanOrEqual(1);
    expect(await real.head(lateKey!)).toBeNull();
    // Every write on that key has finished (each intent is settled), so nothing is left to watch.
    expect(await all(h.db, "SELECT 1 FROM media_write_intents WHERE user_id = ? AND object_key = ?", owner.userId, lateKey)).toEqual([]);
  }, 60_000);

  it("a write not known to have finished stays watched: each later landing is removed again, until a day has passed", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (unsettled write)" });
    const key = `u/${owner.userId}/assets/ast_watch/original-${"c".repeat(16)}.jpg`;
    // TEST SETUP: a write recorded by a run that stopped before the write said it had finished.
    await recordWriteIntent(h.rt, { userId: owner.userId, jobId: "job_stopped", attempt: 1 }, key);
    await h.deps.bucket.put(key, new Uint8Array([1, 2, 3]));
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    expect((await sweepAbandonedWrites(h.rt)).removed).toBe(1);
    expect(await h.deps.bucket.head(key)).toBeNull();
    expect(await all(h.db, "SELECT job_id FROM media_write_intents WHERE user_id = ? AND object_key = ?", owner.userId, key)).toEqual([{ job_id: "job_stopped" }]);
    // The write lands (again) later: the next sweep removes it again and keeps watching.
    await h.deps.bucket.put(key, new Uint8Array([1, 2, 3]));
    h.clock.advance(60_000);
    expect((await sweepAbandonedWrites(h.rt)).removed).toBe(1);
    expect(await h.deps.bucket.head(key)).toBeNull();
    expect(await all(h.db, "SELECT 1 FROM media_write_intents WHERE user_id = ? AND object_key = ?", owner.userId, key)).toHaveLength(1);
    // A day after the write began it can no longer land, and the watch ends.
    h.clock.advance(ABANDONED_WRITE_WATCH_MS);
    await sweepAbandonedWrites(h.rt);
    expect(await all(h.db, "SELECT 1 FROM media_write_intents WHERE user_id = ?", owner.userId)).toEqual([]);
  });

  it("a kept file with an unfinished write is removed once its image is gone and the late write lands", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (kept, then deleted)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.settle(owner);
    const { object_key: key } = (await first<{ object_key: string }>(h.db, "SELECT object_key FROM media_renditions WHERE user_id = ? AND kind != 'original' AND status != 'deleted' LIMIT 1", owner.userId))!;
    // TEST SETUP: a stopped run's write to the same (content-addressed) key that never said it finished.
    await recordWriteIntent(h.rt, { userId: owner.userId, jobId: "job_stopped", attempt: 1 }, key);
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    await sweepAbandonedWrites(h.rt);
    expect(await h.deps.bucket.head(key)).not.toBeNull(); // kept: a live record names it
    expect(await all(h.db, "SELECT job_id FROM media_write_intents WHERE user_id = ? AND object_key = ?", owner.userId, key)).toEqual([{ job_id: "job_stopped" }]);
    await owner.exec("media.delete_asset", { assetId: up.asset!.assetId });
    await h.settle(owner);
    expect(await h.deps.bucket.head(key)).toBeNull();
    await h.deps.bucket.put(key, new Uint8Array([9, 9, 9])); // the stopped run's write lands now
    await sweepAbandonedWrites(h.rt);
    expect(await h.deps.bucket.head(key)).toBeNull();
  });

  it("while a real sweep is removing a file no job can start writing it; afterwards writing is possible again", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (cleanup claim)" });
    const key = `u/${owner.userId}/assets/ast_claim/original-${"d".repeat(16)}.jpg`;
    // TEST SETUP: an abandoned write (never said it finished) whose file is in storage.
    await recordWriteIntent(h.rt, { userId: owner.userId, jobId: "job_old", attempt: 1 }, key);
    await h.deps.bucket.put(key, new Uint8Array([4, 5, 6]));
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    // TEST DOUBLE: storage whose delete is held until released (the real bucket deletes when released).
    const real = h.deps.bucket;
    let release: () => void = () => undefined;
    let deleting: () => void = () => undefined;
    const deleteStarted = new Promise<void>((resolve) => (deleting = resolve));
    h.deps.bucket = new Proxy(real, {
      get(target, k) {
        const value = Reflect.get(target, k, target) as unknown;
        if (k === "delete") return (...args: Parameters<R2Bucket["delete"]>) => { deleting(); return new Promise<void>((resolve) => (release = resolve)).then(() => real.delete(...args)); };
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const sweep = sweepAbandonedWrites(h.rt);
    await deleteStarted;
    // The removal is under way: a new writer of the key is refused and records nothing.
    await expect(recordWriteIntent(h.rt, { userId: owner.userId, jobId: "job_new", attempt: 1 }, key)).rejects.toBeInstanceOf(WriteCleanupInProgressError);
    expect(await all(h.db, "SELECT job_id FROM media_write_intents WHERE user_id = ?", owner.userId)).toEqual([{ job_id: "job_old" }]);
    release();
    expect((await sweep).removed).toBe(1);
    h.deps.bucket = real;
    expect(await real.head(key)).toBeNull();
    // The claim was released once the removal completed, and the key can be written again.
    expect(await all(h.db, "SELECT 1 FROM media_write_cleanups WHERE user_id = ?", owner.userId)).toEqual([]);
    await recordWriteIntent(h.rt, { userId: owner.userId, jobId: "job_new", attempt: 1 }, key);
  });

  it("a writer under a live lease is left alone, and a claim left by a stopped sweep lapses only after a day", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (live writer)" });
    const key = `u/${owner.userId}/assets/ast_live/original-${"e".repeat(16)}.jpg`;
    // TEST SETUP: a claim left by a sweep that stopped during its removal.
    await h.db.prepare("INSERT INTO media_write_cleanups (user_id, object_key, claimed_at, expires_at) VALUES (?, ?, ?, ?)").bind(owner.userId, key, h.clock.iso(), toInstant(h.clock.now() + ABANDONED_WRITE_WATCH_MS)).run();
    h.clock.advance(ABANDONED_WRITE_WATCH_MS - 60_000);
    await expect(recordWriteIntent(h.rt, { userId: owner.userId, jobId: "job_new", attempt: 1 }, key)).rejects.toBeInstanceOf(WriteCleanupInProgressError);
    h.clock.advance(61_000);
    await recordWriteIntent(h.rt, { userId: owner.userId, jobId: "job_new", attempt: 1 }, key);
    await h.deps.bucket.put(key, new Uint8Array([4, 5, 6]));
    // TEST SETUP: that writer's job is running under a live lease well past the intent's settle time.
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    await h.db.prepare("INSERT INTO media_jobs (user_id, job_id, kind, subject_id, dedupe_key, state, attempts, max_attempts, lease_until, payload_json, command_id, created_at, updated_at) VALUES (?, 'job_new', 'normalize', 'ast_live', 'claim-test', 'running', 1, 3, ?, '{}', 'cmd_test_setup', ?, ?)").bind(owner.userId, toInstant(h.clock.now() + 60_000), h.clock.iso(), h.clock.iso()).run();
    expect(await sweepAbandonedWrites(h.rt)).toEqual({ kept: 0, removed: 0 });
    expect(await h.deps.bucket.head(key)).not.toBeNull();
    // Once that lease lapses the file is removed.
    h.clock.advance(61_000);
    expect((await sweepAbandonedWrites(h.rt)).removed).toBe(1);
    expect(await h.deps.bucket.head(key)).toBeNull();
    expect(await all(h.db, "SELECT 1 FROM media_write_cleanups WHERE user_id = ?", owner.userId)).toEqual([]);
  });

  it("watched keys cannot crowd others out of a limited sweep: the least recently checked come first", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (fair sweep)" });
    const keys = ["f", "a", "b"].map((c, i) => `u/${owner.userId}/assets/ast_fair${i}/original-${c.repeat(16)}.jpg`);
    // TEST SETUP: the tests of this file share one database; intents left by earlier tests are cleared so the
    // batch holds only this test's keys.
    await h.db.prepare("DELETE FROM media_write_intents").run();
    // TEST SETUP: three abandoned writes that never said they finished, each with a file in storage.
    for (const key of keys) {
      await recordWriteIntent(h.rt, { userId: owner.userId, jobId: "job_stopped", attempt: 1 }, key);
      await h.deps.bucket.put(key, new Uint8Array([7]));
      h.clock.advance(1000);
    }
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    const present = async () => (await Promise.all(keys.map((k) => h.deps.bucket.head(k)))).map((o) => o !== null);
    expect((await sweepAbandonedWrites(h.rt, { limit: 2 })).removed).toBe(2);
    expect(await present()).toEqual([false, false, true]);
    // Every write lands again; the next limited sweep reaches the key the first one did not check.
    for (const key of keys) await h.deps.bucket.put(key, new Uint8Array([7]));
    h.clock.advance(60_000);
    expect((await sweepAbandonedWrites(h.rt, { limit: 2 })).removed).toBe(2);
    expect((await present())[2]).toBe(false);
    h.clock.advance(60_000);
    expect((await sweepAbandonedWrites(h.rt, { limit: 2 })).removed).toBe(1);
    expect(await present()).toEqual([false, false, false]);
  });

  it("keeps every file a live record names and drops its intents", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (kept writes)" });
    await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 256 }), demo: true });
    await h.settle(owner);
    const intents = await all<{ object_key: string }>(h.db, "SELECT DISTINCT object_key FROM media_write_intents WHERE user_id = ?", owner.userId);
    expect(intents.length).toBeGreaterThan(0);
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    expect(await sweepAbandonedWrites(h.rt)).toEqual({ kept: intents.length, removed: 0 });
    for (const { object_key } of intents) expect(await h.deps.bucket.head(object_key), object_key).not.toBeNull();
    expect(await all(h.db, "SELECT 1 FROM media_write_intents WHERE user_id = ?", owner.userId)).toEqual([]);
  });
});

describe("races between the sweep and late writes or results", () => {
  it("a job result naming a file under removal is refused in its commit; the job then succeeds once the removal is over", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (fenced result)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true });
    // TEST DOUBLE: storage that, after the job's first write lands, has the sweep claim that file (as if it were
    // removing a stale copy) before the job's result command commits.
    const real = h.deps.bucket;
    let claimed: string | undefined;
    h.deps.bucket = new Proxy(real, {
      get(target, k) {
        const value = Reflect.get(target, k, target) as unknown;
        if (k === "put" && !claimed) {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            const out = await real.put(...args);
            claimed = String(args[0]);
            await h.db.prepare("INSERT INTO media_write_cleanups (user_id, object_key, claimed_at, expires_at) VALUES (?, ?, ?, ?)").bind(owner.userId, claimed, h.clock.iso(), toInstant(h.clock.now() + 60_000)).run();
            return out;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(await runMediaJob(h.rt, owner.userId, up.jobId!)).toBe("retry");
    h.deps.bucket = real;
    expect(claimed).toBeTruthy();
    expect(await all(h.db, "SELECT 1 FROM media_renditions WHERE user_id = ? AND object_key = ?", owner.userId, claimed)).toEqual([]);
    // TEST SETUP: the removal finished and its claim was released.
    await h.db.prepare("DELETE FROM media_write_cleanups WHERE user_id = ?").bind(owner.userId).run();
    h.clock.advance(10_000);
    expect(await runMediaJob(h.rt, owner.userId, up.jobId!)).toBe("succeeded");
    expect(await all(h.db, "SELECT 1 FROM media_renditions WHERE user_id = ? AND object_key = ? AND status = 'active'", owner.userId, claimed)).toHaveLength(1);
    expect(await real.head(claimed!)).not.toBeNull();
  }, 60_000);

  it("a write that lands and settles while the sweep checks the key stays tracked and is removed by the next sweep", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (settles during check)" });
    const key = `u/${owner.userId}/assets/ast_mid/original-${"7".repeat(16)}.jpg`;
    const w = { userId: owner.userId, jobId: "job_stopped", attempt: 1 };
    const writeId = await recordWriteIntent(h.rt, w, key);
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    // TEST DOUBLE: while the sweep looks the key up (nothing there yet), the stopped run's write lands and says it finished.
    const real = h.deps.bucket;
    h.deps.bucket = new Proxy(real, {
      get(target, k) {
        const value = Reflect.get(target, k, target) as unknown;
        if (k === "head") {
          return async (...args: Parameters<R2Bucket["head"]>) => {
            const found = await real.head(...args);
            if (String(args[0]) === key) {
              await real.put(key, new Uint8Array([1]));
              await settleWriteIntent(h.rt, w, key, writeId);
            }
            return found;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await sweepAbandonedWrites(h.rt);
    h.deps.bucket = real;
    expect(await real.head(key)).not.toBeNull(); // landed after the check
    expect(await all(h.db, "SELECT write_id FROM media_write_intents WHERE user_id = ? AND object_key = ?", owner.userId, key)).toEqual([{ write_id: writeId }]);
    h.clock.advance(60_000);
    expect((await sweepAbandonedWrites(h.rt)).removed).toBe(1);
    expect(await real.head(key)).toBeNull();
    expect(await all(h.db, "SELECT 1 FROM media_write_intents WHERE user_id = ? AND object_key = ?", owner.userId, key)).toEqual([]);
  });

  it("two overlapping writes of one key by one attempt are tracked separately: settling one leaves the other watched", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (overlapping writes)" });
    const key = `u/${owner.userId}/assets/ast_twice/original-${"8".repeat(16)}.jpg`;
    const w = { userId: owner.userId, jobId: "job_twice", attempt: 1 };
    const firstWrite = await recordWriteIntent(h.rt, w, key);
    const secondWrite = await recordWriteIntent(h.rt, w, key);
    expect(firstWrite).not.toBe(secondWrite);
    await h.deps.bucket.put(key, new Uint8Array([1]));
    await settleWriteIntent(h.rt, w, key, firstWrite); // only the first says it finished
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    expect((await sweepAbandonedWrites(h.rt)).removed).toBe(1);
    expect(await all(h.db, "SELECT write_id, settled_at FROM media_write_intents WHERE user_id = ? AND object_key = ?", owner.userId, key)).toEqual([{ write_id: secondWrite, settled_at: null }]);
  });

  it("a late result from a run whose file was removed is refused even after the removal finished and its claim was released", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (swept attempt)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true });
    const jobId = up.jobId!;
    // TEST SETUP: the job's first attempt claimed it, wrote a file and stopped; its lease has lapsed but nobody reclaimed it.
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 1, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() + 1000), owner.userId, jobId).run();
    const key = `u/${owner.userId}/assets/${up.asset!.assetId}/catalogue-v9-${"9".repeat(16)}.webp`;
    await recordWriteIntent(h.rt, { userId: owner.userId, jobId, attempt: 1 }, key);
    await h.deps.bucket.put(key, new Uint8Array([1]));
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    expect((await sweepAbandonedWrites(h.rt)).removed).toBe(1);
    expect(await all(h.db, "SELECT 1 FROM media_write_cleanups WHERE user_id = ?", owner.userId)).toEqual([]);
    expect(await all(h.db, "SELECT job_attempt FROM media_swept_attempts WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual([{ job_attempt: 1 }]);
    // The stopped run's result arrives now: refused in its commit, nothing written.
    const late = await execSystem(h.rt, owner.userId, "media.complete_job", { jobId, attempt: 1, result: { late: true } }, "late-result-after-sweep").then(() => "ok", (e) => (isCommandError(e) ? e.code : String(e)));
    expect(late).toBe("precondition_failed");
    expect(await first(h.db, "SELECT state FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "running" });
    // A new attempt is not affected, and the swept record is pruned once its attempt is superseded.
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    await sweepAbandonedWrites(h.rt);
    expect(await all(h.db, "SELECT 1 FROM media_swept_attempts WHERE user_id = ?", owner.userId)).toEqual([]);
  }, 60_000);

  it("an exhausted attempt that was swept is still abandoned, never run beyond its attempt limit", async () => {
    const h = await createMediaHarness();
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (swept exhausted attempt)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: onPatternedBackground(160), demo: true });
    const jobId = up.jobId!;
    // TEST SETUP: the job's only allowed attempt claimed it, wrote a file and vanished.
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 1, max_attempts = 1, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() + 1000), owner.userId, jobId).run();
    const key = `u/${owner.userId}/assets/${up.asset!.assetId}/catalogue-v9-${"8".repeat(16)}.webp`;
    await recordWriteIntent(h.rt, { userId: owner.userId, jobId, attempt: 1 }, key);
    await h.deps.bucket.put(key, new Uint8Array([1]));
    h.clock.advance(writeSettleMs(h.rt) + 1000);
    expect((await sweepAbandonedWrites(h.rt)).removed).toBe(1);
    expect(await all(h.db, "SELECT job_attempt FROM media_swept_attempts WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual([{ job_attempt: 1 }]);
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("dead");
    expect(await first(h.db, "SELECT state, attempts FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId)).toEqual({ state: "dead", attempts: 1 });
    // The swept attempt's own late result stays refused.
    const late = await execSystem(h.rt, owner.userId, "media.complete_job", { jobId, attempt: 1, result: { late: true } }, "late-result-after-abandon").then(() => "ok", (e) => (isCommandError(e) ? e.code : String(e)));
    expect(late).toBe("precondition_failed");
  }, 60_000);
});

describe("a browser search that fails without saying what it used", () => {
  it("is charged every session it reserved, so the garment's two-session allowance is not opened again", async () => {
    let reservedDuringSearch: unknown;
    let identifierCalls = 0;
    const h0: { db?: D1Database; userId?: string } = {};
    // TEST DOUBLES: a browser catalogue search that throws after looking at its own claim, and a browser identifier search.
    const throwing: DiscoveryProvider = {
      name: "test-double-throwing-browser", strategies: ["maker_catalogue"], usesBrowser: true,
      async search() {
        reservedDuringSearch = await first(h0.db!, "SELECT browser_sessions, settled_at FROM media_browser_reservations WHERE user_id = ?", h0.userId);
        throw new Error("the browser crashed (test double)");
      },
    };
    const identifier: DiscoveryProvider = { name: "test-double-identifier-browser", strategies: ["identifier_search"], usesBrowser: true, async search() { identifierCalls++; return { pages: [], browserSessions: 1, browserSeconds: 30 }; } };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [throwing, identifier] } });
    const owner = await h.createOwner({ synthetic: false, displayName: "Session charge owner (test records only)" });
    Object.assign(h0, { db: h.db, userId: owner.userId });
    await owner.exec("settings.update", { patch: { extensions: { media: { browserMinutesPerDay: 9, interactiveReserveMinutesPerDay: 5 } } } });
    await owner.exec("garment.create", { garmentId: "s-1", name: "test record s-1", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", aliases: [{ phrase: "PCF7701", kind: "code" }], source: { kind: "system", note: "test record" } });
    await owner.exec("media.request_discovery", { garmentIds: ["s-1"] });
    await h.settle(owner);
    // While the search ran, its claim held both sessions; once it threw, both were charged to its attempt.
    expect(reservedDuringSearch).toEqual({ browser_sessions: 2, settled_at: null });
    expect(await all(h.db, "SELECT strategy, browser_sessions, outcome FROM media_discovery_attempts WHERE user_id = ? AND garment_id = 's-1'", owner.userId)).toEqual([{ strategy: "maker_catalogue", browser_sessions: 2, outcome: "provider_error" }]);
    // The identifier search had no session left to open.
    expect(identifierCalls).toBe(0);
    // With no session left the failure is final: the investigation concludes instead of being deferred for ever.
    const media = await first<{ discovery_json: string }>(h.db, "SELECT discovery_json FROM garment_media WHERE user_id = ? AND garment_id = 's-1'", owner.userId);
    expect(JSON.parse(media!.discovery_json).conclusion).not.toBe("deferred");
    expect(await all(h.db, "SELECT 1 FROM media_jobs WHERE user_id = ? AND kind = 'discover' AND state IN ('queued', 'running')", owner.userId)).toEqual([]);
  });

  it("a search interrupted when its run stopped is charged every session it reserved when the claim is recovered", async () => {
    let identifierCalls = 0;
    // TEST DOUBLES: a browser catalogue search that never answers, and a browser identifier search.
    const hanging: DiscoveryProvider = { name: "test-double-hanging-browser", strategies: ["maker_catalogue"], usesBrowser: true, search: () => new Promise(() => undefined) };
    const identifier: DiscoveryProvider = { name: "test-double-identifier-browser", strategies: ["identifier_search"], usesBrowser: true, async search() { identifierCalls++; return { pages: [], browserSessions: 1, browserSeconds: 30 }; } };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [hanging, identifier] } });
    h.deps.limits = { jobLeaseSeconds: 1 }; // TEST SETUP: discovery deadline three seconds
    const owner = await h.createOwner({ synthetic: false, displayName: "Interrupted session owner (test records only)" });
    await owner.exec("settings.update", { patch: { extensions: { media: { browserMinutesPerDay: 9, interactiveReserveMinutesPerDay: 5 } } } });
    await owner.exec("garment.create", { garmentId: "s-2", name: "test record s-2", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", aliases: [{ phrase: "PCF7702", kind: "code" }], source: { kind: "system", note: "test record" } });
    await owner.exec("media.request_discovery", { garmentIds: ["s-2"] });
    const jobId = (await first<{ job_id: string }>(h.db, "SELECT job_id FROM media_jobs WHERE user_id = ? AND subject_id = 's-2'", owner.userId))!.job_id;
    // The run is given up at its deadline during the search: its claim is left unsettled, holding both sessions.
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
    expect(await all(h.db, "SELECT browser_sessions, settled_at FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toEqual([{ browser_sessions: 2, settled_at: null }]);
    // The next run recovers the interrupted claim (without searching again) and charges both sessions.
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(await all(h.db, "SELECT strategy, browser_sessions FROM media_discovery_attempts WHERE user_id = ? AND garment_id = 's-2'", owner.userId)).toEqual([{ strategy: "maker_catalogue", browser_sessions: 2 }]);
    expect(identifierCalls).toBe(0);
  }, 30_000);
});
