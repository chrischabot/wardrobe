/**
 * The verifier's write guard for the owner's outfit board (used by verify-codex.mjs, tested in test/plugin.test.mjs).
 *
 * Before every write the verifier reads the board again and asks `writeDecision`. A write goes ahead only when the
 * board is the one it last saw, at the same revision, and (on a hosted run, the owner's real board) carries no choice
 * the owner made. Every write also sends the board version it just observed (`versionsOf`) as `expectedVersions`,
 * so a change that lands between the read and the write is refused by the server instead of overwritten.
 */

/** The owner's calendar date `offsetDays` from today in `timeZone`, as YYYY-MM-DD: calendar arithmetic, so a
 * daylight-saving change (a 23- or 25-hour day) never yields today or the day after tomorrow. */
export function ownerDay(now, timeZone, offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now);
  const part = (type) => Number(parts.find((p) => p.type === type)?.value);
  const [y, m, d] = [part("year"), part("month"), part("day")];
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

/** The authorization URL `codex mcp login` printed, or null while it is not complete: output arrives in arbitrary
 * pipe chunks, so the URL counts only once the whitespace (newline) that ends it has arrived. */
export function authorizationUrlFrom(output) {
  const m = /(https?:\/\/\S*\/oauth\/authorize\?\S+)\s/.exec(output);
  return m ? new URL(m[1]) : null;
}

/**
 * Is the board the verifier writes to the owner's real board? Only two runs use a board of their own: the local
 * Worker (its run publishes the board as the owner) and a Ferrite instance the operator declared disposable
 * (--disposable-test-instance) at a loopback URL. Every other run, hosted or not, works on the owner's real board.
 */
export const realBoardRun = ({ workerLocal, ferrite, loopback, disposable }) => !workerLocal && !(ferrite && loopback && disposable);

/**
 * May the verifier send a piece swap (`board.swap_slot`)? A swap rewrites an outfit on the board, and a server may
 * not offer its undo (some answer `not_undoable`), so on the owner's real board it is sent only when the operator
 * acknowledged that with --allow-real-swap. Returns { ok: true } or { ok: false, reason }.
 */
export function swapDecision({ realBoard, allowRealSwap = false }) {
  if (!realBoard) return { ok: true };
  if (allowRealSwap) return { ok: true };
  return { ok: false, reason: "this run works on the owner's real board, where a swap may not be undoable; pass --allow-real-swap to send it, or run against a test account or a disposable instance" };
}

/** Whether an assistant tool (ask, research) refused for want of an inference gateway, naming the secret: code
 * module_unavailable, and WARDROBE_AI_GATEWAY in the message or the details. */
export function assistantRefusal(outcome) {
  if (!outcome || outcome.ok || outcome.error?.code !== "module_unavailable") return false;
  return JSON.stringify({ m: outcome.error.message ?? "", d: outcome.error.details ?? null }).includes("WARDROBE_AI_GATEWAY");
}

/** The owner's choice on a board (option and footwear), or null. */
export const choiceOf = (board) =>
  JSON.stringify(board?.selection ? { optionId: board.selection.optionId ?? null, footwearGarmentId: board.selection.footwearGarmentId ?? null } : null);

/** The board as the owner sees it: which board, the choice and every option's pieces (not the revision, which an undo advances). */
export const boardState = (board) =>
  JSON.stringify({
    boardId: board?.boardId ?? null,
    choice: choiceOf(board),
    options: (board?.options ?? []).map((o) => `${o.optionId}=${(o.garments ?? []).map((g) => `${g.role}:${g.garmentId}`).sort().join(",")}`).sort(),
  });

/** Whether the wear recorded for a day is the same in two reads of `/v1/days/<date>` (choosing an outfit must not
 * record a wear). Both reads must list the day's garments; order does not matter. */
export function sameWear(beforeDay, afterDay) {
  if (!Array.isArray(beforeDay?.garments) || !Array.isArray(afterDay?.garments)) return { ok: false, reason: "the day's wear could not be read before and after" };
  const ids = (day) => JSON.stringify(day.garments.map((g) => (typeof g === "string" ? g : g?.garmentId ?? JSON.stringify(g))).sort());
  return ids(beforeDay) === ids(afterDay) ? { ok: true, reason: `${afterDay.garments.length} garments worn, as before` } : { ok: false, reason: `wear before ${ids(beforeDay)}, after ${ids(afterDay)}` };
}

/** Settle with `promise`, or fail with `message` after `ms` or as soon as `stop` settles (for example the child
 * process exiting), whichever comes first. The timer is always cleared. For a helper that takes no abort signal this
 * cannot stop its work, but it lets the caller reach its own cleanup. */
export function within(promise, ms, message, stop) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    const ended = () => reject(new Error(`${message} (the process ended first)`));
    stop?.then(ended, ended);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** The first garment in an inventory snapshot that is laundered by service, held once and clean now, or null. */
export const cleanLaundered = (items) => (items ?? []).find((i) => i?.careChannel === "service" && Number(i.quantity) === 1 && Number(i.balances?.clean) >= 1)?.garmentId ?? null;

/** Every garment's balances in an inventory snapshot (every balance key, e.g. clean, dirty, service), as a comparable string (order-independent). */
export const balancesState = (items) =>
  JSON.stringify(
    (items ?? [])
      .map((i) => {
        const b = { clean: 0, dirty: 0, ...(i.balances ?? {}) };
        return `${i.garmentId}:${Object.keys(b).sort().map((k) => `${k}=${Number(b[k] ?? 0)}`).join(",")}`;
      })
      .sort(),
  );

/**
 * Whether a garderobe_today answer establishes that the day has no board: only an answer that carries a `board`
 * field set to null does. A failed or malformed read establishes nothing, so nothing may be published on it.
 */
export function boardAbsence(outcome) {
  if (!outcome?.ok) return { known: false, absent: false, reason: `garderobe_today failed: ${outcome?.error?.code ?? "unknown"}: ${outcome?.error?.message ?? ""}`.trim() };
  const data = outcome.data;
  if (data === null || typeof data !== "object" || !("board" in data)) return { known: false, absent: false, reason: "garderobe_today answered without a board field" };
  return data.board === null ? { known: true, absent: true, reason: "no board for that day" } : { known: true, absent: false, reason: `board ${data.board?.boardId ?? "(unnamed)"} already published` };
}

/**
 * What the verifier's board setup on the Ferrite port may do, from the garderobe_today answer: publish only when the
 * day is known to have no board and the instance was declared disposable at a loopback URL.
 */
export function setupDecision({ outcome, loopback, disposable }) {
  const absence = boardAbsence(outcome);
  if (!absence.known) return { action: "unknown", reason: absence.reason };
  if (!absence.absent) return { action: "exists", reason: absence.reason };
  if (!loopback || !disposable) return { action: "not_disposable", reason: "a publication has no undo, so it is sent only to a disposable local instance (--disposable-test-instance at a loopback URL)" };
  return { action: "publish", reason: absence.reason };
}

/**
 * The owner's board.publish for `date`: `expectedBoardRevision: 0` makes the server refuse it (precondition_failed,
 * boardChanged) when a board was published meanwhile, instead of replacing that board.
 */
export function publishCommand(date, outfits) {
  const options = outfits.map(([top, bottom, socks, footwear]) => ({ slots: [{ role: "top", garmentId: top }, { role: "bottom", garmentId: bottom }, { role: "socks", garmentId: socks }, { role: "footwear", garmentId: footwear }], reason: "" }));
  return { type: "board.publish", idempotencyKey: `codex-verify-publish-${date}`, authorization: "owner_tap", source: { channel: "ios" }, payload: { localDate: date, requestedCount: options.length, options, expectedBoardRevision: 0 } };
}

/** Whether a refused publication was refused only because another board was published meanwhile. */
export const publishLostRace = (json) => json?.error?.code === "precondition_failed" && json?.error?.details?.boardChanged === true;

/** Whether `after` is `before` with exactly one unit of `garmentId` moved from clean to dirty, nothing else changed. */
export function movedToDirty(before, after, garmentId) {
  // Exactly one item must be that garment, with a clean unit to move; otherwise nothing proves a move.
  const matching = (before ?? []).filter((i) => i.garmentId === garmentId);
  if (matching.length !== 1 || !(Number(matching[0].balances?.clean) >= 1)) return false;
  const shifted = before.map((i) => (i.garmentId === garmentId ? { ...i, balances: { ...i.balances, clean: Number(i.balances?.clean) - 1, dirty: Number(i.balances?.dirty ?? 0) + 1 } } : i));
  return balancesState(shifted) === balancesState(after);
}

/** A board revision usable as an expected version: a non-negative integer. */
export const validRevision = (revision) => Number.isInteger(revision) && revision >= 0;

/** Whether a change that was not applied (refused, or kept for the owner's confirmation) left the board exactly as it
 * was read just before the request: same board, same revision, same choice and every option's pieces. */
export function unchangedAfterUnapplied(before, after) {
  if (!before?.boardId || !validRevision(before.revision)) return { ok: false, reason: "no usable board was read before the request" };
  if (!after?.boardId) return { ok: false, reason: "the board could not be read after the request" };
  if (after.boardId !== before.boardId) return { ok: false, reason: `a different board (${after.boardId}) after the request` };
  if (after.revision !== before.revision) return { ok: false, reason: `the board moved from revision ${before.revision} to ${after.revision}` };
  if (boardState(after) !== boardState(before)) return { ok: false, reason: `before ${boardState(before)}, after ${boardState(after)}` };
  return { ok: true, reason: `board ${before.boardId} still at revision ${before.revision}, choice and pieces as before` };
}

/** The `expectedVersions` for a write to this board, at the revision observed. Throws on a board without a usable revision. */
export const versionsOf = (board) => {
  if (!board?.boardId || !validRevision(board.revision)) throw new Error(`no usable board version to send as expectedVersions (${JSON.stringify(board?.revision)})`);
  return { [`board:${board.boardId}`]: board.revision };
};

/**
 * May the verifier write to the board now?
 *   hosted    true against a deployment (the owner's real board), false against the local Worker
 *   lastSeen  the board as the verifier last read it after its previous step (null before the first write)
 *   current   the board read just now, immediately before the write
 *   ownWrite  true when the write takes back the verifier's own change (its own choice is then expected on the board)
 * Returns { ok: true } or { ok: false, reason }.
 */
export function writeDecision({ hosted, lastSeen = null, current, ownWrite = false }) {
  // A baseline that could not be established (see adoptAfterWrite) stops every later write.
  if (lastSeen?.refused) return { ok: false, reason: lastSeen.refused };
  if (!current?.boardId) return { ok: false, reason: "the board could not be read just before the write" };
  // Without a usable revision there is no expectedVersions to protect the write: refuse.
  if (!validRevision(current.revision)) return { ok: false, reason: `the board read has no usable revision (${JSON.stringify(current.revision)})` };
  if (lastSeen) {
    if (current.boardId !== lastSeen.boardId) return { ok: false, reason: `a different board is published now (${lastSeen.boardId} -> ${current.boardId})` };
    if (current.revision !== lastSeen.revision) return { ok: false, reason: `the board changed between steps (revision ${lastSeen.revision} -> ${current.revision})` };
  }
  if (hosted && !ownWrite && current.selection) return { ok: false, reason: `the owner has chosen option ${current.selection.optionId}; the verifier does not write over it` };
  return { ok: true };
}

/** The board version a write produced, from its receipt (`affected: [{ kind: "board", id, version }]`), or null. */
export const writtenVersion = (receipt, boardId) => receipt?.affected?.find((a) => a.kind === "board" && a.id === boardId)?.version ?? null;

/**
 * After a write, may the next read become the verifier's baseline? Only when it shows exactly the verifier's own
 * write: the same board, at the version the write's receipt reports, in the expected state. Anything else means
 * someone else changed the board in between; the caller then stops (passes `{ refused: reason }` as lastSeen).
 *   before   the board the write was made against
 *   after    the board read after the write
 *   receipt  the write's receipt
 *   expect   (board) => boolean: the state the write should have produced
 */
export function adoptAfterWrite({ before, after, receipt, expect = () => true }) {
  if (!after?.boardId) return { ok: false, reason: "the board could not be read after the verifier's write" };
  if (after.boardId !== before?.boardId) return { ok: false, reason: `a different board is published now (${before?.boardId} -> ${after.boardId})` };
  const version = writtenVersion(receipt, before.boardId);
  if (version === null) return { ok: false, reason: "the write's receipt does not name the board version it produced" };
  if (after.revision !== version) return { ok: false, reason: `the board is at revision ${after.revision}, not ${version} as the verifier's write left it: someone else changed it` };
  if (!expect(after)) return { ok: false, reason: "the board does not show the verifier's write" };
  return { ok: true };
}
