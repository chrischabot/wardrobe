import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, define, first, stmt } from "@garderobe/domain";
import { NO_UNDO, money, requireGarments, named } from "./common.ts";

/** A shopping candidate: a product record outside the wardrobe. It never becomes owned stock here. */
export const productRecord = define({
  type: "product.record",
  schema: C["product.record"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const productId = p.productId ?? ctx.newId("prd");
    const existing = await first<{ version: number }>(ctx.db, "SELECT version FROM products WHERE user_id = ? AND product_id = ?", ctx.userId, productId);
    if (existing) {
      return {
        outcome: "merged",
        summary: `Shopping candidate updated: ${named(p.name)}. It is not in your wardrobe`,
        statements: [
          stmt(
            "UPDATE products SET version = version + 1, url = COALESCE(?, url), maker = COALESCE(?, maker), name = ?, product_code = COALESCE(?, product_code), note = COALESCE(?, note), updated_at = ? WHERE user_id = ? AND product_id = ?",
            p.url, p.maker, p.name, p.productCode, p.note, ctx.now, ctx.userId, productId,
          ),
        ],
        affected: [{ kind: "product", id: productId, version: existing.version + 1 }],
        result: { productId },
        undo: NO_UNDO("a candidate record is kept for later reference"),
      };
    }
    return {
      summary: `Shopping candidate saved: ${named(p.name)}${p.maker ? ` (${named(p.maker)})` : ""}. It is not in your wardrobe`,
      statements: [
        stmt(
          "INSERT INTO products (user_id, product_id, version, url, maker, name, product_code, note, source_ref, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, productId, p.url, p.maker, p.name, p.productCode, p.note, p.sourceRef, ctx.now, ctx.now,
        ),
      ],
      affected: [{ kind: "product", id: productId, version: 1 }],
      outbox: [{ topic: "search.index", entityKind: "product", entityId: productId, revision: 1 }],
      result: { productId },
      undo: NO_UNDO("a candidate record is kept for later reference"),
    };
  },
});

/** One dated observation of the exact variant on the page actually checked. */
export const productRecordObservation = define({
  type: "product.record_observation",
  schema: C["product.record_observation"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "system_schedule"],
  async plan(ctx, p) {
    const product = await first<{ name: string; version: number }>(ctx.db, "SELECT name, version FROM products WHERE user_id = ? AND product_id = ?", ctx.userId, p.productId);
    if (!product) throw new CommandError("not_found", `no shopping candidate '${p.productId}'; nothing was written`);
    // A general product page being live does not prove a size is purchasable.
    if (p.availability === "available" && (!p.size || !p.colour)) {
      throw new CommandError("invalid_command", "'available' needs the exact size and colour that were observed; without them availability is 'unknown'");
    }
    if (p.completeness === "failed" && p.availability !== "unknown") {
      throw new CommandError("invalid_command", "a failed extraction cannot establish availability; record it as 'unknown'");
    }
    const observationId = ctx.newId("pob");
    const variant = [p.size, p.colour].filter(Boolean).join(", ");
    const price = p.priceMinor !== null ? `, ${money(p.priceMinor, p.currency)}` : "";
    return {
      summary: `${named(product.name)}${variant ? ` (${named(variant)})` : ""}: ${p.availability} as observed ${p.observedAt}${price}. Stock and price are rechecked before any purchase`,
      statements: [
        stmt(
          `INSERT INTO product_observations (user_id, observation_id, product_id, observed_at, checked_url, availability, size, colour, price_minor, currency, country, method, completeness, facts_json, missing_fields_json, return_terms, command_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ctx.userId, observationId, p.productId, p.observedAt, p.checkedUrl, p.availability, p.size, p.colour, p.priceMinor, p.currency, p.country, p.method, p.completeness, JSON.stringify(p.facts), JSON.stringify(p.missingFields), p.returnTerms, ctx.commandId,
        ),
        stmt("UPDATE products SET version = version + 1, updated_at = ? WHERE user_id = ? AND product_id = ?", ctx.now, ctx.userId, p.productId),
      ],
      affected: [{ kind: "product", id: p.productId, version: product.version + 1 }],
      result: { productId: p.productId, observationId, checkedUrl: p.checkedUrl, observedAt: p.observedAt, availability: p.availability },
      undo: NO_UNDO("an observation is a dated record; a newer one supersedes it"),
    };
  },
});

export const productRecordFitAssessment = define({
  type: "product.record_fit_assessment",
  schema: C["product.record_fit_assessment"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "system_schedule"],
  async plan(ctx, p) {
    const product = await first<{ name: string }>(ctx.db, "SELECT name FROM products WHERE user_id = ? AND product_id = ?", ctx.userId, p.productId);
    if (!product) throw new CommandError("not_found", `no shopping candidate '${p.productId}'; nothing was written`);
    const assessmentId = ctx.newId("fit");
    const uncertain = p.uncertainties.length > 0 ? ` Uncertain: ${p.uncertainties.join("; ")}` : "";
    return {
      summary: `Fit assessment for ${named(product.name)}${p.sizeLabel ? ` in ${named(p.sizeLabel)}` : ""}: ${p.verdict.replace(/_/g, " ")}.${uncertain}`,
      statements: [
        stmt(
          "INSERT INTO fit_assessments (user_id, assessment_id, product_id, size_label, verdict, computation_json, uncertainties_json, measurement_refs_json, command_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ctx.userId, assessmentId, p.productId, p.sizeLabel, p.verdict, JSON.stringify(p.computation), JSON.stringify(p.uncertainties), JSON.stringify(p.measurementRefs), ctx.commandId, ctx.now,
        ),
      ],
      affected: [{ kind: "product", id: p.productId, version: 1 }],
      result: { assessmentId, productId: p.productId, verdict: p.verdict },
      undo: NO_UNDO("an assessment is a dated record"),
    };
  },
});

/** Saved research keeps its citations and its uncertainty; an unsupported claim is stored as unsupported. */
export const researchSaveNote = define({
  type: "research.save_note",
  schema: C["research.save_note"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "system_schedule"],
  async plan(ctx, p) {
    for (const claim of p.claims) {
      if (claim.status === "supported" && claim.support.length === 0) {
        throw new CommandError("invalid_command", `the claim "${claim.text.slice(0, 80)}" is marked supported but cites no passage; store it as unsupported or add its source`);
      }
    }
    await requireGarments(ctx, p.garmentIds);
    const noteId = p.noteId ?? ctx.newId("rsn");
    const existing = await first<{ version: number; status: string }>(ctx.db, "SELECT version, status FROM research_notes WHERE user_id = ? AND note_id = ?", ctx.userId, noteId);
    if (existing?.status === "forgotten") throw new CommandError("forbidden", "this note was forgotten at your request and cannot be rewritten");
    const version = (existing?.version ?? 0) + 1;
    const supported = p.claims.filter((c) => c.status === "supported").length;
    return {
      outcome: existing ? "merged" : "committed",
      summary: `Research saved: ${named(p.topic)} (${p.claims.length} claim${p.claims.length === 1 ? "" : "s"}, ${supported} with independent support)`,
      statements: [
        existing
          ? stmt("UPDATE research_notes SET version = version + 1, topic = ?, body = ?, claims_json = ?, garment_ids_json = ?, product_ids_json = ?, command_id = ?, updated_at = ? WHERE user_id = ? AND note_id = ?", p.topic, p.body, JSON.stringify(p.claims), JSON.stringify(p.garmentIds), JSON.stringify(p.productIds), ctx.commandId, ctx.now, ctx.userId, noteId)
          : stmt(
              "INSERT INTO research_notes (user_id, note_id, version, topic, body, claims_json, garment_ids_json, product_ids_json, status, command_id, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
              ctx.userId, noteId, p.topic, p.body, JSON.stringify(p.claims), JSON.stringify(p.garmentIds), JSON.stringify(p.productIds), ctx.commandId, ctx.now, ctx.now,
            ),
      ],
      affected: [{ kind: "research_note", id: noteId, version }],
      outbox: [{ topic: "search.index", entityKind: "research_note", entityId: noteId, revision: version }],
      result: { noteId },
      undo: NO_UNDO("use Forget to remove saved research"),
    };
  },
});

export const researchHandlers = [productRecord, productRecordObservation, productRecordFitAssessment, researchSaveNote];
