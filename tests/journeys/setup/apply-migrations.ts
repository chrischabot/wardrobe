import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Real local D1 (miniflare/workerd): apply the production migrations before each journey file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
