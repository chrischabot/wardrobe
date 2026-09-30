import type { Env as WorkerEnv } from '../../../backend/src/env.js';
import type { D1Migration } from 'cloudflare:test';

// Typed bindings for the journey suite (`import { env, exports } from 'cloudflare:workers'`).
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Test-only binding (vitest config); optional so production code typed against Cloudflare.Env is unaffected. */
      TEST_MIGRATIONS?: D1Migration[];
      /** Test-only private JWK signing local Access assertions (vitest config). */
      TEST_ACCESS_PRIVATE_JWK?: string;
    }
    interface GlobalProps {
      mainModule: typeof import('../../../backend/src/index.js');
    }
  }
}

export {};
