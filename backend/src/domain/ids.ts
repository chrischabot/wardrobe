/** Opaque identifier generation. IDs are type-prefixed random values, never derived from email or names. */
export type IdPrefix =
  | 'usr'
  | 'idn'
  | 'g'
  | 'lot'
  | 'mv'
  | 'ali'
  | 'fct'
  | 'obs'
  | 'cmd'
  | 'eff'
  | 'pre'
  | 'rst'
  | 'bat'
  | 'lex'
  | 'doc'
  | 'rule'
  | 'amd'
  | 'brd'
  | 'opt'
  | 'sel'
  | 'prj'
  | 'ord'
  | 'oln'
  | 'ddl'
  | 'msr'
  | 'imp'
  | 'iss';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Deterministic id for derived entities (e.g. counted wear rows) used in receipts. */
export function dailyWearId(garmentId: string, wearingDate: string): string {
  return `${garmentId}|${wearingDate}`;
}
