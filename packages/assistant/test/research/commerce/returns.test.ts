import { describe, it, expect } from "vitest";
import { computeReturnDeadline, refundState, reminderSchedule, UNRESOLVED_REASONS } from "../../../src/research/commerce/index.ts";
import type { ReturnTerms } from "../../../src/research/commerce/index.ts";

const terms: ReturnTerms = {
  windowDays: 14, concerns: "post", triggerEvent: "delivery",
  sourceRef: "gmail:m1#returns-paragraph", checkedOn: "2025-01-11",
};
const london = "Europe/London";

describe("computeReturnDeadline", () => {
  it("establishes a deadline from sourced terms and the real trigger date", () => {
    const result = computeReturnDeadline({ terms, trigger: { event: "delivery", date: "2025-01-10" }, timezone: london });
    expect(result).toEqual({
      status: "established", deadlineLocalDate: "2025-01-24", deadlineAt: "2025-01-25T00:00:00.000Z",
      timezone: london, concerns: "post",
    });
  });

  it("ends the deadline day at local midnight across the Europe/London clock changes", () => {
    const at = (date: string): string => {
      const result = computeReturnDeadline({ terms, trigger: { event: "delivery", date }, timezone: london });
      return result.status === "established" ? `${result.deadlineLocalDate} ${result.deadlineAt}` : result.reason;
    };
    // Clocks go forward on 2025-03-30: the day before still ends at 00:00 UTC, the day itself at 23:00 UTC.
    expect(at("2025-03-15")).toBe("2025-03-29 2025-03-30T00:00:00.000Z");
    expect(at("2025-03-16")).toBe("2025-03-30 2025-03-30T23:00:00.000Z");
    // Clocks go back on 2025-10-26: the day before ends at 23:00 UTC, the day itself at 00:00 UTC.
    expect(at("2025-10-11")).toBe("2025-10-25 2025-10-25T23:00:00.000Z");
    expect(at("2025-10-12")).toBe("2025-10-26 2025-10-27T00:00:00.000Z");
  });

  it("uses the given timezone west of UTC and crosses month ends", () => {
    const result = computeReturnDeadline({
      terms: { ...terms, windowDays: 30, concerns: "retailer_receipt", triggerEvent: "purchase" },
      trigger: { event: "purchase", date: "2025-06-01" }, timezone: "America/New_York",
    });
    expect(result).toEqual({
      status: "established", deadlineLocalDate: "2025-07-01", deadlineAt: "2025-07-02T04:00:00.000Z",
      timezone: "America/New_York", concerns: "retailer_receipt",
    });
  });

  it("stays unresolved, with the reason, instead of producing a speculative countdown", () => {
    const delivered = { event: "delivery", date: "2025-01-10" } as const;
    expect(computeReturnDeadline({ terms: null, trigger: delivered, timezone: london }))
      .toEqual({ status: "unresolved", reason: UNRESOLVED_REASONS.noTerms });
    expect(computeReturnDeadline({ terms: { ...terms, sourceRef: "  " }, trigger: delivered, timezone: london }))
      .toEqual({ status: "unresolved", reason: UNRESOLVED_REASONS.unsourcedTerms });
    expect(computeReturnDeadline({ terms, trigger: null, timezone: london }))
      .toEqual({ status: "unresolved", reason: UNRESOLVED_REASONS.missingTrigger });
    expect(computeReturnDeadline({ terms, trigger: { event: "dispatch", date: "2025-01-08" }, timezone: london }))
      .toEqual({ status: "unresolved", reason: UNRESOLVED_REASONS.triggerMismatch });
    expect(computeReturnDeadline({ terms, trigger: { event: "delivery", date: "2025-02-30" }, timezone: london }))
      .toEqual({ status: "unresolved", reason: UNRESOLVED_REASONS.invalidDate });
    expect(computeReturnDeadline({ terms, trigger: delivered, timezone: "Mars/Olympus" }))
      .toEqual({ status: "unresolved", reason: UNRESOLVED_REASONS.invalidTimezone });
    expect(computeReturnDeadline({ terms: { ...terms, windowDays: 14.5 }, trigger: delivered, timezone: london }))
      .toEqual({ status: "unresolved", reason: UNRESOLVED_REASONS.invalidTerms });
  });
});

describe("reminderSchedule", () => {
  const deadlineAt = "2025-01-25T00:00:00.000Z";

  it("defaults to seven and two days before, with deterministic dedupe keys", () => {
    const input = { caseId: "case-1", deadlineAt, nowMs: Date.parse("2025-01-01T00:00:00Z") };
    const reminders = reminderSchedule(input);
    expect(reminders).toEqual([
      { dueAt: "2025-01-18T00:00:00.000Z", daysBefore: 7, dedupeKey: "return:case-1:2025-01-25T00:00:00.000Z:7" },
      { dueAt: "2025-01-23T00:00:00.000Z", daysBefore: 2, dedupeKey: "return:case-1:2025-01-25T00:00:00.000Z:2" },
    ]);
    // Recomputing for app and for calendar yields the same keys, so a reminder is delivered once.
    expect(reminderSchedule(input).map((r) => r.dedupeKey)).toEqual(reminders.map((r) => r.dedupeKey));
  });

  it("skips reminders whose time has already passed", () => {
    const afterFirst = reminderSchedule({ caseId: "case-1", deadlineAt, nowMs: Date.parse("2025-01-20T09:00:00Z") });
    expect(afterFirst.map((r) => r.daysBefore)).toEqual([2]);
    expect(reminderSchedule({ caseId: "case-1", deadlineAt, nowMs: Date.parse("2025-01-24T09:00:00Z") })).toEqual([]);
  });

  it("accepts configured offsets and ignores repeats", () => {
    const reminders = reminderSchedule({ caseId: "c", deadlineAt, daysBefore: [1, 3, 3], nowMs: 0 });
    expect(reminders.map((r) => r.daysBefore)).toEqual([3, 1]);
    expect(reminders.map((r) => r.dedupeKey)).toEqual([`return:c:${deadlineAt}:3`, `return:c:${deadlineAt}:1`]);
  });

  it("schedules nothing for a deadline that is not an instant", () => {
    expect(reminderSchedule({ caseId: "c", deadlineAt: "unresolved", nowMs: 0 })).toEqual([]);
  });
});

describe("refundState", () => {
  it("compares the amount received with the amount expected", () => {
    expect(refundState(19500, 0)).toBe("none");
    expect(refundState(19500, 9500)).toBe("partial");
    expect(refundState(19500, 19500)).toBe("full");
    expect(refundState(19500, 20000)).toBe("over");
  });

  it("never calls a refund full when the expected amount is unknown", () => {
    expect(refundState(null, 0)).toBe("none");
    expect(refundState(null, 9500)).toBe("partial");
  });
});
