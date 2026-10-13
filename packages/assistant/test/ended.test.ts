/**
 * When the owner's words end a restriction's condition (policy/ended.ts). Pure trusted code; no stand-ins.
 * A false lift removes a hard constraint, so a contradiction anywhere in the owner's words blocks it.
 */
import { describe, expect, it } from "vitest";
import { endedCovers, statesConditionEnded } from "../src/policy/ended.ts";

/** The re-review's seven genuine statements (the same list as testing/corpora.ts GENUINE_HEALING_SENTENCES). */
const GENUINE_HEALING_SENTENCES = [
  "My feet have healed.",
  "Good news: the podiatrist cleared me and my feet are properly healed now.",
  "My feet are healed, I can wear the Paraboots again.",
  "My feet are finally healed, I think we can drop the sneakers rule.",
  "The doctor told me my feet have healed, so please lift the sneakers restriction.",
  "Feet are all good again, welted shoes back in rotation please.",
  "I'm fully recovered, no more sneakers-only.",
];

describe("ended: a restriction lift needs an uncontradicted statement about the feet", () => {
  it("a contradiction anywhere in the owner's words blocks the lift, before or after the statement", () => {
    expect(statesConditionEnded(["My feet have healed."])).not.toBeNull();
    expect(statesConditionEnded(["My feet have healed. Actually my feet have not healed."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. No, they haven't."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. They still hurt."])).toBeNull();
    expect(statesConditionEnded(["No. My feet have healed."])).toBeNull();
    expect(statesConditionEnded(["My feet have not healed.", "My feet have healed."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. That is false."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. I doubt it."])).toBeNull();
    expect(statesConditionEnded(["My feet have mostly healed."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed, nope."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed, no more."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. Except the left one."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. My ankle is swollen."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. The left one tingles a bit."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed. My feet have been better."])).toBeNull();
    // A clause that adds nothing doubtful keeps the statement.
    expect(statesConditionEnded(["My feet have healed, the podiatrist cleared me this morning."])).not.toBeNull();
  });
  it("'have been better' or 'are better' (improvement only, not healed) ends nothing", () => {
    expect(statesConditionEnded(["My feet have been better."])).toBeNull();
    expect(statesConditionEnded(["My feet are better."])).toBeNull();
    expect(statesConditionEnded(["My feet are better now."])).toBeNull();
  });
  it("an ended statement covers only a restriction that exists because of a foot's healing", () => {
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until the owner says his feet have healed (nerve damage from previously too-small shoes); the welted fleet and the 990v6 are out of play" })).toBe(true);
    expect(endedCovers({ kind: "sneakers_only", reason: "During recovery from abdominal surgery" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Recovering from surgery; keep feet dry when it rains" })).toBe(false);
    expect(endedCovers({ kind: "footwear", reason: "Keep feet dry while it rains" })).toBe(false);
    expect(endedCovers({ kind: "footwear", reason: "Keep feet healthy while it rains" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only for workplace safety, not for a foot injury" })).toBe(false);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only while the sprained ankle recovers" })).toBe(true);
  });
  it("a clause that keeps the restriction is not a follow-up", () => {
    expect(statesConditionEnded(["I'm fully recovered, I can only wear sneakers."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed, I can wear sneakers."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed, I can only wear the Paraboots."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed, the sneakers rule."])).toBeNull();
    expect(statesConditionEnded(["My feet have healed, drop the sneakers rule."])).not.toBeNull();
  });
  it("a restriction with a purpose besides healing is not ended by the healing", () => {
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only for workplace safety and until the foot injury heals" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only until the foot injury heals and while it rains" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only until the foot injury heals or the site rules change" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only until the sprained ankle heals, after which the dress code applies" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only until foot injury heals and antibiotics are finished" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Foot injury and shoes too small" }, statesConditionEnded(["My feet have healed."])!)).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only until foot heals, shoes only" }, statesConditionEnded(["My feet have healed."])!)).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only while feet are healed" }, statesConditionEnded(["My feet have healed."])!)).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers only until foot surgery" }, statesConditionEnded(["My feet have healed."])!)).toBe(false);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until both feet have healed" }, statesConditionEnded(["Both my feet have healed."])!)).toBe(true);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until the heel heals" }, statesConditionEnded(["My heel has healed."])!)).toBe(true);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until both heels have healed" }, statesConditionEnded(["My heel has healed."])!)).toBe(false);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until both heels have healed" }, statesConditionEnded(["My heels have healed."])!)).toBe(true);
  });
  it("the foot-and-healing phrase must stand within one field, never across kind and reason", () => {
    expect(endedCovers({ kind: "healing", reason: "Keep feet dry while it rains" })).toBe(false);
    expect(endedCovers({ kind: "feet", reason: "Healing time is long for everyone" })).toBe(false);
    expect(endedCovers({ kind: "foot_healing", reason: null })).toBe(true);
  });
  it("a condition described as absent, excluded or ruled out is not a healing condition", () => {
    expect(endedCovers({ kind: "sneakers_only", reason: "Foot injury ruled out; sneakers required for workplace safety" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers for site work, without any foot injury" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Foot injury excluded by the scan; site rules require sneakers" })).toBe(false);
    expect(endedCovers({ kind: "sneakers_only", reason: "Sneakers for safety; foot injury absent" })).toBe(false);
  });
  it("the statement lifts only a restriction on the same part of the foot", () => {
    const feet = { kind: "healing", reason: "Sneakers only until the owner says his feet have healed" };
    const ankle = { kind: "healing", reason: "Sneakers only while recovering from a broken ankle" };
    const toe = statesConditionEnded(["My toe is healed."]);
    expect(toe).not.toBeNull();
    expect(endedCovers(feet, toe!)).toBe(false);
    expect(endedCovers(ankle, toe!)).toBe(false);
    const podiatristToe = statesConditionEnded(["The podiatrist told me my toe has healed."])!;
    expect(podiatristToe).not.toBeNull();
    expect(podiatristToe.parts).toEqual(["toe"]);
    expect(endedCovers(feet, podiatristToe)).toBe(false);
    const podiatristOneFoot = statesConditionEnded(["The podiatrist told me my foot has healed."])!;
    expect(podiatristOneFoot.parts).toEqual(["foot"]);
    expect(endedCovers(feet, podiatristOneFoot)).toBe(false);
    const feetHealed = statesConditionEnded(["My feet have healed."])!;
    expect(endedCovers(feet, feetHealed)).toBe(true);
    expect(endedCovers(ankle, feetHealed)).toBe(false);
    // A statement about one foot ("my foot has healed") does not lift a restriction on both feet or a reasonless foot_healing restriction.
    const oneFoot = statesConditionEnded(["My foot has healed."])!;
    expect(endedCovers(feet, oneFoot)).toBe(false);
    expect(endedCovers({ kind: "foot_healing", reason: null }, oneFoot)).toBe(false);
    expect(endedCovers({ kind: "foot_healing", reason: null }, feetHealed)).toBe(true);
    expect(endedCovers({ kind: "foot_healing", reason: "until the ankle heals" }, statesConditionEnded(["My ankle has healed."])!)).toBe(true);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until the foot heals" }, oneFoot)).toBe(true);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until the foot heals" }, feetHealed)).toBe(true);
    expect(endedCovers(ankle, statesConditionEnded(["My ankle has healed."])!)).toBe(true);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only while recovering from broken ankles" }, statesConditionEnded(["My ankle has healed."])!)).toBe(false);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until both his ankle heal" }, statesConditionEnded(["My ankle has healed."])!)).toBe(false);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until both his ankle heal" }, statesConditionEnded(["My ankles have healed."])!)).toBe(true);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until both the foot heal" }, oneFoot)).toBe(false);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until both his foot injuries have healed" }, oneFoot)).toBe(false);
    expect(endedCovers({ kind: "healing", reason: "Sneakers only until both his foot injuries have healed" }, feetHealed)).toBe(true);
    // A generic statement about the shoes speaks to the feet as a whole, never a named part.
    const generic = statesConditionEnded(["I'm fully recovered, no more sneakers-only."])!;
    expect(endedCovers(feet, generic)).toBe(true);
    expect(endedCovers(ankle, generic)).toBe(false);
  });
  it("every genuine statement of the corpus still lifts it", () => {
    for (const genuine of GENUINE_HEALING_SENTENCES) expect(statesConditionEnded([genuine]), genuine).not.toBeNull();
  });
  it("a generic recovery speaks to the feet only when the owner's words name them or their shoes", () => {
    expect(statesConditionEnded(["I'm fully recovered."])).toBeNull();
    expect(statesConditionEnded(["My doctor cleared me."])).toBeNull();
    expect(statesConditionEnded(["I'm fully recovered, no more sneakers-only."])).not.toBeNull();
    expect(statesConditionEnded(["The podiatrist cleared me."])).not.toBeNull();
    expect(statesConditionEnded(["The podiatrist signed me off."])).not.toBeNull();
    expect(statesConditionEnded(["The podiatrist signed me."])).toBeNull();
  });
});
