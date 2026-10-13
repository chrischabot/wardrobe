/**
 * Test harness: the REAL command service and read API against REAL local D1 inside workerd.
 * Nothing here mocks the ledger. Import only from test files run with the Workers Vitest pool
 * (see `@garderobe/domain/testing/vitest-config`).
 *
 * Every harness creates its own owners with fresh IDs, so tests are independent without having to
 * wipe the database, and cross-owner isolation is exercised constantly.
 */
import { applyD1Migrations, env } from "cloudflare:test";
import type { AuthorizationBasis, Channel, CommandReceipt, Scope, Actor, OwnerSettings } from "@garderobe/contracts";
import { CommandService } from "../commands/service.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import { createFoundationRegistry } from "../foundation.ts";
import { createPrincipal, type Principal } from "../principal.ts";
import { createUser } from "../platform.ts";
import { newId, parseInstant, toInstant } from "../util.ts";
import type { Db } from "../db.ts";
import { SYNTHETIC_WARDROBE, type SyntheticGarment } from "./synthetic.ts";
import { importOwnerData, type OwnerImportResult } from "../import/apply.ts";

export { SYNTHETIC_WARDROBE, SYNTHETIC_LABEL, type SyntheticGarment } from "./synthetic.ts";

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: { name: string; queries: string[] }[];
  OWNER_PROFILE_MD: string;
  OWNER_INVENTORY_CSV: string;
  SUPPLIED_SHA256SUMS: string;
  IMPORT_REPORT_MD: string;
  REQUIREMENT_CHECKLIST_MD: string;
}

/** The supplied owner documents exactly as committed under requirements/ (byte identity is hash-tested). */
export function ownerDocuments(): { profileText: string; inventoryCsv: string; sha256sums: string; importReportMd: string; checklistMd: string } {
  const e = env as unknown as TestEnv;
  return { profileText: e.OWNER_PROFILE_MD, inventoryCsv: e.OWNER_INVENTORY_CSV, sha256sums: e.SUPPLIED_SHA256SUMS, importReportMd: e.IMPORT_REPORT_MD, checklistMd: e.REQUIREMENT_CHECKLIST_MD };
}

let migrated: Promise<void> | null = null;

/** The local D1 database with all repository migrations applied (idempotent). */
export async function testDatabase(): Promise<Db> {
  const e = env as unknown as TestEnv;
  migrated ??= applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
  await migrated;
  return e.DB;
}

/** Deterministic, manually advanced clock. */
export class TestClock {
  private ms: number;
  constructor(startIso = "2026-09-15T08:00:00Z") {
    this.ms = parseInstant(startIso);
  }
  now = (): number => this.ms;
  iso(): string {
    return toInstant(this.ms);
  }
  set(iso: string): void {
    this.ms = parseInstant(iso);
  }
  advance(ms: number): void {
    this.ms += ms;
  }
  advanceMinutes(minutes: number): void {
    this.ms += minutes * 60_000;
  }
}

export interface ExecOptions {
  channel?: Channel;
  actor?: Actor;
  scopes?: Scope[];
  authorization?: AuthorizationBasis;
  idempotencyKey?: string;
  occurredAt?: string;
  expectedVersions?: Record<string, number>;
  clientSubmissionId?: string;
}

export interface TestOwner {
  userId: string;
  /** A principal for this owner on a channel (default: the owner tapping in the iOS app). */
  principal(opts?: { channel?: Channel; actor?: Actor; scopes?: Scope[] }): Principal;
  /** Execute a command through the real service and return the verified receipt. */
  exec(type: string, payload: Record<string, unknown>, opts?: ExecOptions): Promise<CommandReceipt>;
}

export interface Harness {
  db: Db;
  clock: TestClock;
  registry: CommandRegistry;
  service: CommandService;
  createOwner(opts?: { displayName?: string; settings?: Partial<OwnerSettings>; synthetic?: boolean }): Promise<TestOwner>;
  /**
   * The REAL owner fixture: the supplied profile (verbatim) and the real inventory CSV imported through the
   * ordinary command service. Use this for personalization tests; use synthetic owners for boundary cases.
   */
  createRealOwner(): Promise<{ owner: TestOwner; result: OwnerImportResult }>;
  /** A labelled synthetic owner with the synthetic boundary-test wardrobe loaded through real commands. */
  createSyntheticOwner(opts?: { displayName?: string; garments?: SyntheticGarment[]; settings?: Partial<OwnerSettings> }): Promise<TestOwner>;
}

const DEFAULT_AUTH: Record<Actor, AuthorizationBasis> = { owner: "owner_tap", assistant: "owner_statement", system: "system_schedule" };

export async function createHarness(opts: { registry?: CommandRegistry; startAt?: string } = {}): Promise<Harness> {
  const db = await testDatabase();
  const clock = new TestClock(opts.startAt);
  const registry = opts.registry ?? createFoundationRegistry();
  const service = new CommandService({ db, registry, clock: clock.now });

  const makeOwner = (userId: string): TestOwner => {
    const principal: TestOwner["principal"] = (o = {}) =>
      createPrincipal({ userId, actor: o.actor ?? "owner", channel: o.channel ?? "ios", scopes: o.scopes ?? ["read", "write"], authRef: `test:${o.channel ?? "ios"}` });
    return {
      userId,
      principal,
      exec(type, payload, o = {}) {
        const actor = o.actor ?? "owner";
        const channel = o.channel ?? "ios";
        return service.execute(principal({ channel, actor, scopes: o.scopes }), {
          type,
          payload,
          idempotencyKey: o.idempotencyKey ?? `test-${newId("k")}`,
          expectedVersions: o.expectedVersions ?? {},
          ...(o.occurredAt ? { occurredAt: o.occurredAt } : {}),
          authorization: o.authorization ?? DEFAULT_AUTH[actor],
          source: { channel, ...(o.clientSubmissionId ? { clientSubmissionId: o.clientSubmissionId } : {}) },
        });
      },
    };
  };

  const createOwner: Harness["createOwner"] = async (o = {}) => {
    const { userId } = await createUser(db, { displayName: o.displayName ?? "Test owner", isSynthetic: o.synthetic ?? true, settings: o.settings, nowMs: clock.now() });
    return makeOwner(userId);
  };

  const createSyntheticOwner: Harness["createSyntheticOwner"] = async (o = {}) => {
    const owner = await createOwner({ displayName: o.displayName ?? "Synthetic owner (test fixture)", settings: o.settings, synthetic: true });
    for (const g of o.garments ?? SYNTHETIC_WARDROBE) {
      await owner.exec(
        "garment.create",
        {
          garmentId: g.id,
          name: g.name,
          category: g.category,
          roles: g.roles,
          careChannel: g.careChannel,
          fabric: g.fabric ?? null,
          colour: g.colour ?? null,
          attributes: g.attributes ?? {},
          acquisition: g.acquisition ?? "owned",
          quantity: g.quantity ?? 1,
          isSynthetic: true,
          source: { kind: "system", note: "synthetic test fixture - not the owner's wardrobe" },
        },
        { idempotencyKey: `synthetic-seed:${owner.userId}:${g.id}` },
      );
    }
    return owner;
  };

  const createRealOwner: Harness["createRealOwner"] = async () => {
    const owner = await createOwner({ displayName: "Chris (owner data fixture)", synthetic: false });
    const docs = ownerDocuments();
    const result = await importOwnerData(service, owner.principal({ channel: "import", actor: "system", scopes: ["read", "write", "admin"] }), docs);
    return { owner, result };
  };

  return { db, clock, registry, service, createOwner, createSyntheticOwner, createRealOwner };
}
