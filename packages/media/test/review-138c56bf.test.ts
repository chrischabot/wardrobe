import { describe, expect, it } from "vitest";
import { all, first, isCommandError, toInstant } from "@garderobe/domain";
import { type DiscoveryCandidatePage, type DiscoveryProvider, type ImageFetcher } from "../src/index.ts";
import { runMediaJob, type JobRow } from "../src/jobs.ts";
import { execSystem } from "../src/exec.ts";
import { runDiscoveryJob } from "../src/pipeline/discovery.ts";
import { createMediaHarness } from "../src/testing/index.ts";

// Regression tests for the review of prepared patch b91f7cbe: discovery claims are fenced by the requesting
// job attempt and a recovered search keeps the pages it examined (the import-lock cases of that review live in
// import-lock.test.ts). SYNTHETIC TEST IMAGES and test records only. The
// search provider and the image fetcher are TEST DOUBLES.

const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (isCommandError(e) ? e.code : `threw:${String(e)}`));
const page = (over: Partial<DiscoveryCandidatePage>): DiscoveryCandidatePage => ({ pageUrl: "https://maker.example.org/p", imageUrl: "https://img.example.org/p.jpg", title: null, sourceClass: "maker", identifiers: {}, retrievedAt: "2026-09-15T08:00:00Z", ...over });

async function stoppedSearch() {
  let calls = 0;
  let fetches = 0;
  // TEST DOUBLE: a browser search that finds one candidate page and reports one minute used.
  const browser: DiscoveryProvider = { name: "test-double-browser", strategies: ["maker_catalogue"], usesBrowser: true, async search() { calls++; return { pages: [page({ identifiers: { productCodes: ["PCF7401"], maker: "Test Maker" } })], browserSessions: 1, browserSeconds: 60 }; } };
  // TEST DOUBLE for the network: the first run stops (throws) while fetching the candidate image; later the image is not found.
  const fetcher: ImageFetcher = { async fetchImage() { if (fetches++ === 0) throw new Error("simulated stop after the search"); return { ok: false, reason: "not found (test double)" }; } };
  const h = await createMediaHarness({ adapters: { discoveryProviders: [browser], imageFetcher: fetcher } });
  const owner = await h.createOwner({ synthetic: false, displayName: "Discovery claim-fence owner (test records only)" });
  await owner.exec("settings.update", { patch: { extensions: { media: { browserMinutesPerDay: 7, interactiveReserveMinutesPerDay: 5 } } } });
  await owner.exec("garment.create", { garmentId: "fence-1", name: "test record fence-1", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", aliases: [{ phrase: "PCF7401", kind: "code" }], source: { kind: "system", note: "test record" } });
  await owner.exec("media.request_discovery", { garmentIds: ["fence-1"] });
  const jobId = (await first<{ job_id: string }>(h.db, "SELECT job_id FROM media_jobs WHERE user_id = ? AND subject_id = 'fence-1'", owner.userId))!.job_id;
  expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
  return { h, owner, jobId, calls: () => calls };
}

describe("review of b91f7cbe: discovery claims belong to the job's current attempt", () => {
  it("a superseded runner cannot take a claim back from the newer attempt, nor search, nor record", async () => {
    const { h, owner, jobId, calls } = await stoppedSearch();
    expect(calls()).toBe(1);
    // TEST SETUP: attempt 2 claimed the job (lease valid) and took the settled claim over; it is still working.
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 2, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() + 600_000), owner.userId, jobId).run();
    await h.db.prepare("UPDATE media_browser_reservations SET job_attempt = 2 WHERE user_id = ?").bind(owner.userId).run();
    const job = (await first<JobRow>(h.db, "SELECT * FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId))!;
    // The stale runner (attempt 1) runs the job body again.
    expect(await code(runDiscoveryJob(h.rt, { ...job, attempts: 1 }))).toBe("precondition_failed");
    expect(calls()).toBe(1); // no new search was dispatched
    expect(await all(h.db, "SELECT job_attempt, settled_at IS NOT NULL AS settled FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toEqual([{ job_attempt: 2, settled: 1 }]);
    expect(await all(h.db, "SELECT 1 FROM media_discovery_attempts WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("a claim held by another job running under a live lease is busy", async () => {
    const { h, owner, jobId, calls } = await stoppedSearch();
    // TEST SETUP: the claim belongs to another job that is running with a live lease.
    await h.db.prepare("INSERT INTO media_jobs (user_id, job_id, kind, subject_id, dedupe_key, state, attempts, max_attempts, lease_until, payload_json, command_id, created_at, updated_at) SELECT user_id, 'job_other', kind, subject_id, 'other-runner', 'running', 1, max_attempts, ?, payload_json, command_id, created_at, updated_at FROM media_jobs WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() + 600_000), owner.userId, jobId).run();
    await h.db.prepare("UPDATE media_browser_reservations SET job_id = 'job_other', job_attempt = 1 WHERE user_id = ?").bind(owner.userId).run();
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(calls()).toBe(1);
    expect(await first(h.db, "SELECT job_id FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toEqual({ job_id: "job_other" });
    expect((await first<{ conclusion: string }>(h.db, "SELECT discovery_json AS conclusion FROM garment_media WHERE user_id = ? AND garment_id = 'fence-1'", owner.userId))!.conclusion).toMatch(/another run is making this search now/);
  });

  it("a claim held by another job whose lease has lapsed is taken over and its stored search recorded", async () => {
    const { h, owner, jobId, calls } = await stoppedSearch();
    // TEST SETUP: the claim belongs to another job that was running but whose lease lapsed a minute ago.
    await h.db.prepare("INSERT INTO media_jobs (user_id, job_id, kind, subject_id, dedupe_key, state, attempts, max_attempts, lease_until, payload_json, command_id, created_at, updated_at) SELECT user_id, 'job_other', kind, subject_id, 'other-runner', 'running', 1, max_attempts, ?, payload_json, command_id, created_at, updated_at FROM media_jobs WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() - 60_000), owner.userId, jobId).run();
    await h.db.prepare("UPDATE media_browser_reservations SET job_id = 'job_other', job_attempt = 1 WHERE user_id = ?").bind(owner.userId).run();
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(calls()).toBe(1); // the stored pages were used; no new search was dispatched
    // The claim was taken over and released when the search was recorded.
    expect(await all(h.db, "SELECT 1 FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toHaveLength(0);
    expect(await all(h.db, "SELECT pages_examined, browser_seconds FROM media_discovery_attempts WHERE user_id = ? AND garment_id = 'fence-1'", owner.userId)).toEqual([{ pages_examined: 1, browser_seconds: 60 }]);
    expect((await first<{ conclusion: string }>(h.db, "SELECT discovery_json AS conclusion FROM garment_media WHERE user_id = ? AND garment_id = 'fence-1'", owner.userId))!.conclusion).not.toMatch(/another run is making this search now/);
  });

  it("a search recovered from a stopped run is recorded from the pages it returned, without searching again", async () => {
    const { h, owner, jobId, calls } = await stoppedSearch();
    expect(await first(h.db, "SELECT pages_examined, retryable, json_array_length(pages_json) AS stored FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toEqual({ pages_examined: 1, retryable: 0, stored: 1 });
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("succeeded");
    expect(calls()).toBe(1);
    expect(await all(h.db, "SELECT pages_examined, browser_seconds, outcome FROM media_discovery_attempts WHERE user_id = ? AND garment_id = 'fence-1'", owner.userId)).toEqual([{ pages_examined: 1, browser_seconds: 60, outcome: "no_match" }]);
    expect(await all(h.db, "SELECT 1 FROM media_candidates WHERE user_id = ? AND garment_id = 'fence-1'", owner.userId)).toHaveLength(1);
  });

  it("a result is refused while another runner holds the claim of a search it records", async () => {
    const { h, owner, jobId } = await stoppedSearch();
    const claim = (await first<{ attempt_id: string; query_hash: string }>(h.db, "SELECT attempt_id, query_hash FROM media_browser_reservations WHERE user_id = ?", owner.userId))!;
    // TEST SETUP: this job runs as attempt 2, but another job has taken the search's claim over.
    await h.db.prepare("UPDATE media_jobs SET state = 'running', attempts = 2, lease_until = ? WHERE user_id = ? AND job_id = ?").bind(toInstant(h.clock.now() + 600_000), owner.userId, jobId).run();
    await h.db.prepare("UPDATE media_browser_reservations SET job_id = 'job_other', job_attempt = 1 WHERE user_id = ?").bind(owner.userId).run();
    const result = (key: string) => execSystem(h.rt, owner.userId, "media.record_discovery", {
      garmentId: "fence-1", jobId, attempt: 2, candidates: [], conclusion: "deferred", note: "test record",
      attempts: [{ attemptId: claim.attempt_id, strategy: "maker_catalogue", queryHash: claim.query_hash, query: {}, provider: "test-double-browser", pagesExamined: 1, browserSessions: 1, browserSeconds: 60, outcome: "no_match", detail: null }],
    }, key);
    expect(await code(result("claim-taken"))).toBe("precondition_failed");
    expect(await all(h.db, "SELECT 1 FROM media_discovery_attempts WHERE user_id = ?", owner.userId)).toHaveLength(0);
    await h.db.prepare("UPDATE media_browser_reservations SET job_id = ?, job_attempt = 2 WHERE user_id = ?").bind(jobId, owner.userId).run();
    expect(await code(result("claim-held"))).toBe("ok");
    // The recorded search's claim was released in the same commit (no runner involved): its browser time now counts
    // once, from the recorded attempt.
    expect(await all(h.db, "SELECT 1 FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("an interrupted search whose reservation used up the browser allowance is still recovered and charged, not skipped", async () => {
    const { h, owner, jobId, calls } = await stoppedSearch();
    // TEST SETUP: the stopped run was interrupted during its search: its claim is unsettled, still open, and reserves
    // the owner's whole backfill allowance (two minutes), so the allowance now shows nothing left.
    await h.db.prepare("UPDATE media_browser_reservations SET settled_at = NULL, pages_json = NULL, pages_examined = NULL, seconds = 120, expires_at = ? WHERE user_id = ?").bind(toInstant(h.clock.now() + 3_600_000), owner.userId).run();
    await runMediaJob(h.rt, owner.userId, jobId);
    expect(calls()).toBe(1); // nothing searched again
    // The interrupted search was recorded with its reserved time charged, and its claim released.
    expect(await all(h.db, "SELECT browser_seconds FROM media_discovery_attempts WHERE user_id = ? AND garment_id = 'fence-1'", owner.userId)).toEqual([{ browser_seconds: 120 }]);
    expect(await all(h.db, "SELECT 1 FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toHaveLength(0);
  });

  it("the reserved time of an abandoned job's unrecorded search still counts against today's allowance after its claim expires", async () => {
    const { h, owner, jobId, calls } = await stoppedSearch();
    // TEST SETUP: the stopped job was then abandoned (its attempts used up), so its claim, holding the whole two-minute
    // backfill allowance, is never recorded; later today the claim expires.
    await h.db.prepare("UPDATE media_jobs SET state = 'dead', lease_until = NULL WHERE user_id = ? AND job_id = ?").bind(owner.userId, jobId).run();
    // The claim was interrupted during its search: unsettled, holding the whole allowance.
    await h.db.prepare("UPDATE media_browser_reservations SET seconds = 120, settled_at = NULL, pages_json = NULL, pages_examined = NULL WHERE user_id = ?").bind(owner.userId).run();
    await h.db.prepare("UPDATE media_browser_reservations SET expires_at = ? WHERE user_id = ?").bind(toInstant(h.clock.now() - 1000), owner.userId).run();
    // Another garment's browser search the same day finds no allowance left.
    await owner.exec("garment.create", { garmentId: "fence-2", name: "test record fence-2", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Green", aliases: [{ phrase: "PCF7402", kind: "code" }], source: { kind: "system", note: "test record" } });
    await owner.exec("media.request_discovery", { garmentIds: ["fence-2"] });
    const second = (await first<{ job_id: string }>(h.db, "SELECT job_id FROM media_jobs WHERE user_id = ? AND subject_id = 'fence-2'", owner.userId))!.job_id;
    await runMediaJob(h.rt, owner.userId, second);
    expect(calls()).toBe(1); // the spent time was not handed out again
    expect((await first<{ conclusion: string }>(h.db, "SELECT discovery_json AS conclusion FROM garment_media WHERE user_id = ? AND garment_id = 'fence-2'", owner.userId))!.conclusion).toMatch(/browser allowance/);
  });
});

describe("review of 981ed5e2: a job whose provider never answers is given up at the runner deadline", () => {
  it("stops renewing and records a failed attempt after three lease periods", async () => {
    // TEST DOUBLE: a (non-browser) maker search that never resolves.
    const hanging: DiscoveryProvider = { name: "test-double-hanging", strategies: ["maker_catalogue"], usesBrowser: false, search: () => new Promise(() => undefined) };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [hanging] } });
    h.deps.limits = { jobLeaseSeconds: 1 }; // TEST SETUP: a one-second lease, so the deadline is three seconds
    const owner = await h.createOwner({ synthetic: false, displayName: "Discovery deadline owner (test records only)" });
    await owner.exec("garment.create", { garmentId: "hang-1", name: "test record hang-1", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", source: { kind: "system", note: "test record" } });
    await owner.exec("media.request_discovery", { garmentIds: ["hang-1"] });
    const jobId = (await first<{ job_id: string }>(h.db, "SELECT job_id FROM media_jobs WHERE user_id = ? AND subject_id = 'hang-1'", owner.userId))!.job_id;
    const started = Date.now();
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
    const row = await first<{ state: string; lease_until: string | null; last_error: string }>(h.db, "SELECT state, lease_until, last_error FROM media_jobs WHERE user_id = ? AND job_id = ?", owner.userId, jobId);
    expect(row).toMatchObject({ state: "queued", lease_until: null });
    expect(row!.last_error).toMatch(/time limit/);
  }, 20_000);

  it("a search that answers after the deadline settles nothing and starts no further search", async () => {
    let calls = 0;
    let answer: (() => void) | undefined;
    // TEST DOUBLE: a (non-browser) search for two strategies whose first answer is held until released.
    const late: DiscoveryProvider = {
      name: "test-double-late", strategies: ["maker_catalogue", "identifier_search"], usesBrowser: false,
      search: () => { calls++; return new Promise((resolve) => (answer = () => resolve({ pages: [], browserSessions: 0, browserSeconds: 0 }))); },
    };
    const h = await createMediaHarness({ adapters: { discoveryProviders: [late] } });
    h.deps.limits = { jobLeaseSeconds: 1 }; // TEST SETUP: discovery deadline three seconds
    const owner = await h.createOwner({ synthetic: false, displayName: "Discovery late answer owner (test records only)" });
    await owner.exec("garment.create", { garmentId: "late-1", name: "test record late-1", category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, maker: "Test Maker", product: "Oxford Shirt", colour: "Blue", source: { kind: "system", note: "test record" } });
    await owner.exec("media.request_discovery", { garmentIds: ["late-1"] });
    const jobId = (await first<{ job_id: string }>(h.db, "SELECT job_id FROM media_jobs WHERE user_id = ? AND subject_id = 'late-1'", owner.userId))!.job_id;
    expect(await runMediaJob(h.rt, owner.userId, jobId)).toBe("retry");
    expect(calls).toBe(1);
    answer!(); // the provider answers after the run was given up
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The stale work neither settled its claim nor went on to the next strategy's search.
    expect(calls).toBe(1);
    expect(await all(h.db, "SELECT settled_at FROM media_browser_reservations WHERE user_id = ?", owner.userId)).toEqual([{ settled_at: null }]);
    expect(await all(h.db, "SELECT 1 FROM media_discovery_attempts WHERE user_id = ?", owner.userId)).toHaveLength(0);
  }, 20_000);
});
