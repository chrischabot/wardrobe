/** Shared setup for the assistant tests: real D1, real command service, real owner data, the real Durable Object. */
import { env } from "cloudflare:test";
import type { CommandReceipt } from "@garderobe/contracts";
import type { TurnRecord } from "@garderobe/contracts/ext/assistant";
import { all, createFoundationRegistry, listInventory, localDateOf, type CommandRegistry, type Db, type Principal } from "@garderobe/domain";
import { HEALING_RESTRICTION_ID } from "@garderobe/domain/import";
import { createHarness, type Harness, type TestOwner } from "@garderobe/domain/testing";
import type { ModelOperation } from "@garderobe/contracts/ext/assistant";
import { assistantClient, registerAssistant, type AssistantClient } from "../src/index.ts";
import { TEST_GATEWAY_ID, resetFakeModels, setTestNow, setTestPorts, fakeModelFor, type CorpusContext, type FakeModel } from "../src/testing/index.ts";

export const START = "2026-09-15T08:00:00Z";

export interface World {
  h: Harness;
  owner: TestOwner;
  client: AssistantClient;
  /** The FAKE MODEL standing in for the primary conversation profile. */
  model: FakeModel;
  garment(search: string): Promise<{ garmentId: string; name: string }>;
  clientFor(principal: Principal): AssistantClient;
}

export async function passProbes(h: Harness, owner: TestOwner, profileId: string, operations: ModelOperation[] = ["text", "tools", "structured_output", "vision"]): Promise<void> {
  for (const operation of operations) {
    await owner.exec(
      "inference.record_probe",
      { profileId, operation, result: "passed", billing: "unified_billing", reason: "TEST FIXTURE: the route is served by the FAKE MODEL; no Gateway was probed", gatewayId: TEST_GATEWAY_ID },
      { actor: "system", channel: "system", scopes: ["read", "write", "admin"], authorization: "system_schedule" },
    );
  }
}

export async function createWorld(opts: { real?: boolean; probes?: string[]; startAt?: string; extend?: (registry: CommandRegistry) => void } = {}): Promise<World> {
  resetFakeModels();
  setTestPorts({});
  setTestNow(opts.startAt ?? START);
  const registry = registerAssistant(createFoundationRegistry());
  opts.extend?.(registry);
  const h = await createHarness({ registry, startAt: opts.startAt ?? START });
  const owner = opts.real === false ? await h.createSyntheticOwner() : (await h.createRealOwner()).owner;
  for (const profileId of opts.probes ?? ["deepseek-v41-flash"]) await passProbes(h, owner, profileId);
  const clientFor = (principal: Principal) => assistantClient(env as never, principal);
  return {
    h,
    owner,
    client: clientFor(owner.principal({ channel: "ios" })),
    model: fakeModelFor("deepseek-v41-flash"),
    clientFor,
    async garment(search: string) {
      const page = await listInventory(h.db, owner.principal(), { search });
      const hit = page.items[0];
      if (!hit) throw new Error(`test setup: no garment matches "${search}"`);
      return { garmentId: hit.garment.garmentId, name: hit.garment.name };
    },
  };
}

let counter = 0;
export function submission(label = "t"): string {
  return `sub-${label}-${Date.now()}-${counter++}`;
}

/** Move both clocks (the harness command service and the conversation actor). */
export function setNow(w: World, iso: string): void {
  w.h.clock.set(iso);
  setTestNow(iso);
}

/**
 * The owner's confirmation of one proposal of a turn, exactly as the Worker's owner-only route carries it
 * out (apps/worker/src/proposals/service.ts): the proposed command runs through the shared command service
 * as the signed-in owner, with `owner_tap`, the proposal's expected versions, and the turn as its parent.
 * The route itself (sign-in, listing, stale and expired proposals, a connected assistant being refused) is
 * tested in apps/worker/test/assistant-confirmation.test.ts.
 */
export async function confirm(w: World, turn: TurnRecord, index = 0): Promise<CommandReceipt> {
  // Read as the route reads it: the stored proposal of the turn, with the versions it was built against.
  const row = await all<{ proposals_json: string }>(w.h.db, "SELECT proposals_json FROM assistant_turns WHERE user_id = ? AND turn_id = ?", w.owner.userId, turn.turnId);
  const proposal = (JSON.parse(row[0]?.proposals_json ?? "[]") as { type: string; payload: Record<string, unknown>; expectedVersions?: Record<string, number> }[])[index];
  if (!proposal) throw new Error(`test setup: the turn has no proposal ${index}`);
  return w.h.service.execute(w.owner.principal({ channel: "ios" }), {
    type: proposal.type,
    payload: proposal.payload,
    idempotencyKey: `proposal:test:${turn.turnId}:${index}`,
    expectedVersions: proposal.expectedVersions ?? {},
    authorization: "owner_tap",
    source: { channel: "ios", parentKind: "turn", parentId: turn.turnId },
  });
}

export function corpusContext(w: World): CorpusContext {
  const today = localDateOf(w.h.clock.now(), "Europe/London");
  return { garment: (search) => w.garment(search), healingRestrictionId: HEALING_RESTRICTION_ID, localDate: today, yesterday: localDateOf(w.h.clock.now() - 86_400_000, "Europe/London") };
}

/**
 * Every table of the database that has a text column, with the rows of `userId` (all rows for a table
 * without an owner column) in which any text column contains `needle`. The table list comes from the
 * database itself, so a table added by a later migration is covered without touching this helper.
 */
export async function tablesHolding(db: Db, userId: string, needle: string | RegExp): Promise<{ scanned: string[]; holding: Record<string, string[]> }> {
  const tables = (await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name")).map((t) => t.name);
  const scanned: string[] = [];
  const holding: Record<string, string[]> = {};
  const test = (v: string) => (typeof needle === "string" ? v.toLowerCase().includes(needle.toLowerCase()) : needle.test(v));
  for (const table of tables) {
    const columns = await all<{ name: string; type: string }>(db, `PRAGMA table_info(${table})`);
    const text = columns.filter((c) => /TEXT|CHAR|CLOB|^$/i.test(c.type)).map((c) => c.name);
    if (text.length === 0) continue;
    scanned.push(table);
    const owned = columns.some((c) => c.name === "user_id");
    const rows = owned ? await all<Record<string, unknown>>(db, `SELECT * FROM ${table} WHERE user_id = ?`, userId) : await all<Record<string, unknown>>(db, `SELECT * FROM ${table}`);
    const hit = new Set<string>();
    for (const row of rows) for (const c of text) if (typeof row[c] === "string" && test(row[c] as string)) hit.add(c);
    if (hit.size > 0) holding[table] = [...hit].sort();
  }
  return { scanned, holding };
}

/**
 * One owner turn followed by the owner's confirmation of every request it left, in order: the journey of
 * an owner who asks for a change and confirms it in the app. Returns the turn with the receipts of the
 * confirmed changes appended to those recorded at once. Throws if a confirmation is refused.
 */
export async function runAndConfirm(w: World, input: Parameters<AssistantClient["runTurn"]>[0]): Promise<TurnRecord & { confirmed: CommandReceipt[] }> {
  const turn = await w.client.runTurn(input);
  const confirmed: CommandReceipt[] = [];
  for (let n = 0; n < turn.proposals.length; n++) confirmed.push(await confirm(w, turn, n));
  return { ...turn, receipts: [...turn.receipts, ...confirmed.map((r) => ({ commandId: r.commandId, type: r.type, outcome: r.outcome, summary: r.summary, undoAvailable: r.undo.available }))], confirmed };
}
