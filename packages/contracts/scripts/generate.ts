/**
 * Contract code generator for @garderobe/contracts.
 *
 *   npm run generate            write generated/garderobe-contracts.schema.json and generated/swift/GarderobeContracts.swift
 *   npm run generate -- --check exit 1 when the committed files differ from fresh output
 *
 * Sources: every zod schema exported from src/index.ts and from each module in src/ext/*.ts (picked up
 * automatically), plus every payload schema in an exported command map (`FOUNDATION_COMMANDS`, and any
 * `<LANE>_COMMANDS` an extension module exports).
 *
 * Shapes: what the client SENDS is emitted in zod's input shape (fields with a server default are optional):
 * `CommandEnvelope`, the `Command*` payloads and exports named `*Request`, `*Query` or `*Input`. Everything
 * else is a read model or receipt the client RECEIVES and is emitted in zod's output shape.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import * as contracts from "../src/index.ts";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_EXT_DIR = join(PACKAGE_ROOT, "src", "ext");
export const SCHEMA_JSON_PATH = "generated/garderobe-contracts.schema.json";
export const SWIFT_PATH = "generated/swift/GarderobeContracts.swift";
const GENERATOR_PATH = "packages/contracts/scripts/generate.ts";

/** Exported schemas the client sends rather than receives (emitted in input shape under their own name). */
const isSentExport = (name: string): boolean => name === "CommandEnvelope" || /(Request|Query|Input)$/.test(name);
/** Exported maps of command type -> payload schema: `FOUNDATION_COMMANDS`, `DAILY_COMMANDS`, ... */
const COMMAND_MAP_EXPORT = /^[A-Z][A-Z0-9_]*_COMMANDS$/;
/** Suffix of the input-shape variant of a shared schema whose input and output shapes differ. */
const INPUT_SUFFIX = "Input";

export type Io = "input" | "output";

export interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  items?: JsonSchema | boolean;
  prefixItems?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  [keyword: string]: unknown;
}

export interface SchemaEntry {
  /** Name of the `$defs` entry and of the Swift type. */
  name: string;
  schema: z.ZodType;
  io: Io;
  /** Set for the typed payload of a command (`Command*`). */
  commandType?: string;
  origin: string;
}

export interface CollectedSchemas {
  entries: SchemaEntry[];
  commandTypes: string[];
  /** Problems that do not stop generation but that a contract owner should resolve (name clashes between lanes). */
  warnings: string[];
  contractVersion: string;
  apiVersion: string;
}

export interface DefMeta {
  io: Io;
  commandType?: string;
  origin: string;
  /** Set on the exported, parsed (output-shape) form of a command payload: the command type it belongs to. */
  parsedPayloadOf?: string;
}

export interface ContractsDocument {
  $schema: string;
  $id: string;
  $comment: string;
  contractVersion: string;
  apiVersion: string;
  commandTypes: string[];
  $defs: Record<string, JsonSchema>;
}

export interface BuiltContracts {
  /** Property order inside each schema follows the zod declaration order; `renderJsonSchema` sorts keys. */
  document: ContractsDocument;
  meta: Record<string, DefMeta>;
}

export interface GeneratedFile {
  /** Path relative to the package root. */
  path: string;
  content: string;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

/** Locale-independent ordering, so output is identical on every machine. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** `wear.record` -> `CommandWearRecord`. */
export function commandTypeName(commandType: string): string {
  return `Command${pascalCase(commandType)}`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compare)) sorted[key] = sortKeys(source[key]);
  return sorted;
}

const stable = (value: unknown): string => JSON.stringify(sortKeys(value));

const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "dependentSchemas"];
const SCHEMA_KEYWORDS = ["items", "additionalProperties", "propertyNames", "contains", "not", "if", "then", "else", "unevaluatedProperties"];
const SCHEMA_LIST_KEYWORDS = ["prefixItems", "anyOf", "oneOf", "allOf"];

/** Rebuilds a schema bottom-up, passing every (sub)schema through `visit`. Never descends into data such as `default`. */
function mapSchema(schema: JsonSchema, visit: (node: JsonSchema) => JsonSchema): JsonSchema {
  const next: Record<string, unknown> = { ...schema };
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const value = next[keyword];
    if (!isSchema(value)) continue;
    const mapped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) mapped[key] = isSchema(child) ? mapSchema(child, visit) : child;
    next[keyword] = mapped;
  }
  for (const keyword of SCHEMA_KEYWORDS) {
    const value = next[keyword];
    if (isSchema(value)) next[keyword] = mapSchema(value, visit);
  }
  for (const keyword of SCHEMA_LIST_KEYWORDS) {
    const value = next[keyword];
    if (Array.isArray(value)) next[keyword] = value.map((child: unknown) => (isSchema(child) ? mapSchema(child, visit) : child));
  }
  return visit(next as JsonSchema);
}

const DEFS_PREFIX = "#/$defs/";

/** Name a local `$ref` points at; `#` (the root) is reported as the empty string. */
function refTarget(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  if (ref === "#") return "";
  return ref.startsWith(DEFS_PREFIX) ? ref.slice(DEFS_PREFIX.length) : undefined;
}

function collectRefs(schema: JsonSchema): Set<string> {
  const refs = new Set<string>();
  mapSchema(schema, (node) => {
    const target = refTarget(node.$ref);
    if (target !== undefined) refs.add(target);
    return node;
  });
  return refs;
}

function renameRefs(schema: JsonSchema, rename: (target: string) => string): JsonSchema {
  return mapSchema(schema, (node) => {
    const target = refTarget(node.$ref);
    return target === undefined ? node : { ...node, $ref: `${DEFS_PREFIX}${rename(target)}` };
  });
}

/**
 * zod's output shape marks every plain object `additionalProperties: false` because parsing strips unknown
 * keys. For a client that RECEIVES the value this is the wrong message: the contract requires clients to
 * tolerate unknown fields, so read models are published as open objects.
 */
function openObjects(schema: JsonSchema): JsonSchema {
  return mapSchema(schema, (node) => {
    if (node.additionalProperties !== false) return node;
    const { additionalProperties: _closed, ...open } = node;
    return open;
  });
}

/* ------------------------------------------------------------------ */
/* Collection                                                           */
/* ------------------------------------------------------------------ */

/**
 * Collects every schema to generate from: the exports of src/index.ts and of each module in `extDir`
 * (default src/ext, which may be absent or empty), including the payloads of exported command maps.
 */
export async function collectSchemas(options: { extDir?: string } = {}): Promise<CollectedSchemas> {
  interface Candidate {
    name: string;
    schema: z.ZodType;
    origin: string;
    /** Extension lane (file name without `.ts`); undefined for src/index.ts. */
    lane?: string;
  }
  const candidates = new Map<string, Candidate[]>();
  const commands = new Map<string, SchemaEntry>();
  const scan = (moduleExports: Record<string, unknown>, origin: string, lane?: string): void => {
    for (const name of Object.keys(moduleExports).sort(compare)) {
      const value = moduleExports[name];
      if (name === "default") continue;
      if (value instanceof z.ZodType) {
        const sameName = candidates.get(name) ?? [];
        // The same schema re-exported by a second module is one definition, not a clash.
        if (!sameName.some((candidate) => candidate.schema === value)) sameName.push({ name, schema: value, origin, lane });
        candidates.set(name, sameName);
        continue;
      }
      if (!COMMAND_MAP_EXPORT.test(name) || !isSchema(value)) continue;
      const payloads = Object.entries(value);
      if (payloads.length === 0 || !payloads.every(([, schema]) => schema instanceof z.ZodType)) continue;
      for (const [commandType, schema] of payloads) {
        const entry: SchemaEntry = { name: commandTypeName(commandType), schema: schema as z.ZodType, io: "input", commandType, origin: `${name}["${commandType}"] in ${origin}` };
        const earlier = commands.get(commandType);
        if (earlier !== undefined && earlier.schema !== entry.schema) throw new Error(`Command type "${commandType}" has two payload schemas: ${earlier.origin} and ${entry.origin}.`);
        if (earlier === undefined) commands.set(commandType, entry);
      }
    }
  };

  scan({ ...contracts }, "src/index.ts");

  const extDir = options.extDir ?? DEFAULT_EXT_DIR;
  if (existsSync(extDir)) {
    const files = readdirSync(extDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts") && !file.endsWith(".test.ts"))
      .sort(compare);
    for (const file of files) {
      const moduleExports = (await import(pathToFileURL(join(extDir, file)).href)) as Record<string, unknown>;
      scan({ ...moduleExports }, `src/ext/${file}`, file.slice(0, -".ts".length));
    }
  }

  const byName = new Map<string, SchemaEntry>();
  const warnings: string[] = [];
  const add = (entry: SchemaEntry): void => {
    if (!IDENTIFIER.test(entry.name)) throw new Error(`${entry.origin}: "${entry.name}" is not usable as a generated type name`);
    const existing = byName.get(entry.name);
    if (existing !== undefined) throw new Error(`Generated name "${entry.name}" is produced by both ${existing.origin} and ${entry.origin}; rename one of them.`);
    byName.set(entry.name, entry);
  };
  for (const name of [...candidates.keys()].sort(compare)) {
    const sameName = candidates.get(name) ?? [];
    // Two lanes (or a lane and the foundation) using one name for different schemas: a single Swift file and a
    // single `$defs` map cannot hold both, so every lane's definition is qualified with its lane name.
    const qualify = (candidate: Candidate): string => (sameName.length > 1 && candidate.lane !== undefined ? `${pascalCase(candidate.lane)}${name}` : name);
    if (sameName.length > 1) {
      warnings.push(
        `"${name}" is exported with different schemas by ${sameName.map((candidate) => candidate.origin).join(" and ")}; generated as ${sameName.map((candidate) => `"${qualify(candidate)}"`).join(" and ")}.`,
      );
    }
    for (const candidate of sameName) add({ name: qualify(candidate), schema: candidate.schema, io: isSentExport(name) ? "input" : "output", origin: candidate.origin });
  }
  for (const commandType of [...commands.keys()].sort(compare)) {
    const entry = commands.get(commandType);
    if (entry !== undefined) add(entry);
  }

  return {
    entries: [...byName.values()].sort((a, b) => compare(a.name, b.name)),
    commandTypes: [...commands.keys()].sort(compare),
    warnings,
    contractVersion: contracts.CONTRACT_VERSION,
    apiVersion: contracts.API_VERSION,
  };
}

/* ------------------------------------------------------------------ */
/* JSON Schema                                                          */
/* ------------------------------------------------------------------ */

interface Conversion {
  body: JsonSchema;
  /** `$defs` zod produced that are not named exports (anonymous recursive schemas and the like). */
  anonymous: Record<string, JsonSchema>;
}

/**
 * Temporarily gives each named schema its export name as registry `id`, so z.toJSONSchema emits `$ref`s
 * between named schemas instead of inlining them. The registry is restored afterwards.
 */
function withRegisteredNames<T>(named: ReadonlyMap<z.ZodType, string>, run: () => T): T {
  const restore: Array<() => void> = [];
  try {
    for (const [schema, name] of named) {
      const had = z.globalRegistry.has(schema);
      const previous = z.globalRegistry.get(schema);
      restore.push(() => {
        z.globalRegistry.remove(schema);
        if (had && previous !== undefined) z.globalRegistry.add(schema, previous);
      });
      z.globalRegistry.add(schema, { ...previous, id: name });
    }
    return run();
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}

function convert(schema: z.ZodType, io: Io, names: ReadonlySet<string>): Conversion {
  const raw = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    // Dates, transforms, custom types... become `{}` (any JSON) instead of aborting generation.
    unrepresentable: "any",
    cycles: "ref",
    reused: "inline",
  }) as JsonSchema;
  const { $schema: _dialect, $defs: local = {}, ...root } = raw;
  const anonymous: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(local)) if (!names.has(key)) anonymous[key] = value;
  const rootTarget = refTarget(root.$ref);
  const rootDef = rootTarget ? local[rootTarget] : undefined;
  // A named root comes back as `{ $ref: "#/$defs/<name>" }`; unwrap it to the definition itself.
  const body = rootTarget && names.has(rootTarget) && rootDef ? rootDef : root;
  const result = { body, anonymous };
  return io === "output" ? { body: openObjects(result.body), anonymous: mapValues(anonymous, openObjects) } : result;
}

function mapValues<T, U>(record: Record<string, T>, fn: (value: T) => U): Record<string, U> {
  const out: Record<string, U> = {};
  for (const [key, value] of Object.entries(record)) out[key] = fn(value);
  return out;
}

function conversionRefs(conversion: Conversion): Set<string> {
  const refs = collectRefs(conversion.body);
  for (const schema of Object.values(conversion.anonymous)) for (const ref of collectRefs(schema)) refs.add(ref);
  return refs;
}

export function buildContractsDocument(collected: CollectedSchemas): BuiltContracts {
  const exported = collected.entries.filter((entry) => entry.commandType === undefined);
  const commandEntries = collected.entries.filter((entry) => entry.commandType !== undefined);
  const commandTypeOf = new Map<z.ZodType, string>();
  for (const entry of commandEntries) if (entry.commandType !== undefined && !commandTypeOf.has(entry.schema)) commandTypeOf.set(entry.schema, entry.commandType);

  // Name of the input-shape variant of a shared schema whose input and output shapes differ.
  const takenNames = new Set(collected.entries.map((entry) => entry.name));
  const variantNames = new Map<string, string>();
  const variantName = (name: string): string => {
    let variant = variantNames.get(name);
    if (variant === undefined) {
      variant = `${name}${INPUT_SUFFIX}`;
      for (let n = 1; takenNames.has(variant); n += 1) variant = `${name}${INPUT_SUFFIX}Shape${n === 1 ? "" : n}`;
      takenNames.add(variant);
      variantNames.set(name, variant);
    }
    return variant;
  };

  // One registry name per schema instance: the first export name in sorted order. Further names are aliases.
  const primaryName = new Map<z.ZodType, string>();
  for (const entry of exported) if (!primaryName.has(entry.schema)) primaryName.set(entry.schema, entry.name);
  const names = new Set(primaryName.values());

  const output = new Map<string, Conversion>();
  const input = new Map<string, Conversion>();
  const commandInput = new Map<string, Conversion>();
  withRegisteredNames(primaryName, () => {
    for (const [schema, name] of primaryName) {
      output.set(name, convert(schema, "output", names));
      input.set(name, convert(schema, "input", names));
    }
    for (const entry of commandEntries) commandInput.set(entry.name, convert(entry.schema, "input", names));
  });

  // Named schemas whose input shape differs from their output shape, directly or through something they reference.
  const differs = new Set<string>();
  for (const name of names) if (stable(input.get(name)) !== stable(output.get(name))) differs.add(name);
  for (let grew = true; grew; ) {
    grew = false;
    for (const name of names) {
      if (differs.has(name)) continue;
      const conversion = input.get(name);
      if (conversion && [...conversionRefs(conversion)].some((ref) => differs.has(ref))) {
        differs.add(name);
        grew = true;
      }
    }
  }

  const defs: Record<string, JsonSchema> = {};
  const meta: Record<string, DefMeta> = {};
  const place = (target: string, conversion: Conversion, defMeta: DefMeta): void => {
    if (target in defs) throw new Error(`Generated name "${target}" is produced twice (${meta[target]?.origin} and ${defMeta.origin}); rename one of them.`);
    const pending: string[] = [];
    const rename = (ref: string): string => {
      if (ref === "") return target;
      if (ref in conversion.anonymous) return `${target}${pascalCase(ref)}`;
      if (defMeta.io === "input" && differs.has(ref) && !isSentExport(ref)) {
        pending.push(ref);
        return variantName(ref);
      }
      return ref;
    };
    defs[target] = renameRefs(conversion.body, rename);
    meta[target] = defMeta;
    for (const key of Object.keys(conversion.anonymous).sort(compare)) {
      const schema = conversion.anonymous[key];
      const name = `${target}${pascalCase(key)}`;
      if (schema === undefined) continue;
      if (name in defs) throw new Error(`Generated name "${name}" is produced twice; rename ${defMeta.origin}.`);
      defs[name] = renameRefs(schema, rename);
      meta[name] = { io: defMeta.io, origin: defMeta.origin };
    }
    for (const ref of pending.sort(compare)) {
      const variant = variantName(ref);
      const conversionOfRef = input.get(ref);
      if (variant in defs || conversionOfRef === undefined) continue;
      place(variant, conversionOfRef, { io: "input", origin: `input shape of ${ref}` });
    }
  };

  for (const entry of exported) {
    const primary = primaryName.get(entry.schema);
    if (primary === undefined) continue;
    const defMeta: DefMeta = { io: entry.io, origin: entry.origin };
    const parsedPayloadOf = commandTypeOf.get(entry.schema);
    if (parsedPayloadOf !== undefined && entry.io === "output") defMeta.parsedPayloadOf = parsedPayloadOf;
    if (primary !== entry.name) {
      place(entry.name, { body: { $ref: `${DEFS_PREFIX}${primary}` }, anonymous: {} }, defMeta);
      continue;
    }
    const conversion = (entry.io === "input" ? input : output).get(primary);
    if (conversion) place(entry.name, conversion, defMeta);
  }
  for (const entry of commandEntries) {
    const conversion = commandInput.get(entry.name);
    if (conversion) place(entry.name, conversion, { io: "input", commandType: entry.commandType, origin: entry.origin });
  }

  const sortedDefs: Record<string, JsonSchema> = {};
  for (const name of Object.keys(defs).sort(compare)) {
    const schema = defs[name];
    if (schema !== undefined) sortedDefs[name] = schema;
  }

  return {
    document: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "garderobe-contracts",
      $comment:
        `Generated by ${GENERATOR_PATH} from the zod schemas in packages/contracts/src - do not edit by hand. ` +
        "CommandEnvelope, Command*, *Request, *Query and *Input definitions are what a client sends (zod input shape: fields with a server default are optional). " +
        "Every other definition is what a client receives (zod output shape), published as an open object because clients must tolerate unknown fields and unknown enum members.",
      contractVersion: collected.contractVersion,
      apiVersion: collected.apiVersion,
      commandTypes: [...collected.commandTypes],
      $defs: sortedDefs,
    },
    meta,
  };
}

/** Serialises the document with every object key sorted, two-space indentation and a trailing newline. */
export function renderJsonSchema(document: ContractsDocument): string {
  return `${JSON.stringify(sortKeys(document), null, 2)}\n`;
}

/* ------------------------------------------------------------------ */
/* Swift                                                                */
/* ------------------------------------------------------------------ */

const SWIFT_KEYWORDS: ReadonlySet<string> = new Set([
  "Any", "Protocol", "Self", "Type", "as", "associatedtype", "break", "case", "catch", "class", "continue", "default", "defer", "deinit",
  "do", "else", "enum", "extension", "fallthrough", "false", "fileprivate", "for", "func", "guard", "if", "import", "in", "init", "inout",
  "internal", "is", "let", "nil", "operator", "precedencegroup", "private", "protocol", "public", "repeat", "rethrows", "return", "self",
  "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where", "while",
]);

/** Names the generated support code owns; a contract schema may not take them. */
const SWIFT_SUPPORT_TYPES: ReadonlySet<string> = new Set(["GarderobeContract", "GarderobeCommandPayload", "JSONValue", "JSONCodingKey", "Nullable"]);

/** Names a nested type must not take: Swift forbids some, the others would shadow a type the generated code uses. */
const SWIFT_RESERVED_NESTED: ReadonlySet<string> = new Set([
  ...SWIFT_SUPPORT_TYPES,
  "Type", "Protocol", "Self", "Any", "CodingKeys", "String", "Int", "Double", "Bool", "Set", "Array", "Dictionary", "Optional",
  "Decoder", "Encoder", "Codable", "Sendable", "Equatable", "CaseIterable", "Error",
]);

const INDENT = "    ";
const indent = (lines: string[]): string[] => lines.map((line) => (line === "" ? "" : `${INDENT}${line}`));

function swiftString(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) out += `\\u{${code.toString(16).toUpperCase()}}`;
    else out += char;
  }
  return `"${out}"`;
}

const escapeIdentifier = (identifier: string): string => (SWIFT_KEYWORDS.has(identifier) ? `\`${identifier}\`` : identifier);

/** lowerCamelCase Swift identifier (without backticks) for a JSON key or enum value. */
function swiftIdentifier(raw: string, fallback: string): string {
  if (IDENTIFIER.test(raw) && !raw.includes("_")) return raw;
  const pascal = pascalCase(raw);
  if (pascal === "") return fallback;
  const camel = pascal === pascal.toUpperCase() ? pascal.toLowerCase() : pascal.charAt(0).toLowerCase() + pascal.slice(1);
  return /^[0-9]/.test(camel) ? `_${camel}` : camel;
}

function unique(candidate: string, taken: Set<string>): string {
  let name = candidate;
  for (let n = 2; taken.has(name); n += 1) name = `${candidate}${n}`;
  taken.add(name);
  return name;
}

function docLines(text: string | undefined): string[] {
  if (text === undefined || text.trim() === "") return [];
  return text.split(/\r?\n/).map((line) => (line.trim() === "" ? "///" : `/// ${line.trim()}`));
}

interface SwiftContext {
  /** Every top-level type name, including nested declarations hoisted next to a typealias. */
  topLevel: Set<string>;
  usesNullable: boolean;
  usesCodingKey: boolean;
}

interface SwiftScope {
  /** Where nested type declarations are collected. */
  declarations: string[][];
  /** Type names already taken in this scope (its own nested types and the enclosing types). */
  taken: Set<string>;
  enclosing: string[];
  /** The enclosing definition can be part of a request the client sends. */
  sent: boolean;
  context: SwiftContext;
}

interface ResolvedType {
  type: string;
  nullable: boolean;
  /** Unconstrained JSON: `JSONValue`, which already covers null. */
  any: boolean;
}

const ANY_TYPE: ResolvedType = { type: "JSONValue", nullable: false, any: true };
const isNullSchema = (schema: JsonSchema): boolean => schema.type === "null";
const isStringEnum = (schema: JsonSchema): boolean =>
  Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value) => typeof value === "string") && !Array.isArray(schema.type);
const hasProperties = (schema: JsonSchema): boolean => schema.type === "object" && schema.properties !== undefined && Object.keys(schema.properties).length > 0;

function claimTypeName(hint: string, scope: SwiftScope): string {
  const base = IDENTIFIER.test(hint) ? hint : `_${pascalCase(hint)}`;
  let name = base;
  for (let n = 1; SWIFT_RESERVED_NESTED.has(name) || scope.context.topLevel.has(name) || scope.taken.has(name); n += 1) {
    name = n === 1 ? `${base}Value` : `${base}Value${n}`;
  }
  scope.taken.add(name);
  return name;
}

function elementType(resolved: ResolvedType): string {
  return resolved.nullable && !resolved.any ? `${resolved.type}?` : resolved.type;
}

/** Swift type for a schema used as a property, element or alias target; declares nested types into the scope. */
function resolveType(schema: JsonSchema | boolean | undefined, hint: string, scope: SwiftScope): ResolvedType {
  if (schema === undefined || typeof schema === "boolean") return ANY_TYPE;
  const ref = refTarget(schema.$ref);
  if (ref !== undefined && ref !== "") return { type: ref, nullable: false, any: false };

  const union = schema.anyOf ?? schema.oneOf;
  if (union !== undefined) {
    const members = union.filter((member) => !isNullSchema(member));
    const nullable = members.length < union.length;
    const only = members[0];
    if (members.length === 1 && only !== undefined) {
      const inner = resolveType(only, hint, scope);
      return { ...inner, nullable: inner.nullable || nullable };
    }
    // A union of literals (`z.union([z.literal(160), z.literal(320)])`) is an enum or a plain scalar.
    const literals = members.map((member) => ("const" in member && member.$ref === undefined ? member.const : undefined));
    if (members.length > 0 && literals.every((value): value is string => typeof value === "string")) {
      return resolveType({ type: "string", enum: [...literals, ...(nullable ? [null] : [])] }, hint, scope);
    }
    if (members.length > 0 && literals.every((value): value is number => typeof value === "number")) {
      return { type: literals.every((value) => Number.isInteger(value)) ? "Int" : "Double", nullable, any: false };
    }
    return ANY_TYPE; // a real union: no faithful Codable form without a discriminator convention
  }
  if (schema.allOf !== undefined) {
    const only = schema.allOf[0];
    return schema.allOf.length === 1 && only !== undefined ? resolveType(only, hint, scope) : ANY_TYPE;
  }

  let type: string | undefined;
  let nullable = false;
  if (Array.isArray(schema.type)) {
    const rest = schema.type.filter((member) => member !== "null");
    nullable = rest.length < schema.type.length;
    if (rest.length !== 1) return ANY_TYPE;
    type = rest[0];
  } else {
    type = schema.type;
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((value) => value !== null);
    if (values.length < schema.enum.length) nullable = true;
    if (values.length === 0 || !values.every((value): value is string => typeof value === "string")) return ANY_TYPE;
    const name = claimTypeName(hint, scope);
    scope.declarations.push(renderEnum(name, values, docLines(undefined)));
    return { type: name, nullable, any: false };
  }
  if ("const" in schema) {
    const value = schema.const;
    if (typeof value === "string") return { type: "String", nullable, any: false };
    if (typeof value === "boolean") return { type: "Bool", nullable, any: false };
    if (typeof value === "number") return { type: Number.isInteger(value) ? "Int" : "Double", nullable, any: false };
    return ANY_TYPE;
  }

  switch (type) {
    case "string":
      return { type: "String", nullable, any: false };
    case "integer":
      return { type: "Int", nullable, any: false };
    case "number":
      return { type: "Double", nullable, any: false };
    case "boolean":
      return { type: "Bool", nullable, any: false };
    case "array": {
      if (schema.prefixItems !== undefined) return { type: "[JSONValue]", nullable, any: false }; // tuple
      return { type: `[${elementType(resolveType(schema.items, `${hint}Item`, scope))}]`, nullable, any: false };
    }
    case "object": {
      if (hasProperties(schema)) {
        const name = claimTypeName(hint, scope);
        scope.declarations.push(renderStruct(name, schema, { doc: [], enclosing: scope.enclosing, sent: scope.sent, context: scope.context }));
        return { type: name, nullable, any: false };
      }
      const values = isSchema(schema.additionalProperties) ? resolveType(schema.additionalProperties, `${hint}Value`, scope) : ANY_TYPE;
      return { type: `[String: ${elementType(values)}]`, nullable, any: false };
    }
    default:
      return ANY_TYPE;
  }
}

function renderEnum(name: string, values: string[], doc: string[]): string[] {
  const taken = new Set<string>();
  const cases = values.map((value) => {
    const identifier = unique(swiftIdentifier(value, "empty"), taken);
    return identifier === value ? `case ${escapeIdentifier(identifier)}` : `case ${escapeIdentifier(identifier)} = ${swiftString(value)}`;
  });
  const lines = [...doc, `public enum ${name}: String, Codable, Sendable, CaseIterable {`, ...indent(cases)];
  if (!values.includes("unknown")) {
    if (taken.has("unknown")) throw new Error(`enum ${name}: a member other than "unknown" maps to the Swift case "unknown"`);
    lines.push(...indent(["/// A member this client version does not know; the contract requires tolerating it.", "case unknown"]));
  }
  lines.push(
    "",
    ...indent([
      "public init(from decoder: Decoder) throws {",
      `${INDENT}let rawValue = try decoder.singleValueContainer().decode(String.self)`,
      `${INDENT}self = Self(rawValue: rawValue) ?? .unknown`,
      "}",
    ]),
    "}",
  );
  return lines;
}

type PropertyMode =
  | "required" // always present, never null
  | "optional" // nil is omitted when encoding; a missing key or null decodes to nil
  | "explicitNull" // key is required by the server and may be null: nil is encoded as null
  | "tristate"; // key may be omitted, null or a value, and the server tells omitted from null

interface SwiftProperty {
  key: string;
  identifier: string;
  /** Type without the outer Optional. */
  base: string;
  mode: PropertyMode;
  doc: string[];
}

const propertyType = (property: SwiftProperty): string => (property.mode === "required" ? property.base : `${property.base}?`);

function renderStruct(
  name: string,
  schema: JsonSchema,
  options: { doc: string[]; commandType?: string; enclosing: string[]; sent: boolean; context: SwiftContext },
): string[] {
  const { context } = options;
  const scope: SwiftScope = { declarations: [], taken: new Set([name, ...options.enclosing]), enclosing: [...options.enclosing, name], sent: options.sent, context };
  const required = new Set(schema.required ?? []);
  const identifiers = new Set<string>(options.commandType === undefined ? [] : ["commandType"]);
  const properties: SwiftProperty[] = [];

  for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
    const resolved = resolveType(propertySchema, pascalCase(key) || "Value", scope);
    const isRequired = required.has(key);
    const hasDefault = "default" in propertySchema;
    const doc = docLines(propertySchema.description);
    if ("const" in propertySchema) doc.push(`/// Always \`${JSON.stringify(propertySchema.const)}\`.`);
    if (hasDefault && !isRequired) doc.push(`/// Server default when omitted: \`${JSON.stringify(sortKeys(propertySchema.default))}\`.`);

    let mode: PropertyMode;
    let base = resolved.type;
    if (resolved.any) {
      mode = "optional"; // JSONValue covers null; a missing key decodes to nil instead of failing
    } else if (resolved.nullable && !isRequired && !hasDefault && options.sent) {
      mode = "tristate";
      base = `Nullable<${resolved.type}>`;
      doc.push("/// `nil` omits the key; `.null` sends an explicit JSON null.");
      context.usesNullable = true;
    } else if (resolved.nullable && isRequired && options.sent) {
      mode = "explicitNull";
    } else if (resolved.nullable || !isRequired) {
      mode = "optional";
    } else {
      mode = "required";
    }
    properties.push({ key, identifier: unique(swiftIdentifier(key, "value"), identifiers), base, mode, doc });
  }

  // `catchall` objects keep the keys outside the declared set instead of dropping them.
  const open = isSchema(schema.additionalProperties) ? elementType(resolveType(schema.additionalProperties, "AdditionalValue", scope)) : undefined;
  const extras = open === undefined ? undefined : unique("additionalProperties", identifiers);
  const custom =
    extras !== undefined || properties.some((property) => property.mode === "explicitNull" || property.mode === "tristate" || property.identifier !== property.key);
  if (custom) context.usesCodingKey = true;

  const conformances = ["Codable", "Sendable", "Equatable", ...(options.commandType === undefined ? [] : ["GarderobeCommandPayload"])];
  const body: string[] = [];
  if (options.commandType !== undefined) body.push(`public static let commandType = ${swiftString(options.commandType)}`, "");
  for (const property of properties) body.push(...property.doc, `public var ${escapeIdentifier(property.identifier)}: ${propertyType(property)}`);
  if (extras !== undefined) body.push("/// Keys outside the declared properties (this object is open by contract).", `public var ${extras}: [String: ${open}]`);
  if (body.length > 0 && body[body.length - 1] !== "") body.push("");

  const parameters = properties.map((property) => `${escapeIdentifier(property.identifier)}: ${propertyType(property)}${property.mode === "required" || property.mode === "explicitNull" ? "" : " = nil"}`);
  if (extras !== undefined) parameters.push(`${extras}: [String: ${open}] = [:]`);
  const assignments = [...properties.map((property) => property.identifier), ...(extras === undefined ? [] : [extras])].map(
    (identifier) => `self.${escapeIdentifier(identifier)} = ${escapeIdentifier(identifier)}`,
  );
  if (parameters.length === 0) body.push("public init() {}");
  else body.push("public init(", ...indent(parameters.map((parameter, index) => (index < parameters.length - 1 ? `${parameter},` : parameter))), ") {", ...indent(assignments), "}");

  for (const declaration of scope.declarations) body.push("", ...declaration);

  if (custom) {
    const keyOf = (property: SwiftProperty): string => `JSONCodingKey(${swiftString(property.key)})`;
    const decode = properties.map((property) => {
      const target = `self.${escapeIdentifier(property.identifier)}`;
      if (property.mode === "required") return `${target} = try container.decode(${property.base}.self, forKey: ${keyOf(property)})`;
      if (property.mode === "tristate") return `${target} = try container.contains(${keyOf(property)}) ? container.decode(${property.base}.self, forKey: ${keyOf(property)}) : nil`;
      return `${target} = try container.decodeIfPresent(${property.base}.self, forKey: ${keyOf(property)})`;
    });
    const encode = properties.map((property) => {
      const method = property.mode === "required" || property.mode === "explicitNull" ? "encode" : "encodeIfPresent";
      return `try container.${method}(self.${escapeIdentifier(property.identifier)}, forKey: ${keyOf(property)})`;
    });
    if (extras !== undefined) {
      body.push("", `private static let declaredKeys: Set<String> = [${properties.map((property) => swiftString(property.key)).join(", ")}]`);
      decode.push(
        `var extra: [String: ${open}] = [:]`,
        "for key in container.allKeys where !Self.declaredKeys.contains(key.stringValue) {",
        `${INDENT}extra[key.stringValue] = try container.decode(${open}.self, forKey: key)`,
        "}",
        `self.${extras} = extra`,
      );
      encode.unshift(`for (key, value) in self.${extras} where !Self.declaredKeys.contains(key) {`, `${INDENT}try container.encode(value, forKey: JSONCodingKey(key))`, "}");
    }
    body.push(
      "",
      "public init(from decoder: Decoder) throws {",
      ...indent(["let container = try decoder.container(keyedBy: JSONCodingKey.self)", ...decode]),
      "}",
      "",
      "public func encode(to encoder: Encoder) throws {",
      ...indent([`${encode.length > 0 ? "var" : "let"} container = encoder.container(keyedBy: JSONCodingKey.self)`, ...encode]),
      "}",
    );
  }

  return [...options.doc, `public struct ${name}: ${conformances.join(", ")} {`, ...indent(body), "}"];
}

const SWIFT_JSON_VALUE = `/// Any JSON value. Used where the contract is open (\`unknown\`, free-form records, unions).
public indirect enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case integer(Int)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// JSON does not distinguish \`1\` from \`1.0\`, so \`.integer\` and \`.number\` compare by numeric value.
    public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case (.bool(let a), .bool(let b)): return a == b
        case (.integer(let a), .integer(let b)): return a == b
        case (.number(let a), .number(let b)): return a == b
        case (.integer(let a), .number(let b)), (.number(let b), .integer(let a)): return Double(a) == b
        case (.string(let a), .string(let b)): return a == b
        case (.array(let a), .array(let b)): return a == b
        case (.object(let a), .object(let b)): return a == b
        default: return false
        }
    }

    /// Encodes a typed value (for example a \`Command*\` payload) as the JSON object \`CommandEnvelope.payload\` carries:
    /// \`CommandEnvelope(type: CommandWearRecord.commandType, payload: try JSONValue.encode(payload), ...)\`.
    /// Throws when the value does not encode to a JSON object.
    public static func encode<T: Encodable>(_ value: T) throws -> [String: JSONValue] {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode([String: JSONValue].self, from: data)
    }
}`;

const SWIFT_COMMAND_PAYLOAD = `/// A typed command payload; \`commandType\` is the value of \`CommandEnvelope.type\` it belongs to.
public protocol GarderobeCommandPayload: Codable, Sendable {
    static var commandType: String { get }
}`;

const SWIFT_NULLABLE = `/// A value the server tells apart from an omitted key: \`.null\` is an explicit JSON null.
public enum Nullable<Wrapped: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    case null
    case value(Wrapped)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = container.decodeNil() ? .null : .value(try container.decode(Wrapped.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .value(let value): try container.encode(value)
        }
    }
}`;

const SWIFT_CODING_KEY = `/// String coding key for the types below that encode or decode their keys by hand.
public struct JSONCodingKey: CodingKey, Hashable, Sendable {
    public let stringValue: String
    public var intValue: Int? { nil }

    public init(_ stringValue: String) {
        self.stringValue = stringValue
    }

    public init?(stringValue: String) {
        self.stringValue = stringValue
    }

    public init?(intValue: Int) {
        return nil
    }
}`;

export function renderSwift(built: BuiltContracts): string {
  const { document, meta } = built;
  const names = Object.keys(document.$defs).sort(compare);
  for (const name of names) if (SWIFT_SUPPORT_TYPES.has(name)) throw new Error(`"${name}" is reserved for generated Swift support code; rename the contract schema.`);

  // Definitions that can be part of a request: for those, null versus omitted must survive encoding.
  const sent = new Set(names.filter((name) => meta[name]?.io === "input"));
  const queue = [...sent];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const schema = document.$defs[name];
    if (schema === undefined) continue;
    for (const ref of collectRefs(schema)) {
      if (!sent.has(ref)) {
        sent.add(ref);
        queue.push(ref);
      }
    }
  }

  const context: SwiftContext = { topLevel: new Set(names), usesNullable: false, usesCodingKey: false };
  const blocks: string[][] = [];
  for (const name of names) {
    const schema = document.$defs[name];
    const defMeta = meta[name];
    if (schema === undefined || defMeta === undefined) continue;
    const doc = docLines(schema.description);
    if (defMeta.parsedPayloadOf !== undefined) {
      doc.push(
        `/// The \`${defMeta.parsedPayloadOf}\` payload as the server sees it after parsing (defaults applied).`,
        `/// To send the command, use \`${commandTypeName(defMeta.parsedPayloadOf)}\`.`,
      );
    }
    if (defMeta.commandType !== undefined) {
      if (schema.type !== "object") throw new Error(`${defMeta.origin}: a command payload must be an object schema`);
      doc.push(`/// Payload of the \`${defMeta.commandType}\` command, as the client sends it (fields with a server default are optional).`);
      blocks.push(renderStruct(name, schema, { doc, commandType: defMeta.commandType, enclosing: [], sent: true, context }));
    } else if (isStringEnum(schema)) {
      blocks.push(renderEnum(name, schema.enum as string[], doc));
    } else if (hasProperties(schema)) {
      blocks.push(renderStruct(name, schema, { doc, enclosing: [], sent: sent.has(name), context }));
    } else {
      const scope: SwiftScope = { declarations: [], taken: new Set(), enclosing: [], sent: sent.has(name), context };
      const resolved = resolveType(schema, name, scope);
      for (const taken of scope.taken) context.topLevel.add(taken);
      blocks.push(...scope.declarations, [...doc, `public typealias ${name} = ${resolved.nullable && !resolved.any ? `${resolved.type}?` : resolved.type}`]);
    }
  }

  const header = [
    "// GENERATED FILE - DO NOT EDIT BY HAND.",
    `// Generated by ${GENERATOR_PATH} (run \`npm run generate\` in packages/contracts)`,
    "// from the zod schemas of @garderobe/contracts. Change the schemas and regenerate instead of editing this file.",
    "//",
    `// Contract version ${document.contractVersion}, API version ${document.apiVersion}.`,
    "//",
    "// - What the app sends is `CommandEnvelope`, the `Command*` payloads and the `*Request`, `*Query` and `*Input`",
    "//   types: fields the server defaults are optional, and a required-but-nullable field is encoded as an",
    "//   explicit null.",
    "// - Every other type is what the app receives. Decoding ignores unknown keys, and every enum decodes a",
    "//   member it does not know to `.unknown` (which is also part of `allCases`).",
    "// - Value constraints (lengths, ranges, patterns, cross-field rules) are enforced by the server only.",
    "",
    "import Foundation",
  ];
  const contract = [
    "public enum GarderobeContract {",
    ...indent([
      `public static let version = ${swiftString(document.contractVersion)}`,
      `public static let apiVersion = ${swiftString(document.apiVersion)}`,
      "public static let commandTypes: [String] = [",
      ...indent(document.commandTypes.map((commandType) => `${swiftString(commandType)},`)),
      "]",
    ]),
    "}",
  ];
  const sections = [
    header.join("\n"),
    SWIFT_JSON_VALUE,
    contract.join("\n"),
    SWIFT_COMMAND_PAYLOAD,
    ...(context.usesNullable ? [SWIFT_NULLABLE] : []),
    ...(context.usesCodingKey ? [SWIFT_CODING_KEY] : []),
    ...blocks.map((block) => block.join("\n")),
  ];
  return `${sections.join("\n\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* Entry points                                                         */
/* ------------------------------------------------------------------ */

export interface Generated {
  files: GeneratedFile[];
  warnings: string[];
}

/** Pure generation: returns the content of every generated file without touching the disk. */
export async function generate(options: { extDir?: string } = {}): Promise<Generated> {
  const collected = await collectSchemas(options);
  const built = buildContractsDocument(collected);
  return {
    files: [
      { path: SCHEMA_JSON_PATH, content: renderJsonSchema(built.document) },
      { path: SWIFT_PATH, content: renderSwift(built) },
    ],
    warnings: collected.warnings,
  };
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes("--check");
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}\nUsage: node --experimental-strip-types scripts/generate.ts [--check]`);
    return 2;
  }
  const { files, warnings } = await generate();
  for (const warning of warnings) console.error(`warning: ${warning}`);
  let stale = 0;
  for (const file of files) {
    const absolute = join(PACKAGE_ROOT, file.path);
    const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
    if (current === file.content) {
      console.log(`up to date  ${file.path}`);
    } else if (check) {
      stale += 1;
      console.error(`${current === undefined ? "missing     " : "out of date "}${file.path}`);
    } else {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, file.content);
      console.log(`wrote       ${file.path}`);
    }
  }
  if (stale > 0) {
    console.error("Generated contract files are stale. Run `npm run generate` in packages/contracts and commit the result.");
    return 1;
  }
  return 0;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && existsSync(entryPoint) && import.meta.url === pathToFileURL(realpathSync(entryPoint)).href) {
  process.exitCode = await main(process.argv.slice(2));
}
