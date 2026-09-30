import type { ImportDatasetInput } from '@garderobe/contracts';

/**
 * SYNTHETIC TEST OWNER B — not a real person and not the owner's profile.
 *
 * A deliberately small, invented wardrobe used only as the second user in two-user isolation tests.
 * The real owner's data lives in garderobe/data/ and is imported by the seed script.
 */

export const SYNTHETIC_PROFILE_B = `# SYNTHETIC TEST OWNER B — not a real person

This profile exists only for isolation tests. It must never be shown as, merged with, or mistaken for the owner's profile.

## Taste

Plain workwear, grey and green, nothing shiny. Canvas trousers and wool jumpers.

## Rules

Always wear socks. Boots are fine every day.
`;

export const syntheticOwnerB: ImportDatasetInput = {
  format: 'garderobe-neutral-export',
  version: 1,
  source: { system: 'synthetic-test-owner-b', exportedAt: '2026-09-01T00:00:00.000Z', label: 'SYNTHETIC TEST OWNER B (isolation fixture)' },
  owner: {
    displayName: 'Synthetic Test Owner B',
    homeLocationLabel: 'Utrecht (synthetic)',
    timezone: 'Europe/Amsterdam',
    wearLoggingSince: '2026-09-01',
  },
  styleDocuments: [
    {
      sourceId: 'synthetic-b-profile',
      title: 'SYNTHETIC TEST OWNER B — not a real person',
      body: SYNTHETIC_PROFILE_B,
      isDemo: true,
      source: 'synthetic_test',
      authoredOn: '2026-09-01',
      rules: [
        {
          ruleKey: 'synthetic.socks_always',
          kind: 'hard_rule',
          strength: 'hard',
          category: 'socks',
          statement: 'Always wear socks (synthetic owner B).',
          interpretation: 'Synthetic isolation fixture rule.',
          exceptionPolicy: 'none',
          passage: { section: 'Rules', quote: 'Always wear socks.' },
        },
      ],
    },
  ],
  garments: [
    { sourceId: 'b-1', name: 'SYNTHETIC grey canvas work trousers', category: 'trousers', roles: ['bottom'], careChannel: 'service', laundryPolicy: 'single_wear_day', acquisition: 'owned', stock: { clean: 1 }, aliases: [{ phrase: 'grey canvas', kind: 'owner_phrase' }] },
    { sourceId: 'b-2', name: 'SYNTHETIC green canvas work trousers', category: 'trousers', roles: ['bottom'], careChannel: 'service', laundryPolicy: 'single_wear_day', acquisition: 'owned', stock: { clean: 1 } },
    { sourceId: 'b-3', name: 'SYNTHETIC grey wool jumper', category: 'knitwear', roles: ['mid_layer'], careChannel: 'none', laundryPolicy: 'multi_wear', acquisition: 'owned', stock: { clean: 1 } },
    { sourceId: 'b-4', name: 'SYNTHETIC white tee', category: 'tshirt', roles: ['base_top'], careChannel: 'service', laundryPolicy: 'per_wear', acquisition: 'owned', stock: { clean: 1 } },
    { sourceId: 'b-5', name: 'SYNTHETIC ecru tee', category: 'tshirt', roles: ['base_top'], careChannel: 'service', laundryPolicy: 'per_wear', acquisition: 'owned', stock: { clean: 1 } },
    { sourceId: 'b-6', name: 'SYNTHETIC brown work boots', category: 'boots', roles: ['footwear'], careChannel: 'none', laundryPolicy: 'never', acquisition: 'owned', stock: { clean: 1 }, attributes: { construction: 'welted' } },
    { sourceId: 'b-7', name: 'SYNTHETIC grey wool socks', category: 'socks', roles: ['socks'], careChannel: 'hand_wash', laundryPolicy: 'per_wear', tracking: 'anonymous_quantity', acquisition: 'owned', stock: { clean: 5 } },
    { sourceId: 'b-8', name: 'SYNTHETIC black leather belt', category: 'belt', roles: ['belt'], careChannel: 'none', laundryPolicy: 'never', acquisition: 'owned', stock: { clean: 1 } },
    { sourceId: 'b-9', name: 'SYNTHETIC olive chore coat', category: 'jacket', roles: ['outer_layer'], careChannel: 'none', laundryPolicy: 'multi_wear', acquisition: 'owned', stock: { clean: 1 } },
    { sourceId: 'b-10', name: 'SYNTHETIC wide stripe shirt', category: 'shirt', roles: ['base_top'], careChannel: 'service', laundryPolicy: 'per_wear', acquisition: 'owned', stock: { clean: 1 }, aliases: [{ phrase: 'the wide stripe', kind: 'owner_phrase' }] },
  ],
};
