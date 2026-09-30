import type { Env as WorkerEnv } from './env.js';

// The agents/Think base classes are typed against the global Cloudflare.Env. Declare the Worker's
// bindings there so Think subclasses see DB, AI, ASSISTANT and the rest.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
