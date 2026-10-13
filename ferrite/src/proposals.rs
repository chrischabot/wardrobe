//! The owner's proposals, `GET /v1/proposals` (`ProposalList`) and `POST /v1/proposals/{id}/decision`
//! (`ProposalDecisionRequest` → `ProposalDecisionResponse`), ported from apps/worker/src/routes/proposals.ts
//! and proposals/service.ts.
//!
//! Authority, as in TypeScript (`assertOwnerInApp`): only the signed-in owner on an app channel lists,
//! confirms or rejects a proposal. A connected assistant is refused (`forbidden`,
//! `owner_in_app_required`), so it can never confirm what it proposed; there is no MCP tool for either.
//!
//! What this port holds: no proposals. TypeScript keeps one when the assistant workstream could not make a
//! change on a conversation turn (conversation is not ported) or when a connected assistant sends a typed
//! command its policy reserves for the owner (`connectedDisposition` "owner": erasure, authorization towards
//! another party, what a model or outside connection may reach, rewriting the profile). None of the commands
//! this port executes is of that kind, and a read-only connection calling `garderobe_command` is refused with
//! an OAuth step-up in both builds, so nothing here ever creates one. The list is therefore always empty
//! and every decision names a proposal that does not exist (`not_found`), after the request itself has been
//! checked as TypeScript checks it.

use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::{Principal, OWNER};
use crate::ledger::CmdError;
use crate::time::instant;

/// The proposal a decision path names: `/v1/proposals/<proposalId>/decision`.
pub fn decision_target(path: &str) -> Option<&str> {
    path.strip_prefix("/v1/proposals/")?.strip_suffix("/decision").filter(|id| !id.is_empty() && !id.contains('/'))
}

/// `assertOwnerInApp`: only the owner, signed in on the app, decides or lists proposals.
pub fn owner_in_app(principal: Principal) -> Result<(), CmdError> {
    if principal == OWNER {
        Ok(())
    } else {
        Err(CmdError::with("forbidden", "a proposal is confirmed or rejected by the owner in the Garderobe app", json!({"reason": "owner_in_app_required"})))
    }
}

fn invalid(message: impl Into<String>, issue: &str) -> CmdError {
    CmdError::with("invalid_command", message, json!({"issues": [issue]}))
}

/// `GET /v1/proposals[?state=pending|all]`: the owner's proposals, newest first, and how many wait.
pub fn list(principal: Principal, state: Option<&str>, now_ms: u64) -> Result<Value, CmdError> {
    owner_in_app(principal)?;
    match state {
        None | Some("pending") | Some("all") => {}
        Some(_) => return Err(invalid("the proposals query is invalid", "state: expected pending or all")),
    }
    Ok(json!({"proposals": [], "pending": 0, "readAt": instant(now_ms)}))
}

/// `POST /v1/proposals/{id}/decision`: the owner confirms or rejects one proposal.
pub fn decide(principal: Principal, proposal_id: &str, body: &[u8]) -> Result<Value, CmdError> {
    owner_in_app(principal)?;
    let request: Map<String, Value> = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(o)) => o,
        _ => return Err(invalid("that decision is not valid", "body: expected a JSON object")),
    };
    let decision = match request.get("decision").and_then(Value::as_str) {
        Some(d @ ("confirm" | "reject")) => d,
        _ => return Err(invalid("that decision is not valid", "decision: expected confirm or reject")),
    };
    let acknowledged = match request.get("acknowledgedRestrictionIds") {
        None => 0,
        Some(Value::Array(ids)) if (1..=20).contains(&ids.len()) && ids.iter().all(|i| i.as_str().map_or(false, |s| (1..=64).contains(&s.chars().count()))) => ids.len(),
        Some(_) => return Err(invalid("that decision is not valid", "acknowledgedRestrictionIds: expected 1 to 20 restriction IDs")),
    };
    if acknowledged > 0 && decision != "confirm" {
        return Err(CmdError::with("invalid_command", "a restriction is acknowledged only when confirming", json!({"reason": "acknowledgement_on_reject"})));
    }
    // Nothing in this port creates a proposal (see the module comment), so none is ever found.
    Err(CmdError::with("not_found", "that proposal was not found", json!({"proposalId": proposal_id})))
}
