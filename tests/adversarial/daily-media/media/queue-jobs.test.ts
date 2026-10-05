/**
 * Media abuse: the job queue - poison messages, replayed and duplicated deliveries, messages that name
 * another owner's job, jobs whose every attempt died, and a job row that names another owner's files.
 *
 * Specification section 4 ("D1 changes feed a transactional projection outbox, delivered through Queues
 * to index and media jobs"), section 11 (derived files are written once per source; deletion removes the
 * stored files), section 15 (every stored path is scoped to one owner).
 *
 * Real: the Worker's own queue consumer inside workerd, fed through the real local queue binding the Worker
 * itself produces to; local D1; the private local R2 bucket; the upload, preview and deletion routes over
 * HTTP. Stand-ins: test-signed sign-in assertions in place of Cloudflare Access.
 *
 * Messages are put on the queue directly, as a redelivery, a duplicate or a foreign producer would. Three
 * cases need a state no request can create (an isolate that died holding a job, a corrupted job row, an
 * account disabled while work was queued); each says "TEST SETUP" where it edits a row in D1 to get there.
 * Owners, garments and pictures are SYNTHETIC test fixtures.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { testApp } from "@garderobe/worker/testing";
import { attemptUpload, cleanPng, mediaFingerprint, objectKeys, rows, settleJobs, syntheticOwner, uploadClean, type AbuseOwner } from "./support.ts";

interface Job {
  job_id: string;
  kind: string;
  state: string;
  attempts: number;
  max_attempts: number;
  subject_id: string;
  last_error: string | null;
}

let victim: AbuseOwner;
let attacker: AbuseOwner;
let sentinel: AbuseOwner;
let victimAsset: string;
let colour = 10;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jobsOf = (userId: string) => rows<Job>("SELECT job_id, kind, state, attempts, max_attempts, subject_id, last_error FROM media_jobs WHERE user_id = ? ORDER BY created_at, job_id", userId);
const jobOf = async (userId: string, jobId: string) => (await rows<Job>("SELECT job_id, kind, state, attempts, max_attempts, subject_id, last_error FROM media_jobs WHERE user_id = ? AND job_id = ?", userId, jobId))[0]!;
const freshPng = (size = 128) => cleanPng(size, [(colour += 23) % 200, (colour * 3) % 200, (colour * 7) % 200]);

/** Put bodies on the real queue, one message each. Returns how many the queue accepted. */
async function deliver(bodies: unknown[]): Promise<number> {
  const queue = (await testApp()).env.MEDIA_QUEUE!;
  let accepted = 0;
  for (const body of bodies) {
    try {
      await queue.send(body as never);
      accepted++;
    } catch {
      /* the queue itself refused the body: it never reaches the consumer */
    }
  }
  return accepted;
}

/**
 * The consumer has worked through what was sent before this call and is still working: a new picture sent
 * afterwards is processed to the end by the same consumer.
 */
async function consumerCaughtUp(what: string): Promise<void> {
  await pause(500);
  const probe = await uploadClean(sentinel, await freshPng(96), { intent: "attachment" });
  const job = (await jobsOf(sentinel.owner.userId)).find((j) => j.subject_id === probe.assetId && j.kind === "normalize");
  expect(job, what).toMatchObject({ state: "succeeded", attempts: 1 });
  await pause(250);
}

async function waitForJob(userId: string, jobId: string, done: (job: Job) => boolean, what: string): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const job = await jobOf(userId, jobId);
    if (done(job)) return job;
    await pause(50);
  }
  throw new Error(`${what}: the job did not get there (${JSON.stringify(await jobOf(userId, jobId))})`);
}

/** A picture uploaded and then deleted: leaves a finished removal job behind. */
async function uploadAndDelete(o: AbuseOwner): Promise<string> {
  const doomed = await uploadClean(o, await freshPng(), { intent: "attachment" });
  const deleted = await o.owner.api.command("media.delete_asset", { assetId: doomed.assetId });
  expect(deleted.status, await deleted.clone().text()).toBe(200);
  await settleJobs(o.owner.userId);
  return doomed.assetId;
}

beforeAll(async () => {
  victim = await syntheticOwner("QV");
  attacker = await syntheticOwner("QA");
  sentinel = await syntheticOwner("QS");
  // The victim ends up with one finished job of each kind the queue carries for an owner's own pictures.
  victimAsset = (await uploadClean(victim, await freshPng(192))).assetId;
  await victim.owner.api.json("POST", "/v1/studio/previews", { clientRequestId: `queue-preview-${crypto.randomUUID()}`, slots: victim.slots() });
  await settleJobs(victim.owner.userId);
  await uploadAndDelete(victim);
  await uploadClean(attacker, await freshPng(160), { role: "top" });
  await uploadAndDelete(attacker);
  const kinds = new Set((await jobsOf(victim.owner.userId)).map((j) => j.kind));
  for (const kind of ["normalize", "render_composite", "purge_objects"]) expect(kinds.has(kind), kind).toBe(true);
  for (const job of [...(await jobsOf(victim.owner.userId)), ...(await jobsOf(attacker.owner.userId))]) expect(job.state, job.kind).toBe("succeeded");
});

describe("poison messages", () => {
  it("messages that are not jobs, or name jobs and owners that do not exist, are dropped: nothing changes and the queue keeps working", async () => {
    const before = { victim: await mediaFingerprint(victim.owner.userId), attacker: await mediaFingerprint(attacker.owner.userId) };
    const totals = async () => ({ users: (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM users"))[0]!.n, jobs: (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM media_jobs WHERE user_id NOT IN (?)", sentinel.owner.userId))[0]!.n });
    const totalsBefore = await totals();
    const u = victim.owner.userId;
    const j = (await jobsOf(u))[0]!.job_id;
    const victimKeys = await objectKeys(u);
    const poison: unknown[] = [
      null,
      0,
      true,
      "",
      "media.job",
      JSON.stringify({ kind: "media.job", userId: u, jobId: j }), // a job, but as text
      [],
      [{ kind: "media.job", userId: u, jobId: j }],
      {},
      { kind: "media.job" },
      { kind: "media.job", userId: u },
      { kind: "media.job", jobId: j },
      { kind: "media.job", userId: 7, jobId: true },
      { kind: "media.job", userId: null, jobId: null },
      { kind: "media.job", userId: [u], jobId: [j] },
      { kind: "media.job", userId: { $ne: null }, jobId: { $ne: null } },
      { kind: "other.job", userId: u, jobId: j },
      { kind: "MEDIA.JOB", userId: u, jobId: j },
      { kind: "media.job", userId: "' OR 1=1 --", jobId: "' OR 1=1 --" },
      { kind: "media.job", userId: `${u}' OR '1'='1`, jobId: `${j}' OR '1'='1` },
      { kind: "media.job", userId: "%", jobId: "%" },
      { kind: "media.job", userId: u, jobId: "%" },
      { kind: "media.job", userId: "*", jobId: "*" },
      { kind: "media.job", userId: "", jobId: "" },
      { kind: "media.job", userId: "usr_doesnotexist0000000000", jobId: "job_doesnotexist0000000000" },
      { kind: "media.job", userId: u, jobId: "job_doesnotexist0000000000" },
      { kind: "media.job", userId: `${u}\u0000`, jobId: `${j}\u0000` },
      { kind: "media.job", userId: ` ${u} `, jobId: ` ${j} ` },
      { kind: "media.job", userId: u.toUpperCase(), jobId: j.toUpperCase() },
      { kind: "media.job", userId: "x".repeat(40_000), jobId: "y".repeat(40_000) },
      JSON.parse(`{"__proto__":{"kind":"media.job","userId":"${u}","jobId":"${j}"}}`),
      // A real, finished job with instructions smuggled alongside: only the two identifiers are ever read.
      { kind: "media.job", userId: u, jobId: j, jobKind: "purge_objects", state: "queued", payload: { keys: victimKeys }, keys: victimKeys },
    ];
    expect(await deliver(poison)).toBeGreaterThan(20);
    await consumerCaughtUp("after the poison messages");

    expect(await mediaFingerprint(victim.owner.userId)).toBe(before.victim);
    expect(await mediaFingerprint(attacker.owner.userId)).toBe(before.attacker);
    expect(await totals()).toEqual(totalsBefore); // no owner and no job came into being
    expect(await objectKeys(u)).toEqual(victimKeys);
    const served = await victim.owner.api.get(`/v1/media/assets/${victimAsset}`);
    expect(served.status).toBe(200);
    await served.arrayBuffer();
  });
});

describe("replayed and duplicated deliveries", () => {
  it("replaying finished jobs, alone or under another owner's name, runs nothing again", async () => {
    const before = { victim: await mediaFingerprint(victim.owner.userId), attacker: await mediaFingerprint(attacker.owner.userId) };
    const victims = await jobsOf(victim.owner.userId);
    const attackers = await jobsOf(attacker.owner.userId);
    const messages: unknown[] = [];
    for (let round = 0; round < 3; round++) {
      for (const job of victims) messages.push({ kind: "media.job", userId: victim.owner.userId, jobId: job.job_id });
      // The victim's job under the attacker's name, and the attacker's job under the victim's name.
      for (const job of victims) messages.push({ kind: "media.job", userId: attacker.owner.userId, jobId: job.job_id });
      for (const job of attackers) messages.push({ kind: "media.job", userId: victim.owner.userId, jobId: job.job_id });
    }
    expect(await deliver(messages)).toBe(messages.length);
    await consumerCaughtUp("after the replays");
    // The fingerprint holds every record, every stored file, every job's state and attempt count, and the
    // number of commands: a job that ran again in any way would change it.
    expect(await mediaFingerprint(victim.owner.userId)).toBe(before.victim);
    expect(await mediaFingerprint(attacker.owner.userId)).toBe(before.attacker);
  });

  it("replaying the jobs of a deleted picture does not bring its files back", async () => {
    const doomed = await uploadClean(victim, await freshPng(), { intent: "attachment" });
    const normalize = (await jobsOf(victim.owner.userId)).find((j) => j.subject_id === doomed.assetId && j.kind === "normalize")!;
    expect((await objectKeys(victim.owner.userId)).filter((k) => k.includes(doomed.assetId)).length).toBeGreaterThan(0);
    const deleted = await victim.owner.api.command("media.delete_asset", { assetId: doomed.assetId });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    await settleJobs(victim.owner.userId);
    expect((await objectKeys(victim.owner.userId)).filter((k) => k.includes(doomed.assetId))).toEqual([]);
    const before = await mediaFingerprint(victim.owner.userId);

    const all = (await jobsOf(victim.owner.userId)).filter((j) => j.subject_id === doomed.assetId);
    expect(all.some((j) => j.kind === "purge_objects")).toBe(true);
    await deliver(Array.from({ length: 4 }, () => all.map((job) => ({ kind: "media.job", userId: victim.owner.userId, jobId: job.job_id }))).flat());
    await consumerCaughtUp("after replaying a deleted picture's jobs");

    expect((await objectKeys(victim.owner.userId)).filter((k) => k.includes(doomed.assetId))).toEqual([]);
    expect(await jobOf(victim.owner.userId, normalize.job_id)).toMatchObject({ state: "succeeded", attempts: normalize.attempts });
    expect(await mediaFingerprint(victim.owner.userId)).toBe(before);
    expect((await victim.owner.api.get(`/v1/media/assets/${doomed.assetId}`)).status).toBe(404);
    // The victim's other picture was not caught by the replayed removal.
    expect((await victim.owner.api.get(`/v1/media/assets/${victimAsset}`)).status).toBe(200);
  });

  it("a job delivered many times at once runs once: one set of derived files, one result", async () => {
    const u = attacker.owner.userId;
    const resultsBefore = (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'media.record_normalization'", u))[0]!.n;
    const attempt = await attemptUpload(attacker, await freshPng(176), { role: "bottom" });
    expect(attempt.complete!.body.state, JSON.stringify(attempt.complete)).toBe("finalized");
    const assetId = attempt.complete!.body.asset.assetId as string;
    const job = (await jobsOf(u)).find((j) => j.subject_id === assetId && j.kind === "normalize")!;
    // Eight copies of its message, sent together, on top of the one the Worker sends itself.
    const queue = (await testApp()).env.MEDIA_QUEUE!;
    await Promise.all(Array.from({ length: 8 }, () => queue.send({ kind: "media.job", userId: u, jobId: job.job_id } as never)));
    await settleJobs(u);
    await consumerCaughtUp("after the duplicated delivery");

    expect(await jobOf(u, job.job_id)).toMatchObject({ state: "succeeded", attempts: 1 });
    const perKind = await rows<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM media_renditions WHERE user_id = ? AND asset_id = ? GROUP BY kind", u, assetId);
    expect(perKind.length).toBeGreaterThan(1);
    for (const row of perKind) expect(row.n, row.kind).toBe(1);
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'media.record_normalization'", u))[0]!.n).toBe(resultsBefore + 1);
    // Exactly the recorded files are in storage for this picture: no second copy under another name.
    const recorded = (await rows<{ object_key: string }>("SELECT object_key FROM media_renditions WHERE user_id = ? AND asset_id = ? AND status != 'deleted'", u, assetId)).map((r) => r.object_key).sort();
    expect((await objectKeys(u)).filter((k) => k.includes(assetId))).toEqual(recorded);
  });
});

describe("jobs that were interrupted", () => {
  /** TEST SETUP: put a finished job back into the state an isolate leaves behind when it dies holding the lease. */
  async function leaveAsCrashed(userId: string, jobId: string, attempts: number): Promise<void> {
    const app = await testApp();
    await app.db.prepare("UPDATE media_jobs SET state = 'running', attempts = ?, lease_until = '2000-01-01T00:00:00.000Z', last_error = NULL, result_json = NULL WHERE user_id = ? AND job_id = ?").bind(attempts, userId, jobId).run();
  }

  // Regression: a job whose attempts all died without reporting back (the isolate ran out of memory or time
  // while it held the lease) was started again by every redelivery and every sweep, without end.
  it("a job whose every attempt died is recorded as failed and never started again", async () => {
    const o = await syntheticOwner("QC");
    const photo = await uploadClean(o, await freshPng(160), { role: "top" });
    const job = (await jobsOf(o.owner.userId)).find((j) => j.subject_id === photo.assetId && j.kind === "normalize")!;
    const results = async () => (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ? AND type = 'media.record_normalization'", o.owner.userId))[0]!.n;
    const resultsBefore = await results();
    await leaveAsCrashed(o.owner.userId, job.job_id, job.max_attempts);
    await deliver([{ kind: "media.job", userId: o.owner.userId, jobId: job.job_id }]);
    const after = await waitForJob(o.owner.userId, job.job_id, (j) => j.state !== "running", "every attempt died");
    expect(after.state).toBe("dead");
    expect(after.attempts).toBe(job.max_attempts); // not started a further time
    expect(after.last_error).toMatch(/abandoned after \d+ attempts/);
    expect(await results()).toBe(resultsBefore); // the work itself did not run again
    // Redelivering it afterwards changes nothing, and the failure is reported to the owner rather than hidden.
    await deliver(Array.from({ length: 3 }, () => ({ kind: "media.job", userId: o.owner.userId, jobId: job.job_id })));
    await consumerCaughtUp("after redelivering the abandoned job");
    expect(await jobOf(o.owner.userId, job.job_id)).toMatchObject({ state: "dead", attempts: job.max_attempts });
    expect((await rows<{ status_reason: string }>("SELECT status_reason FROM media_assets WHERE user_id = ? AND asset_id = ?", o.owner.userId, photo.assetId))[0]!.status_reason).toMatch(/did not complete/);
  });

  it("queued work of an account whose access has ended is not run by a replayed message", async () => {
    const o = await syntheticOwner("QD");
    const photo = await uploadClean(o, await freshPng(160), { role: "top" });
    const job = (await jobsOf(o.owner.userId)).find((j) => j.subject_id === photo.assetId && j.kind === "normalize")!;
    const app = await testApp();
    // TEST SETUP: the job is queued again and the account is disabled, as when access ends while work is waiting.
    await app.db.prepare("UPDATE media_jobs SET state = 'queued', lease_until = NULL WHERE user_id = ? AND job_id = ?").bind(o.owner.userId, job.job_id).run();
    await app.db.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?").bind(o.owner.userId).run();
    const commands = async () => (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE user_id = ?", o.owner.userId))[0]!.n;
    const commandsBefore = await commands();
    const keys = await objectKeys(o.owner.userId);
    try {
      await deliver(Array.from({ length: 3 }, () => ({ kind: "media.job", userId: o.owner.userId, jobId: job.job_id })));
      await consumerCaughtUp("after replaying a disabled account's job");
      expect(await jobOf(o.owner.userId, job.job_id)).toMatchObject({ state: "queued", attempts: job.attempts });
      expect(await commands()).toBe(commandsBefore);
      expect(await objectKeys(o.owner.userId)).toEqual(keys);
    } finally {
      // TEST CLEANUP: back to the state before the setup, so nothing is left waiting.
      await app.db.prepare("UPDATE media_jobs SET state = 'succeeded' WHERE user_id = ? AND job_id = ?").bind(o.owner.userId, job.job_id).run();
      await app.db.prepare("UPDATE users SET status = 'active' WHERE user_id = ?").bind(o.owner.userId).run();
    }
  });
});

describe("a job row that names another owner's files", () => {
  it("removes nothing of the other owner's, whatever keys the row carries", async () => {
    const a = attacker.owner.userId;
    const v = victim.owner.userId;
    const victimKeys = await objectKeys(v);
    expect(victimKeys.length).toBeGreaterThan(1);
    const victimBefore = await mediaFingerprint(v);
    const purge = (await jobsOf(a)).find((j) => j.kind === "purge_objects")!;
    const app = await testApp();
    const payloads = [
      { keys: victimKeys },
      { keys: victimKeys.map((k) => `u/${a}/../../${k}`) },
      { keys: victimKeys.map((k) => k.replace(`u/${v}/`, `u/${a}/../${v}/`)) },
      { keys: [`u/${a}`, `u/${v}/`, "u/", "", "/"] },
      { keys: [(await objectKeys(a))[0] ?? `u/${a}/assets/none`, ...victimKeys] }, // one of the attacker's own first
    ];
    const attackerKeysBefore = await objectKeys(a);
    try {
      for (const payload of payloads) {
        // TEST SETUP: a corrupted job row. No request can write one; this checks the runner does not trust it.
        await app.db.prepare("UPDATE media_jobs SET state = 'queued', lease_until = NULL, last_error = NULL, payload_json = ? WHERE user_id = ? AND job_id = ?").bind(JSON.stringify(payload), a, purge.job_id).run();
        await deliver([{ kind: "media.job", userId: a, jobId: purge.job_id }]);
        const after = await waitForJob(a, purge.job_id, (j) => j.last_error !== null || j.state === "succeeded", `payload ${JSON.stringify(payload).slice(0, 80)}`);
        expect(await objectKeys(v), JSON.stringify(payload).slice(0, 120)).toEqual(victimKeys);
        // The whole row is refused before anything is deleted: the attacker's own listed file is still there too.
        expect(await objectKeys(a)).toEqual(attackerKeysBefore);
        expect(after.state).not.toBe("succeeded");
      }
    } finally {
      // TEST CLEANUP: the corrupted row is closed so it is not retried for the rest of the run.
      await app.db.prepare("UPDATE media_jobs SET state = 'succeeded', lease_until = NULL, payload_json = '{}' WHERE user_id = ? AND job_id = ?").bind(a, purge.job_id).run();
    }
    expect(await mediaFingerprint(v)).toBe(victimBefore);
    const served = await victim.owner.api.get(`/v1/media/assets/${victimAsset}?variant=original`);
    expect(served.status).toBe(200);
    await served.arrayBuffer();
  });
});
