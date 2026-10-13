import { SignJWT, importPKCS8 } from "jose";
import { all, claimDueEffects, createPrincipal, first, prepare, settleEffect, stmt, toInstant, type Db, type EffectRecord } from "@garderobe/domain";
import { returnReminderDelivery } from "@garderobe/assistant";
import type { App } from "../app.ts";
import { codeHash, seal, unseal } from "../crypto.ts";
import type { Env } from "../env.ts";
import { ApiException } from "../errors.ts";

/**
 * Notifications to the owner's iPhone through APNs (specification section 9: "APNs and a calendar
 * client's synchronization are best-effort delivery mechanisms; the measurable guarantee is that the
 * server board ... exist"; section 8: a durable effect record is the instruction to dispatch a
 * notification, with a stable key and a recorded outcome).
 *
 * The other workstreams queue effects (`notification.morning_board` from the daily service,
 * `notification.reminder` and `notification.return_reminder` from the assistant). This module is the
 * dispatcher: it claims due effects, re-checks that each is still wanted, sends one push per registered
 * device with the effect's operation key as the collapse identifier, and records the outcome. A
 * notification says where to look; it never carries the outfit, so nothing private is in a push.
 *
 * APNs is reached with its token-based provider API (an ES256 token signed with the team's key). The
 * adapter is isolated here. Not verified against Apple in this build: see the README's live checks.
 */
export const NOTIFICATION_KINDS = ["notification.morning_board", "notification.reminder", "notification.return_reminder"] as const;

const APNS_HOSTS = { production: "https://api.push.apple.com", development: "https://api.sandbox.push.apple.com" } as const;
const MORNING_STALE_MS = 6 * 3_600_000;
const MAX_ATTEMPTS = 6;

export function apnsConfigured(env: Env): boolean {
  return Boolean(env.APNS_TEAM_ID && env.APNS_KEY_ID && env.APNS_PRIVATE_KEY && env.APNS_TOPIC);
}

/* ------------------------------------------------------------------ */
/* Devices                                                              */
/* ------------------------------------------------------------------ */

export interface DeviceInput {
  deviceId: string;
  token: string;
  environment: "development" | "production";
}

const tokenAad = (userId: string, deviceId: string) => `notification-device\u0000${userId}\u0000${deviceId}`;

/** Register (or refresh) this owner's device. A token that was registered to another owner moves to this one. */
export async function registerDevice(app: App, userId: string, input: DeviceInput): Promise<{ deviceId: string; environment: string; status: string; updatedAt: string }> {
  if (!/^[0-9a-fA-F]{32,200}$/.test(input.token)) throw new ApiException("invalid_command", "that is not a device token");
  const now = toInstant(app.now());
  const hash = await codeHash(app.env.STATE_SIGNING_KEY, "apns-device-token", input.token.toLowerCase());
  const sealed = await seal(app.env.CREDENTIAL_KEY, { token: input.token.toLowerCase() }, tokenAad(userId, input.deviceId));
  await app.db.batch(
    [
      // One phone belongs to one signed-in owner at a time.
      stmt("DELETE FROM notification_devices WHERE token_hash = ? AND NOT (user_id = ? AND device_id = ?)", hash, userId, input.deviceId),
      stmt(
        `INSERT INTO notification_devices (user_id, device_id, platform, environment, token_hash, token_cipher, token_iv, status, created_at, updated_at) VALUES (?, ?, 'ios', ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT (user_id, device_id) DO UPDATE SET environment = excluded.environment, token_hash = excluded.token_hash, token_cipher = excluded.token_cipher, token_iv = excluded.token_iv, status = 'active', disabled_reason = NULL, updated_at = excluded.updated_at`,
        userId,
        input.deviceId,
        input.environment,
        hash,
        sealed.ciphertext,
        sealed.iv,
        now,
        now,
      ),
    ].map((s) => prepare(app.db, s)),
  );
  return { deviceId: input.deviceId, environment: input.environment, status: "active", updatedAt: now };
}

export async function removeDevice(db: Db, userId: string, deviceId: string): Promise<{ removed: boolean }> {
  const result = await prepare(db, stmt("DELETE FROM notification_devices WHERE user_id = ? AND device_id = ?", userId, deviceId)).run();
  return { removed: (result.meta?.changes ?? 0) > 0 };
}

export async function listDevices(app: App, userId: string) {
  const rows = await all<{ device_id: string; environment: string; status: string; disabled_reason: string | null; updated_at: string; last_delivery_at: string | null }>(
    app.db,
    "SELECT device_id, environment, status, disabled_reason, updated_at, last_delivery_at FROM notification_devices WHERE user_id = ? ORDER BY updated_at DESC",
    userId,
  );
  return {
    deliveryConfigured: apnsConfigured(app.env),
    devices: rows.map((r) => ({ deviceId: r.device_id, environment: r.environment, status: r.status, disabledReason: r.disabled_reason, updatedAt: r.updated_at, lastDeliveryAt: r.last_delivery_at })),
  };
}

/* ------------------------------------------------------------------ */
/* APNs                                                                 */
/* ------------------------------------------------------------------ */

let providerToken: { key: string; token: string; issuedAt: number } | null = null;

/** The provider token: ES256, issuer = team, key ID in the header. Apple accepts one for up to an hour; it is reused for 40 minutes. */
async function apnsProviderToken(env: Env, nowMs: number): Promise<string> {
  const cacheKey = `${env.APNS_TEAM_ID}:${env.APNS_KEY_ID}`;
  if (providerToken && providerToken.key === cacheKey && nowMs - providerToken.issuedAt < 40 * 60_000) return providerToken.token;
  const key = await importPKCS8(env.APNS_PRIVATE_KEY!.replace(/\\n/g, "\n"), "ES256");
  const token = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: env.APNS_KEY_ID! }).setIssuer(env.APNS_TEAM_ID!).setIssuedAt(Math.floor(nowMs / 1000)).sign(key);
  providerToken = { key: cacheKey, token, issuedAt: nowMs };
  return token;
}

function apnsHost(env: Env, environment: "development" | "production"): string {
  // The override exists for local runs and tests only; a deployment always talks to Apple.
  if (env.APNS_BASE_URL && (env.ENVIRONMENT === "local" || env.ENVIRONMENT === "test")) return env.APNS_BASE_URL.replace(/\/+$/, "");
  return APNS_HOSTS[environment];
}

type Push = { title: string; body: string; kind: string; data: Record<string, unknown>; collapseId: string; expiresAtMs: number };

async function sendPush(env: Env, device: { token: string; environment: "development" | "production" }, push: Push, nowMs: number): Promise<"sent" | "unregistered" | "retry" | "rejected"> {
  const response = await fetch(`${apnsHost(env, device.environment)}/3/device/${device.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsProviderToken(env, nowMs)}`,
      "apns-topic": env.APNS_TOPIC!,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(push.expiresAtMs / 1000)),
      // The same operation never shows twice on a device, even if it is sent twice.
      "apns-collapse-id": push.collapseId,
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps: { alert: { title: push.title, body: push.body }, sound: "default", "thread-id": push.kind }, garderobe: { kind: push.kind, ...push.data } }),
  });
  if (response.status === 200) return "sent";
  const reason = ((await response.json().catch(() => ({}))) as { reason?: string }).reason ?? "";
  if (response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") return "unregistered";
  if (response.status === 429 || response.status >= 500 || reason === "ExpiredProviderToken") {
    if (reason === "ExpiredProviderToken") providerToken = null;
    return "retry";
  }
  console.warn("APNs rejected a notification", response.status, reason.slice(0, 60));
  return "rejected";
}

/* ------------------------------------------------------------------ */
/* Effects                                                              */
/* ------------------------------------------------------------------ */

const collapseIdOf = async (operationKey: string): Promise<string> => (await codeHashless(operationKey)).slice(0, 48);
async function codeHashless(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What to say for an effect, or the reason it is no longer wanted. Built from current records, never from stale payload alone. */
async function compose(app: App, effect: EffectRecord, nowMs: number): Promise<Push | { skip: string }> {
  const { db } = app;
  const p = effect.payload;
  const collapseId = await collapseIdOf(effect.operationKey);
  if (effect.kind === "notification.morning_board") {
    // Asked of the daily service, not read from its tables: is this still the day's board, and is the service paused?
    if (!app.daily) return { skip: "the daily service is not installed" };
    const reader = createPrincipal({ userId: effect.userId, actor: "system", channel: "system", scopes: ["read"], authRef: `notification:${effect.effectId}` });
    const view = await app.daily.today(reader, { date: String(p.localDate ?? ""), ...(typeof p.scope === "string" && p.scope !== "home" ? { scope: p.scope } : {}) });
    if (view.paused) return { skip: "recommendations are paused" };
    if (!view.board || view.board.boardId !== p.boardId) return { skip: "the board is no longer current" };
    const row = { current_revision: view.board.revision };
    const queuedAt = await first<{ created_at: string }>(db, "SELECT created_at FROM effects WHERE user_id = ? AND effect_id = ?", effect.userId, effect.effectId);
    if (queuedAt && nowMs - Date.parse(queuedAt.created_at) > MORNING_STALE_MS) return { skip: "the morning has passed; a late reminder is not sent" };
    return { title: "Today's outfits are ready", body: "Open Garderobe to see today's board.", kind: effect.kind, data: { localDate: p.localDate, boardId: p.boardId, revision: row.current_revision }, collapseId, expiresAtMs: nowMs + MORNING_STALE_MS };
  }
  if (effect.kind === "notification.return_reminder") {
    const principal = createPrincipal({ userId: effect.userId, actor: "system", channel: "system", scopes: ["read"], authRef: `notification:${effect.effectId}` });
    const wanted = await returnReminderDelivery(db, principal, { caseId: String(p.caseId ?? "") });
    if (!wanted.deliver) return { skip: wanted.reason ?? "the reminder is no longer wanted" };
    const days = Number(p.daysBefore ?? 0);
    return { title: "Return deadline", body: `${String(p.label ?? "A return")}: ${days === 1 ? "one day" : `${days} days`} left (${String(p.deadlineLocalDate ?? "")}).`, kind: effect.kind, data: { caseId: p.caseId, deadlineLocalDate: p.deadlineLocalDate }, collapseId, expiresAtMs: nowMs + 24 * 3_600_000 };
  }
  if (effect.kind === "notification.reminder") {
    return { title: String(p.title ?? "Reminder"), body: p.dueAt ? `Due ${String(p.dueAt).slice(0, 16).replace("T", " ")} UTC.` : "Open Garderobe for the details.", kind: effect.kind, data: { reminderId: p.reminderId, dueAt: p.dueAt }, collapseId, expiresAtMs: nowMs + 24 * 3_600_000 };
  }
  return { skip: "unknown notification kind" };
}

export interface DeliveryResult {
  claimed: number;
  sent: number;
  cancelled: number;
  retried: number;
  failed: number;
  devicesDisabled: number;
}

/**
 * Deliver due notification effects (scheduled sweep). While APNs is not configured nothing is claimed:
 * the effects stay pending and visible rather than being marked as sent or silently dropped.
 */
export async function deliverNotifications(app: App, nowMs: number, limit = 25): Promise<DeliveryResult> {
  const result: DeliveryResult = { claimed: 0, sent: 0, cancelled: 0, retried: 0, failed: 0, devicesDisabled: 0 };
  if (!apnsConfigured(app.env)) return result;
  const effects = await claimDueEffects(app.db, { nowMs, kinds: [...NOTIFICATION_KINDS], limit });
  result.claimed = effects.length;
  for (const effect of effects) {
    try {
      const push = await compose(app, effect, nowMs);
      if ("skip" in push) {
        await settleEffect(app.db, effect, { state: "cancelled" }, nowMs);
        result.cancelled++;
        continue;
      }
      const devices = await all<{ device_id: string; environment: "development" | "production"; token_cipher: string; token_iv: string }>(app.db, "SELECT device_id, environment, token_cipher, token_iv FROM notification_devices WHERE user_id = ? AND status = 'active'", effect.userId);
      if (devices.length === 0) {
        // Nothing to deliver to: recorded as not sent, never as delivered.
        await settleEffect(app.db, effect, { state: "cancelled" }, nowMs);
        result.cancelled++;
        continue;
      }
      let delivered = 0;
      let retry = false;
      for (const device of devices) {
        const { token } = await unseal<{ token: string }>(app.env.CREDENTIAL_KEY, { ciphertext: device.token_cipher, iv: device.token_iv }, tokenAad(effect.userId, device.device_id));
        const outcome = await sendPush(app.env, { token, environment: device.environment }, push, nowMs).catch(() => "retry" as const);
        if (outcome === "sent") {
          delivered++;
          await prepare(app.db, stmt("UPDATE notification_devices SET last_delivery_at = ? WHERE user_id = ? AND device_id = ?", toInstant(nowMs), effect.userId, device.device_id)).run();
        } else if (outcome === "unregistered") {
          await prepare(app.db, stmt("UPDATE notification_devices SET status = 'disabled', disabled_reason = 'the device no longer accepts notifications for this app', updated_at = ? WHERE user_id = ? AND device_id = ?", toInstant(nowMs), effect.userId, device.device_id)).run();
          result.devicesDisabled++;
        } else if (outcome === "retry") retry = true;
      }
      if (delivered > 0) {
        // APNs accepted it for at least one device. That is acceptance by Apple, not proof it was shown.
        await settleEffect(app.db, effect, { state: "projected" }, nowMs);
        result.sent++;
      } else if (retry && effect.attempts < MAX_ATTEMPTS) {
        await settleEffect(app.db, effect, { state: "retry", error: "the notification service did not accept the request", retryAtMs: nowMs + Math.min(60, 2 ** effect.attempts) * 60_000 }, nowMs);
        result.retried++;
      } else {
        await settleEffect(app.db, effect, { state: "failed" }, nowMs);
        result.failed++;
      }
    } catch (error) {
      console.error("notification delivery failed", String((error as Error)?.message ?? error).slice(0, 200));
      await settleEffect(app.db, effect, { state: "retry", error: "delivery raised an error", retryAtMs: nowMs + 5 * 60_000 }, nowMs);
      result.retried++;
    }
  }
  return result;
}
