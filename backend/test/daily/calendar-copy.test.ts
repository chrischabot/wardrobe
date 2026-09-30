import { describe, expect, it } from 'vitest';
import { managedBlockOf } from '../../src/calendar/projection.js';
import type { ScoredOption } from '../../src/recommend/compose.js';
import type { MandatoryContext } from '../../src/recommend/context.js';
import { checkProse, dayLineOf, maskStandaloneCodes, searchOnlyPhraseIn, whySentence, type ProseWriter } from '../../src/recommend/document.js';
import type { WardrobeGarment } from '../../src/recommend/garments.js';
import { managedEventId } from '../../src/recommend/publish.js';
import type { WeatherScenarioName } from '../../src/weather/fake.js';
import { ownerScenario, type Scenario } from '../helpers/daily.js';

/**
 * Calendar and board copy never carries a maker code or a search-only name (spec: no item codes in
 * Calendar text; search names are for finding a garment, not for showing it). Boards carry each
 * garment's aliases for the app's search; the managed event's title and description, which is also what
 * the event's notification shows, use display names only. Garderobe sends no other notification text.
 *
 * The oracle below is the rule itself, with no length, digit or word-count exclusions: every registered
 * maker code (whole token, any case) and every alias that is not the garment's own display or short name
 * (whole phrase, any case) is a leak, except where it lies inside the display name, short name or
 * recorded fabric of a piece the text is about. Runs use the owner's full 144-garment wardrobe.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortOf = (name: string) => name.split(/\s+[—–-]\s+/)[0]!.trim();
const norm = (s: string) => s.trim().toLowerCase();

function spans(text: string, phrase: string, whole: boolean): [number, number][] {
  const p = phrase.trim();
  if (!p) return [];
  const re = whole ? new RegExp(`(?<![\\p{L}\\p{N}])${esc(p)}(?![\\p{L}\\p{N}])`, 'giu') : new RegExp(esc(p), 'giu');
  return [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]);
}

/** A garment's search-only aliases: every alias that is not its own display name or short name. */
const searchOnly = (g: WardrobeGarment) => g.aliases.filter((a) => norm(a) !== norm(g.name) && norm(a) !== norm(shortOf(g.name)));

/**
 * Oracle: every maker code and search-only alias in `text` outside the wording of `pieces`. A code is
 * allowed only inside a piece's display or short name; an alias also inside its recorded fabric.
 */
function leaks(text: string, ctx: MandatoryContext, pieces: Iterable<string> = []): string[] {
  const names: [number, number][] = [];
  const wording: [number, number][] = [];
  for (const id of pieces) {
    const g = ctx.byId.get(id)!;
    for (const p of [g.name, shortOf(g.name)]) names.push(...spans(text, p, false));
    for (const p of [g.fabric ?? '', (g.fabric ?? '').replace(/\(.*?\)/g, '')]) wording.push(...spans(text, p, false));
  }
  wording.push(...names);
  const outsideOf = (allowed: [number, number][]) => (found: [number, number][]) => found.some(([a, b]) => !allowed.some(([x, y]) => x <= a && b <= y));
  const codeOut = outsideOf(names);
  const aliasOut = outsideOf(wording);
  const found: string[] = [];
  for (const g of ctx.wardrobe) {
    for (const c of g.makerCodes) if (codeOut(spans(text, c, true))) found.push(`code ${c}`);
    for (const a of searchOnly(g)) if (aliasOut(spans(text, a, true))) found.push(`search name "${a}" (${g.name})`);
  }
  return found;
}

const pieceIds = (o: ScoredOption) => o.slots.map((s) => s.garmentId);
const insideOwnWording = (g: WardrobeGarment, phrase: string) => [g.name, shortOf(g.name), g.fabric ?? ''].some((w) => norm(w).includes(norm(phrase)));

const DAYS: { date: string; scenario: WeatherScenarioName }[] = [
  { date: '2026-10-06', scenario: 'mild' },
  { date: '2026-10-07', scenario: 'coldSnap' },
  { date: '2026-10-08', scenario: 'heavyRain' },
  { date: '2026-10-09', scenario: 'jacketBand' },
];

/** A later-added shirt with an all-letter product code, a two-character code and a short, two-word search name. */
async function addOchreShirt(s: Scenario): Promise<string> {
  const r = await s.cmd({
    type: 'add_item',
    explicit: true,
    name: 'Lightweight oxford — ochre',
    category: 'shirt',
    roles: ['base_top'],
    color: 'Ochre',
    acquisition: 'owned',
    productCode: 'ABCDEF',
    aliases: [{ phrase: 'Summer Oxford', kind: 'owner_phrase' }, { phrase: 'QX', kind: 'maker_code' }, { phrase: 'AB-20931', kind: 'maker_code' }],
    attributes: { fabricClass: 'lightweight_oxford' },
  });
  return r.facts.garmentId as string;
}

describe('Calendar and board copy: no maker codes or search-only names', () => {
  it('the owner’s 144-garment wardrobe has codes and search-only names to leak, many of them short everyday phrases', async () => {
    const s = await ownerScenario({ withAdditions: true });
    const ctx = await s.rec.context({ date: '2026-10-06' });
    expect(ctx.wardrobe).toHaveLength(144);
    expect(ctx.wardrobe.flatMap((g) => g.makerCodes).length).toBeGreaterThan(30);
    const aliases = ctx.wardrobe.flatMap(searchOnly);
    expect(aliases.length).toBeGreaterThan(150);
    expect(aliases).toEqual(expect.arrayContaining(['Cashmere', 'Overcoat', 'Harris Tweed', 'Woven belt', 'Washed Blue Lightweight Oxford PCF4339']));
    expect(aliases.filter((a) => a.trim().split(/\s+/).length <= 2).length).toBeGreaterThan(10);
  });

  it('every registered maker code is refused as a whole token in any case, including all-letter and short codes', async () => {
    const s = await ownerScenario({ withAdditions: true });
    const ochre = await addOchreShirt(s);
    const { context: ctx, composed } = await s.rec.compose({ date: '2026-10-06', include: [ochre] });
    const o = composed.options.find((x) => pieceIds(x).includes(ochre))!;
    expect(o).toBeTruthy();
    const codes = ctx.wardrobe.flatMap((g) => g.makerCodes);
    expect(codes).toEqual(expect.arrayContaining(['ABCDEF', 'QX', 'AB-20931', 'PCF4339']));
    for (const code of codes) {
      for (const form of [code, code.toLowerCase()]) {
        const text = `The ${form} cloth gives this outfit its interest today.`;
        expect(checkProse(text, null, ctx), text).toBe('item code or internal ID');
        expect(checkProse(text, o, ctx), text).toBe('item code or internal ID');
        expect(leaks(text, ctx, pieceIds(o)), text).not.toEqual([]);
      }
    }
    // Whole tokens only: a longer word that merely contains a code is not the code.
    expect(checkProse('The ABCDEFGH weave is not a code of this wardrobe at all.', null, ctx)).toBeNull();
    expect(checkProse('An equal quantity of texture top and bottom keeps it calm.', null, ctx)).toBeNull();
  });

  it('a maker code that equals a word of a piece’s recorded fabric is still refused; only the piece’s own name exempts it', async () => {
    const s = await ownerScenario({ withAdditions: true, weather: { scenario: 'coldSnap' } });
    // A later-added jumper whose registered maker code is the plain word "CASHMERE".
    await s.cmd({ type: 'add_item', explicit: true, name: 'Shetland crew — heather', category: 'knitwear', roles: ['mid_layer'], color: 'Heather', acquisition: 'owned', productCode: 'CASHMERE', attributes: {} });
    const scarf = await s.byName('Joseph Turner cashmere scarf');
    const { context: ctx, composed } = await s.rec.compose({ date: '2026-10-07', include: [scarf] });
    expect(ctx.byId.get(scarf)!.fabric).toMatch(/^cashmere$/i);
    const o = [...composed.options, ...composed.reserves].find((x) => pieceIds(x).includes(scarf))!;
    expect(o, 'an outfit that wears the cashmere scarf').toBeTruthy();
    // Standalone, in any case: refused, even though the outfit's scarf records "cashmere" as its fabric.
    for (const text of ['CASHMERE at the neck lifts the whole outfit today.', 'Cashmere at the neck lifts the whole outfit today.', 'A soft cashmere note at the neck, and the socks answer it.']) {
      expect(checkProse(text, o, ctx), text).toBe('item code or internal ID');
      expect(leaks(text, ctx, pieceIds(o)), text).toContain('code CASHMERE');
    }
    // Inside the piece's own display name it is the name the owner sees, and stays allowed.
    const named = 'The Joseph Turner cashmere scarf lifts the whole outfit today.';
    expect(checkProse(named, o, ctx), named).toBeNull();
    expect(leaks(named, ctx, pieceIds(o))).toEqual([]);
  });

  it('the deterministic fallback never quotes a registered code, even when a code equals a fabric it would quote (board and Calendar copy)', async () => {
    // Every model sentence is refused (it carries a code), so each option falls back to the deterministic text.
    const refuse: ProseWriter = { name: 'refused-model', write: async (input) => ({ why: Object.fromEntries(input.options.map((o) => [o.optionId, 'Wear the PCF4339 cloth today, and the socks answer it.'])) }) };
    const s = await ownerScenario({ withAdditions: true, weather: { scenario: 'coldSnap' }, deps: { prose: refuse } });
    // A later-added jumper whose registered code is the word "CASHMERE"; the cord jacket records "6-wale cotton/cashmere cord".
    await s.cmd({ type: 'add_item', explicit: true, name: 'Shetland crew — heather', category: 'knitwear', roles: ['mid_layer'], color: 'Heather', acquisition: 'owned', productCode: 'CASHMERE', attributes: {} });
    const cord = await s.byName('PWVC Cashmere Cord Bark');
    let quotedFabricPieces = 0;
    for (let i = 0; i < 6; i++) {
      const date = `2026-10-${String(6 + i).padStart(2, '0')}`;
      const out = await s.rec.composeAndPublish({ date, include: [cord], seed: `fallback-${i}` });
      expect(out.published, date).toBe(true);
      const ctx = out.context!;
      expect(ctx.byId.get(cord)!.fabric).toMatch(/\bcashmere\b/i);
      const doc = out.board!.document!;
      expect(doc.prose, date).toBe('deterministic');
      for (const o of out.composed!.options) {
        const p = o.validation.parts;
        if (o.devices.includes('texture') && [p.outer, p.top, p.bottom].some((g) => g && /\bcashmere\b/i.test(g.fabric ?? ''))) quotedFabricPieces++;
      }
      for (const o of doc.options) expect(leaks(o.why, ctx, o.garments.map((g) => g.garmentId)), `${date}: ${o.why}`).not.toContain('code CASHMERE');
      expect((await s.daily.projector.projectDay(date)).status).toBe('projected');
      const ev = s.calendar.managed.get(await managedEventId(s.userId, date))!;
      const onBoard = out.board!.options.flatMap((o) => o.slots.map((x) => x.garmentId));
      // Calendar copy: outside the display names of the pieces on the board, the code never stands alone.
      expect(leaks(`${ev.summary}\n${ev.description}`, ctx, onBoard), `${date} Calendar`).not.toContain('code CASHMERE');
      expect(leaks(doc.text, ctx, onBoard), `${date} board text`).not.toContain('code CASHMERE');
    }
    // The scenario really exercises the fabric the fallback would quote.
    expect(quotedFabricPieces).toBeGreaterThan(0);
  }, 120_000);

  it('the assembled fallback sentence never holds a code equal to a template word (THE, WITH, AND), in the board or the Calendar event', async () => {
    const refuse: ProseWriter = { name: 'refused-model', write: async (input) => ({ why: Object.fromEntries(input.options.map((o) => [o.optionId, 'Wear the PCF4339 cloth today, and the socks answer it.'])) }) };
    const s = await ownerScenario({ withAdditions: true, deps: { prose: refuse } });
    await s.cmd({ type: 'add_item', explicit: true, name: 'Shetland crew — heather', category: 'knitwear', roles: ['mid_layer'], color: 'Heather', acquisition: 'owned', productCode: 'THE', aliases: [{ phrase: 'WITH', kind: 'maker_code' }, { phrase: 'AND', kind: 'maker_code' }], attributes: {} });
    for (const [i, scenario] of (['mild', 'coldSnap', 'heavyRain'] as WeatherScenarioName[]).entries()) {
      s.weather.set({ scenario });
      const date = `2026-10-${String(6 + i).padStart(2, '0')}`;
      const out = await s.rec.composeAndPublish({ date, seed: `template-${i}` });
      expect(out.published, date).toBe(true);
      const ctx = out.context!;
      const doc = out.board!.document!;
      expect(doc.prose).toBe('deterministic');
      for (const code of ['THE', 'WITH', 'AND']) expect(ctx.wardrobe.some((g) => g.makerCodes.includes(code))).toBe(true);
      await s.daily.projector.projectDay(date);
      const ev = s.calendar.managed.get(await managedEventId(s.userId, date))!;
      for (const o of doc.options) {
        // Every sentence the board publishes, checked as the final assembled text.
        const found = leaks(o.why, ctx, o.garments.map((g) => g.garmentId)).filter((x) => /^code (THE|WITH|AND)$/.test(x));
        expect(found, `${date}: ${o.why}`).toEqual([]);
        expect(o.why.trim().length).toBeGreaterThan(0);
        // The same sentence is what the board text and the Calendar event carry.
        if (o.status === 'offerable') {
          expect(doc.text).toContain(o.why);
          expect(ev.description).toContain(o.why);
        }
      }
    }
  }, 120_000);

  it('the complete published board and Calendar documents never hold a code equal to a label or template word (AND, THE, WITH, OR, OPEN)', async () => {
    const refuse: ProseWriter = { name: 'refused-model', write: async (input) => ({ why: Object.fromEntries(input.options.map((o) => [o.optionId, 'Wear the PCF4339 cloth today, and the socks answer it.'])) }) };
    const s = await ownerScenario({ withAdditions: true, deps: { prose: refuse } });
    const words = ['AND', 'THE', 'WITH', 'OR', 'OPEN'];
    await s.cmd({ type: 'add_item', explicit: true, name: 'Shetland crew — heather', category: 'knitwear', roles: ['mid_layer'], color: 'Heather', acquisition: 'owned', productCode: 'AND', aliases: words.slice(1).map((phrase) => ({ phrase, kind: 'maker_code' as const })), attributes: {} });
    const noUrl = (t: string) => t.replace(/https?:\/\/\S+/g, ' ');
    for (const [i, scenario] of (['mild', 'coldSnap', 'heavyRain'] as WeatherScenarioName[]).entries()) {
      s.weather.set({ scenario });
      const date = `2026-10-${String(6 + i).padStart(2, '0')}`;
      const out = await s.rec.composeAndPublish({ date, seed: `labels-${i}` });
      expect(out.published, date).toBe(true);
      const ctx = out.context!;
      for (const w of words) expect(ctx.wardrobe.some((g) => g.makerCodes.includes(w))).toBe(true);
      const board = out.board!;
      const doc = board.document!;
      const onBoard = board.options.flatMap((o) => o.slots.map((x) => x.garmentId));
      // Choose one so the Calendar block carries its "chosen" line as well.
      await s.cmd({ type: 'select_option', boardId: board.boardId, optionId: board.options[0]!.optionId });
      await s.daily.processEffects();
      await s.daily.projector.projectDay(date);
      const ev = s.calendar.managed.get(await managedEventId(s.userId, date))!;
      // Every piece of published copy: the rendered board text, each field the app and web board show, and the Calendar event.
      const copy: [string, string][] = [
        ['board text', doc.text],
        ['day line', doc.dayLine],
        ['weather line', doc.weather.line],
        ['suitability note', doc.suitabilityNote ?? ''],
        ['shortfall', doc.shortfall ?? ''],
        ...doc.options.flatMap((o) => [[`why ${o.position}`, o.why], ...o.lines.flatMap((l) => [[`label ${o.position}`, l.label], [`line ${o.position}`, l.text], [`flourish ${o.position}`, l.flourish?.text ?? '']])] as [string, string][]),
        ['Calendar title', ev.summary],
        ['Calendar description', noUrl(ev.description)],
      ];
      for (const [where, text] of copy) {
        const found = leaks(text, ctx, onBoard).filter((x) => words.some((w) => x === `code ${w}`));
        expect(found, `${date} ${where}: ${text.slice(0, 200)}`).toEqual([]);
      }
      // The copy is still there to read: every option keeps its lines and the event its title and board text.
      expect(ev.summary.trim().length).toBeGreaterThan(0);
      for (const o of doc.options) expect(o.lines.length).toBeGreaterThanOrEqual(4);
    }
  }, 120_000);

  it('the final guard leaves copy without codes untouched, keeps piece names and links, and substitutes colliding words readably', () => {
    const text = 'Tuesday: rain after 16:00.\n\n1. The oxford with the chinos.\n\nSocks and shoes: Merino — fire red with NB 990v4 — grey\n    optional tie: Silk knit tie — rust\n\nOpen the board: https://garderobe.invalid/b/brd_and_the';
    const names = ['Merino — fire red', 'NB 990v4 — grey', 'Silk knit tie — rust'];
    expect(maskStandaloneCodes(text, ['PCF4339', 'XK77Q'], names)).toBe(text);
    const masked = maskStandaloneCodes(text, ['AND', 'THE', 'WITH', 'OPEN', 'RUST'], names);
    expect(masked).toContain('Socks & shoes: Merino — fire red + NB 990v4 — grey');
    expect(masked).toContain('1. Oxford + chinos.');
    expect(masked).toContain('optional tie: Silk knit tie — rust');
    expect(masked).toContain('· board: https://garderobe.invalid/b/brd_and_the');
    expect(masked.replace(/https?:\/\/\S+/g, '')).not.toMatch(/(?<![\p{L}\p{N}])(and|the|with|open)(?![\p{L}\p{N}])/iu);
  });

  it('every search-only name is refused, including short ones like "Summer Oxford", "Cashmere" and "Harris Tweed"', async () => {
    const s = await ownerScenario({ withAdditions: true });
    const ochre = await addOchreShirt(s);
    const { context: ctx, composed } = await s.rec.compose({ date: '2026-10-06', include: [ochre] });
    let checked = 0;
    for (const g of ctx.wardrobe) {
      for (const a of searchOnly(g)) {
        const text = `Today it is all about the ${a}, worn easily.`;
        expect(checkProse(text, null, ctx), text).toMatch(/search name|item code/);
        expect(leaks(text, ctx), text).not.toEqual([]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(150);
    // In an outfit that wears the garment, its search-only names are still refused.
    const o = composed.options.find((x) => pieceIds(x).includes(ochre))!;
    expect(checkProse('The Summer Oxford warms the grey trousers and the socks answer it.', o, ctx)).toMatch(/search name/);
    expect(checkProse('The summer oxford warms the grey trousers and the socks answer it.', o, ctx)).toMatch(/search name/);
    for (const opt of composed.options) {
      for (const id of pieceIds(opt)) {
        const g = ctx.byId.get(id)!;
        for (const a of searchOnly(g).filter((x) => !insideOwnWording(g, x))) {
          const text = `The ${a} is the anchor here, and the socks answer it.`;
          expect(checkProse(text, opt, ctx), `${text} (${g.name})`).toMatch(/search name|item code/);
        }
      }
    }
  });

  it('display names and short names of the outfit’s own pieces stay allowed', async () => {
    const s = await ownerScenario({ withAdditions: true });
    const ochre = await addOchreShirt(s);
    const { context: ctx, composed } = await s.rec.compose({ date: '2026-10-06', include: [ochre] });
    const o = composed.options.find((x) => pieceIds(x).includes(ochre))!;
    expect(checkProse('The Lightweight oxford — ochre warms the grey trousers today.', o, ctx)).toBeNull();
    expect(checkProse('The lightweight oxford keeps the collar soft today.', o, ctx)).toBeNull();
    let checked = 0;
    for (const scenario of ['mild', 'coldSnap', 'heavyRain', 'heat'] as WeatherScenarioName[]) {
      s.weather.set({ scenario });
      for (let i = 0; i < 4; i++) {
        const { context, composed: c } = await s.rec.compose({ date: '2026-10-06', seed: `names-${scenario}-${i}` });
        for (const opt of [...c.options, ...c.reserves]) {
          for (const id of pieceIds(opt)) {
            const name = context.byId.get(id)!.name;
            for (const n of new Set([name, shortOf(name)])) {
              const text = `The ${n} carries the outfit today.`;
              expect(checkProse(text, opt, context), text).toBeNull();
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
  }, 120_000);

  it('over 64 seeded real-wardrobe boards the deterministic copy is never refused, and model prose using search names or codes always is', async () => {
    const scenarios: WeatherScenarioName[] = ['mild', 'coldSnap', 'heavyRain', 'jacketBand', 'heat', 'elevenToNineteen', 'strongWind', 'warmDayCoolEvening'];
    type Kind = 'display' | 'short' | 'alias' | 'code';
    const kinds: Kind[] = ['display', 'short', 'alias', 'code'];
    let ctx: MandatoryContext | null = null;
    let board = 0;
    const sent = new Map<string, { kind: Kind; text: string }>();
    const writer: ProseWriter = {
      name: 'search-name-model',
      write: async (input) => {
        sent.clear();
        const why: Record<string, string> = {};
        input.options.forEach((o, n) => {
          const pieces = o.garments.map((x) => ctx!.wardrobe.find((w) => w.name === x.name)!);
          const top = pieces[o.garments.findIndex((x) => x.role === 'base_top')]!;
          let kind = kinds[(board + n) % 4]!;
          const alias = pieces.flatMap((g) => searchOnly(g).filter((a) => !insideOwnWording(g, a)))[0];
          const code = pieces.flatMap((g) => g.makerCodes)[0];
          if (kind === 'code' && !code) kind = 'alias';
          if (kind === 'alias' && !alias) kind = 'display';
          const phrase = kind === 'display' ? top.name : kind === 'short' ? shortOf(top.name) : kind === 'alias' ? alias! : code!;
          const text = `The ${phrase} is the anchor here, and the socks answer it.`;
          why[o.optionId] = text;
          sent.set(o.optionId, { kind, text });
        });
        return { why };
      },
    };
    const s = await ownerScenario({ withAdditions: true, deps: { prose: writer } });
    const tally = { boards: 0, boardsWithRefusal: 0, refused: { display: 0, short: 0, alias: 0, code: 0 }, sent: { display: 0, short: 0, alias: 0, code: 0 }, deterministicChecked: 0 };
    for (const scenario of scenarios) {
      s.weather.set({ scenario });
      for (let i = 0; i < 8; i++, board++) {
        ctx = await s.rec.context({ date: '2026-10-06' });
        const out = await s.rec.composeAndPublish({ date: '2026-10-06', seed: `refusals-${scenario}-${i}` });
        expect(out.published).toBe(true);
        const context = out.context!;
        // The deterministic fallback copy is never itself refused: day line, every sentence, every option block.
        expect(searchOnlyPhraseIn(dayLineOf(context), null, context)).toBeNull();
        for (const o of [...out.composed!.options, ...out.composed!.reserves]) {
          const w = whySentence(o, context);
          expect(checkProse(w, o, context), w).toBeNull();
          expect(leaks(w, context, pieceIds(o)), w).toEqual([]);
          tally.deterministicChecked++;
        }
        for (const d of out.board!.document!.options) {
          const block = d.lines.map((l) => `${l.label}: ${l.text}${l.flourish ? ` optional ${l.flourish.kind}: ${l.flourish.text}` : ''}`).join('\n');
          expect(leaks(block, context, d.garments.map((g) => g.garmentId)), block).toEqual([]);
        }
        // Model sentences: names are used, search names and codes fall back to the deterministic sentence.
        let refusedHere = false;
        for (const d of out.board!.document!.options) {
          const m = sent.get(d.optionId)!;
          tally.sent[m.kind]++;
          const used = d.why === m.text;
          if (!used) {
            tally.refused[m.kind]++;
            refusedHere = true;
          }
          expect(used, `${m.kind}: ${m.text}`).toBe(m.kind === 'display' || m.kind === 'short');
          expect(leaks(d.why, context, d.garments.map((g) => g.garmentId)), d.why).toEqual([]);
        }
        tally.boards++;
        if (refusedHere) tally.boardsWithRefusal++;
      }
    }
    console.log(`[calendar-copy] refusal tally over the 144-garment wardrobe: ${JSON.stringify(tally)}`);
    expect(tally.boards).toBe(64);
    expect(tally.refused.display + tally.refused.short).toBe(0);
    expect(tally.refused.alias).toBe(tally.sent.alias);
    expect(tally.refused.code).toBe(tally.sent.code);
    expect(tally.sent.alias).toBeGreaterThan(20);
    expect(tally.sent.code).toBeGreaterThan(20);
  }, 300_000);

  it('the Calendar event title and description carry no code or search-only name across weather, seeds and a selection', async () => {
    const s = await ownerScenario({ withAdditions: true });
    for (const day of DAYS) {
      s.weather.set({ scenario: day.scenario });
      const out = await s.rec.composeAndPublish({ date: day.date, seed: `copy-${day.scenario}` });
      expect(out.published, day.date).toBe(true);
      // The board document itself carries search names for the app; the Calendar copy must not.
      expect(out.board!.document!.options.some((o) => o.garments.some((g) => (g.aliases ?? []).length > 0))).toBe(true);
      expect((await s.daily.projector.projectDay(day.date)).status).toBe('projected');
      const ev = s.calendar.managed.get(await managedEventId(s.userId, day.date))!;
      const ctx = await s.rec.context({ date: day.date });
      const onBoard = out.board!.options.flatMap((o) => o.slots.map((x) => x.garmentId));
      expect(leaks(ev.summary, ctx), `${day.date} title`).toEqual([]);
      expect(leaks(ev.description, ctx, onBoard), `${day.date} description`).toEqual([]);
      expect(managedBlockOf(ev.description)).toContain('Socks and shoes:');
    }
    const board = (await s.rec.composeAndPublish({ date: DAYS[0]!.date })).board!;
    await s.cmd({ type: 'select_option', boardId: board.boardId, optionId: board.options[0]!.optionId });
    await s.daily.processEffects();
    const ev = s.calendar.managed.get(await managedEventId(s.userId, DAYS[0]!.date))!;
    expect(ev.summary).toMatch(/^Outfit 1 of \d chosen$/);
    const ctx = await s.rec.context({ date: DAYS[0]!.date });
    expect(leaks(`${ev.summary}\n${ev.description}`, ctx, board.options.flatMap((o) => o.slots.map((x) => x.garmentId)))).toEqual([]);
  });

  it('a model writing short search names and all-letter codes into prose never gets them into the event', async () => {
    let ctx: MandatoryContext | null = null;
    const writer: ProseWriter = {
      name: 'leaky-model',
      write: async (input) => ({
        why: Object.fromEntries(input.options.map((o, n) => [o.optionId, ['Harris Tweed energy with the socks answering it today.', 'The summer oxford does the talking, and the socks answer it.', 'A quiet abcdef weave with the socks answering it today.', 'Cashmere softness up top, with the socks answering it.'][n % 4]!])),
        dayLine: `${input.dayLine} Wear the Overcoat.`,
      }),
    };
    const s = await ownerScenario({ withAdditions: true, deps: { prose: writer } });
    await addOchreShirt(s);
    ctx = await s.rec.context({ date: DAYS[0]!.date });
    const out = await s.rec.composeAndPublish({ date: DAYS[0]!.date });
    const doc = out.board!.document!;
    // A code or a garment's search-only name that the outfit does not wear is always refused.
    for (const o of doc.options) expect(o.why).not.toMatch(/summer oxford does|abcdef/i);
    // "Harris Tweed" and "Cashmere" are search-only aliases, but they are also fabric words: when an outfit
    // piece's recorded fabric says them, the sentence describes that piece and may stand. Every sentence that
    // was kept must pass the independent oracle for that option's own pieces.
    for (const o of doc.options) expect(leaks(o.why, ctx, o.garments.map((g) => g.garmentId)), o.why).toEqual([]);
    expect(doc.options.filter((o) => /Harris Tweed energy|Cashmere softness/.test(o.why)).every((o) => o.garments.some((g) => /harris tweed|cashmere/i.test(ctx!.byId.get(g.garmentId)!.fabric ?? '')))).toBe(true);
    expect(doc.dayLine).not.toMatch(/Overcoat/);
    await s.daily.projector.projectDay(DAYS[0]!.date);
    const ev = s.calendar.managed.get(await managedEventId(s.userId, DAYS[0]!.date))!;
    expect(leaks(`${ev.summary}\n${ev.description}`, ctx, out.board!.options.flatMap((o) => o.slots.map((x) => x.garmentId)))).toEqual([]);
  });
});
