import type { CommandOf } from '@garderobe/contracts';
import { DomainError } from './errors.js';
import { versionIs } from './db.js';
import type { CommandPlan, HandlerContext } from './commands/types.js';

/**
 * update_delivery_settings (Settings > Morning delivery). An edit: the owner_settings version guards
 * the change, and the previous values are kept in owner_settings_history and the receipt facts.
 * Undo is "set it again": the receipt names the previous values.
 */
export async function updateDeliverySettings(ctx: HandlerContext<CommandOf<'update_delivery_settings'>>): Promise<CommandPlan> {
  const c = ctx.command;
  const userId = ctx.principal.userId;
  const row = await ctx.db
    .prepare('SELECT delivery_time, daily_option_count, calendar_id, home_location_label, timezone, version FROM owner_settings WHERE user_id = ?')
    .bind(userId)
    .first<{ delivery_time: string; daily_option_count: number; calendar_id: string | null; home_location_label: string; timezone: string; version: number }>();
  if (!row) throw new DomainError('invalid_state', 'Settings have not been created for this owner yet');
  const next = {
    deliveryTime: c.deliveryTime ?? row.delivery_time,
    dailyOptionCount: c.dailyOptionCount ?? row.daily_option_count,
    calendarId: c.calendarId === undefined ? row.calendar_id : c.calendarId,
    homeLocationLabel: c.homeLocationLabel ?? row.home_location_label,
  };
  const previous = { deliveryTime: row.delivery_time, dailyOptionCount: row.daily_option_count, calendarId: row.calendar_id, homeLocationLabel: row.home_location_label };
  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== previous[k]);
  const version = row.version + 1;
  const parts: string[] = [];
  if (changed.includes('deliveryTime')) parts.push(`outfits at ${next.deliveryTime}`);
  if (changed.includes('dailyOptionCount')) parts.push(`${next.dailyOptionCount} outfits each morning`);
  if (changed.includes('calendarId')) parts.push(next.calendarId ? 'outfit calendar set' : 'outfit calendar cleared');
  if (changed.includes('homeLocationLabel')) parts.push(`home location ${next.homeLocationLabel}`);
  return {
    occurredAt: ctx.now,
    guards: [versionIs(userId, 'owner_settings', userId, row.version)],
    statements: [
      ctx.db
        .prepare('UPDATE owner_settings SET delivery_time = ?, daily_option_count = ?, calendar_id = ?, home_location_label = ?, version = ?, updated_at = ? WHERE user_id = ? AND version = ?')
        .bind(next.deliveryTime, next.dailyOptionCount, next.calendarId, next.homeLocationLabel, version, ctx.now, userId, row.version),
      ctx.db
        .prepare('INSERT INTO owner_settings_history (user_id, version, body_json, command_id, changed_at) VALUES (?, ?, ?, ?, ?)')
        .bind(userId, version, JSON.stringify({ ...next, timezone: row.timezone }), ctx.commandId, ctx.now),
    ],
    affected: [{ entityType: 'owner_settings', entityId: userId, version, change: 'updated' }],
    summary: changed.length ? `Morning delivery updated: ${parts.join('; ')}.` : 'Morning delivery unchanged: the settings already had these values.',
    facts: { previous, current: next, changed },
    undo: null,
    undoUnavailableReason: 'Change the setting again; the previous values are in this receipt.',
    effects: [],
  };
}
