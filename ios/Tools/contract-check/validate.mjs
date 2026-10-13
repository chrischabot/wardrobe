// Validates what the Swift client sends, and what its fixtures hold, against the REAL shared contracts
// (the zod schemas in packages/contracts, not a copy).
//
//   node --experimental-strip-types ios/Tools/contract-check/validate.mjs requests <requests.json>
//       Every request body and query the app produced (from `swift run garderobe-contract-dump`):
//       command envelopes are parsed with CommandEnvelope and the payload schema registered for their
//       type; every other request with the request schema API_ROUTES names for its route.
//
//   node --experimental-strip-types ios/Tools/contract-check/validate.mjs fixtures <dir>
//       Every cassette: its provenance hashes must equal the supplied profile and inventory files and
//       the current contract version, and every recorded 2xx answer must parse with the response
//       schema API_ROUTES names for its route (so a fixture can never drift from the contracts).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const load = (rel) => import(pathToFileURL(join(repo, rel)).href);
const core = await load("packages/contracts/src/index.ts");
const modules = { core };
for (const file of readdirSync(join(repo, "packages/contracts/src/ext")).filter((f) => f.endsWith(".ts")).sort()) {
  modules[file.replace(/\.ts$/, "")] = await load(`packages/contracts/src/ext/${file}`);
}
const api = modules.api;

// Command type -> payload schema, from every exported *_COMMANDS map.
const commands = new Map();
for (const [name, mod] of Object.entries(modules)) {
  for (const [key, value] of Object.entries(mod)) {
    if (/^[A-Z][A-Z0-9_]*_COMMANDS$/.test(key) && value && typeof value === "object") {
      for (const [type, schema] of Object.entries(value)) commands.set(type, { schema, module: name });
    }
  }
}

// A schema by exported name: the API module first (it is the route contract), then the others.
function schemaNamed(name) {
  for (const mod of [api, core, ...Object.values(modules)]) {
    const candidate = mod[name];
    if (candidate && typeof candidate.safeParse === "function") return candidate;
  }
  return null;
}

const routes = api.API_ROUTES.map((route) => ({
  ...route,
  pattern: new RegExp(`^${route.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+").replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));
const routeFor = (method, path) => routes.find((r) => r.method === method && r.pattern.test(path)) ?? null;

const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);
const issues = (error) => error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ");

function checkEnvelope(where, envelope) {
  const parsed = core.CommandEnvelope.safeParse(envelope);
  if (!parsed.success) return fail(where, `envelope: ${issues(parsed.error)}`);
  const entry = commands.get(envelope.type);
  if (!entry) return fail(where, `command type "${envelope.type}" is not in any registered command map`);
  const payload = entry.schema.safeParse(envelope.payload);
  if (!payload.success) fail(where, `payload of ${envelope.type}: ${issues(payload.error)}`);
  if (envelope.authorization !== "owner_tap") fail(where, `the app must send authorization owner_tap, sent ${envelope.authorization}`);
  if (envelope.source?.channel !== "ios") fail(where, `the app must send source.channel ios, sent ${envelope.source?.channel}`);
  for (const forbidden of ["userId", "ownerId", "owner"]) {
    if (forbidden in envelope || forbidden in (envelope.payload ?? {})) fail(where, `an owner field (${forbidden}) must never be sent`);
  }
  return entry;
}

function checkRequests(file) {
  const samples = JSON.parse(readFileSync(file, "utf8"));
  const seenCommands = new Set();
  const seenRoutes = new Set();
  for (const [index, sample] of samples.entries()) {
    const where = `#${index} ${sample.method} ${sample.path}`;
    const route = routeFor(sample.method, sample.path);
    if (!route) {
      fail(where, "no route in API_ROUTES matches this request");
      continue;
    }
    seenRoutes.add(`${route.method} ${route.path}`);
    if (route.method === "POST" && route.path === "/v1/commands") {
      if (checkEnvelope(`${where} (${sample.body?.type})`, sample.body)) seenCommands.add(sample.body.type);
      continue;
    }
    if (route.method === "POST" && route.path === "/v1/commands/batch") {
      const parsed = api.CommandBatchRequest.safeParse(sample.body);
      if (!parsed.success) fail(where, issues(parsed.error));
      for (const envelope of sample.body?.commands ?? []) if (checkEnvelope(`${where} (${envelope.type})`, envelope)) seenCommands.add(envelope.type);
      continue;
    }
    const schema = route.request ? schemaNamed(route.request) : null;
    let value = route.method === "GET" ? sample.query : sample.body;
    // A query string carries text. The API contract states the convention for the wardrobe query
    // ("booleans true/false, numbers in decimal"); apply exactly that before parsing, as the Worker does.
    if (route.method === "GET" && route.path === "/v1/wardrobe" && value) {
      value = { ...value };
      if (value.includeDisposed === "true" || value.includeDisposed === "false") value.includeDisposed = value.includeDisposed === "true";
      if (typeof value.limit === "string" && /^\d+$/.test(value.limit)) value.limit = Number(value.limit);
    }
    if (route.request && !schema) {
      if (route.request !== "binary") fail(where, `request schema "${route.request}" named by API_ROUTES is not exported`);
      continue;
    }
    if (!schema) {
      // No request schema: the route takes no input. An empty body or query is the only valid one.
      if (value && Object.keys(value).length > 0) fail(where, `the route takes no input but the app sent ${JSON.stringify(value)}`);
      continue;
    }
    const parsed = schema.safeParse(value ?? {});
    if (!parsed.success) fail(where, `${route.request}: ${issues(parsed.error)}`);
  }
  console.log(`requests checked: ${samples.length}`);
  console.log(`command types the app sent (${seenCommands.size}): ${[...seenCommands].sort().join(", ")}`);
  console.log(`routes the app called (${seenRoutes.size}): ${[...seenRoutes].sort().join(", ")}`);
  // The command types the app's code paths must cover. A type missing here means the dump no longer exercises it.
  const required = [
    "board.select", "board.swap_slot", "wear.record", "wear.amend", "command.undo", "care.mark_dirty", "care.washed", "garment.move", "garment.receive",
    "stock.reconcile", "stock.pack", "stock.unpack", "laundry.collect", "laundry.return", "laundry.report_exception", "style.set_brief", "style.save_document",
    "style.add_direction", "style.retire_direction", "settings.update", "service.pause", "service.resume", "trip.create", "trip.cancel",
    "studio.save_combination", "studio.plan_for_day", "studio.remove_combination", "studio.remove_day_plan", "feedback.record", "feedback.retract", "return.open_case",
  ];
  for (const type of required) if (!seenCommands.has(type)) fail("coverage", `the app's requests no longer include a ${type} command`);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function checkFixtures(dir) {
  const profile = sha256(join(repo, "requirements/chris-wardrobe-profile.md"));
  const inventory = sha256(join(repo, "requirements/wardrobe_inventory_clean.csv"));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) fail(dir, "no cassettes found");
  let answers = 0;
  for (const file of files) {
    const cassette = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const p = cassette.provenance ?? {};
    if (p.profileSha256 !== profile) fail(file, "was not recorded from the current owner profile (hash differs): re-record with ios/Tools/fixtures/record.sh");
    if (p.inventorySha256 !== inventory) fail(file, "was not recorded from the current inventory CSV (hash differs): re-record with ios/Tools/fixtures/record.sh");
    if (p.contractVersion !== core.CONTRACT_VERSION) fail(file, `was recorded at contract ${p.contractVersion}, current is ${core.CONTRACT_VERSION}`);
    if (!String(p.backend ?? "").startsWith("worker")) fail(file, "was not recorded from the Worker");
    const check = (where, method, path, exchange) => {
      if (!exchange || exchange.status < 200 || exchange.status >= 300 || exchange.body === undefined || exchange.body === null) return;
      const route = routeFor(method, path);
      if (!route) return fail(where, "no route in API_ROUTES matches this recorded exchange");
      const schema = schemaNamed(route.response.split(" ")[0]);
      if (!schema) return; // binary, HTML and protocol-defined responses have no zod schema
      const parsed = schema.safeParse(exchange.body);
      answers += 1;
      if (!parsed.success) fail(where, `${route.response}: ${issues(parsed.error)}`);
    };
    for (const step of cassette.steps) {
      if (step.request) {
        check(`${file} step ${step.id}`, step.request.method, step.request.path, step.response);
        if (step.request.path === "/v1/commands") checkEnvelope(`${file} step ${step.id} request`, step.request.body);
      }
      for (const [key, exchange] of Object.entries(step.reads ?? {})) {
        const [method, rest] = [key.slice(0, key.indexOf(" ")), key.slice(key.indexOf(" ") + 1)];
        const path = rest.split("?")[0];
        if (method === "STREAM") {
          for (const event of exchange.body ?? []) {
            const parsed = api.RunEvent.safeParse(event.data);
            answers += 1;
            if (!parsed.success) fail(`${file} step ${step.id} ${key}`, `RunEvent: ${issues(parsed.error)}`);
            const data = api.RunEventData?.[event.data?.type];
            if (data) {
              const inner = data.safeParse(event.data.data);
              if (!inner.success) fail(`${file} step ${step.id} ${key}`, `event ${event.data.type}: ${issues(inner.error)}`);
            }
          }
        } else {
          check(`${file} step ${step.id} ${key}`, method, path, exchange);
        }
      }
      for (const post of step.posts ?? []) check(`${file} step ${step.id} POST ${post.path}`, "POST", post.path, post.response);
    }
  }
  console.log(`cassettes checked: ${files.length} (${files.join(", ")}); recorded answers parsed with their response schemas: ${answers}`);
}

const [mode, target] = process.argv.slice(2);
if (mode === "requests" && target) checkRequests(target);
else if (mode === "fixtures" && target) checkFixtures(target);
else {
  console.error("usage: validate.mjs requests <requests.json> | fixtures <dir>");
  process.exit(2);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} contract failure(s):`);
  for (const line of failures.slice(0, 60)) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("contract check passed");
