import { describe, expect, it } from "vitest";
import { all, first } from "../src/index.ts";
import { createHarness, type Harness, type TestOwner } from "../src/testing/index.ts";
import { balances, wearOn } from "./helpers.ts";

/**
 * Expected versions a client states are honoured by every command except wear, wash and laundry reports.
 * Reported by the iOS thread at garderobe-rebuild 9231220e: `garment.retire` with a wrong or an old garment
 * version was committed, so a proposal made against an old record could be confirmed and applied.
 * Synthetic owner and garments throughout.
 */

const STATEMENT = { kind: "owner_statement" as const, note: "synthetic test statement" };

/** The current version behind an expected-version key, read straight from the ledger. */
async function current(h: Harness, owner: TestOwner, key: string): Promise<number> {
  if (key.startsWith("garment:")) return (await first<{ v: number }>(h.db, "SELECT version AS v FROM garments WHERE user_id = ? AND garment_id = ?", owner.userId, key.slice("garment:".length)))!.v;
  const column = key === "wardrobe" ? "wardrobe_revision" : "style_revision";
  return (await first<{ v: number }>(h.db, `SELECT ${column} AS v FROM owner_state WHERE user_id = ?`, owner.userId))!.v;
}

const commandCount = async (h: Harness, owner: TestOwner, type: string) => (await all(h.db, "SELECT 1 FROM commands WHERE user_id = ? AND type = ?", owner.userId, type)).length;

describe("expected versions on commands that remove, move, receive or rewrite a record", () => {
  it("retiring a garment with a wrong or an old version is refused and writes nothing; the current version retires it", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const created = await owner.exec("garment.create", { garmentId: "scarf-synthetic", name: "synthetic navy scarf", category: "accessory", roles: ["accessory"], careChannel: "none", acquisition: "owned", quantity: 1, isSynthetic: true, source: STATEMENT });
    const createdVersion = created.affected.find((a) => a.kind === "garment")!.version;
    await owner.exec("garment.correct", { garmentId: "scarf-synthetic", changes: { condition: "pilled (synthetic)" }, source: STATEMENT });
    const key = "garment:scarf-synthetic";
    const now = await current(h, owner, key);
    expect(now).toBeGreaterThan(createdVersion);

    for (const version of [99, createdVersion]) {
      const refused = await owner.exec("garment.retire", { garmentId: "scarf-synthetic", disposition: "sold" }, { expectedVersions: { [key]: version } }).catch((e) => e);
      expect(refused.code).toBe("conflict");
      expect(refused.details.failed).toBe(`expected ${key} = ${version}`);
    }
    expect(await current(h, owner, key)).toBe(now);
    expect(await balances(h, owner, "scarf-synthetic")).toMatchObject({ clean: 1, gone: 0 });
    expect(await commandCount(h, owner, "garment.retire")).toBe(0);
    expect((await first<{ n: number }>(h.db, "SELECT COUNT(*) AS n FROM command_preconditions"))!.n).toBe(0);

    const retired = await owner.exec("garment.retire", { garmentId: "scarf-synthetic", disposition: "sold" }, { expectedVersions: { [key]: now } });
    expect(retired.outcome).toBe("committed");
    expect(await balances(h, owner, "scarf-synthetic")).toMatchObject({ clean: 0, gone: 1 });
  });

  // Each row: a command, the version key it is sent with, and an unrelated change that moves that version on.
  const bumpGarment = (garmentId: string) => (owner: TestOwner) => owner.exec("garment.set_planning_policy", { garmentId, policy: "occasional" });
  const cases: { type: string; payload: Record<string, unknown>; key: string; bump: (owner: TestOwner) => Promise<unknown> }[] = [
    { type: "garment.correct", payload: { garmentId: "shirt-moss", changes: { condition: "frayed collar (synthetic)" }, source: STATEMENT }, key: "garment:shirt-moss", bump: bumpGarment("shirt-moss") },
    { type: "garment.move", payload: { garmentId: "shirt-gold", to: "storage" }, key: "garment:shirt-gold", bump: bumpGarment("shirt-gold") },
    { type: "garment.receive", payload: { garmentId: "shirt-ordered" }, key: "garment:shirt-ordered", bump: bumpGarment("shirt-ordered") },
    { type: "stock.reconcile", payload: { garmentId: "sock-grey", counts: { clean: 1 } }, key: "garment:sock-grey", bump: bumpGarment("sock-grey") },
    { type: "stock.pack", payload: { tripId: "trip-synthetic", items: [{ garmentId: "shirt-slate" }] }, key: "garment:shirt-slate", bump: bumpGarment("shirt-slate") },
    { type: "garment.retire", payload: { garmentId: "trouser-beige", disposition: "sold" }, key: "wardrobe", bump: (owner) => owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-moss"] }) },
    {
      type: "measurement.record",
      payload: { subject: "garment", garmentId: "jacket-academic", key: "half_chest", value: 58, unit: "cm", source: STATEMENT },
      key: "style",
      bump: (owner) => owner.exec("style.add_direction", { text: "Synthetic direction for a version test.", source: STATEMENT }),
    },
  ];

  it.each(cases)("$type sent with a stale '$key' version is a conflict and is not recorded; with the current version it commits", async ({ type, payload, key, bump }) => {
    const h = await createHarness({ startAt: "2026-09-15T09:00:00Z" });
    const owner = await h.createSyntheticOwner();
    const seen = await current(h, owner, key);
    await bump(owner);
    const now = await current(h, owner, key);
    expect(now).toBeGreaterThan(seen);

    const refused = await owner.exec(type, payload, { expectedVersions: { [key]: seen } }).catch((e) => e);
    expect(refused.code).toBe("conflict");
    expect(refused.details.failed).toBe(`expected ${key} = ${seen}`);
    expect(await commandCount(h, owner, type)).toBe(0);
    expect(await current(h, owner, key)).toBe(now);

    expect((await owner.exec(type, payload, { expectedVersions: { [key]: now } })).outcome).toBe("committed");
  });

  it("a wash report and a laundry pickup still land whatever versions the client last saw", async () => {
    const h = await createHarness({ startAt: "2026-09-14T08:00:00Z" });
    const owner = await h.createSyntheticOwner();
    await wearOn(h, owner, "2026-09-14", ["shirt-moss", "sock-navy"]);
    h.clock.set("2026-09-16T12:00:00Z");
    expect(await balances(h, owner, "sock-navy")).toMatchObject({ dirty: 1 });
    const stale = { expectedVersions: { "garment:shirt-moss": 999, "garment:sock-navy": 999, wardrobe: 12345 } };
    expect((await owner.exec("care.washed", { items: [{ garmentId: "sock-navy" }] }, stale)).outcome).toBe("committed");
    expect(await balances(h, owner, "sock-navy")).toMatchObject({ dirty: 0 });
    expect((await owner.exec("laundry.collect", {}, stale)).outcome).toBe("committed");
    expect(await balances(h, owner, "shirt-moss")).toMatchObject({ dirty: 0, service: 1 });
  });
});
