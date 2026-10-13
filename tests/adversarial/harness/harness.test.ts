/**
 * Proof that the shared harness attacks the real thing: the real Worker answers over `SELF.fetch`, its
 * commands land in the real local D1, the command service with a controllable clock writes to the same
 * database, the labelled external doubles answer, and the fingerprint sees every write.
 * Every owner here is a labelled SYNTHETIC fixture.
 */
import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { first } from "@garderobe/domain";
import { APP_ORIGIN, SYNTHETIC, STRICT, committed, createLedgerHarness, ledgerDiff, ledgerFingerprint, newPlace, ownerScopedTables, provisionOwner, refusal, refused, scriptWeather, testApp } from "./index.ts";

const garment = (name: string) => ({ name, category: "shirt", roles: ["top"], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic test fixture - not the owner's wardrobe" } });

describe("adversarial harness", () => {
  it("reaches the real Worker: an unauthenticated request is refused by its own authentication", async () => {
    const response = await SELF.fetch(`${APP_ORIGIN}/v1/me`);
    expect(response.status).toBe(401);
  });

  it(`${SYNTHETIC} a command sent over HTTP is stored in the real local D1 with its receipt, and the fingerprint sees it`, async () => {
    const owner = await provisionOwner();
    const app = await testApp();
    const before = await ledgerFingerprint(owner.userId);
    const receipt = await committed(await owner.api.command("garment.create", garment("harness check oxford")));
    expect(receipt.outcome).toBe("committed");
    const stored = await first<{ type: string; receipt_json: string }>(app.db, "SELECT type, receipt_json FROM commands WHERE user_id = ? AND command_id = ?", owner.userId, receipt.commandId);
    expect(stored?.type).toBe("garment.create");
    expect(JSON.parse(stored!.receipt_json).commandId).toBe(receipt.commandId);
    const changed = ledgerDiff(before, await ledgerFingerprint(owner.userId)).map((line) => line.split(" ")[0]);
    expect(changed).toEqual(expect.arrayContaining(["commands", "garments"]));
  });

  it(`${SYNTHETIC} a refused command leaves the owner's rows exactly as they were, in every table`, async () => {
    const owner = await provisionOwner();
    await committed(await owner.api.command("garment.create", garment("harness check poplin")));
    const before = await ledgerFingerprint(owner.userId);
    const answer = await refused(await owner.api.command("garment.create", { ...garment("harness check refused"), quantity: -1 }));
    expect(answer.status).toBe(400);
    expect(answer.error.code).toBe("invalid_command");
    expect(ledgerDiff(before, await ledgerFingerprint(owner.userId))).toEqual([]);
  });

  it(`${SYNTHETIC} the command service with a controllable clock writes to the same database`, async () => {
    const ledger = await createLedgerHarness({ startAt: "2026-09-15T08:00:00Z" });
    const owner = await ledger.createSyntheticOwner();
    const receipt = await owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-moss"] });
    expect(Date.parse(receipt.recordedAt)).toBe(Date.parse("2026-09-15T08:00:00Z"));
    const app = await testApp();
    const stored = await first<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM daily_wears WHERE user_id = ? AND garment_id = 'shirt-moss' AND status = 'active'", owner.userId);
    expect(stored?.n).toBe(1);
    const error = await refusal(owner.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["no-such-garment"] }));
    expect(error.code).toBe("not_found");
  });

  it("finds the owner-scoped tables of the ledger, so a fingerprint covers them", async () => {
    const tables = await ownerScopedTables();
    expect(tables).toEqual(expect.arrayContaining(["commands", "garments", "stock_events", "daily_wears", "effects"]));
  });

  it("reaches the labelled external doubles (weather) and nothing else outbound", async () => {
    const place = await newPlace("Harness check");
    const scripted = await scriptWeather(place, { "2026-09-15": { morningC: 10, peakC: 18, eveningC: 13 } });
    expect(scripted.requests).toBe(0);
    const elsewhere = await fetch("https://example.com/");
    expect(elsewhere.status).toBe(503);
  });

  it("knows whether this is the strict run", () => {
    expect(typeof STRICT).toBe("boolean");
  });
});
