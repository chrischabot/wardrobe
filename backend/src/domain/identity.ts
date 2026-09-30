import { DEFAULT_LAUNDRY_ROUTINE, type LaundryRoutine } from '@garderobe/contracts';
import { json } from './db.js';
import { DomainError } from './errors.js';
import { newId } from './ids.js';

/**
 * Identity (spec section 15). The internal user ID is opaque and created before any personal data.
 * (issuer, subject) maps to exactly one user; email is display-only and never links accounts.
 */

export interface CreateUserInput {
  displayName: string;
  identity?: { issuer: string; subject: string; email?: string };
  settings?: {
    homeLocationLabel: string;
    homeLatitude?: number;
    homeLongitude?: number;
    timezone: string;
    deliveryTime?: string;
    dailyOptionCount?: number;
    laundryRoutine?: LaundryRoutine;
    wearLoggingSince?: string;
    estimatorParameters?: Record<string, unknown>;
  };
  now?: string;
  /** Only for deterministic local fixtures; production always generates the id. */
  userId?: string;
}

export async function createUser(db: D1Database, input: CreateUserInput): Promise<{ userId: string }> {
  const userId = input.userId ?? newId('usr');
  const now = input.now ?? new Date().toISOString();
  const statements: D1PreparedStatement[] = [db.prepare("INSERT INTO users (user_id, display_name, status, created_at, version) VALUES (?, ?, 'active', ?, 1)").bind(userId, input.displayName, now)];
  if (input.identity) {
    statements.push(
      db
        .prepare('INSERT INTO auth_identities (user_id, identity_id, issuer, subject, email, linked_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, newId('idn'), input.identity.issuer, input.identity.subject, input.identity.email ?? null, now),
    );
  }
  if (input.settings) {
    const s = input.settings;
    statements.push(
      db
        .prepare(
          `INSERT INTO owner_settings (user_id, home_location_label, home_latitude, home_longitude, timezone, delivery_time, daily_option_count, laundry_routine_json, estimator_params_json, wear_logging_since, version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          userId,
          s.homeLocationLabel,
          s.homeLatitude ?? null,
          s.homeLongitude ?? null,
          s.timezone,
          s.deliveryTime ?? '07:00',
          s.dailyOptionCount ?? 5,
          json(s.laundryRoutine ?? DEFAULT_LAUNDRY_ROUTINE),
          s.estimatorParameters ? json(s.estimatorParameters) : null,
          s.wearLoggingSince ?? now.slice(0, 10),
          now,
        ),
    );
  }
  try {
    await db.batch(statements);
  } catch (err) {
    if (String(err).includes('auth_identities.issuer')) throw new DomainError('validation_failed', 'That identity is already linked to another user');
    throw err;
  }
  return { userId };
}

/** Maps a verified (issuer, subject) to the internal user id; null when not linked. */
export async function resolveIdentity(db: D1Database, issuer: string, subject: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT a.user_id FROM auth_identities a JOIN users u ON u.user_id = a.user_id WHERE a.issuer = ? AND a.subject = ? AND a.unlinked_at IS NULL')
    .bind(issuer, subject)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}
