import { env } from 'cloudflare:workers';
import { getAgentByName } from 'agents';
import { FakeModelTransport, lastToolResults } from '../../src/models/fake.js';
import { installTestModelTransport } from '../../src/assistant/runtime.js';
import { installTestDailyProviders } from '../../src/assistant/day-context.js';
import { FakeWeatherProvider } from '../../src/weather/fake.js';
import { FakeCalendar } from '../../src/calendar/fake.js';
import { resetCircuitBreakers } from '../../src/models/service.js';
import type { GarderobeAssistant } from '../../src/assistant/agent.js';

/** One deterministic fake model shared by the test isolate and the assistant actors it hosts. */
export const fake = new FakeModelTransport();
installTestModelTransport(fake);

/** Fake weather and calendar for the daily-service day context (no network in tests). */
export const realClock = (): string => new Date().toISOString();
export function installFakeDay(opts: { weather?: FakeWeatherProvider; calendar?: FakeCalendar | null } = {}) {
  const weather = opts.weather ?? new FakeWeatherProvider({ scenario: 'mild', clock: realClock });
  const calendar = opts.calendar === undefined ? new FakeCalendar(realClock) : opts.calendar;
  installTestDailyProviders({ weather, calendar, clock: realClock });
  return { weather, calendar };
}
installFakeDay();

export type AssistantStub = Pick<
  GarderobeAssistant,
  'submitTurn' | 'stopAndSend' | 'stop' | 'getTurn' | 'deliverResult' | 'waitForIdle' | 'rawTranscript' | 'workingHistory' | 'compactNow' | 'forgetMessage' | 'runtimeInfo'
>;

export async function assistantFor(userId: string): Promise<AssistantStub> {
  return (await getAgentByName(env.ASSISTANT as never, `test:${userId}`)) as unknown as AssistantStub;
}

export function resetFake(): void {
  fake.reset();
  resetCircuitBreakers();
}

let n = 0;
export function turnId(prefix = 'turn'): string {
  n++;
  return `${prefix}-${Date.now().toString(36)}-${n}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Submit a turn and wait until the actor is idle; returns the settled turn. */
export async function converse(a: AssistantStub, text: string, extra: Record<string, unknown> = {}) {
  const clientTurnId = turnId();
  const receipt = await a.submitTurn({ clientTurnId, text, ...extra } as never);
  await a.waitForIdle();
  const turn = await a.getTurn(clientTurnId);
  return { receipt, turn, clientTurnId };
}

export function chatCalls() {
  return fake.calls.filter((c) => c.task === 'chat');
}

/** Script the chat model: on the first step of each turn, answer with these tool calls (by turn order). */
export function scriptToolCalls(perTurn: { toolName: string; input: unknown; toolCallId?: string }[][]): void {
  let turn = 0;
  fake.respondWith((call) => {
    if (call.task !== 'chat') return undefined;
    if (lastToolResults(call.request.prompt).length) return undefined;
    const calls = perTurn[turn++];
    return calls && calls.length ? { toolCalls: calls } : undefined;
  });
}

/** Every tool result the model received, in order. */
export function toolResults(): { toolName: string; value: Record<string, unknown> }[] {
  const out: { toolName: string; value: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  for (const c of fake.calls) {
    const prompt = c.request.prompt;
    let lastUser = -1;
    prompt.forEach((m, i) => {
      if (m.role === 'user') lastUser = i;
    });
    for (const m of prompt.slice(lastUser + 1)) {
      if (m.role !== 'tool') continue;
      for (const p of m.content) {
        if (p.type !== 'tool-result') continue;
        const id = (p as { toolCallId: string }).toolCallId;
        if (seen.has(id)) continue;
        seen.add(id);
        const output = (p as { output: { type: string; value?: unknown } }).output;
        out.push({ toolName: (p as { toolName: string }).toolName, value: (output.value ?? output) as Record<string, unknown> });
      }
    }
  }
  return out;
}
