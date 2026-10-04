/**
 * What trusted code reads as the owner's own wear or wash report, and which pieces a clause names
 * (policy/report.ts, policy/naming.ts), plus the credential forms the adversarial suite reported. Pure
 * functions on a SYNTHETIC wardrobe built in the test: no database, no model, no network.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets, reportDateOf, reportsIn, withinReportWindow } from "../src/index.ts";
import { namedInText, type GarmentWords } from "../src/policy/naming.ts";
import { coverOf } from "../src/policy/report.ts";

const TODAY = "2026-09-15"; // a Tuesday
const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

describe("A (unit): what trusted code reads as the owner's own report", () => {
  const g = (garmentId: string, category: string, words: string, aliases: string[] = []): GarmentWords => ({ garmentId, name: words, category, careChannel: "service", words: new Set(words.split(" ")), aliases });
  const wardrobe = [g("coat", "outerwear", "grandfather coat dbf"), g("pink", "shirt", "pima oxford pink"), g("navy", "shirt", "pima oxford navy"), g("boot", "footwear", "clifford boot drake"), g("cords", "trousers", "stratton stretch corduroy"), g("belt", "belt", "anderson belt olive"), g("nb", "footwear", "nb 990v4 grey")];
  const read = (text: string) => reportsIn(wardrobe, [text], TODAY).map((r) => `${r.kind}@${r.date ?? "-"}:${[...r.garments.keys()].sort().join("+")}${r.pointsAtAttachment ? "*" : ""}`);

  it("reads a first-person report of each kind, with its date and exactly the pieces it names", () => {
    expect(read("I wore the Grandfather Coat today.")).toEqual([`wear@${TODAY}:coat`]);
    expect(read("Wearing the Stratton corduroy and the olive Anderson belt.")).toEqual([`wear@${TODAY}:belt+cords`]);
    expect(read("I had the Grandfather Coat on yesterday.")).toEqual([`wear@${day(1)}:coat`]);
    expect(read("Threw on the Grandfather Coat this morning.")).toEqual([`wear@${TODAY}:coat`]);
    expect(read("I wore the grey 990v4 on Saturday")).toEqual([`wear@${day(3)}:nb`]);
    expect(read("I wore the Grandfather Coat three days ago.")).toEqual([`wear@${day(3)}:coat`]);
    expect(read("The navy Pima oxford is in the wash.")).toEqual(["dirty@-:navy"]);
    expect(read("Got curry down the pink oxford at lunch.")).toEqual(["dirty@-:pink"]);
    expect(read("Washed the navy Pima oxford last night.")).toEqual(["washed@-:navy"]);
    expect(read("I wore the navy Pima oxford and the 990v4 are dirty")).toEqual([`wear@${TODAY}:navy`, "dirty@-:nb"]);
    expect(read("Wore this today.")).toEqual([`wear@${TODAY}:*`]);
    expect(read("I wore it today.")).toEqual([`wear@${TODAY}:*`]);
    // A pointing word in a clause that names a piece is that piece, not something attached: without this
    // the first line reads `...:navy*` and an unrelated attached garment is covered by the report.
    expect(read("I wore this navy Pima oxford today.")).toEqual([`wear@${TODAY}:navy`]);
    // "This Friday" is a day, not something shown (today is a Tuesday; Friday was four days ago).
    expect(read("Wore the new one this Friday.")).toEqual([`wear@${day(4)}:`]);
    // A singular pointing word says which piece only when one piece is attached; a plural one covers several.
    const one = reportsIn(wardrobe, ["Wore this today."], TODAY);
    const several = reportsIn(wardrobe, ["Wore these today."], TODAY);
    expect(coverOf(one, "wear", TODAY, ["coat"], ["coat"])?.map((c) => c.basis)).toEqual(["attached_by_owner"]);
    expect(coverOf(one, "wear", TODAY, ["coat"], ["coat", "boot"])).toBeNull();
    expect(coverOf(several, "wear", TODAY, ["coat", "boot"], ["coat", "boot"])?.length).toBe(2);
  });

  it("adversarial I05-1 to I05-3: beside its own wording a report may say only which pieces and when; anything else is no report", () => {
    for (const text of [
      // the past, undated
      "I wore the Clifford boot for years before my toe went.",
      "I wore the Grandfather Coat at Easter.",
      "I wore the Grandfather Coat as a student.",
      // a plan or a fantasy in report form
      "Wearing the Grandfather Coat when the weather turns.",
      "I wore the Grandfather Coat in my dream.",
      "I wore the Grandfather Coat in a parallel universe.",
      // a doubt, a hope, somebody else's statement
      "I wonder whether the navy Pima oxford is dirty.",
      "The care label says the navy Pima oxford needs washing after every wear.",
      "I doubt the navy Pima oxford is washed.",
      "Hopefully the navy Pima oxford is clean again.",
      // commentary this code cannot judge: it waits for the owner rather than being guessed at
      "I wore the navy Pima oxford today and it felt tight.",
      // pull request 25 review, findings 6 and 7: a time this code does not know, and a piece that was NOT worn
      "I wore the Grandfather Coat two nights ago.",
      "I wore the Grandfather Coat a fortnight ago.",
      "I wore the Grandfather Coat on the weekend.",
      "I wore the navy Pima oxford but left the Grandfather Coat at home.",
      // change review, 2026-10-03: an alternative, a negation, a condition; and a spill that did not happen
      "I wore the Grandfather Coat or the navy Pima oxford today.",
      "I wore the navy Pima oxford or the coat today.",
      "I wore the navy Pima oxford with your coat today.",
      // a second statement about another piece is not part of the first report, in either direction
      "I wore the Grandfather Coat today and washed the navy Pima oxford.",
      "Washed the navy Pima oxford and wore the Grandfather Coat today.",
      "I wore the Grandfather Coat today, not the navy Pima oxford.",
      "Wearing the Grandfather Coat today if I can.",
      "Got lucky and kept the curry from going down the navy Pima oxford.",
      "Spilled nothing on the navy Pima oxford.",
      "Spilled absolutely nothing on the navy Pima oxford.",
    ])
      expect(read(text), text).toEqual([]);
    expect(read("Spilled red wine on the pink oxford.")).toEqual(["dirty@-:pink"]);
    expect(read("Got a bit of curry down the pink oxford.")).toEqual(["dirty@-:pink"]);
    // What may stand beside the pieces: a time, the everyday where, another named piece.
    expect(read("I wore the navy Pima oxford to work today.")).toEqual([`wear@${TODAY}:navy`]);
    expect(read("I wore the Grandfather Coat over the navy Pima oxford yesterday.")).toEqual([`wear@${day(1)}:coat+navy`]);
    expect(read("Just put the pink oxford in the wash.")).toEqual(["dirty@-:pink"]);
  });

  it("adversarial I06-3 and I06-8: one noun phrase names one piece, or none when the owner's words do not tell the pieces apart", () => {
    const blues = [g("plain", "shirt", "lightweight oxford light blue"), g("portuguese", "shirt", "cotton linen oxford portuguese light blue"), g("stripe", "shirt", "lightweight oxford light blue wide stripe"), g("coat", "outerwear", "grandfather coat dbf")];
    // Three light blue shirts fit "the light blue shirt" equally well: none is named, so a model cannot record all of them.
    expect([...namedInText(blues, "I wore the light blue shirt today.").keys()]).toEqual([]);
    expect(reportsIn(blues, ["I wore the light blue shirt today."], TODAY)).toEqual([]);
    // Said precisely, one of them is named.
    expect([...namedInText(blues, "I wore the Portuguese light blue shirt today.").keys()]).toEqual(["portuguese"]);
    expect([...namedInText(blues, "I wore the light blue wide stripe oxford and the Grandfather Coat.").keys()].sort()).toEqual(["coat", "stripe"]);
    // A piece named exactly by its alias does not also name the sibling that shares two of its words.
    const clarks = [g("beige", "shirt", "clark oxford beige", ["clark oxford beige"]), g("evergreen", "shirt", "clark oxford evergreen")];
    expect([...namedInText(clarks, "I wore the Clark oxford beige today.").keys()]).toEqual(["beige"]);
    expect([...namedInText(clarks, "I wore the Clark oxford evergreen today.").keys()]).toEqual(["evergreen"]);
    expect([...namedInText(clarks, "I wore the Clark oxford today.").keys()]).toEqual([]);
    // "The white oxford" is not the off-white one.
    const whites = [g("white", "shirt", "pima oxford white"), g("offwhite", "shirt", "lightweight oxford offwhite")];
    expect([...namedInText(whites, "Got curry down the white oxford.").keys()]).toEqual(["white"]);
    expect([...namedInText(whites, "Got curry down the off-white oxford.").keys()]).toEqual(["offwhite"]);
  });

  it("adversarial D12-1: credentials in six more common forms are removed (SYNTHETIC values assembled here; none is a real credential)", () => {
    const fill = (n: number) => "A1b2".repeat(Math.ceil(n / 4)).slice(0, n);
    const forms = [`sk_${"live"}_${fill(24)}`, `aws_secret_access_key = ${fill(40)}`, `npm_${fill(36)}`, `glpat-${fill(20)}`, `hf_${fill(34)}`, `${"1234567890"}:${fill(35)}`];
    for (const form of forms) {
      const cleaned = redactSecrets(`Here it is: ${form} thanks`).text;
      expect(cleaned, form.slice(0, 12)).toContain("[secret removed]");
      expect(cleaned, form.slice(0, 12)).not.toContain(fill(20));
    }
  });

  it("reads nothing from a mention, a question, a negation, a plan, somebody else, a quotation, sarcasm or an undatable past", () => {
    for (const text of [
      "The Clifford boot is the best thing I own.",
      "The pink lemonade at lunch was nice.",
      "I love the Grandfather Coat.",
      "The grey 990s are great.",
      "My shirts are lovely.",
      "Did I wear the Grandfather Coat today?",
      "I didn't wear the Grandfather Coat today.",
      "I'll wear the Grandfather Coat tomorrow.",
      "My brother wore the Grandfather Coat today.",
      'The note says "I wore the Grandfather Coat today".',
      "I wore the Grandfather Coat today, said no one ever.",
      "Yeah right, I wore the Grandfather Coat to the beach.",
      "I wore the Grandfather Coat at my wedding in 2019.",
      "I wore the Grandfather Coat last month.",
      "I wore the Grandfather Coat every day this week.",
      "I wore the Grandfather Coat yesterday and today.",
      "Wearing the Clifford boot is a pain.",
      "Does this go with grey flannel?",
    ])
      expect(read(text), text).toEqual([]);
    // "The pink socks" says a kind, and it is not the pink shirt's: nothing is named, so nothing is read.
    expect(read("I wore the pink socks today.")).toEqual([]);
  });

  it("fixes a date only inside the report window", () => {
    expect(reportDateOf("I wore it eight days ago", TODAY)).toBeNull();
    expect(reportDateOf("I wore it on Tuesday", TODAY)).toBeNull(); // today is a Tuesday: today or a week ago?
    expect(reportDateOf("I wore it on 2026-09-10", TODAY)).toBe("2026-09-10");
    expect(reportDateOf("I wore it on 2026-09-16", TODAY)).toBeNull();
    expect([withinReportWindow(day(7), TODAY), withinReportWindow(day(8), TODAY), withinReportWindow(day(-1), TODAY), withinReportWindow("2026-02-30", TODAY)]).toEqual([true, false, false, false]);
  });
});
