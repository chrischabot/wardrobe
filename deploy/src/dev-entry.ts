/**
 * Worker entry for the Garderobe dev deployment only.
 *
 * Every request except `/__dev/*` goes unchanged to the product entry (backend/src/index.ts): the
 * OAuth provider, MCP server, /v1 API, web board and consent page. The Durable Object class, the
 * Workflow class and the Queue consumer are the product's own exports.
 *
 * `/__dev/*` adds real-platform probes (deploy/src/probes.ts) used to record deployment evidence.
 * They need a verified Cloudflare Access assertion on the app hostname whose subject is listed in
 * DEV_PROBE_SUBJECTS, and they answer 404 unless ENVIRONMENT is `dev`.
 *
 * The end-to-end simulation (tests/simulation) wraps every other request in its hook
 * (tests/simulation/worker/sim-hook.ts): only a request carrying an `x-garderobe-sim` header signed
 * with the DEV_SIM_SECRET Worker secret runs with a simulated clock, weather and calendar; every other
 * request reaches the product unchanged. The assistant class adds the hook's `devSimulation` RPC.
 */
import product from '../../backend/src/index.js';
import { GarderobeAssistant as ProductAssistant } from '../../backend/src/index.js';
import type { Env } from '../../backend/src/env.js';
import { handleDevProbe, type DevEnv } from './probes.js';
import { simulationFetch, withSimulation, type SimEnv } from '../../tests/simulation/worker/sim-hook.js';

export { DailyServiceWorkflow } from '../../backend/src/index.js';

export class GarderobeAssistant extends withSimulation(ProductAssistant) {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/__dev/')) return handleDevProbe(request, env as DevEnv, ctx);
    return simulationFetch(request, env as SimEnv, ctx, (r) => product.fetch(r, env, ctx));
  },
  queue: product.queue,
} satisfies ExportedHandler<Env>;
