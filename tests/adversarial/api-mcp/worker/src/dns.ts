/**
 * Dependency-free pieces of the outbound double that test files running INSIDE workerd may import. The double
 * itself (`./outbound.ts`) runs in Node and imports Node-only configuration, so a test file must never import it
 * directly: workerd cannot load `node:*` modules ("No such module node:process").
 */

export interface OutboundScript {
  /** `url`: the exact URL; `prefix`: URLs starting with `key`; `host`: every request to that host. */
  match: "url" | "prefix" | "host";
  key: string;
  status?: number;
  headers?: Record<string, string>;
  /** Response body as text, or `bodyBase64` for bytes. */
  body?: string;
  bodyBase64?: string;
  /** Only for requests with this method (default: any). */
  method?: string;
}

/** The DNS-over-HTTPS resolver the product asks before an outbound request (the Worker's fixture answers only its own hosts). */
export const DNS_RESOLVER = "https://cloudflare-dns.com/dns-query";
/** A public address (example.com's) planted as a host's resolver answer. */
export const PUBLIC_ADDRESS = "93.184.216.34";
/**
 * Script the resolver's answer for `host`: one public A record by default. Every stand-in tool service this
 * suite registers needs one, because the Worker resolves an endpoint before contacting it and refuses a name
 * that does not resolve. A test about private answers plants its own.
 */
export function dnsAnswer(host: string, answers: { type: 1 | 28; data: string }[] = [{ type: 1, data: PUBLIC_ADDRESS }]): OutboundScript {
  return { match: "prefix", key: `${DNS_RESOLVER}?name=${encodeURIComponent(host)}&`, headers: { "content-type": "application/dns-json" }, body: JSON.stringify({ Status: 0, Answer: answers }) };
}
