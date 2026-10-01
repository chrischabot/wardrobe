/**
 * The daily service's composition model port, implemented behind the application model service:
 * budget reservation under the `daily_board` class, AI Gateway adapter, fallback and settlement.
 * The daily service validates everything this returns in code; on budget exhaustion or an outage this
 * returns no candidates so its deterministic composer fills the board.
 */
import { estimateTokens } from "../context/mandatory.ts";
import { BudgetExceededError, InferenceFailedError, NoSelectableProfileError, type ModelService } from "./service.ts";

export const COMPOSITION_PROMPT_VERSION = "garderobe-composition/1.0.0";

export interface CompositionRequest {
  localDate: string;
  count: number;
  /** The complete mandatory context built by the daily service (full profile verbatim, rules, every garment with status, weather, calendar, wear history). */
  contextText: string;
  contextData?: unknown;
  rejections?: unknown[];
  deadlineAtMs?: number;
}

export interface CompositionCandidate {
  slots: { role: string; garmentId: string }[];
  footwearAlternatives?: string[];
  principle?: string | null;
  claims?: { garmentId: string; attribute: string; value: string }[];
  suitsEventIds?: string[];
}

const INSTRUCTION = `Propose outfits as JSON only: {"candidates":[{"slots":[{"role":"top","garmentId":"..."}],"footwearAlternatives":[],"principle":"one or two sentences","claims":[{"garmentId":"...","attribute":"colour","value":"..."}],"suitsEventIds":[]}]}.
Use only garment IDs that appear in the context with an offerable status. Never invent an ID or a fact. No prose outside the JSON.`;

/** Parse model output defensively: anything that is not the expected shape yields no candidate. */
export function parseCandidates(text: string): CompositionCandidate[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = (parsed as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) return [];
  const out: CompositionCandidate[] = [];
  for (const c of list) {
    const slots = (c as { slots?: unknown })?.slots;
    if (!Array.isArray(slots) || slots.length === 0) continue;
    if (!slots.every((s) => s && typeof (s as { role?: unknown }).role === "string" && typeof (s as { garmentId?: unknown }).garmentId === "string")) continue;
    const cc = c as Record<string, unknown>;
    out.push({
      slots: slots as { role: string; garmentId: string }[],
      footwearAlternatives: Array.isArray(cc["footwearAlternatives"]) ? (cc["footwearAlternatives"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
      principle: typeof cc["principle"] === "string" ? (cc["principle"] as string).slice(0, 600) : null,
      claims: Array.isArray(cc["claims"]) ? (cc["claims"] as { garmentId: string; attribute: string; value: string }[]).filter((x) => x && typeof x.garmentId === "string" && typeof x.attribute === "string" && typeof x.value === "string") : [],
      suitsEventIds: Array.isArray(cc["suitsEventIds"]) ? (cc["suitsEventIds"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
    });
  }
  return out;
}

export function createCompositionModel(models: ModelService, opts: { userId: string; runId?: string }): { profile: string; propose(req: CompositionRequest): Promise<CompositionCandidate[]> } {
  const state = { profile: "unselected" };
  return {
    get profile() {
      return state.profile;
    },
    async propose(req: CompositionRequest): Promise<CompositionCandidate[]> {
      const prompt = `${INSTRUCTION}\nDate: ${req.localDate}. Candidates wanted: ${req.count}.${req.rejections && req.rejections.length > 0 ? `\nThese earlier candidates were rejected by validation; do not repeat them: ${JSON.stringify(req.rejections).slice(0, 6000)}` : ""}`;
      const remaining = req.deadlineAtMs ? req.deadlineAtMs - Date.now() : undefined;
      if (remaining !== undefined && remaining <= 0) return [];
      const deadline = new AbortController();
      const timer = remaining !== undefined ? setTimeout(() => deadline.abort(new DOMException("the composition deadline passed", "TimeoutError")), remaining) : undefined;
      try {
        const out = await models.generateText(
          { userId: opts.userId, task: "outfit_composition", parent: { kind: "job", id: opts.runId ?? `board:${req.localDate}` }, promptVersion: COMPOSITION_PROMPT_VERSION, estimatedInputTokens: estimateTokens(req.contextText + prompt), minContextTokens: estimateTokens(req.contextText) + 4_000, onAttempt: (a) => (state.profile = a.profileId) },
          { system: req.contextText, prompt, abortSignal: deadline.signal },
        );
        return parseCandidates(out.text).slice(0, Math.max(req.count * 2, req.count));
      } catch (e) {
        // Budget, outage or no verified profile: the deterministic composer takes over; nothing is unbudgeted.
        if (e instanceof BudgetExceededError || e instanceof NoSelectableProfileError || e instanceof InferenceFailedError) return [];
        if ((e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") return [];
        throw e;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
