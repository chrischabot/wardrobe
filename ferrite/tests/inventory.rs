//! The Wardrobe tab, `GET /v1/wardrobe` (`InventoryPage`, as `listInventory`), through the request
//! handler on the owner's real inventory: the contract shape of each item (the record, aliases, balances,
//! owned units, the estimator's availability, recorded wears), the filters and search, the counts, and
//! paging whose `total`, `complete` and `nextCursor` are always explicit.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments are the real seed.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Store, Tokens, OWNER};
use wardrobe::seed::catalogue;

const OWNER_TOKEN: &str = "owner-token-for-tests";
const ASSISTANT_TOKEN: &str = "assistant-token-for-tests";
const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z

const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f"; // Lightweight oxford — blue, maker's code PCF4339
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729";
const REIMS: &str = "gmt_a8fe5fe3a6c0754361249bf8";

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

async fn get_as(store: &mut MemStore, token: &str, path: &str) -> (u16, Value) {
    let mut req = IngressRequest::new("GET", path, Vec::new());
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER_TOKEN.into()), assistant: Some(ASSISTANT_TOKEN.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, T0, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn page(store: &mut MemStore, query: &str) -> Value {
    let (status, body) = get_as(store, OWNER_TOKEN, &format!("/v1/wardrobe{query}")).await;
    assert_eq!(status, 200, "{query}: {body}");
    body
}

fn ids(page: &Value) -> Vec<String> {
    page["items"].as_array().unwrap().iter().map(|i| i["garment"]["garmentId"].as_str().unwrap().to_string()).collect()
}

async fn run(store: &mut MemStore, kind: &str, payload: Value, key: &str) {
    let env = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}});
    api::execute(store, OWNER, T0, &env).await.unwrap_or_else(|e| panic!("{kind}: {} {}", e.code, e.message));
}

#[tokio::test]
async fn the_complete_snapshot_lists_every_garment_in_the_contract_shape() {
    let mut store = MemStore::default();
    let all = page(&mut store, "").await;
    assert_eq!((all["total"].clone(), all["complete"].clone(), all["nextCursor"].clone(), all["wardrobeRevision"].clone(), all["readAt"].clone()), (json!(127), json!(true), Value::Null, json!(0), json!("2026-09-10T00:26:40Z")));
    let items = all["items"].as_array().unwrap();
    assert_eq!(items.len(), 127);
    // Ordered by category, name and ID (byte order), as the TypeScript query orders the garments.
    let keys: Vec<(String, String, String)> = items.iter().map(|i| (i["garment"]["category"].as_str().unwrap().into(), i["garment"]["name"].as_str().unwrap().into(), i["garment"]["garmentId"].as_str().unwrap().into())).collect();
    assert!(keys.windows(2).all(|w| (w[0].0.as_bytes(), w[0].1.as_bytes(), w[0].2.as_bytes()) < (w[1].0.as_bytes(), w[1].1.as_bytes(), w[1].2.as_bytes())));
    // Every unit the import counted, and the available count is the owned pieces offerable now.
    assert_eq!(items.iter().map(|i| i["totalOwnedUnits"].as_u64().unwrap()).sum::<u64>(), 144);
    let offerable = items.iter().filter(|i| matches!(i["availability"]["status"].as_str(), Some("available" | "estimated"))).count();
    assert_eq!(all["counts"], json!({"owned": 127, "available": offerable, "incoming": 0, "retired": 0}));

    // One item: the record and its aliases as imported, balances and availability as the estimator has them.
    let blue = items.iter().find(|i| i["garment"]["garmentId"] == OXFORD_BLUE).unwrap();
    let g = catalogue().get(OXFORD_BLUE).unwrap();
    assert_eq!(blue["aliases"], json!(g.aliases.iter().map(|a| a.phrase.clone()).collect::<Vec<_>>()));
    assert_eq!(blue["aliases"][0], g.name);
    assert_eq!((blue["garment"]["name"].clone(), blue["garment"]["version"].clone(), blue["garment"]["userId"].clone()), (json!(g.name), json!(1), json!("owner")));
    assert_eq!(blue["balances"], json!([{"bucket": "clean", "ref": "", "quantity": 1}]));
    assert_eq!((blue["totalOwnedUnits"].clone(), blue["recordedWearCount"].clone(), blue["lastRecordedWear"].clone()), (json!(1), json!(0), Value::Null));
    assert_eq!((blue["availability"]["status"].clone(), blue["availability"]["pAvailable"].clone()), (json!("estimated"), json!(0.8)));
    // The same document the availability route gives.
    let (_, snapshot) = get_as(&mut store, OWNER_TOKEN, "/v1/availability?date=2026-09-10").await;
    let from_route = snapshot["garments"].as_array().unwrap().iter().find(|a| a["garmentId"] == OXFORD_BLUE).unwrap().clone();
    assert_eq!(blue["availability"], from_route);
    let reims = items.iter().find(|i| i["garment"]["garmentId"] == REIMS).unwrap();
    assert_eq!((reims["availability"]["status"].clone(), reims["availability"]["hardExcluded"].clone()), (json!("unavailable"), json!(true)));

    // The connected assistant reads the same page.
    let (status, by_assistant) = get_as(&mut store, ASSISTANT_TOKEN, "/v1/wardrobe").await;
    assert_eq!((status, by_assistant["items"].clone()), (200, all["items"].clone()));
}

#[tokio::test]
async fn filters_and_search_narrow_the_list_and_counts_stay_whole() {
    let mut store = MemStore::default();
    let socks = page(&mut store, "?category=socks").await;
    assert_eq!((socks["total"].clone(), socks["counts"]["owned"].clone()), (json!(15), json!(127)), "counts describe the whole wardrobe");
    assert!(socks["items"].as_array().unwrap().iter().all(|i| i["garment"]["category"] == "socks"));
    // Search reads names, makers, products, colours, fabrics and aliases (a maker's code, here).
    assert_eq!(ids(&page(&mut store, "?search=PCF4339").await), vec![OXFORD_BLUE]);
    assert_eq!(ids(&page(&mut store, "?search=pcf4339").await), vec![OXFORD_BLUE]);
    let grey = page(&mut store, "?search=merino+grey&category=socks").await;
    assert!(ids(&grey).contains(&SOCK_GREY.to_string()), "{grey}");
    // Accents are folded as `normalizePhrase` folds them: "lightweight oxford — blue" percent-encoded,
    // and a decomposed accent in the search matches the plain letter.
    assert!(ids(&page(&mut store, "?search=Lightweight%20Oxford%20%E2%80%94%20Blue").await).contains(&OXFORD_BLUE.to_string()));
    assert_eq!(page(&mut store, "?search=oxfo%CC%81rd+blue").await["total"], page(&mut store, "?search=oxford+blue").await["total"]);
    assert_eq!(page(&mut store, "?search=gucci+horsebit").await["total"], 0);
    // Colour is a normalized substring of the recorded colour.
    let navy = page(&mut store, "?colour=NAVY&category=shirt").await;
    assert!(navy["total"].as_u64().unwrap() > 0);
    assert!(navy["items"].as_array().unwrap().iter().all(|i| i["garment"]["colour"].as_str().unwrap_or("").to_lowercase().contains("navy")));
    // Availability and location read the estimator's status and the balances.
    let unavailable = page(&mut store, "?availability=unavailable").await;
    assert!(ids(&unavailable).contains(&REIMS.to_string()));
    assert!(unavailable["items"].as_array().unwrap().iter().all(|i| i["availability"]["status"] == "unavailable"));
    assert_eq!(page(&mut store, "?location=home").await["total"], 127);
    assert_eq!(page(&mut store, "?location=service").await["total"], 0);
    run(&mut store, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0001").await;
    run(&mut store, "laundry.collect", json!({}), "collect-0001").await;
    let away = page(&mut store, "?location=service").await;
    assert_eq!(ids(&away), vec![OXFORD_BLUE]);
    assert_eq!(away["items"][0]["availability"]["reasons"], json!(["no_units_at_home", "in_service_batch"]));
    assert_eq!(away["items"][0]["garment"]["version"], 3);
    assert_eq!(away["wardrobeRevision"], 2);
    // Every garment is owned, so nothing is incoming or retired, and includeDisposed changes nothing.
    assert_eq!(page(&mut store, "?acquisition=owned&includeDisposed=true").await["total"], 127);
    assert_eq!(page(&mut store, "?acquisition=disposed").await["total"], 0);
    // Unknown keys are ignored, an empty category filters nothing, and the last of a repeated key wins.
    assert_eq!(page(&mut store, "?note=x&category=").await["total"], 127);
    assert_eq!(page(&mut store, "?category=shirt&category=socks").await["total"], 15);
}

#[test]
fn numbers_are_read_as_javascript_number_reads_strings() {
    use wardrobe::inventory::js_number;
    for (text, want) in [("", Some(0.0)), ("  ", Some(0.0)), ("42", Some(42.0)), (" 42\n", Some(42.0)), ("+42", Some(42.0)), ("-42", Some(-42.0)), ("4.5", Some(4.5)), (".5", Some(0.5)), ("5.", Some(5.0)), ("1e3", Some(1000.0)), ("1E-1", Some(0.1)), ("0x1F", Some(31.0)), ("0o17", Some(15.0)), ("0B101", Some(5.0)), ("Infinity", Some(f64::INFINITY)), ("-Infinity", Some(f64::NEG_INFINITY))] {
        assert_eq!(js_number(text), want, "{text:?}");
    }
    for text in ["abc", "1a", "0x", "-0x5", "0xG", "1e", "e1", ".", "+", "1_000", "inf", "NaN", "infinity", "1.2.3", "--1", "0b2"] {
        assert_eq!(js_number(text), None, "{text:?}");
    }
}

#[tokio::test]
async fn pages_say_whether_they_are_the_whole_and_bad_queries_are_refused() {
    let mut store = MemStore::default();
    let all = ids(&page(&mut store, "").await);
    let first = page(&mut store, "?limit=50").await;
    assert_eq!((first["total"].clone(), first["complete"].clone(), first["nextCursor"].clone()), (json!(127), json!(false), json!("50")));
    let second = page(&mut store, "?limit=50&cursor=50").await;
    assert_eq!((second["complete"].clone(), second["nextCursor"].clone()), (json!(false), json!("100")));
    let last = page(&mut store, "?limit=50&cursor=100").await;
    assert_eq!((last["items"].as_array().unwrap().len(), last["complete"].clone(), last["nextCursor"].clone()), (27, json!(false), Value::Null));
    let joined: Vec<String> = [ids(&first), ids(&second), ids(&last)].concat();
    assert_eq!(joined, all, "the pages are the snapshot, in order, each garment once");
    // One page holding everything is the whole; a cursor past the end is an empty page, never the whole.
    let whole = page(&mut store, "?limit=500").await;
    assert_eq!((whole["complete"].clone(), whole["nextCursor"].clone()), (json!(true), Value::Null));
    let beyond = page(&mut store, "?limit=5&cursor=99999999999999999999").await;
    assert_eq!((beyond["items"].clone(), beyond["complete"].clone(), beyond["nextCursor"].clone(), beyond["total"].clone()), (json!([]), json!(false), Value::Null, json!(127)));
    // Without a limit the result is the complete snapshot, whatever the cursor.
    let no_limit = page(&mut store, "?cursor=50").await;
    assert_eq!((no_limit["items"].as_array().unwrap().len(), no_limit["complete"].clone()), (127, json!(true)));
    // Numbers are read as JavaScript's `Number()` reads them: white space, exponents and hexadecimal.
    for (query, same_as) in [("?limit=0x32", "?limit=50"), ("?limit=5e1", "?limit=50"), ("?limit=%2050%20", "?limit=50"), ("?limit=50&cursor=1e2", "?limit=50&cursor=100"), ("?limit=50&cursor=0x64", "?limit=50&cursor=100"), ("?limit=50&cursor=", "?limit=50"), ("?limit=50.0&cursor=50.0", "?limit=50&cursor=50")] {
        assert_eq!(ids(&page(&mut store, query).await), ids(&page(&mut store, same_as).await), "{query}");
    }
    for bad in ["?limit=0", "?limit=501", "?limit=ten", "?limit=2.5", "?limit=", "?limit=Infinity", "?limit=-0x5", "?limit=0x", "?limit=1e", "?limit=.", "?cursor=abc", "?cursor=-1", "?limit=5&cursor=1.5", "?cursor=Infinity", "?cursor=NaN", "?cursor=inf", "?availability=maybe", "?location=attic", "?acquisition=borrowed", "?forDate=2026-02-30", "?search=%ZZ"] {
        let (status, e) = get_as(&mut store, OWNER_TOKEN, &format!("/v1/wardrobe{bad}")).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{bad}: {e}");
    }
    // A named day is the day the availability is for.
    assert_eq!(page(&mut store, "?forDate=2026-09-20&limit=1").await["total"], 127);
    assert!(store.data.is_empty(), "reads write nothing");
}
