#!/usr/bin/env node
/**
 * Print a local sign-in token (valid one hour) for the local owner.
 *
 *   npm run dev:token                 the token
 *   npm run dev:token -- --header     a ready-to-paste header line
 *   npm run dev:token -- --claim      also claim the seeded account when it is not claimed yet
 *
 * Send it as `Cf-Access-Jwt-Assertion: <token>` (what Cloudflare Access sends to the origin) or as
 * `Authorization: Bearer <token>` (what the native app sends; accepted this way only locally).
 * This token only exists for local runs: the Worker accepts the local key only when ENVIRONMENT is
 * local or test.
 */
import { ensureClaimed, localAssertion } from "./lib/local.mjs";

const args = new Set(process.argv.slice(2));
if (args.has("--claim")) {
  const result = await ensureClaimed();
  console.error(result.claimed ? `claimed the local account ${result.me.userId}; the recovery kit is saved in .wrangler/garderobe-local/state.json` : `already signed in as ${result.me.userId}`);
}
const token = await localAssertion();
console.log(args.has("--header") ? `Cf-Access-Jwt-Assertion: ${token}` : token);
