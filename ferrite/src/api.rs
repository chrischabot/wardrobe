//! Requests, authentication and the command service: the Ferrite form of
//! apps/worker/src/routes/core.ts and packages/domain/src/commands/service.ts
//! for the commands this slice ports.
//!
//! Storage is the app's APE binding (`state`), reached through [`Store`]:
//!   `ledger`     the owner's ledger (`crate::ledger::Ledger`), the commit guard;
//!   `b/<id>`     a day board (`crate::board::Board`), written with the ledger;
//!   `c/<id>`     a command: its stored receipt, payload hash and undo data;
//!   `fb/<id>`    a comfort note (`crate::feedback::Note`), written with the ledger;
//!   `trip/<id>`  a trip (`crate::trips::Trip`), written with the ledger;
//!   `tp/<id>/<n>` revision n of a trip's packing proposal, written with the ledger;
//!   `ret/<id>`   a return or exchange case (`crate::returns::Case`), written with the ledger;
//!   `i/<sha256>` an idempotency key → command ID and request hash;
//!   `mu/`, `mc/`, `ma/`, `media-index`  photographs (`crate::media`): uploads and their bytes,
//!                assets and their index (the asset and index written with the ledger).
//! Every command rewrites `ledger`, and the receipt and marker are committed
//! in the same guarded write, so two requests that read the same ledger can
//! never both commit: the loser re-reads, and finds the winner's receipt if it
//! was the same request.

use std::io;

use ferrite_app::client::ApeClusterClient;
use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;

use crate::board::{self, Board};
use crate::feedback::{self, Note};
use crate::trips::{self, Trip};
use crate::returns::{self, Case};
use crate::laundry;
use crate::wear;
use crate::canonical::{canonical, keys_are_plain, numbers_are_accepted, whole, MAX_SAFE};
use crate::ledger::{self, BoardRef, CmdError, Ctx, Ledger, Plan, StoredCommand};
use crate::seed::{catalogue, Catalogue};
use crate::sha256::{constant_time_eq, hex_digest};
use crate::time::{earliest_day, instant, parse_instant, parse_local_date};
use crate::{mcp, oauth};

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
    /// The app's public origin (`WARDROBE_PUBLIC_ORIGIN`), for OAuth metadata
    /// and MCP challenges: the gateway forwards no `Host` header.
    pub public_origin: Option<String>,
    /// The owner's own app as an OAuth client (`WARDROBE_APP_CLIENT_ID` and
    /// `WARDROBE_APP_REDIRECT_URI`, see `oauth::AppClient`): its sign-ins
    /// authenticate as the owner on `/v1`.
    pub app_client_id: Option<String>,
    pub app_redirect_uri: Option<String>,
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
    /// The JSON body, unless `raw` carries another one.
    pub body: Value,
    pub headers: Vec<(String, String)>,
    /// A non-JSON body: content type and bytes.
    pub raw: Option<(String, Vec<u8>)>,
}

impl Reply {
    pub fn json(status: u16, body: Value) -> Reply {
        Reply { status, body, headers: Vec::new(), raw: None }
    }
    pub fn html(status: u16, html: String) -> Reply {
        Reply { status, body: Value::Null, headers: Vec::new(), raw: Some(("text/html; charset=utf-8".into(), html.into_bytes())) }
    }
    pub fn empty(status: u16) -> Reply {
        Reply { status, body: Value::Null, headers: Vec::new(), raw: Some(("text/plain; charset=utf-8".into(), Vec::new())) }
    }
    pub fn with_header(mut self, name: &str, value: &str) -> Reply {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }
    /// Content type and body bytes as served.
    pub fn content(&self) -> (String, Vec<u8>) {
        match &self.raw {
            Some((t, b)) => (t.clone(), b.clone()),
            None => ("application/json; charset=utf-8".into(), serde_json::to_vec(&self.body).unwrap_or_default()),
        }
    }
}

fn error_status(code: &str) -> u16 {
    // API_ERROR_STATUS in packages/contracts/src/ext/api.ts.
    match code {
        "invalid_command" | "unknown_command" => 400,
        "unauthenticated" => 401,
        "forbidden" => 403,
        "not_found" => 404,
        "conflict" | "idempotency_key_reuse" | "precondition_failed" | "not_undoable" | "ambiguous_target" | "confirmation_required" => 409,
        "unrecoverable" => 403,
        "expired" => 410,
        "payload_too_large" => 413,
        "unsupported_media_type" => 415,
        "rate_limited" => 429,
        "module_unavailable" => 501,
        _ => 500,
    }
}

pub(crate) fn error_reply(e: CmdError) -> Reply {
    Reply::json(error_status(e.code), json!({"error": {"code": e.code, "message": e.message, "details": e.details}}))
}

fn ok(body: Value) -> Reply {
    Reply::json(200, body)
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

fn authenticate_static(req: &IngressRequest, tokens: &Tokens) -> Result<Result<Principal, String>, CmdError> {
    let Some(owner_token) = tokens.owner.as_deref().filter(|t| !t.is_empty()) else {
        return Err(CmdError::new("internal", format!("the server has no {OWNER_TOKEN_SECRET} secret; set it and deploy again")));
    };
    let presented = header(req, "authorization")
        .and_then(crate::oauth::bearer_credentials)
        .unwrap_or("");
    if presented.is_empty() {
        return Err(CmdError::new("unauthenticated", "sign in first: send Authorization: Bearer <token>"));
    }
    if constant_time_eq(presented.as_bytes(), owner_token.as_bytes()) {
        return Ok(Ok(OWNER));
    }
    if let Some(a) = tokens.assistant.as_deref().filter(|t| !t.is_empty()) {
        if constant_time_eq(presented.as_bytes(), a.as_bytes()) {
            return Ok(Ok(ASSISTANT));
        }
    }
    Ok(Err(presented.to_string()))
}

/// Who a `/v1` request acts for: the owner token, the assistant token, or a sign-in of the owner's
/// app (an OAuth access token of the configured app client, which acts as the owner on channel
/// `ios`). A connected assistant's MCP token is refused here.
async fn authenticate<S: Store>(store: &mut S, req: &IngressRequest, tokens: &Tokens, app: Option<&crate::oauth::AppClient>, now_ms: u64) -> Result<Principal, CmdError> {
    let presented = match authenticate_static(req, tokens)? {
        Ok(principal) => return Ok(principal),
        Err(presented) => presented,
    };
    if presented.starts_with("wat.") {
        return match crate::oauth::authenticate_app(store, &presented, now_ms, app).await {
            Ok(_) => Ok(OWNER),
            Err(crate::oauth::BearerError::Invalid(d)) => Err(CmdError::new("unauthenticated", d)),
            Err(crate::oauth::BearerError::Missing) => Err(CmdError::new("unauthenticated", "sign in first: send Authorization: Bearer <token>")),
            Err(crate::oauth::BearerError::Fault(f)) => Err(fault_error(f)),
        };
    }
    Err(CmdError::new("unauthenticated", "that token is not valid for this wardrobe"))
}

/// The identity routes this port does not serve, each with its reason: claims and linked identities
/// need an identity provider (Cloudflare Access in the TypeScript Worker), and account deletion needs
/// an erasure the storage binding cannot do.
fn identity_unavailable(path: &str) -> CmdError {
    let (reason, message) = match path {
        "/v1/account/delete" => (
            "erasure_unavailable",
            "account deletion is not ported: this server's storage binding has no delete and no key listing, so it cannot erase every stored record; nothing was changed",
        ),
        _ => (
            "no_identity_provider",
            "invitation claims and linked identities are not ported: this server has one owner, who signs in with the owner token or a recovery code (the app through /oauth/authorize); a lost owner token is replaced with `ferrite secrets set` and a deploy",
        ),
    };
    CmdError::with("module_unavailable", message, json!({"module": "identity", "reason": reason}))
}

/// `POST /v1/recovery-kit` (`RecoveryKitIssued`): the owner's alone (the owner token or the app's
/// sign-in), never the assistant token's. An app sign-in is checked again under the commit's guard;
/// the owner token (whatever its spelling) is not a sign-in and is not.
async fn issue_recovery_kit<S: Store>(store: &mut S, req: &IngressRequest, tokens: &Tokens, principal: Principal, now_ms: u64) -> Result<Value, CmdError> {
    if principal != OWNER {
        return Err(CmdError::new("forbidden", "only the owner issues a recovery kit"));
    }
    let presented = header(req, "authorization").and_then(crate::oauth::bearer_credentials).unwrap_or("");
    let owner_token = tokens.owner.as_deref().filter(|t| !t.is_empty()).map_or(false, |t| constant_time_eq(presented.as_bytes(), t.as_bytes()));
    let session = if owner_token {
        None
    } else {
        // `authenticate` accepted it as the owner, and it is not the owner token: an app sign-in.
        Some(crate::oauth::app_grant_of_token(presented).ok_or_else(|| CmdError::new("unauthenticated", "that token is not valid for this wardrobe"))?)
    };
    match crate::recovery::issue(store, now_ms, session).await {
        Ok(Some(issued)) => Ok(issued),
        Ok(None) => Err(CmdError::new("unauthenticated", "this sign-in has ended; sign in again")),
        Err(oauth::Fault::Unavailable) => Err(internal("the recovery kit could not be written just now; nothing was issued; try again")),
        Err(oauth::Fault::Corrupt) => Err(CmdError::with("internal", "a stored sign-in record is unreadable; nothing was issued", json!({"retryable": false}))),
    }
}

/// `POST /v1/sessions/revoke` (`SessionsRevoked`): sign out everywhere. Every sign-in of the app ends
/// now; connected assistants and the owner token itself are not affected.
async fn sign_out_everywhere<S: Store>(store: &mut S, principal: Principal, now_ms: u64) -> Result<Value, CmdError> {
    if principal != OWNER {
        return Err(CmdError::new("forbidden", "only the owner signs out everywhere"));
    }
    crate::oauth::sign_out_app(store, now_ms).await.map_err(fault_error)?;
    Ok(json!({"sessionsRevokedBefore": crate::time::instant(now_ms), "receiptId": format!("aud_{}", crate::random::token(12))}))
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

/// Answer one request. The caller publishes the reply. No model is reachable through this entry
/// point: the assistant's tools refuse by the name of the missing secret.
pub async fn handle<S: Store>(store: &mut S, tokens: &Tokens, now_ms: u64, req: &IngressRequest) -> Reply {
    handle_with(store, tokens, &mut crate::inference::Inference::unavailable(), now_ms, req).await
}

/// [`handle`] with the inference adapter the app was started with.
pub async fn handle_with<S: Store, T: crate::inference::Transport>(store: &mut S, tokens: &Tokens, inference: &mut crate::inference::Inference<T>, now_ms: u64, req: &IngressRequest) -> Reply {
    let (path, query) = split_path(&req.path);
    inference.set_reply_deadline((req.deadline_ms > 0).then_some(req.deadline_ms));
    if path == "/health" {
        return ok(json!({"status": "ok", "service": "wardrobe", "host": "ferrite", "contractVersion": CONTRACT_VERSION}));
    }
    let app = oauth::AppClient::from_config(tokens.app_client_id.as_deref(), tokens.app_redirect_uri.as_deref());
    // The recovery transaction answers before any sign-in: it is for an owner who lost his (see
    // src/recovery.rs). Claims and linked identities are not served (see `identity_unavailable`).
    if req.method == "POST" && path == "/auth/recovery/start" {
        return crate::recovery::start(store, now_ms).await.map(ok).unwrap_or_else(error_reply);
    }
    if req.method == "POST" && path == "/auth/recovery/complete" {
        return crate::recovery::complete(store, now_ms, &req.body).await.map(ok).unwrap_or_else(error_reply);
    }
    if req.method == "POST" && matches!(path, "/auth/claim" | "/auth/link/complete") {
        return error_reply(identity_unavailable(path));
    }
    // OAuth and MCP authenticate themselves (an MCP access token, the owner
    // token on the consent form) and need the public origin.
    if path.starts_with("/.well-known/") || path.starts_with("/oauth/") || path == "/mcp" {
        let Some(origin) = tokens.public_origin.as_deref().filter(|o| oauth::valid_origin(o)) else {
            return error_reply(CmdError::with(
                "internal",
                format!("the server has no valid {} secret (https://host, or http on a loopback host, with no path); set it and deploy again", oauth::PUBLIC_ORIGIN_SECRET),
                json!({"retryable": false}),
            ));
        };
        let raw_query = req.path.split_once('?').map_or("", |(_, q)| q);
        return match (req.method.as_str(), path) {
            ("GET", "/.well-known/oauth-protected-resource" | "/.well-known/oauth-protected-resource/mcp") => oauth::protected_resource_metadata(origin),
            ("GET", "/.well-known/oauth-authorization-server") => oauth::authorization_server_metadata(origin),
            ("POST", "/oauth/register") => oauth::register(store, now_ms, &req.body).await,
            ("GET", "/oauth/authorize") => oauth::authorize_page(store, origin, app.as_ref(), tokens.owner.as_deref(), now_ms, raw_query).await,
            ("POST", "/oauth/authorize") => oauth::authorize_decision(store, origin, app.as_ref(), tokens.owner.as_deref(), &oauth::Mint::new(tokens.owner.as_deref(), &req.correlation_id), now_ms, &req.body).await,
            ("POST", "/oauth/token") => oauth::token_endpoint(store, origin, app.as_ref(), &oauth::Mint::new(tokens.owner.as_deref(), &req.correlation_id), now_ms, &req.body).await,
            ("POST", "/oauth/revoke") => oauth::revoke(store, now_ms, &req.body).await,
            (_, "/mcp") => mcp::handle(store, origin, inference, now_ms, req).await,
            _ => error_reply(CmdError::new("not_found", "no such route")),
        };
    }
    // A portable export's download is authorized by its single-use ticket alone, so the sign-in is
    // neither required nor read (APIClient.download sends none).
    if req.method == "GET" {
        if let Some(id) = crate::exports::download_target(path) {
            let ticket = query.iter().find(|(k, _)| k == "ticket").map(|(_, v)| v.as_str());
            return crate::exports::download(store, now_ms, id, ticket).await.unwrap_or_else(error_reply);
        }
    }
    // A photograph's upload target is authorized by its URL alone.
    if let Some(reply) = crate::media::public_route(store, tokens, now_ms, req, path, &query).await {
        return reply;
    }
    let principal = match authenticate(store, req, tokens, app.as_ref(), now_ms).await {
        Ok(p) => p,
        Err(e) => return error_reply(e),
    };
    // Photographs: the owner's alone (`media::route` refuses anyone else).
    if let Some(reply) = crate::media::route(store, tokens, principal, now_ms, req, path, &query).await {
        return reply;
    }
    let result = match (req.method.as_str(), path) {
        ("GET", "/v1/wardrobe") => match crate::inventory::parse_query(req.path.split_once('?').map_or("", |(_, q)| q)) {
            Ok(q) => crate::inventory::page(store, now_ms, &q).await,
            Err(e) => Err(e),
        },
        ("GET", "/v1/today") => {
            let date = query.iter().find(|(k, _)| k == "date").map(|(_, v)| v.as_str());
            match query.iter().find(|(k, _)| k == "scope").map(|(_, v)| v.as_str()) {
                None => read_today(store, now_ms, date).await,
                Some(s) if board::scope_ok(s) => read_today_scoped(store, now_ms, date, s).await,
                Some(_) => Err(CmdError::new("invalid_command", "scope: expected home, home:evening, trip:<tripId> or trip:<tripId>:evening")),
            }
        }
        ("GET", "/v1/weather") => read_weather(now_ms, query.iter().find(|(k, _)| k == "date").map(|(_, v)| v.as_str())),
        ("GET", p) if p.starts_with("/v1/days/") => {
            if principal != OWNER {
                Err(CmdError::new("forbidden", "the day's recorded wear is read by the owner"))
            } else {
                read_day(store, &p["/v1/days/".len()..]).await
            }
        }
        ("GET", p) if p.starts_with("/v1/runs/") => crate::runs::get(store, &p["/v1/runs/".len()..], now_ms).await,
        ("POST", p) if p.strip_prefix("/v1/runs/").and_then(|r| r.strip_suffix("/cancel")).is_some() => {
            let id = p.strip_prefix("/v1/runs/").and_then(|r| r.strip_suffix("/cancel")).unwrap_or_default();
            crate::runs::cancel(store, id, now_ms).await
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
        ("GET", "/v1/meta") => crate::app_routes::meta(tokens.public_origin.as_deref().filter(|o| oauth::valid_origin(o)), now_ms),
        ("GET", "/v1/command-types") => crate::command_types::list(),
        ("GET", "/v1/me") => crate::app_routes::me(store, principal).await,
        ("GET", "/v1/service") => Ok(crate::app_routes::service()),
        ("GET", "/v1/settings") => Ok(crate::app_routes::settings(now_ms)),
        ("GET", "/v1/recovery") => Ok(crate::app_routes::recovery(store, now_ms).await),
        ("GET", "/v1/wardrobe/temperature-preview") => {
            let raw = query.iter().find(|(k, _)| k == "temperatureC").map(|(_, v)| v.as_str());
            crate::temperature::parse_temperature(raw).map(|t| crate::temperature::preview(catalogue(), t))
        }
        ("GET", p) if crate::item::target(p).is_some() => crate::item::read(store, now_ms, crate::item::target(p).unwrap_or_default()).await,
        ("GET", "/v1/wardrobe/resolve") => crate::selection::resolve_phrase(req.path.split_once('?').map_or("", |(_, q)| q)).map(|phrase| crate::selection::resolve(catalogue(), &phrase)),
        ("POST", "/v1/wardrobe/selection") => read_selection(store, &req.body).await,
        ("GET", "/v1/availability") => read_availability(store, now_ms, query.iter().find(|(k, _)| k == "date").map(|(_, v)| v.as_str())).await,
        ("GET", "/v1/style") => crate::style::context(query.iter().find(|(k, _)| k == "date").map(|(_, v)| v.as_str())),
        ("GET", "/v1/style/conflicts") => {
            let q = |name: &str| query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
            crate::style::conflicts(q("status"), q("documentId"))
        }
        ("POST", "/v1/sessions/revoke") => sign_out_everywhere(store, principal, now_ms).await,
        ("POST", "/v1/recovery-kit") => issue_recovery_kit(store, req, tokens, principal, now_ms).await,
        ("POST", p @ ("/v1/identities/link" | "/v1/identities/unlink" | "/v1/account/delete")) => Err(identity_unavailable(p)),
        ("GET", "/v1/laundry") => crate::app_routes::laundry(store, now_ms).await,
        ("GET", "/v1/feedback") => read_feedback(store, query.iter().find(|(k, _)| k == "garmentId").map(|(_, v)| v.as_str())).await,
        ("GET", "/v1/trips") => read_trips(store).await,
        ("GET", "/v1/returns") => read_returns(store).await,
        // Orders come from purchase import (`purchase.import_order`), which is not ported: there are none.
        ("GET", "/v1/orders") => Ok(json!({"orders": []})),
        ("GET", p) if trip_target(p).is_some() => read_trip(store, trip_target(p).unwrap_or_default()).await,
        ("POST", p) if crate::app_routes::packing_target(p).is_some() => {
            let id = crate::app_routes::packing_target(p).unwrap_or_default();
            crate::app_routes::propose_packing(store, principal, now_ms, id, &req.body).await
        }
        ("GET", "/v1/studio") => {
            let q = |name: &str| query.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
            crate::studio::read(store, now_ms, q("mode"), q("date")).await
        }
        ("POST", "/v1/studio/validate") => crate::studio::validate(store, now_ms, &req.body).await,
        ("POST", "/v1/studio/suggest") => crate::studio::suggest(store, now_ms, &req.body).await,
        ("POST", "/v1/studio/compose") => crate::studio::compose(&req.body),
        ("GET", p) if p.strip_prefix("/v1/studio/compositions/").is_some_and(|rest| !rest.is_empty()) => Err(crate::studio::stored_composition(p)),
        ("POST", "/v1/commands/batch") => crate::app_routes::batch(store, principal, now_ms, &req.body).await,
        ("POST", "/v1/recommendations") => crate::app_routes::recommendations(store, principal, now_ms, &req.body).await,
        ("POST", p) if crate::app_routes::swap_target(p).is_some() => {
            let id = crate::app_routes::swap_target(p).unwrap_or_default();
            crate::app_routes::swap(store, principal, now_ms, id, &req.body).await
        }
        ("POST", "/v1/commands") => match serde_json::from_slice::<Value>(&req.body) {
            Ok(envelope) => execute(store, principal, now_ms, &envelope).await,
            Err(_) => Err(CmdError::new("invalid_command", "the request body is not valid JSON")),
        },
        // Settings › Connected assistants, Connections and Notifications: the owner's alone.
        ("GET", "/v1/proposals") => crate::proposals::list(principal, query.iter().find(|(k, _)| k == "state").map(|(_, v)| v.as_str()), now_ms),
        ("POST", p) if crate::proposals::decision_target(p).is_some() => crate::proposals::decide(principal, crate::proposals::decision_target(p).unwrap_or_default(), &req.body),
        ("GET" | "POST", p) if owner_settings(p) && principal != OWNER => Err(CmdError::new("forbidden", "only the owner manages connected assistants, connections and notification devices")),
        ("GET", "/v1/assistants") => oauth::list_assistants(store, now_ms).await.map_err(fault_error),
        ("POST", p) if disconnect_target(p).is_some() => {
            let id = disconnect_target(p).unwrap_or_default();
            match oauth::disconnect(store, now_ms, id).await {
                Ok(Some(grant)) => Ok(grant),
                Ok(None) => Err(CmdError::new("not_found", "that connected assistant was not found")),
                Err(f) => Err(fault_error(f)),
            }
        }
        // Outbound tool connections (Google Workspace, owner-added MCP services) cannot be registered
        // on this server, so there are none: the list is empty and every connection is not found.
        ("GET", "/v1/connections") => Ok(json!({"connections": [], "readAt": instant(now_ms)})),
        ("POST", "/v1/connections") => Err(CmdError::with(
            "module_unavailable",
            "connecting Google Workspace or an MCP tool service is not ported to this server; the wardrobe works without one",
            json!({"module": "connections"}),
        )),
        ("GET" | "POST", p) if p.starts_with("/v1/connections/") => Err(CmdError::new("not_found", "that connection was not found: this server has no outbound connections (connecting one is not ported)")),
        ("GET", "/v1/devices") => crate::devices::list(store).await,
        ("POST", "/v1/devices") => crate::devices::register(store, now_ms, &req.body).await,
        ("POST", p) if crate::devices::remove_target(p).is_some() => crate::devices::remove(store, crate::devices::remove_target(p).unwrap_or_default()).await,
        // Portable export: the owner's alone (each function refuses anyone else).
        ("POST", "/v1/exports") => crate::exports::start(store, principal, now_ms, &req.body).await,
        ("GET", "/v1/exports") => crate::exports::list(store, principal, now_ms).await,
        ("POST", p) if crate::exports::ticket_target(p).is_some() => crate::exports::ticket(store, principal, now_ms, crate::exports::ticket_target(p).unwrap_or_default()).await,
        ("GET", p) if crate::exports::job_target(p).is_some() => crate::exports::get(store, principal, now_ms, crate::exports::job_target(p).unwrap_or_default()).await,
        _ => Err(CmdError::new("not_found", "no such route")),
    };
    match result {
        Ok(body) => ok(body),
        Err(e) => error_reply(e),
    }
}

// ──────────────────────────────── storage ────────────────────────────────

/// The trip ID of `GET /v1/trips/{id}`, if the path is one.
fn trip_target(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/trips/")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

/// The grant ID of `POST /v1/assistants/{id}/disconnect`, if the path is one.
fn disconnect_target(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/assistants/")?.strip_suffix("/disconnect")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

/// The owner-only settings routes: connected assistants, outbound connections, notification devices.
fn owner_settings(path: &str) -> bool {
    ["/v1/assistants", "/v1/connections", "/v1/devices"].iter().any(|p| path == *p || path.strip_prefix(p).is_some_and(|rest| rest.starts_with('/')))
}

fn fault_error(f: oauth::Fault) -> CmdError {
    match f {
        oauth::Fault::Unavailable => internal("the connections could not be read just now; try again"),
        oauth::Fault::Corrupt => CmdError::with("internal", "a stored connection record is unreadable; nothing was changed", json!({"retryable": false})),
    }
}

pub(crate) async fn read_ledger<S: Store>(store: &mut S) -> Result<(Option<Vec<u8>>, Ledger), CmdError> {
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

pub(crate) fn command_key(id: &str) -> Vec<u8> {
    format!("c/{id}").into_bytes()
}

pub(crate) fn board_key(id: &str) -> Vec<u8> {
    format!("b/{id}").into_bytes()
}

/// Read one board. Absent is `Ok(None)`; a record that is not a board this code wrote is an error.
async fn load_board<S: Store>(store: &mut S, id: &str) -> Result<Option<Board>, CmdError> {
    if id.is_empty() || id.len() > 64 {
        return Ok(None);
    }
    let bytes = store.get(&board_key(id)).await.map_err(|_| internal("the board could not be read just now; try again"))?;
    match bytes {
        None => Ok(None),
        Some(b) => serde_json::from_slice::<Value>(&b)
            .ok()
            .and_then(|v| Board::from_json(&v))
            .filter(|board| board.board_id == id)
            .map(Some)
            .ok_or_else(|| CmdError::with("internal", "the stored board is unreadable; nothing was changed", json!({"retryable": false, "boardId": id}))),
    }
}

/// A board the ledger's index names: absent is as corrupt as unreadable.
async fn indexed_board<S: Store>(store: &mut S, r: Option<&BoardRef>) -> Result<Option<Board>, CmdError> {
    let Some(r) = r else { return Ok(None) };
    match load_board(store, &r.board_id).await? {
        Some(b) => Ok(Some(b)),
        None => Err(CmdError::with("internal", "the day's board is listed but its record is missing; nothing was changed", json!({"retryable": false, "boardId": r.board_id}))),
    }
}

/// Read one comfort note. Absent is `Ok(None)`; a record that is not a note this code wrote is an error.
async fn load_note<S: Store>(store: &mut S, id: &str) -> Result<Option<Note>, CmdError> {
    if id.is_empty() || id.chars().count() > 128 {
        return Ok(None);
    }
    let bytes = store.get(&feedback::key(id)).await.map_err(|_| internal("the comfort note could not be read just now; try again"))?;
    match bytes {
        None => Ok(None),
        Some(b) => serde_json::from_slice::<Value>(&b)
            .ok()
            .and_then(|v| Note::from_json(&v, id))
            .map(Some)
            .ok_or_else(|| CmdError::with("internal", "the stored comfort note is unreadable; nothing was changed", json!({"retryable": false, "feedbackId": id}))),
    }
}

/// A generated note ID that no stored note (active or withdrawn) and no note in this commit holds.
async fn free_feedback_id<S: Store>(store: &mut S, ctx: &Ctx<'_>, next: &Ledger) -> Result<String, CmdError> {
    for attempt in 0..feedback::ID_ATTEMPTS {
        let id = feedback::new_id(ctx, attempt);
        if !next.feedback.iter().any(|f| *f == id) && load_note(store, &id).await?.is_none() {
            return Ok(id);
        }
    }
    Err(CmdError::with("conflict", "no free ID for the comfort note; send a feedbackId of your own. Nothing was written", json!({"reason": "feedback_id_taken"})))
}

/// `GET /v1/feedback`: the active comfort notes, newest first, optionally those naming one garment.
pub async fn read_feedback<S: Store>(store: &mut S, garment: Option<&str>) -> Result<Value, CmdError> {
    let (_, l) = read_ledger(store).await?;
    let mut notes = Vec::with_capacity(l.feedback.len());
    for id in &l.feedback {
        match load_note(store, id).await? {
            Some(n) => notes.push(n),
            None => return Err(CmdError::with("internal", "a comfort note is listed but its record is missing", json!({"retryable": false, "feedbackId": id}))),
        }
    }
    Ok(feedback::listing(notes, garment))
}

/// Read one trip. Absent is `Ok(None)`; a record that is not a trip this code wrote is an error.
pub(crate) async fn load_trip<S: Store>(store: &mut S, id: &str) -> Result<Option<Trip>, CmdError> {
    if id.is_empty() || id.chars().count() > 128 {
        return Ok(None);
    }
    let bytes = store.get(&trips::key(id)).await.map_err(|_| internal("the trip could not be read just now; try again"))?;
    match bytes {
        None => Ok(None),
        Some(b) => serde_json::from_slice::<Value>(&b)
            .ok()
            .and_then(|v| Trip::from_json(&v, id))
            .map(Some)
            .ok_or_else(|| CmdError::with("internal", "the stored trip is unreadable; nothing was changed", json!({"retryable": false, "tripId": id}))),
    }
}

/// A trip with its latest packing proposal, as `GET /v1/trips` reads it.
async fn trip_with_proposal<S: Store>(store: &mut S, trip: Trip) -> Result<(Trip, Option<Value>), CmdError> {
    if trip.proposal_revision == 0 {
        return Ok((trip, None));
    }
    let unreadable = || CmdError::with("internal", "the trip's packing proposal is unreadable", json!({"retryable": false, "tripId": trip.trip_id}));
    let bytes = store.get(&trips::proposal_key(&trip.trip_id, trip.proposal_revision)).await.map_err(|_| internal("the packing proposal could not be read just now; try again"))?;
    let proposal = bytes
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| trips::proposal_from_json(&v, &trip.trip_id, trip.proposal_revision))
        .ok_or_else(unreadable)?;
    Ok((trip, Some(proposal)))
}

/// The planned reuse a board of `scope` is checked with (`plannedReuse` in trip-day.ts): `None` for
/// the home board and a trip that does not exist; no reuse until something is packed. The proposal is
/// the newest one recorded no later than the newest packing report for the trip, compared as instants;
/// a proposal recorded after the last packing report changes nothing.
pub(crate) async fn trip_plan<S: Store>(store: &mut S, l: &Ledger, scope: &str) -> Result<Option<board::TripPlan>, CmdError> {
    let Some(trip_id) = board::scope_trip(scope) else { return Ok(None) };
    let Some(trip) = load_trip(store, trip_id).await? else { return Ok(None) };
    let pack = l.events.iter().filter(|e| e.kind == "pack" && e.voided_by.is_none() && e.trip_id.as_deref() == Some(trip_id)).max_by_key(|e| e.seq);
    let Some(pack) = pack else {
        return Ok(Some(board::TripPlan::from_proposal(&trip.departs_on, None, 0)));
    };
    // The journal lists only commands committed with their record, so an absent record is corrupt.
    let record = load_command(store, &pack.command_id).await?.ok_or_else(|| corrupt_record(&pack.command_id))?;
    let packed_at = record.value["receipt"]["recordedAt"].as_str().and_then(parse_instant).ok_or_else(|| corrupt_record(&pack.command_id))?;
    let unreadable = || CmdError::with("internal", "the trip's packing proposal is unreadable", json!({"retryable": false, "tripId": trip_id}));
    let mut proposal = None;
    for revision in (1..=trip.proposal_revision).rev() {
        let bytes = store.get(&trips::proposal_key(trip_id, revision)).await.map_err(|_| internal("the packing proposal could not be read just now; try again"))?;
        let p = bytes
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| trips::proposal_from_json(&v, trip_id, revision))
            .ok_or_else(unreadable)?;
        if p["createdAt"].as_str().and_then(parse_instant).map_or(false, |at| at <= packed_at) {
            proposal = Some(p);
            break;
        }
    }
    Ok(Some(board::TripPlan::from_proposal(&trip.departs_on, proposal.as_ref(), pack.seq)))
}

/// `GET /v1/trips` (`TripList`): every trip, by departure date then ID, each with what is packed for it.
pub async fn read_trips<S: Store>(store: &mut S) -> Result<Value, CmdError> {
    let (_, l) = read_ledger(store).await?;
    let stock = ledger::replay(catalogue(), &l.events);
    let mut out = Vec::with_capacity(l.trips.len());
    for id in l.trips.keys() {
        match load_trip(store, id).await? {
            Some(t) => {
                let (t, proposal) = trip_with_proposal(store, t).await?;
                let packed = crate::packing::packed(catalogue(), &stock, &t.trip_id);
                out.push((t, proposal, packed));
            }
            None => return Err(CmdError::with("internal", "a trip is listed but its record is missing", json!({"retryable": false, "tripId": id}))),
        }
    }
    Ok(trips::listing(out))
}

/// The trip the owner is away on that day (`packedTripOn` in packages/daily/src/trip-day.ts): a planned
/// trip whose dates cover the day and for which something is packed, the latest departure first, then
/// by trip ID. Until he says something is packed, a trip is only a plan and the day is answered from
/// home.
pub(crate) async fn packed_trip_on<S: Store>(store: &mut S, l: &Ledger, date: &str) -> Result<Option<Trip>, CmdError> {
    let stock = ledger::replay(catalogue(), &l.events);
    let mut best: Option<Trip> = None;
    // The ledger lists trips in ID order, so a later trip replaces the best only by departing later.
    for id in l.trips.keys() {
        if stock.packed_for(id) == 0 {
            continue;
        }
        let Some(t) = load_trip(store, id).await? else {
            return Err(CmdError::with("internal", "a trip is listed but its record is missing", json!({"retryable": false, "tripId": id})));
        };
        if t.status != "planned" || date < t.departs_on.as_str() || date > t.returns_on.as_str() {
            continue;
        }
        if best.as_ref().map_or(true, |b| t.departs_on > b.departs_on) {
            best = Some(t);
        }
    }
    Ok(best)
}

/// `GET /v1/trips/{id}` (`Trip`).
pub async fn read_trip<S: Store>(store: &mut S, id: &str) -> Result<Value, CmdError> {
    let (_, l) = read_ledger(store).await?;
    match load_trip(store, id).await? {
        Some(t) => {
            let (t, proposal) = trip_with_proposal(store, t).await?;
            let packed = crate::packing::packed(catalogue(), &ledger::replay(catalogue(), &l.events), &t.trip_id);
            Ok(t.view(proposal, packed))
        }
        None => Err(CmdError::new("not_found", "that trip was not found")),
    }
}

/// Read one return case. Absent is `Ok(None)`; a record that is not a case this code wrote is an error.
pub(crate) async fn load_case<S: Store>(store: &mut S, id: &str) -> Result<Option<Case>, CmdError> {
    if id.is_empty() || id.chars().count() > 128 {
        return Ok(None);
    }
    let bytes = store.get(&returns::key(id)).await.map_err(|_| internal("the return could not be read just now; try again"))?;
    match bytes {
        None => Ok(None),
        Some(b) => serde_json::from_slice::<Value>(&b)
            .ok()
            .and_then(|v| Case::from_json(&v, id))
            .map(Some)
            .ok_or_else(|| CmdError::with("internal", "the stored return is unreadable; nothing was changed", json!({"retryable": false, "caseId": id}))),
    }
}

/// `GET /v1/returns` (`ReturnList`): every case, cancelled and finished ones included.
pub async fn read_returns<S: Store>(store: &mut S) -> Result<Value, CmdError> {
    let (_, l) = read_ledger(store).await?;
    let mut out = Vec::with_capacity(l.returns.len());
    for id in l.returns.keys() {
        match load_case(store, id).await? {
            Some(c) if Some(&c.version) == l.returns.get(id) => out.push(c),
            Some(_) => return Err(CmdError::with("internal", "a return's record does not match the ledger", json!({"retryable": false, "caseId": id}))),
            None => return Err(CmdError::with("internal", "a return is listed but its record is missing", json!({"retryable": false, "caseId": id}))),
        }
    }
    Ok(returns::listing(out))
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
            // A stock or laundry undo writes only the target; a board undo adds the board it restored.
            if result.get("undoneCommandId") != Some(&value["undoes"]) || (result.len() > 1 && !board_result_ok("undo.select", result) && !board_result_ok("undo.swap", result)) {
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
        (Value::Null, "care.washed") => {
            // The garments that came back clean, each once, and the units: both empty for a noop,
            // both present for a committed report.
            let ids = result.get("washed").and_then(Value::as_array).and_then(|a| a.iter().map(|x| x.as_str().filter(|s| !s.is_empty())).collect::<Option<Vec<_>>>());
            let Some(ids) = ids else { return None };
            let distinct: std::collections::BTreeSet<&str> = ids.iter().copied().collect();
            let units = result.get("units").and_then(Value::as_u64);
            let consistent = match (rc["outcome"].as_str(), units) {
                (Some("committed"), Some(u)) => !ids.is_empty() && u as usize >= ids.len(),
                (Some("noop"), Some(0)) => ids.is_empty(),
                _ => false,
            };
            if result.len() != 2 || distinct.len() != ids.len() || !consistent {
                return None;
            }
        }
        (Value::Null, k @ ("board.publish" | "board.select" | "board.swap_slot")) if board_result_ok(k, result) => {}
        (Value::Null, "laundry.collect") => {
            let batch = matches!(result.get("batchId"), Some(Value::Null) | Some(Value::String(_)));
            // Each member exactly `{garmentId, quantity}`, a garment ID and a positive whole quantity.
            let members = result.get("members").and_then(Value::as_array).map_or(false, |a| {
                a.iter().all(|m| {
                    m.as_object().map_or(false, |o| o.len() == 2)
                        && m["garmentId"].as_str().map_or(false, |s| !s.is_empty())
                        && m["quantity"].as_u64().map_or(false, |q| q >= 1)
                })
            });
            if result.len() != 3 || !batch || result.get("units").and_then(Value::as_u64).is_none() || !members {
                return None;
            }
        }
        (Value::Null, "laundry.return") => {
            let batch = matches!(result.get("batchId"), Some(Value::Null) | Some(Value::String(_)));
            if result.len() != 3 || !batch || result.get("returned").and_then(Value::as_u64).is_none() || result.get("stillAway").and_then(Value::as_u64).is_none() {
                return None;
            }
        }
        (Value::Null, "wear.record") => {
            let ids = |k: &str| result.get(k).and_then(Value::as_array).map_or(false, |a| a.iter().all(|x| x.as_str().map_or(false, |s| !s.is_empty())));
            let keys = ["wearingDate", "counted", "merged", "observationIds", "additionalUnitEvents", "additionalUnitsAlreadyRecorded"];
            if result.len() != keys.len()
                || !keys.iter().all(|k| result.contains_key(*k))
                || !result["wearingDate"].as_str().map_or(false, |d| parse_local_date(d).is_some())
                || !ids("counted")
                || !ids("merged")
                || !ids("observationIds")
                || result["additionalUnitEvents"].as_u64().is_none()
                || result["additionalUnitsAlreadyRecorded"].as_u64().is_none()
            {
                return None;
            }
            // One report per garment named: each garment is either counted or merged, never both,
            // and a report names at least one garment.
            let list = |k: &str| result[k].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default();
            let (counted, merged, observations) = (list("counted"), list("merged"), list("observationIds"));
            let garments: std::collections::BTreeSet<&str> = counted.iter().chain(merged.iter()).copied().collect();
            let distinct_obs: std::collections::BTreeSet<&str> = observations.iter().copied().collect();
            if observations.is_empty()
                || distinct_obs.len() != observations.len()
                || garments.len() != counted.len() + merged.len()
                || counted.len() + merged.len() != observations.len()
            {
                return None;
            }
            // "merged" means nothing new was counted or consumed; "committed" means something was.
            let extras = result["additionalUnitEvents"].as_u64().unwrap_or(0);
            let consistent = match rc["outcome"].as_str() {
                Some("merged") => counted.is_empty() && extras == 0,
                Some("committed") => !counted.is_empty() || extras > 0,
                _ => false,
            };
            if !consistent {
                return None;
            }
        }
        (Value::Null, "feedback.record") => {
            // Committed: the note, its garments, whether it reports pain and its scope; a repeat: the ID only.
            let id = result.get("feedbackId").and_then(Value::as_str).map_or(false, |s| !s.is_empty());
            let committed = result.len() == 4
                && result.get("garmentIds").and_then(Value::as_array).map_or(false, |a| a.iter().all(|x| x.as_str().map_or(false, |s| !s.is_empty())))
                && result.get("pain").map_or(false, Value::is_boolean)
                && matches!(result.get("scope"), Some(Value::Null) | Some(Value::String(_)));
            let consistent = match rc["outcome"].as_str() {
                Some("committed") => committed,
                Some("noop") => result.len() == 1,
                _ => false,
            };
            if !id || !consistent {
                return None;
            }
        }
        (Value::Null, "feedback.retract") => {
            if result.len() != 1 || !result.get("feedbackId").and_then(Value::as_str).map_or(false, |s| !s.is_empty()) {
                return None;
            }
        }
        (Value::Null, k @ ("stock.pack" | "stock.unpack")) => {
            // The trip and how many items the report named: at least one for a committed report; a
            // report that unpacked nothing is a noop with an empty result.
            let count = if k == "stock.pack" { "packed" } else { "unpacked" };
            let ok = match rc["outcome"].as_str() {
                Some("committed") => result.len() == 2 && result.get("tripId").and_then(Value::as_str).map_or(false, |s| !s.is_empty()) && result.get(count).and_then(Value::as_u64).map_or(false, |n| n >= 1),
                Some("noop") => k == "stock.unpack" && result.is_empty(),
                _ => false,
            };
            if !ok {
                return None;
            }
        }
        (Value::Null, k @ ("trip.create" | "trip.update" | "trip.cancel" | "trip.record_packing_proposal")) => {
            let id = result.get("tripId").and_then(Value::as_str).map_or(false, |s| !s.is_empty());
            let n = |key: &str, min: u64| result.get(key).and_then(Value::as_u64).map_or(false, |v| v >= min);
            let ok = match (k, rc["outcome"].as_str()) {
                ("trip.create", Some("committed")) => result.len() == 1 && id,
                ("trip.update", Some("committed")) => result.len() == 2 && id && n("version", 2),
                ("trip.cancel", Some("committed")) => result.len() == 2 && id && n("stillPacked", 0),
                ("trip.cancel", Some("noop")) => result.is_empty(),
                ("trip.record_packing_proposal", Some("committed")) => result.len() == 2 && id && n("revision", 1),
                _ => false,
            };
            if !ok {
                return None;
            }
        }
        (Value::Null, k @ ("return.open_case" | "return.update_case")) => {
            let id = result.get("caseId").and_then(Value::as_str).map_or(false, |s| !s.is_empty());
            let deadline = result.get("deadline").map_or(false, |d| d.as_object().map_or(false, |o| o.len() == 6) && matches!(d["status"].as_str(), Some("established" | "unresolved")));
            let ok = match (k, rc["outcome"].as_str()) {
                // Reminders are not ported, so an opened case lists none.
                ("return.open_case", Some("committed")) => result.len() == 3 && id && deadline && result.get("reminders").and_then(Value::as_array).map_or(false, Vec::is_empty),
                ("return.update_case", Some("committed")) => {
                    result.len() == 4
                        && id
                        && deadline
                        && result.get("state").and_then(Value::as_str).map_or(false, |s| returns::STATES.contains(&s))
                        && result.get("refund").and_then(Value::as_object).map_or(false, |r| r.len() == 3 && r.get("receivedMinor").map_or(false, Value::is_i64))
                }
                _ => false,
            };
            if !ok {
                return None;
            }
        }
        (Value::Null, "media.finalize_upload") if crate::media::finalize_result_ok(rc["outcome"].as_str(), result) => {}
        _ => return None,
    }
    // Exactly one of: undo data (offered by the receipt), or the reason the
    // receipt gives for offering none.
    let undo = value["undo"].as_object()?;
    let available = rc["undo"]["available"].as_bool()?;
    let undo = match (undo.len(), undo.get("data"), undo.get("unavailableReason")) {
        (1, Some(data), None) if available && rc["undo"]["reason"].is_null() && undo_data_ok(&kind, data) => Ok(data.clone()),
        (1, None, Some(Value::String(reason))) if !available && !reason.is_empty() && rc["undo"]["reason"].as_str() == Some(reason.as_str()) => Err(reason.clone()),
        _ => return None,
    };
    // A dirty report, a choice and a swap always carry undo data; an undo and a publication never do;
    // a laundry report does unless it changed nothing; a wear report always does, merged or not.
    match (kind.as_str(), &undo) {
        ("care.mark_dirty" | "board.select" | "board.swap_slot", Ok(_)) | ("command.undo" | "board.publish", Err(_)) => {}
        ("laundry.collect" | "laundry.return" | "care.washed", Ok(_)) if rc["outcome"] == "committed" => {}
        ("laundry.collect" | "laundry.return" | "care.washed", Err(_)) if rc["outcome"] == "noop" => {}
        ("wear.record", Ok(_)) if rc["outcome"] == "committed" || rc["outcome"] == "merged" => {}
        // Packing and unpacking are undone by voiding their events; an unpacking that unpacked nothing changed nothing.
        ("stock.pack" | "stock.unpack", Ok(_)) if rc["outcome"] == "committed" => {}
        ("stock.unpack", Err(_)) if rc["outcome"] == "noop" => {}
        // A comfort note can be withdrawn by undo; a repeat changed nothing, and a withdrawal is not undone.
        ("feedback.record", Ok(_)) if rc["outcome"] == "committed" => {}
        ("feedback.record", Err(_)) if rc["outcome"] == "noop" => {}
        ("feedback.retract", Err(_)) => {}
        // A trip's creation is undone by cancelling it; its edits, its cancellation and a proposal are not undone.
        ("trip.create", Ok(_)) if rc["outcome"] == "committed" => {}
        ("trip.update" | "trip.cancel" | "trip.record_packing_proposal", Err(_)) => {}
        // Opening a return is undone by cancelling it, and an update by putting the case back.
        ("return.open_case" | "return.update_case", Ok(_)) if rc["outcome"] == "committed" => {}
        // Storing a photograph, or refusing one, is not undone (photographs cannot be deleted here yet).
        ("media.finalize_upload", Err(_)) => {}
        _ => return None,
    }
    if rc["outcome"] == "noop" && !kind.starts_with("laundry.") && !kind.starts_with("feedback.") && kind != "care.washed" && kind != "trip.cancel" && kind != "stock.unpack" && kind != "media.finalize_upload" {
        return None;
    }
    if rc["outcome"] == "merged" && kind != "wear.record" {
        return None;
    }
    // A wear receipt's result and its undo data describe the same report: the same date, the same
    // observations in the same order, and one increment per further-unit event counted.
    if kind == "wear.record" {
        let data = undo.as_ref().ok()?;
        let events = data["stockEventIds"].as_array().map_or(usize::MAX, Vec::len) as u64;
        if data["wearingDate"] != result["wearingDate"] || data["observationIds"] != result["observationIds"] || result["additionalUnitEvents"].as_u64() != Some(events) {
            return None;
        }
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

/// The result each board command (and the undo of a choice or a swap) writes, field by field.
fn board_result_ok(kind: &str, r: &ferrite_app::serde_json::Map<String, Value>) -> bool {
    let s = |k: &str| r.get(k).and_then(Value::as_str).map_or(false, |x| !x.is_empty());
    let sn = |k: &str| matches!(r.get(k), Some(Value::Null)) || s(k);
    let n = |k: &str| r.get(k).and_then(Value::as_u64).is_some();
    let null = |k: &str| matches!(r.get(k), Some(Value::Null));
    let keys = |want: &[&str]| r.len() == want.len() && want.iter().all(|k| r.contains_key(*k));
    let base = s("boardId") && r.get("revision").and_then(Value::as_u64).map_or(false, |v| v >= 1);
    let role = r.get("role").and_then(Value::as_str).map_or(false, |x| board::ROLES.contains(&x));
    let basis = r.get("weatherBasis").and_then(Value::as_str).map_or(false, |x| x == "unavailable" || x == "not_weather_dependent");
    let date = r.get("localDate").and_then(Value::as_str).map_or(false, |x| x.len() == 10 && x.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() }));
    // Each dropped candidate: `{position, violations: [text]}`, as publication writes it.
    let dropped = r.get("dropped").and_then(Value::as_array).map_or(false, |a| {
        a.iter().all(|d| {
            d.as_object().map_or(false, |o| o.len() == 2)
                && d["position"].as_str().map_or(false, |x| !x.is_empty())
                && d["violations"].as_array().map_or(false, |v| !v.is_empty() && v.iter().all(|x| x.as_str().map_or(false, |x| !x.is_empty())))
        })
    });
    base && match kind {
        "board.publish" => {
            keys(&["boardId", "revision", "localDate", "scope", "offered", "reserves", "requestedCount", "dropped", "optionIds", "exposureId"])
                && date
                && r["scope"].as_str().map_or(false, board::scope_ok)
                && n("offered")
                && n("reserves")
                && n("requestedCount")
                && dropped
                && r["optionIds"].as_array().map_or(false, |a| a.iter().all(|x| x.as_str().map_or(false, |x| !x.is_empty())))
                && null("exposureId")
        }
        "board.select" => keys(&["boardId", "revision", "selectedOptionId", "footwearGarmentId"]) && sn("selectedOptionId") && sn("footwearGarmentId"),
        "undo.select" => keys(&["boardId", "revision", "selectedOptionId", "footwearGarmentId", "undoneCommandId"]) && sn("selectedOptionId") && sn("footwearGarmentId"),
        "board.swap_slot" => {
            keys(&["boardId", "revision", "optionId", "role", "garmentId", "replacedGarmentId", "weatherBasis", "weatherAgeMinutes"])
                && s("optionId")
                && role
                && s("garmentId")
                && sn("replacedGarmentId")
                && basis
                && null("weatherAgeMinutes")
        }
        "undo.swap" => keys(&["boardId", "revision", "optionId", "role", "garmentId", "weatherBasis", "undoneCommandId"]) && s("optionId") && role && sn("garmentId") && basis,
        _ => false,
    }
}

/// The undo data each undoable command writes, exactly.
fn undo_data_ok(kind: &str, data: &Value) -> bool {
    let Some(d) = data.as_object() else { return false };
    let keys = |want: &[&str]| d.len() == want.len() && want.iter().all(|k| d.contains_key(*k));
    let str_or_null = |k: &str| matches!(d.get(k), Some(Value::Null) | Some(Value::String(_)));
    let id = |k: &str| d.get(k).and_then(Value::as_str).map_or(false, |s| !s.is_empty());
    let event_ids = |d: &ferrite_app::serde_json::Map<String, Value>| d.get("stockEventIds").and_then(Value::as_array).map_or(false, |ids| !ids.is_empty() && ids.iter().all(|x| x.as_str().map_or(false, |s| !s.is_empty())));
    match kind {
        "care.mark_dirty" | "care.washed" | "stock.pack" | "stock.unpack" => keys(&["stockEventIds"]) && event_ids(d),
        "feedback.record" => keys(&["feedbackId"]) && id("feedbackId"),
        "trip.create" => keys(&["tripId"]) && id("tripId"),
        "return.open_case" => keys(&["caseId", "version"]) && id("caseId") && d["version"] == 1,
        "return.update_case" => keys(&["caseId", "version", "previous"]) && id("caseId") && d["version"].as_u64().map_or(false, |v| v >= 2) && d["previous"].is_object(),
        "wear.record" => {
            // Each list names each ID once: undo matches them against the journal as sets.
            let list = |k: &str, nonempty: bool| {
                d.get(k).and_then(Value::as_array).map_or(false, |a| {
                    let distinct: std::collections::BTreeSet<&str> = a.iter().filter_map(Value::as_str).collect();
                    (!nonempty || !a.is_empty()) && a.iter().all(|x| x.as_str().map_or(false, |s| !s.is_empty())) && distinct.len() == a.len()
                })
            };
            keys(&["observationIds", "wearingDate", "stockEventIds"])
                && list("observationIds", true)
                && list("stockEventIds", false)
                && d["wearingDate"].as_str().map_or(false, |x| parse_local_date(x).is_some())
        }
        "laundry.collect" => keys(&["stockEventIds", "batchId"]) && event_ids(d) && id("batchId"),
        // A return with no pickup on record, with or without a bag of its own for what is still away.
        "laundry.return" if !d.contains_key("batchId") => (keys(&["stockEventIds"]) || (keys(&["stockEventIds", "heldBatchId"]) && id("heldBatchId"))) && event_ids(d),
        "laundry.return" => {
            // Every value restored on undo is checked here, so a restored batch always reads back.
            let count = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).map_or(false, |x| x <= u64::from(u32::MAX));
            let time = |v: Option<&Value>| v.and_then(Value::as_str).and_then(crate::time::parse_instant).is_some();
            let open = |s: Option<&str>| matches!(s, Some("collected" | "partially_returned"));
            let after = |s: Option<&str>| matches!(s, Some("returned" | "partially_returned"));
            // `versionAfter` came later: a return recorded before it stays readable, but is not undone.
            (keys(&["stockEventIds", "batchId", "batchBefore", "statusAfter", "returnedAtAfter", "items"])
                || (keys(&["stockEventIds", "batchId", "batchBefore", "statusAfter", "returnedAtAfter", "versionAfter", "items"])
                    && d["versionAfter"].as_u64().map_or(false, |v| v >= 2)))
                && event_ids(d)
                && id("batchId")
                && after(d["statusAfter"].as_str())
                && time(d.get("returnedAtAfter"))
                && d["batchBefore"].as_object().map_or(false, |b| {
                    b.len() == 2 && open(b.get("status").and_then(Value::as_str)) && (matches!(b.get("returnedAt"), Some(Value::Null)) || time(b.get("returnedAt")))
                })
                && d["items"].as_array().map_or(false, |items| {
                    !items.is_empty()
                        && items.iter().all(|i| {
                            i.as_object().map_or(false, |o| o.len() == 6)
                                && i["garmentId"].as_str().map_or(false, |s| !s.is_empty())
                                && ["returnedBefore", "stillAwayBefore", "returnedAfter", "stillAwayAfter", "heldBefore"].iter().all(|k| count(i, k))
                        })
                })
        }
        "board.select" => {
            keys(&["boardId", "previousOptionId", "previousFootwearId", "previousAt", "wrote"])
                && id("boardId")
                && str_or_null("previousOptionId")
                && str_or_null("previousFootwearId")
                && str_or_null("previousAt")
                && d["wrote"].as_object().map_or(false, |w| w.len() == 1 && w.get("version").and_then(Value::as_u64).is_some())
        }
        "board.swap_slot" => {
            keys(&["boardId", "revisionBefore", "revisionAfter", "optionId", "role"])
                && id("boardId")
                && id("optionId")
                && d["role"].as_str().map_or(false, |r| board::ROLES.contains(&r))
                && matches!((d["revisionBefore"].as_u64(), d["revisionAfter"].as_u64()), (Some(a), Some(b)) if a < b)
        }
        _ => false,
    }
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

pub async fn read_wardrobe<S: Store>(store: &mut S, now_ms: u64, category: Option<&str>) -> Result<Value, CmdError> {
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
    let (receipts, _, _) = receipts_page(store, limit).await?;
    Ok(json!({"receipts": receipts}))
}

/// Recorded wear (`garderobe_inventory` view `history`): what was worn on `date` (`DailyRecord`), or
/// the counted wears from `from` to `to` inclusive, optionally of one garment. With the wardrobe
/// revision read. A day without a record is unknown, not unworn.
pub async fn read_history<S: Store>(store: &mut S, date: Option<&str>, range: Option<(&str, &str)>, garment: Option<&str>) -> Result<(Value, u64), CmdError> {
    let (_, l) = read_ledger(store).await?;
    let cat = catalogue();
    match (date, range) {
        (Some(d), None) => Ok((wear::daily_record(cat, &l, d), l.revision)),
        (None, Some((from, to))) => Ok((json!({"from": from, "to": to, "wears": wear::counted_wears(&l, from, to, garment), "caveat": "Recorded wears only; a day without a record is unknown, not unworn."}), l.revision)),
        _ => Err(CmdError::new("invalid_command", "name either a date, or a range from and to")),
    }
}

/// `GET /v1/days/{date}` (`DailyRecord`, as `getDailyRecord`): what the owner recorded as worn that
/// day, the counted garments and every report kept. The same record `garderobe_inventory` view
/// `history` gives for a date; choosing an outfit never changes it.
pub async fn read_day<S: Store>(store: &mut S, date: &str) -> Result<Value, CmdError> {
    if parse_local_date(date).is_none() {
        return Err(CmdError::new("invalid_command", "the date must be written YYYY-MM-DD"));
    }
    let (_, l) = read_ledger(store).await?;
    Ok(wear::daily_record(catalogue(), &l, date))
}

/// `GET /v1/today[?date=]` for the home board; see `read_today_scoped`.
pub async fn read_today<S: Store>(store: &mut S, now_ms: u64, date: Option<&str>) -> Result<Value, CmdError> {
    read_today_scoped(store, now_ms, date, "home").await
}

/// `GET /v1/today[?date=][&scope=]` (`TodayResponse`, `getToday`): the day's board of `scope` (the
/// home board, or a trip's day board), read without inference. Without a date it is the owner's day
/// now, in the owner's timezone (`time::OWNER_TIMEZONE`), whatever the scope, as in TypeScript.
pub async fn read_today_scoped<S: Store>(store: &mut S, now_ms: u64, date: Option<&str>, scope: &str) -> Result<Value, CmdError> {
    let owner_today = crate::time::local_date(crate::time::owner_day(now_ms));
    let date = match date {
        None => owner_today.as_str(),
        Some(d) if parse_local_date(d).is_some() => d,
        Some(_) => return Err(CmdError::with("invalid_command", "date: expected the day as YYYY-MM-DD", json!({"issues": ["date: expected YYYY-MM-DD"]}))),
    };
    // The ledger and the board are separate records committed together; read the ledger again after
    // the board, so the board and the stock it is checked against belong to the same commit.
    for _ in 0..3 {
        let (before, l) = read_ledger(store).await?;
        let board = indexed_board(store, l.board_for(scope, date)).await?;
        let plan = trip_plan(store, &l, scope).await?;
        let (after, _) = read_ledger(store).await?;
        if before != after {
            continue;
        }
        let cat = catalogue();
        let day = board::Day::for_board(cat, &l, scope, date, plan.as_ref());
        return Ok(board::today(&day, date, board.as_ref(), wear::day_record(cat, &l, date), l.revision, now_ms));
    }
    Err(CmdError::with("conflict", "the wardrobe kept changing while the board was read; try again", json!({"retryable": true})))
}

/// `POST /v1/wardrobe/selection` (`GarmentSelection`): the garments a bulk edit with this selector
/// would touch. Writes nothing.
pub async fn read_selection<S: Store>(store: &mut S, body: &[u8]) -> Result<Value, CmdError> {
    let selector: Value = serde_json::from_slice(body).map_err(|_| CmdError::with("invalid_command", "that selection is not valid", json!({"issues": ["body: expected a JSON object"]})))?;
    crate::selection::parse_selector(&selector)?;
    let (_, l) = read_ledger(store).await?;
    crate::selection::preview(catalogue(), &l, &selector)
}

/// `GET /v1/availability[?date=]` (`AvailabilitySnapshot`): every garment's availability for a fresh
/// wear on the day (the owner's day now without one), with the open option sets derived from the
/// boards the ledger indexes for the days that still count (`availability::board_exposures`).
pub async fn read_availability<S: Store>(store: &mut S, now_ms: u64, date: Option<&str>) -> Result<Value, CmdError> {
    let for_date = match date {
        None => crate::time::local_date(crate::time::owner_day(now_ms)),
        Some(d) if parse_local_date(d).is_some() => d.to_string(),
        Some(_) => return Err(CmdError::with("invalid_command", "date: expected the day as YYYY-MM-DD", json!({"issues": ["date: expected YYYY-MM-DD"]}))),
    };
    let (l, exposures) = exposures_for(store, &for_date).await?;
    let input = crate::availability::Input::new(catalogue(), &l, &for_date, exposures);
    Ok(crate::availability::snapshot(&input, &for_date, now_ms))
}

/// The ledger and the open option sets for a fresh wear on `for_date`: the boards the ledger indexes for
/// the days that still count, read between two reads of the ledger so the sets and the stock they are
/// weighed against belong to the same commit (the boards and the ledger are separate records committed
/// together).
pub(crate) async fn exposures_for<S: Store>(store: &mut S, for_date: &str) -> Result<(Ledger, Vec<crate::availability::ExposureSet>), CmdError> {
    let from = crate::availability::horizon(for_date);
    for _ in 0..3 {
        let (before, l) = read_ledger(store).await?;
        let mut boards = Vec::new();
        for r in l.boards.iter().filter(|b| crate::availability::day_scope(&b.scope) && b.local_date.as_str() >= from.as_str() && b.local_date.as_str() < for_date) {
            if let Some(b) = indexed_board(store, Some(r)).await? {
                boards.push(b);
            }
        }
        let (after, _) = read_ledger(store).await?;
        if before != after {
            continue;
        }
        let exposures = crate::availability::board_exposures(&l, &boards, &from, for_date);
        return Ok((l, exposures));
    }
    Err(CmdError::with("conflict", "the wardrobe kept changing while availability was read; try again", json!({"retryable": true})))
}

/// `GET /v1/weather[?date=]` (`WeatherSnapshot`), for the owner's day now when no date is named.
/// See `weather.rs`: the port has no home city, so the snapshot says no forecast was requested.
pub fn read_weather(now_ms: u64, date: Option<&str>) -> Result<Value, CmdError> {
    let local_date = match date {
        None => crate::time::local_date(crate::time::owner_day(now_ms)),
        Some(d) if parse_local_date(d).is_some() => d.to_string(),
        Some(_) => return Err(CmdError::with("invalid_command", "date: expected the day as YYYY-MM-DD", json!({"issues": ["date: expected YYYY-MM-DD"]}))),
    };
    Ok(crate::weather::snapshot(&local_date, now_ms, &format!("wxs_{}", crate::random::token(16))))
}

/// The board document of `board_id`, checked against the stock read in the same commit as the board.
pub(crate) async fn board_view<S: Store>(store: &mut S, board_id: &str) -> Result<Value, CmdError> {
    for _ in 0..3 {
        let (before, l) = read_ledger(store).await?;
        let Some(board) = load_board(store, board_id).await? else {
            return Err(CmdError::new("not_found", "that board was not found"));
        };
        let plan = trip_plan(store, &l, &board.scope).await?;
        let (after, _) = read_ledger(store).await?;
        if before != after {
            continue;
        }
        let day = board::Day::for_board(catalogue(), &l, &board.scope, &board.local_date, plan.as_ref());
        return Ok(board::document(&day, &board, l.revision));
    }
    Err(CmdError::with("conflict", "the wardrobe kept changing while the board was read; try again", json!({"retryable": true})))
}

/// The newest `limit` receipts, whether older ones exist, and the wardrobe
/// revision read. Every command raises the revision by one, so the revision
/// is the number of receipts there are.
pub async fn receipts_page<S: Store>(store: &mut S, limit: usize) -> Result<(Vec<Value>, bool, u64), CmdError> {
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
    let more = l.revision > receipts.len() as u64;
    Ok((receipts, more, l.revision))
}

/// `RESTRICTION_LIFT_TYPES` in packages/assistant/src/policy/classes.ts.
pub const RESTRICTION_LIFT_TYPES: [&str; 2] = ["assistant.lift_restriction", "restriction.resolve"];

/// `forbiddenForConnectedAssistant` in packages/assistant/src/policy/classes.ts:
/// why a connected assistant may never carry out this change, whatever it
/// relays. `undo_target` is the type of the command an undo would take back.
pub fn connected_refusal(kind: &str, undo_target: Option<&str>) -> Option<&'static str> {
    if RESTRICTION_LIFT_TYPES.contains(&kind) {
        return Some("restriction_lift_not_relayed");
    }
    if kind == "command.undo" && undo_target == Some("restriction.add") {
        return Some("restriction_not_lifted_by_undo");
    }
    None
}

fn connected_refusal_error(reason: &'static str) -> CmdError {
    CmdError::with(
        "forbidden",
        "a connected assistant cannot lift a restriction or undo the command that recorded one; nothing was changed. The owner lifts it in the Garderobe app by saying its condition has ended.",
        json!({"reason": reason}),
    )
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
    // Every number a command of this slice carries is a count or a version, a trip destination's
    // coordinate, or a return's refund amount. Refusing anything else keeps the request hash exactly JavaScript's.
    if !numbers_are_accepted(v) {
        return Err(envelope_error(format!(
            "numbers in a command must be whole numbers from 0 to {MAX_SAFE} (a trip destination's latitude and longitude may be any coordinate, and a return's refund amounts may be negative)"
        )));
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

/// The authorizations this port accepts for any command (`checkAuthorization` in service.ts, less the
/// schedule and policy bases: the port has no schedules yet).
pub const ACCEPTED_AUTHORIZATIONS: &[&str] = &["owner_tap", "owner_statement"];

/// `checkAuthorization` in service.ts. Every command of this port is one an
/// owner tap or an owner statement authorizes (a publication also by a
/// schedule, which this port does not have yet); only the owner can tap, and
/// an assistant can only relay the owner's words.
fn check_authorization(principal: Principal, env: &Envelope, source_channel: &str) -> Result<(), CmdError> {
    let allowed = ACCEPTED_AUTHORIZATIONS;
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

/// Most entries an `expectedVersions` map may name.
const MAX_EXPECTED: usize = 16;

/// The current revision of every board `expectedVersions` names (absent boards are left out).
async fn expected_boards<S: Store>(store: &mut S, env: &Envelope) -> Result<Vec<(String, u64)>, CmdError> {
    let Some(map) = env.expected_versions.as_object() else { return Ok(Vec::new()) };
    if map.len() > MAX_EXPECTED {
        return Err(envelope_error(format!("expectedVersions: at most {MAX_EXPECTED} entries")));
    }
    let mut out = Vec::new();
    for key in map.keys() {
        if let Some(id) = key.strip_prefix("board:") {
            if let Some(b) = load_board(store, id).await? {
                out.push((id.to_string(), b.current_revision));
            }
        }
    }
    Ok(out)
}

/// The owner's observations: `expectedVersions` is not checked for them (they are rebased), and the
/// boards it names are not even read, so an unrelated board can never refuse a wash or wear report.
/// A comfort note is an observation too (`class: "observation"` in feedback.ts).
const OBSERVATIONS: &[&str] = &["care.mark_dirty", "care.washed", "feedback.record", "feedback.retract", "laundry.collect", "laundry.return", "wear.record"];

/// Client-stated versions, checked for every command but an observation
/// (a wash report, a laundry pickup or return is rebased instead, section 5 of the specification).
/// A board choice does not advance the board's revision, so it can be made
/// at the version the client read; a revision moved by anyone else is a conflict.
fn check_expected_versions(env: &Envelope, l: &Ledger, boards: &[(String, u64)]) -> Result<(), CmdError> {
    if OBSERVATIONS.contains(&env.kind.as_str()) {
        return Ok(());
    }
    if let Some(map) = env.expected_versions.as_object() {
        for (key, want) in map {
            let (kind, id) = key.split_once(':').unwrap_or((key.as_str(), ""));
            let have = match kind {
                "wardrobe" => Some(l.revision),
                "garment" => Some(l.garment_version(id)),
                "board" => boards.iter().find(|(b, _)| b == id).map(|(_, r)| *r),
                "laundry_batch" => l.batch(id).map(|b| b.version),
                "trip" => l.trips.get(id).copied(),
                "return_case" => l.returns.get(id).copied(),
                _ => return Err(CmdError::with("invalid_command", format!("unknown expected-version kind '{kind}'"), json!({"key": key}))),
            };
            if have.is_none() || have != whole(want) {
                return Err(CmdError::with("conflict", "this was changed elsewhere since you last saw it; nothing was written", json!({"failed": format!("expected {key} = {want}")})));
            }
        }
    }
    Ok(())
}

/// What a command is about to write besides the ledger and its record.
struct Planned {
    plan: Plan,
    board: Option<board::Outcome>,
    original: Option<Record>,
    /// Further records the command writes in the same commit (a comfort note).
    docs: Vec<(Vec<u8>, Value)>,
}

impl Planned {
    fn stock(plan: Plan) -> Planned {
        Planned { plan, board: None, original: None, docs: Vec::new() }
    }
    fn board(out: board::Outcome) -> Planned {
        Planned { plan: out.plan.clone(), board: Some(out), original: None, docs: Vec::new() }
    }
    fn note((plan, note): (Plan, Option<Note>)) -> Planned {
        let docs = note.map(|n| vec![(feedback::key(&n.feedback_id), n.to_json())]).unwrap_or_default();
        Planned { plan, board: None, original: None, docs }
    }
    fn trip(plan: Plan, trip: Option<Trip>) -> Planned {
        let docs = trip.map(|t| vec![(trips::key(&t.trip_id), t.to_json())]).unwrap_or_default();
        Planned { plan, board: None, original: None, docs }
    }
    fn case((plan, case): (Plan, Case)) -> Planned {
        Planned { plan, board: None, original: None, docs: vec![(returns::key(&case.case_id), case.to_json())] }
    }
}

/// The day a board is validated against: a trip's day board against what is packed for the trip (with
/// the reuse its packing proposal planned), the home board against home stock with the repeat horizon
/// looking back from its day. No board is validated against undated home stock.
async fn board_day<'c, S: Store>(store: &mut S, cat: &'c Catalogue, current: &Ledger, b: Option<&board::Board>) -> Result<board::Day<'c>, CmdError> {
    match b {
        None => Ok(board::Day::of(cat, current, "")),
        Some(b) => {
            let plan = trip_plan(store, current, &b.scope).await?;
            Ok(board::Day::for_board(cat, current, &b.scope, &b.local_date, plan.as_ref()))
        }
    }
}

/// Plan one command against `current`, writing ledger changes into `next`.
async fn plan_command<S: Store>(store: &mut S, principal: Principal, env: &Envelope, ctx: &Ctx<'_>, current: &Ledger, next: &mut Ledger, undo_target: Option<&str>) -> Result<Planned, CmdError> {
    let boards = if OBSERVATIONS.contains(&env.kind.as_str()) {
        // The envelope's shape still holds; only the board reads are skipped.
        if env.expected_versions.as_object().map_or(false, |m| m.len() > MAX_EXPECTED) {
            return Err(envelope_error(format!("expectedVersions: at most {MAX_EXPECTED} entries")));
        }
        Vec::new()
    } else {
        expected_boards(store, env).await?
    };
    check_expected_versions(env, current, &boards)?;
    // A board is validated for its own scope and date: a trip's day board against what is packed for
    // the trip, the home board against home stock with the repeat horizon looking back from its day.
    match (env.kind.as_str(), undo_target) {
        ("care.mark_dirty", _) => Ok(Planned::stock(ledger::mark_dirty(ctx, next, &env.payload)?)),
        ("care.washed", _) => Ok(Planned::stock(ledger::washed(ctx, next, &env.payload)?)),
        ("laundry.collect", _) => Ok(Planned::stock(laundry::collect(ctx, next, &env.payload)?)),
        ("laundry.return", _) => Ok(Planned::stock(laundry::return_batch(ctx, next, &env.payload)?)),
        ("wear.record", _) => Ok(Planned::stock(wear::record(ctx, next, &env.payload, principal.channel, env.occurred_at.is_some())?)),
        ("stock.pack", _) => {
            let input = crate::packing::parse_pack(&env.payload)?;
            let trip = load_trip(store, &input.trip_id).await?;
            Ok(Planned::stock(crate::packing::pack(ctx, next, trip.as_ref(), input)?))
        }
        ("stock.unpack", _) => {
            let input = crate::packing::parse_unpack(&env.payload)?;
            let trip = load_trip(store, &input.trip_id).await?;
            Ok(Planned::stock(crate::packing::unpack(ctx, next, trip.as_ref(), input)?))
        }
        ("feedback.record", _) => {
            let input = feedback::parse_record(&env.payload)?;
            // The final ID is settled before anything is read, so a generated ID never lands on a
            // note a caller already recorded under that name.
            let (id, existing) = match &input.feedback_id {
                Some(id) => (id.clone(), load_note(store, id).await?),
                None => (free_feedback_id(store, ctx, next).await?, None),
            };
            Ok(Planned::note(feedback::record(ctx, next, input, id, existing.as_ref())?))
        }
        ("feedback.retract", _) => {
            let id = feedback::parse_retract(&env.payload)?;
            let existing = load_note(store, &id).await?;
            Ok(Planned::note(feedback::retract(next, &id, existing.as_ref())?))
        }
        ("trip.create", _) => {
            let input = trips::parse_create(&env.payload)?;
            let (plan, trip) = trips::create(ctx, next, input)?;
            Ok(Planned::trip(plan, Some(trip)))
        }
        ("trip.update", _) => {
            let input = trips::parse_update(&env.payload)?;
            let trip = load_trip(store, &input.trip_id).await?;
            let (plan, trip) = trips::update(ctx, next, trip.as_ref(), input)?;
            Ok(Planned::trip(plan, Some(trip)))
        }
        ("trip.cancel", _) => {
            let id = trips::parse_cancel(&env.payload)?;
            let trip = load_trip(store, &id).await?;
            let still_packed = ledger::replay(ctx.cat, &next.events).packed_for(&id);
            let (plan, trip) = trips::cancel(ctx, next, &id, trip.as_ref(), still_packed)?;
            Ok(Planned::trip(plan, trip))
        }
        ("trip.record_packing_proposal", _) => {
            let input = trips::parse_proposal(ctx.cat, &env.payload)?;
            let trip = load_trip(store, &input.trip_id).await?;
            let (plan, trip, proposal) = trips::record_proposal(ctx, trip.as_ref(), input)?;
            let mut planned = Planned::trip(plan, None);
            planned.docs.push((trips::proposal_key(&trip.trip_id, trip.proposal_revision), proposal));
            planned.docs.push((trips::key(&trip.trip_id), trip.to_json()));
            Ok(planned)
        }
        ("return.open_case", _) => {
            let input = returns::parse_open(&env.payload)?;
            Ok(Planned::case(returns::open(ctx, next, input)?))
        }
        ("return.update_case", _) => {
            let input = returns::parse_update(&env.payload)?;
            let case = load_case(store, &input.case_id).await?;
            Ok(Planned::case(returns::update(ctx, next, case.as_ref(), input)?))
        }
        ("board.publish", _) => {
            let input = board::publish_input(&env.payload)?;
            // A trip's day board is for a day of a trip still planned (`prepareTripDayBoard`).
            if let Some(trip_id) = board::scope_trip(&input.scope) {
                match load_trip(store, trip_id).await? {
                    Some(t) if t.status == "planned" => {
                        if input.local_date < t.departs_on || input.local_date > t.returns_on {
                            return Err(CmdError::with("invalid_command", "that date is outside the trip", json!({"tripId": trip_id, "localDate": input.local_date, "departsOn": t.departs_on, "returnsOn": t.returns_on})));
                        }
                    }
                    _ => return Err(CmdError::with("not_found", format!("no active trip '{trip_id}'"), json!({"tripId": trip_id}))),
                }
            }
            let existing = indexed_board(store, current.board_for(&input.scope, &input.local_date)).await?;
            let plan = trip_plan(store, current, &input.scope).await?;
            let day = board::Day::for_board(ctx.cat, current, &input.scope, &input.local_date, plan.as_ref());
            Ok(Planned::board(board::publish(ctx, &day, existing.as_ref(), input)?))
        }
        ("board.select", _) => {
            let id = board::named_board(&env.kind, &env.payload)?;
            let b = load_board(store, &id).await?;
            let day = board_day(store, ctx.cat, current, b.as_ref()).await?;
            Ok(Planned::board(board::select(ctx, &day, b.as_ref(), &env.payload)?))
        }
        ("board.swap_slot", _) => {
            let id = board::named_board(&env.kind, &env.payload)?;
            let b = load_board(store, &id).await?;
            let day = board_day(store, ctx.cat, current, b.as_ref()).await?;
            Ok(Planned::board(board::swap(ctx, &day, b.as_ref(), &env.payload)?))
        }
        ("media.finalize_upload", _) => {
            let (plan, docs) = crate::media::plan_finalize(store, principal, ctx, &env.payload).await?;
            Ok(Planned { plan, board: None, original: None, docs })
        }
        ("command.undo", Some(target)) => {
            let record = load_command(store, target).await?;
            if principal.actor == ASSISTANT.actor {
                if let Some(r) = &record {
                    if connected_refusal(&env.kind, Some(&r.command.kind)).is_some() {
                        return Err(connected_refusal_error("restriction_not_lifted_by_undo"));
                    }
                }
            }
            let data = ledger::undo_precheck(record.as_ref().map(|r| &r.command), target)?;
            let Some(record) = record else { return Err(CmdError::new("not_found", "there is no such action to undo")) };
            let summary = record.command.summary.clone();
            let mut planned = match record.command.kind.as_str() {
                "care.mark_dirty" | "care.washed" | "stock.pack" | "stock.unpack" => Planned::stock(ledger::command_undo(ctx, next, Some(&record.command), target)?),
                "laundry.collect" => Planned::stock(laundry::undo_collect(ctx, next, &record.command, &data, target)?),
                "laundry.return" => Planned::stock(laundry::undo_return(ctx, next, &record.command, &data, target)?),
                "wear.record" => Planned::stock(wear::undo_record(ctx, next, &record.command, &data, target)?),
                "feedback.record" => {
                    let existing = load_note(store, feedback::undo_target_note(&data).unwrap_or_default()).await?;
                    Planned::note(feedback::undo_record(next, existing.as_ref(), &summary, target)?)
                }
                "trip.create" => {
                    let id = trips::undo_target_trip(&data).unwrap_or_default().to_string();
                    let trip = load_trip(store, &id).await?;
                    let packed = ledger::replay(ctx.cat, &next.events).packed_for(&id);
                    let (plan, trip) = trips::undo_create(ctx, next, trip.as_ref(), packed, &summary, target)?;
                    Planned::trip(plan, Some(trip))
                }
                kind @ ("return.open_case" | "return.update_case") => {
                    let case = load_case(store, returns::undo_target_case(&data).unwrap_or_default()).await?;
                    Planned::case(if kind == "return.open_case" {
                        returns::undo_open(ctx, next, case.as_ref(), &data, &summary, target)?
                    } else {
                        returns::undo_update(ctx, next, case.as_ref(), &data, &summary, target)?
                    })
                }
                kind @ ("board.select" | "board.swap_slot") => {
                    let b = load_board(store, data["boardId"].as_str().unwrap_or_default()).await?;
                    Planned::board(if kind == "board.select" {
                        board::undo_select(ctx, b.as_ref(), &data, &summary, target)?
                    } else {
                        let day = board_day(store, ctx.cat, current, b.as_ref()).await?;
                        board::undo_swap(ctx, &day, b.as_ref(), &data, &summary, target)?
                    })
                }
                other => return Err(CmdError::with("not_undoable", "this action has no automatic undo", json!({"commandId": target, "type": other}))),
            };
            planned.original = Some(record);
            Ok(planned)
        }
        _ => Err(CmdError::with("unknown_command", format!("unknown command type '{}'", env.kind), json!({"known": ledger::COMMAND_TYPES}))),
    }
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

/// The receipt and payload of the command an idempotency key already recorded, if one did. A route
/// that computes its payload (a packing proposal) asks first, so a retransmission answers from what
/// was recorded instead of recomputing a payload that no longer matches. A marker or record that
/// cannot be read is an unknown outcome, as in [`replay_existing`].
pub(crate) async fn recorded_request<S: Store>(store: &mut S, key: &str) -> Result<Option<(Value, Value)>, CmdError> {
    let Some(bytes) = store.get(&idempotency_key(key)).await.map_err(|_| unknown_outcome())? else {
        return Ok(None);
    };
    let parsed = serde_json::from_slice::<Value>(&bytes).ok().and_then(|m| {
        let id = m.get("commandId")?.as_str()?.to_string();
        let hash = m.get("requestHash")?.as_str()?.to_string();
        (id.starts_with("cmd_") && id.len() <= 64 && is_hash(&hash)).then_some((id, hash))
    });
    let Some((command_id, hash)) = parsed else { return Err(unknown_outcome()) };
    match load_command(store, &command_id).await.ok().flatten() {
        Some(record) if record.request_hash == hash => {
            let mut receipt = current_receipt(&record.value);
            receipt["replayed"] = json!(true);
            Ok(Some((receipt, record.value["payload"].clone())))
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
        && matches!(str_of("outcome"), Some("committed") | Some("noop") | Some("merged"))
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
    // Refused before anything else is looked up: a connected assistant never lifts a restriction.
    if principal.actor == ASSISTANT.actor {
        if let Some(reason) = connected_refusal(&env.kind, None) {
            return Err(connected_refusal_error(reason));
        }
    }
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
        let planned = match plan_command(store, principal, &env, &ctx, &current, &mut next, undo_target.as_deref()).await {
            Ok(planned) => planned,
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
        let Planned { plan, board: board_out, original: original_record, docs } = planned;
        if let Some(out) = &board_out {
            if out.created {
                // Index entries for long-past days are dropped (their records stay); the index stays bounded.
                let keep_from = earliest_day(now_ms) - board::INDEX_KEPT_DAYS;
                next.boards.retain(|r| parse_local_date(&r.local_date).map_or(false, |d| d >= keep_from));
                next.boards.push(BoardRef { board_id: out.board.board_id.clone(), scope: out.board.scope.clone(), local_date: out.board.local_date.clone() });
            }
        }
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
        if let Some(out) = &board_out {
            entries.push((board_key(&out.board.board_id), out.board.to_json().to_string().into_bytes()));
        }
        for (key, doc) in &docs {
            entries.push((key.clone(), doc.to_string().into_bytes()));
        }
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
    fn a_connected_assistant_is_refused_restriction_lifts_and_their_undo() {
        assert_eq!(connected_refusal("restriction.resolve", None), Some("restriction_lift_not_relayed"));
        assert_eq!(connected_refusal("assistant.lift_restriction", None), Some("restriction_lift_not_relayed"));
        assert_eq!(connected_refusal("command.undo", Some("restriction.add")), Some("restriction_not_lifted_by_undo"));
        assert_eq!(connected_refusal("command.undo", Some("care.mark_dirty")), None);
        assert_eq!(connected_refusal("care.mark_dirty", None), None);
    }

    #[test]
    fn bearer_tokens_select_the_principal() {
        let tokens = Tokens { owner: Some("owner-secret".into()), assistant: Some("assistant-secret".into()), ..Tokens::default() };
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
        assert_eq!(authenticate_static(&req, &tokens).unwrap_err().code, "unauthenticated");
        req.headers = vec![("authorization".into(), "Bearer owner-secret".into())];
        assert_eq!(authenticate_static(&req, &tokens).unwrap(), Ok(OWNER));
        req.headers = vec![("authorization".into(), "Bearer assistant-secret".into())];
        assert_eq!(authenticate_static(&req, &tokens).unwrap(), Ok(ASSISTANT));
        req.headers = vec![("authorization".into(), "Bearer guess".into())];
        assert_eq!(authenticate_static(&req, &tokens).unwrap(), Err("guess".to_string()), "an unknown token goes on to the app sign-in check");
        assert_eq!(authenticate_static(&req, &Tokens::default()).unwrap_err().code, "internal");
    }
}
