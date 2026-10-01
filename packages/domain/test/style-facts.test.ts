import { describe, expect, it } from "vitest";
import { all, deriveFactDiff, getAvailability, getStyleContext, listRestrictions, listStyleFactConflicts, previewStyleSave, sha256Hex, type AnchoredFact } from "../src/index.ts";
import { HEALING_RESTRICTION_ID } from "../src/import/index.ts";
import { createHarness, ownerDocuments, type Harness, type TestOwner } from "../src/testing/index.ts";

const hashOf = (text: string) => sha256Hex(new TextEncoder().encode(text));
const STATEMENT = { kind: "owner_statement" as const };

/* A labelled synthetic profile: every fact below is test data, not the owner's. */
const PROFILE = ["# Synthetic profile (test fixture)", "", "Socks always.", "Chest 44 inches; neck 17 inches.", "", "Jackets: 46 at Maker A.", "Plain, humble, just me.", ""].join("\n");

async function syntheticOwnerWithFacts(): Promise<{ h: Harness; owner: TestOwner; ids: { chest: string; neck: string; size: string } }> {
  const h = await createHarness();
  const owner = await h.createSyntheticOwner({ garments: [] });
  const sha = await hashOf(PROFILE);
  const importOpts = { actor: "system" as const, channel: "import" as const, scopes: ["read" as const, "write" as const, "admin" as const], authorization: "data_import" as const };
  await owner.exec("style.import_document", { title: "Synthetic profile", content: PROFILE, expectedSha256: sha, source: { kind: "import" } }, importOpts);
  const passage = (quote: string, line: number) => ({ documentSha256: sha, lineStart: line, lineEnd: line, quote });
  await owner.exec("style.upsert_rule", { key: "socks.required", kind: "hard", status: "active", params: { required: true }, interpretation: "every outfit has socks", origin: "profile", passages: [passage("Socks always.", 3)] });
  const body = { subject: "body", unit: "in", convention: "body circumference", source: STATEMENT, passage: passage("Chest 44 inches; neck 17 inches.", 4) };
  const chest = await owner.exec("measurement.record", { ...body, key: "chest", value: 44 });
  const neck = await owner.exec("measurement.record", { ...body, key: "neck", value: 17 });
  const size = await owner.exec("size_experience.record", { maker: "Maker A", productFamily: "jackets", sizeLabel: "46", passage: passage("Jackets: 46 at Maker A.", 6) });
  return { h, owner, ids: { chest: chest.result.measurementId as string, neck: neck.result.measurementId as string, size: size.result.sizeExperienceId as string } };
}

const measurementsOf = async (h: Harness, owner: TestOwner) => Object.fromEntries((await getStyleContext(h.db, owner.principal())).measurements.map((m) => [m.key, m.value]));

describe("deriving the structured-fact diff of a profile edit (pure)", () => {
  const fact = (id: string, ...quotes: string[]): AnchoredFact => ({ ref: { kind: "rule", id }, label: id, passages: quotes.map((quote) => ({ documentSha256: "a".repeat(64), lineStart: 1, lineEnd: 1, quote })) });
  const before = "One.\nSocks always.\nNo watches.\nLast.";

  it("a passage that only moved is unchanged and relocated; a reworded one carries the new wording; a deleted one has none", () => {
    const after = "Brand new opening line.\nOne.\nSocks, nearly always.\nLast.";
    const diff = deriveFactDiff(before, after, "b".repeat(64), [fact("keeps", "One.", "Last."), fact("socks", "Socks always."), fact("watches", "No watches."), fact("detached", "Never in the text.")]);
    expect(diff.anchored.map((f) => f.ref.id)).toEqual(["keeps", "socks", "watches"]); // a fact that never quoted this text is not this edit's business
    expect(diff.unchanged.map((u) => [u.fact.ref.id, u.passages.map((p) => [p.lineStart, p.documentSha256[0]])])).toEqual([["keeps", [[2, "b"], [4, "b"]]]]);
    // "Socks always." and "No watches." sat in one edited region, so the same new wording is shown for both; neither is interpreted.
    expect(diff.affected.map((a) => [a.fact.ref.id, a.reason, a.candidateText])).toEqual([
      ["socks", "passage_changed", "Socks, nearly always."],
      ["watches", "passage_changed", "Socks, nearly always."],
    ]);
    expect(diff.addedText).toEqual([{ lineStart: 1, lineEnd: 1 }, { lineStart: 3, lineEnd: 3 }]);

    const removed = deriveFactDiff(before, "One.\nSocks always.\nLast.", "c".repeat(64), [fact("watches", "No watches.")]);
    expect(removed.affected.map((a) => [a.reason, a.candidateText, a.missingQuotes])).toEqual([["passage_removed", null, ["No watches."]]]);
  });
});

describe("Save in My style derives a diff of structured facts", () => {
  it("an edit that leaves every quoted passage intact re-anchors the facts to the new version and opens no conflict", async () => {
    const { h, owner } = await syntheticOwnerWithFacts();
    const edited = PROFILE.replace("# Synthetic profile (test fixture)", "# Synthetic profile (test fixture)\n\nA new opening paragraph about cloth.");
    const preview = await previewStyleSave(h.db, owner.principal(), { content: edited });
    expect(preview).toMatchObject({ fromVersion: 1, contentChanged: true, anchoredFacts: 4, unchanged: 4, conflicts: [], applied: [] });
    expect((await getStyleContext(h.db, owner.principal())).document.version).toBe(1); // a preview writes nothing

    const saved = await owner.exec("style.save_document", { content: edited, source: STATEMENT }, { expectedVersions: { "style_document:owner-profile": 1 } });
    const diff = saved.result.factDiff as typeof preview;
    expect(diff).toEqual(preview);
    expect(diff.addedText).toHaveLength(1); // the inserted paragraph and its blank line
    expect(diff.addedText[0]!.lineEnd - diff.addedText[0]!.lineStart).toBe(1);
    const ctx = await getStyleContext(h.db, owner.principal());
    const newSha = await hashOf(edited);
    expect(ctx.rules[0]!.passages).toEqual([{ documentSha256: newSha, lineStart: 5, lineEnd: 5, quote: "Socks always." }]);
    expect(ctx.measurements.map((m) => [m.key, m.value, m.passage!.documentSha256 === newSha, m.passage!.lineStart])).toEqual([["chest", 44, true, 6], ["neck", 17, true, 6]]);
    expect(ctx.sizeExperiences[0]!.passage).toMatchObject({ documentSha256: newSha, lineStart: 8 });
    expect(ctx.rules[0]!.version).toBe(1); // moving a reference is not a new rule version
    expect(ctx.factConflicts).toEqual([]);

    // A second save against the version the first one replaced is a clean conflict, not a silent overwrite.
    const stale = await owner.exec("style.save_document", { content: edited + "More.\n", source: STATEMENT }, { expectedVersions: { "style_document:owner-profile": 1 } }).catch((e) => e);
    expect(stale.code).toBe("conflict");
  });

  it("a reworded passage never changes a fact by itself: the fact stays in force and the conflict stays visible until the owner decides", async () => {
    const { h, owner, ids } = await syntheticOwnerWithFacts();
    const edited = PROFILE.replace("Chest 44 inches; neck 17 inches.", "Chest 43 inches now; neck 17 inches.").replace("Jackets: 46 at Maker A.\n", "");
    const saved = await owner.exec("style.save_document", { content: edited, source: STATEMENT });
    expect(saved.summary).toContain("3 structured fact(s) no longer match the text and stay in force until decided");
    const diff = saved.result.factDiff as Awaited<ReturnType<typeof previewStyleSave>>;
    expect(diff.conflicts.map((c) => [c.fact, c.reason, c.candidateText])).toEqual([
      [{ kind: "measurement", id: ids.chest }, "passage_changed", "Chest 43 inches now; neck 17 inches."],
      [{ kind: "measurement", id: ids.neck }, "passage_changed", "Chest 43 inches now; neck 17 inches."],
      [{ kind: "size_experience", id: ids.size }, "passage_removed", null],
    ]);
    expect(diff.unchanged).toBe(1);

    // Nothing was invented: the recorded chest is still 44 and the size experience still stands.
    let ctx = await getStyleContext(h.db, owner.principal());
    expect(await measurementsOf(h, owner)).toEqual({ chest: 44, neck: 17 });
    expect(ctx.sizeExperiences).toHaveLength(1);
    expect(ctx.factConflicts!.map((c) => [c.fact.kind, c.status, c.fromVersion, c.toVersion, c.missingQuotes[0]])).toEqual([
      ["measurement", "open", 1, 2, "Chest 44 inches; neck 17 inches."],
      ["measurement", "open", 1, 2, "Chest 44 inches; neck 17 inches."],
      ["size_experience", "open", 1, 2, "Jackets: 46 at Maker A."],
    ]);

    // A further edit elsewhere does not open the same conflict twice or lose it.
    await owner.exec("style.save_document", { content: edited + "Cloth matters.\n", source: STATEMENT });
    expect(await listStyleFactConflicts(h.db, owner.principal())).toHaveLength(3);

    // Stating the fact anew through its own command settles its conflict without a second decision.
    const direct = await syntheticOwnerWithFacts();
    await direct.owner.exec("style.save_document", { content: edited, source: STATEMENT });
    await direct.owner.exec("measurement.record", { subject: "body", key: "chest", value: 43, unit: "in", source: STATEMENT });
    expect((await listStyleFactConflicts(direct.h.db, direct.owner.principal())).map((c) => c.fact.id).sort()).toEqual([direct.ids.neck, direct.ids.size].sort());

    // The owner decides each one. A quote that is not in the saved text is refused.
    const byFact = new Map(ctx.factConflicts!.map((c) => [c.fact.id, c.conflictId]));
    const wrongQuote = await owner.exec("style.resolve_fact_conflict", { conflictId: byFact.get(ids.chest), resolution: { action: "replace", quote: "Chest 42 inches", measurement: { value: 43, unit: "in" } } }).catch((e) => e);
    expect(wrongQuote.code).toBe("precondition_failed");
    const model = await owner.exec("style.resolve_fact_conflict", { conflictId: byFact.get(ids.chest), resolution: { action: "replace", measurement: { value: 43, unit: "in" } } }, { actor: "assistant", channel: "conversation", authorization: "standing_policy" }).catch((e) => e);
    expect(model.code).toBe("forbidden"); // only the owner's tap or statement decides

    const chest = await owner.exec("style.resolve_fact_conflict", { conflictId: byFact.get(ids.chest), resolution: { action: "replace", quote: "Chest 43 inches now", measurement: { value: 43, unit: "in", measuredOn: "2026-10-01" } } });
    await owner.exec("style.resolve_fact_conflict", { conflictId: byFact.get(ids.neck), resolution: { action: "keep", quote: "neck 17 inches." } });
    const retire = await owner.exec("style.resolve_fact_conflict", { conflictId: byFact.get(ids.size), resolution: { action: "retire", note: "sold the jackets" } });
    const retireMeasurement = await owner.exec("style.resolve_fact_conflict", { conflictId: byFact.get(ids.neck), resolution: { action: "retire" } });
    expect(retireMeasurement.outcome).toBe("noop"); // already decided

    ctx = await getStyleContext(h.db, owner.principal());
    expect(ctx.factConflicts).toEqual([]);
    expect(ctx.measurements.map((m) => [m.key, m.value, m.measuredOn, m.passage?.quote])).toEqual([["chest", 43, "2026-10-01", "Chest 43 inches now"], ["neck", 17, null, "neck 17 inches."]]);
    expect(ctx.sizeExperiences).toEqual([]);
    expect(await all(h.db, "SELECT 1 FROM measurements WHERE user_id = ?", owner.userId)).toHaveLength(3); // 44 is superseded, not erased
    expect(await all(h.db, "SELECT 1 FROM size_experiences WHERE user_id = ?", owner.userId)).toHaveLength(1); // retired, not deleted

    // Undo is a compensating command: the decision is withdrawn and the conflict is open again.
    await owner.exec("command.undo", { commandId: chest.commandId });
    await owner.exec("command.undo", { commandId: retire.commandId });
    ctx = await getStyleContext(h.db, owner.principal());
    expect(await measurementsOf(h, owner)).toEqual({ chest: 44, neck: 17 });
    expect(ctx.sizeExperiences).toHaveLength(1);
    expect(ctx.factConflicts!.map((c) => c.fact.id).sort()).toEqual([ids.chest, ids.size].sort());
  });

  it("clear owner decisions apply atomically with the new version and its amendments, and one undo takes all of it back", async () => {
    const { h, owner, ids } = await syntheticOwnerWithFacts();
    const amendment = await owner.exec("style.add_amendment", { text: "Chest now 43 inches.", kind: "measurement", source: STATEMENT });
    const edited = PROFILE.replace("Chest 44 inches; neck 17 inches.", "Chest 43 inches; neck 17 inches.").replace("Socks always.", "Socks always, merino by default.");
    const payload = {
      content: edited,
      incorporateAmendmentIds: [amendment.result.amendmentId],
      source: STATEMENT,
      factResolutions: [
        { fact: { kind: "measurement", id: ids.chest }, resolution: { action: "replace", quote: "Chest 43 inches; neck 17 inches.", measurement: { value: 43, unit: "in" } } },
        { fact: { kind: "measurement", id: ids.neck }, resolution: { action: "keep", quote: "Chest 43 inches; neck 17 inches." } },
        { fact: { kind: "rule", id: "socks.required" }, resolution: { action: "replace", quote: "Socks always, merino by default.", rule: { params: { required: true, default: "merino" }, interpretation: "every outfit has socks, merino by default" } } },
      ],
    };

    // One refused decision refuses the whole save: no new version, no half-applied facts.
    const bad = await owner.exec("style.save_document", { ...payload, factResolutions: [...payload.factResolutions.slice(0, 2), { fact: { kind: "rule", id: "socks.required" }, resolution: { action: "keep", quote: "Socks are optional." } }] }).catch((e) => e);
    expect(bad.code).toBe("precondition_failed");
    const stray = await owner.exec("style.save_document", { ...payload, factResolutions: [...payload.factResolutions, { fact: { kind: "size_experience", id: ids.size }, resolution: { action: "retire" } }] }).catch((e) => e);
    expect(stray.code).toBe("invalid_command"); // the edit does not touch that passage
    let ctx = await getStyleContext(h.db, owner.principal());
    expect([ctx.document.version, ctx.amendments.length, (await measurementsOf(h, owner)).chest]).toEqual([1, 1, 44]);

    const saved = await owner.exec("style.save_document", payload);
    const diff = saved.result.factDiff as Awaited<ReturnType<typeof previewStyleSave>>;
    expect(diff.applied.map((a) => [a.fact.kind, a.action])).toEqual([["rule", "replace"], ["measurement", "replace"], ["measurement", "keep"]]);
    expect(diff.conflicts).toEqual([]);
    ctx = await getStyleContext(h.db, owner.principal());
    expect(ctx.document.version).toBe(2);
    expect(ctx.amendments).toEqual([]); // incorporated in the same command
    expect(await measurementsOf(h, owner)).toEqual({ chest: 43, neck: 17 });
    expect(ctx.rules[0]).toMatchObject({ key: "socks.required", version: 2, origin: "profile", params: { required: true, default: "merino" } });
    expect(ctx.rules[0]!.passages.map((p) => p.quote)).toEqual(["Socks always, merino by default."]);
    expect(ctx.factConflicts).toEqual([]);

    await owner.exec("command.undo", { commandId: saved.commandId });
    ctx = await getStyleContext(h.db, owner.principal());
    expect(ctx.document).toMatchObject({ version: 3, content: PROFILE });
    expect(ctx.amendments).toHaveLength(1);
    expect(await measurementsOf(h, owner)).toEqual({ chest: 44, neck: 17 });
    expect(ctx.rules[0]).toMatchObject({ version: 1, params: { required: true } });
    expect(ctx.measurements.map((m) => m.passage!.quote)).toEqual(["Chest 44 inches; neck 17 inches.", "Chest 44 inches; neck 17 inches."]);
  });

  it("putting a removed passage back withdraws its conflict; a model inference can never save the profile; owners are isolated", async () => {
    const { h, owner, ids } = await syntheticOwnerWithFacts();
    const other = await syntheticOwnerWithFacts();
    const without = PROFILE.replace("Jackets: 46 at Maker A.\n", "");
    await owner.exec("style.save_document", { content: without, source: STATEMENT });
    expect((await listStyleFactConflicts(h.db, owner.principal())).map((c) => c.fact.id)).toEqual([ids.size]);
    expect(await listStyleFactConflicts(other.h.db, other.owner.principal())).toEqual([]);
    const foreign = (await listStyleFactConflicts(h.db, owner.principal()))[0]!.conflictId;
    expect((await other.owner.exec("style.resolve_fact_conflict", { conflictId: foreign, resolution: { action: "keep" } }).catch((e) => e)).code).toBe("not_found");

    const model = await owner.exec("style.save_document", { content: "# Compacted profile\n", source: { kind: "model_inference" } }, { actor: "assistant", channel: "conversation", authorization: "owner_statement" }).catch((e) => e);
    expect(model.code).toBe("forbidden");

    await owner.exec("style.save_document", { content: PROFILE, source: STATEMENT });
    expect(await listStyleFactConflicts(h.db, owner.principal())).toEqual([]);
    expect((await listStyleFactConflicts(h.db, owner.principal(), { status: "all" })).map((c) => c.status)).toEqual(["withdrawn"]);
    expect((await getStyleContext(h.db, owner.principal())).sizeExperiences[0]!.passage).toMatchObject({ documentSha256: await hashOf(PROFILE), lineStart: 6 });
  });
});

describe("the owner's real profile: editing prose never lifts the sneakers-only restriction", () => {
  it("deleting the healing paragraph leaves the restriction active, reports the rule as a conflict, and refuses to retire it through the edit", async () => {
    const h = await createHarness();
    const { owner } = await h.createRealOwner();
    const profile = ownerDocuments().profileText;
    const paragraph = profile.split("\n").find((line) => line.includes("**Sneakers only, until he says his feet have healed.**"))!;
    const edited = profile.replace(paragraph + "\n", "");
    expect(edited).not.toBe(profile);

    const preview = await previewStyleSave(h.db, owner.principal(), { content: edited });
    const sneakers = preview.conflicts.find((c) => c.fact.id === "footwear.sneakers_only_until_healed")!;
    expect(sneakers.reason).toBe("passage_removed");
    expect(sneakers.note).toContain(HEALING_RESTRICTION_ID);
    expect(preview.anchoredFacts).toBe(preview.unchanged + preview.conflicts.length);

    const lift = await owner.exec("style.save_document", { content: edited, source: STATEMENT, factResolutions: [{ fact: sneakers.fact, resolution: { action: "retire" } }] }).catch((e) => e);
    expect(lift.code).toBe("forbidden");
    expect((await getStyleContext(h.db, owner.principal())).document.version).toBe(1);

    await owner.exec("style.save_document", { content: edited, source: STATEMENT });
    const ctx = await getStyleContext(h.db, owner.principal());
    expect(ctx.document.version).toBe(2);
    expect(ctx.rules.find((r) => r.key === "footwear.sneakers_only_until_healed")).toMatchObject({ status: "active", kind: "hard" });
    expect(ctx.factConflicts!.map((c) => c.fact.id)).toContain("footwear.sneakers_only_until_healed");
    expect((await listRestrictions(h.db, owner.principal(), { status: "active" })).map((r) => r.restrictionId)).toEqual([HEALING_RESTRICTION_ID]);
    const availability = await getAvailability(h.db, owner.principal(), { nowMs: h.clock.now() });
    expect(availability.garments.filter((g) => g.reasons.includes("restricted")).length).toBeGreaterThan(0);
    // Every fact whose passage the edit did not touch now quotes the new version.
    const untouched = ctx.rules.filter((r) => r.origin === "profile" && !ctx.factConflicts!.some((c) => c.fact.id === r.key));
    expect(untouched.length).toBeGreaterThan(10);
    expect(untouched.every((r) => r.passages.every((p) => p.documentSha256 === ctx.document.contentSha256 && edited.split("\n").slice(p.lineStart - 1, p.lineEnd).join("\n").includes(p.quote)))).toBe(true);
  });
});
