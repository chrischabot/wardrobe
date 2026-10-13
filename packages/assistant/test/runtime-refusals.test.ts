/**
 * What a model-written retrieval or search may carry out of the turn (review of the prepared change a72b49ad).
 * Real: the runtime's checks and D1 with a SYNTHETIC owner's wardrobe. No stand-ins.
 */
import { describe, expect, it } from "vitest";
import { ownerSource, refuseUnknownPieces, retrievalRefusal, searchQueryRefusal } from "../src/tools/runtime.ts";
import { createWorld } from "./helpers.ts";

describe("retrieval and search refusals", () => {
  it("with no allow-list, no address is retrieved (fail closed); with one, only its addresses are", () => {
    expect(retrievalRefusal({}, "https://shop.example/p/1")).not.toBeNull();
    expect(retrievalRefusal({ allowedUrls: new Set() }, "https://shop.example/p/1")).not.toBeNull();
    const allowedUrls = new Set(["https://shop.example/p/1"]);
    expect(retrievalRefusal({ allowedUrls }, "https://shop.example/p/1")).toBeNull();
    expect(retrievalRefusal({ allowedUrls }, "https://shop.example/p/2")).not.toBeNull();
  });

  it("an unrequested year and a number inside a longer number are refused; whole requested numbers pass", async () => {
    const w = await createWorld({ real: false });
    const rt = (requestText: string) => ({ db: w.h.db, principal: w.owner.principal(), requestText });
    // A birth year the owner did not ask about never leaves.
    expect(await searchQueryRefusal(rt("find me a navy overcoat"), "navy overcoat born 1981")).not.toBeNull();
    // "44" is not said by "144".
    expect(await searchQueryRefusal(rt("the 144 model jacket"), "jacket chest 44")).not.toBeNull();
    expect(await searchQueryRefusal(rt("a jacket in size 44"), "jacket size 44")).toBeNull();
    expect(await searchQueryRefusal(rt("history of the 1913 chore coat"), "chore coat 1913")).toBeNull();
  });

  it("an identifier trusted code minted for the record a command creates is not refused as an unknown piece; a made-up reference still is", async () => {
    const w = await createWorld({ real: false });
    const refusals: unknown[] = [];
    const rt = { db: w.h.db, principal: w.owner.principal(), onRefusal: (r: unknown) => void refusals.push(r) };
    const req = (minted: string[]) => ({ tool: "t", type: "lifecycle.create_project", payload: { garmentId: "g_minted_new" }, targets: [], minted });
    expect(await refuseUnknownPieces(rt, req(["g_minted_new"]))).toBeNull();
    expect(await refuseUnknownPieces(rt, req([]))).toMatchObject({ status: "refused", code: "not_found" });
    expect(refusals).toHaveLength(1);
  });

  it("a tapped answer with no words of its own credits the owner's words to the message the question was about", () => {
    const base = { userMessageId: "msg_tap", ownerTexts: ["I wore the navy coat yesterday"], attachedRefs: [] } as never as Parameters<typeof ownerSource>[0];
    expect(ownerSource({ ...base, currentOwnerText: "", askedMessageId: "msg_report" })).toEqual({ kind: "owner_statement", ref: "message:msg_report" });
    expect(ownerSource({ ...base, currentOwnerText: "I wore the navy coat yesterday" })).toEqual({ kind: "owner_statement", ref: "message:msg_tap" });
  });

  it("a private term is said only by the whole word: 'painting' does not say 'pain', nor 'lightweight' 'weight'", async () => {
    const w = await createWorld({ real: false });
    const rt = (requestText: string) => ({ db: w.h.db, principal: w.owner.principal(), requestText });
    expect(await searchQueryRefusal(rt("a smock for painting"), "smock for nerve pain")).not.toBeNull();
    expect(await searchQueryRefusal(rt("a lightweight raincoat"), "raincoat weight loss")).not.toBeNull();
    expect(await searchQueryRefusal(rt("shoes for nerve pain"), "shoes for nerve pain")).toBeNull();
  });

  it("refuses a query that copies a stored restriction reason even when 'nerve' and 'damage' are omitted, while allowing benign garment searches and null reasons (I05-5)", async () => {
    const w = await createWorld({ real: true });
    const rt = (requestText: string) => ({ db: w.h.db, principal: w.owner.principal(), requestText });
    expect(await searchQueryRefusal(rt("Find me some new trousers."), "Sneakers only until the owner says his feet have healed from previously too-small shoes")).not.toBeNull();
    expect(await searchQueryRefusal(rt("Find me some new trousers."), "Sneakers only until the owner says previously too-small shoes")).not.toBeNull();
    expect(await searchQueryRefusal(rt("Find me some new trousers."), "high rise wool flannel trousers")).toBeNull();
    // A comfort note mentioning generic garment words ('wool flannel trousers', 'blue cotton oxford shirt') does not block ordinary product searches.
    const g = await w.garment("Clark oxford — evergreen");
    await w.owner.exec("feedback.record", { garmentIds: [g.garmentId], text: "grey wool flannel trousers and blue cotton oxford shirt", kind: "positive" }, { actor: "owner", channel: "ios", authorization: "owner_tap" });
    expect(await searchQueryRefusal(rt("Find me something for autumn."), "grey wool flannel trousers")).toBeNull();
    expect(await searchQueryRefusal(rt("Find me something for autumn."), "blue cotton oxford shirt")).toBeNull();
  });
});
