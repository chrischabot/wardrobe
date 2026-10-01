/**
 * Catalogue built from tools DISCOVERED on a search connection. Capabilities
 * are resolved from the discovered names and descriptions; documented default
 * names are hints only. Tools that perform provider-side inference stay
 * discovered but disabled. Re-exported from connectors.ts.
 */
import { PrivateForwardingError, assertNoPrivateForwarding, stripGeneratedAnswerOptions } from "./tool-args.ts";
import type { ToolArgs } from "./tool-args.ts";

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export type SearchCapability = "search" | "fetch" | "extract" | "map" | "crawl";

export const PROVIDER_INFERENCE_REASON = "provider-side inference is not routed through Garderobe's AI Gateway";

export interface CatalogEntry {
  name: string;
  description: string;
  discovered: true;
  enabled: boolean;
  /** Why the tool is disabled; null when enabled. */
  reason: string | null;
}

export interface CapabilityResolution {
  tool: string | null;
  reason: string;
}

export type PreparedToolCall = { ok: true; toolName: string; args: ToolArgs } | { ok: false; toolName: string; reason: string };

/** Documented default names. Hints for ranking only; never the only accepted names. */
export const DOCUMENTED_TOOL_NAME_HINTS: Readonly<Record<SearchCapability, readonly string[]>> = {
  search: ["web_search_exa"],
  fetch: ["web_fetch_exa"],
  extract: [],
  map: [],
  crawl: [],
};

const CAPABILITY_KEYWORDS: Readonly<Record<SearchCapability, readonly string[]>> = {
  search: ["search"],
  fetch: ["fetch", "contents"],
  extract: ["extract"],
  map: ["map", "sitemap"],
  crawl: ["crawl"],
};

const INFERENCE_NAME = /research|answer|summar|agent/i;
const INFERENCE_DESCRIPTION =
  /\b(research agent|deep research|agentic|(generat|synthesi[sz])(e|es|ed|ing) (an? |the )?(answer|summary|summaries|report)|(ai|llm)[- ]generated|summari[sz](e|es|ed|ing|ation))\b/i;

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
}

function tokenMatches(token: string, keyword: string): boolean {
  return token === keyword || token === `${keyword}s` || token === `${keyword}ing` || token === `${keyword}er`;
}

function nameMatches(name: string, capability: SearchCapability): boolean {
  const tokens = nameTokens(name);
  return CAPABILITY_KEYWORDS[capability].some((keyword) => tokens.some((token) => tokenMatches(token, keyword)));
}

/** The first sentence of a description states what the tool does. */
function descriptionMatches(description: string, capability: SearchCapability): boolean {
  const lead = (description.split(/[.\n]/)[0] ?? "").toLowerCase();
  return CAPABILITY_KEYWORDS[capability].some((keyword) => new RegExp(`\\b${keyword}(s|es|ing)?\\b`).test(lead));
}

const ALL_CAPABILITIES: readonly SearchCapability[] = ["search", "fetch", "extract", "map", "crawl"];

export class ToolCatalog {
  private readonly byName = new Map<string, CatalogEntry>();

  constructor(tools: DiscoveredTool[]) {
    for (const tool of tools) {
      const description = tool.description ?? "";
      const inference = INFERENCE_NAME.test(tool.name) || INFERENCE_DESCRIPTION.test(description);
      this.byName.set(tool.name, {
        name: tool.name,
        description,
        discovered: true,
        enabled: !inference,
        reason: inference ? PROVIDER_INFERENCE_REASON : null,
      });
    }
  }

  entries(): CatalogEntry[] {
    return [...this.byName.values()].map((entry) => ({ ...entry }));
  }

  /** The entry for a discovered tool, or null when the tool was not discovered. */
  entry(toolName: string): CatalogEntry | null {
    const found = this.byName.get(toolName);
    return found ? { ...found } : null;
  }

  /**
   * Finds an enabled discovered tool for the capability. Ranking: a
   * documented default name, then a name match, then a description whose
   * first sentence names the capability; ties go to the shorter name.
   */
  resolveCapability(capability: SearchCapability): CapabilityResolution {
    const hints = DOCUMENTED_TOOL_NAME_HINTS[capability];
    const ranked: { name: string; score: number; how: string }[] = [];
    let disabledMatch: string | null = null;

    for (const entry of this.byName.values()) {
      let score = 0;
      let how = "";
      if (hints.includes(entry.name)) {
        score = 3;
        how = "documented default name";
      } else if (nameMatches(entry.name, capability)) {
        score = 2;
        how = "discovered tool name";
      } else {
        const namedForAnother = ALL_CAPABILITIES.some((other) => other !== capability && nameMatches(entry.name, other));
        if (!namedForAnother && descriptionMatches(entry.description, capability)) {
          score = 1;
          how = "discovered tool description";
        }
      }
      if (score === 0) continue;
      if (!entry.enabled) {
        disabledMatch = disabledMatch ?? entry.name;
        continue;
      }
      ranked.push({ name: entry.name, score, how });
    }

    ranked.sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      if (left.name.length !== right.name.length) return left.name.length - right.name.length;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    });
    const best = ranked[0];
    if (best) return { tool: best.name, reason: `matched by ${best.how}` };
    if (disabledMatch !== null) {
      return { tool: null, reason: `only "${disabledMatch}" matches "${capability}" and it is disabled: ${PROVIDER_INFERENCE_REASON}` };
    }
    return { tool: null, reason: `no discovered tool provides "${capability}"` };
  }

  /**
   * Refuses undiscovered or disabled tools and arguments that carry private
   * data; otherwise returns the arguments without generated-answer options.
   */
  prepareToolCall(toolName: string, args: ToolArgs): PreparedToolCall {
    const entry = this.byName.get(toolName);
    if (!entry) return { ok: false, toolName, reason: "tool was not discovered on this connection" };
    if (!entry.enabled) return { ok: false, toolName, reason: entry.reason ?? PROVIDER_INFERENCE_REASON };
    try {
      assertNoPrivateForwarding(args);
    } catch (error) {
      if (error instanceof PrivateForwardingError) return { ok: false, toolName, reason: error.message };
      throw error;
    }
    return { ok: true, toolName, args: stripGeneratedAnswerOptions(args) };
  }
}
