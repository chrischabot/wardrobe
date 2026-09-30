import type { CommandEnvelopeInput, CommandReceipt, DomainCommandInput } from '@garderobe/contracts';

/**
 * LABELLED TEST EVENTS — scenario state the owner's May 2026 CSV does not contain (wear history,
 * a laundry batch, items at the tailor, in storage, incoming and disposed). They are applied through
 * the real command service on top of the imported baseline, never written into it.
 *
 * Every event carries an idempotency key starting with `test-event:` and a sourceRef or note
 * containing TEST_EVENT_LABEL, so receipts and records remain distinguishable from owner data.
 * The same script is reusable by the end-to-end simulation.
 */

export const TEST_EVENT_LABEL = 'TEST EVENT (fixture, not owner data)';

export interface CommandExecutor {
  execute(input: unknown): Promise<CommandReceipt>;
}

export interface TestEventContext {
  /** Resolves a perceptible garment name from the imported wardrobe to its id. */
  garment(name: string): Promise<string>;
  /** Base Monday (local date) the week of events starts on. */
  weekStart: string;
  timezone?: string;
}

export interface TestEventResult {
  receipts: CommandReceipt[];
  incomingGarmentId: string;
  disposedGarmentId: string;
  batchId: string | null;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export async function applyTestEvents(exec: CommandExecutor, ctx: TestEventContext): Promise<TestEventResult> {
  const tz = ctx.timezone ?? 'Europe/London';
  const receipts: CommandReceipt[] = [];
  let n = 0;
  const send = async (command: DomainCommandInput, source: CommandEnvelopeInput['source'] = 'app') => {
    n++;
    const r = await exec.execute({ idempotencyKey: `test-event:${ctx.weekStart}:${n}`, source, command } satisfies CommandEnvelopeInput);
    if (r.outcome !== 'committed' && r.outcome !== 'merged') throw new Error(`Test event ${n} (${command.type}) failed: ${r.error?.code} ${r.error?.message}`);
    receipts.push(r);
    return r;
  };
  const day = (i: number, time = '08:30') => ({ wearingDate: addDays(ctx.weekStart, i), timezone: tz, occurredAt: `${addDays(ctx.weekStart, i)}T${time}:00+01:00`, sourceRef: TEST_EVENT_LABEL });

  const g = async (name: string) => ctx.garment(name);
  // Monday to Wednesday wears (sneakers only: the welted fleet is restricted).
  await send({ type: 'record_wear', ...day(0), items: [
    { garmentId: await g('Lightweight oxford — blue'), role: 'base_top' },
    { garmentId: await g('Di Sondrio walnut chino'), role: 'bottom' },
    { garmentId: await g('Merino — inky blue'), role: 'socks' },
    { garmentId: await g('NB 990v4 — grey'), role: 'footwear' },
    { garmentId: await g("Anderson's belt — brown"), role: 'belt' },
  ] });
  await send({ type: 'record_wear', ...day(1), items: [
    { garmentId: await g('Pima oxford — fatigue'), role: 'base_top' },
    { garmentId: await g('JP double-pleated heavyweight chino — navy'), role: 'bottom' },
    { garmentId: await g('Merino — deep earth brown'), role: 'socks' },
    { garmentId: await g('NB 990v4 — olive/cream'), role: 'footwear' },
    { garmentId: await g("Drake's Olive Jungle Jacket"), role: 'outer_layer' },
  ] }, 'mcp');
  await send({ type: 'record_wear', ...day(2), items: [
    { garmentId: await g('Lightweight oxford — light blue wide stripe'), role: 'base_top' },
    { garmentId: await g('Olive reverse sateen fatigue'), role: 'bottom' },
    { garmentId: await g('Merino — correct grey'), role: 'socks' },
    { garmentId: await g('NB 990v4 — navy'), role: 'footwear' },
  ] });
  // Thursday: pickup of the service hamper; Friday: a wear after pickup stays in the hamper.
  const collected = await send({ type: 'laundry_collected', occurredAt: `${addDays(ctx.weekStart, 3)}T09:00:00+01:00` });
  await send({ type: 'record_wear', ...day(4), items: [
    { garmentId: await g('Lightweight oxford — moss'), role: 'base_top' },
    { garmentId: await g('Stratton stretch corduroy'), role: 'bottom' },
    { garmentId: await g('Merino — pine green'), role: 'socks' },
    { garmentId: await g('NB 990v4 — grey'), role: 'footwear' },
  ] });
  // Saturday: partial return (one shirt still away).
  await send({ type: 'laundry_partial_return', occurredAt: `${addDays(ctx.weekStart, 5)}T11:00:00+01:00`, exceptions: [{ garmentId: await g('Pima oxford — fatigue') }] });
  await send({ type: 'socks_washed', occurredAt: `${addDays(ctx.weekStart, 5)}T20:00:00+01:00` });
  // Lifecycle states the CSV lacks.
  await send({ type: 'send_to_tailor', garmentId: await g("Drake's Camel Field Games"), work: `Take in the waist (${TEST_EVENT_LABEL})`, expectedReturn: addDays(ctx.weekStart, 20), occurredAt: `${addDays(ctx.weekStart, 1)}T12:00:00+01:00` });
  await send({ type: 'put_into_storage', garmentId: await g('DBF Grandfather Coat'), locationDetail: `Loft (${TEST_EVENT_LABEL})`, occurredAt: `${addDays(ctx.weekStart, 2)}T18:00:00+01:00` });
  const incoming = await send({
    type: 'add_item',
    explicit: true,
    name: `NB 993 — grey (${TEST_EVENT_LABEL})`,
    category: 'sneakers',
    roles: ['footwear'],
    maker: 'New Balance',
    acquisition: 'incoming',
    attributes: { model: '993', testEvent: true },
    notes: TEST_EVENT_LABEL,
  });
  const disposedId = await g('Drake\'s red polka-dot');
  await send({ type: 'dispose_item', garmentId: disposedId, reason: 'donated', note: TEST_EVENT_LABEL, occurredAt: `${addDays(ctx.weekStart, 3)}T15:00:00+01:00` });
  return {
    receipts,
    incomingGarmentId: incoming.facts.garmentId as string,
    disposedGarmentId: disposedId,
    batchId: (collected.facts.batchId as string | undefined) ?? null,
  };
}
