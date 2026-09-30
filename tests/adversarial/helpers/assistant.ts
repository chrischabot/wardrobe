import { env } from 'cloudflare:workers';
import { getAgentByName } from 'agents';
import { FakeModelTransport, lastToolResults } from '../../../backend/src/models/fake.js';
import { installTestModelTransport } from '../../../backend/src/assistant/runtime.js';
import { installTestDailyProviders } from '../../../backend/src/assistant/day-context.js';
import { FakeWeatherProvider } from '../../../backend/src/weather/fake.js';
import { FakeCalendar } from '../../../backend/src/calendar/fake.js';
import { resetCircuitBreakers } from '../../../backend/src/models/service.js';
import { classifyTurnIntent } from '../../../backend/src/assistant/intent.js';
import { ownerPrincipal, readOnlyPrincipal } from '../../../backend/src/domain/principal.js';
import type { ToolContext } from '../../../backend/src/assistant/tools.js';
import type { GarderobeAssistant } from '../../../backend/src/assistant/agent.js';

/**
 * The hostile model. `FakeModelTransport` (backend/src/models/fake.ts) stands in for every real model
 * provider behind AI Gateway: tests script it to emit whatever tool calls an adversarial or
 * prompt-injected model would, and the real Think actor, tools and command service handle them.
 */
export const fake = new FakeModelTransport();
installTestModelTransport(fake);

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
  fake.respondWith((c) => {
    if (c.task !== 'chat') return undefined;
    if (lastToolResults(c.request.prompt).length) return undefined;
    const calls = perTurn[turn++];
    return calls && calls.length ? { toolCalls: calls } : undefined;
  });
}

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

/** The system prompt of the most recent chat call (what the model was actually given). */
export function lastSystemPrompt(): string {
  const c = chatCalls().at(-1);
  if (!c) return '';
  return c.request.prompt
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** A direct tool context (no model): the owner's message drives the intent, as in the actor. */
export function toolCtx(userId: string, text: string, extra: Partial<ToolContext> & { readOnly?: boolean; attachments?: { kind: 'image' | 'link' | 'file' }[]; captureIntent?: 'add_item' | 'identify' | 'what_i_wore' } = {}): ToolContext {
  const { readOnly, attachments, captureIntent, ...rest } = extra;
  return {
    db: env.DB,
    principal: readOnly ? readOnlyPrincipal(userId) : ownerPrincipal(userId, 'test'),
    turnId: `turn_${crypto.randomUUID().replace(/-/g, '')}`,
    channel: 'conversation',
    ownerText: text,
    intent: classifyTurnIntent({ text, attachments, captureIntent: captureIntent ?? null }),
    timezone: 'Europe/London',
    now: () => new Date().toISOString(),
    ...rest,
  };
}
