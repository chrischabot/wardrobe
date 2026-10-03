import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_ORIGIN, connectMcp, ownerDay, provisionOwner, toolResult, type TestOwner } from "../src/testing/index.ts";

/*
 * Profile saves and bulk corrections through the real Worker, with the REAL owner fixture (supplied
 * profile and inventory). Stand-in: test-signed Access assertions. Nothing else is simulated: the
 * profile text, its quoted passages and the garments are the imported ones.
 */
let owner: TestOwner;
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string; details: Record<string, any> } }).error;

beforeAll(async () => {
  owner = await provisionOwner({ real: true });
});

describe("choosing garments for a bulk correction", () => {
  it("previews exactly the garments a selector covers, the same over MCP, and changes nothing", async () => {
    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const category = wardrobe.items[0].garment.category as string;
    const expected = wardrobe.items.filter((i: any) => i.garment.category === category).map((i: any) => i.garment.garmentId).sort();
    const selection = await owner.api.json("POST", "/v1/wardrobe/selection", { category });
    expect(selection.count).toBe(expected.length);
    expect(selection.garments.map((g: any) => g.garmentId).sort()).toEqual(expected);
    expect(selection.wardrobeRevision).toBe(wardrobe.wardrobeRevision);

    const mcp = await connectMcp(owner, { write: false });
    const viaTool = toolResult(await mcp.client.callTool({ name: "garderobe_inventory", arguments: { view: "selection", selector: { category } } }));
    expect(viaTool.ok, JSON.stringify(viaTool.error)).toBe(true);
    expect(viaTool.data.total).toBe(expected.length);
    expect(viaTool.data.data.garments.map((g: any) => g.garmentId).sort()).toEqual(expected);
    await mcp.close();

    // A selector with no criterion would select everything by accident: refused.
    expect((await owner.api.post("/v1/wardrobe/selection", {})).status).toBe(400);
    expect((await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision).toBe(wardrobe.wardrobeRevision);
  });

  it("refuses a bulk correction whose expected count no longer matches, and applies a matching one as one receipt", async () => {
    const types = await owner.api.json("GET", "/v1/command-types");
    expect(types.types.map((t: any) => t.type)).toEqual(expect.arrayContaining(["garment.bulk_correct", "style.resolve_fact_conflict"]));

    const wardrobe = await owner.api.json("GET", "/v1/wardrobe");
    const category = wardrobe.items[0].garment.category as string;
    const selection = await owner.api.json("POST", "/v1/wardrobe/selection", { category });
    const payload = { selector: { category }, changes: { condition: "checked in a bulk correction test" }, source: { kind: "owner_statement" } };
    const stale = await owner.api.command("garment.bulk_correct", { ...payload, expectedCount: selection.count + 1 });
    expect(stale.ok).toBe(false);
    expect((await owner.api.json("GET", "/v1/wardrobe")).wardrobeRevision).toBe(wardrobe.wardrobeRevision);

    const applied = await owner.api.command("garment.bulk_correct", { ...payload, expectedCount: selection.count });
    const receipt = (await applied.json()) as any;
    expect(applied.status, JSON.stringify(receipt)).toBe(200);
    expect(receipt.outcome).toBe("committed");
    expect(receipt.affected.filter((a: any) => a.kind === "garment")).toHaveLength(selection.count);
  });
});

describe("Save in My style", () => {
  let edited: string;
  let preview: any;

  it("previews what an edit does to the structured facts without saving anything", async () => {
    const style = await owner.api.json("GET", "/v1/style");
    const unchanged = await owner.api.json("POST", "/v1/style/preview-save", { content: style.document.content });
    expect(unchanged).toMatchObject({ contentChanged: false, conflicts: [] });
    expect(unchanged.anchoredFacts).toBeGreaterThan(0); // the real import anchors facts to the real profile text

    // Remove one passage that a standing rule quotes: that rule can no longer point at the text.
    const rule = style.rules.find((r: any) => r.passages.length > 0 && style.document.content.includes(r.passages[0].quote));
    expect(rule, "a rule that quotes the profile").toBeTruthy();
    edited = style.document.content.replace(rule.passages[0].quote, "");
    preview = await owner.api.json("POST", "/v1/style/preview-save", { content: edited });
    expect(preview.contentChanged).toBe(true);
    expect(preview.conflicts.length).toBeGreaterThan(0);
    expect(preview.conflicts.map((c: any) => c.fact.id)).toContain(rule.key);
    expect(preview.applied).toEqual([]);

    const after = await owner.api.json("GET", "/v1/style");
    expect(after.document.version).toBe(style.document.version);
    expect(after.document.contentSha256).toBe(style.document.contentSha256);
    expect((await owner.api.json("GET", "/v1/style/conflicts")).conflicts).toEqual([]);
    expect((await owner.api.post("/v1/style/preview-save", { content: "" })).status).toBe(400);
  });

  it("a save without decisions keeps the affected facts in force and lists each as an open conflict", async () => {
    // A save names the version it was edited from (the domain refuses a blind save since the foundation review, M6).
    const current = await owner.api.json("GET", "/v1/style");
    const saved = await owner.api.command("style.save_document", { content: edited, source: { kind: "owner_statement" } }, { expectedVersions: { [`style_document:${current.document.documentId}`]: current.document.version } });
    const receipt = (await saved.json()) as any;
    expect(saved.status, JSON.stringify(receipt)).toBe(200);
    const open = (await owner.api.json("GET", "/v1/style/conflicts")).conflicts;
    expect(open.map((c: any) => c.fact.id).sort()).toEqual(preview.conflicts.map((c: any) => c.fact.id).sort());
    expect(open.every((c: any) => c.status === "open" && c.resolution === null)).toBe(true);
    const style = await owner.api.json("GET", "/v1/style");
    expect(style.factConflicts.map((c: any) => c.conflictId).sort()).toEqual(open.map((c: any) => c.conflictId).sort());
    // The rule itself is still there: nothing was resolved on the owner's behalf.
    expect(style.rules.map((r: any) => r.key)).toEqual(expect.arrayContaining(open.filter((c: any) => c.fact.kind === "rule").map((c: any) => c.fact.id)));

    // A profile text written by a model is not accepted as the owner's profile.
    const model = await owner.api.command("style.save_document", { content: "# Compacted profile\n", source: { kind: "model_inference" } });
    expect(model.ok).toBe(false);
    expect((await owner.api.json("GET", "/v1/style")).document.version).toBe(style.document.version);
  });

  it("returns the day's brief with its identifier, so the app can clear a brief it did not set", async () => {
    const today = await ownerDay(owner);
    const tomorrow = await ownerDay(owner, 1);
    const set = await owner.api.command("style.set_brief", { localDate: tomorrow, text: "Dinner with clients: no trainers", source: { kind: "owner_statement" } });
    expect(set.status, await set.clone().text()).toBe(200);
    const forDay = await owner.api.json("GET", `/v1/style?date=${tomorrow}`);
    expect(forDay.briefs).toHaveLength(1);
    expect(forDay.briefs[0]).toMatchObject({ localDate: tomorrow, text: "Dinner with clients: no trainers" });
    expect(forDay.briefs[0].briefId).toBeTruthy();
    // Without a date it is the owner's local today (the brief above is for another day).
    expect((await owner.api.json("GET", "/v1/style")).briefs.filter((b: any) => b.localDate === tomorrow && today !== tomorrow)).toEqual([]);
    const cleared = await owner.api.command("style.retire_brief", { briefId: forDay.briefs[0].briefId });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect((await owner.api.json("GET", `/v1/style?date=${tomorrow}`)).briefs).toEqual([]);
  });

  it("another owner sees none of it", async () => {
    const stranger = await provisionOwner();
    expect((await stranger.api.json("GET", "/v1/style/conflicts")).conflicts).toEqual([]);
  });

  it("the open conflicts come across in an export and import, with the same identifiers", async () => {
    const source = (await owner.api.json("GET", "/v1/style/conflicts?status=all")).conflicts;
    expect(source.length).toBeGreaterThan(0);
    const requested = await owner.api.json("POST", "/v1/exports", { clientRequestId: `export-${crypto.randomUUID()}` });
    let job: any;
    for (let i = 0; i < 150; i++) {
      job = await owner.api.json("GET", `/v1/exports/${requested.exportId}`);
      if (!["queued", "running"].includes(job.state)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(job.state).toBe("completed");
    const ticket = await owner.api.json("POST", `/v1/exports/${job.exportId}/ticket`, {});
    const zip = new Uint8Array(await (await SELF.fetch(`${APP_ORIGIN}${ticket.url}`)).arrayBuffer());

    const target = await provisionOwner();
    const imported = await target.api.request("POST", "/v1/imports", { raw: zip, headers: { "Content-Type": "application/zip" } });
    const report = (await imported.json()) as any;
    expect(imported.status, JSON.stringify(report)).toBe(200);
    expect(report.state).toBe("completed");
    expect((await target.api.json("GET", "/v1/style/conflicts?status=all")).conflicts).toEqual(source);
    expect((await target.api.json("GET", "/v1/style")).document.contentSha256).toBe((await owner.api.json("GET", "/v1/style")).document.contentSha256);
  });
});
