import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

/** A throwaway RSA key standing in for the Cloudflare Access team key in API/auth tests (never deployed). */
function testAccessKeys(): { jwks: string; privateJwk: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = { ...publicKey.export({ format: 'jwk' }), kid: 'test-access-key', alg: 'RS256', use: 'sig' };
  const priv = { ...privateKey.export({ format: 'jwk' }), kid: 'test-access-key', alg: 'RS256' };
  return { jwks: JSON.stringify({ keys: [pub] }), privateJwk: JSON.stringify(priv) };
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(migrationsDir);
  const access = testAccessKeys();
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        // Everything runs locally: no remote bindings, no Cloudflare account.
        remoteBindings: false,
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ACCESS_JWKS_JSON: access.jwks, TEST_ACCESS_PRIVATE_JWK: access.privateJwk },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup/apply-migrations.ts'],
      testTimeout: 30_000,
    },
  };
});
