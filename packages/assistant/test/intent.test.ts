/**
 * Unit tests for the explicit owner sentence-form allow-list (`policy/intent.ts`) on a SYNTHETIC three-piece
 * wardrobe. Every unlisted phrasing or command type returns `{ ok: false }` and becomes a one-tap proposal
 * for the signed-in owner to confirm in the app.
 */
import { describe, expect, it } from "vitest";
import {
  ownerRequests,
  endedCovers,
  statesConditionEnded,
  targetIdsOf,
  grantCoversTargets,
  classifyChange,
  jobFailure,
  ConnectionError,
  type IntentInput,
} from "../src/index.ts";
import { numbersIn } from "../src/policy/intent.ts";
import { NAMING_STOP, namedInText, tokensOf, type GarmentWords } from "../src/policy/naming.ts";
import { reportDateOf, reportsIn } from "../src/policy/report.ts";

const piece = (garmentId: string, name: string, category: string): GarmentWords => ({
  garmentId,
  name,
  category,
  careChannel: "machine",
  words: new Set(tokensOf(name).filter((t) => !NAMING_STOP.has(t))),
  aliases: [],
});
const COAT = piece("gmt_synth_coat", "SYNTHETIC red wool coat", "outerwear");
const BOOTS = piece("gmt_synth_boots", "SYNTHETIC blue suede boot", "footwear");
const SCARF = piece("gmt_synth_scarf", "SYNTHETIC navy lambswool scarf", "scarf");
const wardrobe = [COAT, BOOTS, SCARF];
const LOCAL = "2026-09-15";

const asks = (type: string, payload: Record<string, unknown>, text: string, extra: Partial<IntentInput> = {}) =>
  ownerRequests(type, payload, { ownerTexts: [text], wardrobe, pointedAt: [], localDate: LOCAL, ...extra }).ok;

describe("intent allow-list: one test per allow-listed sentence form, and unlisted phrasings route to proposals", () => {
  it("Form 1 (garment.create): 'Add my new <name> to the wardrobe.' applies at once; extra fields, counts, plural countable nouns or unlisted phrasings become proposals", () => {
    const jumper = { name: "Cream Aran jumper", category: "knitwear", colour: "cream", acquisition: "owned", quantity: 1 };
    expect(asks("garment.create", jumper, "Add my new cream Aran jumper to the wardrobe.")).toBe(true);
    expect(asks("garment.create", jumper, "Please add my cream Aran jumper.")).toBe(true);
    // Multi-token colours ("off-white", "light blue", "forest green") match both hyphenated and space-separated forms.
    const offWhiteShirt = { name: "Off-white shirt", category: "shirt", colour: "off-white", acquisition: "owned", quantity: 1 };
    expect(asks("garment.create", offWhiteShirt, "Add my new off-white shirt to the wardrobe.")).toBe(true);
    expect(asks("garment.create", { ...offWhiteShirt, colour: "off white" }, "Add my new off-white shirt to the wardrobe.")).toBe(true);
    expect(asks("garment.create", { name: "Light blue oxford", category: "shirt", colour: "light blue", acquisition: "owned", quantity: 1 }, "Add my new light blue oxford to the wardrobe.")).toBe(true);
    expect(asks("garment.create", { name: "White t-shirt", category: "tee", colour: "white", acquisition: "owned", quantity: 1 }, "Add my new white t-shirt to the wardrobe.")).toBe(true);
    expect(asks("garment.create", { name: "White t-shirt", category: "shirt", colour: "white", acquisition: "owned", quantity: 1 }, "Add my new white t-shirt to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "White t-shirts", category: "tee", colour: "white", acquisition: "owned", quantity: 1 }, "Add my new white t-shirts to the wardrobe.")).toBe(false);
    // Smuggled maker, wrong colour, non-colour leading word, plural countable nouns, counts (1-90, hundred, thousand, billion, trillion), wrong category/roles/careChannel, incoming acquisition, or unlisted phrasing -> proposal (false).
    expect(asks("garment.create", { ...jumper, maker: "Harley" }, "Add my new cream Aran jumper to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { ...jumper, colour: "navy" }, "Add my new cream Aran jumper to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { ...jumper, name: "Harley jumper", colour: "Harley" }, "Add my new Harley jumper to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { ...jumper, name: "Cashmere jumper", colour: "cashmere" }, "Add my new cashmere jumper to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "two blue shirts", category: "shirt", acquisition: "owned", quantity: 1 }, "Add my two blue shirts to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "thirteen navy shirts", category: "shirt", acquisition: "owned", quantity: 1 }, "Add my thirteen navy shirts to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "twenty four white shirts", category: "shirt", acquisition: "owned", quantity: 1 }, "Add my twenty-four white shirts to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "hundred blue shirts", category: "shirt", acquisition: "owned", quantity: 1 }, "Add my hundred blue shirts to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "thousand blue shirts", category: "shirt", acquisition: "owned", quantity: 1 }, "Add my thousand blue shirts to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "billion blue trousers", category: "trousers", acquisition: "owned", quantity: 1 }, "Add my billion blue trousers to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "trillion blue trousers", category: "trousers", acquisition: "owned", quantity: 1 }, "Add my trillion blue trousers to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "navy shirts", category: "shirt", acquisition: "owned", quantity: 1 }, "Add my new navy shirts to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "blue boots", category: "footwear", acquisition: "owned", quantity: 1 }, "Add my new blue boots to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { name: "constructor", acquisition: "owned" }, "Add my constructor.")).toBe(false);
    expect(asks("garment.create", { name: "toString", acquisition: "owned" }, "Add my toString.")).toBe(false);
    expect(asks("garment.create", { ...jumper, category: "footwear" }, "Add my new cream Aran jumper to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { ...jumper, roles: ["footwear"] }, "Add my new cream Aran jumper to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { ...jumper, careChannel: "none" }, "Add my new cream Aran jumper to the wardrobe.")).toBe(false);
    expect(asks("garment.create", { ...jumper, acquisition: "incoming" }, "Add my new cream Aran jumper to the wardrobe.")).toBe(false);
    expect(asks("garment.create", jumper, "I bought a cream Aran jumper yesterday.")).toBe(false);
    expect(asks("garment.create", jumper, "My wife gave me a cream Aran jumper.")).toBe(false);
  });

  it("Form 2 (garment.retire): 'I sold the <piece> (on eBay).' and charity-shop donation apply at once; other phrasings become proposals", () => {
    const sold = { garmentId: COAT.garmentId, disposition: "sold" };
    const donated = { garmentId: COAT.garmentId, disposition: "donated" };
    expect(asks("garment.retire", sold, "I sold the red wool coat.")).toBe(true);
    expect(asks("garment.retire", sold, "I sold the red coat on eBay.")).toBe(true);
    expect(asks("garment.retire", donated, "I gave the red coat away to a charity shop.")).toBe(true);
    expect(asks("garment.retire", donated, "I donated the red coat to a charity shop.")).toBe(true);
    // Mismatched disposition, wrong garment, negated, retracted ('I was joking', 'That was a lie'), cross-text denial, wanted/tried, or unlisted phrasing -> proposal (false).
    expect(asks("garment.retire", donated, "I sold the red coat.")).toBe(false);
    expect(asks("garment.retire", { garmentId: BOOTS.garmentId, disposition: "sold" }, "I sold the red coat.")).toBe(false);
    expect(asks("garment.retire", sold, "I have not sold the red coat.")).toBe(false);
    expect(asks("garment.retire", sold, "I sold the red coat. I was joking.")).toBe(false);
    expect(asks("garment.retire", sold, "I sold the red coat. That was a lie.")).toBe(false);
    expect(ownerRequests("garment.retire", sold, { ownerTexts: ["I sold the red coat.", "I have not sold it."], wardrobe, pointedAt: [], localDate: LOCAL }).ok).toBe(false);
    expect(ownerRequests("garment.retire", sold, { ownerTexts: ["I sold the red coat.", "Correction: I still own the red coat."], wardrobe, pointedAt: [], localDate: LOCAL }).ok).toBe(false);
    expect(ownerRequests("garment.retire", sold, { ownerTexts: ["I sold the red coat.", "I donated the red coat to a charity shop."], wardrobe, pointedAt: [], localDate: LOCAL }).ok).toBe(false);
    expect(asks("garment.retire", sold, "I want to sell the red coat.")).toBe(false);
    expect(asks("garment.retire", sold, "If I sell the red coat I'll tell you.")).toBe(false);
    expect(asks("garment.retire", sold, "I sold the red coat yesterday.")).toBe(false);
    expect(asks("garment.retire", sold, "I sold the red coat in a dream.")).toBe(false);
    expect(asks("garment.retire", sold, "I sold the red coat shoes.")).toBe(false);
    expect(asks("garment.retire", { garmentId: COAT.garmentId, disposition: "discarded" }, "Chucked out the red coat.")).toBe(false);
  });

  it("Form 3 (garment.move): 'Put the <piece> (away) in storage (for the summer|winter).' and 'The <piece> is/are at the tailor.' apply at once", () => {
    const toStorage = { garmentId: COAT.garmentId, to: "storage" };
    const toTailor = { garmentId: COAT.garmentId, to: "tailor" };
    expect(asks("garment.move", toStorage, "Put the red coat in storage.")).toBe(true);
    expect(asks("garment.move", toStorage, "Put the red coat away in storage for the summer.")).toBe(true);
    expect(asks("garment.move", toTailor, "The red coat is at the tailor.")).toBe(true);
    expect(asks("garment.move", { garmentId: BOOTS.garmentId, to: "tailor" }, "The blue boots are at the tailor.")).toBe(true);
    // Source vs destination, extra note, negated, or multi-sentence with negation -> proposal (false).
    expect(asks("garment.move", toStorage, "I took the red coat out of storage.")).toBe(false);
    expect(asks("garment.move", toStorage, "Move the red coat from storage to the tailor.")).toBe(false);
    expect(asks("garment.move", { ...toTailor, note: "shorten sleeves" }, "The red coat is at the tailor.")).toBe(false);
    expect(asks("garment.move", toStorage, "Don't put the red coat in storage. Put the blue boots in storage.")).toBe(false);
  });

  it("Form 4 (assistant.report_arrival): 'The <piece> (has) arrived (today).' applies at once", () => {
    expect(asks("assistant.report_arrival", { garmentId: SCARF.garmentId }, "The navy lambswool scarf arrived.")).toBe(true);
    expect(asks("assistant.report_arrival", { garmentId: SCARF.garmentId, deliveredOn: LOCAL }, "The navy lambswool scarf has arrived today.")).toBe(true);
    // Wrong date, wrong piece, or question -> proposal (false).
    expect(asks("assistant.report_arrival", { garmentId: SCARF.garmentId, deliveredOn: "2026-09-14" }, "The navy lambswool scarf arrived.")).toBe(false);
    expect(asks("assistant.report_arrival", { garmentId: COAT.garmentId }, "The navy lambswool scarf arrived.")).toBe(false);
    expect(asks("assistant.report_arrival", { garmentId: SCARF.garmentId }, "Has the navy lambswool scarf arrived?")).toBe(false);
  });

  it("Form 5 (garment.add_alias): 'Call the <piece> the <alias>.' applies at once", () => {
    const alias = { garmentId: COAT.garmentId, phrase: "the interview coat", kind: "owner_name" };
    expect(asks("garment.add_alias", alias, "Call the red wool coat the interview coat.")).toBe(true);
    expect(asks("garment.add_alias", { ...alias, phrase: "interview coat" }, "Please call the red wool coat the interview coat.")).toBe(true);
    // Mismatched alias, plural/singular mismatch, or wrong piece -> proposal (false).
    expect(asks("garment.add_alias", { ...alias, phrase: "my everyday sneakers" }, "Call the red wool coat the interview coat.")).toBe(false);
    expect(asks("garment.add_alias", { ...alias, phrase: "the interview coats" }, "Call the red wool coat the interview coat.")).toBe(false);
    expect(asks("garment.add_alias", { ...alias, garmentId: BOOTS.garmentId }, "Call the red wool coat the interview coat.")).toBe(false);
  });

  it("Form 6 (measurement.record): 'My <key> is|measures <N> inches|in|cm.' applies at once", () => {
    const body = (key: string, value: number, unit: string) => ({ subject: "body", key, value, unit });
    expect(asks("measurement.record", body("neck", 17.5, "in"), "My neck measures 17.5 inches.")).toBe(true);
    expect(asks("measurement.record", body("chest", 112, "cm"), "My chest is 112 cm.")).toBe(true);
    expect(asks("measurement.record", body("chest", 42, "in"), "My chest is 42 inches.")).toBe(true);
    // Mismatched unit, wrong key/value, non-default convention, garment subject, or doubtful/negated sentence -> proposal (false).
    expect(asks("measurement.record", body("chest", 112, "in"), "My chest is 112 cm.")).toBe(false);
    expect(asks("measurement.record", body("chest", 36, "in"), "My chest is 44 inches.")).toBe(false);
    expect(asks("measurement.record", { ...body("chest", 42, "in"), convention: "half chest flat" }, "My chest is 42 inches.")).toBe(false);
    expect(asks("measurement.record", { ...body("inseam", 32, "in"), convention: "body length" }, "My inseam is 32 inches.")).toBe(true);
    expect(asks("measurement.record", { ...body("inseam", 32, "in"), convention: "body circumference" }, "My inseam is 32 inches.")).toBe(false);
    expect(asks("measurement.record", { subject: "garment", garmentId: COAT.garmentId, key: "chest", value: 42, unit: "in" }, "The red coat chest is 42 inches.")).toBe(false);
    expect(asks("measurement.record", body("chest", 42, "in"), "I doubt my chest is still 42 inches.")).toBe(false);
  });

  it("Form 7 (style.add_direction): 'Never put me in <X>.', 'Do not make <X>.', and 'Always prefer <X>.' apply at once when verbatim", () => {
    expect(asks("style.add_direction", { text: "Never put me in a tie on Fridays." }, "Never put me in a tie on Fridays.")).toBe(true);
    expect(asks("style.add_direction", { text: "Do not make navy the default swap" }, "Please do not make navy the default swap.")).toBe(true);
    expect(asks("style.add_direction", { text: "Always prefer suede in autumn" }, "Always prefer suede in autumn.")).toBe(true);
    expect(asks("style.add_direction", { text: "Always prefer suede in autumn" }, "Always prefer suede in autumn. Always prefer cashmere in winter.")).toBe(false);
    // Paraphrases, altered words (including singular/plural changes), restriction-bypassing words, or unlisted forms -> proposal (false).
    expect(asks("style.add_direction", { text: "Never put me in a tie on Mondays." }, "Never put me in a tie on Fridays.")).toBe(false);
    expect(asks("style.add_direction", { text: "Always prefer shirt" }, "Always prefer shirts.")).toBe(false);
    expect(asks("style.add_direction", { text: "Always prefer welted shoes" }, "Always prefer welted shoes.")).toBe(false);
    expect(asks("style.add_direction", { text: "Prefer wool to cotton" }, "I prefer wool to cotton.")).toBe(false);
    expect(asks("style.add_direction", { text: "Never navy with black" }, "Navy is fine. Never put me in black.")).toBe(false);
  });

  it("Form 8 (command.undo): 'Undo that.' applies at once only for the owner's most recent change", () => {
    expect(asks("command.undo", { commandId: "cmd_x" }, "Undo that.", { record: { words: ["Recorded something"], mostRecent: true } })).toBe(true);
    expect(asks("command.undo", { commandId: "cmd_x" }, "Please undo that.", { record: { words: ["Recorded something"], mostRecent: true } })).toBe(true);
    expect(asks("command.undo", { commandId: "cmd_x" }, "Undo that.", { record: { words: ["Recorded something"], mostRecent: false } })).toBe(false);
    expect(asks("command.undo", { commandId: "cmd_x" }, "Don't undo that.", { record: { words: ["Recorded something"], mostRecent: true } })).toBe(false);
  });

  it("every unlisted command type fails closed (routes to a one-tap proposal), whatever the sentence says", () => {
    expect(asks("style.add_amendment", { text: "I no longer wear ties", kind: "taste" }, "I no longer wear ties.")).toBe(false);
    expect(asks("style.set_brief", { localDate: "2026-09-16", text: "Smarter" }, "Make tomorrow smarter.")).toBe(false);
    expect(asks("memory.record_conclusion", { text: "Likes wool" }, "Remember that I like wool.")).toBe(false);
    expect(asks("memory.set_status", { memoryId: "mem_x", status: "retired" }, "Forget that I like tweed.")).toBe(false);
    expect(asks("garment.correct", { garmentId: COAT.garmentId, changes: { fabric: "leather" } }, "The red coat is leather.")).toBe(false);
    expect(asks("restriction.add", { kind: "other", scope: { garmentIds: [COAT.garmentId] }, reason: "x" }, "Don't suggest the red coat.")).toBe(false);
    expect(asks("purchase.import_order", { merchant: "Drake's", orderNumber: "DR-1", lines: [{ productName: "Scarf", category: "scarf" }] }, "Log my Drake's order DR-1: one scarf.")).toBe(false);
    expect(asks("purchase.record_event", { orderId: "ord_x", event: { kind: "delivery" } }, "My Acme order was delivered.")).toBe(false);
    expect(asks("return.open_case", { kind: "return", garmentId: COAT.garmentId }, "I want to send the red coat back.")).toBe(false);
    expect(asks("return.update_case", { caseId: "ret_synth", state: "refunded" }, "The refund for the red coat came through.")).toBe(false);
    expect(asks("lifecycle.open_project", { kind: "sale", title: "Sell", items: [{ garmentId: COAT.garmentId }] }, "I'm selling the red coat.")).toBe(false);
    expect(asks("lifecycle.record_event", { projectId: "lcp_x", kind: "discarded" }, "I threw the red coat away.")).toBe(false);
    expect(asks("reminder.set", { kind: "drop", title: "Drake's drop", dueAt: "2026-09-18T09:00:00Z" }, "Remind me on Friday about the Drake's drop.")).toBe(false);
    expect(asks("reminder.cancel", { reminderId: "rem_x" }, "Cancel my tailor reminder.")).toBe(false);
    expect(asks("settings.update", { patch: { homeCity: "London" } }, "Set my home city to London.")).toBe(false);
    expect(asks("feedback.record", { kind: "too_warm", garmentIds: [COAT.garmentId], text: "Too warm" }, "The red coat was too warm.")).toBe(false);
    expect(asks("wear.amend", { wearingDate: LOCAL, add: [BOOTS.garmentId], remove: [COAT.garmentId] }, "Actually I wore the blue boots today, not the red coat.")).toBe(false);
    expect(asks("job.create", { kind: "email_investigation" }, "Search my emails for orders.")).toBe(false);
    expect(asks("trip.create", { tripId: "trp_synth", name: "Lisbon weekend", startsOn: "2026-10-01" }, "Plan the Lisbon weekend.")).toBe(false);
  });

  it("numbersIn parses digits, number words, hyphenated compounds and 'and a half'", () => {
    expect(numbersIn("forty-two and a half inches or 1,250")).toEqual([42.5, 1250]);
  });
});

describe("report dates, ended statements, grants and naming", () => {
  it("a huge 'N days ago' gives no date and never throws", () => {
    expect(() => reportDateOf("I wore it 999999999999 days ago.", LOCAL)).not.toThrow();
    expect(reportDateOf("I wore it 999999999999 days ago.", LOCAL)).toBeNull();
    expect(reportDateOf("I wore it three days ago.", LOCAL)).toBe("2026-09-12");
  });
  it("a statement taken back later in the message ends nothing", () => {
    expect(statesConditionEnded(["My feet have healed."])).not.toBeNull();
    expect(statesConditionEnded(["My feet have healed. That was a joke."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. Just kidding."])).toBeNull();
  });
  it("an ended statement speaks only to a restriction about that condition", () => {
    expect(endedCovers({ kind: "footwear", reason: "Sneakers only until the owner says his feet have healed" })).toBe(false);
    expect(endedCovers({ kind: "storage_hold", reason: "Keep the summer linen in storage until May" })).toBe(false);
    expect(endedCovers({ kind: "medical", reason: "Back injury: no heavy coats until recovered" })).toBe(false);
    expect(endedCovers({ kind: "medical", reason: "Doctor's orders after the knee injury" })).toBe(false);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until the owner says his feet have healed" })).toBe(true);
    expect(endedCovers({ kind: "other", reason: "Keep feet dry while it rains" })).toBe(false);
  });
  it("a grant covers only the records it was recorded for", () => {
    expect(targetIdsOf({ restrictionId: "rst_a", scope: { garmentIds: ["g2", "g1"] } })).toEqual(["g1", "g2", "rst_a"]);
    expect(grantCoversTargets({ targets: ["rst_a"] }, { restrictionId: "rst_a" })).toBe(true);
    expect(grantCoversTargets({ targets: ["rst_a"] }, { restrictionId: "rst_b" })).toBe(false);
    expect(grantCoversTargets({}, { restrictionId: "rst_a" })).toBe(false);
  });
  it("a wear correction's pieces are its targets, so a grant for one piece does not cover another", () => {
    const amend = { wearingDate: "2026-09-14", remove: ["gmt_synth_coat"], add: ["gmt_synth_boots"] };
    expect(targetIdsOf(amend, "wear.amend")).toEqual(["gmt_synth_boots", "gmt_synth_coat"]);
    expect(grantCoversTargets({ targets: ["gmt_synth_coat"] }, amend, "wear.amend")).toBe(false);
    expect(grantCoversTargets({ targets: ["gmt_synth_boots", "gmt_synth_coat"] }, amend, "wear.amend")).toBe(true);
  });
  it("importing a profile document is a rewrite of it, and a command reaching more pieces than the cap waits for the owner", () => {
    expect(classifyChange("style.import_document", {})).toBe("confirm");
    expect(classifyChange("lifecycle.record_event", { projectId: "lcp_x", kind: "discarded", moveStock: true, garmentIds: [] }, "ios", 21)).toBe("confirm");
    expect(classifyChange("lifecycle.record_event", { projectId: "lcp_x", kind: "discarded", moveStock: true, garmentIds: [] }, "ios", 3)).toBe("direction");
  });
  it("a failed job records a reason trusted code wrote, says when the failure was temporary, and logs no error text", () => {
    const leaky = new Error("GET https://api.example/v1?key=SYNTHETIC-SECRET failed");
    const internal = jobFailure(leaky);
    expect(internal.reason).not.toContain("SYNTHETIC-SECRET");
    expect(JSON.stringify(internal.diagnostic)).not.toContain("SYNTHETIC-SECRET");
    expect(internal.transient).toBe(false);
    const slow = jobFailure(new ConnectionError("timeout", "timed out calling https://api.example/v1?key=SYNTHETIC-SECRET"));
    expect(slow).toMatchObject({ transient: true, diagnostic: { code: "timeout" } });
    expect(slow.reason).toContain("temporarily unavailable");
    expect(slow.reason).not.toContain("SYNTHETIC-SECRET");
    expect(jobFailure(new ConnectionError("auth", "401")).reason).toContain("sign in again");
  });
  it("a verb of having outside the report's wording is not a connecting word, and a second clause's report does not leak into the first (review of 8445a1e9)", () => {
    const coat = piece("gmt_synth_gcoat", "SYNTHETIC Grandfather Coat", "outerwear");
    const oxford = piece("gmt_synth_oxford", "SYNTHETIC navy Pima oxford", "shirt");
    const mixed = reportsIn([coat, oxford], ["I wore the Grandfather Coat today and have the navy Pima oxford at home."], LOCAL);
    expect(mixed).toEqual([]);
    const split = reportsIn([coat, oxford], ["I wore the Grandfather Coat today and the navy Pima oxford is in the wash."], LOCAL);
    const worn = split.filter((r) => r.kind === "wear").flatMap((r) => [...r.garments.keys()]);
    expect(worn).toEqual(["gmt_synth_gcoat"]);
    expect(worn).not.toContain("gmt_synth_oxford");
  });
  it("an alias spanning a separator names one piece; a sibling's shorter alias inside it names nothing more (review of 8445a1e9)", () => {
    const twoTone = { ...piece("gmt_synth_twotone", "SYNTHETIC chelsea boot", "footwear"), aliases: ["black and tan boots"] };
    const tan = { ...piece("gmt_synth_tan", "SYNTHETIC suede boot", "footwear"), aliases: ["tan boots"] };
    expect([...namedInText([twoTone, tan], "I wore the black and tan boots today").keys()]).toEqual(["gmt_synth_twotone"]);
    expect([...namedInText([twoTone, tan], "I wore the tan boots today").keys()]).toEqual(["gmt_synth_tan"]);
  });
});
