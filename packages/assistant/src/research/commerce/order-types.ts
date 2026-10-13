// Order types and normalization helpers. Re-exported from `orders.ts`.
// Nothing here models arrival or ownership: an order is a record of what the
// merchant's emails say, and a carrier delivery email is only an event.

export interface NormalizedOrderLine {
  lineKey: string;
  productName: string;
  productCode: string | null;
  fabricCode: string | null;
  size: string | null;
  colour: string | null;
  fitOptions: Record<string, string>;
  priceMinor: number | null;
  currency: string | null;
  quantity: number;
  arrivalEstimate: string | null;
  replacesLineKey: string | null;
}

export type OrderEventKind = "confirmation" | "dispatch" | "delivery" | "refund" | "cancellation" | "remake" | "return";

export interface NormalizedOrderEvent {
  kind: OrderEventKind;
  dedupeKey: string;
  occurredAt: string;
  sourceRef: string;
  lineKeys: string[];
  amountMinor: number | null;
}

export interface NormalizedOrder {
  merchant: string;
  merchantKey: string;
  orderNumber: string;
  orderedOn: string | null;
  currency: string | null;
  totalMinor: number | null;
  lines: NormalizedOrderLine[];
  events: NormalizedOrderEvent[];
  replaces: { merchantKey: string; orderNumber: string } | null;
  sourceRefs: string[];
}

export interface OrderEmailLineFact {
  productName: string;
  productCode?: string;
  fabricCode?: string;
  size?: string;
  colour?: string;
  fitOptions?: Record<string, string>;
  /** Decimal string such as "195.00". */
  price?: string;
  currency?: string;
  quantity?: number;
  arrivalEstimate?: string;
}

/** Facts already extracted from ONE email. */
export interface OrderEmailFact {
  kind: OrderEventKind;
  merchant: string;
  orderNumber: string;
  messageId: string;
  threadId?: string;
  /** ISO instant. */
  sentAt: string;
  lines?: OrderEmailLineFact[];
  refundAmount?: string;
  currency?: string;
  total?: string;
  originalOrderNumber?: string;
}

export interface ReconcileIssue { messageId: string; reason: string }
export interface ReconcileResult { orders: NormalizedOrder[]; issues: ReconcileIssue[] }

const LEGAL_SUFFIXES = new Set([
  "ltd", "limited", "inc", "incorporated", "llc", "llp", "plc", "corp", "corporation",
  "co", "company", "gmbh", "ag", "sa", "sas", "sarl", "srl", "spa", "bv", "ab", "oy", "kk",
]);

/** "Drake's" and "DRAKES Ltd." both become "drakes". */
export function normalizeMerchantKey(merchant: string): string {
  const words = merchant
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);
  // Legal suffixes are only stripped from the end, and never the whole name.
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] ?? "")) words.pop();
  return words.join("");
}

/** Trimmed, upper-cased, without a leading "#" or inner whitespace. Empty when absent. */
export function normalizeOrderNumber(orderNumber: string | undefined | null): string {
  return (orderNumber ?? "").trim().replace(/^#+/, "").replace(/\s+/g, "").toUpperCase();
}

/**
 * Decimal string to integer minor units using string arithmetic only, so
 * "195.00" is exactly 19500. Returns null for anything that is not a plain
 * decimal amount with at most two decimal places (never rounds or guesses).
 */
export function toMinor(amount: string | undefined | null): number | null {
  if (amount === undefined || amount === null) return null;
  const match = /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) return null;
  const whole = (match[2] ?? "").replace(/,/g, "");
  const fraction = (match[3] ?? "").padEnd(2, "0");
  const minor = Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction, 10);
  if (!Number.isSafeInteger(minor)) return null;
  return match[1] === "-" && minor !== 0 ? -minor : minor;
}

const normText = (value: string | undefined | null): string => (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const normCode = (value: string | undefined | null): string => (value ?? "").trim().toUpperCase().replace(/\s+/g, "");

function optionsPart(fitOptions: Record<string, string> | undefined): string {
  return Object.entries(fitOptions ?? {})
    .map(([k, v]) => `${normText(k)}=${normText(v)}`)
    .sort()
    .join(",");
}

export type LineIdentity = Pick<OrderEmailLineFact, "productName" | "productCode" | "fabricCode" | "size" | "fitOptions">;

/**
 * Line identity within an order: product code + fabric code + size + sorted
 * fit options. Only when there is no product code does the normalized name
 * stand in for it, still together with fabric, size and options, so a product
 * name alone never makes two lines the same line.
 */
export function lineKeyFor(line: LineIdentity): string {
  const code = normCode(line.productCode);
  const head = code ? `code:${code}` : `name:${normText(line.productName)}`;
  return `${head}|fabric:${normCode(line.fabricCode)}|size:${normCode(line.size)}|opts:${optionsPart(line.fitOptions)}`;
}

/**
 * Identity used only to match a code-less line from a later email (a dispatch
 * or refund that quotes no product code) to one existing line: name + size +
 * options. Callers must require the match to be unique.
 */
export function softLineKeyFor(line: LineIdentity): string {
  return `name:${normText(line.productName)}|size:${normCode(line.size)}|opts:${optionsPart(line.fitOptions)}`;
}

export function orderDedupeKey(merchantKey: string, orderNumber: string, kind: OrderEventKind, messageId: string): string {
  return `${merchantKey}:${orderNumber}:${kind}:${messageId}`;
}

/** Normalizes one extracted line. Unparseable prices stay null. */
export function normalizeLine(line: OrderEmailLineFact, fallbackCurrency: string | null): NormalizedOrderLine {
  const fitOptions: Record<string, string> = {};
  for (const key of Object.keys(line.fitOptions ?? {}).sort()) {
    const value = line.fitOptions?.[key];
    if (value !== undefined) fitOptions[key.trim()] = value.trim();
  }
  const text = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };
  const quantity = line.quantity !== undefined && Number.isInteger(line.quantity) && line.quantity > 0 ? line.quantity : 1;
  return {
    lineKey: lineKeyFor(line),
    productName: line.productName.trim(),
    productCode: text(line.productCode),
    fabricCode: text(line.fabricCode),
    size: text(line.size),
    colour: text(line.colour),
    fitOptions,
    priceMinor: toMinor(line.price),
    currency: text(line.currency)?.toUpperCase() ?? fallbackCurrency,
    quantity,
    arrivalEstimate: text(line.arrivalEstimate),
    replacesLineKey: null,
  };
}
