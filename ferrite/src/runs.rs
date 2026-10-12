//! Saved runs: `garderobe_run` and `GET /v1/runs/{id}` (apps/worker/src/runs.ts, the `api`
//! provider). A run is the durable record of a long operation, kept at `u/<runId>`.
//!
//! The only runs this server writes are recommendation runs (`crate::recommend`), and they finish
//! inside their request, so every run is a completed recommendation. A stored record is returned only
//! when it is exactly the record `recommend` writes (the same fields, none missing and none extra,
//! each of its type, its two times and the answer's read time one instant as written, and the answer
//! checked by `recommend::stored_answer_ok`); anything else is refused as damaged, never returned as
//! a run. A run of another kind gets its own exact check when the code that writes it is ported (ask
//! and research next).
//!
//! Every run belongs to the one owner, so any of the owner's connections may read it, as in the
//! TypeScript build (runs are scoped to the user, not to a connection). Actions:
//!   `status`  the run as the contract's `Run`;
//!   `cancel`  answers the finished run unchanged with nothing stopped (committed changes stay
//!             committed); no run here is ever unfinished, so there is nothing to stop;
//!   `resume`  refused: nothing here runs in the background, so an interrupted request is sent again;
//!   `respond` refused: no run here waits for the owner's answer.

use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::Store;
use crate::ledger::CmdError;
use crate::time::parse_instant;

/// The storage key of a run.
pub fn run_key(run_id: &str) -> Vec<u8> {
    format!("u/{run_id}").into_bytes()
}

/// Whether `id` is a run ID this server issues (`run_` and 24 lowercase hex digits). Anything else
/// is not looked up at all.
pub fn valid_run_id(id: &str) -> bool {
    id.strip_prefix("run_").map_or(false, |h| h.len() == 24 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn not_found() -> CmdError {
    CmdError::new("not_found", "that run was not found")
}

fn damaged() -> CmdError {
    CmdError::with("internal", "the stored run is unreadable; nothing was changed", json!({"retryable": false}))
}

/// The fields of a recommendation run record, exactly as `recommend` writes it.
const RECORD_FIELDS: [&str; 16] = [
    "v", "runId", "kind", "state", "createdAt", "updatedAt", "activity", "lastEventId", "pendingInput", "receipts", "proposals",
    "connection", "clientRequestId", "requestHash", "result", "error",
];

fn is_hex64(v: &Value) -> bool {
    v.as_str().map_or(false, |s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// The stored run as the contract's `Run`, after checking that it is exactly a recommendation run
/// record. The connection, request ID and request hash are never returned.
pub fn project(run: &Value) -> Result<Value, CmdError> {
    let Some(m) = run.as_object() else { return Err(damaged()) };
    let whole = m.len() == RECORD_FIELDS.len()
        && RECORD_FIELDS.iter().all(|k| m.contains_key(*k))
        && run["v"] == 1
        && run["runId"].as_str().map_or(false, valid_run_id)
        && run["kind"] == "recommendation"
        && run["state"] == "completed"
        && run["createdAt"].as_str().map_or(false, |t| parse_instant(t).is_some())
        // `recommend` writes the run's two times and the answer's read time from one instant.
        && run["updatedAt"] == run["createdAt"]
        && run["result"]["readAt"] == run["createdAt"]
        && run["activity"].is_null()
        && run["lastEventId"] == 2
        && run["pendingInput"].is_null()
        && run["receipts"] == json!([])
        && run["proposals"] == json!([])
        && run["connection"].as_str().map_or(false, |c| !c.is_empty())
        && run["clientRequestId"].as_str().map_or(false, |c| (8..=128).contains(&c.chars().count()))
        && is_hex64(&run["requestHash"])
        && run["error"].is_null()
        && crate::recommend::stored_answer_ok(&run["result"]);
    if !whole {
        return Err(damaged());
    }
    Ok(json!({
        "runId": run["runId"], "kind": "recommendation", "state": "completed", "createdAt": run["createdAt"], "updatedAt": run["updatedAt"],
        "activity": null, "lastEventId": 2, "pendingInput": null, "receipts": [], "proposals": [],
        "result": {"reply": null, "options": run["result"]["options"], "board": null, "research": null, "exportId": null, "importId": null},
        "error": null,
    }))
}

/// `McpRunInput`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInput {
    pub run_id: String,
    pub action: String,
    pub input_id: Option<String>,
    pub choice_id: Option<String>,
    pub text: Option<String>,
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("invalid_command", message)
}

pub fn parse_input(args: &Map<String, Value>) -> Result<RunInput, CmdError> {
    if let Some(k) = args.keys().find(|k| !["runId", "action", "inputId", "choiceId", "text"].contains(&k.as_str())) {
        return Err(invalid(format!("'{k}' is not an argument this server takes for this tool")));
    }
    let text_arg = |k: &str| -> Result<Option<String>, CmdError> {
        match args.get(k) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(invalid(format!("{k} must be a string"))),
        }
    };
    let run_id = text_arg("runId")?.ok_or_else(|| invalid("runId is required"))?;
    let action = text_arg("action")?.unwrap_or_else(|| "status".into());
    if !["status", "respond", "cancel", "resume"].contains(&action.as_str()) {
        return Err(invalid("action must be status, respond, cancel or resume"));
    }
    let text = text_arg("text")?;
    if text.as_ref().map_or(false, |t| t.encode_utf16().count() > 4000) {
        return Err(invalid("text: at most 4000 characters"));
    }
    Ok(RunInput { run_id, action, input_id: text_arg("inputId")?, choice_id: text_arg("choiceId")?, text })
}

/// Read a run (`GET /v1/runs/{id}`, action `status`).
pub async fn get<S: Store>(store: &mut S, run_id: &str) -> Result<Value, CmdError> {
    if !valid_run_id(run_id) {
        return Err(not_found());
    }
    let bytes = store
        .get(&run_key(run_id))
        .await
        .map_err(|_| CmdError::with("internal", "the run could not be read just now; try again", json!({"retryable": true})))?
        .ok_or_else(not_found)?;
    let run: Value = serde_json::from_slice(&bytes).map_err(|_| damaged())?;
    if run["runId"] != run_id {
        return Err(damaged());
    }
    project(&run)
}

/// Cancel what remains of a run (`POST /v1/runs/{id}/cancel`): `{run, stopped}`. Every run here has
/// finished, so it is answered unchanged with nothing stopped, and nothing is written.
pub async fn cancel<S: Store>(store: &mut S, run_id: &str) -> Result<Value, CmdError> {
    Ok(json!({"run": get(store, run_id).await?, "stopped": []}))
}

/// `garderobe_run`: `McpRunOutput` (`{run, stopped}`).
pub async fn act<S: Store>(store: &mut S, input: &RunInput) -> Result<Value, CmdError> {
    match input.action.as_str() {
        "cancel" => cancel(store, &input.run_id).await,
        "resume" => {
            get(store, &input.run_id).await?;
            Err(CmdError::new("precondition_failed", "this run cannot be resumed; start it again"))
        }
        "respond" => {
            if input.input_id.as_deref().map_or(true, str::is_empty) {
                return Err(invalid("action 'respond' needs inputId"));
            }
            // Read first, so an unknown run says so.
            get(store, &input.run_id).await?;
            Err(CmdError::new("precondition_failed", "this run is not waiting for input"))
        }
        _ => Ok(json!({"run": get(store, &input.run_id).await?, "stopped": []})),
    }
}

/// The tool's one-line summary (apps/worker/src/mcp/server.ts).
pub fn summary(input: &RunInput, out: &Value) -> String {
    let state = out["run"]["state"].as_str().unwrap_or("");
    if input.action == "cancel" {
        let stopped: Vec<&str> = out["stopped"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        return format!("Run {} is {state}. {}", input.run_id, stopped.join(" ")).trim_end().to_string();
    }
    format!("Run {} is {state}", input.run_id)
}
