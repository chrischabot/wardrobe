import { all, first, type Db } from "@garderobe/domain";

/**
 * The owner's ledger tables, exported and imported as documented records. Order matters for import:
 * a table appears after everything it references. Every table here carries `user_id`; nothing else
 * is ever read for an export or written by an import.
 */
export interface TableSpec {
  table: string;
  component: string;
  /** Columns never exported (database-local sequence numbers). */
  omit?: string[];
  /** Existing rows of a freshly created owner are replaced rather than duplicated. */
  upsert?: boolean;
  description: string;
}

export const LEDGER_TABLES: TableSpec[] = [
  { table: "commands", component: "receipts", description: "Every committed command with its verified receipt (the audit record of each change, correction and undo)." },
  { table: "command_entities", component: "receipts", description: "Which entities each command touched, with the resulting version." },
  { table: "action_intents", component: "receipts", description: "Registered action intents (stable identity of proposed changes)." },
  { table: "effects", component: "receipts", description: "External effect records (calendar projection, notification...). Their recorded outcome prevents any replay." },
  { table: "garments", component: "inventory", description: "One row per garment or interchangeable group (quantities live in stock_balances)." },
  { table: "garment_aliases", component: "inventory", description: "Names the owner, makers and codes use for a garment." },
  { table: "garment_facts", component: "inventory", description: "Dated facts with their evidence source; corrections supersede, never erase." },
  { table: "restrictions", component: "inventory", description: "Restrictions (healing, tailor, storage...) and what evidence lifts them." },
  { table: "stock_events", component: "quantities", omit: ["seq"], description: "Append-only quantity movements in recorded order; the source of stock_balances." },
  { table: "stock_balances", component: "quantities", description: "Current quantity per garment and bucket (clean, dirty, service, storage, tailor, trip...)." },
  { table: "wear_observations", component: "wear", description: "Every wear report as received (observations; duplicates across clients are kept as provenance)." },
  { table: "daily_wears", component: "wear", description: "The counted wear: at most one per garment and wearing date." },
  { table: "laundry_batches", component: "laundry", description: "Service laundry batches." },
  { table: "laundry_batch_items", component: "laundry", description: "What each batch actually contained and what came back." },
  { table: "laundry_cycles", component: "laundry", description: "Applied weekly cleanliness baselines (an inference under the owner's standing policy, never an observed return)." },
  { table: "laundry_exceptions", component: "laundry", description: "Owner-reported delays, items still away and losses." },
  { table: "exposure_sets", component: "availability", description: "Published sets of offered options used for wear-probability estimates." },
  { table: "exposure_items", component: "availability", description: "Garments in each offered option." },
  { table: "style_documents", component: "style", description: "The profile, every version verbatim with its content hash (originals are never summarised)." },
  { table: "style_amendments", component: "style", description: "Amendments to the profile with their status." },
  { table: "style_rules", component: "style", description: "Standing rules with the profile passages they come from." },
  { table: "standing_directions", component: "style", description: "Standing owner directions." },
  { table: "temporary_briefs", component: "style", description: "Dated temporary briefs." },
  { table: "measurements", component: "style", description: "Body and garment measurements with unit and convention." },
  { table: "size_experiences", component: "style", description: "Size experience by maker." },
  { table: "import_runs", component: "provenance", description: "Data imports with source hashes." },
  { table: "import_refs", component: "provenance", description: "Disposition of every imported source row." },
  { table: "migration_issues", component: "provenance", description: "Conflicts and questions found while importing." },
  { table: "owner_settings", component: "settings", upsert: true, description: "Current settings." },
  { table: "owner_settings_versions", component: "settings", upsert: true, description: "Every settings version." },
  { table: "owner_state", component: "settings", upsert: true, description: "Wardrobe and style revision counters." },
];

export const LEDGER_COMPONENTS: { name: string; title: string }[] = [
  { name: "inventory", title: "Inventory, aliases, facts and restrictions" },
  { name: "quantities", title: "Quantity movements and balances" },
  { name: "wear", title: "Wear observations and daily counted wears" },
  { name: "laundry", title: "Laundry batches, weekly baselines and exceptions" },
  { name: "availability", title: "Offered-option exposure records" },
  { name: "style", title: "Profile originals, amendments, rules, directions, measurements" },
  { name: "settings", title: "Settings and revision counters" },
  { name: "receipts", title: "Command receipts, corrections and external-effect records" },
  { name: "provenance", title: "Import provenance" },
];

/**
 * Tables that are never exported and never importable, whatever a package contains: credentials,
 * verifiers, one-time secrets, sessions, grants and internal queues.
 */
export const NEVER_EXPORTED = [
  "connection_credentials (third-party credentials, encrypted at rest)",
  "connection_oauth_states (one-time authorization state)",
  "recovery_credentials (recovery credential verifiers)",
  "recovery_transactions",
  "owner_invitations",
  "identity_link_tickets",
  "auth_identities (login identities: an import never creates or links a sign-in)",
  "auth_session_floors, auth_rate_limits",
  "mcp_grants and the OAuth provider's KV records (clients, grants, token hashes)",
  "export_tickets, account_deletions",
  "outbox, command_preconditions (internal queues)",
  "browser cookies and raw model reasoning (never stored)",
];

export interface TableDump {
  description: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export async function tableColumns(db: Db, table: string): Promise<string[]> {
  const rows = await all<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}')`);
  return rows.map((r) => r.name);
}

/** Read every row of one owner from one allow-listed table, in stored order, paged by rowid. */
export async function dumpTable(db: Db, spec: TableSpec, userId: string): Promise<TableDump> {
  const all_columns = await tableColumns(db, spec.table);
  if (!all_columns.includes("user_id")) throw new Error(`table ${spec.table} is not owner-qualified`);
  const columns = all_columns.filter((c) => !(spec.omit ?? []).includes(c) && c !== "user_id");
  const select = columns.map((c) => `"${c}"`).join(", ");
  const rows: Record<string, unknown>[] = [];
  let after = 0;
  for (;;) {
    const page = await all<Record<string, unknown> & { _rowid: number }>(db, `SELECT rowid AS _rowid, ${select} FROM ${spec.table} WHERE user_id = ? AND rowid > ? ORDER BY rowid LIMIT 400`, userId, after);
    for (const row of page) {
      after = row._rowid;
      const { _rowid: _ignored, ...rest } = row;
      rows.push(rest);
    }
    if (page.length < 400) break;
  }
  return { description: spec.description, columns, rows };
}

export interface Snapshot {
  takenAt: string;
  wardrobeRevision: number;
  styleRevision: number;
  lastCommandRecordedAt: string | null;
  commandCount: number;
}

/** The version boundary of an export: unchanged between the first and the last read means one coherent state. */
export async function readSnapshot(db: Db, userId: string, takenAt: string): Promise<Snapshot> {
  const state = await first<{ wardrobe_revision: number; style_revision: number }>(db, "SELECT wardrobe_revision, style_revision FROM owner_state WHERE user_id = ?", userId);
  const commands = await first<{ n: number; last: string | null }>(db, "SELECT COUNT(*) AS n, MAX(recorded_at) AS last FROM commands WHERE user_id = ?", userId);
  return { takenAt, wardrobeRevision: state?.wardrobe_revision ?? 0, styleRevision: state?.style_revision ?? 0, lastCommandRecordedAt: commands?.last ?? null, commandCount: commands?.n ?? 0 };
}

export const sameBoundary = (a: Snapshot, b: Snapshot): boolean => a.wardrobeRevision === b.wardrobeRevision && a.styleRevision === b.styleRevision && a.commandCount === b.commandCount && a.lastCommandRecordedAt === b.lastCommandRecordedAt;

/* ------------------------------------------------------------------ */
/* Readable views                                                       */
/* ------------------------------------------------------------------ */

export function csv(header: string[], rows: unknown[][]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    let text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
    // Neutralise spreadsheet formula injection in cells that begin with a formula character.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export const README = (info: { exportedAt: string; formatVersion: string; complete: boolean }) => `# Garderobe wardrobe export

Exported ${info.exportedAt}. Format \`${info.formatVersion}\`. ${info.complete ? "Every component is complete." : "THIS EXPORT IS INCOMPLETE: see `manifest.json` (`components`) for what is missing and why."}

This package is yours and is readable without Garderobe. Nothing in it is needed by any service to
keep working, and it contains no passwords, tokens, recovery codes or sign-in identities.

## What is where

- \`manifest.json\`: format version, export time, the snapshot the export describes, every component
  with its state and record count, and the size and SHA-256 of every file.
- \`checksums.sha256\`: the same checksums in \`sha256sum\` format (\`sha256sum -c checksums.sha256\`).
- \`records/*.json\`: the complete records, one file per component. Each table lists its columns, a
  description and its rows.
- \`views/inventory.csv\`, \`views/wear-history.csv\`, \`views/quantity-movements.csv\`: spreadsheet views.
- \`views/summary.md\`, \`views/profile.md\`, \`views/conversation.md\`: readable views.
- \`media/\`: your photographs and derived images, with their provenance in \`records/media.json\`.

## How the records relate

- A **garment** (\`garments\`) is one piece, or one group of interchangeable pieces such as identical
  socks. Its quantities are in \`stock_balances\`, one row per bucket: clean, dirty, service (at the
  laundry), storage, tailor, trip, incoming (ordered, not arrived) and gone.
- \`stock_events\` is the append-only history those balances are computed from. Row order is the order
  in which the events were recorded; \`occurred_at\` is when the event happened, which can be earlier.
- A **wear** is reported in \`wear_observations\` (every report, from any device) and counted in
  \`daily_wears\`: at most once per garment and wearing date, however many reports arrived.
- \`commands\` holds a receipt for every change ever made, including corrections and undo; a correction
  is a new command, the original is never erased. \`command_entities\` links receipts to what they changed.
- \`effects\` records work for other systems (for example writing the board to Calendar) and whether it
  was completed. They are history: importing this package never repeats them.
- The **profile** (\`style_documents\`) is stored word for word in every version, with its SHA-256.
  \`style_amendments\`, \`style_rules\` and \`standing_directions\` are kept separately from the original.
- Identifiers (\`garment_id\`, \`command_id\`, ...) are stable and are the same after an import.

## Units and dates

- Instants are UTC, ISO 8601 (\`2026-09-15T06:50:00Z\`).
- A **wearing date** (\`wearing_date\`, \`local_date\`) is a calendar date in the owner's timezone (see
  \`owner_settings\`); an overnight wear keeps the date it started on.
- Quantities are whole units (a pair of socks is one unit). Temperatures are in degrees Celsius.
  Measurements carry their own unit and convention in each row.

## Estimates that are not facts

- Availability and cleanliness between observations are estimates. The export contains the observed and
  recorded events they are computed from, not the estimates themselves.
- A weekly laundry baseline (\`laundry_cycles\`) is an inference under your standing instruction, not an
  observed return.
- A wear count of zero means no wear was recorded since logging began, never that the piece is unworn.

## What is not in this package

- Credentials of any kind: sign-in identities and sessions, recovery credentials, connected-assistant
  grants and tokens, and the credentials of Gmail, Calendar or other connections.
- Attachments that only exist in another service (for example an email that was read but not stored),
  and historical images that were never in Garderobe. They are listed as missing where known.
- Raw model reasoning, which is never stored.
- Anything you asked Garderobe to forget.
`;
