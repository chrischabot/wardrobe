import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

/**
 * Journey suite: the real Garderobe Worker (backend/wrangler.jsonc → backend/src/index.ts) in workerd
 * through @cloudflare/vitest-pool-workers, with real local D1 (the production migrations), R2, KV,
 * Durable Objects and queues. Requests go through the Worker's own fetch handler (HTTP API, OAuth,
 * MCP). Every journey file gets fresh storage. Nothing remote is contacted.
 */

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));
const migrationsDir = fileURLToPath(new URL('../../backend/migrations', import.meta.url));

/** A throwaway RSA key standing in for the Cloudflare Access team key (local only, never deployed). */
function testAccessKeys(): { jwks: string; privateJwk: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = { ...publicKey.export({ format: 'jwk' }), kid: 'journey-access-key', alg: 'RS256', use: 'sig' };
  const priv = { ...privateKey.export({ format: 'jwk' }), kid: 'journey-access-key', alg: 'RS256' };
  return { jwks: JSON.stringify({ keys: [pub] }), privateJwk: JSON.stringify(priv) };
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir);
  const access = testAccessKeys();
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: `${backendDir}wrangler.jsonc` },
        remoteBindings: false,
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ACCESS_JWKS_JSON: access.jwks, TEST_ACCESS_PRIVATE_JWK: access.privateJwk },
        },
      }),
    ],
    test: {
      include: ['journeys/**/*.journey.test.ts'],
      setupFiles: ['./setup/apply-migrations.ts'],
      testTimeout: 60_000,
      hookTimeout: 90_000,
    },
  };
});
