/**
 * Candidate-side kit: runs inside workerd next to the real Worker. It builds the world a case runs in,
 * sends the owner's message through the app's conversation route, and reads what the application did
 * back through the public API. It holds no judging material: what it knows of a case is what the case
 * server gave it (identifier, request, scenario, world; see src/node/outbound.ts).
 */
import { createPrincipal, type Principal } from "@garderobe/domain";
import { importOwnerData } from "@garderobe/domain/import";
import { ownerDocuments } from "@garderobe/domain/testing";
import { ownerDay, provisionOwner, testApp, type TestOwner } from "@garderobe/worker/testing";
import { addDays, exec, liveAt, newPlace, scriptWeather, sleep, wholeWardrobe, type TestPlace, type WardrobeItem } from "../../tests/journeys/src/world.ts";
import type { ProbeReport } from "./node/gateway.mjs";

export const HARNESS = "https://harness.eval-harness.test";

/** The date the corpus fixture calls "today" (fixtures/wardrobe.json `default_date`). Runs happen on the real date; scenario dates are rebased. */
export const FIXTURE_TODAY = "2026-09-15";

export type WorldKind = "owner_real_stock" | "synthetic_fixture";

export interface FixtureItem {
  id: string;
  name: string;
  role: string;
  owned: boolean;
  quantity: number;
  availability: string;
  fabric?: string;
  size?: string;
  care?: string;
  collar?: string;
  footwear_kind?: string;
  exists?: boolean;
}

export interface CandidateCase {
  id: string;
  request: string;
  scenario: Record<string, any>;
  world: WorldKind;
}

export interface CandidateInput {
  split: string;
  driver: "conversation" | "scripted_commands";
  fixture: { items: FixtureItem[]; default_date: string; timezone: string; default_peak_c: number; default_departure_c: number };
  cases: CandidateCase[];
}

export interface World {
  kind: WorldKind;
  owner: TestOwner;
  place: TestPlace;
  /** The owner's local today on the day of the run. */
  today: string;
  day(offset: number): string;
  /** Synthetic world only: corpus fixture ID -> the garment the application created for it. */
  fixture: Map<string, { garmentId: string; name: string }>;
  /** Application garment ID -> fixture ID (synthetic world). */
  fixtureIdOf: Map<string, string>;
  /** Admin principal of this owner, for the two things with no owner route: the import and the model-route probe rows. */
  admin: Principal;
}

/** A scenario date (written against the fixture's today) as the run's date, and back. */
export function rebase(world: Pick<World, "today">, fixtureDate: string): string {
  const delta = Math.round((Date.parse(`${fixtureDate}T00:00:00Z`) - Date.parse(`${FIXTURE_TODAY}T00:00:00Z`)) / 86_400_000);
  return addDays(world.today, delta);
}
export function unrebase(world: Pick<World, "today">, runDate: string): string {
  const delta = Math.round((Date.parse(`${runDate}T00:00:00Z`) - Date.parse(`${world.today}T00:00:00Z`)) / 86_400_000);
  return addDays(FIXTURE_TODAY, delta);
}

const CATEGORY: Record<string, { category: string; roles: string[]; careChannel: string }> = {
  shirt: { category: "shirt", roles: ["top"], careChannel: "service" },
  trousers: { category: "trousers", roles: ["bottom"], careChannel: "service" },
  outerwear: { category: "outerwear", roles: ["outer"], careChannel: "none" },
  shoes: { category: "footwear", roles: ["footwear"], careChannel: "none" },
  socks: { category: "socks", roles: ["socks"], careChannel: "handwash" },
  belt: { category: "belt", roles: ["belt"], careChannel: "none" },
  tie: { category: "tie", roles: ["neckwear"], careChannel: "none" },
  scarf: { category: "scarf", roles: ["neckwear"], careChannel: "none" },
};

/**
 * Thrown by a driver when the application offers no way to put itself into the scenario's starting state.
 * The case is then reported as not run, with this reason: a substituted scenario is never scored.
 */
export class UnsupportedScenario extends Error {}

/** The `garment.create` payload for one corpus fixture item: a labelled SYNTHETIC garment. */
export function fixtureGarmentPayload(item: FixtureItem): Record<string, unknown> {
  const base = CATEGORY[item.role];
  if (!base) throw new Error(`fixture role ${item.role} has no mapping`);
  const lower = `${item.id} ${item.name}`.toLowerCase();
  let { category, roles } = base;
  if (item.id === "shirt-tee") category = "tee";
  if (lower.includes("cardigan")) {
    category = "knitwear";
    roles = ["mid_layer"];
  }
  const attributes: Record<string, unknown> = {};
  if (item.footwear_kind) attributes.footwearKind = item.footwear_kind;
  const model = /990v\d/i.exec(item.name)?.[0];
  if (model) attributes.model = model.toLowerCase();
  const fabric = (item.fabric ?? "").toLowerCase();
  if (fabric.includes("lightweight oxford")) attributes.fabricClass = "lightweight_oxford";
  else if (fabric.includes("heavy oxford") || lower.includes("heavy oxford")) attributes.fabricClass = "heavy_oxford";
  if (item.role === "outerwear" && !lower.includes("cardigan")) attributes.jacketLike = true;
  // The fixture's collar and care facts are kept on the record; the care fact also decides the laundry channel.
  if (item.collar) attributes.collar = item.collar;
  if (item.care) attributes.carePolicy = item.care;
  const care = (item.care ?? "").toLowerCase();
  const careChannel = care.includes("hand-wash") ? "handwash" : care.includes("never laundered") || care.includes("reusable") ? "none" : care.includes("single wear-day") ? "service" : base.careChannel;
  return {
    name: item.name,
    category,
    roles,
    fabric: item.fabric ?? null,
    size: item.size ?? null,
    careChannel,
    acquisition: "owned",
    quantity: item.quantity,
    isSynthetic: true,
    attributes,
    source: { kind: "import", ref: `evals/fixtures/wardrobe.json#${item.id}`, note: "SYNTHETIC evaluation fixture garment (constructed corpus stock, not the owner's)" },
  };
}

async function placeWithWeather(owner: TestOwner, label: string, scenario: Record<string, any>, fixture: CandidateInput["fixture"]): Promise<{ place: TestPlace; today: string }> {
  const today = await ownerDay(owner, 0);
  const place = await newPlace(`Evaluation ${label}`);
  const peak = Number(scenario.peak_c ?? fixture.default_peak_c);
  const departure = Number(scenario.departure_c ?? fixture.default_departure_c);
  const days: Record<string, { morningC: number; peakC: number; eveningC: number }> = {};
  for (let i = -1; i <= 9; i++) days[addDays(today, i)] = { morningC: departure, peakC: peak, eveningC: Math.min(peak, departure + 2) };
  await scriptWeather(place, days);
  await liveAt(owner, place);
  return { place, today };
}

/**
 * Build the world of one case. Every case gets an owner of its own, so no case sees another's state.
 *  - owner_real_stock: the owner's real profile and real inventory, imported by the product's importer.
 *  - synthetic_fixture: a SYNTHETIC owner with the owner's real profile (imported by the same importer,
 *    with the inventory sheet reduced to its header row) and the corpus's constructed fixture wardrobe,
 *    each garment created through the ordinary `garment.create` command and marked synthetic.
 */
export async function buildWorld(c: CandidateCase, fixture: CandidateInput["fixture"]): Promise<World> {
  const app = await testApp();
  if (c.world === "owner_real_stock") {
    const owner = await provisionOwner({ real: true });
    const { place, today } = await placeWithWeather(owner, c.id, c.scenario, fixture);
    const admin = createPrincipal({ userId: owner.userId, actor: "system", channel: "system", scopes: ["read", "write", "admin"], authRef: "evals:harness" });
    return { kind: c.world, owner, place, today, day: (n) => addDays(today, n), fixture: new Map(), fixtureIdOf: new Map(), admin };
  }
  const owner = await provisionOwner({ displayName: "Evaluation fixture owner (SYNTHETIC stock)" });
  const docs = ownerDocuments();
  // The sheet up to and including its header row (it opens with a title row): the same sheet with no stock rows.
  const sheet = docs.inventoryCsv.split(/\r?\n/);
  const headerAt = sheet.findIndex((line) => /^"?Category"?\s*,\s*"?Item"?/.test(line.replace(/^\uFEFF/, "").trim()));
  if (headerAt === -1) throw new Error("the owner's inventory sheet has no header row the synthetic world could keep");
  const header = sheet.slice(0, headerAt + 1).join("\n");
  await importOwnerData(app.service, createPrincipal({ userId: owner.userId, actor: "system", channel: "import", scopes: ["read", "write", "admin"], authRef: "evals:profile-import" }), { profileText: docs.profileText, inventoryCsv: `${header}\n` });
  const { place, today } = await placeWithWeather(owner, c.id, c.scenario, fixture);
  const map = new Map<string, { garmentId: string; name: string }>();
  const back = new Map<string, string>();
  // The fixture's stock is not new today: it has been the owner's for a month, so reports about earlier days find it.
  const ownedSince = `${addDays(today, -30)}T12:00:00.000Z`;
  // Case facts override fixture defaults: a scenario's `stock_override` patches an item before it is created,
  // and a garment the scenario or the fixture gives as unavailable or restricted must be excluded in the
  // application before the request is made.
  const overrides = (c.scenario.stock_override ?? {}) as Record<string, Partial<FixtureItem>>;
  const statedUnavailable = new Set<string>(Array.isArray(c.scenario.unavailable) ? (c.scenario.unavailable as string[]) : []);
  const mustBeExcluded = new Map<string, string>();
  for (const base of fixture.items) {
    const item: FixtureItem = { ...base, ...(overrides[base.id] ?? {}) };
    if (!item.owned || item.exists === false || !(item.quantity > 0)) continue;
    const receipt = await exec(owner.api, "garment.create", fixtureGarmentPayload(item), { occurredAt: ownedSince });
    const garmentId = String(receipt.result.garmentId);
    map.set(item.id, { garmentId, name: item.name });
    back.set(garmentId, item.id);
    const why = statedUnavailable.has(item.id) ? "the scenario gives it as unavailable" : item.availability === "restricted" || item.availability === "unavailable" ? `the corpus fixture gives it as ${item.availability}` : null;
    if (why) mustBeExcluded.set(garmentId, why);
  }
  const excludedNow = async () => new Map((await wholeWardrobe(owner.api)).items.map((i) => [i.garment.garmentId, Boolean(i.availability?.hardExcluded)]));
  let excluded = await excludedNow();
  for (const [garmentId, why] of mustBeExcluded) {
    // Already excluded by the owner's own rules (the profile's footwear restriction, for example): nothing to add.
    if (excluded.get(garmentId)) continue;
    await exec(owner.api, "restriction.add", { kind: "other", scope: { garmentIds: [garmentId] }, reason: `SYNTHETIC evaluation scenario: ${why}`, source: { kind: "import", ref: `evals/fixtures/wardrobe.json#${back.get(garmentId)}`, note: "SYNTHETIC evaluation fixture state" } });
  }
  excluded = await excludedNow();
  const wrong: string[] = [];
  for (const [garmentId, fixtureId] of back) {
    const want = mustBeExcluded.has(garmentId);
    if (excluded.get(garmentId) !== want) wrong.push(`${fixtureId} is ${excluded.get(garmentId) ? "excluded" : "offerable"} in the application but ${want ? `must be excluded (${mustBeExcluded.get(garmentId)})` : "is available in the corpus"}`);
  }
  if (wrong.length > 0) throw new Error(`the synthetic world does not match the corpus's starting state: ${wrong.join("; ")}`);
  const admin = createPrincipal({ userId: owner.userId, actor: "system", channel: "system", scopes: ["read", "write", "admin"], authRef: "evals:harness" });
  return { kind: c.world, owner, place, today, day: (n) => addDays(today, n), fixture: map, fixtureIdOf: back, admin };
}

/**
 * Tell the application what this run's probes of its AI Gateway found, with the product's own command for
 * that (`inference.record_probe`). The product routes a task only to a profile whose required operations
 * passed a probe, so after this the product's routing chooses among the registry profiles that really
 * answered on the gateway, in the registry's order. A failed probe is recorded as failed.
 */
export async function enableGatewayRoutes(world: World): Promise<void> {
  const report = (await (await fetch(`${HARNESS}/probes`)).json()) as ProbeReport;
  const app = await testApp();
  for (const profile of report.profiles) {
    for (const [operation, probe] of Object.entries(profile.operations)) {
      const passed = probe.result === "passed";
      await app.service.execute(world.admin, {
        type: "inference.record_probe",
        payload: {
          profileId: profile.profileId,
          operation,
          result: probe.result,
          billing: passed ? "unified_billing" : "ineligible",
          reason: passed
            ? `Probed by the evaluation harness at ${report.probedAt} over the gateway's HTTP endpoint with no provider key on the request; a key stored on the gateway cannot be told apart from Unified Billing by the answer.`
            : String(probe.reason ?? "the probe failed").slice(0, 500),
          resolvedModel: probe.resolvedModel,
          gatewayId: report.gatewayId,
        },
        idempotencyKey: `eval-probe:${world.owner.userId}:${profile.profileId}:${operation}`,
        expectedVersions: {},
        authorization: "system_schedule",
        source: { channel: "system" },
      });
    }
  }
}

export interface TurnOutcome {
  runId: string;
  state: string;
  replyText: string;
  /** The run document exactly as the API returned it. */
  run: Record<string, any>;
  elapsedMs: number;
}

/** One owner message through the app's conversation route, followed to a settled run (up to 15 minutes). */
export async function say(world: World, text: string, extra: Record<string, unknown> = {}): Promise<TurnOutcome> {
  const started = Date.now();
  const accepted = await world.owner.api.json("POST", "/v1/conversation/turns", { clientTurnId: `eval-${crypto.randomUUID()}`, text, ...extra });
  let run: any;
  for (;;) {
    run = await world.owner.api.json("GET", `/v1/runs/${accepted.runId}`);
    if (["completed", "failed", "cancelled", "needs_input", "resumable"].includes(run.state)) break;
    if (Date.now() - started > 15 * 60_000) break;
    await sleep(500);
  }
  return { runId: accepted.runId, state: run.state, replyText: String(run.result?.reply?.text ?? ""), run, elapsedMs: Date.now() - started };
}

export interface GarmentSnapshot {
  garmentId: string;
  fixtureId: string | null;
  name: string;
  category: string;
  roles: string[];
  acquisition: string;
  synthetic: boolean;
  balances: { bucket: string; quantity: number }[];
  hardExcluded: boolean;
  availability: Record<string, any> | null;
  attributes: Record<string, any>;
}

/** The wardrobe as the application reports it now (every page of `GET /v1/wardrobe`). */
export async function snapshot(world: World): Promise<GarmentSnapshot[]> {
  const { items } = await wholeWardrobe(world.owner.api);
  return items.map((i: WardrobeItem) => ({
    garmentId: i.garment.garmentId,
    fixtureId: world.fixtureIdOf.get(i.garment.garmentId) ?? null,
    name: i.garment.name,
    category: i.garment.category,
    roles: i.garment.roles,
    acquisition: i.garment.acquisition,
    synthetic: Boolean(i.garment.isSynthetic),
    balances: i.balances.filter((b) => b.quantity > 0).map((b) => ({ bucket: b.bucket, quantity: b.quantity })),
    hardExcluded: Boolean(i.availability?.hardExcluded),
    availability: i.availability,
    attributes: i.garment.attributes ?? {},
  }));
}

/** Every stored receipt of this owner, newest first, as `GET /v1/commands` returns them. */
export async function receiptsSince(world: World, sinceIso: string): Promise<Record<string, any>[]> {
  const out: Record<string, any>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const body: any = await world.owner.api.json("GET", `/v1/commands?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const receipts = (body.receipts ?? []) as Record<string, any>[];
    out.push(...receipts);
    cursor = body.nextCursor ?? null;
    if (!cursor || receipts.some((r) => String(r.recordedAt ?? r.occurredAt ?? "") < sinceIso)) break;
  }
  return out.filter((r) => String(r.recordedAt ?? r.occurredAt ?? "9999") >= sinceIso);
}

/** Replace corpus fixture IDs by the garment names the owner would say, and fixture dates by the run's dates, anywhere in a scenario value. */
export function named(world: World, value: unknown): unknown {
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value) ? rebase(world, value) : (world.fixture.get(value)?.name ?? value);
  if (Array.isArray(value)) return value.map((v) => named(world, v));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [world.fixture.get(k)?.name ?? k, named(world, v)]));
  return value;
}

function lines(value: unknown, indent = ""): string[] {
  if (value === null || typeof value !== "object") return [`${indent}${String(value)}`];
  if (Array.isArray(value)) return value.flatMap((v) => (v !== null && typeof v === "object" ? [`${indent}-`, ...lines(v, `${indent}  `)] : [`${indent}- ${String(v)}`]));
  return Object.entries(value).flatMap(([k, v]) => (v !== null && typeof v === "object" ? [`${indent}${k.replace(/_/g, " ")}:`, ...lines(v, `${indent}  `)] : [`${indent}${k.replace(/_/g, " ")}: ${String(v)}`]));
}

/**
 * The owner's message for a case with no behavioural driver: the request, followed by the case's own facts
 * in plain lines (the corpus hands the candidate exactly these two things, `request` and `scenario`).
 * Fixture IDs become the garment names. Nothing else is added: no instruction, no hint, no expected answer.
 */
export function ownerMessage(c: CandidateCase, world: World): string {
  const scenario = { ...c.scenario };
  delete scenario.task;
  delete scenario.requested_count;
  if (Object.keys(scenario).length === 0) return c.request;
  return `${c.request}\n\nWhat applies today:\n${lines(named(world, scenario)).join("\n")}`;
}

export async function record(caseId: string, name: string, body: unknown): Promise<void> {
  const response = await fetch(`${HARNESS}/record?case=${encodeURIComponent(caseId)}&name=${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify(body, null, 1) });
  if (!response.ok) throw new Error(`recorder refused ${caseId}/${name}: ${response.status}`);
}

/** What a behavioural driver works with. */
export interface DriverContext {
  c: CandidateCase;
  world: World;
  /** `conversation`: the owner's message goes to the real model. `scripted_commands`: no inference; see `scripted`. */
  mode: CandidateInput["driver"];
  /** Set by the runner after the owner's message settled (conversation mode). */
  turn: TurnOutcome | null;
  /** Free space for a driver to carry values from `seed` to `observe`. */
  memo: Record<string, any>;
  /** Instant the acting step started (after seeding), for `receiptsSince`. */
  actStartedAt: string;
}

/**
 * A behavioural case: how its scenario becomes application state, and how the outcome is read back.
 *  - `seed` puts the application in the scenario's starting state through ordinary commands and routes.
 *  - `message` is what the owner says (default: the case request). It must not restate seeded state as a
 *    new report, and it must not carry anything the corpus keeps from the candidate.
 *  - `scripted` is used ONLY in `scripted_commands` mode (no model route): the harness issues, as the owner,
 *    the command the owner's sentence plainly states. Such a run tests the ledger, not the assistant, and is
 *    labelled that way in every result.
 *  - `act` (optional) runs after the message in BOTH modes, for the part of a scenario that is not said to
 *    the assistant at all (a second client's report, a scheduled run, a recovery flow).
 *  - `observe` reads the outcome from application state and receipts, in the vocabulary of the corpus's
 *    state assertions. It never returns a constant standing in for an observation.
 */
export interface BehaviourDriver {
  seed(ctx: DriverContext): Promise<void>;
  message?(ctx: DriverContext): string;
  scripted?(ctx: DriverContext): Promise<void>;
  act?(ctx: DriverContext): Promise<void>;
  observe(ctx: DriverContext): Promise<{ observed: Record<string, unknown>; evidence: Record<string, unknown> }>;
}
