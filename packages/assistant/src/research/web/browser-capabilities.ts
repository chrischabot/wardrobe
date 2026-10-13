/**
 * Browser Run capability families, the probe-gated registry and the list of
 * inference-bearing facilities that stay disabled. Provider tool names are
 * mapped from the pinned release and the discovered catalogue elsewhere; the
 * names here are Garderobe's application-level tools. Re-exported from
 * browser.ts.
 */

export interface BrowserCapability {
  id: string;
  title: string;
  /** Application-level tools in this family. */
  tools: readonly string[];
  intendedUse: string;
}

export const BROWSER_CAPABILITIES = [
  {
    id: "readable_extraction",
    title: "HTML and readable extraction",
    tools: ["content", "markdown", "scrape_elements", "links", "accessibility_tree", "snapshot"],
    intendedUse: "inspect shops and source material",
  },
  {
    id: "captures_documents",
    title: "Captures and documents",
    tools: ["screenshot", "pdf"],
    intendedUse: "retain variant evidence, inspect visual controls, export outfit layouts",
  },
  {
    id: "structured_extraction",
    title: "Structured extraction",
    tools: ["json_validated_against_schema"],
    intendedUse: "derive product and size-chart records from retrieved evidence",
  },
  {
    id: "multi_page_crawl",
    title: "Multi-page research",
    tools: ["crawl_start", "crawl_status", "crawl_results_page", "crawl_cancel"],
    intendedUse: "collect a maker's relevant pages with depth and domain limits",
  },
  {
    id: "browser_sessions",
    title: "Browser sessions",
    tools: ["session_create", "session_reconnect", "session_inspect", "session_close"],
    intendedUse: "bounded remote browser; task identity is kept independently of the browser process",
  },
  {
    id: "interactive_actions",
    title: "Interactive actions",
    tools: [
      "navigate",
      "back",
      "reload",
      "select_tab",
      "click",
      "type",
      "select_option",
      "scroll",
      "keyboard",
      "drag",
      "wait_for",
      "handle_dialog",
    ],
    intendedUse: "semantic page interaction against a fresh observation",
  },
  {
    id: "files_inspection",
    title: "Files and inspection",
    tools: ["upload", "download", "page_screenshot", "console_diagnostics", "network_diagnostics", "session_cookies"],
    intendedUse: "authorized file transfer and diagnostics within the session's access boundary",
  },
  {
    id: "owner_assistance",
    title: "Owner assistance",
    tools: ["live_view", "human_handoff", "resume_task"],
    intendedUse: "blocked or authenticated step with a resumable task and explicit return to the agent",
  },
  {
    id: "page_provided_tools",
    title: "Page-provided tools",
    tools: ["webmcp_discover", "webmcp_call"],
    intendedUse: "WebMCP capabilities under the same origin, authorization and effect policy as browser actions",
  },
] as const satisfies readonly BrowserCapability[];

export type BrowserCapabilityId = (typeof BROWSER_CAPABILITIES)[number]["id"];

export const NOT_PROBED_REASON = "not probed on this deployment";

export interface CapabilityProbe {
  passed: boolean;
  detail: string;
  /** UTC ISO timestamp of the probe. */
  at: string;
}

export interface CapabilityStatus {
  capability: BrowserCapabilityId;
  enabled: boolean;
  /** Why the capability is disabled; null when it is enabled. */
  reason: string | null;
  probe: CapabilityProbe | null;
}

/**
 * Documented availability does not establish support in the selected adapter
 * release: every capability is disabled until a deployed probe passes.
 */
export class CapabilityRegistry {
  private readonly probes = new Map<BrowserCapabilityId, CapabilityProbe>();

  private definition(capability: BrowserCapabilityId): BrowserCapability {
    const found = BROWSER_CAPABILITIES.find((entry) => entry.id === capability);
    if (!found) throw new RangeError(`Unknown browser capability: ${String(capability)}`);
    return found;
  }

  /** Records the latest probe. A later failed probe disables the capability again. */
  recordProbe(capability: BrowserCapabilityId, probe: CapabilityProbe): CapabilityStatus {
    this.definition(capability);
    this.probes.set(capability, { passed: probe.passed, detail: probe.detail, at: probe.at });
    return this.status(capability);
  }

  status(capability: BrowserCapabilityId): CapabilityStatus {
    this.definition(capability);
    const probe = this.probes.get(capability) ?? null;
    if (!probe) return { capability, enabled: false, reason: NOT_PROBED_REASON, probe: null };
    if (!probe.passed) return { capability, enabled: false, reason: `probe failed: ${probe.detail}`, probe };
    return { capability, enabled: true, reason: null, probe };
  }

  isEnabled(capability: BrowserCapabilityId): boolean {
    return this.status(capability).enabled;
  }

  statuses(): CapabilityStatus[] {
    return BROWSER_CAPABILITIES.map((entry) => this.status(entry.id));
  }

  /**
   * Compact one-line descriptions for the on-demand catalogue, so no prompt
   * permanently carries every browser schema.
   */
  describeCatalogue(): string[] {
    return BROWSER_CAPABILITIES.map((entry) => {
      const status = this.status(entry.id);
      const state = status.enabled ? "enabled" : `disabled (${status.reason ?? NOT_PROBED_REASON})`;
      return `${entry.id}: ${entry.title} - ${entry.intendedUse} [${state}]`;
    });
  }

  /** Full detail for one capability, fetched only when it is needed. */
  describeCapability(capability: BrowserCapabilityId): BrowserCapability & { status: CapabilityStatus } {
    const entry = this.definition(capability);
    return { id: entry.id, title: entry.title, tools: [...entry.tools], intendedUse: entry.intendedUse, status: this.status(capability) };
  }
}

export const INFERENCE_ROUTE_REASON =
  "its inference route is not proven to go through Garderobe's AI Gateway";

export interface InferenceBearingFacility {
  id: string;
  title: string;
  enabled: false;
  reason: string;
  /** The compliant path used instead. */
  alternative: string;
}

const RAW_THEN_GATEWAY = "raw Browser Run retrieval followed by the configured Gateway model";

export const INFERENCE_BEARING_FACILITIES: readonly InferenceBearingFacility[] = [
  {
    id: "json_endpoint_extraction",
    title: "JSON endpoint extraction",
    enabled: false,
    reason: INFERENCE_ROUTE_REASON,
    alternative: RAW_THEN_GATEWAY,
  },
  {
    id: "stagehand",
    title: "Stagehand",
    enabled: false,
    reason: INFERENCE_ROUTE_REASON,
    alternative: "accessibility snapshots and semantic actions chosen by the Gateway model",
  },
  {
    id: "visual_action_models",
    title: "Visual action models",
    enabled: false,
    reason: INFERENCE_ROUTE_REASON,
    alternative: "screenshots interpreted by the configured Gateway model",
  },
  {
    id: "crawl_extraction",
    title: "Crawl extraction",
    enabled: false,
    reason: INFERENCE_ROUTE_REASON,
    alternative: RAW_THEN_GATEWAY,
  },
];
