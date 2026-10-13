//! Saved runs: `garderobe_run` and `GET /v1/runs/{id}` (apps/worker/src/runs.ts, the `api`
//! provider). A run is the durable record of a long operation, kept at `u/<runId>`.
//!
//! The runs this server writes finish inside their request: recommendation runs (`crate::recommend`),
//! and conversation turns and research runs (`crate::assistant`). A conversation turn or research run
//! is claimed (a `running` record with a lease) before its model call and replaced by the completed
//! record when the answer is saved. A stored record is returned only when it is exactly the record
//! its writer writes (the same fields, none missing and none extra, each of its type, its two times
//! and the result's read time one instant as written, and the result checked by that writer's own
//! validator: `recommend::stored_answer_ok`, `assistant::stored_turn_ok`,
//! `assistant::stored_research_ok`; a claim checked by `assistant::claim_ok`); anything else is
//! refused as damaged, never returned as a run.
//!
//! Every run belongs to the one owner, so any of the owner's connections may read it, as in the
//! TypeScript build (runs are scoped to the user, not to a connection). Actions:
//!   `status`  the run as the contract's `Run`;
//!   `cancel`  answers the run as it stands with nothing stopped (committed changes stay committed;
//!             a model call already sent cannot be withdrawn);
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

/// The fields of a run record, exactly as `recommend` and `assistant` write it.
const RECORD_FIELDS: [&str; 16] = [
    "v", "runId", "kind", "state", "createdAt", "updatedAt", "activity", "lastEventId", "pendingInput", "receipts", "proposals",
    "connection", "clientRequestId", "requestHash", "result", "error",
];

pub(crate) fn is_hex64(v: &Value) -> bool {
    v.as_str().map_or(false, |s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// The stored run as the contract's `Run`, after checking that it is exactly a run record of one of
/// the kinds this server writes, or exactly a claim (`assistant::claim_ok`): a claim is a run whose
/// model call is under way while its lease holds at `now_ms`, and a failed run once the lease has run
/// out or the call failed. The connection, request ID and request hash are never returned.
pub fn project(run: &Value, now_ms: u64) -> Result<Value, CmdError> {
    let Some(m) = run.as_object() else { return Err(damaged()) };
    if run["state"] == "running" {
        if !crate::assistant::claim_ok(run) {
            return Err(damaged());
        }
        let live = now_ms < run["claimedUntil"].as_u64().unwrap_or(0);
        let error = if live { Value::Null } else { json!({"code": "interrupted", "message": "the model call did not finish and nothing was saved; send the request again with the same ID", "resumable": false}) };
        return Ok(json!({
            "runId": run["runId"], "kind": run["kind"], "state": if live { "running" } else { "failed" }, "createdAt": run["createdAt"], "updatedAt": run["createdAt"],
            "activity": if live { json!("Waiting for the model") } else { Value::Null }, "lastEventId": 1, "pendingInput": null, "receipts": [], "proposals": [],
            "result": null, "error": error,
        }));
    }
    let kind = run["kind"].as_str().unwrap_or("");
    let result = &run["result"];
    let result_ok = match kind {
        "recommendation" => crate::recommend::stored_answer_ok(result),
        "conversation_turn" => crate::assistant::stored_turn_ok(result),
        "research" => crate::assistant::stored_research_ok(result),
        _ => false,
    };
    let whole = m.len() == RECORD_FIELDS.len()
        && RECORD_FIELDS.iter().all(|k| m.contains_key(*k))
        && run["v"] == 1
        && run["runId"].as_str().map_or(false, valid_run_id)
        && run["state"] == "completed"
        && run["createdAt"].as_str().map_or(false, |t| parse_instant(t).is_some())
        // Every writer sets the run's two times and the result's read time from one instant.
        && run["updatedAt"] == run["createdAt"]
        && result["readAt"] == run["createdAt"]
        && run["activity"].is_null()
        && run["lastEventId"] == 2
        && run["pendingInput"].is_null()
        && run["receipts"] == json!([])
        && run["proposals"] == json!([])
        && run["connection"].as_str().map_or(false, |c| !c.is_empty())
        && run["clientRequestId"].as_str().map_or(false, |c| (8..=128).contains(&c.chars().count()))
        && is_hex64(&run["requestHash"])
        && run["error"].is_null()
        && result_ok;
    if !whole {
        return Err(damaged());
    }
    let (reply, options, research) = match kind {
        "recommendation" => (Value::Null, result["options"].clone(), Value::Null),
        // There is no transcript here, so the reply's message is named by its run.
        "conversation_turn" => (json!({"messageId": run["runId"], "text": result["answer"]}), json!([]), Value::Null),
        _ => (Value::Null, json!([]), result["research"].clone()),
    };
    Ok(json!({
        "runId": run["runId"], "kind": kind, "state": "completed", "createdAt": run["createdAt"], "updatedAt": run["updatedAt"],
        "activity": null, "lastEventId": 2, "pendingInput": null, "receipts": [], "proposals": [],
        "result": {"reply": reply, "options": options, "board": null, "research": research, "exportId": null, "importId": null},
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
pub async fn get<S: Store>(store: &mut S, run_id: &str, now_ms: u64) -> Result<Value, CmdError> {
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
    project(&run, now_ms)
}

/// Cancel what remains of a run (`POST /v1/runs/{id}/cancel`): `{run, stopped}`. A finished run is
/// answered unchanged with nothing stopped, and nothing is written. A model call under way is not
/// stopped either (an egress call cannot be withdrawn once sent), so it too is answered as it stands.
pub async fn cancel<S: Store>(store: &mut S, run_id: &str, now_ms: u64) -> Result<Value, CmdError> {
    Ok(json!({"run": get(store, run_id, now_ms).await?, "stopped": []}))
}

/// `garderobe_run`: `McpRunOutput` (`{run, stopped}`).
pub async fn act<S: Store>(store: &mut S, input: &RunInput, now_ms: u64) -> Result<Value, CmdError> {
    match input.action.as_str() {
        "cancel" => cancel(store, &input.run_id, now_ms).await,
        "resume" => {
            get(store, &input.run_id, now_ms).await?;
            Err(CmdError::new("precondition_failed", "this run cannot be resumed; start it again"))
        }
        "respond" => {
            if input.input_id.as_deref().map_or(true, str::is_empty) {
                return Err(invalid("action 'respond' needs inputId"));
            }
            // Read first, so an unknown run says so.
            get(store, &input.run_id, now_ms).await?;
            Err(CmdError::new("precondition_failed", "this run is not waiting for input"))
        }
        _ => Ok(json!({"run": get(store, &input.run_id, now_ms).await?, "stopped": []})),
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
