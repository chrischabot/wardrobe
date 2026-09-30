import { defineConfig } from 'vitest/config';

// Node-only unit tests of the harness itself (the simulation proper runs with `npm run sim`).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
