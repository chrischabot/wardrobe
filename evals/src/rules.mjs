/**
 * Pure rules of the evaluation harness, with no I/O and no platform imports, so the candidate-side drivers
 * (in workerd), the gateway relay (in Node) and the orchestrator's self-test (`node evals/run.mjs selftest`)
 * apply exactly the same code. Each function takes plain data and returns plain data.
 */

/* ------------------------------------------------------------------ */
/* Model routes                                                         */
/* ------------------------------------------------------------------ */

/** Routes this run keeps for the independent judge; a candidate may never use them. */
export function reservedRoutes(report) {
  return Array.isArray(report?.reservedForJudging) ? report.reservedForJudging.filter((x) => typeof x === "string") : [];
}

/** Whether a probed profile may answer the candidate: its text and tool probes passed and its route is not kept for the judge. */
export function isCandidateProfile(profile, report) {
  return Boolean(profile?.gatewayRoute) && profile.operations?.text?.result === "passed" && profile.operations?.tools?.result === "passed" && !reservedRoutes(report).includes(profile.gatewayRoute);
}

/**
 * The routes a candidate can use: profiles whose text and tool probes passed, minus the routes kept for the
 * judge, and (when given) only routes of the conversation task's candidate profiles.
 */
export function candidateRoutes(report, conversationRoutes = null) {
  const routes = (report?.profiles ?? []).filter((p) => isCandidateProfile(p, report)).map((p) => p.gatewayRoute);
  return [...new Set(conversationRoutes ? routes.filter((x) => conversationRoutes.includes(x)) : routes)];
}

/**
 * The route to keep for the judge: the first route of the judge order that answered the text probe and whose
 * removal still leaves the candidate at least one usable route. Null when no such route exists.
 */
export function reserveJudgeRoute(report, order, conversationRoutes = null) {
  const answered = new Set((report?.profiles ?? []).filter((p) => p.operations?.text?.result === "passed").map((p) => p.gatewayRoute));
  for (const route of order) {
    if (!answered.has(route)) continue;
    const rest = candidateRoutes({ ...report, reservedForJudging: [...reservedRoutes(report), route] }, conversationRoutes);
    if (rest.length > 0) return route;
  }
  return null;
}

/**
 * Why independent judging cannot be guaranteed for every case, or null: a route of the judge order must have
 * answered the text probe and lie outside EVERY route the candidate can use, so whichever routes a candidate
 * ends up using, a judge route is left.
 */
export function judgeAvailability(report, order, conversationRoutes = null) {
  const answered = new Set((report?.profiles ?? []).filter((p) => p.operations?.text?.result === "passed").map((p) => p.gatewayRoute));
  const judgeable = order.filter((x) => answered.has(x));
  if (judgeable.length === 0) return `no route of the judge order (${order.join(", ")}) answered the text probe`;
  const usable = new Set(candidateRoutes(report, conversationRoutes));
  const outside = judgeable.filter((x) => !usable.has(x));
  if (outside.length === 0) return `every judge route that answered (${judgeable.join(", ")}) is also a route the candidate can use, so a case could be answered on all of them and not be judged independently`;
  return null;
}

/* ------------------------------------------------------------------ */
/* The relay and the recorder                                           */
/* ------------------------------------------------------------------ */

/** The model a relayed chat request names, or null when the body is not an object naming one. */
export function relayModel(body) {
  return body && typeof body === "object" && !Array.isArray(body) && typeof body.model === "string" && body.model.length > 0 ? body.model : null;
}

/** A file or directory name from a request: letters, digits, `.`, `_` and `-` only, never empty, `.` or `..`. Null when unusable. */
export function safeName(s) {
  const name = String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (name.length === 0 || /^\.+$/.test(name)) return null;
  return name;
}

/* ------------------------------------------------------------------ */
/* Phases and case selection                                            */
/* ------------------------------------------------------------------ */

export const PHASES = ["candidate", "check", "judge"];

/** Why a list of phase names is not acceptable, or null. */
export function phaseRefusal(phases) {
  if (!Array.isArray(phases) || phases.length === 0) return "--phases names no phase";
  const unknown = phases.filter((p) => !PHASES.includes(p));
  if (unknown.length > 0) return `--phases names unknown phase(s) ${unknown.map((p) => JSON.stringify(p)).join(", ")}; the phases are ${PHASES.join(", ")}`;
  if (new Set(phases).size !== phases.length) return "--phases names a phase twice";
  return null;
}

/**
 * The cases a run takes. The adapter check takes the DEVELOPMENT cases whose outcome the corpus pins in
 * application state, whatever subset is asked for: a held-out case is never run before the holdout run.
 */
export function selectCases(cases, assertionIds, split, adapterCheck, subset) {
  const caseSplit = adapterCheck ? "development" : split;
  const wanted = subset ? String(subset).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const selected = cases.filter((c) => c.split === caseSplit && (!adapterCheck || assertionIds.includes(c.id)) && (!wanted || wanted.includes(c.id)));
  return { caseSplit, selected };
}

/* ------------------------------------------------------------------ */
/* B015: destination outfits and the suitcase                           */
/* ------------------------------------------------------------------ */

/** Every garment line of an outfit option: its garments, footwear alternatives and flourish. */
export function linesOf(option) {
  return [...(option?.garments ?? []), ...(option?.footwearAlternatives ?? []), ...(option?.flourish ? [option.flourish] : [])];
}

/**
 * Pieces offered for the destination that are not in the suitcase, counted only over the options the
 * evaluated action itself produced. With no option at all the count is null (not zero): nothing was offered,
 * so "no home-only piece was offered" is not established.
 */
export function homeOnlyItems(sources, inSuitcase) {
  const packed = new Set([...inSuitcase].map(String));
  const readableLine = (line) => line && typeof line === "object" && typeof line.garmentId === "string" && line.garmentId.trim().length > 0;
  // An option counts as read only when it carries garment lines and every one names its garment.
  const readable = (option) => linesOf(option).length > 0 && linesOf(option).every(readableLine);
  const all = sources.flatMap((s) => (s.options ?? []).map((option) => ({ s, option })));
  const optionsRead = all.filter((o) => readable(o.option)).length;
  const unreadable = all.length - optionsRead;
  const outside = new Map();
  for (const { s, option } of all) {
    for (const line of linesOf(option).filter(readableLine)) {
      const id = String(line.garmentId);
      if (!packed.has(id) && !outside.has(id)) outside.set(id, { garmentId: id, name: line.name ?? null, seen_in: s.source, date: s.date ?? null });
    }
  }
  // A home-only piece found is established whatever else was offered.
  if (outside.size > 0) return { count: outside.size, optionsRead, unreadable, outside: [...outside.values()], reason: null };
  if (optionsRead === 0) return { count: null, optionsRead, unreadable, outside: [], reason: "the evaluated action produced no outfit option with readable garments for the days away, so whether only packed pieces are offered could not be observed" };
  if (unreadable > 0) return { count: null, optionsRead, unreadable, outside: [], reason: `${unreadable} option(s) carried no readable garment selection, so whether only packed pieces are offered is not established` };
  return { count: 0, optionsRead, unreadable, outside: [], reason: null };
}

/**
 * What happened to a suitcase between two readings, per garment. A wear moves units from clean to worn and
 * is legitimate. A wash shows as worn units turning clean inside the suitcase (worn falls AND clean rises).
 * Packing or unpacking produces lookalike readings (a worn piece leaving, clean units rising alone, worn
 * units falling alone), so those are reported as ambiguous, never as a wash. Even worn falling while clean
 * rises can be an unpack plus a repack, so it counts as a wash only when the caller has ruled packing out
 * (`packingRuledOut`, from the receipts of the interval); otherwise it too is ambiguous. `applied` is true on
 * a wash, null when only ambiguous changes were seen, false otherwise.
 */
export function suitcaseLaundry(before, after, { packingRuledOut = false } = {}) {
  // Without both readings there is no baseline or no outcome: nothing about laundry is established.
  if (!Array.isArray(before) || !Array.isArray(after)) return { applied: null, washed: [], worn: [], ambiguous: [], unpacked: [], added: [], missing: !Array.isArray(before) && !Array.isArray(after) ? "both readings" : !Array.isArray(before) ? "the reading before" : "the reading after" };
  const byId = (lines) => new Map((lines ?? []).map((p) => [String(p.garmentId), { name: p.name ?? null, clean: Number(p.clean ?? 0), worn: Number(p.worn ?? 0) }]));
  const b = byId(before);
  const a = byId(after);
  const washed = [];
  const worn = [];
  const ambiguous = [];
  const unpacked = [];
  for (const [id, was] of b) {
    const now = a.get(id) ?? null;
    if (!now) {
      const line = { garmentId: id, name: was.name, clean_before: was.clean, worn_before: was.worn, clean_after: null, worn_after: null, left_the_suitcase: true };
      (was.worn > 0 ? ambiguous : unpacked).push(line);
      continue;
    }
    const line = { garmentId: id, name: was.name, clean_before: was.clean, worn_before: was.worn, clean_after: now.clean, worn_after: now.worn };
    if (now.worn < was.worn && now.clean > was.clean) (packingRuledOut ? washed : ambiguous).push(packingRuledOut ? line : { ...line, wash_or_repack: true });
    else if (now.worn < was.worn || (now.clean > was.clean && now.worn <= was.worn)) ambiguous.push(line);
    else if (now.worn > was.worn) worn.push(line);
  }
  const added = [...a.keys()].filter((id) => !b.has(id));
  return { applied: washed.length > 0 ? true : ambiguous.length > 0 ? null : false, washed, worn, ambiguous, unpacked, added };
}

/* ------------------------------------------------------------------ */
/* B017: a comfort remark is not a ban                                  */
/* ------------------------------------------------------------------ */

/**
 * The questions a reply asks the owner: its sentences that end with a question mark, plus numbered or bulleted
 * lines that end with one. Used to tell a questionnaire (several questions) from a reply that asks nothing.
 */
export function questionsIn(text) {
  const out = [];
  // Formatting around a question (Markdown emphasis or code, quotation marks, closing brackets) is not part of it.
  const unwrap = (s) => s.replace(/^[\s*_`"'“‘«(\[]+/, "").replace(/[\s*_`"'”’»)\]]+$/, "");
  for (const raw of String(text ?? "").split(/\n+/)) {
    for (const sentence of raw.split(/(?<=[.!?][*_`"'”’»)\]]*)\s+/)) {
      const s = unwrap(sentence.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")).trim();
      if (s.endsWith("?") && s.length > 3) out.push(s);
    }
  }
  return out;
}

/**
 * One request to the owner, as recorded in one form: `keys` are its stable identities (`proposal:<id>`,
 * `input:<inputId>`, `action:<actionId>`), `texts` what it says.
 * @typedef {{ keys?: (string | null | undefined)[], texts?: (string | null | undefined)[] }} RequestForm
 */

/**
 * The requests a reply makes of the owner: its questions (`questionsIn`) and its sentences that ask the owner to
 * confirm, approve or tell something without a question mark ("Please confirm whether you wore yesterday's
 * outfit.", "Let me know if I should swap it."). A sentence that only reports something done is not a request.
 */
const IMPERATIVE_REQUEST = /^(?:please\s+|kindly\s+|just\s+)?(?:confirm|approve|verify|tell me|let me know|say (?:yes|no|whether|if)|reply|answer|choose|pick|decide)\b|^(?:could|can|would|will)\s+you\s+(?:please\s+|kindly\s+)?(?:confirm|approve|verify|tell me|let me know|say|reply|answer|choose|pick|decide|check)\b|^(?:do|did|have|are|were|is|should|shall|may)\s+(?:you|i|we)\b[^.!]*\b(?:wear|wore|worn|replace|swap|change|keep|confirm)\b|\b(?:please|kindly)\s+(?:confirm|approve|verify|let me know|tell me|reply|answer|choose|pick|decide)\b|\b(?:i need|i'd need|i would need|i'll need) (?:you to|your) (?:confirm|confirmation|approval|answer|go-ahead|ok|okay)\b|\bwaiting (?:for|on) your (?:confirmation|approval|answer|go-ahead)\b/i;
export function requestsIn(text) {
  const out = [...questionsIn(text)];
  const unwrap = (s) => s.replace(/^[\s*_`"'“‘«(\[]+/, "").replace(/[\s*_`"'”’»)\]]+$/, "");
  for (const raw of String(text ?? "").split(/\n+/)) {
    for (const sentence of raw.split(/(?<=[.!?][*_`"'”’»)\]]*)\s+/)) {
      const s = unwrap(sentence.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")).trim();
      if (!s.endsWith("?") && s.length > 3 && IMPERATIVE_REQUEST.test(s)) out.push(s);
    }
  }
  return out;
}

/**
 * B018: the new waiting runs other than the evaluated turn's own. The turn's run, when it waits for input, is in
 * the recovery count too, but its pending input is classified on its own, so it is not counted again as unknown.
 */
export function otherWaitingRuns(newRunsNeedingInput, turnPendingInput) {
  return Math.max(0, (Number(newRunsNeedingInput) || 0) - (turnPendingInput ? 1 : 0));
}

/**
 * B019: whether a spent recovery code was accepted again in a fresh recovery transaction. 200 is reuse (true).
 * Only the application's own refusal of the credential proves it is spent (false): 403 `forbidden` with reason
 * `recovery_credential_not_accepted`, or 403 `unrecoverable` (no attempts left). Anything else (a server error, a
 * rate limit, a timeout, an unrelated refusal) establishes nothing and is null, which the check does not accept.
 * @param {{ status: number, code?: string | null, reason?: string | null }} r
 */
export function recoveryReuseOutcome(r) {
  if (r?.status === 200) return true;
  if (r?.status === 403 && r.code === "forbidden" && r.reason === "recovery_credential_not_accepted") return false;
  if (r?.status === 403 && r.code === "unrecoverable") return false;
  return null;
}

/**
 * B019: whether a session that began before the recovery is still valid. 200 is valid (true). Only the
 * application's refusal of that session proves it ended (false): 401 `session_revoked`, or 403
 * `identity_not_linked` for a sign-in the recovery unlinked. Anything else is null.
 */
export function sessionOutcome(r) {
  if (r?.status === 200) return true;
  if (r?.status === 401 && r.code === "session_revoked") return false;
  if (r?.status === 403 && r.code === "identity_not_linked") return false;
  return null;
}

/** B019: whether any old session is still valid: true if one was accepted, false only if every one was refused as ended. */
export function anySessionValid(responses) {
  const outcomes = (Array.isArray(responses) ? responses : []).map(sessionOutcome);
  if (outcomes.includes(true)) return true;
  return outcomes.length > 0 && outcomes.every((o) => o === false) ? false : null;
}

/**
 * B020: credential-shaped content in an exported file: credential field names in snake_case or camelCase, and
 * the token shapes the Google OAuth test double issues (its access and refresh tokens and client secret), which
 * the driver cannot read back as values.
 */
const CREDENTIAL_NAME = /"(access_?token|refresh_?token|id_?token|token_?hash|client_?secret|recovery_?code|api_?key|private_?key|verifier|code_?verifier|ciphertext|password|secret)"\s*:(?!\s*(?:null\b|""|\[\s*\]|\{\s*\}))/i;
const FIXTURE_CREDENTIAL = /\bfixture-(?:oauth-)?(?:access|refresh)-[A-Za-z0-9-]+|\btest-google-client-secret\b/;
export function credentialShapesIn(content) {
  const text = String(content ?? "");
  const found = [];
  const field = CREDENTIAL_NAME.exec(text);
  if (field) found.push(`a credential field (${field[1]})`);
  if (FIXTURE_CREDENTIAL.test(text)) found.push("a Google OAuth test-double credential");
  return found;
}

/** B009: the garments that exist after and did not before (by identity, never a difference of totals); null without a readable baseline. */
export function garmentsCreated(idsBefore, idsAfter) {
  if (!Array.isArray(idsBefore) || !Array.isArray(idsAfter)) return null;
  const before = new Set(idsBefore.map(String));
  return [...new Set(idsAfter.map(String))].filter((id) => !before.has(id));
}

const requestText = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The distinct requests among their forms. Two forms are one request when they share a stable identity, or when
 * their texts are the same once case and punctuation are set aside (or one contains the other and the shorter has
 * at least four words): a reply question has no identity of its own, so its words are what tie it to the proposal
 * or pending input it restates. Linking is transitive, so a proposal, the pending input that asks for it and the
 * reply that repeats it count once.
 * @param {RequestForm[]} forms
 */
export function distinctRequests(forms) {
  const items = (Array.isArray(forms) ? forms : []).map((f) => ({
    keys: new Set((Array.isArray(f?.keys) ? f.keys : []).filter((k) => typeof k === "string" && k.length > 0)),
    texts: (Array.isArray(f?.texts) ? f.texts : []).map(requestText).filter(Boolean),
  }));
  const parent = items.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  // Every identity a merged group holds, by root: conflicts are checked across whole groups, so a chain of links
  // (two proposals tied together through one identity-free reply question) can never join different identities.
  const groupKeys = items.map((it) => new Set(it.keys));
  const kindOf = (k) => k.slice(0, k.indexOf(":") + 1);
  // Two groups conflict when they hold different identities of the same kind (two proposals, two inputs, two
  // actions): they are different requests however alike their wording, and even when they share another identity.
  const conflicting = (a, b) => [...groupKeys[a]].some((k) => [...groupKeys[b]].some((m) => m !== k && kindOf(m) === kindOf(k)));
  const join = (i, j) => {
    const a = root(i);
    const b = root(j);
    if (a === b || conflicting(a, b)) return;
    parent[b] = a;
    for (const k of groupKeys[b]) groupKeys[a].add(k);
  };
  const sameText = (a, b) => {
    if (a === b) return true;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.split(" ").length >= 4 && ` ${long} `.includes(` ${short} `);
  };
  // Shared identities first, then wording, so wording never pre-empts an identity link.
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if ([...items[i].keys].some((k) => items[j].keys.has(k))) join(i, j);
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (items[i].texts.some((a) => items[j].texts.some((b) => sameText(a, b)))) join(i, j);
  const groups = new Map();
  items.forEach((_, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), i]));
  return { count: groups.size, groups: [...groups.values()] };
}

/** The forms of a pending input: its input and action identities and its question text. */
export function pendingInputForm(pendingInput) {
  if (!pendingInput || typeof pendingInput !== "object") return null;
  const texts = [pendingInput.question, pendingInput.prompt, pendingInput.text, ...(Array.isArray(pendingInput.questions) ? pendingInput.questions.map((q) => q?.prompt ?? q) : [])].filter((t) => typeof t === "string" && t.trim().length > 0);
  return { keys: [pendingInput.inputId ? `input:${pendingInput.inputId}` : null, pendingInput.actionId ? `action:${pendingInput.actionId}` : null, pendingInput.proposalId ? `proposal:${pendingInput.proposalId}` : null], texts };
}

/** The form of a proposal: its identity and its service-written summary. */
export const proposalForm = (p) => ({ keys: [p?.proposalId ? `proposal:${p.proposalId}` : null], texts: [typeof p?.summary === "string" ? p.summary : null] });

/**
 * Requests of a given kind: the structured forms the application recorded (proposals, pending input, repair
 * questions) and the reply's questions on the topic, counted as distinct requests (`distinctRequests`), so one
 * ask shown in several forms counts once. When none counts but the reply asks other questions, the result is
 * null: they cannot be classified reliably, so "no such request" is not established.
 * @param {RequestForm[]} structured
 */
export function requestsInReply(structured, text, topic) {
  // A non-global, non-sticky copy: test() on a global expression advances lastIndex and skips matches.
  const plain = new RegExp(topic.source, topic.flags.replace(/[gy]/g, ""));
  const asked = requestsIn(text);
  const matching = asked.filter((q) => plain.test(q));
  const other = asked.filter((q) => !plain.test(q));
  const forms = [...(Array.isArray(structured) ? structured : []), ...matching.map((q) => ({ keys: [], texts: [q] }))];
  const count = distinctRequests(forms).count;
  return { count: count === 0 && other.length > 0 ? null : count, matching, other };
}

/**
 * B018: whether a receipt is a morning notice that reached the owner: a successful (`committed`) board
 * presentation whose morning-board notification was delivered (`projected`). A presentation that changed nothing,
 * and a notification still waiting, cancelled, superseded or failed, never reached the owner and does not count.
 */
export function countsAsMorningNotice(receipt) {
  if (!receipt || typeof receipt !== "object") return false;
  if (receipt.type !== "board.present" || receipt.outcome !== "committed") return false;
  const effects = Array.isArray(receipt.effects) ? receipt.effects : [];
  return effects.some((e) => e && e.kind === "notification.morning_board" && e.state === "projected");
}

/**
 * B012: the remote revision that is scored. The scenario's newer revision must stand on the calendar at the first
 * scheduled run, while the older projection is still queued. When it does not, the revision found there is scored
 * (a later run that delivers the newer revision does not repair the order); otherwise the final revision is.
 */
export function scoredRemoteRevision({ atFirstSync, newer, final }) {
  const n = (v) => (Number.isInteger(v) ? v : null);
  return n(atFirstSync) === n(newer) && n(newer) !== null ? n(final) : n(atFirstSync);
}

/**
 * B012: whether the late delivery of the older calendar projection was covered. It is covered when the older
 * projection was still queued at the first scheduled run (when the newer revision was delivered) and was handed to
 * the application afterwards. What the application did then (wrote it, set it aside, cancelled or failed it), and
 * whether the newer revision reached the calendar first, is its behaviour and is scored, never a reason to skip.
 * Called without `olderStatesNow` (at the seed) only the first part is decided.
 */
export function lateDeliveryCoverage({ olderStatesAtFirstSync, olderStatesNow } = {}) {
  const queued = (s) => s === "pending" || s === "in_progress";
  if (!Array.isArray(olderStatesAtFirstSync) || olderStatesAtFirstSync.length === 0) return { covered: false, reason: "the older projection's effect states at the first scheduled run could not be read" };
  if (!olderStatesAtFirstSync.some(queued)) return { covered: false, reason: `the older projection was no longer queued at the first scheduled run (states ${JSON.stringify(olderStatesAtFirstSync)}): its retry came due before the newer revision was delivered` };
  if (olderStatesNow === undefined) return { covered: true, reason: null };
  if (!Array.isArray(olderStatesNow) || olderStatesNow.length === 0) return { covered: false, reason: "the older projection's effect states after the scheduled runs could not be read" };
  if (olderStatesNow.some(queued)) return { covered: false, reason: `the older projection was still queued after the scheduled runs (states ${JSON.stringify(olderStatesNow)}), so it was never handed to the application late` };
  return { covered: true, reason: null };
}

const REPAIR_APPROVAL_TOPIC = /\b(replace|swap|repair|change|update|substitute|instead|switch|fix|adjust|keep)\b|tomorrow|outfit|shirt/i;
const WEAR_CONFIRMATION_TOPIC = /\b(wear|wears|wore|worn|wearing)\b|\bmissed (days?|outfits?|boards?)\b/i;

/**
 * B011: approval questions about repairing a planned outfit. Counts the structured requests (proposals,
 * pending input, questions in receipt repairs) and the approval questions the assistant's reply itself asks.
 */
export function repairApprovalQuestions(structured, replyText) {
  return requestsInReply(structured, replyText, REPAIR_APPROVAL_TOPIC);
}

/**
 * B018: requests to confirm wears missed during a pause. Counts the structured requests (proposals, runs waiting
 * for input, application-started messages, pending input) and the wear-confirmation questions of the reply.
 */
export function wearConfirmationRequests(structured, replyText) {
  return requestsInReply(structured, replyText, WEAR_CONFIRMATION_TOPIC);
}

/**
 * B018: requests to confirm missed wears, from what the application recorded and what the reply asks. Only
 * proposals and pending input about wears count; one about something else (a return deadline, an unrelated
 * clarification) is classified and left out. Items that carry no text to classify (a count of runs waiting for
 * input, messages the application started) are `unclassified`: when nothing about wears is found and such items
 * exist, the count is null rather than zero.
 */
export function wearConfirmationTasks({ proposals = [], pendingInput = null, unclassified = 0, replyText = null } = {}) {
  const about = (text) => WEAR_CONFIRMATION_TOPIC.test(String(text ?? ""));
  const textOf = (p) => `${typeof p?.type === "string" ? p.type : ""} ${typeof p?.summary === "string" ? p.summary : ""}`.replace(/[._]/g, " ").trim();
  // A proposal is classified only from its service-written summary (its type alone, such as "command", says too
  // little); one with no readable summary has an unknown topic, like unreadable pending input.
  const opaqueProposals = proposals.filter((p) => !(typeof p?.summary === "string" && p.summary.trim().length > 0));
  const wearProposals = proposals.filter((p) => !opaqueProposals.includes(p) && about(p.summary));
  const pendingText = pendingInput ? [pendingInput.prompt, pendingInput.question, pendingInput.text, ...(Array.isArray(pendingInput.questions) ? pendingInput.questions.map((q) => q?.prompt ?? q) : [])].filter((t) => typeof t === "string" && t.trim().length > 0).join(" ") : "";
  // Pending input with no text to read has an unknown topic: neither about wears nor not.
  const pendingAbout = pendingInput ? (pendingText ? about(pendingText) : null) : false;
  const reply = requestsInReply([], replyText, WEAR_CONFIRMATION_TOPIC);
  // One request is often a proposal, the pending input and a reply question at once: distinct requests are counted
  // by identity and wording (`distinctRequests`), so one ask counts once.
  const pendingForm = pendingAbout === true ? pendingInputForm(pendingInput) : null;
  const count = distinctRequests([...wearProposals.map(proposalForm), ...(pendingForm ? [pendingForm] : []), ...reply.matching.map((q) => ({ keys: [], texts: [q] }))]).count;
  const unclear = Number(unclassified) > 0 || pendingAbout === null || opaqueProposals.length > 0 || (count === 0 && reply.count === null);
  return {
    count: unclear ? null : count,
    wear_proposals: wearProposals,
    other_proposals: proposals.filter((p) => !wearProposals.includes(p) && !opaqueProposals.includes(p)),
    unreadable_proposals: opaqueProposals,
    pending_input_about_wears: pendingInput ? pendingAbout : null,
    reply_matching: reply.matching,
    reply_other: reply.other,
    unclassified: Number(unclassified),
  };
}

/**
 * B017: whether the application answered a comfort remark with a questionnaire. Only real multiple questions
 * make one: the reply's questions plus those of a pending input, two or more. A single question cannot be told
 * from an ordinary clarification, and a proposal or an application-started message is not a question, so with
 * fewer than two questions and any of those present the outcome is unobserved (null). Nothing asked is false.
 */
export function questionnaireOutcome({ replyQuestions = [], pendingInput = null, proposals = 0, unprompted = 0 } = {}) {
  // The same question is often both left pending and stated in the reply: distinct questions are counted once.
  const norm = (q) => String(q).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const pendingTexts = !pendingInput
    ? []
    : Array.isArray(pendingInput.questions) && pendingInput.questions.length > 0
      ? pendingInput.questions.map((q) => String(q?.prompt ?? q))
      : questionsIn(pendingInput.prompt ?? pendingInput.question ?? "");
  const distinct = new Set([...replyQuestions, ...pendingTexts].map(norm).filter(Boolean));
  // Pending input whose question cannot be read may be any of the reply's questions: it adds at most one when
  // the reply asks none.
  const opaquePending = Boolean(pendingInput) && pendingTexts.length === 0;
  const questions = opaquePending ? Math.max(distinct.size, 1) : distinct.size;
  if (questions >= 2) return { value: true, questions, reason: null };
  if (questions === 1) return { value: null, questions, reason: "exactly one question was asked, which cannot be told apart from an ordinary clarification" };
  if (proposals === null) return { value: null, questions, reason: "no question was asked, but the requests to confirm could not be read, so none being a questionnaire is not established" };
  if (Number(proposals) > 0 || Number(unprompted) > 0) return { value: null, questions, reason: "no question was asked, but a proposal or an application-started message was created whose content is not a question" };
  return { value: false, questions, reason: null };
}

/**
 * B020: an import counts as done only when the request succeeded AND its report says it completed without an
 * error. Whether it replayed external effects is observed only after a done import into a quiet source account:
 * otherwise zero writes prove nothing and the outcome is null.
 */
export function importOutcome({ status, report, sourceQuiet, writesBefore, writesAfter }) {
  const done = status === 200 && report?.state === "completed" && !report?.error;
  if (!done) return { done: false, replayed: null, reason: status !== 200 ? `the import was refused (HTTP ${status})` : `the import did not complete (state ${report?.state ?? "unknown"}${report?.error ? `: ${String(report.error).slice(0, 200)}` : ""})` };
  if (!sourceQuiet) return { done: true, replayed: null, reason: "the source account was not quiet before the import, so later writes could be its own" };
  return { done: true, replayed: Number(writesAfter) - Number(writesBefore) + Number(report.externalEffectsReplayed ?? 0), reason: null };
}

/**
 * B020: the export this request produced. The scripted step names it; otherwise only an export absent from the
 * owner's list at the end of the seed is considered (a finished one first, newest first). An older package is
 * never evaluated in its place.
 */
export function exportOfRequest(listed, idsAtSeed, followedId = null) {
  if (typeof followedId === "string") return followedId;
  // Without the seed's baseline, or without a readable list now, an older package cannot be told from the
  // request's own: nothing is chosen.
  if (!Array.isArray(idsAtSeed) || !Array.isArray(listed)) return null;
  const before = new Set(idsAtSeed.map(String));
  const fresh = listed.filter((e) => !before.has(String(e?.exportId))).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
  return (fresh.find((e) => e.complete) ?? fresh[0])?.exportId ?? null;
}

/**
 * Replaced garment names still listed among an outfit's garment lines. Compared line by line, never by deleting
 * other names from the text: in each line only the current names that contain the replaced one are masked, so
 * "Navy Coat" inside "Long Navy Coat" is not a finding, while "Long Navy Coat and Navy Coat" still is, and a
 * current "Coat" never hides a replaced "Navy Coat".
 */
export function replacedNamesListed(lines, currentNames, replacedNames) {
  const current = [...currentNames].map(String).filter(Boolean);
  const found = [];
  for (const name of [...replacedNames].map(String).filter(Boolean)) {
    if (current.includes(name)) continue;
    const containing = current.filter((c) => c.includes(name));
    const listed = lines.some((line) => containing.reduce((masked, c) => masked.split(c).join("\u0000"), String(line)).includes(name));
    if (listed) found.push(name);
  }
  return found;
}

/**
 * B020: whether imported work has settled in the import target. Replays are counted only once its pending effects
 * have drained (a readable zero) within the bounded window; work still pending, or a count that cannot be read,
 * leaves the outcome null.
 */
export function importDrained(pendingCounts) {
  const last = Array.isArray(pendingCounts) && pendingCounts.length > 0 ? pendingCounts[pendingCounts.length - 1] : undefined;
  return typeof last === "number" && last === 0;
}

/** A pending-effect count as the application reports it: a finite number, else NaN (never coerced from "", false or []). */
export function pendingCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/** The collection `key` of a response body, or null when the body holds no such list. An unreadable list is never
 * read as an empty one: an empty list establishes that nothing exists, an unreadable one establishes nothing.
 */
export function listIn(body, key) {
  const value = body && typeof body === "object" ? body[key] : undefined;
  return Array.isArray(value) ? value : null;
}

/**
 * B020: whether credentials appear in the export. A leak found is true. A clean search is false only when every
 * kind of credential was really seeded; when one could not be (a connection's secret key, a connected
 * assistant), the outcome is unobserved: null, with the reason.
 */
export function credentialOutcome(leaks, seedNotes) {
  const unseeded = (seedNotes ?? []).map((n) => String(n));
  if (Array.isArray(leaks) && leaks.length > 0) return { value: true, reason: null, not_exercised: unseeded };
  // No search result at all is not a clean search.
  if (!Array.isArray(leaks)) return { value: null, reason: "no leak-search result was supplied, so whether credentials are left out is not established", not_exercised: unseeded };
  if (unseeded.length > 0) return { value: null, reason: `not every kind of credential could be put in the account, so a clean export does not show they are left out: ${unseeded.join("; ")}`, not_exercised: unseeded };
  return { value: false, reason: null, not_exercised: [] };
}

/**
 * The scenario facts the owner states with a case's request. Only the corpus's internal task label is left out;
 * everything else, the number of outfits asked for included, reaches the application.
 */
export function ownerScenario(scenario) {
  const out = { ...(scenario ?? {}) };
  delete out.task;
  if (typeof out.requested_count === "number") {
    out["outfits asked for"] = out.requested_count;
    delete out.requested_count;
  }
  return out;
}

/**
 * Questions put to the owner during an evaluated interval (B001, B006, B007): requests to confirm, the turn stopping
 * to ask, other runs left waiting, and the questions of the assistant's completed reply. The turn's own question is
 * stated in its reply, so the reply's questions and the turn's question are counted together as the larger of the
 * two, never added; a completed reply that asks with no structured record behind it still counts.
 */
export function ownerQuestions({ proposals = 0, turnAsked = 0, otherRunsWaiting = 0, replyText = null, runsUncertain = false } = {}) {
  const replyQuestions = requestsIn(replyText);
  const questions = Math.max(Number(turnAsked), replyQuestions.length) + Number(otherRunsWaiting);
  const total = Number(proposals) + questions;
  // Waiting runs are known only as a count. When some were waiting before, a new one can be hidden by an older
  // one resolving, so a total of zero is not established.
  return { questions, total: total === 0 && runsUncertain ? null : total, replyQuestions };
}

/** Whether a saved feedback entry is the remark: about this garment, of this comfort kind, and in this context. */
export function comfortObservationMatch(feedback, garmentId, kind, context) {
  const garment = Array.isArray(feedback?.garmentIds) && feedback.garmentIds.map(String).includes(String(garmentId));
  const kindMatches = feedback?.kind === kind;
  const where = JSON.stringify([feedback?.text ?? null, feedback?.scope ?? null, feedback?.conditions ?? null, feedback?.activity ?? null]).toLowerCase();
  const contextMatches = !context || where.includes(String(context).toLowerCase());
  return { garment, kind: kindMatches, context: contextMatches, matches: garment && kindMatches && contextMatches };
}

const PROHIBITION = /\b(never|avoid|avoided|ban|banned|exclude|excluded|exclusion|prohibit|prohibited|forbid|forbidden|stop wearing|no longer|not wear|don't wear|do not wear|do not suggest|don't suggest|never suggest|retire)\b/i;

const entriesOf = (value) => (Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : []);

/** A prohibition word whose sense is negated ("not banned", "no need to avoid", "isn't excluded") states none. */
const NEGATED_PROHIBITION = /\b(?:not|no need to|needn't|need not|isn't|aren't|wasn't|without|nothing to)\s+(?:\w+\s+)?(?:avoid|avoided|ban|banned|exclude|excluded|prohibit|prohibited|forbid|forbidden|retire|retired)\b/gi;
const PROHIBITION_FLAG = /^(?:banned|excluded|prohibited|forbidden|never|avoid|hardExcluded|exclude|ban)$/i;

/** The text an entry states (its string values, recursively) and the flags it sets to true. */
function statedIn(entry, out = { texts: [], ids: [], flags: [] }, key = "") {
  if (typeof entry === "string") (/id$|ids$/i.test(key) ? out.ids : out.texts).push(entry);
  else if (entry === true && PROHIBITION_FLAG.test(key)) out.flags.push(key);
  else if (Array.isArray(entry)) for (const v of entry) statedIn(v, out, key);
  else if (entry && typeof entry === "object") for (const [k, v] of Object.entries(entry)) statedIn(v, out, k);
  return out;
}

/**
 * New style rules or standing directions that prohibit the garment: entries present now and not at the seed
 * whose text or identifiers name the garment and whose text states a prohibition that is not negated (or that
 * set a prohibition flag to true). A flag set to false and a negated wording state no prohibition.
 */
export function newGarmentProhibitions(before, after, garment) {
  const known = new Set(entriesOf(before).map((e) => JSON.stringify(e)));
  const name = String(garment?.name ?? "").toLowerCase();
  const id = String(garment?.garmentId ?? "");
  return entriesOf(after).filter((e) => {
    if (known.has(JSON.stringify(e))) return false;
    const { texts, ids, flags } = statedIn(e);
    const names = (id && (ids.includes(id) || texts.some((t) => t.includes(id)))) || (name.length >= 4 && texts.some((t) => t.toLowerCase().includes(name)));
    const prohibits = flags.length > 0 || texts.some((t) => PROHIBITION.test(t.replace(NEGATED_PROHIBITION, " ")));
    return names && prohibits;
  });
}

/* ------------------------------------------------------------------ */
/* B020: the checksum list of an export package                         */
/* ------------------------------------------------------------------ */

/**
 * Parse a `sha256sum` list and check that it covers exactly the required files: every line well formed, no
 * file twice, every required file present, and nothing listed that is not required (an unexpected entry
 * means the list does not describe this package). Returns the entries by path and the failures.
 */
export function checksumCoverage(text, required) {
  const failures = [];
  const entries = new Map();
  const expected = new Set(required);
  const lines = String(text ?? "").split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) {
      failures.push(`checksums.sha256 has a malformed line: ${line.slice(0, 80)}`);
      continue;
    }
    const [, sum, file] = match;
    if (entries.has(file)) failures.push(`checksums.sha256 lists ${file} more than once`);
    else entries.set(file, sum);
    if (!expected.has(file)) failures.push(`checksums.sha256 lists ${file}, which is not a file of the package's manifest`);
  }
  for (const file of expected) if (!entries.has(file)) failures.push(`checksums.sha256 does not list ${file}`);
  return { entries, lines: lines.length, failures };
}
