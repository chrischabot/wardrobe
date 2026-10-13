/**
 * Fencing for background job results. A runner claims a job with a lease and records its result through
 * one of the job-result commands. If the lease expired and another runner claimed the job, the earlier
 * runner must not record anything: each claim's attempt number is its fencing token, carried in the
 * result command's `attempt` field and checked inside the same commit as the result's writes.
 */
import { z } from "zod";
import { CommandError, type CommandDefinition } from "@garderobe/domain";
import { sweptAttemptFence } from "./write-intents.ts";

/** Commands that close a job (they write `media_jobs` through `finishJob`). */
export const JOB_RESULT_COMMANDS = new Set(["media.record_normalization", "media.record_discovery", "media.record_composite", "media.discard_composite", "media.complete_job", "media.fail_job"]);

/** The precondition every fenced result carries: the job is still running under this runner's claim. */
export function jobFence(userId: string, jobId: string, attempt: number) {
  return {
    label: "this runner still holds the job's lease",
    sql: "(SELECT attempts FROM media_jobs WHERE user_id = ? AND job_id = ? AND state = 'running') = ?",
    params: [userId, jobId, attempt],
    class: "state" as const,
  };
}

/**
 * Wraps a job-result command: its payload must name the `attempt` of the runner's claim, and the plan's writes
 * commit only while the job is still running under that attempt. A result from a runner whose lease was taken
 * over is refused as `precondition_failed` and writes nothing; one that names no attempt is refused outright.
 */
export function fenceJobResult<D extends CommandDefinition<any>>(def: D): D {
  if (!JOB_RESULT_COMMANDS.has(def.type)) return def;
  const schema = def.schema as unknown;
  if (!(schema instanceof z.ZodObject)) throw new Error(`${def.type}: a job-result command needs an object schema to be fenced`);
  const fencedSchema = schema.extend({ attempt: z.number().int().positive(), abandonExpiredBefore: z.string().min(10).max(40).optional() });
  const plan = def.plan.bind(def);
  return {
    ...def,
    schema: fencedSchema,
    async plan(ctx, payload: { jobId: string; attempt: number; abandonExpiredBefore?: string }) {
      const { attempt, abandonExpiredBefore, ...rest } = payload;
      // Every result is fenced: there is no unfenced form of a job-result command.
      if (typeof attempt !== "number") throw new CommandError("invalid_command", `${def.type} names the job attempt it reports for`);
      if (abandonExpiredBefore !== undefined && def.type !== "media.fail_job") {
        throw new Error(`${def.type}: abandoning an expired job needs media.fail_job with the attempt it abandons`);
      }
      const out = await plan(ctx, rest as never);
      // A swept attempt's own late result is refused (write-intents.ts). Abandoning that attempt is not its result:
      // it is written by another runner, publishes nothing the swept run produced, and is pinned to the expired,
      // exhausted attempt by abandonFence below, so it must stay possible (otherwise the job would be retried past its limit).
      const fences = abandonExpiredBefore !== undefined
        ? [jobFence(ctx.userId, payload.jobId, attempt)]
        : [jobFence(ctx.userId, payload.jobId, attempt), sweptAttemptFence(ctx.userId, payload.jobId, attempt)];
      // A discovery result records searches made under claims (migration 0402). If any of those claims was
      // taken over by another runner (this one's lease lapsed meanwhile), this result is refused in its commit.
      if (def.type === "media.record_discovery") {
        const ids = [...new Set(((payload as { attempts?: { attemptId: string }[] }).attempts ?? []).map((a) => a.attemptId))];
        if (ids.length > 0) {
          fences.push({
            label: "this runner still holds the claims of the searches it records",
            sql: `NOT EXISTS (SELECT 1 FROM media_browser_reservations WHERE user_id = ? AND attempt_id IN (${ids.map(() => "?").join(",")}) AND NOT (job_id = ? AND job_attempt IS ?))`,
            params: [ctx.userId, ...ids, payload.jobId, attempt],
            class: "state" as const,
          });
        }
      }
      // Giving up a job whose runner vanished: still only while its lease has run out and its allowance is spent,
      // checked in the same commit, so a runner that renewed or a new claim in between is never failed.
      if (abandonExpiredBefore !== undefined) fences.push(abandonFence(ctx.userId, payload.jobId, attempt, abandonExpiredBefore));
      return { ...out, preconditions: [...(out.preconditions ?? []), ...fences] };
    },
  } as D;
}

/** The job is still the expired, exhausted claim that was selected for abandonment. */
export function abandonFence(userId: string, jobId: string, attempt: number, expiredBefore: string) {
  return {
    label: "the job's lease has expired and its attempts are used up",
    sql: "(SELECT COUNT(*) FROM media_jobs WHERE user_id = ? AND job_id = ? AND state = 'running' AND attempts = ? AND lease_until < ? AND attempts >= max_attempts) = 1",
    params: [userId, jobId, attempt, expiredBefore],
    class: "state" as const,
  };
}
