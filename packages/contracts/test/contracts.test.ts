import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildContractsDocument, collectSchemas, commandTypeName, generate, PACKAGE_ROOT, renderSwift, SCHEMA_JSON_PATH, SWIFT_PATH } from "../scripts/generate.ts";
import { API_VERSION, CommandEnvelope, CONTRACT_VERSION, FOUNDATION_COMMANDS, IanaTimezone, LocalTime } from "../src/index.ts";

const foundationTypes = Object.keys(FOUNDATION_COMMANDS).sort();
const foundationPayloads = foundationTypes.map(commandTypeName);
const readModels = ["CommandReceipt", "InventoryPage", "AvailabilitySnapshot", "StyleContext"];
const fixtureExtDir = fileURLToPath(new URL("./fixtures/ext", import.meta.url));
const clashingExtDir = fileURLToPath(new URL("./fixtures/ext-clash", import.meta.url));

interface CommittedSchema {
  contractVersion: string;
  apiVersion: string;
  commandTypes: string[];
  $defs: Record<string, { required?: string[] }>;
}

const committed = (path: string): string => readFileSync(join(PACKAGE_ROOT, path), "utf8");

describe("CommandEnvelope", () => {
  const valid = {
    type: "wear.record",
    payload: { wearingDate: "2026-09-15", garmentIds: ["gmt_oxford"] },
    idempotencyKey: "ios-7f3a9c10",
    occurredAt: "2026-09-15T06:50:00Z",
    authorization: "owner_tap",
    source: { channel: "ios" },
  };

  it("accepts a valid envelope and applies the documented defaults", () => {
    const parsed = CommandEnvelope.parse(valid);
    expect(parsed.expectedVersions).toEqual({});
    expect(parsed.source).toMatchObject({ channel: "ios", parentKind: "none", attachedRefs: [] });
  });

  it.each([
    ["an unknown channel", { ...valid, source: { channel: "fax" } }, "source.channel"],
    ["a short idempotency key", { ...valid, idempotencyKey: "short" }, "idempotencyKey"],
    ["a malformed occurredAt", { ...valid, occurredAt: "2026-09-15 06:50" }, "occurredAt"],
  ])("rejects %s", (_label, envelope, path) => {
    const result = CommandEnvelope.safeParse(envelope);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([path]);
  });
});

describe("times and time zones (adversarial defects L04-4 and L04-5)", () => {
  it("a time zone is an IANA zone name, never a bare UTC offset", () => {
    for (const zone of ["Europe/London", "America/New_York", "UTC", "Etc/GMT+5"]) expect(IanaTimezone.safeParse(zone).success, zone).toBe(true);
    for (const zone of ["+05:00", "-11:00", "+14:00", "+0530", "Mars/Olympus_Mons", "UTC+25", ""]) expect(IanaTimezone.safeParse(zone).success, zone).toBe(false);
  });

  it("a local time is a real time of day", () => {
    for (const time of ["00:00", "07:10", "23:59"]) expect(LocalTime.safeParse(time).success, time).toBe(true);
    for (const time of ["24:00", "25:99", "99:99", "12:60", "7:10", "07:10:00"]) expect(LocalTime.safeParse(time).success, time).toBe(false);
  });
});

describe("foundation command payloads", () => {
  it("maps every command type to a schema", () => {
    expect(foundationTypes.length).toBeGreaterThan(0);
    for (const schema of Object.values(FOUNDATION_COMMANDS)) expect(schema).toBeInstanceOf(z.ZodType);
  });

  it("parses a minimal wear.record and defaults the optional parts", () => {
    const parsed = FOUNDATION_COMMANDS["wear.record"].parse({ wearingDate: "2026-09-15", garmentIds: ["gmt_oxford"] });
    expect(parsed).toMatchObject({ additionalUnits: [], segment: null, tripId: null });
  });

  it("parses a minimal garment.create", () => {
    const parsed = FOUNDATION_COMMANDS["garment.create"].parse({
      name: "Blue oxford shirt",
      category: "shirt",
      roles: ["top"],
      careChannel: "service",
      acquisition: "owned",
      quantity: 2,
      source: { kind: "owner_statement" },
    });
    expect(parsed).toMatchObject({ planningPolicy: "normal", initialBucket: "clean", isSynthetic: false, attributes: {} });
  });

  it("parses laundry.return with and without named exceptions", () => {
    expect(FOUNDATION_COMMANDS["laundry.return"].parse({})).toEqual({ stillAway: [] });
    expect(FOUNDATION_COMMANDS["laundry.return"].parse({ batchId: "batch_1", stillAway: [{ garmentId: "gmt_oxford" }] }).stillAway).toEqual([
      { garmentId: "gmt_oxford", quantity: 1 },
    ]);
  });

  it("requires care.washed to name items or a whole care channel", () => {
    const washed = FOUNDATION_COMMANDS["care.washed"];
    expect(washed.safeParse({ items: [{ garmentId: "gmt_socks" }] }).success).toBe(true);
    expect(washed.safeParse({ allOfChannel: "handwash" }).success).toBe(true);
    expect(washed.safeParse({}).success).toBe(false);
    expect(washed.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("generated contract files", () => {
  it("are up to date with the zod schemas and generate deterministically", async () => {
    const first = await generate();
    const second = await generate();
    expect(second).toEqual(first);
    expect(first.files.map((file) => file.path)).toEqual([SCHEMA_JSON_PATH, SWIFT_PATH]);
    // Compare equality only (not toBe on the strings) so a stale file reports the command to run, not a 9000-line diff.
    const stale = first.files.filter((file) => committed(file.path) !== file.content).map((file) => file.path);
    expect(stale, "run `npm run generate` in packages/contracts and commit the result").toEqual([]);
  });

  it("JSON Schema publishes the versions, the command types and a definition per read model and command payload", async () => {
    const schema = JSON.parse(committed(SCHEMA_JSON_PATH)) as CommittedSchema;
    expect(schema.contractVersion).toBe(CONTRACT_VERSION);
    expect(schema.apiVersion).toBe(API_VERSION);
    expect(Object.keys(schema.$defs)).toEqual(expect.arrayContaining([...readModels, ...schema.commandTypes.map(commandTypeName)]));
    // Extension lanes may add command types; without them the list is exactly the foundation's, sorted.
    expect(schema.commandTypes).toEqual([...new Set(schema.commandTypes)].sort());
    expect(schema.commandTypes).toEqual(expect.arrayContaining(foundationTypes));
    const foundationOnly = buildContractsDocument(await collectSchemas({ extDir: join(fixtureExtDir, "absent") }));
    expect(foundationOnly.document.commandTypes).toEqual(foundationTypes);
    // Sent shapes leave server-defaulted fields optional; received shapes always carry them.
    expect(schema.$defs.CommandWearRecord?.required).toEqual(["wearingDate", "garmentIds"]);
    expect(schema.$defs.CommandEnvelope?.required).not.toContain("expectedVersions");
    expect(schema.$defs.CommandErrorBody?.required).toContain("details");
  });

  it("Swift declares a type per read model and command payload, tolerates unknown enum members and is well formed", () => {
    const swift = committed(SWIFT_PATH);
    const { commandTypes } = JSON.parse(committed(SCHEMA_JSON_PATH)) as CommittedSchema;
    const declared = new Set([...swift.matchAll(/^public (?:indirect )?(?:struct|enum) (\w+)/gm)].map((match) => match[1]));
    const expected = [...readModels, ...foundationPayloads, ...commandTypes.map(commandTypeName), "CommandEnvelope", "JSONValue", "GarderobeContract"];
    expect(expected.filter((name) => !declared.has(name))).toEqual([]);
    for (const commandType of commandTypes) expect(swift).toContain(`public static let commandType = "${commandType}"`);

    const enums = swift.match(/^ *public enum \w+: String, Codable, Sendable, CaseIterable \{$/gm) ?? [];
    expect(enums.length).toBeGreaterThan(0);
    expect(swift.match(/self = Self\(rawValue: rawValue\) \?\? \.unknown/g)).toHaveLength(enums.length);

    expect(swift.slice(0, swift.indexOf("import Foundation"))).toMatch(/GENERATED FILE - DO NOT EDIT BY HAND[\s\S]*scripts\/generate\.ts/);
    expect(swift).not.toContain("TODO");
    // Braces inside comments and string literals are not structure.
    const code = swift.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    expect(code.split("{").length).toBe(code.split("}").length);
  });

  it("picks up the schemas and command maps of extension modules without touching the generator", async () => {
    const built = buildContractsDocument(await collectSchemas({ extDir: fixtureExtDir }));
    // Read model: output shape, shared types by reference.
    expect(built.document.$defs.SampleExtNote).toMatchObject({
      type: "object",
      properties: { garmentId: { $ref: "#/$defs/GarmentId" } },
      required: ["noteId", "garmentId", "mood", "tags"],
    });
    // Command payload: input shape, registered as a command type.
    expect(built.document.$defs.CommandSampleAddNote?.required).toEqual(["noteId", "garmentId", "mood"]);
    expect(built.document.commandTypes).toEqual([...foundationTypes, "sample.add_note"].sort());
    expect(built.document.$defs).not.toHaveProperty("SAMPLE_EXT_LIMIT");
    const swift = renderSwift(built);
    expect(swift).toContain("public struct SampleExtNote: Codable, Sendable, Equatable {");
    expect(swift).toContain("public struct CommandSampleAddNote: Codable, Sendable, Equatable, GarderobeCommandPayload {");
  });

  it("qualifies a name two lanes use for different schemas with the lane name and warns about it", async () => {
    const collected = await collectSchemas({ extDir: clashingExtDir });
    const { $defs } = buildContractsDocument(collected).document;
    expect($defs.LeftConnection?.required).toEqual(["connectionId", "provider"]);
    expect($defs.RightConnection?.required).toEqual(["socketId"]);
    expect($defs).not.toHaveProperty("Connection");
    expect(collected.warnings).toHaveLength(1);
    expect(collected.warnings[0]).toMatch(/"Connection".*left\.ts.*right\.ts.*"LeftConnection".*"RightConnection"/);
  });
});
