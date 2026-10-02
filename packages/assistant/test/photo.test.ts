/**
 * Photo intake: "identify this" and "what I wore" with a REAL image.
 * Real: the media package's upload, finalization and private read path (local R2), the conversation Durable
 * Object, D1, the command service. Stand-ins: the FAKE MODEL at the model boundary (no vision model looked
 * at anything), and SYNTHETIC drawn images from the media package's fixtures (nobody's garments).
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { all, getDailyRecord, listInventory, type Principal } from "@garderobe/domain";
import { authorizeUpload, createMediaRuntime, depsFromBindings, finalizeUpload, openAssetImage, receiveUploadContent, registerMedia, type MediaRuntime } from "@garderobe/media";
import { encodePng } from "@garderobe/media/image";
import { syntheticShirt } from "@garderobe/media/testing";
import { AssistantRequestError, configureAssistant } from "../src/index.ts";
import { TEST_GATEWAY_ID, setTestPorts } from "../src/testing/index.ts";
import { createWorld, passProbes, submission, type World } from "./helpers.ts";

describe("photo intake through the conversation (REAL media upload and private read; FAKE MODEL; SYNTHETIC images)", () => {
  let w: World;
  let rt: MediaRuntime;
  let other: Awaited<ReturnType<World["h"]["createSyntheticOwner"]>>;
  const p = () => w.owner.principal();

  async function upload(principal: Principal, intent: "selfie" | "attachment"): Promise<{ assetId: string; byteLength: number }> {
    const bytes = await encodePng(syntheticShirt({ size: 96 }));
    const { authorization } = await authorizeUpload(rt, principal, { intent, garmentId: null, contentType: "image/png", byteLength: bytes.length, demo: false, wearingDate: null, idempotencyKey: `photo-test:${crypto.randomUUID()}` });
    const token = new URLSearchParams(authorization.url.split("?")[1]).get("token")!;
    await receiveUploadContent(rt, { uploadId: authorization.uploadId, token, body: bytes, contentLength: bytes.length, contentType: "image/png" });
    const done = await finalizeUpload(rt, principal, authorization.uploadId);
    expect(done.rejected).toBeNull();
    return { assetId: done.asset!.assetId, byteLength: bytes.length };
  }

  beforeAll(async () => {
    const deps = depsFromBindings(env as never);
    w = await createWorld({ extend: (registry) => registerMedia(registry, () => deps) });
    rt = createMediaRuntime({ db: w.h.db, service: w.h.service, deps, clock: w.h.clock.now });
    other = await w.h.createSyntheticOwner();
    // The port the Worker wires: this owner's private image, read through the media package.
    setTestPorts({
      openImage: async (principal, assetId) => {
        const opened = await openAssetImage(rt, principal, assetId);
        return { bytes: new Uint8Array(await new Response(opened.body).arrayBuffer()), contentType: opened.contentType };
      },
    });
  });

  it("'identify this': the uploaded image reaches the model as image input with the photo rules, and the transcript holds only a reference", async () => {
    const photo = await upload(p(), "attachment");
    w.model.script({ text: "That looks like one of your striped shirts; I cannot tell which from this angle." });
    const turn = await w.client.runTurn({ submissionId: submission("photo"), text: "identify this", images: [{ assetId: photo.assetId, role: "item_photo" }] });
    expect(turn.status).toBe("completed");
    const seen = w.model.requests.at(-1)!;
    expect(seen.images).toHaveLength(1);
    expect(seen.images[0]).toMatchObject({ mediaType: "image/png", role: "user" });
    expect(seen.images[0]!.byteLength).toBeGreaterThan(100);
    expect(seen.system).toContain("PHOTOGRAPHS IN THIS MESSAGE");
    expect(seen.system).toContain("What cannot be seen stays unknown");
    // The complete profile is still there: a photo does not displace the mandatory context.
    expect(seen.system).toContain("OWNER PROFILE");
    // Stored message: the owner's words and a reference, no image bytes.
    const stored = (await w.client.transcript({})).messages.find((m) => m.turnId === turn.turnId && m.role === "user")!;
    expect(stored.text).toContain("identify this");
    expect(stored.text).toContain(photo.assetId);
    expect(JSON.stringify(stored.parts)).not.toContain("base64");
    expect(JSON.stringify(stored.parts).length).toBeLessThan(2_000);
    // The reservation recorded that an image was part of the input.
    const evidence = await all<{ evidence_json: string }>(w.h.db, "SELECT evidence_json FROM inference_reservations WHERE user_id = ? AND parent_id = ?", w.owner.userId, turn.turnId);
    expect(JSON.parse(evidence[0]!.evidence_json).images).toEqual([photo.assetId]);
  });

  it("'what I wore' with a photo alone logs nothing and creates nothing: what the model saw is at most a request the owner confirms", async () => {
    const selfie = await upload(p(), "selfie");
    const shirt = await w.garment("oxford");
    const before = await getDailyRecord(w.h.db, p(), "2026-09-15");
    const garments = (await listInventory(w.h.db, p())).total;
    w.model.script(
      { toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shirt.garmentId] } }, { toolName: "add_garment", input: { name: "Striped shirt from the photo", category: "shirt", state: "owned" } }] },
      { text: "I can see a striped shirt. Tell me if that is what you wore and I will log it." },
    );
    const turn = await w.client.runTurn({ submissionId: submission("photo"), images: [{ assetId: selfie.assetId, role: "selfie" }] });
    expect(turn.status).toBe("completed");
    expect(turn.receipts).toHaveLength(0);
    expect(turn.proposals.map((x) => x.type).sort()).toEqual(["garment.create", "wear.record"]);
    expect(await getDailyRecord(w.h.db, p(), "2026-09-15")).toEqual(before);
    expect((await listInventory(w.h.db, p())).total).toBe(garments);
    expect(w.model.requests.at(-2)!.images).toHaveLength(1);
  });

  it("a photo with a question still logs nothing, and the marker text of the photo is never owner authority", async () => {
    const selfie = await upload(p(), "selfie");
    const shirt = await w.garment("oxford");
    const before = await getDailyRecord(w.h.db, p(), "2026-09-15");
    w.model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shirt.garmentId] } }] }, { text: "It looks fine. I have not logged anything." });
    const turn = await w.client.runTurn({ submissionId: submission("photo"), text: "does this work?", images: [{ assetId: selfie.assetId, role: "selfie" }] });
    expect(turn.receipts).toHaveLength(0);
    expect(turn.proposals.map((x) => x.type)).toEqual(["wear.record"]);
    expect(await getDailyRecord(w.h.db, p(), "2026-09-15")).toEqual(before);
  });

  it("a shop photo becomes a product record outside the wardrobe, never a garment", async () => {
    const shop = await upload(p(), "attachment");
    const garments = (await listInventory(w.h.db, p())).total;
    w.model.script(
      { toolCalls: [{ toolName: "save_shopping_candidate", input: { name: "Striped poplin shirt seen in a shop", note: "From the owner's shop photo; maker and size not visible" } }, { toolName: "add_garment", input: { name: "Striped poplin shirt", category: "shirt", state: "owned" } }] },
      { text: "Saved as something you are considering. I cannot see the maker or the size." },
    );
    const turn = await w.client.runTurn({ submissionId: submission("photo"), text: "should I get this?", images: [{ assetId: shop.assetId, role: "shop_photo" }] });
    expect(turn.receipts.map((r) => r.type)).toEqual(["product.record"]);
    expect(turn.proposals.map((x) => x.type)).toEqual(["garment.create"]);
    expect((await listInventory(w.h.db, p())).total).toBe(garments);
    expect((await all(w.h.db, "SELECT 1 FROM products WHERE user_id = ? AND name = 'Striped poplin shirt seen in a shop'", w.owner.userId))).toHaveLength(1);
    const stored = (await w.client.transcript({})).messages.find((m) => m.turnId === turn.turnId && m.role === "user")!;
    expect(stored.text).toContain("a product seen in a shop, not owned");
  });

  it("a photo plus the owner's own statement naming the piece does log the wear, once; naming only a kind of piece does not", async () => {
    const selfie = await upload(p(), "selfie");
    const shirt = await w.garment("Clark oxford — evergreen");
    // "The oxford" is a kind of shirt (the owner has many): the model's pick from the photo is a request, not a record.
    w.model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shirt.garmentId] } }] }, { text: "Which oxford?" });
    const vague = await w.client.runTurn({ submissionId: submission("photo"), text: "I'm wearing the oxford today", images: [{ assetId: selfie.assetId, role: "selfie" }] });
    expect(vague.receipts).toEqual([]);
    expect(vague.proposals.map((x) => x.type)).toEqual(["wear.record"]);
    w.model.script({ toolCalls: [{ toolName: "record_wear", input: { garmentIds: [shirt.garmentId] } }] }, { text: "Logged." });
    const turn = await w.client.runTurn({ submissionId: submission("photo"), text: "I'm wearing the evergreen Clark oxford today", images: [{ assetId: selfie.assetId, role: "selfie" }] });
    expect(turn.receipts.map((r) => r.type)).toEqual(["wear.record"]);
    const day = await getDailyRecord(w.h.db, p(), "2026-09-15");
    expect(JSON.stringify(day)).toContain(shirt.garmentId);
  });

  it("refuses another owner's image, an unknown image, and photos when no vision-verified profile exists", async () => {
    const theirs = await upload(other.principal(), "attachment");
    await expect(w.client.runTurn({ submissionId: submission("photo"), text: "identify this", images: [{ assetId: theirs.assetId, role: "item_photo" }] })).rejects.toMatchObject({ code: "image_not_found" });
    await expect(w.client.runTurn({ submissionId: submission("photo"), text: "identify this", images: [{ assetId: "ast_doesnotexist", role: "other" }] })).rejects.toBeInstanceOf(AssistantRequestError);
    expect(w.model.requests.every((r) => !r.messages.some((m) => m.text.includes(theirs.assetId)))).toBe(true);

    // A profile whose vision probe did not pass is never used for a photograph; the request is kept.
    for (const profileId of ["deepseek-v41-flash", "fable-5-1", "gpt-6-astra"]) {
      await w.owner.exec("inference.record_probe", { profileId, operation: "vision", result: "failed", billing: "unified_billing", reason: "TEST FIXTURE: vision probe failed", gatewayId: TEST_GATEWAY_ID }, { actor: "system", channel: "system", scopes: ["read", "write", "admin"], authorization: "system_schedule" });
    }
    const mine = await upload(p(), "attachment");
    const calls = w.model.requests.length;
    const turn = await w.client.runTurn({ submissionId: submission("photo"), text: "identify this", images: [{ assetId: mine.assetId, role: "item_photo" }] });
    expect(turn.status).toBe("resumable");
    expect(turn.failure!.message).toContain("vision");
    expect(w.model.requests).toHaveLength(calls);
    // Text turns are unaffected by the failed vision probe.
    w.model.script({ text: "Still here." });
    expect((await w.client.runTurn({ submissionId: submission("photo"), text: "and without a photo?" })).status).toBe("completed");
  });

  it("photo intake is refused outright when the deployment has no image port", async () => {
    setTestPorts({});
    await expect(w.client.runTurn({ submissionId: submission("photo"), text: "identify this", images: [{ assetId: "ast_anything", role: "other" }] })).rejects.toMatchObject({ code: "images_unavailable" });
  });

  it("a turn with an attached item identity and no photo is served normally when photo intake is not connected", async () => {
    setTestPorts({}); // no image port at all, as on a deployment without media
    const coat = await w.garment("oxford");
    w.model.script({ text: "For ten degrees it wants a layer underneath." });
    const turn = await w.client.runTurn({ submissionId: submission("ref"), text: "Is this one warm enough for ten degrees?", attachedRefs: [`garment:${coat.garmentId}`] });
    expect(turn.status).toBe("completed");
    expect(turn.failure).toBeNull();
    expect(turn.reply?.text).toBe("For ten degrees it wants a layer underneath.");
    const seen = w.model.requests.at(-1)!;
    // The attached identity was resolved by the system and no image was involved.
    expect(seen.system).toContain("WHAT THE OWNER ATTACHED TO THIS MESSAGE");
    expect(seen.system).toContain(coat.name);
    expect(seen.images).toHaveLength(0);
    expect(seen.system).not.toContain("PHOTOGRAPHS IN THIS MESSAGE");
    // Pasted text and a capture note are attachments too, and none of them needs the image port.
    w.model.script({ text: "That is a note, not a photo." });
    const withText = await w.client.runTurn({ submissionId: submission("ref"), text: "what is this?", attachedRefs: [`garment:${coat.garmentId}`], attachments: [{ kind: "other", source: "capture-sheet", text: "Capture intent selected by the owner: Identify this." }] });
    expect(withText.status).toBe("completed");
    // Only an actual photograph is refused there.
    await expect(w.client.runTurn({ submissionId: submission("ref"), text: "and this?", attachedRefs: [`garment:${coat.garmentId}`], images: [{ assetId: "ast_anything", role: "other" }] })).rejects.toMatchObject({ code: "images_unavailable" });
  });

  it("the test actor keeps the ports the composition root configured (only the model is replaced); a test port takes precedence", async () => {
    await passProbes(w.h, w.owner, "deepseek-v41-flash", ["vision"]);
    const realOpen = async (principal: Principal, assetId: string) => {
      const opened = await openAssetImage(rt, principal, assetId);
      return { bytes: new Uint8Array(await new Response(opened.body).arrayBuffer()), contentType: opened.contentType };
    };
    const photo = await upload(p(), "selfie");
    try {
      // What the Worker does at module load. No test port is set.
      configureAssistant({ ports: () => ({ openImage: realOpen }) });
      setTestPorts({});
      w.model.script({ text: "I can see the photo. Tell me what you had on and I will log it." });
      const turn = await w.client.runTurn({ submissionId: submission("cfg"), text: "What I wore", images: [{ assetId: photo.assetId, role: "selfie" }] });
      expect(turn.status).toBe("completed");
      expect(turn.receipts).toHaveLength(0);
      expect(w.model.requests.at(-1)!.images).toHaveLength(1);
      // A port set by a test overrides the configured one.
      setTestPorts({ openImage: async () => { throw new Error("TEST: image store offline"); } });
      await expect(w.client.runTurn({ submissionId: submission("cfg"), text: "What I wore", images: [{ assetId: photo.assetId, role: "selfie" }] })).rejects.toMatchObject({ code: "image_not_found" });
    } finally {
      configureAssistant({});
      setTestPorts({});
    }
  });
});
