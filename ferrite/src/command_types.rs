//! `GET /v1/command-types` (`CommandTypeList`, as `describeCommandTypes` in
//! apps/worker/src/routes/core.ts): every command type this port executes, with its class, required
//! scope, allowed authorizations, whether a connected assistant's command of that type waits for the
//! owner (`consequential`), and its payload JSON Schema.
//!
//! The TypeScript registry's description is `seed/command-types.json`, written by
//! `scripts/build-command-types.mjs`. It is narrowed here to what this port does, from the same
//! constants the port's handlers use, so the list cannot claim more than the port accepts:
//!   * the payload schema keeps only the fields the handler accepts, and says so with
//!     `additionalProperties: false` (the handler refuses any other field by name); a field whose
//!     every non-default value the port refuses is narrowed to the value it accepts
//!     ([`NARROWED`]), and a field it accepts no value for is left out;
//!   * the authorizations are those the command service accepts ([`api::ACCEPTED_AUTHORIZATIONS`]);
//!   * `consequential` is the port's own connected-assistant rule ([`api::connected_refusal`]).

use std::sync::OnceLock;

use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::{self, CONTRACT_VERSION};
use crate::ledger::{self, CmdError};
use crate::{board, feedback, laundry, packing, returns, trips, wear};

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
        "feedback.record" => feedback::RECORD_FIELDS,
        "feedback.retract" => feedback::RETRACT_FIELDS,
        "laundry.collect" => laundry::COLLECT_FIELDS,
        "laundry.return" => laundry::RETURN_FIELDS,
        "return.open_case" => returns::OPEN_FIELDS,
        "return.update_case" => returns::UPDATE_FIELDS,
        "stock.pack" => packing::PACK_FIELDS,
        "stock.unpack" => packing::UNPACK_FIELDS,
        "trip.create" => trips::CREATE_FIELDS,
        "trip.update" => trips::UPDATE_FIELDS,
        "trip.cancel" => trips::CANCEL_FIELDS,
        "trip.record_packing_proposal" => trips::PROPOSAL_FIELDS,
        "wear.record" => wear::RECORD_FIELDS,
        _ => return None,
    })
}

/// Fields the TypeScript schema allows values for that this port categorically refuses, with the schema
/// of what it does accept (`None`: no value is accepted, so the field is not published). Bounds (list
/// lengths, text lengths) are not restated here; the handler names them when it refuses.
fn narrowed_field(kind: &str, field: &str) -> Option<Option<Value>> {
    let null_only = || Some(json!({"type": "null", "default": null}));
    match (kind, field) {
        // board.rs `publish_input`: the home board or a trip's day board (no evening boards), the default
        // day brief, and no snapshot (weather and Calendar are not read, so a named snapshot is never found).
        ("board.publish", "scope") => Some(Some(json!({
            "type": "string", "default": "home",
            "anyOf": [{"const": "home"}, {"pattern": "^trip:[^:]+$", "maxLength": 5 + crate::packing::MAX_TRIP_ID}],
        }))),
        ("board.publish", "brief") => Some(Some(json!({
            "type": "object",
            "properties": {
                "text": {"const": null}, "requestedCount": {"const": null}, "include": {"const": []}, "exclude": {"const": []},
                "occasionOnly": {"const": false}, "allowRepeat": {"const": false}, "segment": {"const": "day"},
            },
            "additionalProperties": false,
        }))),
        ("board.publish", "weatherSnapshotId" | "calendarSnapshotId") => Some(null_only()),
        // board.rs `swap`: a weather snapshot ID is never found, and nothing else is accepted for it.
        ("board.swap_slot", "weatherSnapshotId") => Some(None),
        // returns.rs `parse_open`: orders are not ported, so a case names a garment and no order line;
        // a deadline is computed only in the owner's timezone or UTC (no timezone database).
        ("return.open_case", "orderId" | "lineId") => Some(null_only()),
        ("return.open_case", "garmentId") => Some(Some(json!({"type": "string", "minLength": 1, "maxLength": 64}))),
        ("return.open_case", "timezone") => Some(Some(json!({"type": "string", "enum": returns::TIMEZONES}))),
        _ => None,
    }
}

/// The TypeScript schema with only the fields the handler accepts, each as the port accepts it.
fn narrowed(kind: &str, schema: &Value, fields: &[&str]) -> Value {
    let mut out = schema.clone();
    if let Some(obj) = out.as_object_mut() {
        if let Some(Value::Object(props)) = obj.get_mut("properties") {
            props.retain(|k, _| fields.contains(&k.as_str()) && narrowed_field(kind, k) != Some(None));
            for (k, v) in props.iter_mut() {
                if let Some(Some(accepted)) = narrowed_field(kind, k) {
                    *v = accepted;
                }
            }
        }
        let published: Vec<String> = obj.get("properties").and_then(Value::as_object).map(|p| p.keys().cloned().collect()).unwrap_or_default();
        if let Some(Value::Array(required)) = obj.get_mut("required") {
            required.retain(|k| k.as_str().map_or(false, |k| published.iter().any(|p| p == k)));
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
        t.insert("payloadSchema".into(), narrowed(kind, &entry["payloadSchema"], fields));
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
