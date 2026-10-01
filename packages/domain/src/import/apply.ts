import type { CommandReceipt } from "@garderobe/contracts";
import type { CommandService } from "../commands/service.ts";
import type { Principal } from "../principal.ts";
import { sha256Hex } from "../util.ts";
import { detectConflicts, type ConflictFinding } from "./conflicts.ts";
import { buildInventoryImportPlan, type InventoryImportPlan } from "./inventory.ts";
import { HEALING_RESTRICTION, locatePassage, OWNER_PROFILE_DATE, OWNER_PROFILE_SHA256, OWNER_PROFILE_TITLE, PROFILE_MEASUREMENTS, PROFILE_RULES, PROFILE_SIZE_EXPERIENCES } from "./profile.ts";

export const IMPORTER_VERSION = "garderobe-importer/1.0.0";

export interface OwnerImportResult {
  profile: { documentId: string; version: number; contentSha256: string; rules: number; measurements: number; sizeExperiences: number; restrictionId: string };
  inventory: InventoryImportPlan;
  conflicts: ConflictFinding[];
  receipts: number;
  replayed: number;
}

/**
 * Import the owner's profile and inventory through the ordinary command service.
 *
 * The importer is isolated: it only issues typed commands (no direct table writes), every command has a
 * deterministic idempotency key derived from the source hashes, and running it again returns the stored
 * receipts without creating anything twice. The principal must carry the `admin` scope on the `import`
 * channel; the owner it writes to is the principal's owner, never a value from the data.
 */
export async function importOwnerData(service: CommandService, principal: Principal, docs: { profileText: string; inventoryCsv: string }): Promise<OwnerImportResult> {
  const profileSha = await sha256Hex(new TextEncoder().encode(docs.profileText));
  if (profileSha !== OWNER_PROFILE_SHA256) {
    throw new Error(`owner profile hash mismatch: expected ${OWNER_PROFILE_SHA256}, got ${profileSha}. The profile must be imported verbatim.`);
  }
  const plan = await buildInventoryImportPlan(docs.inventoryCsv);
  const conflicts = detectConflicts(plan, docs.profileText);
  let receipts = 0;
  let replayed = 0;
  const exec = async (key: string, type: string, payload: Record<string, unknown>): Promise<CommandReceipt> => {
    const receipt = await service.execute(principal, { type, payload, idempotencyKey: `import:${key}`, authorization: "data_import", source: { channel: "import" } });
    receipts++;
    if (receipt.replayed) replayed++;
    return receipt;
  };
  const profileSource = { kind: "profile_passage" as const, ref: `chris-wardrobe-profile.md@sha256:${profileSha}`, observedAt: `${OWNER_PROFILE_DATE}T00:00:00Z` };
  const p = profileSha.slice(0, 16);

  // 1. The profile, verbatim.
  const doc = await exec(`${p}:profile`, "style.import_document", {
    documentId: "owner-profile",
    title: OWNER_PROFILE_TITLE,
    content: docs.profileText,
    expectedSha256: OWNER_PROFILE_SHA256,
    source: { kind: "import", ref: "chris-wardrobe-profile.md", note: "owner-authored profile, second edition, 14 September 2026" },
  });

  // 2. Machine rules, each quoting the passage it interprets.
  for (const rule of PROFILE_RULES) {
    await exec(`${p}:rule:${rule.key}`, "style.upsert_rule", {
      key: rule.key,
      kind: rule.kind,
      status: rule.status,
      params: rule.params,
      interpretation: rule.interpretation,
      passages: rule.quotes.map((q) => locatePassage(docs.profileText, profileSha, q, rule.section)),
      origin: rule.origin,
    });
  }

  // 3. Dated body facts and maker-specific size experiences.
  for (const m of PROFILE_MEASUREMENTS) {
    await exec(`${p}:measurement:${m.key}`, "measurement.record", {
      subject: "body",
      key: m.key,
      value: m.value,
      unit: m.unit,
      convention: m.convention,
      qualifier: m.qualifier,
      measuredOn: null, // the profile states the values as current on its date; no measuring date is given
      source: profileSource,
      passage: locatePassage(docs.profileText, profileSha, m.quote, "7"),
    });
  }
  for (const [i, s] of PROFILE_SIZE_EXPERIENCES.entries()) {
    await exec(`${p}:size:${i}`, "size_experience.record", {
      maker: s.maker,
      productFamily: s.productFamily,
      sizeLabel: s.sizeLabel,
      note: s.note,
      notedOn: OWNER_PROFILE_DATE,
      passage: locatePassage(docs.profileText, profileSha, s.quote, "7"),
    });
  }

  // 4. The temporary restriction the profile describes: retained until an explicit owner update.
  const { quote, ...restriction } = HEALING_RESTRICTION;
  await exec(`${p}:restriction:healing`, "restriction.add", {
    ...restriction,
    source: { ...profileSource, note: `profile section 8.2, line ${locatePassage(docs.profileText, profileSha, quote).lineStart}` },
  });

  // 5. The inventory: one explicit creation per garment.
  const c = plan.sourceSha256.slice(0, 16);
  for (const g of plan.garments) {
    await exec(`${c}:garment:${g.garmentId}`, "garment.create", g.payload as Record<string, unknown>);
  }

  // 6. Row accounting and issues.
  await exec(`${c}:run`, "import.record_run", {
    importRunId: plan.importRunId,
    sourceName: plan.sourceName,
    sourceSha256: plan.sourceSha256,
    sourceBytes: plan.sourceBytes,
    importer: IMPORTER_VERSION,
    summary: { totals: plan.totals, profileSha256: profileSha, conflicts: conflicts.length },
    rows: plan.rows.map((r) => ({ sourceRow: r.sourceRow, sourceKey: r.sourceKey, disposition: r.disposition, garmentId: r.garmentId, reason: r.reason, raw: r.raw })),
    issues: [
      ...plan.issues.map((i) => ({ issueId: i.issueId, kind: i.kind, severity: i.severity, detail: i.detail, garmentId: i.garmentId, sourceRows: i.sourceRows })),
      ...conflicts.map((f) => ({ issueId: `${plan.importRunId}_${f.id}`, kind: "profile_inventory_conflict", severity: f.severity, detail: `${f.title}. Inventory: ${f.inventoryEvidence} Importer: ${f.importerAction}`, garmentId: null, sourceRows: f.sourceRows })),
    ],
  });

  return {
    profile: {
      documentId: "owner-profile",
      version: Number((doc.result as { version?: number }).version ?? 1),
      contentSha256: profileSha,
      rules: PROFILE_RULES.length,
      measurements: PROFILE_MEASUREMENTS.length,
      sizeExperiences: PROFILE_SIZE_EXPERIENCES.length,
      restrictionId: HEALING_RESTRICTION.restrictionId!,
    },
    inventory: plan,
    conflicts,
    receipts,
    replayed,
  };
}
