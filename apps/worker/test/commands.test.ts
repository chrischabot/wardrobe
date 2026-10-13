import { beforeAll, describe, expect, it } from "vitest";
import type { CommandReceipt, InventoryPage } from "@garderobe/contracts";
import { first } from "@garderobe/domain";
import { ownerDay, provisionOwner, testApp, type TestOwner } from "../src/testing/index.ts";

/*
 * The owner fixture here is the REAL one: the supplied profile and the real inventory CSV, imported
 * through the command service. The second owner is a labelled synthetic account used for isolation.
 */
let owner: TestOwner;
let synthetic: TestOwner;
let inventory: InventoryPage;

/** Days as the real owner counts them (the owner's timezone), not UTC dates. */
const today = () => ownerDay(owner);
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string; details: Record<string, any> } }).error;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
  synthetic = await provisionOwner();
  inventory = await owner.api.json("GET", "/v1/wardrobe");
});

/** A wearable owned garment of the real wardrobe with at least one clean unit. */
function wearable(role: string, skip: string[] = []) {
  const item = inventory.items.find((i) => i.garment.acquisition === "owned" && i.garment.roles.includes(role as never) && !skip.includes(i.garment.garmentId) && i.balances.some((b) => b.bucket === "clean" && b.quantity > 0));
  if (!item) throw new Error(`the real wardrobe has no clean ${role}`);
  return item;
}

describe("wardrobe reads (real owner data)", () => {
  it("returns the complete inventory with explicit total, completeness and counts", async () => {
    expect(inventory.complete).toBe(true);
    expect(inventory.nextCursor).toBeNull();
    expect(inventory.total).toBe(inventory.items.length);
    // Every garment the import created is in the snapshot: nothing is silently truncated.
    const app = await testApp();
    const stored = await first<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM garments WHERE user_id = ? AND acquisition != 'disposed' AND merged_into IS NULL", owner.userId);
    expect(inventory.total).toBe(stored!.n);
    expect(inventory.total).toBeGreaterThan(50);
    expect(inventory.counts.owned).toBeGreaterThan(0);
    expect(owner.importResult).not.toBeNull();
  });

  it("pages explicitly: a page says it is not complete and the cursor walks the whole wardrobe once", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: InventoryPage = await owner.api.json("GET", `/v1/wardrobe?limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.total).toBe(inventory.total);
      for (const item of page.items) {
        expect(seen.has(item.garment.garmentId)).toBe(false);
        seen.add(item.garment.garmentId);
      }
      cursor = page.nextCursor;
      // A page never claims to be the whole wardrobe; the end is an explicit null cursor.
      expect(page.complete).toBe(false);
      pages++;
    } while (cursor && pages < 50);
    expect(seen.size).toBe(inventory.total);
  });

  it("reads an item with its ledger facts, availability and media state", async () => {
    const target = wearable("top");
    const item = await owner.api.json("GET", `/v1/items/${target.garment.garmentId}`);
    expect(item.detail.garment.name).toBe(target.garment.name);
    expect(item.detail.wearCountCaveat.length).toBeGreaterThan(0);
    expect(item.availability.garmentId).toBe(target.garment.garmentId);
    expect(item.mediaAvailable).toBe(true);
    // No photograph has been uploaded: the response says so instead of inventing an image.
    expect(item.media.image.hasRealImage).toBe(false);
    const image = await owner.api.get(`/v1/items/${target.garment.garmentId}/image`);
    expect(image.status).toBe(404);
  });

  it("serves the profile exactly as supplied, with its hash, in style and settings", async () => {
    const style = await owner.api.json("GET", "/v1/style");
    const settings = await owner.api.json("GET", "/v1/settings");
    expect(settings.profile.contentSha256).toBe(style.document.contentSha256);
    expect(style.document.contentSha256).toBe("e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198");
    expect(settings.settings.timezone).toBe("Europe/London");
    expect(settings.apiVersion).toBe("v1");
  });

  it("lists every command type with a payload schema", async () => {
    const types = await owner.api.json("GET", "/v1/command-types");
    const names = types.types.map((t: any) => t.type);
    for (const expected of ["wear.record", "care.mark_dirty", "laundry.collect", "board.select", "service.pause", "trip.create", "return.open_case", "feedback.record", "studio.save_combination", "command.undo"]) expect(names).toContain(expected);
    const wear = types.types.find((t: any) => t.type === "wear.record");
    expect(wear.payloadSchema.properties.garmentIds).toBeTruthy();
    expect(wear.class).toBe("observation");
  });
});

describe("commands", () => {
  it("returns a verified receipt and the same receipt again for the same key and body", async () => {
    const shirt = wearable("top");
    const key = `wear-${crypto.randomUUID()}`;
    const payload = { wearingDate: await today(), garmentIds: [shirt.garment.garmentId] };
    const firstResponse = await owner.api.command("wear.record", payload, { idempotencyKey: key });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get("X-Garderobe-Api")).toBe("v1");
    const receipt = (await firstResponse.json()) as CommandReceipt;
    expect(receipt.outcome).toBe("committed");
    expect(receipt.replayed).toBe(false);
    expect(receipt.channel).toBe("ios");
    expect(receipt.actor).toBe("owner");
    expect(receipt.summary).toContain(shirt.garment.name);
    expect(receipt.affected.some((a) => a.kind === "garment" && a.id === shirt.garment.garmentId)).toBe(true);

    const again = (await (await owner.api.command("wear.record", payload, { idempotencyKey: key })).json()) as CommandReceipt;
    expect(again.replayed).toBe(true);
    expect(again.commandId).toBe(receipt.commandId);

    // One counted wear, not two; and the receipt is readable by ID, by key and from the item's history.
    const day = await owner.api.json("GET", `/v1/days/${await today()}`);
    expect(day.garments.filter((g: any) => g.garmentId === shirt.garment.garmentId)).toHaveLength(1);
    expect((await owner.api.json("GET", `/v1/commands/${receipt.commandId}`)).commandId).toBe(receipt.commandId);
    expect((await owner.api.json("GET", `/v1/commands?idempotencyKey=${key}`)).receipts[0].commandId).toBe(receipt.commandId);
    const history = await owner.api.json("GET", `/v1/commands?entity=garment:${shirt.garment.garmentId}`);
    expect(history.receipts.map((r: any) => r.commandId)).toContain(receipt.commandId);
  });

  it("refuses a reused key with a different body and writes nothing", async () => {
    const a = wearable("bottom");
    const key = `reuse-${crypto.randomUUID()}`;
    expect((await owner.api.command("care.mark_dirty", { items: [{ garmentId: a.garment.garmentId, quantity: 1 }] }, { idempotencyKey: key })).status).toBe(200);
    const b = wearable("top", [a.garment.garmentId]);
    const dirtyOf = async (garmentId: string): Promise<number> => {
      const laundry = await owner.api.json("GET", "/v1/laundry");
      return [...laundry.awaitingService, ...laundry.awaitingHandwash].filter((l: any) => l.garmentId === garmentId).reduce((n: number, l: any) => n + l.quantity, 0);
    };
    const before = await dirtyOf(b.garment.garmentId);
    const reused = await owner.api.command("care.mark_dirty", { items: [{ garmentId: b.garment.garmentId, quantity: 1 }] }, { idempotencyKey: key });
    expect(reused.status).toBe(409);
    expect((await errorOf(reused)).code).toBe("idempotency_key_reuse");
    expect(await dirtyOf(a.garment.garmentId)).toBeGreaterThan(0);
    expect(await dirtyOf(b.garment.garmentId)).toBe(before);
  });

  it("rejects unknown types, invalid payloads and garments that do not exist, with typed errors", async () => {
    const unknown = await owner.api.command("wardrobe.write_anything", { sql: "DROP TABLE garments" });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).code).toBe("unknown_command");
    const invalid = await owner.api.command("wear.record", { wearingDate: "yesterday", garmentIds: [] });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).code).toBe("invalid_command");
    const missing = await owner.api.command("wear.record", { wearingDate: await today(), garmentIds: ["gmt_does_not_exist"] });
    expect(missing.status).toBe(404);
    // Nothing was created to make the command succeed.
    expect((await owner.api.json("GET", "/v1/wardrobe")).total).toBe(inventory.total);
  });

  it("takes the owner and the channel from the session, never from the body", async () => {
    const shoe = wearable("footwear");
    const forged = await owner.api.post("/v1/commands", {
      type: "care.mark_dirty",
      payload: { items: [{ garmentId: shoe.garment.garmentId, quantity: 1 }] },
      idempotencyKey: `forge-${crypto.randomUUID()}`,
      authorization: "owner_tap",
      source: { channel: "mcp" },
    });
    expect(forged.status).toBe(403);
    const withUserId = await synthetic.api.post("/v1/commands", {
      type: "care.mark_dirty",
      userId: owner.userId,
      payload: { userId: owner.userId, items: [{ garmentId: shoe.garment.garmentId, quantity: 1 }] },
      idempotencyKey: `forge-${crypto.randomUUID()}`,
      authorization: "owner_tap",
      source: { channel: "ios" },
    });
    // The synthetic owner has no such garment: the other owner's ID in the body changes nothing.
    expect([400, 404]).toContain(withUserId.status);
    const app = await testApp();
    const dirty = await first<{ n: number }>(app.db, "SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_balances WHERE user_id = ? AND garment_id = ? AND bucket = 'dirty'", owner.userId, shoe.garment.garmentId);
    expect(dirty!.n).toBe(0);
  });

  it("refuses system-only authorization from an owner session", async () => {
    const response = await owner.api.post("/v1/commands", { type: "laundry.apply_weekly_reset", payload: {}, idempotencyKey: `sys-${crypto.randomUUID()}`, authorization: "data_import", source: { channel: "ios" } });
    expect(response.status).toBe(403);
  });

  it("undo is a compensating command with its own receipt", async () => {
    const sock = wearable("socks");
    const receipt = (await (await owner.api.command("care.mark_dirty", { items: [{ garmentId: sock.garment.garmentId, quantity: 1 }] })).json()) as CommandReceipt;
    expect(receipt.undo.available).toBe(true);
    const undo = (await (await owner.api.command("command.undo", { commandId: receipt.commandId })).json()) as CommandReceipt;
    expect(undo.outcome).toBe("committed");
    expect(undo.commandId).not.toBe(receipt.commandId);
    // The original receipt still exists.
    expect((await owner.api.get(`/v1/commands/${receipt.commandId}`)).status).toBe(200);
  });
});

describe("offline replay", () => {
  it("runs queued commands in order, independently, and is safe to resubmit", async () => {
    const top = wearable("top");
    const bottom = wearable("bottom", [top.garment.garmentId]);
    const yesterday = await ownerDay(owner, -1);
    const envelope = (type: string, payload: Record<string, unknown>, key: string, occurredAt?: string) => ({ type, payload, idempotencyKey: key, expectedVersions: {}, authorization: "owner_tap", source: { channel: "ios", clientSubmissionId: key }, ...(occurredAt ? { occurredAt } : {}) });
    const keys = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].map((k) => `offline-${k}`);
    const batch = {
      commands: [
        // An observation made offline yesterday, reported today: accepted with its occurrence time.
        envelope("wear.record", { wearingDate: yesterday, garmentIds: [top.garment.garmentId, bottom.garment.garmentId] }, keys[0]!, `${yesterday}T08:00:00Z`),
        envelope("wear.record", { wearingDate: yesterday, garmentIds: ["gmt_not_real"] }, keys[1]!),
        envelope("care.mark_dirty", { items: [{ garmentId: top.garment.garmentId, quantity: 1 }] }, keys[2]!),
      ],
    };
    const result = await owner.api.json("POST", "/v1/commands/batch", batch);
    expect(result.results.map((r: any) => r.status)).toEqual(["receipt", "error", "receipt"]);
    expect(result.results[0].receipt.occurredAt).toBe(`${yesterday}T08:00:00Z`);
    expect(result.results[1].error.code).toBe("not_found");
    expect(result.results[1].retryable).toBe(false);
    expect(result.results.map((r: any) => r.idempotencyKey)).toEqual(keys);

    // The phone did not see the response and sends the same queue again: same receipts, nothing doubled.
    const again = await owner.api.json("POST", "/v1/commands/batch", batch);
    expect(again.results[0].receipt.replayed).toBe(true);
    expect(again.results[0].receipt.commandId).toBe(result.results[0].receipt.commandId);
    expect(again.results[2].receipt.replayed).toBe(true);
    const day = await owner.api.json("GET", `/v1/days/${yesterday}`);
    expect(day.garments.map((g: any) => g.garmentId).sort()).toEqual([top.garment.garmentId, bottom.garment.garmentId].sort());
  });

  it("merges the same wear reported by a second client instead of counting it twice", async () => {
    const top = wearable("top");
    const date = await ownerDay(owner, -3);
    const fromPhone = (await (await owner.api.command("wear.record", { wearingDate: date, garmentIds: [top.garment.garmentId] })).json()) as CommandReceipt;
    const web = owner.api.with({ client: "web" });
    const fromWeb = (await (await web.command("wear.record", { wearingDate: date, garmentIds: [top.garment.garmentId] })).json()) as CommandReceipt;
    expect(fromPhone.outcome).toBe("committed");
    expect(fromWeb.outcome).toBe("merged");
    expect(fromWeb.channel).toBe("web");
    const day = await owner.api.json("GET", `/v1/days/${date}`);
    expect(day.garments).toHaveLength(1);
    expect(day.garments[0].observationCount).toBe(2);
  });
});

describe("isolation between owners", () => {
  it("an owner cannot read or change another owner's garments, receipts or runs", async () => {
    const target = wearable("top");
    expect((await synthetic.api.get(`/v1/items/${target.garment.garmentId}`)).status).toBe(404);
    expect((await synthetic.api.json("GET", "/v1/wardrobe")).total).toBe(0);
    const receipt = (await (await owner.api.command("care.mark_dirty", { items: [{ garmentId: target.garment.garmentId, quantity: 1 }] })).json()) as CommandReceipt;
    expect((await synthetic.api.get(`/v1/commands/${receipt.commandId}`)).status).toBe(404);
    expect((await synthetic.api.json("GET", `/v1/commands?entity=garment:${target.garment.garmentId}`)).receipts).toEqual([]);
    expect((await synthetic.api.command("command.undo", { commandId: receipt.commandId })).status).toBe(404);
    const stolen = await synthetic.api.command("wear.record", { wearingDate: await today(), garmentIds: [target.garment.garmentId] });
    expect(stolen.status).toBe(404);
    // The same idempotency key is independent per owner.
    const key = `shared-${crypto.randomUUID()}`;
    expect((await owner.api.command("settings.update", { patch: { delivery: { morningLocalTime: "07:15" } } }, { idempotencyKey: key })).status).toBe(200);
    expect((await synthetic.api.command("settings.update", { patch: { delivery: { morningLocalTime: "06:30" } } }, { idempotencyKey: key })).status).toBe(200);
    expect((await owner.api.json("GET", "/v1/settings")).settings.delivery.morningLocalTime).toBe("07:15");
    expect((await synthetic.api.json("GET", "/v1/settings")).settings.delivery.morningLocalTime).toBe("06:30");
  });
});
