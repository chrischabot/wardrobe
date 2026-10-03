import type { AuthorizationBasis } from "@garderobe/contracts";
import { CommandError } from "../errors.ts";
import type { CommandDefinition, CommitHook, EntityCheck, EntityNamer, OwnerStatementVerifier, VersionResolver } from "./types.ts";

const DEFAULT_AUTHORIZATIONS: Record<CommandDefinition["class"], AuthorizationBasis[]> = {
  observation: ["owner_tap", "owner_statement"],
  edit: ["owner_tap", "owner_statement"],
  system: ["standing_policy", "system_schedule"],
};

/**
 * The set of command types the service will execute. There is no generic write: a type that is not
 * registered is rejected. Workstreams register their own definitions, version resolvers and commit
 * hooks on the registry they receive from `createFoundationRegistry()`.
 */
export class CommandRegistry {
  private readonly definitions = new Map<string, CommandDefinition<any>>();
  private readonly resolvers = new Map<string, VersionResolver>();
  private readonly namers = new Map<string, EntityNamer>();
  private readonly checks = new Map<string, EntityCheck>();
  private readonly hooks: { name: string; hook: CommitHook }[] = [];
  private statementVerifier: OwnerStatementVerifier | null = null;

  /**
   * Register how an evidence reference (for example `message:<id>`) is checked against what the owner
   * actually said. The workstream that owns the conversation registers it; the domain never trusts a
   * reference it cannot check, so without a verifier only the owner himself lifts a restriction.
   */
  setOwnerStatementVerifier(verifier: OwnerStatementVerifier): this {
    this.statementVerifier = verifier;
    return this;
  }

  ownerStatementVerifier(): OwnerStatementVerifier | null {
    return this.statementVerifier;
  }

  register(definition: CommandDefinition<any>): this {
    if (this.definitions.has(definition.type)) throw new Error(`command type already registered: ${definition.type}`);
    this.definitions.set(definition.type, definition);
    return this;
  }

  get(type: string): CommandDefinition<any> {
    const def = this.definitions.get(type);
    if (!def) throw new CommandError("unknown_command", `unknown command type '${type}'`, { type });
    return def;
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  types(): string[] {
    return [...this.definitions.keys()].sort();
  }

  allowedAuthorizations(def: CommandDefinition<any>): AuthorizationBasis[] {
    return def.allowedAuthorizations ?? DEFAULT_AUTHORIZATIONS[def.class];
  }

  /** Whether a stale client expected version refuses this command (`conflict`) or is ignored (`rebase`). */
  staleVersionPolicy(def: CommandDefinition<any>): "rebase" | "conflict" {
    return def.staleVersions ?? (def.class === "observation" ? "rebase" : "conflict");
  }

  /** Register how `expectedVersions["<kind>:<id>"]` (or `"<kind>"`) resolves to a current version. */
  registerVersionResolver(kind: string, resolver: VersionResolver): this {
    if (this.resolvers.has(kind)) throw new Error(`version resolver already registered: ${kind}`);
    this.resolvers.set(kind, resolver);
    return this;
  }

  versionResolver(kind: string): VersionResolver | undefined {
    return this.resolvers.get(kind);
  }

  /**
   * Register how a record of this kind is named in the owner's words (for example a trip by its name), so
   * a receipt written by another workstream's command never has to show the record's identifier.
   */
  registerEntityNamer(kind: string, namer: EntityNamer): this {
    if (this.namers.has(kind)) throw new Error(`entity namer already registered: ${kind}`);
    this.namers.set(kind, namer);
    return this;
  }

  entityNamer(kind: string): EntityNamer | undefined {
    return this.namers.get(kind);
  }

  /**
   * Register whether a record of this kind may be the target of a foundation command (for example whether
   * a trip is this owner's and still planned, for `stock.pack`). The workstream that owns the records
   * registers it; without one the foundation command accepts the identifier as it always did.
   */
  registerEntityCheck(kind: string, check: EntityCheck): this {
    if (this.checks.has(kind)) throw new Error(`entity check already registered: ${kind}`);
    this.checks.set(kind, check);
    return this;
  }

  entityCheck(kind: string): EntityCheck | undefined {
    return this.checks.get(kind);
  }

  /**
   * Add writes to every command's batch (same D1 transaction). Used by the daily service to repair
   * open boards inside the commit that changed availability.
   */
  addCommitHook(name: string, hook: CommitHook): this {
    this.hooks.push({ name, hook });
    return this;
  }

  commitHooks(): readonly { name: string; hook: CommitHook }[] {
    return this.hooks;
  }
}
