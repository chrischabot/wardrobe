/**
 * Verifies the Google Calendar API v3 contract that `src/calendar/google.ts` relies on against the LIVE
 * official discovery document. Run from `wardrobe/packages/daily`:
 *
 *   node --experimental-strip-types scripts/verify-google-calendar.ts
 *
 * Prints the discovery revision and one pass/fail line per item; exits non-zero on any mismatch.
 * This checks the published contract only. It sends no authorised request: behaviour that needs a real
 * OAuth grant (If-Match on patch, 409 on a duplicate ID, 412, restore by patch) is not covered here.
 */

const DISCOVERY_URL = "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest";

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

/** Walk `a.b.c` through plain objects. */
function at(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const next = obj(current);
    if (!next) return undefined;
    current = next[key];
  }
  return current;
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
}

/** Methods the adapter calls: HTTP verb, path, and the query parameters it sends. */
const METHODS: { name: string; verb: string; path: string; query: string[] }[] = [
  { name: "list", verb: "GET", path: "calendars/{calendarId}/events", query: ["singleEvents", "orderBy", "timeMin", "timeMax", "timeZone", "showDeleted", "maxResults", "pageToken"] },
  { name: "get", verb: "GET", path: "calendars/{calendarId}/events/{eventId}", query: [] },
  { name: "insert", verb: "POST", path: "calendars/{calendarId}/events", query: ["sendUpdates"] },
  { name: "patch", verb: "PATCH", path: "calendars/{calendarId}/events/{eventId}", query: ["sendUpdates"] },
  { name: "delete", verb: "DELETE", path: "calendars/{calendarId}/events/{eventId}", query: ["sendUpdates"] },
];

/** Event schema fields the adapter reads or writes (top level). */
const EVENT_FIELDS = ["id", "etag", "status", "summary", "description", "start", "end", "transparency", "location", "extendedProperties", "reminders", "attendees", "organizer"];

async function main(): Promise<void> {
  const response = await fetch(DISCOVERY_URL);
  if (!response.ok) {
    console.log(`FAIL  download ${DISCOVERY_URL}  [HTTP ${response.status}]`);
    process.exit(1);
  }
  const doc = obj(await response.json());
  if (!doc) {
    console.log("FAIL  discovery document is not a JSON object");
    process.exit(1);
  }

  console.log(`Discovery document: ${DISCOVERY_URL}`);
  console.log(`name=${String(doc.name)} version=${String(doc.version)} revision=${String(doc.revision)}`);
  console.log(`checked at ${new Date().toISOString()}`);
  console.log("");

  check("api is calendar v3", doc.name === "calendar" && doc.version === "v3");
  check("baseUrl is https://www.googleapis.com/calendar/v3/", doc.baseUrl === "https://www.googleapis.com/calendar/v3/", String(doc.baseUrl));
  check("global query parameter fields", at(doc, ["parameters", "fields", "location"]) === "query");

  for (const method of METHODS) {
    const definition = obj(at(doc, ["resources", "events", "methods", method.name]));
    check(`events.${method.name} exists`, definition !== null);
    if (!definition) continue;
    check(`events.${method.name} verb ${method.verb}`, definition.httpMethod === method.verb, String(definition.httpMethod));
    check(`events.${method.name} path ${method.path}`, definition.path === method.path, String(definition.path));
    for (const segment of method.path.match(/\{(\w+)\}/g) ?? []) {
      const name = segment.slice(1, -1);
      check(`events.${method.name} path parameter ${name}`, at(definition, ["parameters", name, "location"]) === "path");
    }
    for (const name of method.query) {
      check(`events.${method.name} query parameter ${name}`, at(definition, ["parameters", name, "location"]) === "query");
    }
  }

  const orderBy = at(doc, ["resources", "events", "methods", "list", "parameters", "orderBy", "enum"]);
  check('events.list orderBy accepts "startTime"', Array.isArray(orderBy) && orderBy.includes("startTime"));
  check("events.list singleEvents is boolean", at(doc, ["resources", "events", "methods", "list", "parameters", "singleEvents", "type"]) === "boolean");
  check("events.list showDeleted is boolean", at(doc, ["resources", "events", "methods", "list", "parameters", "showDeleted", "type"]) === "boolean");
  const maxResultsDefault = at(doc, ["resources", "events", "methods", "list", "parameters", "maxResults", "default"]);
  check("events.list maxResults default is 250", maxResultsDefault === "250", String(maxResultsDefault));
  for (const name of ["insert", "patch", "delete"]) {
    const values = at(doc, ["resources", "events", "methods", name, "parameters", "sendUpdates", "enum"]);
    check(`events.${name} sendUpdates accepts "none"`, Array.isArray(values) && values.includes("none"));
  }
  check("events.list response is Events", at(doc, ["resources", "events", "methods", "list", "response", "$ref"]) === "Events");
  for (const name of ["get", "insert", "patch"]) {
    check(`events.${name} response is Event`, at(doc, ["resources", "events", "methods", name, "response", "$ref"]) === "Event");
  }
  for (const name of ["insert", "patch"]) {
    check(`events.${name} request is Event`, at(doc, ["resources", "events", "methods", name, "request", "$ref"]) === "Event");
  }

  const schemas = obj(doc.schemas);
  check("Events.items is an array of Event", at(schemas, ["Events", "properties", "items", "items", "$ref"]) === "Event");
  check("Events.nextPageToken", obj(at(schemas, ["Events", "properties", "nextPageToken"])) !== null);

  const event = obj(at(schemas, ["Event", "properties"]));
  check("schema Event exists", event !== null);
  for (const field of EVENT_FIELDS) check(`Event.${field}`, obj(event?.[field]) !== null);

  check("Event.start is EventDateTime", at(event, ["start", "$ref"]) === "EventDateTime");
  check("Event.end is EventDateTime", at(event, ["end", "$ref"]) === "EventDateTime");
  for (const field of ["date", "dateTime", "timeZone"]) {
    check(`EventDateTime.${field}`, obj(at(schemas, ["EventDateTime", "properties", field])) !== null);
  }
  check("Event.extendedProperties.private is a string map", at(event, ["extendedProperties", "properties", "private", "additionalProperties", "type"]) === "string");
  check("Event.reminders.useDefault is boolean", at(event, ["reminders", "properties", "useDefault", "type"]) === "boolean");
  check("Event.reminders.overrides is an array of EventReminder", at(event, ["reminders", "properties", "overrides", "items", "$ref"]) === "EventReminder");
  for (const field of ["method", "minutes"]) {
    check(`EventReminder.${field}`, obj(at(schemas, ["EventReminder", "properties", field])) !== null);
  }
  check("Event.attendees is an array of EventAttendee", at(event, ["attendees", "items", "$ref"]) === "EventAttendee");
  check("Event.attendees[].self is boolean", at(schemas, ["EventAttendee", "properties", "self", "type"]) === "boolean");
  check("Event.attendees[].responseStatus is string", at(schemas, ["EventAttendee", "properties", "responseStatus", "type"]) === "string");
  const responseStatus = String(at(schemas, ["EventAttendee", "properties", "responseStatus", "description"]) ?? "");
  for (const value of ["needsAction", "declined", "tentative", "accepted"]) {
    check(`attendee responseStatus documents "${value}"`, responseStatus.includes(`"${value}"`));
  }
  check("Event.organizer.self is boolean", at(event, ["organizer", "properties", "self", "type"]) === "boolean");

  const status = String(at(event, ["status", "description"]) ?? "");
  for (const value of ["confirmed", "tentative", "cancelled"]) check(`Event.status documents "${value}"`, status.includes(`"${value}"`));
  check('Event.transparency documents "transparent"', String(at(event, ["transparency", "description"]) ?? "").includes('"transparent"'));

  const idRules = String(at(event, ["id", "description"]) ?? "");
  check("Event.id rule: base32hex, lowercase a-v and digits 0-9", idRules.includes("base32hex") && idRules.includes("lowercase letters a-v and digits 0-9"));
  check("Event.id rule: length between 5 and 1024", idRules.includes("between 5 and 1024 characters"));

  console.log("");
  if (failures > 0) {
    console.log(`RESULT: FAIL (${failures} mismatch${failures === 1 ? "" : "es"}) against revision ${String(doc.revision)}`);
    process.exit(1);
  }
  console.log(`RESULT: PASS against revision ${String(doc.revision)}`);
}

main().catch((error: unknown) => {
  console.log(`FAIL  verification could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
