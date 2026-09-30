import type { CommandPlan, EffectSpec } from '../domain/commands/types.js';
import type { Predicate } from '../domain/db.js';
import type { AffectedEntity } from '@garderobe/contracts';

/** Opaque ids for tables whose prefixes the foundation's IdPrefix does not list. */
export function localId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Merge child plans (e.g. several dispose_item plans inside one lifecycle transition) into one
 * all-or-nothing plan. Effects with the same operation key are merged so the outbox's unique key
 * holds; garment ids of revalidation effects are unioned.
 */
export function mergeEffects(effects: EffectSpec[]): EffectSpec[] {
  const byKey = new Map<string, EffectSpec>();
  for (const e of effects) {
    const prev = byKey.get(e.operationKey);
    if (!prev) {
      byKey.set(e.operationKey, { ...e, payload: { ...e.payload } });
      continue;
    }
    const a = (prev.payload.garmentIds as string[] | undefined) ?? [];
    const b = (e.payload.garmentIds as string[] | undefined) ?? [];
    prev.payload.garmentIds = [...new Set([...a, ...b])];
  }
  return [...byKey.values()];
}

export function mergeChildPlans(children: CommandPlan[]): { guards: Predicate[]; statements: D1PreparedStatement[]; affected: AffectedEntity[]; effects: EffectSpec[] } {
  return {
    guards: children.flatMap((c) => c.guards),
    statements: children.flatMap((c) => c.statements),
    affected: children.flatMap((c) => c.affected),
    effects: mergeEffects(children.flatMap((c) => c.effects)),
  };
}
