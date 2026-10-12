//! The owner's garments as imported from the inventory CSV. The data is
//! `seed/owner-inventory.json`, written by `scripts/build-seed.mjs` from the
//! TypeScript importer (packages/domain/src/import/inventory.ts), so this
//! port never re-implements the import rules.

use std::sync::OnceLock;

use ferrite_app::serde_json::{self, Value};

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
}

#[derive(Debug)]
pub struct Catalogue {
    pub garments: Vec<Garment>,
    pub source_name: String,
    pub source_sha256: String,
    pub import_run_id: String,
    pub unit_count: u64,
}

impl Catalogue {
    pub fn get(&self, id: &str) -> Option<&Garment> {
        self.garments.iter().find(|g| g.id == id)
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
            }
        })
        .collect();
    Catalogue {
        garments,
        source_name: text(&doc, "sourceName"),
        source_sha256: text(&doc, "sourceSha256"),
        import_run_id: text(&doc, "importRunId"),
        unit_count: doc.get("unitCount").and_then(Value::as_u64).unwrap_or(0),
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
    }
}
