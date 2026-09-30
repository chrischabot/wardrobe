import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { DispatchTarget, McpClientLike, McpToolDescriptor } from './registry.js';
import { validateOutboundUrl } from './url-policy.js';

/**
 * Real MCP client over Streamable HTTP (@modelcontextprotocol/client 2.0.0). Every request made by the
 * SDK goes through a fetch that re-validates the destination (including redirects) and adds the
 * connection's resolved credential headers. Written against the SDK's documented API; not exercised
 * against a live remote server in this workstream (tests use in-process fakes).
 */
export async function streamableHttpClient(target: DispatchTarget): Promise<McpClientLike> {
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    validateOutboundUrl(url);
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(target.headers)) headers.set(k, v);
    const res = await fetch(url, { ...init, headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) throw new Error('Redirects are not followed for MCP connections');
    return res;
  };
  const client = new Client({ name: 'garderobe', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(target.url, { fetch: guardedFetch as never });
  await client.connect(transport as never);
  return {
    async listTools(): Promise<McpToolDescriptor[]> {
      const res = await client.listTools();
      return (res.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown>, annotations: t.annotations as McpToolDescriptor['annotations'] }));
    },
    async callTool(name, args, opts) {
      const res = await client.callTool({ name, arguments: args }, { signal: opts.signal } as never);
      return { content: (res.content ?? []) as unknown[], isError: Boolean(res.isError), structuredContent: res.structuredContent };
    },
    async close() {
      await client.close();
    },
  };
}

/** In-process fake MCP server for tests and the simulation. */
export class FakeMcpServer {
  readonly calls: { name: string; args: Record<string, unknown>; target: DispatchTarget }[] = [];
  readonly targets: DispatchTarget[] = [];
  constructor(
    public tools: McpToolDescriptor[],
    public handler: (name: string, args: Record<string, unknown>) => unknown = () => ({ ok: true }),
  ) {}

  factory = async (target: DispatchTarget): Promise<McpClientLike> => {
    this.targets.push(target);
    return {
      listTools: async () => this.tools,
      callTool: async (name, args) => {
        this.calls.push({ name, args, target });
        const out = this.handler(name, args);
        return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] };
      },
    };
  };
}
