import { beforeAll, describe, expect, it } from "vitest";
import { all, first } from "@garderobe/domain";
import { handleMediaQueue, runQueuedMediaJobs } from "../src/index.ts";
import { createMediaHarness, syntheticShirt, syntheticTrousers, type MediaHarness } from "../src/testing/index.ts";

// Regression tests for the media job runner under abuse of the queue.
// SYNTHETIC TEST IMAGES on synthetic fixture garments (labelled demo placeholders).
// Real: the command service, local D1, local R2, and for the first case the local queue with its consumer.
// TEST SETUP: a job is put into the state an isolate leaves behind when it dies holding the lease by editing
// its row; no request can produce that state. The second case hands the consumer function a STAND-IN batch
// object (in place of the queue's delivery) so that each message's acknowledgement can be observed.

interface JobState {
  state: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

describe("the media job runner under queue abuse", () => {
  let h: MediaHarness;
  const jobOf = async (userId: string, jobId: string) => (await first<JobState>(h.db, "SELECT state, attempts, max_attempts, last_error FROM media_jobs WHERE user_id = ? AND job_id = ?", userId, jobId))!;
  const results = async (userId: string) => (await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = 'media.record_normalization'", userId)).length;
  const leaveAsCrashed = (userId: string, jobId: string) =>
    h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = max_attempts, lease_until = '2000-01-01T00:00:00.000Z', last_error = NULL, result_json = NULL WHERE user_id = ? AND job_id = ?").bind(userId, jobId).run();

  beforeAll(async () => {
    h = await createMediaHarness();
  });

  // A job whose attempts all ended without reporting back (the isolate ran out of memory or time while it
  // held the lease) used to be started again by every redelivery and every sweep, without end.
  it("a job whose every attempt died is recorded as failed and not started again, by the queue or by the sweep", async () => {
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (crashed jobs)" });
    const viaQueue = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    const viaSweep = await h.upload(owner, { garmentId: "trouser-olive", raster: syntheticTrousers({ size: 128 }), demo: true });
    await h.settle(owner);
    const before = await results(owner.userId);
    expect(before).toBeGreaterThan(0);

    // Redelivered by the real local queue.
    await leaveAsCrashed(owner.userId, viaQueue.jobId!);
    await h.bindings.MEDIA_QUEUE!.send({ kind: "media.job", userId: owner.userId, jobId: viaQueue.jobId! });
    let job = await jobOf(owner.userId, viaQueue.jobId!);
    for (let i = 0; i < 400 && job.state === "running"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      job = await jobOf(owner.userId, viaQueue.jobId!);
    }
    expect(job.state).toBe("dead");
    expect(job.attempts).toBe(job.max_attempts); // no further attempt was started
    expect(job.last_error).toMatch(/^abandoned after \d+ attempts that started and never finished$/);

    // Picked up by the scheduled sweep.
    await leaveAsCrashed(owner.userId, viaSweep.jobId!);
    expect(await runQueuedMediaJobs(h.rt, { userId: owner.userId })).toEqual({ succeeded: 0, skipped: 0, retry: 0, dead: 1 });
    expect(await jobOf(owner.userId, viaSweep.jobId!)).toMatchObject({ state: "dead", attempts: job.max_attempts });
    // A further sweep finds nothing to run, and the work itself never ran again.
    expect(await runQueuedMediaJobs(h.rt, { userId: owner.userId })).toEqual({ succeeded: 0, skipped: 0, retry: 0, dead: 0 });
    expect(await results(owner.userId)).toBe(before);
    // The failure is told on the image rather than hidden.
    expect((await first<{ status_reason: string }>(h.db, "SELECT status_reason FROM media_assets WHERE user_id = ? AND asset_id = ?", owner.userId, viaQueue.asset!.assetId))!.status_reason).toMatch(/did not complete: abandoned/);
  });

  it("messages whose identifiers could not name a job are dropped without a lookup; unknown ones are skipped; none is retried", async () => {
    const owner = await h.createSyntheticOwner({ displayName: "Synthetic owner (poison messages)" });
    const up = await h.upload(owner, { garmentId: "shirt-moss", raster: syntheticShirt({ size: 128 }), demo: true });
    await h.settle(owner);
    const u = owner.userId;
    const j = up.jobId!;
    const before = JSON.stringify(await all(h.db, "SELECT job_id, state, attempts FROM media_jobs ORDER BY user_id, job_id"));
    const malformed: unknown[] = [
      null,
      "media.job",
      [],
      Object.assign([], { kind: "media.job", userId: u, jobId: j }),
      { kind: "media.job", userId: u },
      { kind: "media.job", userId: 7, jobId: j },
      { kind: "other.job", userId: u, jobId: j },
      { kind: "media.job", userId: "", jobId: j },
      { kind: "media.job", userId: ` ${u}`, jobId: j },
      { kind: "media.job", userId: u, jobId: `${j}\n` },
      { kind: "media.job", userId: `${u}\u0000`, jobId: j },
      { kind: "media.job", userId: u, jobId: "y".repeat(201) },
      { kind: "media.job", userId: "x".repeat(50_000), jobId: j },
    ];
    const unknown: unknown[] = [
      { kind: "media.job", userId: "usr_doesnotexist", jobId: j },
      { kind: "media.job", userId: u, jobId: "job_doesnotexist" },
      { kind: "media.job", userId: "' OR 1=1 --".replace(/ /g, "/**/"), jobId: "%" },
      { kind: "media.job", userId: u, jobId: j }, // a finished job, replayed
    ];
    const acked: number[] = [];
    const retried: number[] = [];
    // STAND-IN for the queue's delivery object, so that ack and retry can be observed per message.
    const batch = {
      queue: "garderobe-media-test",
      messages: [...malformed, ...unknown].map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body, ack: () => void acked.push(i), retry: () => void retried.push(i) })),
      ackAll() {},
      retryAll() {},
    } as unknown as MessageBatch<unknown>;
    const outcome = await handleMediaQueue(h.rt, batch);
    expect(outcome.results).toEqual({ succeeded: 0, skipped: unknown.length, retry: 0, dead: 0, malformed: malformed.length });
    expect(acked).toEqual([...malformed, ...unknown].map((_, i) => i));
    expect(retried).toEqual([]);
    expect(JSON.stringify(await all(h.db, "SELECT job_id, state, attempts FROM media_jobs ORDER BY user_id, job_id"))).toBe(before);
  });
});
