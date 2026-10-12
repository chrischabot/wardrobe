//! `GET /v1/command-types` (`CommandTypeList`, as `describeCommandTypes` in
//! apps/worker/src/routes/core.ts): every command type this port executes, with its class, required
//! scope, allowed authorizations, whether a connected assistant's command of that type waits for the
//! owner (`consequential`), and its payload JSON Schema.
//!
//! The TypeScript registry's description is `seed/command-types.json`, written by
//! `scripts/build-command-types.mjs`. It is narrowed here to what this port does, from the same
//! constants the port's handlers use, so the list cannot claim more than the port accepts:
//!   * the payload schema keeps only the fields the handler accepts, and says so with
//!     `additionalProperties: false` (the handler refuses any other field by name);
//!   * the authorizations are those the command service accepts ([`api::ACCEPTED_AUTHORIZATIONS`]);
//!   * `consequential` is the port's own connected-assistant rule ([`api::connected_refusal`]).

use std::sync::OnceLock;

use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::{self, CONTRACT_VERSION};
use crate::ledger::{self, CmdError};
use crate::{board, laundry, wear};

const GENERATED: &str = include_str!("seed/command-types.json");

/// The payload fields the port's handler for `kind` accepts.
pub fn accepted_fields(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "care.mark_dirty" => ledger::MARK_DIRTY_FIELDS,
        "care.washed" => ledger::WASHED_FIELDS,
        "command.undo" => ledger::UNDO_FIELDS,
        "board.publish" => board::PUBLISH_FIELDS,
        "board.select" => board::SELECT_FIELDS,
        "board.swap_slot" => board::SWAP_FIELDS,
        "laundry.collect" => laundry::COLLECT_FIELDS,
        "laundry.return" => laundry::RETURN_FIELDS,
        "wear.record" => wear::RECORD_FIELDS,
        _ => return None,
    })
}

/// The TypeScript schema with only the fields the handler accepts.
fn narrowed(schema: &Value, fields: &[&str]) -> Value {
    let mut out = schema.clone();
    if let Some(obj) = out.as_object_mut() {
        if let Some(Value::Object(props)) = obj.get_mut("properties") {
            props.retain(|k, _| fields.contains(&k.as_str()));
        }
        if let Some(Value::Array(required)) = obj.get_mut("required") {
            required.retain(|k| k.as_str().map_or(false, |k| fields.contains(&k)));
        }
        obj.insert("additionalProperties".into(), Value::Bool(false));
    }
    out
}

fn describe() -> Result<Value, String> {
    let file: Value = serde_json::from_str(GENERATED).map_err(|e| format!("seed/command-types.json is not JSON: {e}"))?;
    let generated = file.get("types").and_then(Value::as_array).ok_or("seed/command-types.json has no types")?;
    let mut kinds: Vec<&str> = ledger::COMMAND_TYPES.to_vec();
    kinds.sort_unstable();
    let mut types = Vec::with_capacity(kinds.len());
    for kind in kinds {
        let entry = generated.iter().find(|t| t["type"] == kind).ok_or_else(|| format!("seed/command-types.json does not describe {kind}"))?;
        let fields = accepted_fields(kind).ok_or_else(|| format!("no accepted payload fields are named for {kind}"))?;
        let authorizations: Vec<&str> = entry["authorizations"]
            .as_array()
            .ok_or_else(|| format!("seed/command-types.json has no authorizations for {kind}"))?
            .iter()
            .filter_map(Value::as_str)
            .filter(|a| api::ACCEPTED_AUTHORIZATIONS.contains(a))
            .collect();
        let mut t = Map::new();
        t.insert("type".into(), json!(kind));
        t.insert("class".into(), entry["class"].clone());
        t.insert("requiredScope".into(), entry["requiredScope"].clone());
        t.insert("authorizations".into(), json!(authorizations));
        t.insert("consequential".into(), json!(api::connected_refusal(kind, None).is_some()));
        t.insert("payloadSchema".into(), narrowed(&entry["payloadSchema"], fields));
        types.push(Value::Object(t));
    }
    Ok(json!({"types": types, "contractVersion": CONTRACT_VERSION}))
}

/// `GET /v1/command-types`, for the owner and a connected assistant alike (the TypeScript route needs
/// only the `read` scope, and the MCP resource publishes the same list).
pub fn list() -> Result<Value, CmdError> {
    static LIST: OnceLock<Result<Value, String>> = OnceLock::new();
    LIST.get_or_init(describe).clone().map_err(|e| CmdError::with("internal", format!("the command types cannot be described: {e}"), json!({"retryable": false})))
}
