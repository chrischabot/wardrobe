/**
 * The judgment format: the same rules as the bundle's `evaluate.py check-judgments`, so a malformed judgment
 * is caught by the judge process. Pure, so the orchestrator's self-test exercises it directly.
 */
export const DIMENSIONS = ["personal_fit", "composition", "comfort_and_fabric", "variety_and_scope", "practical_usefulness", "voice_and_teaching"];

const isRecord = (x) => Boolean(x) && typeof x === "object" && !Array.isArray(x);

/**
 * Why a parsed judgment is not valid, or null. Never throws, whatever the shape of its input. With `expected`
 * (the packet's case_id and candidate_id), the judgment must name exactly that case and candidate and carry the
 * rubric's mode "candidate_evaluation", so a judgment of another case, candidate or mode is never filed here.
 */
export function judgmentProblem(j, expected) {
  if (!isRecord(j)) return "not an object";
  if (expected !== undefined) {
    if (j.mode !== "candidate_evaluation") return 'mode is not "candidate_evaluation"';
    if (j.case_id !== expected?.case_id) return `case_id is not ${JSON.stringify(expected?.case_id ?? null)}`;
    if (j.candidate_id !== expected?.candidate_id) return `candidate_id is not ${JSON.stringify(expected?.candidate_id ?? null)}`;
  }
  if (!["pass", "revise", "fail", "insufficient_evidence"].includes(j.verdict)) return "verdict is not one of pass, revise, fail, insufficient_evidence";
  if (!isRecord(j.scores) || DIMENSIONS.some((d) => !Object.hasOwn(j.scores, d)) || Object.keys(j.scores).length !== DIMENSIONS.length) return "scores must hold exactly the six dimensions";
  for (const d of DIMENSIONS) if (!(j.scores[d] === null || (Number.isInteger(j.scores[d]) && j.scores[d] >= 1 && j.scores[d] <= 5))) return `score ${d} is not null or an integer from 1 to 5`;
  if (!Array.isArray(j.findings) || j.findings.length === 0) return "findings must be a non-empty list";
  if (j.findings.some((f) => !(typeof f === "string" ? f.trim().length > 0 : isRecord(f)))) return "every finding must be a non-empty text or an object";
  if (typeof j.summary !== "string" || j.summary.trim().length === 0) return "summary must be a non-empty text";
  if (!Array.isArray(j.hard_violations)) return "hard_violations must be a list";
  if (j.hard_violations.length > 0 && j.verdict === "pass") return "a judgment with hard violations cannot pass";
  return null;
}
