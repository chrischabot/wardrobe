/**
 * AI Gateway logs as the provider's record of a dispatched model call, for reconciling reservations whose
 * outcome is not known (see reconcile.ts).
 *
 * Verified on 2026-10-03 against Cloudflare's API reference, "List Gateway Logs"
 * (GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs, permission "AI Gateway Read"): the
 * query parameters used here are `search` ("free-text search over log metadata"), `per_page` (1-50),
 * `order_by=created_at` and `order_by_direction`; each result carries `id`, `success`, `cached`, `model`,
 * `tokens_in`, `tokens_out`, an optional `status_code` and an optional `metadata` string. The reference
 * does not state the format of `metadata` or how a `filters` array is written in a query string, so this
 * adapter does not use `filters`, and it accepts an entry only when its `metadata` parses as a JSON object
 * carrying exactly this call's `garderobe_run` and `garderobe_attempt` (the values gateway.ts sends).
 * Anything else is "not found", which leaves the reservation uncertain. The log's own `cost` is not used:
 * its unit is not stated, and settlement uses the registry's price for the recorded tokens, as every other
 * settlement does.
 *
 * NEVER RUN AGAINST A REAL GATEWAY. It needs the account ID and an API token limited to "AI Gateway Read",
 * supplied as Worker secrets by the deployment; it is tested only against a fake `fetch`.
 */
import type { DispatchedCall, ProviderUsageFinding, ProviderUsageLookup } from "./reconcile.ts";
import { assertGatewayId } from "./gateway.ts";

export interface GatewayLogsOptions {
  accountId: string;
  /** A Cloudflare API token with "AI Gateway Read" only. Resolved from the Worker's secrets; never stored or logged. */
  apiToken: string;
  fetch?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
  /** Gateways this application may read; defaults to its own. */
  allowedGatewayIds?: readonly string[];
}

interface GatewayLogEntry {
  id?: unknown;
  success?: unknown;
  cached?: unknown;
  model?: unknown;
  tokens_in?: unknown;
  tokens_out?: unknown;
  status_code?: unknown;
  metadata?: unknown;
}

const tokens = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Whether a log entry is this call's: its metadata must name the same run and the same attempt. */
function isCall(entry: GatewayLogEntry, call: DispatchedCall): boolean {
  let meta: unknown = entry.metadata;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return false;
    }
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  const m = meta as Record<string, unknown>;
  return m["garderobe_run"] === call.runId.slice(0, 64) && Number(m["garderobe_attempt"]) === call.attempt;
}

export function createGatewayLogsLookup(options: GatewayLogsOptions): ProviderUsageLookup {
  const doFetch = options.fetch ?? fetch;
  const base = (options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  return {
    async find(call: DispatchedCall): Promise<ProviderUsageFinding> {
      const gatewayId = assertGatewayId(call.gatewayId, options.allowedGatewayIds);
      const url = new URL(`${base}/accounts/${encodeURIComponent(options.accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs`);
      url.searchParams.set("search", call.runId.slice(0, 64));
      url.searchParams.set("per_page", "50");
      url.searchParams.set("order_by", "created_at");
      url.searchParams.set("order_by_direction", "desc");
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 10_000);
      let body: { success?: unknown; result?: unknown };
      try {
        const response = await doFetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${options.apiToken}`, Accept: "application/json" }, redirect: "manual", signal: abort.signal });
        // A redirect is never followed with the token attached; any answer but a plain success is a failed lookup.
        if (response.status !== 200) throw new Error(`the Gateway logs request answered ${response.status}`);
        body = (await response.json()) as { success?: unknown; result?: unknown };
      } finally {
        clearTimeout(timer);
      }
      if (body.success !== true || !Array.isArray(body.result)) throw new Error("the Gateway logs answer was not a successful result list");
      const entries = (body.result as GatewayLogEntry[]).filter((e) => e && typeof e === "object" && typeof e.id === "string" && isCall(e, call));
      if (entries.length === 0) return { status: "not_found" };
      // Every upstream request the Gateway made for this attempt counts; a cached answer used no tokens upstream.
      const charged = entries.filter((e) => e.cached !== true && tokens(e.tokens_in) + tokens(e.tokens_out) > 0);
      const ref = `gateway-log:${entries.map((e) => String(e.id)).join(",")}`;
      if (charged.length === 0) return { status: "not_charged", ref };
      return {
        status: "charged",
        inputTokens: charged.reduce((n, e) => n + tokens(e.tokens_in), 0),
        outputTokens: charged.reduce((n, e) => n + tokens(e.tokens_out), 0),
        resolvedModel: typeof charged[0]!.model === "string" ? (charged[0]!.model as string) : null,
        ref,
      };
    },
  };
}
