//! App routes the iOS client calls on its Today screen and at launch, built on the commands and the
//! recommender the port already has (apps/worker/src/routes/core.ts and routes/daily.ts):
//!
//! * `GET /v1/meta`: versions, mounted modules, server time and the MCP endpoint;
//! * `POST /v1/commands/batch`: the phone's offline replay, each command independent;
//! * `POST /v1/recommendations`: options in `preview` mode, or a published board in `board` mode;
//! * `POST /v1/boards/{id}/swap`: one slot of one option, through `board.swap_slot`;
//! * `POST /v1/trips/{id}/packing-proposal`: a packing proposal, through `trip.record_packing_proposal`;
//! * `GET /v1/recovery`: the recovery screen's state.
//!
//! Nothing here is a second implementation of a command: every change goes through
//! [`api::execute`] with its receipt and undo, exactly as `POST /v1/commands` runs it.

use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::{self, Principal, Store, CONTRACT_VERSION, OWNER};
use crate::ledger::CmdError;
use crate::recommend;
use crate::time::instant;

/// Most commands one offline replay may carry (`MAX_BATCH_COMMANDS` in routes/core.ts).
pub const MAX_BATCH_COMMANDS: usize = 50;

/// `GET /v1/recovery` (`RecoveryStatus`, as the route in apps/worker/src/routes/identity.ts): concrete
/// state for the recovery screen instead of a generic error. The board is the home board of the
/// owner's day now, read as Today reads it; a failed read is reported in the diagnostics and never
/// stops the answer. This port has no effects queue, no run that waits for the owner's input and no
/// outbound connections, so nothing is pending and there are no connection issues.
pub async fn recovery<S: Store>(store: &mut S, now_ms: u64) -> Value {
    let mut diagnostics = Map::new();
    diagnostics.insert("environment".into(), json!("ferrite"));
    diagnostics.insert("modules".into(), json!({"daily": true, "assistant": true, "media": false}));
    let (mut last_board, mut projection) = (Value::Null, Value::Null);
    match api::read_today(store, now_ms, None).await {
        Ok(today) => {
            let b = &today["board"];
            if b.is_object() {
                last_board = json!({"boardId": b["boardId"], "localDate": b["localDate"], "revision": b["revision"], "publishedAt": b["publishedAt"]});
                projection = b["calendarProjection"].clone();
            } else {
                diagnostics.insert("noBoardReason".into(), today["emptyReason"].clone());
            }
        }
        Err(e) => {
            diagnostics.insert("boardReadError".into(), json!(e.message.chars().take(200).collect::<String>()));
        }
    }
    let actions = if last_board.is_null() { json!([]) } else { json!(["open_today"]) };
    json!({
        "lastBoard": last_board,
        "lastCalendarProjection": projection,
        "pending": {"effects": 0, "runsNeedingInput": 0},
        "connectionIssues": [],
        "actions": actions,
        "diagnostics": Value::Object(diagnostics),
        "readAt": instant(now_ms),
    })
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("invalid_command", message)
}

fn body_object(body: &[u8]) -> Result<Map<String, Value>, CmdError> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(invalid("the request body must be a JSON object")),
        Err(_) => Err(invalid("the request body is not valid JSON")),
    }
}

fn only_keys(m: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), CmdError> {
    match m.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(invalid(format!("'{k}' is not a field of {what}"))),
        None => Ok(()),
    }
}

/// The authorization a principal's own request carries: the owner's app taps; a connected
/// assistant relays the owner's words.
fn authorization(principal: Principal) -> &'static str {
    if principal == OWNER { "owner_tap" } else { "owner_statement" }
}

/// `GET /v1/meta` (`MetaResponse`). `origin` is the validated public origin; without one the MCP
/// endpoint cannot be named, so the request is refused by the secret's name, as `/mcp` itself is.
pub fn meta(origin: Option<&str>, now_ms: u64) -> Result<Value, CmdError> {
    let Some(origin) = origin else {
        return Err(CmdError::with(
            "internal",
            format!("the server has no valid {} secret (https://host, or http on a loopback host, with no path), so the MCP endpoint cannot be named; set it and deploy again", crate::oauth::PUBLIC_ORIGIN_SECRET),
            json!({"retryable": false}),
        ));
    };
    Ok(json!({
        "apiVersion": "v1",
        "contractVersion": CONTRACT_VERSION,
        "serverTime": instant(now_ms),
        "environment": "ferrite",
        "modules": [
            {"name": "foundation", "mounted": true},
            {"name": "daily", "mounted": true},
            {"name": "assistant", "mounted": true},
            {"name": "media", "mounted": false},
        ],
        "mcp": {
            "endpoint": format!("{origin}/mcp"),
            "protocolVersions": crate::mcp::PROTOCOL_VERSIONS,
            "authorizationServer": origin,
        },
    }))
}

/// Whether resubmitting the identical command later can succeed (`isRetryable` in errors.ts).
fn retryable(code: &str) -> bool {
    matches!(code, "internal" | "rate_limited" | "module_unavailable")
}

/// `POST /v1/commands/batch` (`CommandBatchResponse`): the phone's queued commands in the order they
/// were made, each with the idempotency key it was given then. Every command is independent: one
/// refusal never blocks or rolls back the others, and each result says whether it is final or worth
/// sending again. A command already applied answers from its receipt (`replayed: true`).
pub async fn batch<S: Store>(store: &mut S, principal: Principal, now_ms: u64, body: &[u8]) -> Result<Value, CmdError> {
    let m = body_object(body)?;
    only_keys(&m, &["commands"], "a command batch")?;
    let commands = match m.get("commands") {
        Some(Value::Array(a)) if !a.is_empty() && a.len() <= MAX_BATCH_COMMANDS => a,
        _ => return Err(invalid(format!("commands: expected 1 to {MAX_BATCH_COMMANDS} command envelopes"))),
    };
    let mut results = Vec::with_capacity(commands.len());
    // The revision before anything runs: with the receipts' own revisions it bounds the answer's
    // revision if the final read fails, so the results already collected are never discarded.
    let (_, before) = api::read_ledger(store).await?;
    let mut seen = before.revision;
    for command in commands {
        let key = command.get("idempotencyKey").and_then(Value::as_str).unwrap_or("").to_string();
        let outcome = if command.is_object() { api::execute(store, principal, now_ms, command).await } else { Err(invalid("the command envelope is invalid: expected a JSON object")) };
        results.push(match outcome {
            Ok(receipt) => {
                seen = seen.max(receipt["wardrobeRevision"].as_u64().unwrap_or(0));
                json!({"status": "receipt", "idempotencyKey": key, "receipt": receipt})
            }
            Err(e) => json!({"status": "error", "idempotencyKey": key, "error": {"code": e.code, "message": e.message, "details": e.details}, "retryable": retryable(e.code)}),
        });
    }
    // Once commands have run, a failed final read answers the results with the highest revision
    // this request saw (a lower bound of the current one) rather than an error that would hide them.
    let revision = match api::read_ledger(store).await {
        Ok((_, ledger)) => ledger.revision.max(seen),
        Err(_) => seen,
    };
    Ok(json!({"results": results, "wardrobeRevision": revision}))
}

/// The parsed `RecommendRequest`, and whether it asks for a published board.
fn recommend_request(body: &[u8]) -> Result<(recommend::RecommendInput, bool), CmdError> {
    let m = body_object(body)?;
    only_keys(&m, &["clientRequestId", "date", "brief", "count", "lockedGarmentIds", "occasionOnly", "mode"], "a recommendation request")?;
    // Keeping chosen pieces and occasion-only days are not ported: asked for, they are refused, never ignored.
    match m.get("lockedGarmentIds") {
        None => {}
        Some(Value::Array(a)) if a.is_empty() => {}
        Some(Value::Array(_)) => return Err(invalid("lockedGarmentIds: keeping chosen pieces is not ported to this server yet; send an empty list")),
        Some(_) => return Err(invalid("lockedGarmentIds: expected a list of garment IDs")),
    }
    match m.get("occasionOnly") {
        None | Some(Value::Bool(false)) => {}
        Some(Value::Bool(true)) => return Err(invalid("occasionOnly: occasion-only recommendations are not ported to this server yet")),
        Some(_) => return Err(invalid("occasionOnly: expected true or false")),
    }
    let board = match m.get("mode") {
        None => false,
        Some(Value::String(s)) if s == "preview" => false,
        Some(Value::String(s)) if s == "board" => true,
        Some(_) => return Err(invalid("mode: expected preview or board")),
    };
    let args: Map<String, Value> = m.into_iter().filter(|(k, _)| matches!(k.as_str(), "clientRequestId" | "date" | "brief" | "count")).collect();
    Ok((recommend::parse_input(&args)?, board))
}

/// The `board.publish` option of one recommended option, exactly as it was composed.
fn publish_option(o: &Value) -> Value {
    let ids = |v: &Value| v.as_array().map(|a| a.iter().filter_map(|l| l["garmentId"].as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default();
    let mut slots: Vec<Value> = o["garments"].as_array().map(|a| a.iter().map(|l| json!({"role": l["role"], "garmentId": l["garmentId"]})).collect()).unwrap_or_default();
    if let Some(id) = o["flourish"]["garmentId"].as_str() {
        slots.push(json!({"role": "neckwear", "garmentId": id}));
    }
    json!({"slots": slots, "footwearAlternatives": ids(&o["footwearAlternatives"]), "reason": o["reason"]})
}

/// `POST /v1/recommendations` (`RecommendResponse`). Composition always finishes inside the request
/// here, so the answer is `completed`. In `preview` mode it is the recommender's options, nothing
/// published. In `board` mode those options are published as the day's home board with
/// `board.publish` (its receipt and undo as any publication), and the answer carries the board.
/// The same request ID answers from the saved run, and in board mode the publication replays from
/// its receipt, so a retransmission never composes or publishes twice.
pub async fn recommendations<S: Store>(store: &mut S, principal: Principal, now_ms: u64, body: &[u8]) -> Result<Value, CmdError> {
    let (input, board_mode) = recommend_request(body)?;
    // A request ID belongs to its caller and its mode, so a preview never answers for a board.
    let connection = format!("{}:{}", if board_mode { "api-board" } else { "api" }, principal.actor);
    let (mut answer, scope) = recommend::recommend_scoped(store, &connection, now_ms, &input).await?;
    if !board_mode {
        return Ok(answer);
    }
    let options: Vec<Value> = answer["options"].as_array().cloned().unwrap_or_default();
    if options.is_empty() {
        // Nothing wearable to publish: no board is made, and the note says why.
        return Ok(answer);
    }
    let requested = input.count.unwrap_or_else(|| recommend::default_count(crate::seed::catalogue()));
    // A day inside a packed trip is published as that trip's day board (the scope the run recorded).
    let mut payload = json!({"localDate": input.date, "requestedCount": requested, "options": options.iter().map(publish_option).collect::<Vec<_>>()});
    if scope != "home" {
        payload["scope"] = json!(scope);
    }
    let envelope = json!({
        "type": "board.publish",
        "payload": payload,
        // The request ID belongs to its caller, as the saved run does: the owner and a connected
        // assistant sending the same ID never meet on one publication.
        "idempotencyKey": format!("board-compose:{}:{}", principal.actor, input.client_request_id),
        "authorization": authorization(principal),
        "source": {"channel": principal.channel},
    });
    let receipt = api::execute(store, principal, now_ms, &envelope).await?;
    let board_id = receipt["result"]["boardId"].as_str().unwrap_or_default().to_string();
    let board = api::board_view(store, &board_id).await?;
    answer["options"] = board["options"].clone();
    answer["wardrobeRevision"] = board["freshness"]["wardrobeRevision"].clone();
    answer["board"] = board;
    Ok(answer)
}

/// The board ID of `POST /v1/boards/{id}/swap`, if the path is one.
pub fn swap_target(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/boards/")?.strip_suffix("/swap")?;
    (!id.is_empty() && id.len() <= 64 && !id.contains('/')).then_some(id)
}

/// `POST /v1/boards/{id}/swap` (`SwapSlotResponse`): `board.swap_slot` under the idempotency key
/// `board-swap:{caller}:{clientRequestId}` (the daily service sends `board-swap:{clientRequestId}`;
/// the caller keeps the owner's and an assistant's request IDs apart), with the board revision the owner
/// was looking at as its expected version, answered with the receipt and the board as it now stands.
/// No forecast is read in this port, so no fresher forecast is fetched first.
pub async fn swap<S: Store>(store: &mut S, principal: Principal, now_ms: u64, board_id: &str, body: &[u8]) -> Result<Value, CmdError> {
    let m = body_object(body)?;
    only_keys(&m, &["clientRequestId", "optionId", "role", "garmentId", "expectedRevision"], "a slot swap")?;
    let client = match m.get("clientRequestId") {
        Some(Value::String(s)) if (8..=128).contains(&s.chars().count()) => s.clone(),
        _ => return Err(invalid("clientRequestId: expected a stable request ID of 8 to 128 characters")),
    };
    let option_id = match m.get("optionId") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err(invalid("optionId: expected an option ID")),
    };
    let role = match m.get("role") {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(invalid("role: expected a slot role")),
    };
    let mut payload = json!({"boardId": board_id, "optionId": option_id, "role": role});
    match m.get("garmentId") {
        None => {}
        Some(Value::String(g)) => payload["garmentId"] = json!(g),
        Some(_) => return Err(invalid("garmentId: expected a garment ID")),
    }
    let mut envelope = json!({
        "type": "board.swap_slot",
        "payload": payload,
        "idempotencyKey": format!("board-swap:{}:{client}", principal.actor),
        "authorization": authorization(principal),
        "source": {"channel": principal.channel},
    });
    match m.get("expectedRevision") {
        None => {}
        Some(v) => match crate::canonical::whole(v) {
            Some(n) if n >= 1 => envelope["expectedVersions"] = json!({format!("board:{board_id}"): n}),
            _ => return Err(invalid("expectedRevision: expected a whole number of at least 1")),
        },
    }
    let receipt = api::execute(store, principal, now_ms, &envelope).await?;
    let board = api::board_view(store, board_id).await?;
    Ok(json!({"board": board, "receipt": receipt}))
}

/// The trip ID of `POST /v1/trips/{id}/packing-proposal`, if the path is one.
pub fn packing_target(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/trips/")?.strip_suffix("/packing-proposal")?;
    (!id.is_empty() && id.len() <= 128 && !id.contains('/')).then_some(id)
}

/// `POST /v1/trips/{id}/packing-proposal` (`PackingProposal`): a proposal for a planned trip from the
/// stock at home (`trips::propose`), kept through `trip.record_packing_proposal` under the idempotency
/// key `packing:{clientRequestId}`, as `proposePacking` sends it. Nothing is packed.
///
/// A request already recorded answers with the proposal it recorded, without planning again (so a
/// retransmission after the stock or the trip changed, or after the trip was cancelled, still gets
/// its answer). A new plan is sent with the ledger revision and the trip version it was planned
/// from as `expectedVersions`, so a plan made from a ledger that has since changed is never
/// recorded: it is planned again, at most three times.
pub async fn propose_packing<S: Store>(store: &mut S, principal: Principal, now_ms: u64, trip_id: &str, body: &[u8]) -> Result<Value, CmdError> {
    let m = body_object(body)?;
    only_keys(&m, &["clientRequestId"], "a packing-proposal request")?;
    let client = match m.get("clientRequestId") {
        Some(Value::String(s)) if (8..=128).contains(&s.chars().count()) => s.clone(),
        _ => return Err(invalid("clientRequestId: expected a stable request ID of 8 to 128 characters")),
    };
    let key = format!("packing:{client}");
    for _ in 0..PLAN_ATTEMPTS {
        if let Some(answer) = recorded_proposal(store, &key, trip_id).await? {
            return Ok(answer);
        }
        let (_, ledger) = api::read_ledger(store).await?;
        let trip = api::load_trip(store, trip_id)
            .await?
            .filter(|t| t.status == "planned")
            .ok_or_else(|| CmdError::with("not_found", format!("no active trip '{trip_id}'"), json!({"tripId": trip_id})))?;
        let payload = crate::trips::propose(crate::seed::catalogue(), &ledger, &trip);
        let mut expected = ferrite_app::serde_json::Map::new();
        expected.insert("wardrobe".into(), json!(ledger.revision));
        expected.insert(format!("trip:{}", trip.trip_id), json!(trip.version));
        let envelope = json!({
            "type": "trip.record_packing_proposal",
            "payload": payload,
            "idempotencyKey": key,
            "expectedVersions": expected,
            "authorization": authorization(principal),
            "source": {"channel": principal.channel},
        });
        match api::execute(store, principal, now_ms, &envelope).await {
            Ok(receipt) => return stored_proposal(store, &trip.trip_id, &receipt["result"]["revision"]).await,
            // The ledger moved since the plan was read, or the same request was recorded meanwhile:
            // look again.
            Err(e) if e.code == "conflict" || e.code == "idempotency_key_reuse" => continue,
            Err(e) => return Err(e),
        }
    }
    Err(CmdError::with(
        "conflict",
        "the wardrobe kept changing while the proposal was planned; nothing was written. Try again",
        json!({"retryable": true}),
    ))
}

/// Plans tried for one packing request before it is refused as a conflict.
const PLAN_ATTEMPTS: usize = 3;

/// The proposal a `packing:` key already recorded, if it did. The key is the caller's request ID for
/// one trip, so a key recorded for another trip or another command is a reuse.
async fn recorded_proposal<S: Store>(store: &mut S, key: &str, trip_id: &str) -> Result<Option<Value>, CmdError> {
    let Some((receipt, payload)) = api::recorded_request(store, key).await? else { return Ok(None) };
    if receipt["type"] != "trip.record_packing_proposal" || payload["tripId"] != trip_id {
        return Err(CmdError::with("idempotency_key_reuse", "this clientRequestId was already used for another request", json!({"commandId": receipt["commandId"]})));
    }
    stored_proposal(store, trip_id, &receipt["result"]["revision"]).await.map(Some)
}

/// The proposal record of `trip_id` at `revision`, exactly as it was recorded.
async fn stored_proposal<S: Store>(store: &mut S, trip_id: &str, revision: &Value) -> Result<Value, CmdError> {
    let unreadable = || CmdError::with("internal", "the recorded packing proposal is unreadable", json!({"retryable": false, "tripId": trip_id}));
    let revision = revision.as_u64().filter(|r| *r >= 1).ok_or_else(unreadable)?;
    let bytes = store
        .get(&crate::trips::proposal_key(trip_id, revision))
        .await
        .map_err(|_| CmdError::with("internal", "the packing proposal could not be read just now; try again", json!({"retryable": true})))?;
    bytes
        .and_then(|b| ferrite_app::serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| crate::trips::proposal_from_json(&v, trip_id, revision))
        .ok_or_else(unreadable)
}

// ─────────────────────────── launch and settings reads ───────────────────────────

/// Pause and resume are not ported, so the service is never paused here (`ServiceState`).
fn service_state() -> Value {
    json!({"paused": false, "pause": null, "returnDeadlinesActive": true})
}

/// `GET /v1/service` (`ServiceState`).
pub fn service() -> Value {
    service_state()
}

/// `GET /v1/me` (`MeResponse`). This port serves one owner, signed in with the owner token, a sign-in
/// of the owner's app (both the owner, with every owner scope) or the assistant token; there are no
/// linked identities and no recovery kit (no identity provider), and it says so.
pub fn me(principal: Principal) -> Value {
    let scopes = if principal == api::OWNER { json!(["read", "write", "admin"]) } else { json!(["read", "write"]) };
    json!({
        "userId": "owner",
        "displayName": "Owner",
        "scopes": scopes,
        "channel": principal.channel,
        "identities": [],
        "recoveryKit": {"present": false, "issuedAt": null},
        "issuedRecoveryKit": null,
    })
}

/// `GET /v1/settings` (`SettingsResponse`): the specification's default settings
/// (`DEFAULT_OWNER_SETTINGS`), version 1, because no settings command is ported to change them.
/// The option count is the one the recommender uses (the owner's imported daily-entry rule, held to
/// the settings' 3 to 5). No profile document or inference overview is served here (`null`).
pub fn settings(now_ms: u64) -> Value {
    let count = recommend::default_count(crate::seed::catalogue()).clamp(3, 5);
    json!({
        "settings": {
            "timezone": "Europe/London",
            "homeLocation": null,
            "delivery": {"morningLocalTime": "07:00", "defaultOptionCount": count},
            "laundry": {
                "service": {"weeklyResetEnabled": true, "collectionWeekday": 5, "collectionLocalTime": "08:00", "returnWeekday": 6, "baselineWeekday": 7},
                "handwash": {"mode": "owner_reported"},
            },
            "variety": {"repeatHorizonDays": 7, "patternHorizonDays": 14},
            "estimator": {"pUseBoard": 0.85, "pFollowSelection": 0.9, "importCleanPrior": 0.8},
            "extensions": {},
        },
        "version": 1,
        "profile": null,
        "inference": null,
        "service": service_state(),
        "apiVersion": "v1",
        "contractVersion": CONTRACT_VERSION,
        "readAt": instant(now_ms),
    })
}

/// `GET /v1/laundry` (`LaundryStateResponse`, as `getLaundryState`): what is in the hamper by care
/// channel, sorted by name, and the newest 12 laundry bags that were not withdrawn, newest first.
/// Laundry exceptions and weekly cycles are not ported, so those lists are empty.
pub async fn laundry<S: Store>(store: &mut S, now_ms: u64) -> Result<Value, CmdError> {
    let (_, ledger) = api::read_ledger(store).await?;
    let cat = crate::seed::catalogue();
    let stock = crate::ledger::replay(cat, &ledger.events);
    let name = |id: &str| cat.get(id).map(|g| g.name.clone()).unwrap_or_else(|| "Unknown garment".to_string());
    let pool = |channel: &str| {
        let mut lines: Vec<(String, String, u32)> = cat.garments.iter().filter(|g| g.care_channel == channel).map(|g| (g.name.clone(), g.id.clone(), stock.of(&g.id).dirty)).filter(|l| l.2 > 0).collect();
        lines.sort();
        lines.into_iter().map(|(n, id, q)| json!({"garmentId": id, "name": n, "quantity": q})).collect::<Vec<_>>()
    };
    let mut bags: Vec<&crate::ledger::Batch> = ledger.batches.iter().filter(|b| b.withdrawn_by.is_none()).collect();
    bags.sort_by(|a, b| b.picked_up_at_ms.cmp(&a.picked_up_at_ms));
    let batches: Vec<Value> = bags
        .into_iter()
        .take(12)
        .map(|b| {
            let mut items: Vec<&crate::ledger::BatchItem> = b.items.iter().collect();
            items.sort_by_key(|i| (name(&i.garment_id), i.garment_id.clone()));
            json!({
                "batchId": b.batch_id,
                "status": b.status,
                "pickedUpAt": instant(b.picked_up_at_ms),
                "returnedAt": b.returned_at_ms.map(instant),
                "returnBasis": null,
                "items": items.iter().map(|i| json!({"garmentId": i.garment_id, "name": name(&i.garment_id), "quantity": i.quantity, "returnedQuantity": i.returned, "stillAway": i.still_away})).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(json!({"awaitingService": pool("service"), "awaitingHandwash": pool("handwash"), "batches": batches, "exceptions": [], "cycles": [], "readAt": instant(now_ms)}))
}
