/**
 * Deterministic reads over the ledger that answer recurring questions without asking a model to count:
 *   - wear analysis for a period (specification section 10, research items 42 and 41);
 *   - "what would this displace" for a prospective purchase (section 10, research item 46);
 *   - the full ledger and wear history as paged material for writing (research item 41);
 *   - a recheck of the premises behind remembered conclusions against current records (section 6).
 * Every result states its own limits: recorded wear starts when logging started, so "no recorded wear"
 * is reported as unlogged, never as unworn.
 */
import { all, getStyleContext, isCommandError, json, listCountedWears, listInventory, listRestrictions, type Db, type Principal } from "@garderobe/domain";
import type { MemoryConclusion } from "@garderobe/contracts/ext/assistant";
import { listLifecycleProjects, listOrders, listResearchNotes, listReturnCases } from "./queries.ts";

const WEAR_CAVEAT = "Wear counts cover only what was recorded since logging started for each piece. No recorded wear means unlogged, not unworn.";

function words(text: string | null | undefined): string[] {
  return (text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
}

function overlap(a: string | null | undefined, b: string | null | undefined): boolean {
  const wa = new Set(words(a));
  return words(b).some((w) => wa.has(w));
}

export interface WearAnalysis {
  from: string;
  to: string;
  daysWithRecords: number;
  totalRecordedWears: number;
  byGarment: { garmentId: string; name: string; category: string; wears: number; lastWorn: string }[];
  byCategory: { category: string; wears: number; pieces: number }[];
  noRecordedWear: { garmentId: string; name: string; category: string; wearLoggingSince: string | null }[];
  caveat: string;
}

export async function wearAnalysis(db: Db, principal: Principal, range: { from: string; to: string }, opts: { nowMs?: number; category?: string } = {}): Promise<WearAnalysis> {
  const [wears, inventory] = await Promise.all([listCountedWears(db, principal, range), listInventory(db, principal, {}, opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {})]);
  const owned = inventory.items.filter((i) => i.garment.acquisition === "owned" && (!opts.category || i.garment.category === opts.category));
  const byId = new Map(owned.map((i) => [i.garment.garmentId, i.garment]));
  const counts = new Map<string, { wears: number; lastWorn: string }>();
  for (const w of wears) {
    if (!byId.has(w.garmentId)) continue;
    const c = counts.get(w.garmentId) ?? { wears: 0, lastWorn: w.wearingDate };
    c.wears += 1;
    if (w.wearingDate > c.lastWorn) c.lastWorn = w.wearingDate;
    counts.set(w.garmentId, c);
  }
  const byGarment = [...counts.entries()].map(([garmentId, c]) => ({ garmentId, name: byId.get(garmentId)!.name, category: byId.get(garmentId)!.category, ...c })).sort((a, b) => b.wears - a.wears || (a.name < b.name ? -1 : 1));
  const categories = new Map<string, { wears: number; pieces: Set<string> }>();
  for (const g of byGarment) {
    const c = categories.get(g.category) ?? { wears: 0, pieces: new Set<string>() };
    c.wears += g.wears;
    c.pieces.add(g.garmentId);
    categories.set(g.category, c);
  }
  return {
    from: range.from,
    to: range.to,
    daysWithRecords: new Set(wears.filter((w) => byId.has(w.garmentId)).map((w) => w.wearingDate)).size,
    totalRecordedWears: byGarment.reduce((n, g) => n + g.wears, 0),
    byGarment,
    byCategory: [...categories.entries()].map(([category, c]) => ({ category, wears: c.wears, pieces: c.pieces.size })).sort((a, b) => b.wears - a.wears),
    noRecordedWear: owned.filter((i) => !counts.has(i.garment.garmentId)).map((i) => ({ garmentId: i.garment.garmentId, name: i.garment.name, category: i.garment.category, wearLoggingSince: i.garment.wearLoggingSince })),
    caveat: WEAR_CAVEAT,
  };
}

export interface ProspectivePiece {
  category: string;
  colour?: string | null;
  fabric?: string | null;
  pattern?: string | null;
  maker?: string | null;
}

export interface Displacement {
  prospective: ProspectivePiece;
  /** Owned pieces in the same category, closest first, with the facts that make them close and their recorded wear. */
  overlapping: { garmentId: string; name: string; colour: string | null; fabric: string | null; shared: string[]; recordedWears: number; lastWorn: string | null; availability: string }[];
  ownedInCategory: number;
  /** True when no owned piece shares both category and colour: the purchase would add something not yet covered. */
  addsUncoveredRole: boolean;
  /** Close owned pieces with no recorded wear: the purchase may repeat one that is not being worn (or not being logged). */
  repeatsUnderused: { garmentId: string; name: string; wearLoggingSince: string | null }[];
  window: { from: string; to: string };
  caveat: string;
}

/** Where a prospective purchase would sit among what is already owned. A read: it creates and changes nothing. */
export async function displacementFor(db: Db, principal: Principal, piece: ProspectivePiece, opts: { nowMs: number; localDate: string; windowDays?: number }): Promise<Displacement> {
  const windowDays = opts.windowDays ?? 365;
  const from = new Date(Date.parse(`${opts.localDate}T00:00:00Z`) - windowDays * 86_400_000).toISOString().slice(0, 10);
  const [inventory, wears] = await Promise.all([listInventory(db, principal, { category: piece.category }, { nowMs: opts.nowMs }), listCountedWears(db, principal, { from, to: opts.localDate })]);
  const owned = inventory.items.filter((i) => i.garment.acquisition === "owned" && i.garment.category === piece.category);
  const count = new Map<string, { n: number; last: string }>();
  for (const w of wears) {
    const c = count.get(w.garmentId) ?? { n: 0, last: w.wearingDate };
    c.n += 1;
    if (w.wearingDate > c.last) c.last = w.wearingDate;
    count.set(w.garmentId, c);
  }
  const scored = owned
    .map((i) => {
      const g = i.garment;
      const shared = [overlap(g.colour, piece.colour) ? "colour" : null, overlap(g.fabric, piece.fabric) ? "fabric" : null, overlap(g.pattern, piece.pattern) ? "pattern" : null, overlap(g.maker, piece.maker) ? "maker" : null].filter((x): x is string => !!x);
      const a = i.availability as { status?: string; hardExcluded?: boolean } | null | undefined;
      return { g, shared, wears: count.get(g.garmentId)?.n ?? 0, last: count.get(g.garmentId)?.last ?? null, availability: a ? (a.hardExcluded ? "unavailable" : (a.status ?? "unknown")) : "unknown" };
    })
    .sort((a, b) => b.shared.length - a.shared.length || b.wears - a.wears || (a.g.name < b.g.name ? -1 : 1));
  const close = scored.filter((s) => s.shared.includes("colour") || s.shared.length >= 2);
  return {
    prospective: piece,
    overlapping: scored.slice(0, 12).map((s) => ({ garmentId: s.g.garmentId, name: s.g.name, colour: s.g.colour, fabric: s.g.fabric, shared: s.shared, recordedWears: s.wears, lastWorn: s.last, availability: s.availability })),
    ownedInCategory: owned.length,
    addsUncoveredRole: !scored.some((s) => s.shared.includes("colour")),
    repeatsUnderused: close.filter((s) => s.wears === 0).map((s) => ({ garmentId: s.g.garmentId, name: s.g.name, wearLoggingSince: s.g.wearLoggingSince })),
    window: { from, to: opts.localDate },
    caveat: `${WEAR_CAVEAT} Closeness here is shared recorded facts (colour, fabric, pattern, maker), not a judgement of taste.`,
  };
}

export const LEDGER_SECTIONS = ["garments", "wear", "orders", "returns_and_projects", "research"] as const;
export type LedgerSection = (typeof LEDGER_SECTIONS)[number];

export interface LedgerMaterialPage {
  section: LedgerSection;
  offset: number;
  total: number;
  /** Null when this page reaches the end of the section. */
  nextOffset: number | null;
  entries: Record<string, unknown>[];
  caveat: string;
}

/**
 * The ledger as material for writing, one section and page at a time, in a stable order, so the whole
 * history can be read through without loss. Facts carry their recorded source; nothing is summarized.
 */
export async function ledgerMaterial(db: Db, principal: Principal, input: { section: LedgerSection; offset?: number; limit?: number }, opts: { nowMs?: number } = {}): Promise<LedgerMaterialPage> {
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
  const userId = principal.userId;
  let entries: Record<string, unknown>[] = [];
  let caveat = "These are the recorded facts. Anything not listed here is not recorded and must not be stated as fact.";
  if (input.section === "garments") {
    const inventory = await listInventory(db, principal, {}, opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {});
    const facts = await all<{ garment_id: string; attribute: string; value_json: string; source_json: string }>(db, "SELECT garment_id, attribute, value_json, source_json FROM garment_facts WHERE user_id = ? AND superseded_by IS NULL ORDER BY garment_id, attribute", userId);
    const byGarment = new Map<string, { attribute: string; value: unknown; source: unknown }[]>();
    for (const f of facts) {
      if (!byGarment.has(f.garment_id)) byGarment.set(f.garment_id, []);
      byGarment.get(f.garment_id)!.push({ attribute: f.attribute, value: json(f.value_json, null), source: json(f.source_json, null) });
    }
    entries = [...inventory.items]
      .sort((a, b) => (a.garment.garmentId < b.garment.garmentId ? -1 : 1))
      .map((i) => ({ garmentId: i.garment.garmentId, name: i.garment.name, category: i.garment.category, maker: i.garment.maker, product: i.garment.product, fabric: i.garment.fabric, colour: i.garment.colour, pattern: i.garment.pattern, size: i.garment.size, acquisition: i.garment.acquisition, condition: i.garment.condition, seasonNote: i.garment.seasonNote, ownedUnits: i.totalOwnedUnits, sourcedFacts: byGarment.get(i.garment.garmentId) ?? [] }));
  } else if (input.section === "wear") {
    const wears = await listCountedWears(db, principal, { from: "0000-01-01", to: "9999-12-31" });
    const names = new Map((await listInventory(db, principal, {}, opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {})).items.map((i) => [i.garment.garmentId, i.garment.name]));
    const byDate = new Map<string, string[]>();
    for (const w of wears) {
      if (!byDate.has(w.wearingDate)) byDate.set(w.wearingDate, []);
      byDate.get(w.wearingDate)!.push(names.get(w.garmentId) ?? w.garmentId);
    }
    entries = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([wearingDate, pieces]) => ({ wearingDate, pieces }));
    caveat = WEAR_CAVEAT;
  } else if (input.section === "orders") {
    entries = (await listOrders(db, principal, { limit: 1000 })).map((o) => o as unknown as Record<string, unknown>);
    caveat = "An ordered line is not an arrival and not an owned garment.";
  } else if (input.section === "returns_and_projects") {
    const [returns, projects] = await Promise.all([listReturnCases(db, principal, { open: false }), listLifecycleProjects(db, principal, { open: false })]);
    entries = [...returns.map((r) => ({ record: "return", ...r })), ...projects.map((p) => ({ record: "project", ...p }))];
  } else {
    entries = (await listResearchNotes(db, principal)).map((n) => n as unknown as Record<string, unknown>);
    caveat = "Research claims are as established as their cited support says; a maker's own story is not independent evidence.";
  }
  const total = entries.length;
  const page = entries.slice(offset, offset + limit);
  return { section: input.section, offset, total, nextOffset: offset + page.length < total ? offset + page.length : null, entries: page, caveat };
}

export interface PremiseCheck {
  conclusionId: string;
  premise: { kind: string; ref: string; value: string | null };
  status: "holds" | "changed" | "gone" | "not_checkable";
  current: string | null;
}

/**
 * Compare each recorded premise of a remembered conclusion with the current records. A fit or purchase
 * judgement that rested on a measurement, a garment or a restriction is flagged the moment that changes.
 */
export async function recheckPremises(db: Db, principal: Principal, conclusions: MemoryConclusion[]): Promise<PremiseCheck[]> {
  const withPremises = conclusions.filter((c) => c.premises.length > 0);
  if (withPremises.length === 0) return [];
  const style = await getStyleContext(db, principal).catch((e) => {
    if (isCommandError(e)) return null;
    throw e;
  });
  const measurements = (style?.measurements ?? []).filter((m) => !m.supersededBy);
  const restrictions = await listRestrictions(db, principal, { status: "active" });
  const garments = new Map((await all<{ garment_id: string; acquisition: string; size: string | null }>(db, "SELECT garment_id, acquisition, size FROM garments WHERE user_id = ?", principal.userId)).map((g) => [g.garment_id, g]));
  const out: PremiseCheck[] = [];
  for (const c of withPremises) {
    for (const premise of c.premises) {
      let status: PremiseCheck["status"] = "not_checkable";
      let current: string | null = null;
      if (premise.kind === "measurement") {
        const m = measurements.find((x) => x.measurementId === premise.ref) ?? measurements.find((x) => x.subject === "body" && x.key === premise.ref);
        if (!m) status = "gone";
        else {
          current = `${m.value} ${m.unit}${m.measuredOn ? ` (measured ${m.measuredOn})` : ""}`;
          const recorded = premise.value === null ? null : Number.parseFloat(premise.value);
          status = recorded === null || Number.isNaN(recorded) ? "not_checkable" : Math.abs(recorded - m.value) < 0.01 ? "holds" : "changed";
        }
      } else if (premise.kind === "garment") {
        const g = garments.get(premise.ref);
        if (!g) status = "gone";
        else {
          current = g.acquisition;
          status = g.acquisition === "owned" || g.acquisition === "incoming" ? (premise.value === null || premise.value === g.acquisition ? "holds" : "changed") : "gone";
        }
      } else if (premise.kind === "restriction") {
        const active = restrictions.some((r) => (r as { restrictionId: string }).restrictionId === premise.ref || (r as { kind?: string }).kind === premise.ref);
        current = active ? "active" : "not active";
        status = (premise.value ?? "active") === current ? "holds" : "changed";
      }
      out.push({ conclusionId: c.conclusionId, premise, status, current });
    }
  }
  return out;
}
