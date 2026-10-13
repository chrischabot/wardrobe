//! Portable export: `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/{id}`,
//! `POST /v1/exports/{id}/ticket` and the ticket-authenticated `GET /v1/exports/{id}/download`, as
//! apps/worker/src/export/job.ts and routes/export.ts define them for the app (`ExportRequest`,
//! `ExportJob`, `ExportList`, `DownloadTicket`).
//!
//! Built on the landed reads only. A request builds the whole package at once, inside the request
//! (the owner's records are a few hundred kilobytes and the request deadline is 8 s), so a job is
//! never `queued` or `running`: it answers `completed`, or `completed_incomplete` when a part could
//! not be read whole. The package is a ZIP archive written without compression (any unzip tool
//! opens it): `README.md`, `manifest.json`, `checksums.sha256`, one `records/<component>.json` per
//! component and readable `views/` (inventory and wear history as CSV, the profile document exactly
//! as supplied, a summary).
//!
//! What never leaves: the owner and assistant tokens, sign-in sessions, OAuth clients, codes,
//! grants and token hashes (connected assistants are listed by name, scopes and dates only),
//! notification device tokens (devices are listed by ID, environment and date only), download
//! tickets, idempotency markers, run records, and each command's request hash and internal undo
//! data. This server stores no photographs and no conversation yet, so the package holds none and no
//! location data can leave with it; `includeLocation` is recorded on the job and refused to anyone
//! but the owner.
//!
//! Storage: the index `exports` (its own commit guard) holds every job; a package is stored in parts
//! of [`PART_BYTES`] under `x/<exportId>/<n>`, written in the same guarded commit as its job. A
//! package may be downloaded for [`DOWNLOAD_WINDOW_MS`]; an expired package's parts are emptied by
//! the next export request.
//!
//! Differences from TypeScript, all stated in the README: no passphrase encryption (a request with
//! a passphrase is refused, never answered with an unencrypted package), the format is this
//! server's own (`garderobe-export/ferrite-1`, not the D1 table dump of `garderobe-export/1`), no
//! import, and the job's `runId` names no run in `GET /v1/runs/{id}`.

use std::collections::{BTreeMap, BTreeSet};

use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::{self, Principal, Reply, Store, OWNER};
use crate::ledger::{self, CmdError, Ledger, RECENT_LIMIT};
use crate::seed::catalogue;
use crate::sha256::{constant_time_eq, hex_digest};
use crate::time::instant;

const KEY: &[u8] = b"exports";
pub const FORMAT_VERSION: &str = "garderobe-export/ferrite-1";
/// How long a finished package can be downloaded (TypeScript: 24 hours).
pub const DOWNLOAD_WINDOW_MS: u64 = 24 * 3_600_000;
/// How long a download ticket is valid (TypeScript: 5 minutes). Each ticket works once.
pub const TICKET_TTL_MS: u64 = 5 * 60_000;
/// The largest package this server builds: a reply is bounded at about 4 MiB of arbitrary bytes.
pub const MAX_PACKAGE_BYTES: usize = 3 * 1024 * 1024;
/// The size of one stored part of a package.
pub const PART_BYTES: usize = 192 * 1024;
/// Jobs kept in the index; the oldest whose package was emptied make room.
pub const MAX_JOBS: usize = 20;
/// Exports one owner may request in an hour (TypeScript's rate limit).
pub const HOURLY_LIMIT: usize = 12;
/// Unexpired tickets kept per job; a newer ticket replaces the oldest.
const MAX_TICKETS: usize = 5;
const ATTEMPTS: usize = 3;
/// Reads of the owner's records before the package is marked as not describing one moment.
const BOUNDARY_ATTEMPTS: usize = 3;
/// The most command records one package reads.
const MAX_COMMANDS: usize = 5000;
/// Entries one guarded commit may carry (`ferrite_app::client::MAX_COMMIT_ENTRIES`).
const MAX_COMMIT_ENTRIES: usize = 64;

/// What a package never contains, as its manifest lists it.
pub const NEVER_EXPORTED: &[&str] = &[
    "the owner and assistant tokens (deploy secrets of this server)",
    "sign-in sessions of the app",
    "OAuth clients, authorization codes, grants and token hashes (connected assistants are listed by name, scopes and dates only)",
    "notification device tokens (devices are listed by ID, environment and date only)",
    "export download tickets",
    "idempotency markers and recommendation and assistant run records (operational)",
    "each command's request hash and internal undo data (its receipt, payload and undo links are included)",
];

// ────────────────────────────── jobs ──────────────────────────────

#[derive(Debug, Clone, PartialEq)]
struct Ticket {
    /// `hex(sha256(label ‖ ticket))`; the ticket itself is never stored.
    hash: String,
    expires_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct Job {
    export_id: String,
    client_request_id: String,
    include_location: bool,
    /// `completed` or `completed_incomplete`.
    state: String,
    requested_at_ms: u64,
    expires_at_ms: u64,
    snapshot: Value,
    /// `ExportComponent` values.
    components: Vec<Value>,
    byte_length: u64,
    sha256: String,
    parts: u64,
    /// The package's parts were emptied (it expired).
    cleared: bool,
    tickets: Vec<Ticket>,
}

fn id_ok(id: &str) -> bool {
    id.len() == 28 && id.starts_with("exp_") && id[4..].bytes().all(|b| b.is_ascii_hexdigit())
}

impl Job {
    fn to_json(&self) -> Value {
        json!({
            "exportId": self.export_id, "clientRequestId": self.client_request_id, "includeLocation": self.include_location,
            "state": self.state, "requestedAtMs": self.requested_at_ms, "expiresAtMs": self.expires_at_ms, "snapshot": self.snapshot,
            "components": self.components, "byteLength": self.byte_length, "sha256": self.sha256, "parts": self.parts, "cleared": self.cleared,
            "tickets": self.tickets.iter().map(|t| json!({"hash": t.hash, "expiresAtMs": t.expires_at_ms})).collect::<Vec<_>>(),
        })
    }

    fn from_json(v: &Value) -> Option<Job> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let n = |k: &str| v.get(k).and_then(Value::as_u64);
        let tickets = v.get("tickets")?.as_array()?.iter().map(|t| {
            let hash = t.get("hash")?.as_str()?.to_string();
            (hash.len() == 64).then_some(Ticket { hash, expires_at_ms: t.get("expiresAtMs")?.as_u64()? })
        }).collect::<Option<Vec<_>>>()?;
        let job = Job {
            export_id: s("exportId")?,
            client_request_id: s("clientRequestId")?,
            include_location: v.get("includeLocation")?.as_bool()?,
            state: s("state")?,
            requested_at_ms: n("requestedAtMs")?,
            expires_at_ms: n("expiresAtMs")?,
            snapshot: v.get("snapshot")?.clone(),
            components: v.get("components")?.as_array()?.clone(),
            byte_length: n("byteLength")?,
            sha256: s("sha256")?,
            parts: n("parts")?,
            cleared: v.get("cleared")?.as_bool()?,
            tickets,
        };
        (id_ok(&job.export_id) && ["completed", "completed_incomplete"].contains(&job.state.as_str()) && job.sha256.len() == 64).then_some(job)
    }

    fn expired(&self, now_ms: u64) -> bool {
        self.cleared || now_ms >= self.expires_at_ms
    }

    fn file_name(&self) -> String {
        format!("garderobe-export-{}-{}.zip", &instant(self.requested_at_ms)[..10], &self.export_id[4..10])
    }

    /// `ExportJob`.
    fn view(&self, now_ms: u64) -> Value {
        let state = if self.expired(now_ms) { "expired" } else { self.state.as_str() };
        let complete = state == "completed" && self.components.iter().all(|c| c["state"] == "complete");
        json!({
            "exportId": self.export_id,
            "runId": format!("run_{}", self.export_id),
            "state": state,
            "complete": complete,
            "encrypted": false,
            "includesLocation": self.include_location,
            "formatVersion": FORMAT_VERSION,
            "requestedAt": instant(self.requested_at_ms),
            // The package is built within the request that asked for it.
            "finishedAt": instant(self.requested_at_ms),
            "expiresAt": instant(self.expires_at_ms),
            "snapshot": self.snapshot,
            "components": self.components,
            "byteLength": self.byte_length,
            "sha256": self.sha256,
        })
    }
}

fn part_key(export_id: &str, n: u64) -> Vec<u8> {
    format!("x/{export_id}/{n}").into_bytes()
}

fn ticket_hash(ticket: &str) -> String {
    hex_digest(format!("wardrobe/export-ticket/v1\n{ticket}").as_bytes())
}

fn internal(message: &str) -> CmdError {
    CmdError::with("internal", message, json!({"retryable": true}))
}

fn corrupt() -> CmdError {
    CmdError::with("internal", "the stored list of exports is unreadable; nothing was changed", json!({"retryable": false}))
}

async fn read<S: Store>(store: &mut S) -> Result<(Option<Vec<u8>>, Vec<Job>), CmdError> {
    let bytes = store.get(KEY).await.map_err(|_| internal("the exports could not be read just now; try again"))?;
    let jobs = match &bytes {
        None => Vec::new(),
        Some(b) => {
            let v: Value = serde_json::from_slice(b).map_err(|_| corrupt())?;
            if v["v"] != 1 {
                return Err(corrupt());
            }
            v["jobs"].as_array().ok_or_else(corrupt)?.iter().map(Job::from_json).collect::<Option<Vec<_>>>().ok_or_else(corrupt)?
        }
    };
    Ok((bytes, jobs))
}

/// Write `jobs` with `extra` records if the index is still `old`; `false` when another request changed it first.
async fn commit<S: Store>(store: &mut S, old: Option<&[u8]>, jobs: &[Job], extra: &[(Vec<u8>, Vec<u8>)]) -> Result<bool, CmdError> {
    let record = json!({"v": 1, "jobs": jobs.iter().map(Job::to_json).collect::<Vec<_>>()}).to_string();
    let mut entries: Vec<(&[u8], &[u8])> = vec![(KEY, record.as_bytes())];
    entries.extend(extra.iter().map(|(k, v)| (k.as_slice(), v.as_slice())));
    match store.commit_n_if(KEY, old, &entries).await {
        Ok(Ok(())) => Ok(true),
        Ok(Err(_)) => Ok(false),
        Err(_) => Err(internal("the export could not be saved just now; whether it was is unknown, so read the exports and try again")),
    }
}

fn owner_only(principal: Principal) -> Result<(), CmdError> {
    if principal == OWNER {
        Ok(())
    } else {
        Err(CmdError::new("forbidden", "only the owner exports the wardrobe, in the Garderobe app"))
    }
}

// ─────────────────────────────── routes ───────────────────────────────

/// The export ID of `GET /v1/exports/{id}`, if the path is one.
pub fn job_target(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/exports/")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

/// The export ID of `POST /v1/exports/{id}/ticket`, if the path is one.
pub fn ticket_target(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/exports/")?.strip_suffix("/ticket")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

/// The export ID of `GET /v1/exports/{id}/download`, if the path is one.
pub fn download_target(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/exports/")?.strip_suffix("/download")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

struct Request {
    client_request_id: String,
    include_location: bool,
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("invalid_command", message)
}

fn parse_request(body: &[u8]) -> Result<Request, CmdError> {
    let m: Map<String, Value> = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => m,
        Ok(_) => return Err(invalid("the request body must be a JSON object")),
        Err(_) => return Err(invalid("the request body is not valid JSON")),
    };
    if let Some(k) = m.keys().find(|k| !["clientRequestId", "passphrase", "includeLocation"].contains(&k.as_str())) {
        return Err(invalid(format!("'{k}' is not a field of an export request")));
    }
    let client_request_id = match m.get("clientRequestId") {
        Some(Value::String(s)) if (8..=128).contains(&s.chars().count()) => s.clone(),
        _ => return Err(invalid("clientRequestId: expected 8 to 128 characters")),
    };
    let include_location = match m.get("includeLocation") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(invalid("includeLocation: expected true or false")),
    };
    match m.get("passphrase") {
        None | Some(Value::Null) => {}
        // Never an unencrypted package when encryption was asked for.
        Some(_) => {
            return Err(CmdError::with(
                "module_unavailable",
                "encrypting the export with a passphrase is not available on this server; export without a passphrase (the package is then not encrypted). Nothing was started",
                json!({"module": "export-encryption"}),
            ))
        }
    }
    Ok(Request { client_request_id, include_location })
}

/// Refused once [`HOURLY_LIMIT`] exports were requested in the last hour. Checked before the package
/// is built and again against the freshly read index inside every guarded commit attempt, so
/// concurrent requests cannot together pass the limit.
fn hourly_limit(jobs: &[Job], now_ms: u64) -> Result<(), CmdError> {
    if jobs.iter().filter(|j| now_ms.saturating_sub(j.requested_at_ms) < 3_600_000).count() >= HOURLY_LIMIT {
        return Err(CmdError::with("rate_limited", format!("at most {HOURLY_LIMIT} exports can be requested in an hour; try again later"), json!({"retryable": true})));
    }
    Ok(())
}

fn same_request(job: &Job, req: &Request, now_ms: u64) -> Result<Value, CmdError> {
    if job.include_location != req.include_location {
        return Err(CmdError::new("idempotency_key_reuse", "that request ID was already used for a different export request"));
    }
    Ok(job.view(now_ms))
}

/// `POST /v1/exports` (`ExportRequest` → `ExportJob`). The same `clientRequestId` answers the same
/// job again, whatever state it is in now.
pub async fn start<S: Store>(store: &mut S, principal: Principal, now_ms: u64, body: &[u8]) -> Result<Value, CmdError> {
    owner_only(principal)?;
    let req = parse_request(body)?;
    let (_, jobs) = read(store).await?;
    if let Some(job) = jobs.iter().find(|j| j.client_request_id == req.client_request_id) {
        return same_request(job, &req, now_ms);
    }
    hourly_limit(&jobs, now_ms)?;
    let export_id = format!("exp_{}", crate::random::token(12));
    let built = build(store, now_ms, &export_id, req.include_location).await?;
    if built.bytes.len() > MAX_PACKAGE_BYTES {
        return Err(CmdError::with(
            "payload_too_large",
            format!("the package would be {} bytes, over this server's limit of {MAX_PACKAGE_BYTES} bytes for one download; nothing was kept", built.bytes.len()),
            json!({"limit": MAX_PACKAGE_BYTES}),
        ));
    }
    let parts: Vec<&[u8]> = built.bytes.chunks(PART_BYTES).collect();
    let job = Job {
        export_id: export_id.clone(),
        client_request_id: req.client_request_id.clone(),
        include_location: req.include_location,
        state: if built.complete { "completed" } else { "completed_incomplete" }.into(),
        requested_at_ms: now_ms,
        expires_at_ms: now_ms + DOWNLOAD_WINDOW_MS,
        snapshot: built.snapshot,
        components: built.components,
        byte_length: built.bytes.len() as u64,
        sha256: hex_digest(&built.bytes),
        parts: parts.len() as u64,
        cleared: false,
        tickets: Vec::new(),
    };
    for _ in 0..ATTEMPTS {
        let (old, mut jobs) = read(store).await?;
        // Another delivery of this request finished first: its job is the answer.
        if let Some(existing) = jobs.iter().find(|j| j.client_request_id == req.client_request_id) {
            return same_request(existing, &req, now_ms);
        }
        // Another request may have added a job since the first check.
        hourly_limit(&jobs, now_ms)?;
        let mut extra: Vec<(Vec<u8>, Vec<u8>)> = parts.iter().enumerate().map(|(n, p)| (part_key(&export_id, n as u64), p.to_vec())).collect();
        // Expired packages are emptied, as many as this commit can carry.
        let mut budget = MAX_COMMIT_ENTRIES - 1 - extra.len();
        for j in jobs.iter_mut().filter(|j| !j.cleared && j.expired(now_ms)) {
            if j.parts as usize > budget {
                break;
            }
            budget -= j.parts as usize;
            extra.extend((0..j.parts).map(|n| (part_key(&j.export_id, n), Vec::new())));
            j.cleared = true;
            j.tickets.clear();
        }
        while jobs.len() >= MAX_JOBS {
            match jobs.iter().position(|j| j.cleared) {
                Some(i) => {
                    jobs.remove(i);
                }
                None => {
                    return Err(CmdError::with(
                        "rate_limited",
                        format!("{MAX_JOBS} exports can still be downloaded; try again once the oldest has expired"),
                        json!({"retryable": true}),
                    ))
                }
            }
        }
        jobs.push(job.clone());
        if commit(store, old.as_deref(), &jobs, &extra).await? {
            return Ok(job.view(now_ms));
        }
    }
    Err(CmdError::with("conflict", "the exports kept changing; try again", json!({"retryable": true})))
}

/// `GET /v1/exports` (`ExportList`): the newest first.
pub async fn list<S: Store>(store: &mut S, principal: Principal, now_ms: u64) -> Result<Value, CmdError> {
    owner_only(principal)?;
    let (_, mut jobs) = read(store).await?;
    jobs.sort_by(|a, b| b.requested_at_ms.cmp(&a.requested_at_ms).then_with(|| a.export_id.cmp(&b.export_id)));
    Ok(json!({"exports": jobs.iter().map(|j| j.view(now_ms)).collect::<Vec<_>>()}))
}

/// `GET /v1/exports/{id}` (`ExportJob`).
pub async fn get<S: Store>(store: &mut S, principal: Principal, now_ms: u64, export_id: &str) -> Result<Value, CmdError> {
    owner_only(principal)?;
    let (_, jobs) = read(store).await?;
    jobs.iter().find(|j| j.export_id == export_id).map(|j| j.view(now_ms)).ok_or_else(|| CmdError::new("not_found", "that export was not found"))
}

/// `POST /v1/exports/{id}/ticket` (`DownloadTicket`): a short-lived, single-use download link. Only
/// the ticket's hash is stored.
pub async fn ticket<S: Store>(store: &mut S, principal: Principal, now_ms: u64, export_id: &str) -> Result<Value, CmdError> {
    owner_only(principal)?;
    for _ in 0..ATTEMPTS {
        let (old, mut jobs) = read(store).await?;
        let Some(job) = jobs.iter_mut().find(|j| j.export_id == export_id) else {
            return Err(CmdError::new("not_found", "that export was not found"));
        };
        if job.expired(now_ms) {
            return Err(CmdError::new("expired", "this export has expired; request a new one"));
        }
        let token = crate::random::token(32);
        // A ticket never outlives its package.
        let expires_at_ms = (now_ms + TICKET_TTL_MS).min(job.expires_at_ms);
        job.tickets.retain(|t| t.expires_at_ms > now_ms);
        while job.tickets.len() >= MAX_TICKETS {
            job.tickets.remove(0);
        }
        job.tickets.push(Ticket { hash: ticket_hash(&token), expires_at_ms });
        let file_name = job.file_name();
        if commit(store, old.as_deref(), &jobs, &[]).await? {
            return Ok(json!({"url": format!("/v1/exports/{export_id}/download?ticket={token}"), "expiresAt": instant(expires_at_ms), "fileName": file_name}));
        }
    }
    Err(CmdError::with("conflict", "the exports kept changing; try again", json!({"retryable": true})))
}

fn not_valid() -> CmdError {
    CmdError::new("unauthenticated", "this download link is not valid, has expired or was already used; ask for a new one")
}

/// `GET /v1/exports/{id}/download?ticket=…`: the package, for a valid ticket. The ticket is the whole
/// authorization and is spent before a byte is sent.
pub async fn download<S: Store>(store: &mut S, now_ms: u64, export_id: &str, ticket: Option<&str>) -> Result<Reply, CmdError> {
    let Some(ticket) = ticket.filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())) else {
        return Err(not_valid());
    };
    let hash = ticket_hash(ticket);
    let mut spent = None;
    for _ in 0..ATTEMPTS {
        let (old, mut jobs) = read(store).await?;
        let Some(job) = jobs.iter_mut().find(|j| j.export_id == export_id) else { return Err(not_valid()) };
        let Some(i) = job.tickets.iter().position(|t| constant_time_eq(t.hash.as_bytes(), hash.as_bytes())) else { return Err(not_valid()) };
        if job.tickets[i].expires_at_ms <= now_ms {
            return Err(CmdError::new("expired", "this download link has expired; ask for a new one"));
        }
        if job.expired(now_ms) {
            return Err(CmdError::new("expired", "this export has expired; request a new one"));
        }
        job.tickets.remove(i);
        let snapshot = job.clone();
        if commit(store, old.as_deref(), &jobs, &[]).await? {
            spent = Some(snapshot);
            break;
        }
    }
    let Some(job) = spent else { return Err(CmdError::with("conflict", "the exports kept changing; try again", json!({"retryable": true}))) };
    let damaged = || CmdError::with("internal", "the stored package is damaged; request a new export", json!({"retryable": false}));
    let mut bytes = Vec::with_capacity(job.byte_length as usize);
    for n in 0..job.parts {
        let part = store.get(&part_key(&job.export_id, n)).await.map_err(|_| internal("the package could not be read just now; ask for a new download link"))?;
        bytes.extend(part.ok_or_else(damaged)?);
    }
    if bytes.len() as u64 != job.byte_length || hex_digest(&bytes) != job.sha256 {
        return Err(damaged());
    }
    Ok(Reply {
        status: 200,
        body: Value::Null,
        headers: vec![
            ("content-disposition".into(), format!("attachment; filename=\"{}\"", job.file_name())),
            ("x-garderobe-export-sha256".into(), job.sha256.clone()),
        ],
        raw: Some(("application/zip".into(), bytes)),
    })
}

// ─────────────────────────────── collection ───────────────────────────────

struct Part {
    name: &'static str,
    title: &'static str,
    /// `complete` or `incomplete`.
    state: &'static str,
    records: usize,
    note: Option<String>,
    value: Value,
}

impl Part {
    fn component(&self) -> Value {
        json!({"name": self.name, "state": self.state, "records": self.records, "note": self.note})
    }
}

/// Every string in `v` that is a command ID.
fn command_ids(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::String(s) if s.starts_with("cmd_") && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') => {
            out.insert(s.clone());
        }
        Value::Array(a) => a.iter().for_each(|x| command_ids(x, out)),
        Value::Object(m) => m.values().for_each(|x| command_ids(x, out)),
        _ => {}
    }
}

/// Every string value of a `feedbackId` field in `v`.
fn feedback_ids(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::Array(a) => a.iter().for_each(|x| feedback_ids(x, out)),
        Value::Object(m) => {
            for (k, x) in m {
                match x {
                    Value::String(s) if k == "feedbackId" && !s.is_empty() && s.chars().count() <= 128 => {
                        out.insert(s.clone());
                    }
                    _ => feedback_ids(x, out),
                }
            }
        }
        _ => {}
    }
}

/// One stored record as JSON: `Ok(None)` when absent or unreadable.
async fn raw<S: Store>(store: &mut S, key: &[u8]) -> Result<Option<Value>, CmdError> {
    let bytes = store.get(key).await.map_err(|_| internal("the wardrobe could not be read just now; try again"))?;
    Ok(bytes.and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(Value::is_object))
}

fn part(name: &'static str, title: &'static str, records: usize, missing: usize, what: &str, value: Value) -> Part {
    let (state, note) = if missing == 0 { ("complete", None) } else { ("incomplete", Some(format!("{missing} {what} could not be read and are missing from this package"))) };
    Part { name, title, state, records, note, value }
}

struct Collected {
    ledger: Ledger,
    parts: Vec<Part>,
    last_command_at: Option<String>,
}

/// Read every component of the package from the records the landed routes read.
async fn collect<S: Store>(store: &mut S, now_ms: u64, l: &Ledger) -> Result<Collected, CmdError> {
    let cat = catalogue();
    let mut parts = Vec::new();
    let mut seen = BTreeSet::new();

    let imported: Value = serde_json::from_str(crate::seed::source()).map_err(|_| internal("the imported inventory could not be read"))?;
    parts.push(part("inventory", "Garments as imported from the inventory sheet, with their current versions", cat.garments.len(), 0, "", json!({"imported": imported, "versions": l.versions})));

    let ledger_json = l.to_json();
    command_ids(&ledger_json, &mut seen);
    let movements = l.events.len() + l.observations.len() + l.wears.len() + l.batches.len();
    parts.push(part("ledger", "Quantity movements, wear reports and counted wears, laundry batches", movements, 0, "", ledger_json));

    let mut boards = Vec::new();
    let mut missing = 0;
    for b in &l.boards {
        match raw(store, &api::board_key(&b.board_id)).await? {
            Some(v) => boards.push(v),
            None => missing += 1,
        }
    }
    boards.iter().for_each(|v| command_ids(v, &mut seen));
    parts.push(part("boards", "Day boards and every revision of them, with the choices made", boards.len(), missing, "boards", json!(boards)));

    let mut trips = Vec::new();
    let mut missing = 0;
    for id in l.trips.keys() {
        let Some(trip) = raw(store, &crate::trips::key(id)).await? else {
            missing += 1;
            continue;
        };
        let mut proposals = Vec::new();
        for revision in 1..=trip["proposalRevision"].as_u64().unwrap_or(0) {
            match raw(store, &crate::trips::proposal_key(id, revision)).await? {
                Some(p) => proposals.push(p),
                None => missing += 1,
            }
        }
        trips.push(json!({"trip": trip, "packingProposals": proposals}));
    }
    trips.iter().for_each(|v| command_ids(v, &mut seen));
    parts.push(part("trips", "Trips and their packing proposals", trips.len(), missing, "trip records", json!(trips)));

    let mut cases = Vec::new();
    let mut missing = 0;
    for id in l.returns.keys() {
        match raw(store, &crate::returns::key(id)).await? {
            Some(v) => cases.push(v),
            None => missing += 1,
        }
    }
    cases.iter().for_each(|v| command_ids(v, &mut seen));
    parts.push(part("returns", "Returns and exchanges", cases.len(), missing, "returns", json!(cases)));

    // Receipts: every command the records above name, the newest commands, and every command those
    // name in turn (undo links); comfort notes withdrawn since are found through their receipts.
    let mut notes: BTreeMap<String, Value> = BTreeMap::new();
    let mut notes_missing = 0;
    let mut wanted_notes: BTreeSet<String> = l.feedback.iter().cloned().collect();
    seen.extend(l.recent.iter().cloned());
    let mut queue: Vec<String> = seen.iter().cloned().collect();
    let mut receipts: BTreeMap<String, Value> = BTreeMap::new();
    let mut receipts_missing = 0;
    let mut over = false;
    loop {
        for id in std::mem::take(&mut wanted_notes) {
            if notes.contains_key(&id) {
                continue;
            }
            match raw(store, &crate::feedback::key(&id)).await? {
                Some(v) => {
                    let mut found = BTreeSet::new();
                    command_ids(&v, &mut found);
                    queue.extend(found.into_iter().filter(|c| seen.insert(c.clone())));
                    notes.insert(id, v);
                }
                // An ID named in a receipt need not be a stored note (a refused or other ID); only the
                // notes the ledger lists must exist.
                None if l.feedback.contains(&id) => notes_missing += 1,
                None => {}
            }
        }
        let Some(id) = queue.pop() else { break };
        if receipts.len() >= MAX_COMMANDS {
            over = true;
            break;
        }
        let Some(record) = raw(store, &api::command_key(&id)).await? else {
            receipts_missing += 1;
            continue;
        };
        let mut found = BTreeSet::new();
        command_ids(&record, &mut found);
        queue.extend(found.into_iter().filter(|c| seen.insert(c.clone())));
        if record["receipt"]["type"] == "feedback.record" {
            feedback_ids(&record, &mut wanted_notes);
        }
        // The receipt, what was asked and the undo links; never the request hash or the internal undo data.
        let kept: Map<String, Value> = ["receipt", "payload", "authorization", "undoneBy", "undoes"].iter().filter_map(|k| record.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
        receipts.insert(id, Value::Object(kept));
    }
    let last_command_at = l.recent.first().and_then(|id| receipts.get(id)).and_then(|r| r["receipt"]["recordedAt"].as_str()).map(str::to_string);
    let mut receipt_part = part("receipts", "Command receipts with what was asked and their undo links", receipts.len(), receipts_missing, "receipts", json!(receipts.values().collect::<Vec<_>>()));
    if receipt_part.state == "complete" && (over || l.recent.len() >= RECENT_LIMIT) {
        receipt_part.state = "incomplete";
        receipt_part.note = Some(if over {
            format!("more than {MAX_COMMANDS} receipts; the rest are missing from this package")
        } else {
            format!("this server indexes only the newest {RECENT_LIMIT} commands; an older command that left no trace in another record is missing from this package")
        });
    }
    let feedback_part = part("feedback", "Comfort notes, withdrawn ones included", notes.len(), notes_missing, "comfort notes", json!(notes.values().collect::<Vec<_>>()));
    parts.push(feedback_part);
    parts.push(receipt_part);

    let style = crate::style::seed();
    let style_records = 1 + ["rules", "measurements", "sizeExperiences"].iter().map(|k| style[*k].as_array().map_or(0, Vec::len)).sum::<usize>();
    parts.push(part("style", "The profile document exactly as supplied, its rules, measurements and size experiences", style_records, 0, "", style.clone()));

    // The account summary: names and dates only, never a token or its hash.
    let devices = crate::devices::list(store).await;
    let assistants = crate::oauth::list_assistants(store, now_ms).await;
    let unreadable = usize::from(devices.is_err()) + usize::from(assistants.is_err());
    let devices = devices.map(|d| d["devices"].clone()).unwrap_or(Value::Null);
    let assistants = assistants.map(|a| a["grants"].clone()).unwrap_or(Value::Null);
    let records = devices.as_array().map_or(0, Vec::len) + assistants.as_array().map_or(0, Vec::len);
    parts.push(part(
        "account",
        "Notification devices and connected assistants (no tokens or credentials)",
        records,
        unreadable,
        "lists",
        json!({
            "note": "For your information only: no sign-in, session, token or credential is in this package; reconnect assistants and devices yourself.",
            "devices": devices,
            "connectedAssistants": assistants,
        }),
    ));

    let none = |name: &'static str, title: &'static str, note: &str| Part { name, title, state: "complete", records: 0, note: Some(note.to_string()), value: json!({"note": note}) };
    parts.push(none("conversation", "Conversation messages", "this server stores no conversation (the conversation is not ported to it), so there are no messages to include"));
    // Photographs are stored (`src/media.rs`) but not yet packaged: say so rather than claim the
    // component complete.
    let media_title = "Photographs and derived images";
    parts.push(match crate::media::stored_count(store).await {
        Ok(0) => none("media", media_title, "no photographs are stored, so the package holds none and no location data"),
        Ok(n) => {
            let note = format!("{n} photographs are stored on this server, but this export does not package photographs yet, so none of them, and no location data, is in this package");
            Part { name: "media", title: media_title, state: "incomplete", records: 0, value: json!({"note": note, "storedPhotographs": n}), note: Some(note) }
        }
        Err(_) => {
            let note = "the list of photographs could not be read, so none is in this package".to_string();
            Part { name: "media", title: media_title, state: "incomplete", records: 0, value: json!({"note": note}), note: Some(note) }
        }
    });

    Ok(Collected { ledger: l.clone(), parts, last_command_at })
}

struct Built {
    bytes: Vec<u8>,
    components: Vec<Value>,
    snapshot: Value,
    complete: bool,
}

/// Collect under a version boundary (the same ledger before and after the reads), then write the
/// package. A wardrobe that kept changing is packaged as read, with every part marked incomplete.
async fn build<S: Store>(store: &mut S, now_ms: u64, export_id: &str, include_location: bool) -> Result<Built, CmdError> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let (before, l) = api::read_ledger(store).await?;
        let mut collected = collect(store, now_ms, &l).await?;
        let after = store.get(b"ledger").await.map_err(|_| internal("the wardrobe could not be read just now; try again"))?;
        let coherent = before == after;
        if coherent || attempt >= BOUNDARY_ATTEMPTS {
            if !coherent {
                for p in collected.parts.iter_mut().filter(|p| p.state == "complete" && p.name != "account") {
                    p.state = "incomplete";
                    p.note = Some("the wardrobe kept changing while it was read, so these records may not describe one moment; export again".into());
                }
            }
            return Ok(package(&collected, now_ms, export_id, include_location, coherent));
        }
    }
}

// ─────────────────────────────── package ───────────────────────────────

fn package(c: &Collected, now_ms: u64, export_id: &str, include_location: bool, coherent: bool) -> Built {
    let exported_at = instant(now_ms);
    let snapshot = json!({
        "takenAt": exported_at,
        "wardrobeRevision": c.ledger.revision,
        "styleRevision": crate::style::seed()["version"].as_u64().unwrap_or(1),
        "lastCommandRecordedAt": c.last_command_at,
    });
    let complete = c.parts.iter().all(|p| p.state == "complete");
    let mut zip = Zip::new(&exported_at);
    let mut files: Vec<Value> = Vec::new();
    let add = |zip: &mut Zip, files: &mut Vec<Value>, path: &str, data: &[u8]| {
        zip.add(path, data);
        files.push(json!({"path": path, "bytes": data.len(), "sha256": hex_digest(data)}));
    };
    let mut component_files: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for p in &c.parts {
        let path = format!("records/{}.json", p.name);
        let text = serde_json::to_string_pretty(&p.value).unwrap_or_default();
        add(&mut zip, &mut files, &path, text.as_bytes());
        component_files.entry(p.name).or_default().push(path);
    }
    for (path, text) in views(c, &snapshot) {
        add(&mut zip, &mut files, path, text.as_bytes());
    }
    add(&mut zip, &mut files, "README.md", readme(&exported_at, complete).as_bytes());
    let manifest = json!({
        "format": FORMAT_VERSION,
        "contractVersion": api::CONTRACT_VERSION,
        "exportId": export_id,
        "exportedAt": exported_at,
        "complete": complete,
        "includesLocation": include_location,
        "snapshot": {"takenAt": snapshot["takenAt"], "wardrobeRevision": snapshot["wardrobeRevision"], "styleRevision": snapshot["styleRevision"], "lastCommandRecordedAt": snapshot["lastCommandRecordedAt"], "coherent": coherent},
        "components": c.parts.iter().map(|p| json!({"name": p.name, "title": p.title, "state": p.state, "records": p.records, "note": p.note, "files": component_files.get(p.name).cloned().unwrap_or_default()})).collect::<Vec<_>>(),
        "excluded": NEVER_EXPORTED,
        "files": files,
    });
    let manifest_text = serde_json::to_string_pretty(&manifest).unwrap_or_default();
    add(&mut zip, &mut files, "manifest.json", manifest_text.as_bytes());
    let checksums: String = files.iter().map(|f| format!("{}  {}\n", f["sha256"].as_str().unwrap_or_default(), f["path"].as_str().unwrap_or_default())).collect();
    zip.add("checksums.sha256", checksums.as_bytes());
    Built { bytes: zip.finish(), components: c.parts.iter().map(Part::component).collect(), snapshot, complete }
}

/// One CSV field: quoted when it needs to be, and a text that a spreadsheet would read as a formula
/// is prefixed with an apostrophe.
fn csv_field(text: &str) -> String {
    let text = if text.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{text}") } else { text.to_string() };
    if text.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

fn csv(header: &[&str], rows: Vec<Vec<String>>) -> String {
    let mut out = header.join(",") + "\n";
    for row in rows {
        out += &row.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(",");
        out.push('\n');
    }
    out
}

fn views(c: &Collected, snapshot: &Value) -> Vec<(&'static str, String)> {
    let cat = catalogue();
    let l = &c.ledger;
    let stock = ledger::replay(cat, &l.events);
    let mut wears: BTreeMap<&str, (usize, &str)> = BTreeMap::new();
    for w in l.wears.iter().filter(|w| w.active) {
        let e = wears.entry(w.garment_id.as_str()).or_insert((0, ""));
        e.0 += 1;
        if w.wearing_date.as_str() > e.1 {
            e.1 = w.wearing_date.as_str();
        }
    }
    let inventory = csv(
        &["garment_id", "name", "category", "colour", "care_channel", "units", "clean", "awaiting_care", "at_laundry", "packed", "recorded_wears", "last_recorded_wear"],
        cat.garments
            .iter()
            .map(|g| {
                let st = stock.of(&g.id);
                let laundry: u32 = stock.service.get(&g.id).map_or(0, |m| m.values().map(|h| h.quantity).sum());
                let packed: u32 = stock.trips.get(&g.id).map_or(0, |t| t.iter().map(|(_, s)| s.clean + s.dirty).sum());
                let (n, last) = wears.get(g.id.as_str()).copied().unwrap_or((0, ""));
                vec![g.id.clone(), g.name.clone(), g.category.clone(), g.colour.clone().unwrap_or_default(), g.care_channel.clone(), g.quantity.to_string(), st.clean.to_string(), st.dirty.to_string(), laundry.to_string(), packed.to_string(), n.to_string(), last.to_string()]
            })
            .collect(),
    );
    let mut counted: Vec<_> = l.wears.iter().filter(|w| w.active).collect();
    counted.sort_by(|a, b| a.wearing_date.cmp(&b.wearing_date).then_with(|| a.garment_id.cmp(&b.garment_id)));
    let wear_history = csv(
        &["wearing_date", "garment_id", "garment_name"],
        counted.iter().map(|w| vec![w.wearing_date.clone(), w.garment_id.clone(), cat.get(&w.garment_id).map(|g| g.name.clone()).unwrap_or_default()]).collect(),
    );
    let profile = crate::style::seed()["content"].as_str().unwrap_or("No profile document is stored.\n").to_string();
    let mut summary = format!(
        "# Wardrobe summary\n\nSnapshot taken {} (wardrobe revision {}).\n\n- Garments: {}\n- Counted daily wears: {}\n- Quantity movements: {}\n\n## Components\n\n| Component | State | Records | Note |\n| --- | --- | --- | --- |\n",
        snapshot["takenAt"].as_str().unwrap_or_default(),
        l.revision,
        cat.garments.len(),
        counted.len(),
        l.events.len(),
    );
    for p in &c.parts {
        summary += &format!("| {} | {} | {} | {} |\n", p.title, p.state, p.records, p.note.as_deref().unwrap_or("").replace('|', "/"));
    }
    summary += "\nA wear count of zero means no wear was recorded since logging began; it does not mean a piece is unworn.\n";
    vec![("views/inventory.csv", inventory), ("views/wear-history.csv", wear_history), ("views/profile.md", profile), ("views/summary.md", summary)]
}

fn readme(exported_at: &str, complete: bool) -> String {
    format!(
        "# Your Garderobe export\n\nExported {exported_at}. Format {FORMAT_VERSION}.\n\n{}\n\n\
         - `views/` holds readable copies: the inventory and wear history as CSV, your profile document exactly as you supplied it, and a summary.\n\
         - `records/` holds every record as JSON, one file per component.\n\
         - `manifest.json` lists the components, what each holds and what is never exported; `checksums.sha256` lists a SHA-256 for every file.\n\n\
         No password, sign-in, session, token or other credential is in this package. Keep it private: it describes your wardrobe and how you dress.\n",
        if complete { "Every component is complete." } else { "Some components are incomplete; `manifest.json` and `views/summary.md` say which and why." }
    )
}

// ─────────────────────────────── ZIP ───────────────────────────────

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// A ZIP archive with every file stored (no compression), names in UTF-8.
struct Zip {
    out: Vec<u8>,
    central: Vec<u8>,
    count: u16,
    time: u16,
    date: u16,
}

impl Zip {
    /// `at` is an instant (`YYYY-MM-DDTHH:MM:SS…Z`), written as the files' DOS date and time.
    fn new(at: &str) -> Zip {
        let num = |r: std::ops::Range<usize>| at.get(r).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
        let (y, mo, d, h, mi, s) = (num(0..4), num(5..7), num(8..10), num(11..13), num(14..16), num(17..19));
        Zip { out: Vec::new(), central: Vec::new(), count: 0, time: (h << 11) | (mi << 5) | (s / 2), date: (y.saturating_sub(1980) << 9) | (mo << 5) | d }
    }

    fn add(&mut self, path: &str, data: &[u8]) {
        let crc = crc32(data);
        let offset = self.out.len() as u32;
        let size = data.len() as u32;
        let name = path.as_bytes();
        let common = |v: &mut Vec<u8>| {
            v.extend(20u16.to_le_bytes()); // version needed
            v.extend(0x0800u16.to_le_bytes()); // UTF-8 names
            v.extend(0u16.to_le_bytes()); // stored
            v.extend(self.time.to_le_bytes());
            v.extend(self.date.to_le_bytes());
            v.extend(crc.to_le_bytes());
            v.extend(size.to_le_bytes());
            v.extend(size.to_le_bytes());
            v.extend((name.len() as u16).to_le_bytes());
            v.extend(0u16.to_le_bytes()); // extra
        };
        self.out.extend(0x0403_4b50u32.to_le_bytes());
        common(&mut self.out);
        self.out.extend(name);
        self.out.extend(data);
        self.central.extend(0x0201_4b50u32.to_le_bytes());
        self.central.extend(20u16.to_le_bytes()); // made by
        common(&mut self.central);
        self.central.extend(0u16.to_le_bytes()); // comment
        self.central.extend(0u16.to_le_bytes()); // disk
        self.central.extend(0u16.to_le_bytes()); // internal attributes
        self.central.extend(0u32.to_le_bytes()); // external attributes
        self.central.extend(offset.to_le_bytes());
        self.central.extend(name);
        self.count += 1;
    }

    fn finish(mut self) -> Vec<u8> {
        let offset = self.out.len() as u32;
        let size = self.central.len() as u32;
        self.out.extend(&self.central);
        self.out.extend(0x0605_4b50u32.to_le_bytes());
        self.out.extend(0u16.to_le_bytes());
        self.out.extend(0u16.to_le_bytes());
        self.out.extend(self.count.to_le_bytes());
        self.out.extend(self.count.to_le_bytes());
        self.out.extend(size.to_le_bytes());
        self.out.extend(offset.to_le_bytes());
        self.out.extend(0u16.to_le_bytes());
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_is_the_zip_checksum() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn csv_fields_are_quoted_and_formulas_defused() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a, b"), "\"a, b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("=HYPERLINK(1)"), "'=HYPERLINK(1)");
    }
}
