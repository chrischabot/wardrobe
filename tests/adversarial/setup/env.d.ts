import type { Env as WorkerEnv } from '../../../backend/src/env.js';
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Test-only binding (vitest config). */
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
