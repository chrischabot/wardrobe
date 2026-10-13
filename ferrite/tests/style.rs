//! `GET /v1/style` (the owner's taste context: the profile verbatim, its rules, measurements and size
//! experiences) and `GET /v1/style/conflicts`, as the iOS client's My style screen reads them.
//!
//! The store is an in-memory test double of the APE binding; the profile and every fact are the real
//! seed generated from the owner's profile.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens};
use wardrobe::seed::catalogue;
use wardrobe::time::parse_instant;

const OWNER: &str = "owner-token-for-tests";
const ASSISTANT: &str = "assistant-token-for-tests";
/// SHA-256 of the owner's profile, second edition (specification section 6).
const PROFILE_SHA256: &str = "e15639d891f9a5264c7eff13d05a478bcb188745aea11323b2131db37f5cb198";

#[derive(Default, Clone)]
struct MemStore {
    data: BTreeMap<Vec<u8>, Vec<u8>>,
}

impl Store for MemStore {
    async fn get(&mut self, key: &[u8]) -> io::Result<Option<Vec<u8>>> {
        Ok(self.data.get(key).cloned())
    }
    async fn commit_n_if(&mut self, guard: &[u8], expected: Option<&[u8]>, entries: &[(&[u8], &[u8])]) -> io::Result<Result<(), Option<Vec<u8>>>> {
        let current = self.data.get(guard).cloned();
        if current.as_deref() != expected {
            return Ok(Err(current));
        }
        for (k, v) in entries {
            self.data.insert(k.to_vec(), v.to_vec());
        }
        Ok(Ok(()))
    }
}

async fn send(store: &mut MemStore, token: Option<&str>, path: &str) -> (u16, Value) {
    let mut req = IngressRequest::new("GET", path, Vec::new());
    if let Some(token) = token {
        req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    }
    let tokens = Tokens { owner: Some(OWNER.into()), assistant: Some(ASSISTANT.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, parse_instant("2026-10-12T09:00:00Z").unwrap(), &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn find<'a>(list: &'a Value, field: &str, value: &str) -> &'a Value {
    list.as_array().unwrap().iter().find(|x| x[field] == value).unwrap_or_else(|| panic!("no {field} {value}"))
}

#[tokio::test]
async fn the_style_context_is_the_owners_profile_verbatim_with_the_facts_that_quote_it() {
    let mut store = MemStore::default();
    let (status, s) = send(&mut store, Some(OWNER), "/v1/style").await;
    assert_eq!(status, 200, "{s}");
    assert!(store.data.is_empty(), "reading the profile writes nothing");
    let keys: Vec<&str> = s.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys.len(), 10, "{keys:?}");

    // The document, byte for byte: its hash is the owner's profile's.
    let doc = &s["document"];
    let content = doc["content"].as_str().unwrap();
    assert_eq!(wardrobe::sha256::hex_digest(content.as_bytes()), PROFILE_SHA256);
    assert_eq!((doc["contentSha256"].clone(), doc["byteLength"].clone()), (json!(PROFILE_SHA256), json!(content.len())));
    assert_eq!((doc["documentId"].clone(), doc["version"].clone(), doc["status"].clone()), (json!("owner-profile"), json!(1), json!("active")));
    assert_eq!(doc["title"], "Chris — Taste, Formation, Preferences and Operating Rules (second edition, 14 September 2026)");
    assert!(content.starts_with("# Chris — Taste, Formation, Preferences and Operating Rules\n"));

    // Every passage a fact quotes occurs verbatim at the lines it names.
    let lines: Vec<&str> = content.split('\n').collect();
    let check_passage = |p: &Value| {
        assert_eq!(p["documentSha256"], PROFILE_SHA256);
        let (start, end) = (p["lineStart"].as_u64().unwrap() as usize, p["lineEnd"].as_u64().unwrap() as usize);
        let quote = p["quote"].as_str().unwrap();
        assert!(lines[start - 1..end].join("\n").contains(quote), "{quote} is not at lines {start}-{end}");
    };

    // The rules, ordered by key, are the ones the board validator enforces from the inventory seed.
    let rules = s["rules"].as_array().unwrap();
    assert_eq!(rules.len(), 28);
    let keys: Vec<&str> = rules.iter().map(|r| r["key"].as_str().unwrap()).collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted);
    let cat = catalogue();
    assert_eq!(rules.len(), cat.rules.len());
    for rule in rules {
        let seeded = cat.rules.iter().find(|r| r.key == rule["key"]).unwrap_or_else(|| panic!("{rule}"));
        assert_eq!((rule["kind"].as_str().unwrap(), rule["status"].as_str().unwrap(), &rule["params"]), (seeded.kind.as_str(), seeded.status.as_str(), &seeded.params));
        assert_eq!(rule["version"], 1);
        assert!(rule["ruleId"].as_str().unwrap().starts_with("rul_"));
        // A profile rule quotes its passage; a specification rule has none.
        let passages = rule["passages"].as_array().unwrap();
        assert_eq!(rule["origin"] == "profile", !passages.is_empty(), "{rule}");
        passages.iter().for_each(check_passage);
    }
    let healing = find(&s["rules"], "key", "footwear.sneakers_only_until_healed");
    assert_eq!((healing["status"].clone(), healing["params"]["restrictionId"].clone()), (json!("active"), json!("rst_profile_sneakers_only")));
    // The research thresholds stay pending, as the owner left them.
    assert_eq!(find(&s["rules"], "key", "thermal.cotton_linen_from")["status"], "pending_reconciliation");
    assert_eq!(find(&s["rules"], "key", "thermal.outerwear_ceiling")["status"], "pending_reconciliation");

    // Body measurements as the profile states them, ordered by key, undated and never superseded.
    let m = &s["measurements"];
    let keyed: Vec<(&str, f64, &str)> = m.as_array().unwrap().iter().map(|x| (x["key"].as_str().unwrap(), x["value"].as_f64().unwrap(), x["unit"].as_str().unwrap())).collect();
    assert_eq!(keyed, vec![("chest", 44.0, "in"), ("height", 1.85, "m"), ("neck", 17.0, "in"), ("shoe_size", 8.5, "uk_shoe"), ("waist", 44.0, "in")]);
    for x in m.as_array().unwrap() {
        assert_eq!((x["subject"].clone(), x["garmentId"].clone(), x["measuredOn"].clone(), x["supersededBy"].clone()), (json!("body"), Value::Null, Value::Null, Value::Null));
        assert_eq!(x["source"]["kind"], "profile_passage");
        check_passage(&x["passage"]);
    }
    assert_eq!(find(m, "key", "height")["qualifier"], "a little over");

    // Size experiences by maker, then in the order the importer records them.
    let sizes = s["sizeExperiences"].as_array().unwrap();
    let order: Vec<(&str, &str)> = sizes.iter().map(|x| (x["maker"].as_str().unwrap(), x["sizeLabel"].as_str().unwrap())).collect();
    assert_eq!(
        order,
        vec![("(any)", "XL"), ("(any)", "40 waist, 32 length"), ("De Bonne Facture", "own chart"), ("Drake's", "46"), ("Private White V.C.", "6 / XL"), ("Proper Cloth", "made to measure (current manual measure)")]
    );
    for x in sizes {
        assert_eq!(x["notedOn"], "2026-09-14");
        check_passage(&x["passage"]);
    }

    // Every record ID is distinct.
    let mut ids: Vec<&str> = rules.iter().map(|r| r["ruleId"].as_str().unwrap()).chain(m.as_array().unwrap().iter().map(|x| x["measurementId"].as_str().unwrap())).chain(sizes.iter().map(|x| x["sizeExperienceId"].as_str().unwrap())).collect();
    let n = ids.len();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), n);

    // Nothing layered on top of the import, and the contract's precedence statement.
    for empty in ["amendments", "directions", "briefs", "factConflicts"] {
        assert_eq!(s[empty], json!([]), "{empty}");
    }
    assert_eq!(s["styleRevision"], 0);
    assert_eq!(
        s["precedence"],
        "Precedence: (1) physical reality and hard restrictions; (2) an explicit authorized exception where one is allowed; (3) the current day's brief; (4) standing directions; (5) stylistic preferences. Newer owner-confirmed restrictions, measurements, sizes and current physical state in the amendments supersede conflicting older profile passages; the profile prose governs taste. Taste cannot make an absent garment available."
    );

    // A day can be named; the context is the same. A malformed day is refused.
    assert_eq!(send(&mut store, Some(OWNER), "/v1/style?date=2026-10-13").await, (200, s.clone()));
    let (status, body) = send(&mut store, Some(OWNER), "/v1/style?date=13-10-2026").await;
    assert_eq!((status, body["error"]["code"].clone()), (400, json!("invalid_command")));
    // A connected assistant reads it too (wardrobe.read covers the style profile); nobody else does.
    assert_eq!(send(&mut store, Some(ASSISTANT), "/v1/style").await, (200, s));
    assert_eq!(send(&mut store, None, "/v1/style").await.0, 401);
}

#[tokio::test]
async fn there_are_no_profile_conflicts_to_decide_and_a_bad_status_is_refused() {
    let mut store = MemStore::default();
    assert_eq!(send(&mut store, Some(OWNER), "/v1/style/conflicts").await, (200, json!({"conflicts": []})));
    for q in ["status=open", "status=resolved", "status=withdrawn", "status=all", "status=all&documentId=owner-profile", "documentId=elsewhere"] {
        assert_eq!(send(&mut store, Some(ASSISTANT), &format!("/v1/style/conflicts?{q}")).await, (200, json!({"conflicts": []})), "{q}");
    }
    for q in ["status=closed", "status=", "status=OPEN"] {
        let (status, body) = send(&mut store, Some(OWNER), &format!("/v1/style/conflicts?{q}")).await;
        assert_eq!((status, body["error"]["code"].clone()), (400, json!("invalid_command")), "{q}");
    }
    assert!(store.data.is_empty());
}
