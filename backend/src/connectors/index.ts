import type { ToolSet } from 'ai';
import type { Principal } from '../domain/principal.js';
import { BUILTIN_TOOL_NAMES } from '../assistant/tools.js';
import { streamableHttpClient } from './mcp-client.js';
import { ConnectionRegistry, EnvCredentialStore, type CredentialStore, type McpClientFactory } from './registry.js';

export * from './url-policy.js';
export * from './redact.js';
export * from './untrusted.js';
export * from './registry.js';
export * from './google.js';
export * from './web.js';
export { streamableHttpClient, FakeMcpServer } from './mcp-client.js';

let testFactory: { clientFactory: McpClientFactory; credentials: CredentialStore } | null = null;

/** Tests and the simulation install fake MCP servers and an in-memory credential store here. */
export function installTestConnectors(deps: { clientFactory: McpClientFactory; credentials: CredentialStore } | null): void {
  testFactory = deps;
}

export function connectionRegistry(env: { DB: D1Database } & Record<string, unknown>, principal: Principal): ConnectionRegistry {
  return new ConnectionRegistry(env.DB, principal, {
    clientFactory: testFactory?.clientFactory ?? streamableHttpClient,
    credentials: testFactory?.credentials ?? new EnvCredentialStore(env),
    builtinToolNames: BUILTIN_TOOL_NAMES,
  });
}

/** Namespaced tools from the owner's approved connections, merged into a turn by the assistant. */
export function createConnectorToolSource(env: object, principal: Principal): { toolSet(principal: Principal, turnId: string): Promise<ToolSet> } {
  return {
    toolSet: async () => connectionRegistry(env as { DB: D1Database } & Record<string, unknown>, principal).toolSet(),
  };
}
