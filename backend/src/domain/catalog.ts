import type { CareChannel, Category, GarmentRole, LaundryPolicy, StockTracking } from '@garderobe/contracts';

/**
 * Category defaults applied when an explicit creation or import does not state care facts.
 * Footwear, belts, ties and bags never acquire laundry state (laundry_policy 'never').
 */
export interface CategoryDefaults {
  roles: GarmentRole[];
  careChannel: CareChannel;
  laundryPolicy: LaundryPolicy;
  tracking: StockTracking;
}

const D = (roles: GarmentRole[], careChannel: CareChannel, laundryPolicy: LaundryPolicy, tracking: StockTracking = 'unit'): CategoryDefaults => ({
  roles,
  careChannel,
  laundryPolicy,
  tracking,
});

export const CATEGORY_DEFAULTS: Record<Category, CategoryDefaults> = {
  shirt: D(['base_top'], 'service', 'per_wear'),
  tshirt: D(['base_top'], 'service', 'per_wear'),
  polo: D(['base_top'], 'service', 'per_wear'),
  knitwear: D(['mid_layer'], 'none', 'multi_wear'),
  sweatshirt: D(['mid_layer', 'base_top'], 'service', 'multi_wear'),
  trousers: D(['bottom'], 'service', 'single_wear_day'),
  jeans: D(['bottom'], 'service', 'single_wear_day'),
  shorts: D(['bottom'], 'service', 'single_wear_day'),
  blazer: D(['outer_layer'], 'none', 'multi_wear'),
  jacket: D(['outer_layer'], 'none', 'multi_wear'),
  coat: D(['outer_layer'], 'none', 'multi_wear'),
  overshirt: D(['base_top', 'outer_layer'], 'service', 'multi_wear'),
  shoes: D(['footwear'], 'none', 'never'),
  sneakers: D(['footwear'], 'none', 'never'),
  boots: D(['footwear'], 'none', 'never'),
  socks: D(['socks'], 'hand_wash', 'per_wear', 'anonymous_quantity'),
  underwear: D(['underwear'], 'service', 'per_wear', 'anonymous_quantity'),
  belt: D(['belt'], 'none', 'never'),
  scarf: D(['accessory'], 'none', 'multi_wear'),
  hat: D(['accessory'], 'none', 'never'),
  gloves: D(['accessory'], 'none', 'multi_wear'),
  bag: D(['accessory'], 'none', 'never'),
  tie: D(['accessory'], 'none', 'never'),
  accessory: D(['accessory'], 'none', 'never'),
  indoor: D(['indoor'], 'hand_wash', 'per_wear', 'anonymous_quantity'),
};

/** Lowercase, accent-free, punctuation-free phrase used for alias matching. */
export function normalizePhrase(phrase: string): string {
  return phrase
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
