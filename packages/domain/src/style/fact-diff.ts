/**
 * Deriving what a profile edit does to the structured facts that quote it (specification section 6,
 * "Save in My style"). Pure and deterministic: a fact is compared with the edited text only through the
 * passages it quotes verbatim. Nothing here reads meaning out of prose, so nothing here can invent a fact
 * or a resolution; a fact whose passage is gone or reworded is reported for the owner to decide.
 */
import type { PassageRef, StyleFactRef } from "@garderobe/contracts";

/** A structured fact with the passages it quotes. */
export interface AnchoredFact {
  ref: StyleFactRef;
  label: string;
  passages: PassageRef[];
}

/** A changed region: old lines [oldStart, oldEnd) were replaced by new lines [newStart, newEnd); 0-based. */
export interface LineHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

const MAX_LCS_CELLS = 6_000_000;

/** Line-level differences between two texts (longest common subsequence of lines). */
export function lineDiff(oldText: string, newText: string): LineHunk[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  if (n === 0 && m === 0) return [];
  // Very large edits are reported as one changed region rather than aligned line by line.
  if (n === 0 || m === 0 || n * m > MAX_LCS_CELLS) return [{ oldStart: prefix, oldEnd: prefix + n, newStart: prefix, newEnd: prefix + m }];

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[prefix + i] === b[prefix + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  let open: LineHunk | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= { oldStart: prefix + i, oldEnd: prefix + i, newStart: prefix + j, newEnd: prefix + j };
    if (j < m && (i === n || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
      j++;
      open.newEnd = prefix + j;
    } else {
      i++;
      open.oldEnd = prefix + i;
    }
  }
  close();
  return hunks;
}

/** Locate a verbatim quote; null when it does not occur. Line numbers are 1-based and inclusive. */
export function locateQuote(content: string, contentSha256: string, quote: string, section?: string): PassageRef | null {
  const index = content.indexOf(quote);
  if (index === -1) return null;
  const lineStart = content.slice(0, index).split("\n").length;
  const lineEnd = lineStart + quote.split("\n").length - 1;
  return { documentSha256: contentSha256, ...(section ? { section } : {}), lineStart, lineEnd, quote };
}

export interface AffectedFact {
  fact: AnchoredFact;
  reason: "passage_removed" | "passage_changed";
  missingQuotes: string[];
  /** The new wording at the place of the missing passage(s), verbatim; null when the text was only removed. */
  candidateText: string | null;
}

export interface FactDiff {
  /** Facts whose quotes all occurred in the earlier text. */
  anchored: AnchoredFact[];
  /** Anchored facts whose quotes all still occur, with their passages located in the new text. */
  unchanged: { fact: AnchoredFact; passages: PassageRef[] }[];
  /** Anchored facts with at least one quote that no longer occurs verbatim. */
  affected: AffectedFact[];
  /** 1-based inclusive line ranges of the new text that are new or reworded. */
  addedText: { lineStart: number; lineEnd: number }[];
}

const CANDIDATE_LIMIT = 2000;

/**
 * Compare the structured facts with an edited text.
 *  - A fact is considered only if every passage it quotes occurred in the earlier text; a fact already
 *    detached from the prose (or never anchored in it) is not this save's business.
 *  - It is unchanged when every quote still occurs verbatim, wherever it moved to.
 *  - Otherwise it is affected. Whether the owner reworded the place (`passage_changed`, with the new
 *    wording verbatim) or deleted it (`passage_removed`) is read from the line diff, never interpreted.
 */
export function deriveFactDiff(oldContent: string, newContent: string, newSha256: string, facts: AnchoredFact[]): FactDiff {
  const hunks = oldContent === newContent ? [] : lineDiff(oldContent, newContent);
  const newLines = newContent.split("\n");
  const out: FactDiff = { anchored: [], unchanged: [], affected: [], addedText: [] };
  for (const hunk of hunks) if (hunk.newEnd > hunk.newStart) out.addedText.push({ lineStart: hunk.newStart + 1, lineEnd: hunk.newEnd });

  for (const fact of facts) {
    if (fact.passages.length === 0) continue;
    if (!fact.passages.every((p) => oldContent.includes(p.quote))) continue;
    out.anchored.push(fact);
    const relocated = fact.passages.map((p) => locateQuote(newContent, newSha256, p.quote, p.section));
    if (relocated.every((p) => p !== null)) {
      out.unchanged.push({ fact, passages: relocated as PassageRef[] });
      continue;
    }
    const missing = fact.passages.filter((_, i) => relocated[i] === null);
    const replacement: string[] = [];
    const seen = new Set<number>();
    for (const passage of missing) {
      const index = oldContent.indexOf(passage.quote);
      const first = oldContent.slice(0, index).split("\n").length - 1; // 0-based first line of the quote
      const last = first + passage.quote.split("\n").length - 1;
      for (const [h, hunk] of hunks.entries()) {
        const touches = hunk.oldStart <= last && hunk.oldEnd > first;
        if (!touches || seen.has(h) || hunk.newEnd === hunk.newStart) continue;
        seen.add(h);
        replacement.push(newLines.slice(hunk.newStart, hunk.newEnd).join("\n"));
      }
    }
    const candidate = replacement.join("\n").trim();
    out.affected.push({
      fact,
      reason: candidate ? "passage_changed" : "passage_removed",
      missingQuotes: missing.map((p) => p.quote),
      candidateText: candidate ? candidate.slice(0, CANDIDATE_LIMIT) : null,
    });
  }
  return out;
}
