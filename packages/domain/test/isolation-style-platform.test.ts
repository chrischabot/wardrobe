import { describe, expect, it } from "vitest";
import {
  all,
  claimDueEffects,
  createPrincipal,
  first,
  getAvailability,
  getDailyRecord,
  getGarmentDetail,
  getStyleContext,
  linkIdentity,
  listInventory,
  listRestrictions,
  registerActionIntent,
  resolveAlias,
  resolvePrincipal,
  setUserStatus,
  settleEffect,
  systemPrincipalFor,
  unlinkIdentity,
  define,
} from "../src/index.ts";
import { z } from "zod";
import { createHarness } from "../src/testing/index.ts";
import { balances, countedWears } from "./helpers.ts";

describe("two-owner isolation (synthetic owners with colliding garment IDs)", () => {
  it("commands, reads, receipts, idempotency keys and undo are all scoped to the authenticated owner", async () => {
    const h = await createHarness();
    const a = await h.createSyntheticOwner({ displayName: "Synthetic owner A" });
    const b = await h.createSyntheticOwner({ displayName: "Synthetic owner B" });

    const wearA = await a.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["shirt-moss", "sock-navy"] }, { idempotencyKey: "shared-key-000001" });
    // Same garment IDs, same idempotency key, other owner: an independent command with its own effect.
    const dirtyB = await b.exec("care.mark_dirty", { items: [{ garmentId: "shirt-gold" }] }, { idempotencyKey: "shared-key-000001" });
    expect(dirtyB.commandId).not.toBe(wearA.commandId);
    expect(dirtyB.replayed).toBe(false);

    expect(await balances(h, a, "shirt-moss")).toMatchObject({ clean: 0, dirty: 1 });
    expect(await balances(h, b, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0 });
    expect(await balances(h, a, "shirt-gold")).toMatchObject({ clean: 1, dirty: 0 });
    expect(await countedWears(h, b)).toHaveLength(0);
    expect((await getDailyRecord(h.db, b.principal(), "2026-09-15")).observations).toHaveLength(0);

    // B cannot read or undo A's command, even knowing its ID.
    expect(await h.service.getReceipt(b.principal(), wearA.commandId)).toBeNull();
    expect((await b.exec("command.undo", { commandId: wearA.commandId }).catch((e) => e)).code).toBe("not_found");
    expect(await countedWears(h, a)).toHaveLength(2);
    expect((await h.service.listReceipts(b.principal())).every((r) => r.commandId !== wearA.commandId)).toBe(true);

    // Availability, inventory and item detail only ever show the caller's wardrobe.
    const availabilityB = await getAvailability(h.db, b.principal(), { nowMs: h.clock.now() });
    expect(availabilityB.garments.find((g) => g.garmentId === "shirt-moss")!.status).toBe("available");
    const inventoryA = await listInventory(h.db, a.principal(), {}, { nowMs: h.clock.now() });
    expect(inventoryA.items.every((i) => i.garment.userId === a.userId)).toBe(true);
    expect(inventoryA.items.every((i) => i.garment.isSynthetic)).toBe(true);
  });

  it("a garment that exists only for one owner cannot be targeted, read or referenced by another", async () => {
    const h = await createHarness();
    const a = await h.createSyntheticOwner({ garments: [{ id: "only-a", name: "owner A's coat", category: "outerwear", roles: ["outer"], careChannel: "none" }] });
    const b = await h.createSyntheticOwner({ garments: [{ id: "only-b", name: "owner B's coat", category: "outerwear", roles: ["outer"], careChannel: "none" }] });

    expect((await b.exec("wear.record", { wearingDate: "2026-09-15", garmentIds: ["only-a"] }).catch((e) => e)).code).toBe("not_found");
    expect((await b.exec("garment.merge", { sourceGarmentId: "only-b", targetGarmentId: "only-a" }).catch((e) => e)).code).toBe("not_found");
    expect((await b.exec("restriction.add", { kind: "other", scope: { garmentIds: ["only-a"] }, reason: "x", source: { kind: "owner_statement" } }).catch((e) => e)).code).toBe("not_found");
    expect((await b.exec("exposure.publish", { localDate: "2026-09-15", sourceKind: "test", sourceRef: "t", options: [{ optionId: "o", garmentIds: ["only-a"] }] }, { authorization: "owner_tap" }).catch((e) => e)).code).toBe("not_found");
    expect((await getGarmentDetail(h.db, b.principal(), "only-a").catch((e) => e)).code).toBe("not_found");
    expect((await resolveAlias(h.db, b.principal(), "owner A's coat")).matches).toHaveLength(0);

    // The schema itself refuses a cross-owner relationship (compound foreign keys).
    const cmd = await first<{ command_id: string }>(h.db, "SELECT command_id FROM commands WHERE user_id = ? LIMIT 1", b.userId);
    const fk = await h.db
      .prepare("INSERT INTO wear_observations (user_id, observation_id, garment_id, wearing_date, occurred_at, reported_at, timezone, channel, command_id) VALUES (?, 'x', 'only-a', '2026-09-15', 'x', 'x', 'UTC', 'test', ?)")
      .bind(b.userId, cmd!.command_id)
      .run()
      .catch((e: unknown) => e);
    expect(String((fk as Error).message)).toContain("FOREIGN KEY");
    expect(await balances(h, a, "only-a")).toMatchObject({ clean: 1 });
  });

  it("ownership fields in a request body are never authoritative", async () => {
    const h = await createHarness();
    const a = await h.createSyntheticOwner();
    const b = await h.createSyntheticOwner();
    // A forged owner in the payload and the envelope is ignored: the write lands on the principal's wardrobe.
    const receipt = await h.service.execute(b.principal(), {
      type: "care.mark_dirty",
      payload: { items: [{ garmentId: "shirt-moss" }], userId: a.userId, user_id: a.userId, ownerId: a.userId },
      idempotencyKey: "forged-owner-0001",
      authorization: "owner_tap",
      source: { channel: "ios" },
      userId: a.userId,
    } as never);
    expect(receipt.outcome).toBe("committed");
    expect(await balances(h, a, "shirt-moss")).toMatchObject({ clean: 1, dirty: 0 });
    expect(await balances(h, b, "shirt-moss")).toMatchObject({ clean: 0, dirty: 1 });
    // A principal on one channel cannot submit under another channel's name.
    const spoof = await h.service
      .execute(b.principal({ channel: "mcp", actor: "assistant" }), { type: "care.mark_dirty", payload: { items: [{ garmentId: "shirt-gold" }] }, idempotencyKey: "channel-spoof-001", authorization: "owner_statement", source: { channel: "ios" } })
      .catch((e) => e);
    expect(spoof.code).toBe("forbidden");
  });

  it("identity maps by (issuer, subject) only: unknown subjects, unlinked identities and matching emails are rejected", async () => {
    const h = await createHarness();
    const a = await h.createSyntheticOwner();
    const b = await h.createSyntheticOwner();
    const issuer = `https://access.example.test/${a.userId}`;
    await linkIdentity(h.db, { userId: a.userId, issuer, subject: "sub-a", displayEmail: "same@example.test" });
    const grant = { actor: "owner" as const, channel: "ios" as const, scopes: ["read" as const, "write" as const], authRef: "test" };
    expect((await resolvePrincipal(h.db, { issuer, subject: "sub-a" }, grant)).userId).toBe(a.userId);
    expect((await resolvePrincipal(h.db, { issuer, subject: "sub-unknown" }, grant).catch((e) => e)).code).toBe("forbidden");
    // The same email under another subject is not an account link, and a subject cannot be re-linked to another user.
    await linkIdentity(h.db, { userId: b.userId, issuer, subject: "sub-b", displayEmail: "same@example.test" });
    expect((await resolvePrincipal(h.db, { issuer, subject: "sub-b" }, grant)).userId).toBe(b.userId);
    expect((await linkIdentity(h.db, { userId: b.userId, issuer, subject: "sub-a" }).catch((e) => e)).code).toBe("forbidden");
    // Unlinking an identity does not delete the wardrobe.
    await unlinkIdentity(h.db, { userId: a.userId, issuer, subject: "sub-a" });
    expect((await resolvePrincipal(h.db, { issuer, subject: "sub-a" }, grant).catch((e) => e)).code).toBe("forbidden");
    expect((await listInventory(h.db, a.principal(), {}, { nowMs: h.clock.now() })).total).toBe(19);
    expect(() => createPrincipal({ userId: "", actor: "owner", channel: "ios", scopes: ["read"], authRef: "x" })).toThrow();
  });
});

describe("restrictions", () => {
  it("only the owner's tap or statement with the required evidence lifts a restriction; schedules and time never do", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const added = await owner.exec("restriction.add", {
      kind: "healing",
      scope: { anyOf: [{ category: "footwear", footwearKinds: ["welted", "boot", "other"] }, { models: ["990v6"] }] },
      reason: "sneakers only until healed",
      expectedEnd: "2026-09-20T00:00:00Z",
      source: { kind: "owner_statement" },
    });
    const id = added.result.restrictionId as string;
    expect((added.result.coveredGarmentIds as string[]).sort()).toEqual(["shoe-990v6", "shoe-welted"]);

    // Long after the predicted end, nothing has changed by itself.
    h.clock.set("2026-12-01T09:00:00Z");
    await owner.exec("laundry.apply_weekly_reset", {}, { actor: "system", channel: "scheduled", authorization: "standing_policy" });
    expect((await listRestrictions(h.db, owner.principal(), { status: "active" })).map((r) => r.restrictionId)).toEqual([id]);
    const scheduled = await owner.exec("restriction.resolve", { restrictionId: id, evidence: { kind: "system" } }, { actor: "system", channel: "scheduled", authorization: "system_schedule" }).catch((e) => e);
    expect(scheduled.code).toBe("forbidden");
    const inferred = await owner.exec("restriction.resolve", { restrictionId: id, evidence: { kind: "model_inference", note: "it has been months" } }, { actor: "assistant", channel: "conversation", authorization: "owner_statement" }).catch((e) => e);
    expect(inferred.code).toBe("forbidden");
    expect((await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() })).garments.find((g) => g.garmentId === "shoe-welted")!.hardExcluded).toBe(true);

    // A newly acquired 990v6 is covered by the same selector.
    await owner.exec("garment.create", { garmentId: "shoe-990v6-grey", name: "grey 990v6", category: "footwear", roles: ["footwear"], careChannel: "none", attributes: { footwearKind: "sneaker", model: "990V6" }, acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "owner_statement" } });
    expect((await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() })).garments.find((g) => g.garmentId === "shoe-990v6-grey")!.reasons).toContain("restricted");

    const resolved = await owner.exec("restriction.resolve", { restrictionId: id, evidence: { kind: "owner_statement", note: "my feet have healed" } }, { actor: "assistant", channel: "conversation", authorization: "owner_statement" });
    expect((resolved.result.releasedGarmentIds as string[]).sort()).toEqual(["shoe-990v6", "shoe-990v6-grey", "shoe-welted"]);
    expect((await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() })).garments.find((g) => g.garmentId === "shoe-welted")!.status).toBe("available");
    // Undo reinstates it through a compensating command.
    await owner.exec("command.undo", { commandId: resolved.commandId });
    expect(await listRestrictions(h.db, owner.principal(), { status: "active" })).toHaveLength(1);
  });
});

describe("style profile, amendments, rules, directions and settings", () => {
  const profile = "# Synthetic profile\n\nPlain, humble, just me.\nSocks always.\n";

  async function ownerWithProfile() {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const { sha256Hex } = await import("../src/index.ts");
    const hash = await sha256Hex(profile);
    const importOpts = { actor: "system" as const, channel: "import" as const, scopes: ["read" as const, "write" as const, "admin" as const], authorization: "data_import" as const };
    await owner.exec("style.import_document", { title: "Synthetic profile", content: profile, expectedSha256: hash, source: { kind: "import" } }, importOpts);
    return { h, owner, hash, importOpts };
  }

  it("imports verbatim with a verified hash, versions every save, and keeps amendments individually", async () => {
    const { h, owner, hash, importOpts } = await ownerWithProfile();
    const wrong = await owner.exec("style.import_document", { documentId: "other", title: "x", content: profile + " ", expectedSha256: hash, source: { kind: "import" } }, importOpts).catch((e) => e);
    expect(wrong.code).toBe("precondition_failed");

    const a1 = await owner.exec("style.add_amendment", { text: "Feet healed on 1 October; welted shoes are back.", kind: "restriction", source: { kind: "owner_statement" } });
    const a2 = await owner.exec("style.add_amendment", { text: "Chest now 43 inches.", kind: "measurement", source: { kind: "owner_statement" } });
    const model = await owner.exec("style.add_amendment", { text: "He probably likes watches now.", kind: "taste", source: { kind: "model_inference" } }, { actor: "assistant", channel: "conversation", authorization: "owner_statement" }).catch((e) => e);
    expect(model.code).toBe("forbidden");

    let ctx = await getStyleContext(h.db, owner.principal());
    expect(ctx.document.content).toBe(profile); // the full text, never a summary
    expect(ctx.document.contentSha256).toBe(hash);
    expect(ctx.amendments.map((a) => a.text)).toEqual(["Feet healed on 1 October; welted shoes are back.", "Chest now 43 inches."]);
    expect(ctx.precedence).toContain("physical reality and hard restrictions");
    const revisionBefore = ctx.styleRevision;

    const saved = await owner.exec("style.save_document", { content: profile + "\nChest 43 inches.\n", incorporateAmendmentIds: [a2.result.amendmentId as string], source: { kind: "owner_statement" } }, { expectedVersions: { "style_document:owner-profile": 1 } });
    expect(saved.result).toMatchObject({ version: 2, previousVersion: 1 });
    ctx = await getStyleContext(h.db, owner.principal());
    expect(ctx.document.version).toBe(2);
    expect(ctx.styleRevision).toBeGreaterThan(revisionBefore); // caches keyed by revision are invalidated
    expect(ctx.amendments.map((a) => a.amendmentId)).toEqual([a1.result.amendmentId]); // the other stays active

    // A second editor with the old version gets a clean conflict; the original text is still retrievable.
    const stale = await owner.exec("style.save_document", { content: "overwrite", source: { kind: "owner_statement" } }, { expectedVersions: { "style_document:owner-profile": 1 } }).catch((e) => e);
    expect(stale.code).toBe("conflict");
    const v1 = await first<{ content: string; status: string }>(h.db, "SELECT content, status FROM style_documents WHERE user_id = ? AND version = 1", owner.userId);
    expect(v1).toEqual({ content: profile, status: "superseded" });

    await owner.exec("command.undo", { commandId: saved.commandId });
    ctx = await getStyleContext(h.db, owner.principal());
    expect(ctx.document).toMatchObject({ version: 3, content: profile });
    expect(ctx.amendments).toHaveLength(2);
  });

  it("a profile-derived rule must quote its passage verbatim; directions take effect immediately and undo cleanly; briefs are per day", async () => {
    const { h, owner, hash } = await ownerWithProfile();
    const bad = await owner.exec("style.upsert_rule", { key: "socks.required", kind: "hard", status: "active", interpretation: "x", origin: "profile", passages: [{ documentSha256: hash, lineStart: 4, lineEnd: 4, quote: "Socks are optional." }] }).catch((e) => e);
    expect(bad.code).toBe("precondition_failed");
    await owner.exec("style.upsert_rule", { key: "socks.required", kind: "hard", status: "active", interpretation: "every outfit has socks", origin: "profile", passages: [{ documentSha256: hash, lineStart: 4, lineEnd: 4, quote: "Socks always." }] });
    await owner.exec("style.upsert_rule", { key: "socks.required", kind: "hard", status: "active", params: { default: "merino" }, interpretation: "every outfit has socks, merino by default", origin: "profile", passages: [{ documentSha256: hash, lineStart: 4, lineEnd: 4, quote: "Socks always." }] });

    const direction = await owner.exec("style.add_direction", { text: "Stop making navy the default swap.", checkKey: "swap.never_fall_back_to_navy", source: { kind: "owner_statement" } });
    expect(direction.undo.available).toBe(true);
    await owner.exec("style.set_brief", { localDate: "2026-09-16", text: "Make tomorrow more dramatic.", source: { kind: "owner_statement" } });

    const tomorrow = await getStyleContext(h.db, owner.principal(), { forDate: "2026-09-16" });
    expect(tomorrow.rules).toHaveLength(1);
    expect(tomorrow.rules[0]).toMatchObject({ key: "socks.required", version: 2, params: { default: "merino" } });
    expect(tomorrow.directions.map((d) => d.text)).toEqual(["Stop making navy the default swap."]);
    expect(tomorrow.briefs.map((b) => b.text)).toEqual(["Make tomorrow more dramatic."]);
    // The one-day brief does not leak into another day and did not rewrite the profile or the directions.
    const later = await getStyleContext(h.db, owner.principal(), { forDate: "2026-09-17" });
    expect(later.briefs).toEqual([]);
    expect(later.document.version).toBe(1);

    await owner.exec("command.undo", { commandId: direction.commandId });
    expect((await getStyleContext(h.db, owner.principal())).directions).toEqual([]);
  });

  it("measurements are dated facts from the owner, superseded without erasure, never inferred from a photo", async () => {
    const { h, owner } = await ownerWithProfile();
    await owner.exec("measurement.record", { subject: "body", key: "chest", value: 44, unit: "in", convention: "body circumference", measuredOn: "2026-06-01", source: { kind: "owner_statement" } });
    await owner.exec("measurement.record", { subject: "body", key: "chest", value: 43, unit: "in", convention: "body circumference", measuredOn: "2026-10-01", source: { kind: "owner_statement" } });
    const photo = await owner.exec("measurement.record", { subject: "body", key: "chest", value: 40, unit: "in", source: { kind: "photograph" } }).catch((e) => e);
    expect(photo.code).toBe("forbidden");
    const ctx = await getStyleContext(h.db, owner.principal());
    expect(ctx.measurements.map((m) => [m.key, m.value, m.unit, m.measuredOn])).toEqual([["chest", 43, "in", "2026-10-01"]]);
    expect(await all(h.db, "SELECT 1 FROM measurements WHERE user_id = ?", owner.userId)).toHaveLength(2);
  });

  it("settings are versioned, validated and undoable; laundry days are editable", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const invalid = await owner.exec("settings.update", { patch: { delivery: { defaultOptionCount: 9 } } }).catch((e) => e);
    expect(invalid.code).toBe("invalid_command");
    const updated = await owner.exec("settings.update", { patch: { laundry: { service: { collectionWeekday: 4, baselineWeekday: 6 } }, delivery: { defaultOptionCount: 3 } } }, { expectedVersions: { settings: 1 } });
    expect(updated.result.version).toBe(2);
    const stale = await owner.exec("settings.update", { patch: { timezone: "Europe/Amsterdam" } }, { expectedVersions: { settings: 1 } }).catch((e) => e);
    expect(stale.code).toBe("conflict");
    await owner.exec("command.undo", { commandId: updated.commandId });
    const row = await first<{ version: number; settings_json: string }>(h.db, "SELECT version, settings_json FROM owner_settings WHERE user_id = ?", owner.userId);
    expect(row!.version).toBe(3);
    expect(JSON.parse(row!.settings_json).laundry.service).toMatchObject({ collectionWeekday: 5, baselineWeekday: 7 });
    expect(await all(h.db, "SELECT 1 FROM owner_settings_versions WHERE user_id = ?", owner.userId)).toHaveLength(3);
  });
});

describe("aliases", () => {
  it("an ambiguous phrase returns every match with distinguishing facts and is never resolved to the first result", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const blue = await resolveAlias(h.db, owner.principal(), "blue stripe");
    expect(blue.ambiguous).toBe(true);
    expect(blue.matches.map((m) => m.garmentId).sort()).toEqual(["shirt-blue-stripe-a", "shirt-blue-stripe-b"]);
    expect(new Set(blue.matches.map((m) => m.distinguishing)).size).toBe(2); // the one question can name the difference
    await owner.exec("garment.add_alias", { garmentId: "shirt-blue-stripe-b", phrase: "the summer stripe" });
    const exact = await resolveAlias(h.db, owner.principal(), "The Summer Stripe");
    expect(exact).toMatchObject({ ambiguous: false });
    expect(exact.matches.map((m) => m.garmentId)).toEqual(["shirt-blue-stripe-b"]);
    // An owner correction of the name governs what he dresses from; the old name still finds the garment.
    await owner.exec("garment.correct", { garmentId: "shoe-olive", changes: { name: "rust sneakers", colour: "Rust" }, source: { kind: "owner_statement", note: "they read rust to me" } });
    expect((await resolveAlias(h.db, owner.principal(), "rust sneakers")).matches.map((m) => m.garmentId)).toEqual(["shoe-olive"]);
    expect((await resolveAlias(h.db, owner.principal(), "olive 990v4 sneakers")).matches.map((m) => m.garmentId)).toEqual(["shoe-olive"]);
    const detail = await getGarmentDetail(h.db, owner.principal(), "shoe-olive");
    expect(detail.garment).toMatchObject({ name: "rust sneakers", colour: "Rust" });
    expect(detail.facts.filter((f) => f.attribute === "colour").map((f) => (f.value as { previous: string }).previous)).toEqual(["Olive"]);
    expect(detail.wearCountCaveat).toContain("never unworn");
  });
});

describe("action intents, effects and outbox", () => {
  it("a resampled proposal of the same effect resolves to the same action and one command", async () => {
    const h = await createHarness();
    const owner = await h.createSyntheticOwner();
    const p = owner.principal({ channel: "conversation", actor: "assistant" });
    const effect = { wearingDate: "2026-09-15", garmentIds: ["shirt-moss"] };
    const first1 = await registerActionIntent(h.db, p, { parentKind: "turn", parentId: "turn-1", operation: "wear.record", targets: ["shirt-moss"], effect, nowMs: h.clock.now() });
    const run = (key: string, actionId: string) => h.service.execute(p, { type: "wear.record", payload: effect, idempotencyKey: key, authorization: "owner_statement", source: { channel: "conversation", parentKind: "turn", parentId: "turn-1", actionId } });
    const r1 = await run(first1.idempotencyKey, first1.actionId);
    // Recovery: the model is resampled and proposes the same effect under a new provider tool-call ID.
    const second = await registerActionIntent(h.db, p, { parentKind: "turn", parentId: "turn-1", operation: "wear.record", targets: ["shirt-moss"], effect: { garmentIds: ["shirt-moss"], wearingDate: "2026-09-15" }, nowMs: h.clock.now() });
    expect(second).toMatchObject({ actionId: first1.actionId, existing: true, state: "committed", commandId: r1.commandId });
    const r2 = await run(second.idempotencyKey, second.actionId);
    expect(r2).toMatchObject({ commandId: r1.commandId, replayed: true });
    // A genuinely different effect in the same turn is a different action.
    const other = await registerActionIntent(h.db, p, { parentKind: "turn", parentId: "turn-1", operation: "wear.record", targets: ["shirt-gold"], effect: { wearingDate: "2026-09-15", garmentIds: ["shirt-gold"] }, nowMs: h.clock.now() });
    expect(other.actionId).not.toBe(first1.actionId);
    expect(await countedWears(h, owner)).toHaveLength(1);
  });

  it("effects commit with their command, are claimed once, and a projected newer revision supersedes a delayed older one", async () => {
    const h = await createHarness();
    h.registry.register(
      define({
        type: "test.publish",
        schema: z.object({ revision: z.number().int() }),
        class: "system",
        requiredScope: "write",
        async plan(_ctx, p) {
          return {
            summary: `published revision ${p.revision}`,
            effects: [{ kind: "calendar.project_board", targetKey: "event:2026-09-16", operationKey: `event:2026-09-16:r${p.revision}`, desiredRevision: p.revision, payload: { revision: p.revision } }],
            outbox: [{ topic: "board", entityKind: "board", entityId: "2026-09-16", revision: p.revision }],
          };
        },
      }),
    );
    const owner = await h.createSyntheticOwner();
    const sys = { actor: "system" as const, channel: "scheduled" as const, authorization: "system_schedule" as const };
    const r11 = await owner.exec("test.publish", { revision: 11 }, sys);
    expect(r11.externalEffectState).toBe("projection_pending"); // committed is not "calendar updated"
    expect(r11.effects).toHaveLength(1);
    await owner.exec("test.publish", { revision: 12 }, sys);

    const mine = (list: Awaited<ReturnType<typeof claimDueEffects>>) => list.filter((e) => e.userId === owner.userId);
    const claimed = mine(await claimDueEffects(h.db, { nowMs: h.clock.now(), kinds: ["calendar.project_board"], limit: 500 }));
    expect(claimed.map((e) => e.desiredRevision).sort()).toEqual([11, 12]);
    expect(mine(await claimDueEffects(h.db, { nowMs: h.clock.now(), kinds: ["calendar.project_board"], limit: 500 }))).toHaveLength(0); // leased

    // Revision 12 is verified first; the delayed revision 11 is superseded and can never be delivered afterwards.
    await settleEffect(h.db, claimed.find((e) => e.desiredRevision === 12)!, { state: "projected" }, h.clock.now());
    const states = await all<{ desired_revision: number; state: string }>(h.db, "SELECT desired_revision, state FROM effects WHERE user_id = ? ORDER BY desired_revision", owner.userId);
    expect(states).toEqual([{ desired_revision: 11, state: "superseded" }, { desired_revision: 12, state: "projected" }]);
    h.clock.advanceMinutes(10);
    expect(mine(await claimDueEffects(h.db, { nowMs: h.clock.now(), limit: 500 }))).toHaveLength(0);

    // Scheduled authority stops with the account.
    await owner.exec("test.publish", { revision: 13 }, sys);
    await setUserStatus(h.db, owner.userId, "disabled");
    expect(mine(await claimDueEffects(h.db, { nowMs: h.clock.now(), limit: 500 }))).toHaveLength(0);
    expect((await systemPrincipalFor(h.db, owner.userId, "job-1").catch((e) => e)).code).toBe("forbidden");
    const outbox = await all<{ revision: number }>(h.db, "SELECT revision FROM outbox WHERE user_id = ? AND topic = 'board' ORDER BY seq", owner.userId);
    expect(outbox.map((o) => o.revision)).toEqual([11, 12, 13]);
  });
});
