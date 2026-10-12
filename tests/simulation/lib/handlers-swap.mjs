/**
 * Step handler: a swap on tomorrow's board (board.swap_slot) and its undo, once a week, so the swap-undo path
 * is covered by every run.
 */
import { checkOptions } from "./invariants.mjs";
import { byDraw } from "./rng.mjs";
import { stableJson } from "./sim.mjs";

/** The board's offered outfits by garment identity: what an undo of a swap must bring back exactly. */
export const boardShape = (board) =>
  stableJson(
    [...(board?.options ?? [])]
      .sort((a, b) => a.number - b.number)
      .map((o) => ({ optionId: o.optionId, garments: o.garments.map((g) => `${g.role}:${g.garmentId}`).sort(), alternatives: (o.footwearAlternatives ?? []).map((g) => g.garmentId).sort(), flourish: o.flourish ? `${o.flourish.role}:${o.flourish.garmentId}` : null })),
  );

/** Board revisions the product's background work may publish on its own between the swap and the read-back. */
export const BACKGROUND_REVISION_REASONS = new Set(["replenish", "refresh"]);

/**
 * Does the swap's receipt name the revision the swap made? The receipt must name this board at a version
 * past the one before the swap. The board read back afterwards is at exactly that version, or at a later one
 * only when the latest revision is the product's own background top-up (replenish) or refresh: after a swap
 * the API replenishes in the background (`waitUntil`), which can publish before the read-back. Any other
 * later revision (another swap, a repair, a rebuild, an owner change) fails.
 */
export function swapRevisionVerdict(receipt, boardId, revisionBefore, readBack) {
  const named = (receipt?.affected ?? []).filter((a) => a.kind === "board" && a.id === boardId).map((a) => a.version);
  if (named.length !== 1) return { ok: false, why: `the swap's receipt names board ${boardId} ${named.length} times (${JSON.stringify(receipt?.affected ?? [])})` };
  const version = named[0];
  if (!(Number.isInteger(version) && version > revisionBefore)) return { ok: false, why: `the swap's receipt names board version ${version}; the board was at ${revisionBefore} before the swap` };
  if (!readBack) return { ok: false, why: `the board could not be read back after the swap (receipt names version ${version})` };
  if (readBack.revision === version) return { ok: true, why: `the receipt names version ${version}, the board read back at ${version}` };
  if (readBack.revision > version && BACKGROUND_REVISION_REASONS.has(readBack.reason)) return { ok: true, why: `the receipt names version ${version}; the board read back at ${readBack.revision}, a later ${readBack.reason} revision` };
  return { ok: false, why: `the swap's receipt names board version ${version}; the board read back at ${readBack.revision} with reason ${readBack.reason ?? "none"}, which is not the swap's revision nor a later replenish or refresh` };
}

/**
 * The evening before, he swaps one piece of an option on tomorrow's board and then takes the swap back.
 * Both apply at once from the connected assistant (the 2026-10-05 contract). Only an unchosen option is
 * swapped (with none, the step does not apply). The swap's receipt offers an
 * undo, and the swap makes a newer board revision with that slot changed and the choice untouched. Before the undo, the replacement
 * must be a garment of that role by its recorded roles, and the swapped option must pass every offer check
 * against tomorrow's wardrobe (owned, available, unrestricted). The undo's receipt then names the board at a
 * revision exactly one past the swap's, every option is as it was before the swap (garments, footwear
 * alternatives and flourish), the choice is untouched, and the undo itself cannot be undone. A day's swap
 * may be not applicable; the runner requires at least one accepted swap and undo per run.
 */
export async function swapAndUndo(sim, step) {
  const id = "swap.undo_restores_the_board";
  const tomorrowIndex = step.day + 1;
  if (tomorrowIndex >= sim.plan.dayCount) return sim.notApplicable(id, "no day after the last one");
  const tomorrow = sim.plan.days[tomorrowIndex];
  if (tomorrow.circumstance === "paused" || tomorrow.circumstance === "trip" || sim.pause?.active) return sim.notApplicable(id, `no home board for ${tomorrow.date} (${sim.pause?.active ? "paused" : tomorrow.circumstance})`);
  const before = (await sim.todayBoard(tomorrow.date)).board;
  if (!before || before.options.length === 0) return sim.notApplicable(id, `no option on the board of ${tomorrow.date} to swap in`);
  const options = [...before.options].sort((a, b) => a.number - b.number);
  // Only an option he has not chosen, so the swap never touches his plan.
  const unchosen = options.filter((o) => o.optionId !== before.selection?.optionId);
  if (unchosen.length === 0) return sim.notApplicable(id, `every option on the board of ${tomorrow.date} is the chosen one; nothing unchosen to swap in`);
  const option = byDraw(unchosen, tomorrow.pieceDraw);
  const role = ["top", "bottom"].find((r) => option.garments.some((g) => g.role === r)) ?? option.garments[0]?.role;
  if (!role) return sim.notApplicable(id, `option ${option.number} of ${tomorrow.date} has no piece to swap`);
  const previous = option.garments.find((g) => g.role === role);
  const evidence = { date: tomorrow.date, boardId: before.boardId, optionId: option.optionId, role, previous: previous?.name ?? null, revisionBefore: before.revision };

  const swap = await sim.command("board.swap_slot", { boardId: before.boardId, optionId: option.optionId, role }, { expectedVersions: { [`board:${before.boardId}`]: before.revision }, label: "swapped one piece of tomorrow's option" });
  sim.count("swaps on tomorrow's board");
  if (!swap.receipt) {
    // No other wearable piece for that slot is a domain answer, not a defect; anything else is.
    if (swap.error?.code === "precondition_failed") return sim.notApplicable(id, `no replacement for the ${role} of option ${option.number} on ${tomorrow.date}: ${swap.error.message}`);
    return sim.check("swap.accepted", false, `the swap on the board of ${tomorrow.date} was refused: ${swap.error?.code} ${swap.error?.message}`, { ...evidence, error: swap.error });
  }
  sim.check("swap.accepted", true);
  sim.check("swap.runs_without_a_tap", swap.route === "direct", `board.swap_slot took the route ${swap.route}`, { ...evidence, commandId: swap.receipt.commandId });
  sim.check("swap.receipt_offers_an_undo", swap.receipt.undo?.available === true, `the swap's receipt says undo ${JSON.stringify(swap.receipt.undo ?? null)}`, { ...evidence, commandId: swap.receipt.commandId });
  const swapped = (await sim.todayBoard(tomorrow.date)).board;
  const swappedOption = swapped?.options.find((o) => o.optionId === option.optionId);
  const now = swappedOption?.garments.find((g) => g.role === role);
  const swapEvidence = { ...evidence, commandId: swap.receipt.commandId, revisionSwapped: swapped?.revision ?? null, now: now?.name ?? null };
  sim.check("swap.makes_a_new_board_revision", Boolean(swapped) && swapped.revision > before.revision, `after the swap the board of ${tomorrow.date} is at revision ${swapped?.revision ?? "none"} (was ${before.revision})`, swapEvidence);
  sim.check("swap.changes_the_slot", Boolean(now) && now.garmentId !== previous?.garmentId, `after the swap the ${role} of option ${option.number} is ${now?.name ?? "empty"} (was ${previous?.name ?? "empty"})`, swapEvidence);
  sim.check("swap.keeps_the_choice", (swapped?.selection?.optionId ?? null) === (before.selection?.optionId ?? null), `the choice for ${tomorrow.date} was ${before.selection?.optionId ?? "none"}; right after swapping an unchosen option it is ${swapped?.selection?.optionId ?? "none"}`, swapEvidence);
  const revisionVerdict = swapRevisionVerdict(swap.receipt, before.boardId, before.revision, swapped);
  sim.check("swap.receipt_names_the_new_revision", revisionVerdict.ok, revisionVerdict.why, { ...swapEvidence, affected: swap.receipt.affected, reasonReadBack: swapped?.reason ?? null });
  if (!swapped || !swappedOption) return sim.check(id, false, `after the swap the board of ${tomorrow.date} no longer offers option ${option.number}`, swapEvidence);
  // The replacement is checked before the undo takes it away.
  const post = await sim.snapshot(tomorrow.date);
  const item = now ? post.byId.get(now.garmentId) : null;
  sim.check("swap.replacement_is_a_garment_of_that_role", Boolean(item) && item.garment.name === now.name && (item.garment.roles ?? []).includes(role), `the swap put ${now?.name ?? "nothing"} in the ${role} slot; the wardrobe records it as ${item ? `${item.garment.name} with roles ${(item.garment.roles ?? []).join(", ")}` : "no garment"}`, swapEvidence);
  checkOptions(sim, post, [swappedOption], { date: tomorrow.date, source: `swapped board revision ${swapped.revision}`, freshness: swapped.freshness ?? null });

  const undo = await sim.command("command.undo", { commandId: swap.receipt.commandId, reason: "SIMULATED: he prefers the piece he had" }, { label: "the swap is undone" });
  if (!undo.receipt) return sim.check(id, false, `the undo of the swap on ${tomorrow.date} was refused: ${undo.error?.code} ${undo.error?.message}`, { ...swapEvidence, error: undo.error });
  const after = (await sim.todayBoard(tomorrow.date)).board;
  const undoEvidence = { ...swapEvidence, undoCommandId: undo.receipt.commandId, undoSummary: undo.receipt.summary, revisionAfterUndo: after?.revision ?? null };
  sim.check("swap.undo_runs_without_a_tap", undo.route === "direct", `command.undo of a swap took the route ${undo.route}`, undoEvidence);
  sim.check("swap.undo_makes_the_next_revision", Boolean(after) && after.revision === swapped.revision + 1, `after the undo the board of ${tomorrow.date} is at revision ${after?.revision ?? "none"}; the swap left it at ${swapped.revision}`, undoEvidence);
  sim.check("swap.undo_receipt_names_the_board", undo.receipt.type === "command.undo" && undo.receipt.outcome === "committed" && undo.receipt.affected.some((a) => a.kind === "board" && a.id === before.boardId && a.version === after?.revision) && undo.receipt.undo?.available === false, `the undo's receipt: type ${undo.receipt.type}, outcome ${undo.receipt.outcome}, affected ${JSON.stringify(undo.receipt.affected)}, undo ${JSON.stringify(undo.receipt.undo ?? null)}`, undoEvidence);
  sim.check(id, Boolean(after) && boardShape(after) === boardShape(before), `after the undo the outfits of ${tomorrow.date} differ from those before the swap`, { ...undoEvidence, before: boardShape(before), after: boardShape(after) });
  sim.check("swap.undo_keeps_the_choice", (after?.selection?.optionId ?? null) === (before.selection?.optionId ?? null), `the choice for ${tomorrow.date} was ${before.selection?.optionId ?? "none"}; after the swap and its undo it is ${after?.selection?.optionId ?? "none"}`, undoEvidence);
  sim.count("swaps undone");
  sim.swapsUndone = (sim.swapsUndone ?? 0) + 1;
  sim.trace.push(["swap_and_undo", tomorrow.date, role, previous?.name ?? null, now?.name ?? null]);
}
