import { FakeModelTransport, lastToolResults } from '../../../backend/src/models/fake.js';
import { installTestModelTransport } from '../../../backend/src/assistant/runtime.js';
import { installTestDailyProviders } from '../../../backend/src/assistant/day-context.js';
import { resetCircuitBreakers } from '../../../backend/src/models/service.js';
import type { World } from './world.js';

/**
 * The assistant runs as the real Think actor (Durable Object) inside this workerd isolate. The model
 * behind it is the deterministic FakeModelTransport (stand-in for the AI Gateway models): the local
 * build has no Gateway account, so every conversation journey is labelled "fake model" in the README.
 * Scripted tool calls exercise the assistant's command policy; answers are the fake's text.
 */
export const fakeModel = new FakeModelTransport();
installTestModelTransport(fakeModel);

/** The assistant's day context uses the same world as the API (weather, calendar, clock). */
export function assistantWorld(world: World): void {
  installTestDailyProviders({ weather: world.weather, calendar: world.calendar, clock: world.clock.now });
}

export function resetModel(): void {
  fakeModel.reset();
  resetCircuitBreakers();
}

/** On the first model step of each turn, answer with these tool calls (by turn order). */
export function scriptToolCalls(perTurn: { toolName: string; input: unknown; toolCallId?: string }[][]): void {
  let turn = 0;
  fakeModel.respondWith((call) => {
    if (call.task !== 'chat') return undefined;
    if (lastToolResults(call.request.prompt).length) return undefined;
    const calls = perTurn[turn++];
    return calls && calls.length ? { toolCalls: calls } : undefined;
  });
}

export function chatCalls() {
  return fakeModel.calls.filter((c) => c.task === 'chat');
}

/** The full prompt text the model saw on a call (system + messages). */
export function promptText(call: (typeof fakeModel.calls)[number]): string {
  return JSON.stringify(call.request.prompt);
}
