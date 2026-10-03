/**
 * AI Gateway logs as the provider's record of a dispatched model call, for reconciling reservations whose
 * outcome is not known (see reconcile.ts).
 *
 * Verified on 2026-10-03 against Cloudflare's API reference, "List Gateway Logs"
 * (GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs, permission "AI Gateway Read"): the
 * query parameters used here are `search` ("free-text search over log metadata"), `page` (from 1),
 * `per_page` (1-50), `order_by=created_at` and `order_by_direction`; the answer carries
 * `result_info.total_count`, and each result carries `id`, `success`, `cached`, `model`,
 * `tokens_in`, `tokens_out`, an optional `status_code` and an optional `metadata` string. The reference
 * does not state the format of `metadata` or how a `filters` array is written in a query string, so this
 * adapter does not use `filters`, and it accepts an entry only when its `metadata` parses as a JSON object
 * carrying exactly this call's `garderobe_run` and `garderobe_attempt` (the values gateway.ts sends).
 * Anything else is "not found", which leaves the reservation uncertain. All pages of the search are read,
 * and a reservation is released only when every entry of the call explicitly shows no upstream usage
 * (`findingFrom` below): missing, null, textual or fractional token fields are never read as zero, and a
 * failed call with no tokens counts as "nothing was charged" only when the log records that the provider
 * REFUSED it (see `refusedUpstream`). The log's own `cost` is not used:
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

export interface GatewayLogEntry {
  id?: unknown;
  success?: unknown;
  cached?: unknown;
  model?: unknown;
  tokens_in?: unknown;
  tokens_out?: unknown;
  status_code?: unknown;
  metadata?: unknown;
}

/** A token count exactly as the log gives it: a whole number, zero or more. Anything else is not a count. */
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Whether a log entry is this call's: its metadata must name exactly the same run and exactly the same attempt. */
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
  // The attempt is the number gateway.ts sent, or that number written out in decimal. Never a loose
  // conversion: an absent, empty, boolean or list value is not an attempt number.
  const attempt = m["garderobe_attempt"];
  const sameAttempt = (typeof attempt === "number" && attempt === call.attempt) || (typeof attempt === "string" && attempt === String(call.attempt));
  return m["garderobe_run"] === call.runId.slice(0, 64) && sameAttempt;
}

/** Pages of 50 read for one call before the lookup gives up without a finding. */
const MAX_PAGES = 20;
const PER_PAGE = 50;

/**
 * Whether a failed call's recorded status says the provider refused the request without working on it: a
 * client-error answer (bad request, not authorized, not found, too large, rate limited and the like).
 * Not evidence of that, and so never a reason to release a reservation: a missing or non-numeric status;
 * 408 and 499 (the request timed out or the caller went away, which is how a dropped stream or an owner's
 * stop is recorded while the provider may have billed what it had already processed); and every 5xx (the
 * provider or the Gateway failed part-way, or the Gateway timed out waiting: work may have been done).
 */
export function refusedUpstream(status: unknown): boolean {
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 499 && status !== 408 && status !== 499;
}

/**
 * What the complete set of this call's log entries says. Evidence rules (third review):
 *   - an entry whose token counts are not both whole numbers says nothing reliable, and neither does a
 *     successful, uncached entry with no tokens at all, nor a failed entry with no tokens whose status is
 *     not a provider refusal: the finding is `not_found` and the reservation stays uncertain;
 *   - `charged` when any entry used tokens upstream (not served from cache);
 *   - `not_charged` only when EVERY entry explicitly shows no upstream usage: served from cache, or failed
 *     (`success: false`) with both token counts exactly 0 AND a status that is a provider refusal.
 */
export function findingFrom(entries: GatewayLogEntry[]): ProviderUsageFinding {
  if (entries.length === 0) return { status: "not_found" };
  const ref = `gateway-log:${entries.map((e) => String(e.id)).join(",")}`;
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | null = null;
  for (const e of entries) {
    const tin = count(e.tokens_in);
    const tout = count(e.tokens_out);
    if (typeof e.cached !== "boolean" || typeof e.success !== "boolean") return { status: "not_found" };
    if (e.cached) continue; // answered from the Gateway's cache: nothing was used upstream
    if (tin === null || tout === null) return { status: "not_found" };
    if (tin + tout > 0) {
      inputTokens += tin;
      outputTokens += tout;
      model ??= typeof e.model === "string" ? e.model : null;
      continue;
    }
    // No tokens at all: evidence of no charge only for a call the log itself records as failed because the
    // provider refused it. A timeout, a dropped stream, a stop or a server-side failure may have been billed.
    if (e.success || !refusedUpstream(e.status_code)) return { status: "not_found" };
  }
  if (inputTokens + outputTokens > 0) return { status: "charged", inputTokens, outputTokens, resolvedModel: model, ref };
  return { status: "not_charged", ref };
}

export function createGatewayLogsLookup(options: GatewayLogsOptions): ProviderUsageLookup {
  const doFetch = options.fetch ?? fetch;
  const base = (options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  return {
    async find(call: DispatchedCall): Promise<ProviderUsageFinding> {
      const gatewayId = assertGatewayId(call.gatewayId, options.allowedGatewayIds);
      const entries: GatewayLogEntry[] = [];
      const seen = new Set<string>();
      // Every page of the search is read: an attempt's entries can lie beyond the first fifty when the run
      // ID also matches other attempts or other text. A search that does not end within the page limit
      // gives no finding at all, because the unread part could hold a charged entry.
      for (let page = 1; ; page++) {
        if (page > MAX_PAGES) return { status: "not_found" };
        const url = new URL(`${base}/accounts/${encodeURIComponent(options.accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs`);
        url.searchParams.set("search", call.runId.slice(0, 64));
        url.searchParams.set("page", String(page));
        url.searchParams.set("per_page", String(PER_PAGE));
        url.searchParams.set("order_by", "created_at");
        url.searchParams.set("order_by_direction", "asc");
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 10_000);
        let body: { success?: unknown; result?: unknown; result_info?: { total_count?: unknown } };
        try {
          const response = await doFetch(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${options.apiToken}`, Accept: "application/json" }, redirect: "manual", signal: abort.signal });
          // A redirect is never followed with the token attached; any answer but a plain success is a failed lookup.
          if (response.status !== 200) throw new Error(`the Gateway logs request answered ${response.status}`);
          body = (await response.json()) as typeof body;
        } finally {
          clearTimeout(timer);
        }
        if (body.success !== true || !Array.isArray(body.result)) throw new Error("the Gateway logs answer was not a successful result list");
        const results = body.result as GatewayLogEntry[];
        for (const e of results) {
          if (!e || typeof e !== "object" || typeof e.id !== "string" || seen.has(e.id)) continue;
          seen.add(e.id);
          if (isCall(e, call)) entries.push(e);
        }
        const total = body.result_info?.total_count;
        const complete = typeof total === "number" && Number.isInteger(total) ? page * PER_PAGE >= total : results.length < PER_PAGE;
        if (results.length === 0 || complete) break;
      }
      return findingFrom(entries);
    },
  };
}
