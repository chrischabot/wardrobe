import { z } from 'zod';
import { Instant, LocalDate, OpaqueId } from './enums.js';

/**
 * Style documents and machine rules (spec section 6 and section 5 "Style documents and rules").
 *
 * The personal document is stored verbatim with its SHA-256; machine rules reference the exact
 * passage they interpret (section heading plus a quote that must be a verbatim substring of the
 * document version they cite) and record the interpretation separately from the owner's words.
 */

export const RuleStrength = z.enum(['hard', 'soft']);
export type RuleStrength = z.infer<typeof RuleStrength>;

export const RuleKind = z.enum(['hard_rule', 'standing_direction', 'temporary_brief']);
export type RuleKind = z.infer<typeof RuleKind>;

export const RuleCategory = z.enum([
  'socks',
  'footwear',
  'thermal',
  'variety',
  'swap',
  'naming',
  'colour',
  'register',
  'filter',
  'accessories',
  'fabric',
  'construction',
  'size',
  'advice',
  'board_format',
  'day_brief',
  'comfort',
]);
export type RuleCategory = z.infer<typeof RuleCategory>;

/**
 * Which exceptions a rule admits.
 * - none: no exception of any kind (e.g. the medical socks rule)
 * - owner_scoped: an explicit owner temporary brief may relax it for a dated scope
 * - restriction_lift_only: changes only through lifting its restriction with the required evidence
 */
export const ExceptionPolicy = z.enum(['none', 'owner_scoped', 'restriction_lift_only']);
export type ExceptionPolicy = z.infer<typeof ExceptionPolicy>;

export const PassageRef = z.strictObject({
  /** Section heading as written in the document, e.g. "8. Hard constraints". */
  section: z.string().min(1).max(200),
  /** Verbatim quote from the cited document version. */
  quote: z.string().min(1).max(2000),
});
export type PassageRef = z.infer<typeof PassageRef>;

export const StyleDocument = z.object({
  documentId: OpaqueId,
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().nonnegative(),
  isDemo: z.boolean(),
  source: z.enum(['owner_supplied', 'owner_edit', 'import', 'synthetic_test']),
  authoredOn: LocalDate.nullable(),
  importedAt: Instant,
  isCurrent: z.boolean(),
  /** Set on read: 'mismatch' when the stored body no longer matches contentSha256 (tampering, bad restore). */
  integrity: z.enum(['ok', 'mismatch']).optional(),
});
export type StyleDocument = z.infer<typeof StyleDocument>;

export const StyleRule = z.object({
  ruleId: OpaqueId,
  /** Stable key such as "hard.socks_always"; versions of the same rule share it. */
  ruleKey: z.string().min(3).max(80),
  kind: RuleKind,
  strength: RuleStrength,
  category: RuleCategory,
  statement: z.string(),
  interpretation: z.string(),
  /** Machine-checkable parameters for the composer/validator (daily-service enforces them). */
  machine: z.record(z.string(), z.unknown()),
  exceptionPolicy: ExceptionPolicy,
  documentId: OpaqueId.nullable(),
  documentVersion: z.number().int().positive().nullable(),
  passage: PassageRef.nullable(),
  /** 'missing' when a newer document version no longer contains the quoted passage (needs review). */
  passageStatus: z.enum(['present', 'missing', 'not_applicable']),
  overridesRuleKey: z.string().nullable(),
  validFrom: LocalDate.nullable(),
  validTo: LocalDate.nullable(),
  status: z.enum(['active', 'pending_activation', 'retired']),
  source: z.string(),
  version: z.number().int().positive(),
});
export type StyleRule = z.infer<typeof StyleRule>;

/** Rule definition as shipped in data files and the import format. */
export const StyleRuleDefinition = z.strictObject({
  ruleKey: z.string().min(3).max(80).regex(/^[a-z][a-z0-9_.]+$/),
  kind: RuleKind.exclude(['temporary_brief']),
  strength: RuleStrength,
  category: RuleCategory,
  statement: z.string().min(1).max(1000),
  interpretation: z.string().min(1).max(2000),
  machine: z.record(z.string(), z.unknown()).default({}),
  exceptionPolicy: ExceptionPolicy.default('owner_scoped'),
  passage: PassageRef,
  status: z.enum(['active', 'pending_activation', 'retired']).default('active'),
  /** Optional restriction this rule is implemented by (imported with the wardrobe). */
  restrictionSourceId: z.string().max(120).optional(),
});
export type StyleRuleDefinition = z.infer<typeof StyleRuleDefinition>;
export type StyleRuleDefinitionInput = z.input<typeof StyleRuleDefinition>;

export const StyleRuleCatalogue = z.strictObject({
  /** SHA-256 of the document the passages were quoted from. */
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  documentTitle: z.string(),
  rules: z.array(StyleRuleDefinition).min(1),
});
export type StyleRuleCatalogue = z.infer<typeof StyleRuleCatalogue>;
