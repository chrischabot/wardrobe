import { expect } from 'vitest';
import type { CommandReceipt, TodayResponse } from '@garderobe/contracts';
import { offered } from './profile.js';

/**
 * The UX contract of spec sections 1, 3 and 13, asserted on what the surfaces actually return:
 * a glanceable board of three to five complete outfits, each piece named, a short reason, section 11
 * order; receipts with a verified summary and Undo; nothing proposed or accepted shown as done; no
 * status questionnaire or confirmation backlog.
 */

/** Phrases that would turn a board, receipt or reply into a status interrogation. */
export const INTERROGATION = /\b(did you (wear|wash)|have you (worn|washed)|please confirm|confirm (whether|that|if)|is (it|this|that) (clean|dirty|in the wash)|which of these did you|still (dirty|in the hamper)\?|mark (as|them) (worn|clean)|missing wear|unconfirmed)\b/i;

const LINE_ORDER = ['jacket', 'jumper', 'shirt', 'trousers', 'belt', 'socks_and_shoes'] as const;

export function expectGlanceableBoard(today: TodayResponse, opts: { min?: number; max?: number; requested?: number } = {}): void {
  const board = today.board;
  expect(board, 'a published board').toBeTruthy();
  expect(board!.status).toBe('published');
  const doc = board!.document!;
  expect(doc, 'the board carries its semantic document').toBeTruthy();
  const options = offered(today);
  const min = opts.min ?? 3;
  const max = opts.max ?? 5;
  if (options.length < min) {
    // Fewer valid outfits than requested is allowed only with one brief explanation outside the outfit copy.
    expect(doc.shortfall, `only ${options.length} options, so a shortfall note is required`).toBeTruthy();
  } else {
    expect(options.length).toBeGreaterThanOrEqual(min);
  }
  expect(options.length).toBeLessThanOrEqual(max);
  if (opts.requested && !doc.shortfall) expect(options.length).toBe(opts.requested);
  // Day line leads, closing on the shape of the day.
  expect(doc.dayLine.trim().length).toBeGreaterThan(10);
  expect(doc.text.startsWith(doc.dayLine)).toBe(true);
  expect(doc.text).not.toMatch(INTERROGATION);
  const shownIds = new Set((today.garments ?? []).map((g) => g.garmentId));
  const positions = new Set<number>();
  for (const o of options) {
    positions.add(o.option.position);
    expect(o.doc, `option ${o.option.optionId} has a document entry`).toBeTruthy();
    // Short reason: one or two sentences opening the option.
    const why = o.doc!.why.trim();
    expect(why.length, `option ${o.option.position} why`).toBeGreaterThan(15);
    expect(why.length, `option ${o.option.position} why is short: ${why}`).toBeLessThanOrEqual(320);
    expect(why.split(/(?<=[.!?])\s+/).filter(Boolean).length).toBeLessThanOrEqual(3);
    // Every piece named with a perceptible name, with display data available.
    for (const s of o.option.slots) {
      expect(shownIds.has(s.garmentId), `display data for ${s.garmentId}`).toBe(true);
      const g = o.doc!.garments.find((x) => x.garmentId === s.garmentId);
      expect(g?.name?.trim().length, `name for ${s.garmentId}`).toBeGreaterThan(2);
    }
    // Section 11 order: jacket, shirt or jumper, trousers, belt with flourish, socks with shoes.
    const kinds = o.doc!.lines.map((l) => l.kind);
    const idx = kinds.map((k) => LINE_ORDER.indexOf(k));
    expect([...idx].sort((a, b) => a - b), `line order ${kinds.join(',')}`).toEqual(idx);
    expect(kinds).toContain('trousers');
    expect(kinds).toContain('socks_and_shoes');
    expect(kinds.some((k) => k === 'shirt' || k === 'jumper')).toBe(true);
    for (const l of o.doc!.lines) expect(l.text.trim().length).toBeGreaterThan(0);
  }
  expect(positions.size, 'distinct positions').toBe(options.length);
}

/** A committed, reversible command: verified summary from trusted code, Undo available, never "accepted". */
export function expectDoneReceipt(r: CommandReceipt, opts: { undo?: boolean } = {}): void {
  expect(['committed', 'merged'], `${r.commandType} outcome`).toContain(r.outcome);
  expect(r.commandId).toMatch(/^cmd_/);
  expect(r.summary.trim().length, 'receipt summary').toBeGreaterThan(5);
  expect(r.summary).not.toMatch(INTERROGATION);
  expect(r.error).toBeNull();
  if (opts.undo !== false) expect(r.undo.available, `${r.commandType} offers Undo`).toBe(true);
}

/** Anything not committed or merged must never read as done. */
export function expectNotDone(r: CommandReceipt): void {
  expect(['committed', 'merged']).not.toContain(r.outcome);
  expect(r.error, 'a not-done receipt says why').toBeTruthy();
}
