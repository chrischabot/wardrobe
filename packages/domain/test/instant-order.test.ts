import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claimDueEffects, define, getGarmentDetail } from "../src/index.ts";
import { createHarness } from "../src/testing/index.ts";
import { wearOn } from "./helpers.ts";

/**
 * Stored instants are written with milliseconds only when they have any (`...:00Z`, `...:00.250Z`), so
 * within one second their text order is not their time order. Every comparison and ordering of instants
 * in the domain therefore goes through `julianday()`. Synthetic owner and garments throughout.
 */

describe("instants are compared and ordered as instants, not as text", () => {
  it("a return without a batch ID settles the batch collected first, even when both were collected in the same second", async () => {
    const h = await createHarness({ startAt: "2026-09-14T08:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss"]);
    h.clock.set("2026-09-16T12:00:00Z");
    const first = await owner.exec("laundry.collect", { batchId: "lb-synthetic-first" }); // 12:00:00Z
    h.clock.advance(300);
    await owner.exec("care.mark_dirty", { items: [{ garmentId: "shirt-gold" }] });
    h.clock.advance(300);
    const second = await owner.exec("laundry.collect", { batchId: "lb-synthetic-second" }); // 12:00:00.600Z
    expect((first.result.members as { garmentId: string }[]).map((m) => m.garmentId)).toEqual(["shirt-moss"]);
    expect((second.result.members as { garmentId: string }[]).map((m) => m.garmentId)).toEqual(["shirt-gold"]);

    h.clock.set("2026-09-18T10:00:00Z");
    const back = await owner.exec("laundry.return", {});
    expect(back.result.batchId).toBe("lb-synthetic-first");
  });

  it("an effect is claimable from the instant it is available, and its lease expires at the instant it says", async () => {
    const h = await createHarness({ startAt: "2026-09-16T07:00:00Z" });
    h.registry.register(
      define({
        type: "test.publish",
        schema: z.object({ revision: z.number().int() }),
        class: "system",
        requiredScope: "write",
        async plan(_ctx, p) {
          return { summary: `published revision ${p.revision}`, effects: [{ kind: "test.synthetic_effect", targetKey: "synthetic", operationKey: `synthetic:r${p.revision}`, desiredRevision: p.revision, payload: {} }] };
        },
      }),
    );
    const owner = await h.createSyntheticOwner();
    await owner.exec("test.publish", { revision: 1 }, { actor: "system", channel: "scheduled", authorization: "system_schedule" }); // available at 07:00:00Z
    const claim = (leaseMs: number) => claimDueEffects(h.db, { nowMs: h.clock.now(), kinds: ["test.synthetic_effect"], leaseMs });

    h.clock.advance(500); // 07:00:00.500Z: half a second after it became available
    expect(await claim(59_500)).toHaveLength(1); // leased until 07:01:00Z
    h.clock.advance(59_000); // 07:00:59.500Z: still leased
    expect(await claim(60_000)).toHaveLength(0);
    h.clock.advance(750); // 07:01:00.250Z: the lease has run out
    expect(await claim(60_000)).toHaveLength(1);
  });

  it("a garment's other names are listed in the order they were given within one second", async () => {
    const h = await createHarness({ startAt: "2026-09-16T07:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await owner.exec("garment.add_alias", { garmentId: "shirt-moss", phrase: "first synthetic alias" }); // 07:00:00Z
    h.clock.advance(250);
    await owner.exec("garment.add_alias", { garmentId: "shirt-moss", phrase: "second synthetic alias" }); // 07:00:00.250Z
    const detail = await getGarmentDetail(h.db, owner.principal(), "shirt-moss");
    expect(detail.aliases.map((a) => a.phrase).filter((p) => p.endsWith("synthetic alias"))).toEqual(["first synthetic alias", "second synthetic alias"]);
  });
});
