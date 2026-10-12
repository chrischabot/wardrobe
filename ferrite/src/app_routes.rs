//! App routes the iOS client calls on its Today screen and at launch, built on the commands and the
//! recommender the port already has (apps/worker/src/routes/core.ts and routes/daily.ts):
//!
//! * `GET /v1/meta`: versions, mounted modules, server time and the MCP endpoint;
//! * `POST /v1/commands/batch`: the phone's offline replay, each command independent;
//! * `POST /v1/recommendations`: options in `preview` mode, or a published board in `board` mode;
//! * `POST /v1/boards/{id}/swap`: one slot of one option, through `board.swap_slot`.
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
    for command in commands {
        let key = command.get("idempotencyKey").and_then(Value::as_str).unwrap_or("").to_string();
        let outcome = if command.is_object() { api::execute(store, principal, now_ms, command).await } else { Err(invalid("the command envelope is invalid: expected a JSON object")) };
        results.push(match outcome {
            Ok(receipt) => json!({"status": "receipt", "idempotencyKey": key, "receipt": receipt}),
            Err(e) => json!({"status": "error", "idempotencyKey": key, "error": {"code": e.code, "message": e.message, "details": e.details}, "retryable": retryable(e.code)}),
        });
    }
    let (_, ledger) = api::read_ledger(store).await?;
    Ok(json!({"results": results, "wardrobeRevision": ledger.revision}))
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
    let mut answer = recommend::recommend(store, &connection, now_ms, &input).await?;
    if !board_mode {
        return Ok(answer);
    }
    let options: Vec<Value> = answer["options"].as_array().cloned().unwrap_or_default();
    if options.is_empty() {
        // Nothing wearable to publish: no board is made, and the note says why.
        return Ok(answer);
    }
    let requested = input.count.unwrap_or_else(|| recommend::default_count(crate::seed::catalogue()));
    let envelope = json!({
        "type": "board.publish",
        "payload": {"localDate": input.date, "requestedCount": requested, "options": options.iter().map(publish_option).collect::<Vec<_>>()},
        "idempotencyKey": format!("board-compose:{}", input.client_request_id),
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
/// `board-swap:{clientRequestId}` (as the daily service sends it), with the board revision the owner
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
        "idempotencyKey": format!("board-swap:{client}"),
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
