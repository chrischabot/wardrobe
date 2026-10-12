/**
 * The owner's acknowledged path out of a restriction (README "A covered garment stays covered"): a correction
 * that takes a piece out of an active restriction applies only when the owner himself, in the app, names the
 * restriction in `acknowledgedRestrictionIds`. Real command service, local D1, the labelled synthetic owner.
 */
import { describe, expect, it } from "vitest";
import { first, getAvailability } from "../src/index.ts";
import { createHarness, type Harness, type TestOwner } from "../src/testing/index.ts";

const SCOPE = { anyOf: [{ category: "footwear", footwearKinds: ["welted", "boot", "other"] }] };
const REASON = "SYNTHETIC healing restriction (acknowledgement test fixture)";
const refusal = (p: Promise<unknown>) => p.then(() => ({ code: "committed", details: {} as Record<string, unknown> }), (e) => e as { code: string; details: Record<string, unknown> });
const restricted = async (h: Harness, owner: TestOwner) =>
  (await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() })).garments.filter((g) => g.reasons.includes("restricted")).map((g) => g.garmentId).sort();
const toSneaker = (garmentId: string, acknowledgedRestrictionIds?: string[]) => ({ garmentId, changes: { attributes: { footwearKind: "sneaker" } }, source: { kind: "owner_statement" }, ...(acknowledgedRestrictionIds ? { acknowledgedRestrictionIds } : {}) });

async function start(): Promise<{ h: Harness; owner: TestOwner; restrictionId: string }> {
  const h = await createHarness({ startAt: "2026-09-14T09:00:00Z" });
  const owner = await h.createSyntheticOwner();
  const added = await owner.exec("restriction.add", { kind: "healing", scope: SCOPE, reason: REASON, source: { kind: "owner_statement" } });
  return { h, owner, restrictionId: added.result.restrictionId as string };
}

describe("acknowledging a restriction a correction takes a piece out of", () => {
  it("the owner in the app: the correction applies, the receipt says so in words, and the restriction stays active for the rest", async () => {
    const { h, owner, restrictionId } = await start();
    const before = await restricted(h, owner);
    expect(before).toContain("shoe-welted");
    const receipt = await owner.exec("garment.correct", toSneaker("shoe-welted", [restrictionId]));
    expect(receipt.outcome).toBe("committed");
    expect(receipt.result.releasedFromRestrictions).toEqual([{ restrictionId, garmentIds: ["shoe-welted"] }]);
    expect(receipt.summary).toContain(REASON);
    expect(receipt.summary).not.toContain(restrictionId);
    expect(await restricted(h, owner)).toEqual(before.filter((id) => id !== "shoe-welted"));
    expect((await first<{ status: string }>(h.db, "SELECT status FROM restrictions WHERE user_id = ? AND restriction_id = ?", owner.userId, restrictionId))!.status).toBe("active");
    // Undo puts it back under the restriction without asking again.
    expect((await owner.exec("command.undo", { commandId: receipt.commandId })).outcome).toBe("committed");
    expect(await restricted(h, owner)).toEqual(before);
  });

  it("anyone else is refused, whatever the acknowledgement names, and nothing is written", async () => {
    const { h, owner, restrictionId } = await start();
    const before = await restricted(h, owner);
    const others = [
      { channel: "mcp" as const },
      { actor: "assistant" as const, channel: "ios" as const },
      { actor: "assistant" as const, channel: "mcp" as const },
    ];
    for (const opts of others) {
      const refused = await refusal(owner.exec("garment.correct", toSneaker("shoe-welted", [restrictionId]), opts));
      expect(refused.code, JSON.stringify(opts)).toBe("forbidden");
      expect(refused.details, JSON.stringify(opts)).toMatchObject({ reason: "restriction_acknowledgement_owner_only" });
    }
    expect(await restricted(h, owner)).toEqual(before);
  });

  it("an acknowledgement naming another restriction does not stand in; a bulk correction acknowledges per restriction", async () => {
    const { h, owner, restrictionId } = await start();
    const wrong = await refusal(owner.exec("garment.correct", toSneaker("shoe-welted", ["rst_synthetic_other"])));
    expect(wrong.details).toMatchObject({ reason: "correction_would_release_restriction", restrictionId });
    const covered = (await restricted(h, owner)).filter((id) => id.startsWith("shoe-"));
    expect(covered.length).toBeGreaterThan(0);
    const bulk = await owner.exec("garment.bulk_correct", { selector: { category: "footwear" }, changes: { attributes: { footwearKind: "sneaker" } }, source: { kind: "owner_statement" }, acknowledgedRestrictionIds: [restrictionId] });
    expect(bulk.outcome).toBe("committed");
    expect((bulk.result.releasedFromRestrictions as { restrictionId: string; garmentIds: string[] }[])[0]!.garmentIds.sort()).toEqual(covered);
    expect((await restricted(h, owner)).filter((id) => id.startsWith("shoe-"))).toEqual([]);
  });
});
