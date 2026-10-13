### A02-1: The MCP consent page is served without the script-blocking content security policy the Worker intends for it
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/02-auth.test.ts, "the consent page carries the script-blocking content security policy the Worker intends for it"
- Expected: `GET /oauth/authorize` answers with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'` (the policy written in `consentRoutes`), so that a script in client-supplied text could not run even if escaping were missed somewhere (specification section 15, consent page shows client-supplied identity).
- Actual: the response header is only `frame-ancestors 'none'`. The OAuth provider's `beginConsent` already sets a `Content-Security-Policy` header, and the Worker adds its own only `if (!consent.headers.has("Content-Security-Policy"))`, so its stricter policy is never applied. Client-supplied text is escaped correctly today (asserted by the neighbouring test), so this is a missing second line of defence, not an exploitable injection.
- Reproduction: register any client at `POST /oauth/register`; open `GET /oauth/authorize?...` as a signed-in owner; read the `Content-Security-Policy` response header.
- Where: adv-base-5db4fd8/apps/worker/src/mcp/consent.ts:112 (the conditional), and `@cloudflare/workers-oauth-provider` 1.2.1 `beginConsent` (sets `frame-ancestors 'none'`).

### R09-1: "Sign out everywhere" leaves another session of the same sign-in working when that session began after the one that asked
- Severity: medium
- Owning workstream: API/MCP (apps/worker)
- Test: test/09-recovery-confirmation.test.ts, "signing out everywhere also refuses another device's session of the same sign-in that began after the session that asked"
- Expected: `POST /v1/sessions/revoke` refuses every session authenticated before the request except the one that asked (`revokeSessions`: "every session authenticated before now is refused, except the one doing this"; specification section 15, revoking prior sessions).
- Actual: the exemption is stored per identity with the asking session's issue time (`exempt_identity_hash`, `exempt_not_before = session.identity.issuedAtMs`), so every session of the same sign-in that was issued at or after the asking session's issue time stays valid. A session issued 10 minutes ago on another device (or stolen from it) still answers 200 on `GET /v1/me` after the owner signs out everywhere from a session issued two hours ago. Sessions of other linked sign-ins, and same sign-in sessions older than the asking one, are refused correctly.
- Reproduction: one owner; session A with `iat` = now - 7200 s, session B (same issuer and subject) with `iat` = now - 600 s; `POST /v1/sessions/revoke` with A (200); `GET /v1/me` with B answers 200, expected 401 `session_revoked`.
- Where: adv-base-5db4fd8/apps/worker/src/identity/service.ts:332-337 (`revokeSessions`), apps/worker/src/auth/session.ts:75-82 (the floor check).

### R09-2: Guesses sent at the same moment are all compared: a recovery transaction's five-attempt limit is not enforced under concurrency
- Severity: low
- Owning workstream: API/MCP (apps/worker)
- Test: test/09-recovery-confirmation.test.ts, "a recovery transaction compares at most its five allowed guesses even when they arrive at the same moment"
- Expected: a recovery transaction allows five attempts (`RECOVERY_MAX_ATTEMPTS`; specification section 15, "rate limits, expiring recovery transactions").
- Actual: ten wrong codes posted at once to one open transaction are all read against `attempts = 0`, all compared with the stored verifier, and ten `recovery.complete` refusals are written to `account_audit` for that transaction. The attempt counter is incremented after the comparison and is not part of a guard. The per-sign-in limit (10 per hour) and the per-kit limit (10 per hour) still bound the total, so the gain is from 5 to 10 guesses per sign-in per hour against a 160-bit secret; the defect is that the stated per-transaction limit is not what is enforced.
- Reproduction: `POST /auth/recovery/start` as a new sign-in; send 10 `POST /auth/recovery/complete` with that transaction and ten different well-formed wrong codes in parallel; `SELECT COUNT(*) FROM account_audit WHERE kind = 'recovery.complete' AND outcome = 'refused' AND detail_json LIKE '%<transactionId>%'` returns 10.
- Where: adv-base-5db4fd8/apps/worker/src/identity/service.ts:398-424 (status and attempts read before, incremented after).

### R09-3: Two sessions that unlink each other's sign-in at the same moment leave an account with no sign-in; without an active recovery kit it can never be reached again
- Severity: medium
- Owning workstream: API/MCP (apps/worker)
- Test: test/09-recovery-confirmation.test.ts, "never leaves an account with no sign-in and no recovery kit, even when both sign-ins are unlinked at the same moment" (intermittent: a race, reproduced in two of three runs; it runs in the strict run only)
- Expected: "The last identity can only be unlinked while a recovery kit exists, otherwise the account would be lost" (`unlinkIdentityById`; specification section 15: an identity can be unlinked without losing the wardrobe).
- Actual: with two linked sign-ins and no active recovery kit, each session posts `POST /v1/identities/unlink` naming the other sign-in at the same moment. Both read two linked identities, both pass the last-identity check, both updates commit: `auth_identities` has no linked row for the account and `recovery_credentials` has no active row. The check and the update are separate statements with no guard in the batch.
- Reproduction: owner with sign-ins X and Y linked; `UPDATE recovery_credentials SET status = 'replaced'` for that owner (the state after a kit was retired); in parallel, X posts `/v1/identities/unlink` with Y's `identityId` and Y posts it with X's; `SELECT COUNT(*) FROM auth_identities WHERE user_id = ? AND unlinked_at IS NULL` returns 0.
- Where: adv-base-5db4fd8/apps/worker/src/identity/service.ts:299-312.
