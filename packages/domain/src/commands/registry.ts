import type { AuthorizationBasis } from "@garderobe/contracts";
import { CommandError } from "../errors.ts";
import type { CommandDefinition, CommitHook, VersionResolver } from "./types.ts";

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
  private readonly hooks: { name: string; hook: CommitHook }[] = [];

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
