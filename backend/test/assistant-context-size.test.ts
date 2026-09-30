import { describe, expect, it } from 'vitest';
import { db, newOwner, ok, OWNER_SOURCES } from './helpers/fixtures.js';
import { assistantFor, chatCalls, converse, resetFake, scriptToolCalls, toolResults } from './helpers/assistant.js';
import { listWardrobe } from '../src/domain/queries.js';

/**
 * Per-turn input size (dev deployment follow-up): the chat request carries the full profile and every
 * mandatory section, with a compact wardrobe index and compact tool schemas. Measured on the owner's
 * real data, the reductions took a turn from 33,067 to 27,747 Claude input tokens; these tests keep
 * the savings honest by checking that no fact and no validation was given up for them.
 */
describe('compact per-turn context', () => {
  it('the index keeps every fact in compact form: restrictions by id, wears when recorded, units when not one clean unit', async () => {
    const owner = await newOwner({ withAdditions: true });
    const donegal = await owner.byName('Donegal blazer');
    await ok(owner.principal, { type: 'record_wear', timezone: 'Europe/London', items: [{ garmentId: donegal }] });
    const a = await assistantFor(owner.userId);
    resetFake();
    await converse(a, 'What should I wear on Saturday?');
    const system = chatCalls()[0]!.system;
    expect(system).toContain(OWNER_SOURCES.profileText);
    const index = system.slice(system.indexOf('# Wardrobe index'), system.indexOf('\n\n# ', system.indexOf('# Wardrobe index') + 1));
    const line = (id: string) => index.split('\n').find((l) => l.startsWith(`${id} |`))!;

    const restriction = /^- (rst_[0-9a-f]+) \[healing\] (.+?) \|/m.exec(system)!;
    const boot = line(await owner.byName("Drake's Clifford boot"));
    expect(boot).toContain(`unavailable (Restricted by ${restriction[1]} (see Active restrictions))`);
    // The reason is stated once under Active restrictions, not on every restricted index line.
    expect(index).not.toContain(restriction[2]);

    expect(line(donegal)).toMatch(/\| recorded wears 1, last \d{4}-\d{2}-\d{2}$/);
    const unworn = line(await owner.byName('Chestnut houndstooth blazer'));
    expect(unworn).toMatch(/\| blazer \| available$/);
    expect(index).toContain('no entry means none recorded since logging began, which is unlogged, not unworn');
    // Units are shown for anything other than one clean unit, with the ledger's own numbers.
    const multi = (await listWardrobe(db(), owner.principal, { limit: 1000 })).items.find((i) => i.stock.totalOwned > 1)!;
    expect(line(multi.garment.garmentId)).toContain(`| clean ${multi.stock.buckets.clean ?? 0}/${multi.stock.totalOwned}`);
    expect(unworn).not.toContain('clean');
  });

  it('tool schemas go out without the dialect URL and generated format regexes, and tool input is still validated in full', async () => {
    const owner = await newOwner();
    const a = await assistantFor(owner.userId);
    resetFake();
    scriptToolCalls([[{ toolName: 'wear_history', input: { from: '2026-02-30' } }]]);
    await converse(a, 'What did I wear in February?');
    const tools = chatCalls()[0]!.request.tools!;
    const wire = JSON.stringify(tools);
    expect(wire).not.toContain('"$schema"');
    expect(wire).not.toMatch(/"format":"[a-z-]+","pattern"|"pattern":"[^"]*","format"/);
    // A pattern that is the only description of a string (not a format's regex) is kept.
    expect(wire).toContain('"pattern":"^[a-z]{1,6}_[A-Za-z0-9_-]+$"');
    const wearHistory = tools.find((t) => t.name === 'wear_history')!.inputSchema as { properties: Record<string, { format?: string }>; additionalProperties: boolean };
    expect(wearHistory.properties.from!.format).toBe('date');
    expect(wearHistory.additionalProperties).toBe(false);
    // An impossible date the wire schema no longer spells out is still refused by the tool's own schema.
    const result = toolResults().find((r) => r.toolName === 'wear_history');
    expect(JSON.stringify(result?.value)).toMatch(/invalid/i);
    expect(JSON.stringify(result?.value)).not.toContain('"wears"');
  });
});
