//! The MCP endpoint (`POST /mcp`), Streamable HTTP in JSON response mode,
//! stateless: every request carries its OAuth access token and nothing is
//! kept between requests, which fits Ferrite's request/reply api routes (no
//! session affinity, and an SSE stream would get no headers).
//!
//! The tools are those of apps/worker/src/mcp/server.ts that the ported
//! commands can back, with the same names, arguments and results:
//!   `garderobe_inventory` views `items`, `snapshot` and `receipts`;
//!   `garderobe_command`   the ported commands, offered only to a grant with
//!                         `wardrobe.write` and refused to any other with the
//!                         OAuth `insufficient_scope` step-up.
//! A connected assistant acts as `assistant` on channel `mcp` with
//! authorization `owner_statement`; the command service refuses it a
//! restriction lift and the undo of a restriction's record.

use ferrite_app::serde_json::{self, json, Map, Value};
use ferrite_app::IngressRequest;

use crate::api::{self, Reply, Store, ASSISTANT, CONTRACT_VERSION};
use crate::ledger::CmdError;
use crate::oauth::{self, Caller};
use crate::time::instant;

/// Protocol revisions this server speaks, newest first.
// 2025-03-26 is not offered: its transport allows JSON-RPC batches, which
// this endpoint refuses (2025-06-18 removed them).
pub const PROTOCOL_VERSIONS: [&str; 2] = ["2025-11-25", "2025-06-18"];

const GUIDE: &str = "Garderobe: the connected owner's private wardrobe. The owner is fixed by this connection; no tool takes an owner or user. \
garderobe_inventory reads the wardrobe (views items, snapshot, receipts); check `complete` and `nextCursor` before saying how many things exist. \
garderobe_command makes one typed change the owner reported or asked for (needs the write permission) and returns its verified receipt; \
send a stable idempotencyKey per intended change, and take a change back with command.undo and the receipt's commandId. \
Lifting a restriction, or undoing the command that recorded one, is refused here. Only send what the owner actually reported or asked for.";

fn header<'a>(req: &'a IngressRequest, name: &str) -> Option<&'a str> {
    req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn rpc_error(status: u16, id: Value, code: i64, message: &str) -> Reply {
    Reply::json(status, json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}))
}

fn rpc_result(id: Value, result: Value) -> Reply {
    Reply::json(200, json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// Answer one request to `/mcp`.
pub async fn handle<S: Store>(store: &mut S, origin: &str, now_ms: u64, req: &IngressRequest) -> Reply {
    // DNS-rebinding defence (MCP transport, security warning): a request
    // that carries an Origin must come from this server's own origin.
    if let Some(o) = header(req, "origin") {
        if o != origin {
            return Reply::json(403, json!({"error": "forbidden_origin", "error_description": "requests from another web origin are refused"}));
        }
    }
    if req.method != "POST" {
        // No server-initiated stream and no session to delete.
        return Reply::json(405, json!({"error": "method_not_allowed", "error_description": "this MCP endpoint answers POST only (stateless, JSON responses)"})).with_header("allow", "POST");
    }
    let caller = match oauth::authenticate(store, oauth::authorization_header(req), now_ms).await {
        Ok(c) => c,
        Err(e) => return oauth::bearer_challenge(origin, &e),
    };
    if let Some(v) = header(req, "mcp-protocol-version") {
        if !PROTOCOL_VERSIONS.contains(&v) {
            return rpc_error(400, Value::Null, -32600, &format!("unsupported MCP-Protocol-Version '{v}'; supported: {}", PROTOCOL_VERSIONS.join(", ")));
        }
    }
    let msg: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return rpc_error(400, Value::Null, -32700, "the body is not JSON"),
    };
    let Some(obj) = msg.as_object() else {
        return rpc_error(400, Value::Null, -32600, "expected one JSON-RPC message (batches are not supported)");
    };
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return rpc_error(400, Value::Null, -32600, "jsonrpc must be \"2.0\"");
    }
    let id = obj.get("id").cloned();
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        // A response to a server request; this server sends none.
        return Reply::empty(202);
    };
    let Some(id) = id else {
        // A notification (initialized, cancelled, ...): accepted, nothing to answer.
        return Reply::empty(202);
    };
    if !(id.is_string() || id.is_i64() || id.is_u64()) {
        return rpc_error(400, Value::Null, -32600, "id must be a string or an integer");
    }
    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));
    match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSIONS[0] };
            rpc_result(id, json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": "garderobe", "title": "Garderobe", "version": CONTRACT_VERSION},
                "instructions": GUIDE,
            }))
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({"tools": tools(&caller)})),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else { return rpc_error(200, id, -32602, "params.name is required") };
            let args = match params.get("arguments") {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(m)) => m.clone(),
                Some(_) => return rpc_error(200, id, -32602, "params.arguments must be an object"),
            };
            match name {
                "garderobe_inventory" => rpc_result(id, inventory(store, now_ms, &args).await),
                "garderobe_command" if !caller.can_write() => oauth::insufficient_scope(origin),
                "garderobe_command" => rpc_result(id, command(store, now_ms, &args).await),
                _ => rpc_error(200, id, -32602, &format!("unknown tool '{name}'")),
            }
        }
        _ => rpc_error(200, id, -32601, &format!("method '{method}' is not available on this server")),
    }
}

/// The tool list for this connection: a read-only grant is not offered the write tool.
pub fn tools(caller: &Caller) -> Vec<Value> {
    let mut list = vec![json!({
        "name": "garderobe_inventory",
        "title": "Read the wardrobe",
        "description": "Read the owner's garments with their clean and dirty balances (view items, paged; or snapshot, complete), or the newest command receipts (view receipts). `complete` and `nextCursor` say whether the data is the whole result.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "view": {"type": "string", "enum": ["items", "snapshot", "receipts"], "default": "items"},
                "category": {"type": "string", "description": "items, snapshot: only this category"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 500, "description": "items: page size (default 50); receipts: how many (default 50, at most 200)"},
                "cursor": {"type": "string", "description": "items: the nextCursor of the previous page"}
            }
        },
        "annotations": {"title": "Read the wardrobe", "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false},
    })];
    if caller.can_write() {
        list.push(json!({
            "name": "garderobe_command",
            "title": "Change the wardrobe",
            "description": "One typed change the owner reported or asked for, applied at once with a verified receipt and an undo: care.mark_dirty (payload {items: [{garmentId, quantity?}]}, the owner's wash report) and command.undo (payload {commandId}). Repeating the same idempotencyKey never repeats the change. Lifting a restriction, or undoing the command that recorded one, is refused.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["type", "payload", "idempotencyKey"],
                "properties": {
                    "type": {"type": "string", "minLength": 1, "maxLength": 64},
                    "payload": {"type": "object"},
                    "idempotencyKey": {"type": "string", "minLength": 8, "maxLength": 200},
                    "expectedVersions": {"type": "object", "additionalProperties": {"type": "integer", "minimum": 0}},
                    "occurredAt": {"type": "string", "description": "UTC instant, e.g. 2026-10-12T09:00:00.000Z"}
                }
            },
            "annotations": {"title": "Change the wardrobe", "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false},
        }));
    }
    list
}

fn tool_ok(structured: Value, summary: String) -> Value {
    json!({"content": [{"type": "text", "text": summary}], "structuredContent": structured})
}

/// A refused or failed call: a tool error carrying the HTTP API's error body.
fn tool_error(e: CmdError) -> Value {
    let body = json!({"error": {"code": e.code, "message": e.message, "details": e.details}});
    json!({"isError": true, "content": [{"type": "text", "text": body.to_string()}]})
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("invalid_command", message)
}

fn only_keys(args: &Map<String, Value>, allowed: &[&str]) -> Result<(), CmdError> {
    match args.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(invalid(format!("'{k}' is not an argument this server takes for this tool"))),
        None => Ok(()),
    }
}

async fn inventory<S: Store>(store: &mut S, now_ms: u64, args: &Map<String, Value>) -> Value {
    match inventory_inner(store, now_ms, args).await {
        Ok(v) => v,
        Err(e) => tool_error(e),
    }
}

async fn inventory_inner<S: Store>(store: &mut S, now_ms: u64, args: &Map<String, Value>) -> Result<Value, CmdError> {
    only_keys(args, &["view", "category", "limit", "cursor"])?;
    let view = match args.get("view") {
        None => "items",
        Some(Value::String(v)) if ["items", "snapshot", "receipts"].contains(&v.as_str()) => v.as_str(),
        Some(Value::String(v)) => return Err(invalid(format!("view '{v}' is not available on this server yet; the views are items, snapshot and receipts"))),
        Some(_) => return Err(invalid("view must be a string")),
    };
    let category = match args.get("category") {
        None => None,
        Some(Value::String(c)) => Some(c.as_str()),
        Some(_) => return Err(invalid("category must be a string")),
    };
    let limit = match args.get("limit") {
        None => None,
        Some(v) => match v.as_u64() {
            Some(n) if (1..=500).contains(&n) => Some(n as usize),
            _ => return Err(invalid("limit must be a whole number from 1 to 500")),
        },
    };
    let envelope = |data: Value, complete: bool, total: Option<usize>, next: Option<String>, revision: &Value| {
        json!({"view": view, "complete": complete, "total": total, "nextCursor": next, "wardrobeRevision": revision, "readAt": instant(now_ms), "data": data})
    };
    match view {
        "receipts" => {
            if category.is_some() || args.contains_key("cursor") {
                return Err(invalid("view 'receipts' takes only limit"));
            }
            let limit = limit.unwrap_or(50).min(200);
            let (receipts, more, revision) = api::receipts_page(store, limit).await?;
            let n = receipts.len();
            let summary = if more { format!("The newest {n} receipt(s); older ones exist and are not shown.") } else { format!("{n} receipt(s), newest first.") };
            Ok(tool_ok(envelope(json!({"receipts": receipts}), !more, if more { None } else { Some(n) }, None, &json!(revision)), summary))
        }
        _ => {
            let mut page = api::read_wardrobe(store, now_ms, category).await?;
            let revision = page["wardrobeRevision"].clone();
            let items = page["items"].as_array().cloned().unwrap_or_default();
            let total = items.len();
            let (slice, complete, next) = if view == "snapshot" {
                if limit.is_some() || args.contains_key("cursor") {
                    return Err(invalid("view 'snapshot' is always complete; it takes no limit or cursor"));
                }
                (items, true, None)
            } else {
                let start = match args.get("cursor") {
                    None => 0,
                    Some(Value::String(c)) => match c.parse::<usize>() {
                        Ok(n) if n <= total && c == &n.to_string() => n,
                        _ => return Err(invalid("cursor is not one this server returned")),
                    },
                    Some(_) => return Err(invalid("cursor must be a string")),
                };
                let end = (start + limit.unwrap_or(50)).min(total);
                // `complete` says whether this response alone is the whole result.
                let next = (end < total).then(|| end.to_string());
                (items[start..end].to_vec(), start == 0 && end == total, next)
            };
            let shown = slice.len();
            page["items"] = Value::Array(slice);
            let counts = page["counts"].clone();
            let paging = if complete { " (complete)".to_string() } else if let Some(n) = &next { format!(" (more pages: pass nextCursor {n})") } else { " (last page: nothing follows; this page alone is not the whole result)".to_string() };
            let summary = format!("{shown} of {total} item(s){paging}; {} garments, {} owned units in the wardrobe.", counts["garments"], counts["ownedUnits"]);
            let next_out = next.clone();
            Ok(tool_ok(envelope(page, complete, Some(total), next_out, &revision), summary))
        }
    }
}

async fn command<S: Store>(store: &mut S, now_ms: u64, args: &Map<String, Value>) -> Value {
    if let Err(e) = only_keys(args, &["type", "payload", "idempotencyKey", "expectedVersions", "occurredAt"]) {
        return tool_error(e);
    }
    // The same envelope the HTTP API takes, as the connected assistant relaying the owner's words.
    let mut envelope = Map::new();
    for key in ["type", "payload", "idempotencyKey", "expectedVersions", "occurredAt"] {
        if let Some(v) = args.get(key) {
            envelope.insert(key.to_string(), v.clone());
        }
    }
    envelope.insert("authorization".into(), json!("owner_statement"));
    envelope.insert("source".into(), json!({"channel": "mcp"}));
    match api::execute(store, ASSISTANT, now_ms, &Value::Object(envelope)).await {
        Ok(receipt) => {
            let line = format!(
                "{}: {} (command {})",
                if receipt["replayed"] == json!(true) { "Already recorded" } else { "Recorded" },
                receipt["summary"].as_str().unwrap_or(""),
                receipt["commandId"].as_str().unwrap_or("")
            );
            tool_ok(json!({"receipt": receipt}), line)
        }
        Err(e) => tool_error(e),
    }
}
