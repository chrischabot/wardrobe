//! `GET /v1/wardrobe/temperature-preview?temperatureC=` (`TemperaturePreview`), as `temperaturePreview`
//! in packages/daily/src/service.ts: what becomes wearable at a chosen temperature. A simulation: it
//! reads the catalogue and changes nothing, whatever is clean, dirty or away.
//!
//! Each owned garment that is not excluded from planning, whose first role is a top, mid layer, bottom,
//! outer layer or socks, is checked against the thermal checks of the daily validator
//! (`garmentViolations` in packages/daily/src/validate.ts) with the chosen temperature as both the
//! daytime peak and the outdoor temperature:
//!   * the garment's own bounds (read from the inventory sheet, basis unsettled), assessed against the
//!     basis the owner's active rule gives its role (outerwear follows the morning, base layers the
//!     peak); a bound with no such rule is not enforced;
//!   * each active hard fabric-class rule (`thermal.<name>` with `fabricClass`, `minC`/`maxC` and a
//!     settled basis);
//!   * the outerwear ceiling, while it is active with a settled basis.
//!
//! The research thresholds and the outerwear ceiling are pending reconciliation for the owner, so they
//! are not applied (owner decision: they stay off until he decides them). This port has no seasonal
//! storage bucket, so nothing is ever `inStorage`.

use ferrite_app::serde_json::{json, Value};

use crate::canonical::js_number;
use crate::ledger::CmdError;
use crate::seed::{Catalogue, Garment, Rule};

/// The roles the preview covers (service.ts).
const ROLES: &[&str] = &["top", "mid_layer", "bottom", "outer", "socks"];
/// The thermal rules `buildRules` (packages/daily/src/rules.ts) reads by name; any other active hard
/// `thermal.` rule with a fabric class is a fabric-class bound.
const NAMED_THERMAL: &[&str] = &["thermal.base_layers_follow_daytime_peak", "thermal.outerwear_follows_morning", "thermal.jacket_14_16_lightweight_oxford_only", "thermal.outerwear_ceiling"];

#[derive(Clone, Copy, PartialEq)]
enum Basis {
    Peak,
    Outdoor,
}

fn basis_of(v: &Value) -> Option<Basis> {
    match v.as_str() {
        Some("daytime_peak") => Some(Basis::Peak),
        Some("outdoor_interval") => Some(Basis::Outdoor),
        _ => None,
    }
}

/// A number as JavaScript's template literal writes it, for the values this route admits.
fn js(n: f64) -> String {
    js_number(n).unwrap_or_else(|| n.to_string())
}

/// `temperatureC` from the query string, as `z.coerce.number().min(-40).max(50)` reads it, limited to
/// plain decimal text (what the iOS client sends: `String(Double)`, e.g. `12.0`) and to values
/// JavaScript writes in plain notation.
pub fn parse_temperature(raw: Option<&str>) -> Result<f64, CmdError> {
    let refuse = || CmdError::with("invalid_command", "temperatureC: expected a temperature from -40 to 50 °C", json!({"issues": ["temperatureC: expected a number from -40 to 50"]}));
    let text = raw.map(str::trim).ok_or_else(refuse)?;
    let body = text.strip_prefix(['-', '+']).unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let digits = mantissa.bytes().filter(u8::is_ascii_digit).count();
    let plain = digits > 0 && mantissa.bytes().all(|b| b.is_ascii_digit() || b == b'.') && mantissa.bytes().filter(|b| *b == b'.').count() <= 1;
    let exponent_ok = exponent.map_or(true, |e| {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        !e.is_empty() && e.bytes().all(|b| b.is_ascii_digit())
    });
    if !plain || !exponent_ok {
        return Err(refuse());
    }
    let t: f64 = text.parse().map_err(|_| refuse())?;
    if !(-40.0..=50.0).contains(&t) || js_number(t).is_none() {
        return Err(refuse());
    }
    // `-0` reads as 0, as JavaScript writes it.
    Ok(if t == 0.0 { 0.0 } else { t })
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|f| f.is_finite())
}

/// The thermal violations of one garment in its role at `t` (`garmentViolations`, the thermal codes
/// only: `thermal_too_warm`, `thermal_too_cold`, `fabric_rule`, `outerwear_ceiling`), as their messages.
fn thermal_violations(cat: &Catalogue, g: &Garment, role: &str, t: f64) -> Vec<String> {
    let label = |b: Basis| if b == Basis::Peak { format!("peak {} °C", js(t)) } else { format!("{} °C when outdoors", js(t)) };
    let mut out = Vec::new();
    if let Some(th) = &g.thermal {
        let (min, max) = (number(&th["minC"]), number(&th["maxC"]));
        if min.is_some() || max.is_some() {
            // `thermalBasis`: the garment's own basis, else the basis of the owner's active rule for the role.
            let peak_roles: Vec<&str> = cat
                .active_rule("thermal.base_layers_follow_daytime_peak")
                .and_then(|r| r.params["roles"].as_array())
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let basis = basis_of(&th["basis"]).or(if role == "outer" {
                cat.active_rule("thermal.outerwear_follows_morning").map(|_| Basis::Outdoor)
            } else if cat.active_rule("thermal.base_layers_follow_daytime_peak").is_some() && (peak_roles.contains(&role) || role == "mid_layer") {
                Some(Basis::Peak)
            } else {
                None
            });
            // An unsettled basis is advisory (`thermal_basis_unsettled`), not a thermal refusal.
            if let Some(b) = basis {
                if let Some(max) = max.filter(|m| t > *m) {
                    out.push(format!("{} is kept to {} °C and below ({})", g.name, js(max), label(b)));
                } else if let Some(min) = min.filter(|m| t < *m) {
                    out.push(format!("{} is kept for {} °C and above ({})", g.name, js(min), label(b)));
                }
            }
        }
    }
    let fabric = g.attr_str("fabricClass");
    for rule in cat.rules.iter().filter(|r| fabric_bound(r)) {
        let Some(class) = rule.params["fabricClass"].as_str() else { continue };
        let Some(b) = basis_of(&rule.params["basis"]) else { continue };
        if class != fabric {
            continue;
        }
        // JavaScript's `replace("_", " ")` replaces the first underscore only.
        let words = class.replacen('_', " ", 1);
        if let Some(min) = number(&rule.params["minC"]).filter(|m| t < *m) {
            out.push(format!("{} ({words}) is for {} °C and above ({})", g.name, js(min), label(b)));
        } else if let Some(max) = number(&rule.params["maxC"]).filter(|m| t > *m) {
            out.push(format!("{} ({words}) is for {} °C and below ({})", g.name, js(max), label(b)));
        }
    }
    if role == "outer" {
        if let Some(rule) = cat.active_rule("thermal.outerwear_ceiling") {
            if let (Some(max), Some(b)) = (number(&rule.params["maxC"]), basis_of(&rule.params["basis"])) {
                if t > max {
                    out.push(format!("No outerwear above {} °C ({})", js(max), label(b)));
                }
            }
        }
    }
    out
}

/// An active hard fabric-class temperature rule (the default branch of `buildRules`).
fn fabric_bound(r: &Rule) -> bool {
    r.status == "active" && r.kind == "hard" && r.key.starts_with("thermal.") && !NAMED_THERMAL.contains(&r.key.as_str()) && r.params["fabricClass"].as_str().map_or(false, |s| !s.is_empty())
}

/// The preview at `t` (`TemperaturePreview`). Garments in the order the TypeScript query reads them
/// (`ORDER BY category, name, garment_id`, byte order).
pub fn preview(cat: &Catalogue, t: f64) -> Value {
    let mut garments: Vec<&Garment> = cat.garments.iter().collect();
    garments.sort_by(|a, b| (&a.category, &a.name, &a.id).cmp(&(&b.category, &b.name, &b.id)));
    let mut wearable = Vec::new();
    let mut not_wearable = Vec::new();
    for g in garments {
        if g.acquisition != "owned" || g.planning_policy == "excluded" {
            continue;
        }
        let Some(role) = g.roles.first().map(String::as_str).filter(|r| ROLES.contains(r)) else { continue };
        match thermal_violations(cat, g, role, t).into_iter().next() {
            Some(why) => not_wearable.push(json!({"garmentId": g.id, "name": g.name, "role": role, "why": why})),
            None => {
                let basis = match (&g.thermal, &g.season_note) {
                    (Some(th), _) => th["source"].as_str().unwrap_or_default().to_string(),
                    (None, Some(season)) => format!("no temperature limit recorded (sheet season: {season})"),
                    (None, None) => "no temperature limit recorded".to_string(),
                };
                wearable.push(json!({"garmentId": g.id, "name": g.name, "role": role, "inStorage": false, "basis": basis}));
            }
        }
    }
    let temperature = if t.fract() == 0.0 { json!(t as i64) } else { json!(t) };
    json!({
        "simulation": true,
        "label": format!("Simulation at {} °C. Actual availability, laundry and restrictions are unchanged.", js(t)),
        "temperatureC": temperature,
        "wearable": wearable,
        "notWearable": not_wearable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_temperature_is_read_as_plain_decimal_text_from_minus_40_to_50() {
        for (raw, want) in [("12", 12.0), ("12.0", 12.0), (" 30 ", 30.0), ("-40", -40.0), ("50", 50.0), ("-0", 0.0), ("12.5", 12.5), (".5", 0.5), ("1e1", 10.0), ("+7", 7.0)] {
            assert_eq!(parse_temperature(Some(raw)).unwrap(), want, "{raw}");
        }
        for raw in ["", "abc", "51", "-40.5", "0x10", "Infinity", "NaN", "1e", "1.2.3", "1e-7", "0.0000001", "--1"] {
            assert!(parse_temperature(Some(raw)).is_err(), "{raw}");
        }
        assert!(parse_temperature(None).is_err());
    }
}
