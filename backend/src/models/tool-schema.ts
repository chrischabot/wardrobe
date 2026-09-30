import type { LanguageModelV3FunctionTool } from '@ai-sdk/provider';

/**
 * The wire form of tool schemas. Tool input is validated against the tool's own zod schema when a
 * call arrives (AI SDK tool parsing, then the command service), so the JSON Schema sent to the
 * provider only has to describe the input. Two generated parts carry no meaning for a model and
 * cost tokens on every step of every turn:
 *  - the `$schema` dialect URL at the top of each tool;
 *  - the ~210-character leap-year regex zod emits as `pattern` next to `format: "date"` (and the
 *    like for other formats); `format` already says what the string is.
 * Everything else (types, enums, bounds, required fields, descriptions) is sent unchanged.
 */
export function compactToolSchema(schema: unknown): unknown {
  return strip(schema, true);
}

function strip(node: unknown, top: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => strip(n, false));
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (top && k === '$schema') continue;
    if (k === 'pattern' && typeof obj.format === 'string') continue;
    // Property names are data, not keywords: recurse into their schemas without treating the names as keywords.
    out[k] = k === 'properties' && v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([name, s]) => [name, strip(s, false)])) : strip(v, false);
  }
  return out;
}

export function compactTools(tools: LanguageModelV3FunctionTool[] | undefined): LanguageModelV3FunctionTool[] | undefined {
  return tools?.map((t) => ({ ...t, inputSchema: compactToolSchema(t.inputSchema) as LanguageModelV3FunctionTool['inputSchema'] }));
}
