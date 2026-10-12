//! Requests, authentication and the command service: the Ferrite form of
//! apps/worker/src/routes/core.ts and packages/domain/src/commands/service.ts
//! for the commands this slice ports.
//!
//! Storage is the app's APE binding (`state`), reached through [`Store`]:
//!   `ledger`     the owner's ledger (`crate::ledger::Ledger`), the commit guard;
//!   `c/<id>`     a command: its stored receipt, payload hash and undo data;
//!   `i/<sha256>` an idempotency key → command ID and request hash.
//! Every command rewrites `ledger`, and the receipt and marker are committed
//! in the same guarded write, so two requests that read the same ledger can
//! never both commit: the loser re-reads, and finds the winner's receipt if it
//! was the same request.

use std::io;

use ferrite_app::client::ApeClusterClient;
use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;

use crate::canonical::{canonical, keys_are_plain, numbers_are_whole, whole, MAX_SAFE};
use crate::ledger::{self, CmdError, Ctx, Ledger, Plan, StoredCommand};
use crate::seed::{catalogue, Catalogue};
use crate::sha256::{constant_time_eq, hex_digest};
use crate::time::{instant, parse_instant};

/// `CONTRACT_VERSION` in packages/contracts/src/version.ts.
pub const CONTRACT_VERSION: &str = "1.1.0";
const LEDGER_KEY: &[u8] = b"ledger";
const MAX_ATTEMPTS: u32 = 12;
/// How far ahead of the server clock an `occurredAt` may be (service.ts).
const FUTURE_SLACK_MS: u64 = 5 * 60_000;

/// The deploy secrets that carry the bearer tokens. A missing owner token is
/// refused by name at request time (Ferrite does not check secrets at deploy).
pub const OWNER_TOKEN_SECRET: &str = "WARDROBE_OWNER_TOKEN";
pub const ASSISTANT_TOKEN_SECRET: &str = "WARDROBE_ASSISTANT_TOKEN";

/// The two operations of the APE store this service uses, so the command
/// service can be exercised against a store that fails on purpose.
#[allow(async_fn_in_trait)]
pub trait Store {
    /// Read one key (`None` = absent).
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>>;
    /// Commit `entries` only if `guard` still holds `expected`. `Ok(Err(_))` is a
    /// definite guard mismatch (nothing written); `Err(_)` is an unknown outcome.
    async fn commit_n_if(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> io::Result<Result<(), Option<Vec<u8>>>>;
}

impl Store for ApeClusterClient {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        ApeClusterClient::get(self, key).await
    }
    async fn commit_n_if(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> io::Result<Result<(), Option<Vec<u8>>>> {
        ApeClusterClient::commit_n_if(self, guard, expected, entries).await
    }
}

#[derive(Debug, Clone, Default)]
pub struct Tokens {
    pub owner: Option<String>,
    pub assistant: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Principal {
    pub actor: &'static str,
    pub channel: &'static str,
}

/// The owner's own client (the native app) and a connected assistant (the
/// Codex plugin over MCP). Both may read and write; what each may authorize
/// is decided per command by `check_authorization`.
pub const OWNER: Principal = Principal { actor: "owner", channel: "ios" };
pub const ASSISTANT: Principal = Principal { actor: "assistant", channel: "mcp" };

pub struct Reply {
    pub status: u16,
    pub body: Value,
}

fn error_status(code: &str) -> u16 {
    // API_ERROR_STATUS in packages/contracts/src/ext/api.ts.
    match code {
        "invalid_command" | "unknown_command" => 400,
        "unauthenticated" => 401,
        "forbidden" => 403,
        "not_found" => 404,
        "conflict" | "idempotency_key_reuse" | "precondition_failed" | "not_undoable" | "ambiguous_target" => 409,
        _ => 500,
    }
}

fn error_reply(e: CmdError) -> Reply {
    Reply { status: error_status(e.code), body: json!({"error": {"code": e.code, "message": e.message, "details": e.details}}) }
}

fn ok(body: Value) -> Reply {
    Reply { status: 200, body }
}

fn internal(message: &str) -> CmdError {
    CmdError::with("internal", message, json!({"retryable": true}))
}

/// Whether a request may already have been written cannot be settled: an
/// earlier attempt's commit response was lost, or the idempotency marker
/// could not be read. Never reported as "nothing was written".
pub fn unknown_outcome() -> CmdError {
    CmdError::with(
        "internal",
        "the command's outcome could not be confirmed; it may have been written. Send it again with the same idempotency key: if it was written you get its receipt, otherwise it is applied once",
        json!({"retryable": true, "outcome": "unknown"}),
    )
}

fn header<'a>(req: &'a IngressRequest, name: &str) -> Option<&'a str> {
    req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn authenticate(req: &IngressRequest, tokens: &Tokens) -> Result<Principal, CmdError> {
    let Some(owner_token) = tokens.owner.as_deref().filter(|t| !t.is_empty()) else {
        return Err(CmdError::new("internal", format!("the server has no {OWNER_TOKEN_SECRET} secret; set it and deploy again")));
    };
    let presented = header(req, "authorization")
        .and_then(|h| h.strip_prefix("Bearer ").or_else(|| h.strip_prefix("bearer ")))
        .map(str::trim)
        .unwrap_or("");
    if presented.is_empty() {
        return Err(CmdError::new("unauthenticated", "sign in first: send Authorization: Bearer <token>"));
    }
    if constant_time_eq(presented.as_bytes(), owner_token.as_bytes()) {
        return Ok(OWNER);
    }
    if let Some(a) = tokens.assistant.as_deref().filter(|t| !t.is_empty()) {
        if constant_time_eq(presented.as_bytes(), a.as_bytes()) {
            return Ok(ASSISTANT);
        }
    }
    Err(CmdError::new("unauthenticated", "that token is not valid for this wardrobe"))
}

fn split_path(path: &str) -> (&str, Vec<(String, String)>) {
    let (p, q) = path.split_once('?').unwrap_or((path, ""));
    let query = q
        .split('&')
        .filter(|x| !x.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (k.to_string(), v.to_string())
        })
        .collect();
    (p, query)
}

/// Answer one request. The caller publishes the reply.
pub async fn handle<S: Store>(store: &mut S, tokens: &Tokens, now_ms: u64, req: &IngressRequest) -> Reply {
    let (path, query) = split_path(&req.path);
    if path == "/health" {
        return ok(json!({"status": "ok", "service": "wardrobe", "host": "ferrite", "contractVersion": CONTRACT_VERSION}));
    }
    let principal = match authenticate(req, tokens) {
        Ok(p) => p,
        Err(e) => return error_reply(e),
    };
    let result = match (req.method.as_str(), path) {
        ("GET", "/v1/wardrobe") => {
            let category = query.iter().find(|(k, _)| k == "category").map(|(_, v)| v.as_str());
            read_wardrobe(store, now_ms, category).await
        }
        ("GET", "/v1/commands") => {
            let limit = query.iter().find(|(k, _)| k == "limit").and_then(|(_, v)| v.parse::<usize>().ok()).unwrap_or(50).clamp(1, 200);
            list_receipts(store, limit).await
        }
        ("GET", p) if p.starts_with("/v1/commands/") => {
            let id = &p["/v1/commands/".len()..];
            match load_command(store, id).await {
                Ok(Some(record)) => Ok(current_receipt(&record.value)),
                Ok(None) => Err(CmdError::new("not_found", "that receipt was not found")),
                Err(e) => Err(e),
            }
        }
        ("POST", "/v1/commands") => match serde_json::from_slice::<Value>(&req.body) {
            Ok(envelope) => execute(store, principal, now_ms, &envelope).await,
            Err(_) => Err(CmdError::new("invalid_command", "the request body is not valid JSON")),
        },
        _ => Err(CmdError::new("not_found", "no such route")),
    };
    match result {
        Ok(body) => ok(body),
        Err(e) => error_reply(e),
    }
}

// ──────────────────────────────── storage ────────────────────────────────

async fn read_ledger<S: Store>(store: &mut S) -> Result<(Option<Vec<u8>>, Ledger), CmdError> {
    let bytes = store.get(LEDGER_KEY).await.map_err(|_| internal("the wardrobe could not be read just now; try again"))?;
    let ledger = match &bytes {
        // A record that is not a ledger is refused, never read as empty, so
        // the next guarded commit cannot overwrite its journal.
        Some(b) => serde_json::from_slice::<Value>(b)
            .ok()
            .and_then(|v| Ledger::from_json(&v))
            .ok_or_else(|| CmdError::with("internal", "the stored ledger is unreadable; nothing more can be read or written until it is repaired", json!({"retryable": false})))?,
        None => Ledger::default(),
    };
    Ok((bytes, ledger))
}

fn command_key(id: &str) -> Vec<u8> {
    format!("c/{id}").into_bytes()
}

fn idempotency_key(key: &str) -> Vec<u8> {
    format!("i/{}", hex_digest(key.as_bytes())).into_bytes()
}

/// A stored command record that passed [`validate_record`]: the JSON exactly
/// as stored, and the parts the undo planner reads.
pub struct Record {
    pub value: Value,
    pub command: StoredCommand,
    pub request_hash: String,
}

fn corrupt_record(id: &str) -> CmdError {
    CmdError::with(
        "internal",
        "the stored record of that action is unreadable or incomplete; it cannot be read or undone until it is repaired, and nothing was written",
        json!({"retryable": false, "commandId": id}),
    )
}

/// Read one command record. Absent is `Ok(None)`; a record that does not pass
/// [`validate_record`] is an error, never absent and never a partial receipt.
async fn load_command<S: Store>(store: &mut S, id: &str) -> Result<Option<Record>, CmdError> {
    if id.is_empty() || id.len() > 64 {
        return Ok(None);
    }
    let bytes = store.get(&command_key(id)).await.map_err(|_| internal("the receipt could not be read just now; try again"))?;
    match bytes {
        None => Ok(None),
        Some(b) => validate_record(&b, id).map(Some).ok_or_else(|| corrupt_record(id)),
    }
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_command_id(s: &str) -> bool {
    s.starts_with("cmd_") && s.len() > 4 && s.len() <= 64
}

/// The one validator of a stored command record: every field `execute` writes
/// (the record's and its receipt's), each of the type it is written with, the
/// record of `command_id`, and its undo data consistent with its receipt.
/// Every read of a record goes through it; anything less is `None`.
pub fn validate_record(bytes: &[u8], command_id: &str) -> Option<Record> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let obj = value.as_object()?;
    const FIELDS: &[&str] = &["receipt", "requestHash", "payload", "authorization", "undo", "undoneBy", "undoes"];
    if obj.len() != FIELDS.len() || !FIELDS.iter().all(|f| obj.contains_key(*f)) {
        return None;
    }
    let rc = &value["receipt"];
    let kind = rc["type"].as_str().filter(|k| ledger::COMMAND_TYPES.contains(k))?.to_string();
    if !receipt_is_complete(rc, command_id, &kind) {
        return None;
    }
    let request_hash = value["requestHash"].as_str().filter(|h| is_hash(h))?.to_string();
    if !value["payload"].is_object() || !value["authorization"].as_str().map_or(false, |a| AUTHORIZATIONS.contains(&a)) {
        return None;
    }
    let undone_by = match &value["undoneBy"] {
        Value::Null => None,
        Value::String(s) if is_command_id(s) => Some(s.clone()),
        _ => return None,
    };
    // `undoes` names the target of an undo, and only of an undo; `result` is
    // exactly what each command type writes.
    let result = rc["result"].as_object()?;
    match (&value["undoes"], kind.as_str()) {
        (Value::String(s), "command.undo") if is_command_id(s) => {
            if result.len() != 1 || result.get("undoneCommandId") != Some(&value["undoes"]) {
                return None;
            }
        }
        (Value::Null, "care.mark_dirty") => {
            // `units` counts what the replay moved: 0 when every unit
            // reported was already in the wash.
            if result.len() != 1 || result.get("units").and_then(Value::as_u64).is_none() {
                return None;
            }
        }
        _ => return None,
    }
    // Exactly one of: undo data (offered by the receipt), or the reason the
    // receipt gives for offering none.
    let undo = value["undo"].as_object()?;
    let available = rc["undo"]["available"].as_bool()?;
    let undo = match (undo.len(), undo.get("data"), undo.get("unavailableReason")) {
        (1, Some(data), None) if available && rc["undo"]["reason"].is_null() => {
            let d = data.as_object()?;
            let ids = d.get("stockEventIds")?.as_array()?;
            if d.len() != 1 || ids.is_empty() || !ids.iter().all(|x| x.as_str().map_or(false, |s| !s.is_empty())) {
                return None;
            }
            Ok(data.clone())
        }
        (1, None, Some(Value::String(reason))) if !available && !reason.is_empty() && rc["undo"]["reason"].as_str() == Some(reason.as_str()) => Err(reason.clone()),
        _ => return None,
    };
    // A dirty report always carries undo data and an undo never does.
    match (kind.as_str(), &undo) {
        ("care.mark_dirty", Ok(_)) | ("command.undo", Err(_)) => {}
        _ => return None,
    }
    let command = StoredCommand {
        command_id: command_id.to_string(),
        kind,
        summary: rc["summary"].as_str()?.to_string(),
        undo,
        undone_by,
    };
    Some(Record { value, command, request_hash })
}

/// A stored receipt as it reads now: an undo already used is no longer offered.
fn current_receipt(record: &Value) -> Value {
    let mut receipt = record.get("receipt").cloned().unwrap_or(Value::Null);
    let undone = record.get("undoneBy").map_or(false, |v| !v.is_null());
    if undone && receipt["undo"]["available"] == json!(true) {
        receipt["undo"] = json!({"available": false, "reason": "this action was already undone"});
    }
    receipt
}

// ──────────────────────────────── reads ──────────────────────────────────

fn source(cat: &Catalogue) -> Value {
    json!({"name": cat.source_name, "sha256": cat.source_sha256, "importRunId": cat.import_run_id})
}

async fn read_wardrobe<S: Store>(store: &mut S, now_ms: u64, category: Option<&str>) -> Result<Value, CmdError> {
    let cat = catalogue();
    let (_, l) = read_ledger(store).await?;
    let items = ledger::inventory(cat, &l, category);
    let owned: u64 = cat.garments.iter().filter(|g| g.acquisition == "owned").map(|g| u64::from(g.quantity)).sum();
    Ok(json!({
        "items": items,
        "counts": {"garments": cat.garments.len(), "ownedUnits": owned},
        "wardrobeRevision": l.revision,
        "source": source(cat),
        "readAt": instant(now_ms),
    }))
}

async fn list_receipts<S: Store>(store: &mut S, limit: usize) -> Result<Value, CmdError> {
    let (_, l) = read_ledger(store).await?;
    let mut receipts = Vec::new();
    for id in l.recent.iter().take(limit) {
        // The ledger lists only commands committed with their record, so an
        // absent record is as corrupt as an unreadable one.
        match load_command(store, id).await? {
            Some(record) => receipts.push(current_receipt(&record.value)),
            None => return Err(corrupt_record(id)),
        }
    }
    Ok(json!({"receipts": receipts}))
}

// ─────────────────────────────── commands ─────────────────────────────────

const AUTHORIZATIONS: &[&str] = &["owner_tap", "owner_statement", "standing_policy", "system_schedule", "data_import"];
const CHANNELS: &[&str] = &["ios", "web", "mcp", "conversation", "scheduled", "import", "system", "test"];
const ENVELOPE_KEYS: &[&str] = &["type", "payload", "idempotencyKey", "expectedVersions", "occurredAt", "authorization", "source"];

struct Envelope {
    kind: String,
    payload: Value,
    idempotency_key: String,
    expected_versions: Value,
    occurred_at: Option<(String, u64)>,
    authorization: String,
    request_hash: String,
}

fn envelope_error(issue: impl Into<String>) -> CmdError {
    CmdError::with("invalid_command", "the command envelope is invalid", json!({"issues": [issue.into()]}))
}

fn parse_envelope(v: &Value) -> Result<Envelope, CmdError> {
    let Some(obj) = v.as_object() else { return Err(envelope_error("expected a JSON object")) };
    if let Some(k) = obj.keys().find(|k| !ENVELOPE_KEYS.contains(&k.as_str())) {
        return Err(envelope_error(format!("{k}: not a field of the command envelope")));
    }
    // Every number a command of this slice carries is a count or a version.
    // Refusing anything else keeps the request hash exactly JavaScript's.
    if !numbers_are_whole(v) {
        return Err(envelope_error(format!("numbers in a command must be whole numbers from 0 to {MAX_SAFE}")));
    }
    // Likewise every field name is plain ASCII, so key order hashes as in JavaScript.
    if !keys_are_plain(v) {
        return Err(envelope_error("field names in a command must be printable ASCII and not only digits"));
    }
    let kind = match v.get("type").and_then(Value::as_str) {
        Some(t) if !t.is_empty() && t.len() <= 64 => t.to_string(),
        _ => return Err(envelope_error("type: expected a command type")),
    };
    let payload = match v.get("payload") {
        Some(p) if p.is_object() => p.clone(),
        _ => return Err(envelope_error("payload: expected an object")),
    };
    let idempotency_key = match v.get("idempotencyKey").and_then(Value::as_str) {
        Some(k) if (8..=200).contains(&k.chars().count()) => k.to_string(),
        _ => return Err(envelope_error("idempotencyKey: expected 8 to 200 characters")),
    };
    let expected_versions = match v.get("expectedVersions") {
        None => json!({}),
        Some(Value::Object(m)) if m.values().all(Value::is_number) => Value::Object(m.clone()),
        _ => return Err(envelope_error("expectedVersions: expected an object of whole numbers")),
    };
    let occurred_at = match v.get("occurredAt") {
        None => None,
        Some(Value::String(s)) => match parse_instant(s) {
            Some(ms) => Some((s.clone(), ms)),
            None => return Err(envelope_error("occurredAt: expected UTC ISO 8601 instant")),
        },
        Some(_) => return Err(envelope_error("occurredAt: expected UTC ISO 8601 instant")),
    };
    let authorization = match v.get("authorization").and_then(Value::as_str) {
        Some(a) if AUTHORIZATIONS.contains(&a) => a.to_string(),
        _ => return Err(envelope_error("authorization: expected one of owner_tap, owner_statement, standing_policy, system_schedule, data_import")),
    };
    match v.get("source").and_then(|s| s.get("channel")).and_then(Value::as_str) {
        Some(c) if CHANNELS.contains(&c) => {}
        _ => return Err(envelope_error("source.channel: expected a channel")),
    }
    let request_hash = hex_digest(
        canonical(&json!({
            "type": kind,
            "payload": payload,
            "expectedVersions": expected_versions,
            "occurredAt": occurred_at.as_ref().map(|o| o.0.clone()),
            "authorization": authorization,
        }))
        .as_bytes(),
    );
    Ok(Envelope { kind, payload, idempotency_key, expected_versions, occurred_at, authorization, request_hash })
}

/// `checkAuthorization` in service.ts. Both commands of this slice are of
/// class observation or edit, which an owner tap or an owner statement
/// authorizes; only the owner can tap, and an assistant can only relay the
/// owner's words.
fn check_authorization(principal: Principal, env: &Envelope, source_channel: &str) -> Result<(), CmdError> {
    let allowed = ["owner_tap", "owner_statement"];
    if !allowed.contains(&env.authorization.as_str()) {
        return Err(CmdError::with("forbidden", format!("'{}' cannot be authorized by '{}'", env.kind, env.authorization), json!({"allowed": allowed})));
    }
    let actor_ok = (env.authorization == "owner_tap" && principal.actor == "owner") || (env.authorization == "owner_statement" && (principal.actor == "owner" || principal.actor == "assistant"));
    if !actor_ok {
        return Err(CmdError::with("forbidden", format!("authorization '{}' is not available to actor '{}'", env.authorization, principal.actor), json!({"actor": principal.actor})));
    }
    if source_channel != principal.channel {
        return Err(CmdError::with("forbidden", "the command's channel does not match the authenticated connection", json!({"expected": principal.channel})));
    }
    Ok(())
}

/// Client-stated versions, checked for edits (`command.undo`); observations
/// are rebased instead (section 5 of the specification).
fn check_expected_versions(env: &Envelope, l: &Ledger) -> Result<(), CmdError> {
    if env.kind != "command.undo" {
        return Ok(());
    }
    if let Some(map) = env.expected_versions.as_object() {
        for (key, want) in map {
            let (kind, id) = key.split_once(':').unwrap_or((key.as_str(), ""));
            let have = match kind {
                "wardrobe" => l.revision,
                "garment" => l.garment_version(id),
                _ => return Err(CmdError::with("invalid_command", format!("unknown expected-version kind '{kind}'"), json!({"key": key}))),
            };
            if Some(have) != whole(want) {
                return Err(CmdError::with("conflict", "this was changed elsewhere since you last saw it; nothing was written", json!({"failed": format!("expected {key} = {want}")})));
            }
        }
    }
    Ok(())
}

/// The stored receipt for this request's idempotency key, if it was already
/// committed. A marker that cannot be read is an unknown outcome.
async fn replay_existing<S: Store>(store: &mut S, env: &Envelope) -> Result<Option<Value>, CmdError> {
    let Some(bytes) = store.get(&idempotency_key(&env.idempotency_key)).await.map_err(|_| unknown_outcome())? else {
        return Ok(None);
    };
    // A marker this code did not write (unreadable, or not a command ID and a
    // request hash) settles nothing either way.
    let parsed = serde_json::from_slice::<Value>(&bytes).ok().and_then(|m| {
        let id = m.get("commandId")?.as_str()?.to_string();
        let hash = m.get("requestHash")?.as_str()?.to_string();
        (id.starts_with("cmd_") && id.len() <= 64 && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some((id, hash))
    });
    let Some((command_id, hash)) = parsed else { return Err(unknown_outcome()) };
    if hash != env.request_hash {
        return Err(CmdError::with("idempotency_key_reuse", "this idempotency key was already used with a different request body", json!({"commandId": command_id})));
    }
    // The marker says this request was written: a receipt that cannot be read
    // or is not that command's receipt must not read as a refusal, as nothing
    // written, or as an empty success.
    // `load_command` admits only a record that passes `validate_record`.
    let record = load_command(store, &command_id).await.ok().flatten();
    match record {
        Some(record) if record.request_hash == env.request_hash && record.command.kind == env.kind => {
            let mut receipt = current_receipt(&record.value);
            receipt["replayed"] = json!(true);
            Ok(Some(receipt))
        }
        _ => {
            let mut e = unknown_outcome();
            e.details["commandId"] = json!(command_id);
            Err(e)
        }
    }
}

/// Whether a stored receipt has every field `execute` writes, each of its
/// type, and is the receipt of `command_id` of type `kind`. Anything less
/// does not establish what the command did.
fn receipt_is_complete(rc: &Value, command_id: &str, kind: &str) -> bool {
    let Some(obj) = rc.as_object() else { return false };
    const FIELDS: &[&str] = &[
        "commandId", "type", "outcome", "summary", "affected", "externalEffectState", "effects", "undo", "repairs",
        "result", "occurredAt", "recordedAt", "wardrobeRevision", "replayed", "actor", "channel", "contractVersion",
    ];
    let str_of = |k: &str| rc[k].as_str();
    let instant_ok = |k: &str| str_of(k).and_then(parse_instant).is_some();
    let undo_ok = rc["undo"]["available"].is_boolean() && matches!(rc["undo"].get("reason"), Some(Value::Null) | Some(Value::String(_)));
    let affected_ok = rc["affected"].as_array().map_or(false, |a| a.iter().all(|x| x["kind"].is_string() && x["id"].is_string() && x["version"].is_u64()));
    let repairs_ok = rc["repairs"].as_array().map_or(false, |a| a.iter().all(Value::is_string));
    obj.len() == FIELDS.len()
        && FIELDS.iter().all(|f| obj.contains_key(*f))
        && str_of("commandId") == Some(command_id)
        && str_of("type") == Some(kind)
        && str_of("outcome") == Some("committed")
        && rc["summary"].as_str().map_or(false, |s| !s.is_empty())
        && affected_ok
        && rc["externalEffectState"].is_string()
        && rc["effects"].is_array()
        && undo_ok
        && repairs_ok
        && rc["result"].is_object()
        && instant_ok("occurredAt")
        && instant_ok("recordedAt")
        && rc["wardrobeRevision"].is_u64()
        && rc["replayed"].is_boolean()
        && matches!(str_of("actor"), Some("owner") | Some("assistant"))
        && rc["channel"].is_string()
        && str_of("contractVersion") == Some(CONTRACT_VERSION)
}

fn new_command_id(key: &str, now_ms: u64, attempt: u32) -> String {
    format!("cmd_{}", &hex_digest(format!("{key}\u{0}{now_ms}\u{0}{attempt}").as_bytes())[..32])
}

/// Execute one command envelope: validate, replay a repeated idempotency key,
/// plan against the current ledger, and commit the ledger, the receipt and the
/// idempotency marker in one guarded write; re-plan when another command won.
pub async fn execute<S: Store>(store: &mut S, principal: Principal, now_ms: u64, envelope: &Value) -> Result<Value, CmdError> {
    let env = parse_envelope(envelope)?;
    if !ledger::COMMAND_TYPES.contains(&env.kind.as_str()) {
        return Err(CmdError::with("unknown_command", format!("unknown command type '{}'", env.kind), json!({"known": ledger::COMMAND_TYPES})));
    }
    let source_channel = envelope["source"]["channel"].as_str().unwrap_or_default();
    check_authorization(principal, &env, source_channel)?;
    let undo_target = if env.kind == "command.undo" { Some(ledger::undo_target(&env.payload)?) } else { None };
    let occurred_at_ms = env.occurred_at.as_ref().map(|o| o.1).unwrap_or(now_ms);
    if occurred_at_ms > now_ms + FUTURE_SLACK_MS {
        return Err(CmdError::new("invalid_command", "occurredAt is in the future; an observation cannot be reported before it happens"));
    }

    let cat = catalogue();
    // Set once any commit attempt's outcome is unknown (its response was lost)
    // and never cleared: that write may be durable, so from then on no error
    // may say that nothing was written.
    let mut unconfirmed = false;
    let settle = |e: CmdError, unconfirmed: bool| if unconfirmed { unknown_outcome() } else { e };
    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            ferrite_app::sleep_ms(u64::from(5 * attempt + (now_ms % 7) as u32 * attempt)).await;
        }
        // The ledger (and its guard) is read before the idempotency marker. The
        // marker is only ever written in the same commit as the ledger, so if
        // it is absent now, any executor that commits this request after the
        // guard was read changes the ledger and this commit's guard fails;
        // the next attempt then finds the marker and replays the receipt.
        let (guard, current) = match read_ledger(store).await {
            Ok(read) => read,
            // A retry of a request that was committed must not be refused
            // as if it were not: the marker and its record settle it
            // without the ledger.
            Err(e) => {
                return match replay_existing(store, &env).await {
                    Ok(Some(receipt)) => Ok(receipt),
                    Ok(None) => Err(settle(e, unconfirmed)),
                    Err(e2) => Err(e2),
                };
            }
        };
        if let Some(receipt) = replay_existing(store, &env).await.map_err(|e| settle(e, unconfirmed))? {
            return Ok(receipt);
        }
        let command_id = new_command_id(&env.idempotency_key, now_ms, attempt);
        let ctx = Ctx { cat, command_id: &command_id, now_ms, occurred_at_ms };
        let mut next = current.clone();
        let mut original_record: Option<Record> = None;
        let planned: Result<Plan, CmdError> = match check_expected_versions(&env, &current) {
            Err(e) => Err(e),
            Ok(()) => match undo_target.as_deref() {
                None => ledger::mark_dirty(&ctx, &mut next, &env.payload),
                Some(target) => match load_command(store, target).await {
                    Ok(record) => {
                        original_record = record;
                        ledger::command_undo(&ctx, &mut next, original_record.as_ref().map(|r| &r.command), target)
                    }
                    Err(e) => Err(e),
                },
            },
        };
        let plan = match planned {
            Ok(plan) => plan,
            Err(e) => {
                // A refusal can be the trace of this very request committed by
                // another executor after the reads above (an undo it already
                // applied, a version it already moved): the marker settles it.
                return match replay_existing(store, &env).await {
                    Ok(Some(receipt)) => Ok(receipt),
                    Ok(None) => Err(settle(e, unconfirmed)),
                    Err(e2) => Err(e2),
                };
            }
        };
        next.revision = current.revision + 1;
        next.record_command(&command_id);

        let receipt = json!({
            "commandId": command_id,
            "type": env.kind,
            "outcome": plan.outcome,
            "summary": plan.summary,
            "affected": plan.affected,
            "externalEffectState": "none",
            "effects": [],
            "undo": {"available": plan.undo.is_ok(), "reason": match &plan.undo { Ok(_) => Value::Null, Err(r) => json!(r) }},
            "repairs": plan.repairs,
            "result": plan.result,
            "occurredAt": env.occurred_at.as_ref().map(|o| o.0.clone()).unwrap_or_else(|| instant(now_ms)),
            "recordedAt": instant(now_ms),
            "wardrobeRevision": next.revision,
            "replayed": false,
            "actor": principal.actor,
            "channel": principal.channel,
            "contractVersion": CONTRACT_VERSION,
        });
        let record = json!({
            "receipt": receipt,
            "requestHash": env.request_hash,
            "payload": env.payload,
            "authorization": env.authorization,
            "undo": match &plan.undo { Ok(d) => json!({"data": d}), Err(r) => json!({"unavailableReason": r}) },
            "undoneBy": Value::Null,
            "undoes": undo_target,
        });
        let marker = json!({"commandId": command_id, "requestHash": env.request_hash});
        let mut entries: Vec<(Vec<u8>, Vec<u8>)> = vec![
            (LEDGER_KEY.to_vec(), next.to_json().to_string().into_bytes()),
            (command_key(&command_id), record.to_string().into_bytes()),
            (idempotency_key(&env.idempotency_key), marker.to_string().into_bytes()),
        ];
        if let (Some(target), Some(original)) = (undo_target.as_deref(), original_record) {
            let mut original = original.value;
            original["undoneBy"] = json!(command_id);
            entries.push((command_key(target), original.to_string().into_bytes()));
        }
        let refs: Vec<(&[u8], &[u8])> = entries.iter().map(|(k, v)| (k.as_slice(), v.as_slice())).collect();
        match store.commit_n_if(LEDGER_KEY, guard.as_deref(), &refs).await {
            Ok(Ok(())) => return Ok(receipt),
            // Another command committed since this one read the ledger: re-plan
            // from fresh state (a retry of this same request is found above).
            Ok(Err(_)) => continue,
            // Unknown outcome: the next attempt's marker read settles it.
            Err(_) => unconfirmed = true,
        }
    }
    // The last guard rejection may itself have been this request committed by
    // another executor after the marker was read: the marker settles it.
    match replay_existing(store, &env).await? {
        Some(receipt) => Ok(receipt),
        None if unconfirmed => Err(unknown_outcome()),
        None => Err(CmdError::with(
            "internal",
            "the command could not be committed after repeated concurrent changes; nothing was written. It is safe to send it again with the same idempotency key",
            json!({"retryable": true}),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_app::serde_json::json;

    fn env(v: Value) -> Result<Envelope, CmdError> {
        parse_envelope(&v)
    }

    fn base() -> Value {
        json!({"type": "care.mark_dirty", "payload": {"items": [{"garmentId": "gmt_a"}]}, "idempotencyKey": "key-00000001", "authorization": "owner_statement", "source": {"channel": "mcp"}})
    }

    #[test]
    fn the_request_hash_ignores_key_order_number_spelling_and_the_idempotency_key() {
        let a = env(base()).unwrap();
        let mut other = base();
        other["idempotencyKey"] = json!("key-00000002");
        assert_eq!(env(other).unwrap().request_hash, a.request_hash);
        let one: Value = serde_json::from_str(r#"{"type":"care.mark_dirty","payload":{"items":[{"quantity":1,"garmentId":"gmt_a"}]},"idempotencyKey":"key-00000001","authorization":"owner_statement","source":{"channel":"mcp"}}"#).unwrap();
        let one_f: Value = serde_json::from_str(r#"{"type":"care.mark_dirty","payload":{"items":[{"garmentId":"gmt_a","quantity":1.0}]},"idempotencyKey":"key-00000001","authorization":"owner_statement","source":{"channel":"mcp"}}"#).unwrap();
        assert_eq!(env(one).unwrap().request_hash, env(one_f).unwrap().request_hash);
        let mut changed = base();
        changed["payload"] = json!({"items": [{"garmentId": "gmt_b"}]});
        assert_ne!(env(changed).unwrap().request_hash, a.request_hash);
    }

    #[test]
    fn envelope_validation_matches_the_contract() {
        let mut short = base();
        short["idempotencyKey"] = json!("short");
        assert_eq!(env(short).err().map(|e| e.code), Some("invalid_command"));
        let mut extra = base();
        extra["admin"] = json!(true);
        assert_eq!(env(extra).err().map(|e| e.code), Some("invalid_command"));
        let mut local = base();
        local["occurredAt"] = json!("2026-10-12T09:00:00+01:00");
        assert_eq!(env(local).err().map(|e| e.code), Some("invalid_command"));
        let mut fraction = base();
        fraction["payload"]["items"][0]["quantity"] = json!(1.5);
        assert_eq!(env(fraction).err().map(|e| e.code), Some("invalid_command"));
    }

    #[test]
    fn only_the_owner_can_tap_and_the_channel_must_match_the_connection() {
        let mut tap = base();
        tap["authorization"] = json!("owner_tap");
        let tap = env(tap).unwrap();
        assert_eq!(check_authorization(ASSISTANT, &tap, "mcp").unwrap_err().code, "forbidden");
        assert!(check_authorization(OWNER, &tap, "ios").is_ok());
        let statement = env(base()).unwrap();
        assert!(check_authorization(ASSISTANT, &statement, "mcp").is_ok());
        assert_eq!(check_authorization(ASSISTANT, &statement, "ios").unwrap_err().message, "the command's channel does not match the authenticated connection");
        let mut system = base();
        system["authorization"] = json!("system_schedule");
        assert_eq!(check_authorization(OWNER, &env(system).unwrap(), "ios").unwrap_err().code, "forbidden");
    }

    #[test]
    fn bearer_tokens_select_the_principal() {
        let tokens = Tokens { owner: Some("owner-secret".into()), assistant: Some("assistant-secret".into()) };
        let mut req = ferrite_app::IngressRequest {
            stream_open: false,
            correlation_id: String::new(),
            idempotency_key: String::new(),
            route: "/v1/".into(),
            path: "/v1/wardrobe".into(),
            method: "GET".into(),
            headers: vec![],
            body: vec![],
            deadline_ms: 0,
            reply_to: String::new(),
            published_ms: 0,
            native_caller: None,
            auth_context: None,
            verified_host: None,
        };
        assert_eq!(authenticate(&req, &tokens).unwrap_err().code, "unauthenticated");
        req.headers = vec![("authorization".into(), "Bearer owner-secret".into())];
        assert_eq!(authenticate(&req, &tokens).unwrap(), OWNER);
        req.headers = vec![("authorization".into(), "Bearer assistant-secret".into())];
        assert_eq!(authenticate(&req, &tokens).unwrap(), ASSISTANT);
        req.headers = vec![("authorization".into(), "Bearer guess".into())];
        assert_eq!(authenticate(&req, &tokens).unwrap_err().code, "unauthenticated");
        assert_eq!(authenticate(&req, &Tokens::default()).unwrap_err().code, "internal");
    }
}
