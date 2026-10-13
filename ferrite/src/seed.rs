//! The owner's garments as imported from the inventory CSV. The data is
//! `seed/owner-inventory.json`, written by `scripts/build-seed.mjs` from the
//! TypeScript importer (packages/domain/src/import/inventory.ts), so this
//! port never re-implements the import rules.

use std::sync::OnceLock;

use ferrite_app::serde_json::{self, Map, Value};

const SEED: &str = include_str!("seed/owner-inventory.json");

#[derive(Debug, Clone)]
pub struct Garment {
    pub id: String,
    pub name: String,
    pub category: String,
    /// `service`, `handwash` or `none` (never laundered).
    pub care_channel: String,
    pub planning_policy: String,
    pub acquisition: String,
    pub quantity: u32,
    pub source_rows: Vec<u64>,
    /// The roles the garment can take in an outfit (`Role` in packages/contracts).
    pub roles: Vec<String>,
    /// The recorded colour text, as imported.
    pub colour: Option<String>,
    /// The imported attributes (`fabricClass`, `footwearKind`, `model`, `jacketLike`, ...).
    pub attributes: Map<String, Value>,
    /// The inventory sheet's season text, as imported.
    pub season_note: Option<String>,
    /// The temperature bounds the importer read from the sheet (`{minC?, maxC?, basis, source}`), or none.
    pub thermal: Option<Value>,
}

impl Garment {
    /// A string attribute, or `""`.
    pub fn attr_str(&self, key: &str) -> &str {
        self.attributes.get(key).and_then(Value::as_str).unwrap_or("")
    }
    /// Whether a boolean attribute is `true`.
    pub fn attr_true(&self, key: &str) -> bool {
        self.attributes.get(key) == Some(&Value::Bool(true))
    }
}

/// One of the owner's profile rules as the importer records it
/// (packages/domain/src/import/profile.ts): the board validator reads the
/// parameters of the rules it enforces from here.
#[derive(Debug, Clone)]
pub struct Rule {
    pub key: String,
    /// `hard` or `soft`.
    pub kind: String,
    pub status: String,
    pub params: Value,
}

#[derive(Debug)]
pub struct Catalogue {
    pub garments: Vec<Garment>,
    pub source_name: String,
    pub source_sha256: String,
    pub import_run_id: String,
    pub unit_count: u64,
    pub rules: Vec<Rule>,
    /// The profile's healing restriction (sneakers only until the owner says his feet have healed).
    pub healing_restriction_id: String,
}

impl Catalogue {
    pub fn get(&self, id: &str) -> Option<&Garment> {
        self.garments.iter().find(|g| g.id == id)
    }

    /// The rule with this key, only while it is active.
    pub fn active_rule(&self, key: &str) -> Option<&Rule> {
        self.rules.iter().find(|r| r.key == key && r.status == "active")
    }
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn parse(seed: &str) -> Catalogue {
    // The seed is generated and checked; a malformed one is a build defect,
    // so it fails loudly at first use rather than serving a partial wardrobe.
    let doc: Value = serde_json::from_str(seed).expect("seed/owner-inventory.json is valid JSON");
    let garments = doc
        .get("garments")
        .and_then(Value::as_array)
        .expect("seed has a garments array")
        .iter()
        .map(|g| {
            let initial = text(g, "initialBucket");
            assert_eq!(initial, "clean", "this port seeds imported units as clean only (as the importer does today)");
            Garment {
                id: text(g, "garmentId"),
                name: text(g, "name"),
                category: text(g, "category"),
                care_channel: text(g, "careChannel"),
                planning_policy: text(g, "planningPolicy"),
                acquisition: text(g, "acquisition"),
                quantity: g.get("quantity").and_then(Value::as_u64).unwrap_or(1) as u32,
                source_rows: g
                    .get("sourceRows")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default(),
                roles: g
                    .get("roles")
                    .and_then(Value::as_array)
                    .expect("every seeded garment has roles")
                    .iter()
                    .filter_map(|r| r.as_str().map(str::to_string))
                    .collect(),
                colour: g.get("colour").and_then(Value::as_str).map(str::to_string),
                attributes: g.get("attributes").and_then(Value::as_object).cloned().unwrap_or_default(),
                season_note: g.get("seasonNote").and_then(Value::as_str).map(str::to_string),
                thermal: g.get("thermal").filter(|t| t.is_object()).cloned(),
            }
        })
        .collect();
    let rules = doc
        .get("rules")
        .and_then(Value::as_array)
        .expect("seed has a rules array")
        .iter()
        .map(|r| Rule { key: text(r, "key"), kind: text(r, "kind"), status: text(r, "status"), params: r.get("params").cloned().unwrap_or(Value::Null) })
        .collect();
    Catalogue {
        garments,
        source_name: text(&doc, "sourceName"),
        source_sha256: text(&doc, "sourceSha256"),
        import_run_id: text(&doc, "importRunId"),
        unit_count: doc.get("unitCount").and_then(Value::as_u64).unwrap_or(0),
        rules,
        healing_restriction_id: text(&doc, "healingRestrictionId"),
    }
}

pub fn catalogue() -> &'static Catalogue {
    static CATALOGUE: OnceLock<Catalogue> = OnceLock::new();
    CATALOGUE.get_or_init(|| parse(SEED))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The figures the import report states for the owner's CSV
    /// (data/import/inventory-import-report.json): 127 garments, 144 units.
    #[test]
    fn the_seed_is_the_owner_inventory() {
        let c = catalogue();
        assert_eq!(c.garments.len(), 127);
        assert_eq!(c.garments.iter().map(|g| u64::from(g.quantity)).sum::<u64>(), 144);
        assert_eq!(c.unit_count, 144);
        assert_eq!(c.source_sha256, "ca9a5e06edbb2646ad91f102cb242a81b1776bd39e86e99300c0eb387254c946");
        let reims = c.get("gmt_a8fe5fe3a6c0754361249bf8").expect("Paraboot Reims");
        assert_eq!(reims.name, "Paraboot Reims — noir (black)");
        assert_eq!(reims.care_channel, "none");
        assert_eq!(reims.roles, vec!["footwear".to_string()]);
        assert_eq!(reims.attr_str("footwearKind"), "welted");
        assert!(c.garments.iter().all(|g| !g.roles.is_empty()));
        // The profile's rules as imported, with their states.
        let so = c.active_rule("footwear.sneakers_only_until_healed").expect("sneakers-only is active");
        assert_eq!(so.params["allowedFootwearKinds"], ferrite_app::serde_json::json!(["sneaker"]));
        assert!(c.active_rule("footwear.name_sneaker_and_welted_alternative").is_none(), "dormant while the restriction holds");
        assert!(c.active_rule("thermal.cotton_linen_from").is_none(), "research thresholds stay off");
        assert_eq!(c.healing_restriction_id, "rst_profile_sneakers_only");
    }
}
