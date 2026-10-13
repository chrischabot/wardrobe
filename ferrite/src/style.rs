//! `GET /v1/style[?date=]` (`StyleContext`, as `getStyleContext` in packages/domain/src/queries.ts) and
//! `GET /v1/style/conflicts[?status=][&documentId=]` (`StyleConflictList`, as `listStyleFactConflicts` in
//! packages/domain/src/handlers/style-facts.ts).
//!
//! The owner's taste context is the import of his profile: the document verbatim (hash-checked when the
//! seed is written), the machine rules quoting the passages they interpret, his dated body measurements
//! and his maker-specific size experiences, exactly as the TypeScript importer records them
//! (packages/domain/src/import/apply.ts). It is `seed/owner-style.json`, written by
//! `scripts/build-seed.mjs`, so no rule, value or passage is retyped here.
//!
//! No style command is ported (saving My style, amendments, standing directions, day briefs, rule and
//! measurement changes), so there are no amendments, directions, briefs or fact conflicts, and the
//! context is the import as it stands. A profile-versus-inventory conflict is an import finding, not a
//! `StyleFactConflict`; those stay unresolved with their provenance, as the owner directed.

use std::sync::OnceLock;

use ferrite_app::serde_json::{self, json, Value};

use crate::ledger::CmdError;
use crate::time::parse_local_date;

const SEED: &str = include_str!("seed/owner-style.json");

/// `STYLE_PRECEDENCE_STATEMENT` (packages/contracts/src/style.ts).
pub const PRECEDENCE: &str = "Precedence: (1) physical reality and hard restrictions; (2) an explicit authorized exception where one is allowed; \
(3) the current day's brief; (4) standing directions; (5) stylistic preferences. Newer owner-confirmed restrictions, \
measurements, sizes and current physical state in the amendments supersede conflicting older profile passages; \
the profile prose governs taste. Taste cannot make an absent garment available.";

/// The generated style seed. It is checked by `build-seed.mjs --check`; a malformed one is a build
/// defect, so it fails loudly at first use rather than serving a partial profile.
pub fn seed() -> &'static Value {
    static SEEDED: OnceLock<Value> = OnceLock::new();
    SEEDED.get_or_init(|| serde_json::from_str(SEED).expect("seed/owner-style.json is valid JSON"))
}

/// `StyleContext` for the day asked for (the owner's day when none is). Day briefs are the only dated
/// part, and none can be recorded on this server, so the day changes nothing but is still checked.
pub fn context(date: Option<&str>) -> Result<Value, CmdError> {
    if date.is_some_and(|d| parse_local_date(d).is_none()) {
        return Err(CmdError::with("invalid_command", "date: expected the day as YYYY-MM-DD", json!({"issues": ["date: expected YYYY-MM-DD"]})));
    }
    let s = seed();
    Ok(json!({
        "document": {
            "documentId": s["documentId"], "version": s["version"], "title": s["title"], "content": s["content"],
            "contentSha256": s["contentSha256"], "byteLength": s["byteLength"], "status": "active", "createdAt": s["createdAt"],
        },
        "amendments": [],
        "rules": s["rules"],
        "directions": [],
        "briefs": [],
        "measurements": s["measurements"],
        "sizeExperiences": s["sizeExperiences"],
        "factConflicts": [],
        "precedence": PRECEDENCE,
        // The boards this port publishes are composed against style revision 0 as well.
        "styleRevision": 0,
    }))
}

/// `StyleConflictList`: conflicts a profile save left open between the text and the structured facts.
/// Saving My style is not ported, so there are none in any status, for any document.
pub fn conflicts(status: Option<&str>, document_id: Option<&str>) -> Result<Value, CmdError> {
    let _ = document_id;
    match status {
        None | Some("open" | "resolved" | "withdrawn" | "all") => Ok(json!({"conflicts": []})),
        Some(_) => Err(CmdError::with(
            "invalid_command",
            "status: expected open, resolved, withdrawn or all",
            json!({"issues": ["status: expected one of open, resolved, withdrawn, all"]}),
        )),
    }
}
