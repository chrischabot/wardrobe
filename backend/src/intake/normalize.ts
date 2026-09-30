/**
 * Normalization for purchase intake (spec section 10, "Purchases from email"). Deduplication uses
 * merchant and order identity plus line identity; product name alone is never an identity.
 */

const MERCHANT_ALIASES: Record<string, string> = {
  drakes: "Drake's",
  'drakes london': "Drake's",
  'drake s': "Drake's",
  'private white vc': 'Private White V.C.',
  'private white v c': 'Private White V.C.',
  'private white': 'Private White V.C.',
  'de bonne facture': 'De Bonne Facture',
  paraboot: 'Paraboot',
  'new balance': 'New Balance',
  'proper cloth': 'Proper Cloth',
  andersons: "Anderson's",
  cordings: 'Cordings',
};

function merchantKey(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(ltd|limited|inc|llc|gmbh|sas|sarl|shop|store|online)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical merchant name used as part of the order's stable identity. */
export function normalizeMerchant(raw: string): string {
  const key = merchantKey(raw);
  return MERCHANT_ALIASES[key] ?? raw.trim().replace(/\s+/g, ' ');
}

/** Order numbers compare without whitespace, leading '#', or case. */
export function normalizeOrderNumber(raw: string): string {
  return raw.trim().replace(/^#/, '').replace(/\s+/g, '').toUpperCase();
}

export function normalizeLineId(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}
