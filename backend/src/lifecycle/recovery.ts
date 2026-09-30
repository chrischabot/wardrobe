import { DomainError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';

/**
 * Recovery after losing Google access (spec section 15).
 *
 * A one-time recovery credential is issued at setup; only a PBKDF2-SHA256 verifier is stored,
 * separate from login tokens. Recovery proves possession, binds an alternative verified identity to
 * the existing internal user id, invalidates the used credential, revokes prior native sessions and
 * consumer assistant grants (via validity instants the API layer checks), and issues a replacement
 * kit. Attempts are rate limited and audited. Email matches or wardrobe knowledge never prove
 * ownership; there is no support override.
 */

const ITERATIONS = 100_000;
const PREFIX = 'GRDB';

function b32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of bytes) out += alphabet[b % 32];
  return out;
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function derive(secret: string, salt: string, iterations = ITERATIONS): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations }, key, 256);
  return hex(bits);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface RecoveryKit {
  credential: string;
  credentialId: string;
  instructions: string;
  issuedAt: string;
}

export async function issueRecoveryCredential(db: D1Database, userId: string, now = new Date().toISOString()): Promise<RecoveryKit> {
  const credentialId = `rcv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const secret = b32(crypto.getRandomValues(new Uint8Array(32)));
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const verifier = `pbkdf2-sha256$${ITERATIONS}$${salt}$${await derive(secret, salt)}`;
  await db.batch([
    db.prepare('UPDATE recovery_credentials SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').bind(now, userId),
    db.prepare('INSERT INTO recovery_credentials (user_id, credential_id, verifier_hash, created_at) VALUES (?, ?, ?, ?)').bind(userId, credentialId, verifier, now),
  ]);
  return {
    credential: `${PREFIX}.${credentialId}.${secret}`,
    credentialId,
    issuedAt: now,
    instructions: 'Store this recovery code offline (printed or in a password manager). It is shown once, works once, and replaces any earlier code. Garderobe stores only a verifier.',
  };
}

export interface RecoveryOutcome {
  userId: string;
  linkedIdentityId: string;
  sessionsValidAfter: string;
  replacementKit: RecoveryKit;
}

const MAX_ATTEMPTS_PER_HOUR = 5;

export async function recoverWithCredential(
  db: D1Database,
  input: { credential: string; newIdentity: { issuer: string; subject: string; email?: string } },
  now = new Date().toISOString(),
): Promise<RecoveryOutcome> {
  const parts = input.credential.trim().split('.');
  const credentialId = parts.length === 3 && parts[0] === PREFIX ? parts[1]! : null;
  const secret = parts[2] ?? '';
  const row = credentialId
    ? await db.prepare('SELECT user_id, credential_id, verifier_hash, used_at, revoked_at FROM recovery_credentials WHERE credential_id = ?').bind(credentialId).first<{ user_id: string; credential_id: string; verifier_hash: string; used_at: string | null; revoked_at: string | null }>()
    : null;
  const audit = (userId: string | null, outcome: string) =>
    db.prepare('INSERT INTO recovery_attempts (user_id, attempt_id, outcome, created_at) VALUES (?, ?, ?, ?)').bind(userId, `rat_${crypto.randomUUID().replace(/-/g, '')}`, outcome, now).run();
  if (row) {
    const recent = await db.prepare("SELECT COUNT(*) AS n FROM recovery_attempts WHERE user_id = ? AND outcome <> 'recovered' AND created_at >= ?").bind(row.user_id, new Date(Date.parse(now) - 3600_000).toISOString()).first<{ n: number }>();
    if ((recent?.n ?? 0) >= MAX_ATTEMPTS_PER_HOUR) {
      await audit(row.user_id, 'rate_limited');
      throw new DomainError('insufficient_scope', 'Too many recovery attempts; try again later');
    }
  }
  const fail = async (outcome: string) => {
    await audit(row?.user_id ?? null, outcome);
    return new DomainError('unauthenticated', 'That recovery code is not valid');
  };
  if (!row) throw await fail('unknown_credential');
  if (row.used_at || row.revoked_at) throw await fail(row.used_at ? 'already_used' : 'revoked');
  const [, iterations, salt, expected] = row.verifier_hash.split('$');
  const actual = await derive(secret, salt!, Number(iterations));
  if (!timingSafeEqual(actual, expected!)) throw await fail('wrong_secret');

  const existing = await db.prepare('SELECT user_id FROM auth_identities WHERE issuer = ? AND subject = ?').bind(input.newIdentity.issuer, input.newIdentity.subject).first<{ user_id: string }>();
  if (existing && existing.user_id !== row.user_id) throw await fail('identity_belongs_to_another_user');
  const identityId = newId('idn');
  // Single use: the conditional update and everything else commit together or not at all.
  const statements: D1PreparedStatement[] = [
    db.prepare('INSERT INTO command_preconditions (check_id, ok) SELECT ?, CASE WHEN (SELECT used_at IS NULL AND revoked_at IS NULL FROM recovery_credentials WHERE credential_id = ?) THEN 1 ELSE 0 END').bind(`rcvchk_${identityId}`, row.credential_id),
    db.prepare('UPDATE recovery_credentials SET used_at = ? WHERE credential_id = ?').bind(now, row.credential_id),
    db.prepare('DELETE FROM command_preconditions WHERE check_id = ?').bind(`rcvchk_${identityId}`),
    db
      .prepare(
        `INSERT INTO identity_security (user_id, sessions_valid_after, grants_valid_after, version, updated_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (user_id) DO UPDATE SET sessions_valid_after = excluded.sessions_valid_after, grants_valid_after = excluded.grants_valid_after, version = identity_security.version + 1, updated_at = excluded.updated_at`,
      )
      .bind(row.user_id, now, now, now),
  ];
  if (!existing) {
    statements.push(db.prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, email, linked_at) VALUES (?, ?, ?, ?, ?, ?)').bind(row.user_id, identityId, input.newIdentity.issuer, input.newIdentity.subject, input.newIdentity.email ?? null, now));
  }
  try {
    await db.batch(statements);
  } catch {
    throw await fail('race_lost');
  }
  await audit(row.user_id, 'recovered');
  const replacementKit = await issueRecoveryCredential(db, row.user_id, now);
  return { userId: row.user_id, linkedIdentityId: existing ? 'already_linked' : identityId, sessionsValidAfter: now, replacementKit };
}

/** The API/MCP layer calls these when validating a session or consumer grant. */
export async function isSessionValid(db: D1Database, userId: string, issuedAt: string): Promise<boolean> {
  const r = await db.prepare('SELECT sessions_valid_after FROM identity_security WHERE user_id = ?').bind(userId).first<{ sessions_valid_after: string | null }>();
  return !r?.sessions_valid_after || issuedAt > r.sessions_valid_after;
}

export async function isGrantValid(db: D1Database, userId: string, grantedAt: string): Promise<boolean> {
  const r = await db.prepare('SELECT grants_valid_after FROM identity_security WHERE user_id = ?').bind(userId).first<{ grants_valid_after: string | null }>();
  return !r?.grants_valid_after || grantedAt > r.grants_valid_after;
}
