//! Wardrobe reads the iOS client and a connected assistant use to name, select and plan with garments:
//! `GET /v1/wardrobe/resolve`, `POST /v1/wardrobe/selection` and `GET /v1/availability` (the
//! probabilistic estimator over the outfits offered and not reported), through the request handler.
//!
//! The store is an in-memory test double of the APE binding (the same guarded-commit semantics); the
//! garments, aliases, quantities and the healing restriction are the real seed from the owner's
//! inventory and profile. Boards, choices and wear go through the command service.

use std::collections::BTreeMap;
use std::io;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::IngressRequest;
use wardrobe::api::{self, Principal, Store, Tokens, OWNER};
use wardrobe::seed::catalogue;
use wardrobe::selection::normalize_phrase;

const OWNER_TOKEN: &str = "owner-token-for-tests";
const ASSISTANT_TOKEN: &str = "assistant-token-for-tests";
const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z (01:26 in London)
const HOUR: u64 = 3_600_000;

// Real garments from the owner's inventory.
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f"; // Lightweight oxford — blue, one unit, service laundry
const OXFORD_PINK: &str = "gmt_41c2da80e7f41e5dc6a4340b";
const AKITA_CREAM: &str = "gmt_0bd82c642c7606199361d3d4";
const GREY_CHINO: &str = "gmt_b8744c2627cd88a3b937f851";
const SOCK_BISCUIT: &str = "gmt_9eb32f6a40ea3e5e4dee484b"; // two pairs, hand-washed
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729";
const BED_SOCK: &str = "gmt_8c8b983912a6effbc6b33a86"; // indoor only
const NB_GREY: &str = "gmt_14bc4338d6760f6a13434b2f"; // never laundered
const NB_OLIVE: &str = "gmt_185ccf753d109848f21f7cec";
const REIMS: &str = "gmt_a8fe5fe3a6c0754361249bf8"; // welted: excluded while sneakers-only holds
const BELT_BROWN: &str = "gmt_6335e17bcb19fb15f77c31bf";
const BELT_BLACK: &str = "gmt_4f778d8afb62d536e5fc036b";
const GAMES_JACKET: &str = "gmt_0573b00364cad2ee03e8b70f";

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

async fn send(store: &mut MemStore, method: &str, path: &str, body: &[u8], token: &str) -> (u16, Value) {
    let mut req = IngressRequest::new(method, path, body.to_vec());
    req.headers = vec![("authorization".into(), format!("Bearer {token}"))];
    let tokens = Tokens { owner: Some(OWNER_TOKEN.into()), assistant: Some(ASSISTANT_TOKEN.into()), public_origin: None, ..Default::default() };
    let reply = api::handle(store, &tokens, T0 + 3 * 24 * HOUR, &req).await;
    let (_, bytes) = reply.content();
    (reply.status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn get(store: &mut MemStore, path: &str) -> (u16, Value) {
    send(store, "GET", path, b"", OWNER_TOKEN).await
}

async fn select(store: &mut MemStore, selector: Value) -> (u16, Value) {
    send(store, "POST", "/v1/wardrobe/selection", selector.to_string().as_bytes(), OWNER_TOKEN).await
}

async fn run(store: &mut MemStore, who: Principal, now: u64, kind: &str, payload: Value, key: &str) -> Value {
    let env = json!({"type": kind, "payload": payload, "idempotencyKey": key, "authorization": "owner_tap", "source": {"channel": "ios"}});
    api::execute(store, who, now, &env).await.unwrap_or_else(|e| panic!("{kind}: {} {}", e.code, e.message))
}

fn outfit(top: &str, bottom: &str, socks: &str, shoes: &str, belt: &str) -> Value {
    json!({"slots": [{"role": "top", "garmentId": top}, {"role": "bottom", "garmentId": bottom}, {"role": "belt", "garmentId": belt}, {"role": "socks", "garmentId": socks}, {"role": "footwear", "garmentId": shoes}], "reason": ""})
}

/// Two outfits: the blue oxford with the biscuit socks, or the pink oxford with the grey socks.
async fn publish(store: &mut MemStore, now: u64, day: &str, key: &str) -> Value {
    let options = json!([outfit(OXFORD_BLUE, AKITA_CREAM, SOCK_BISCUIT, NB_GREY, BELT_BROWN), outfit(OXFORD_PINK, GREY_CHINO, SOCK_GREY, NB_OLIVE, BELT_BLACK)]);
    run(store, OWNER, now, "board.publish", json!({"localDate": day, "requestedCount": 2, "options": options}), key).await
}

async fn availability(store: &mut MemStore, date: &str) -> Value {
    let (status, body) = get(store, &format!("/v1/availability?date={date}")).await;
    assert_eq!(status, 200, "{body}");
    body
}

fn of<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["garments"].as_array().unwrap().iter().find(|g| g["garmentId"] == id).unwrap_or_else(|| panic!("no {id}"))
}

fn p(g: &Value) -> f64 {
    g["pAvailable"].as_f64().unwrap()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-12
}

fn inferred(g: &Value) -> Vec<(String, f64)> {
    g["inferredWear"].as_array().unwrap().iter().map(|w| (w["localDate"].as_str().unwrap().to_string(), w["probability"].as_f64().unwrap())).collect()
}

#[test]
fn the_port_normalizes_every_seeded_phrase_as_the_importer_did() {
    let mut n = 0;
    for g in &catalogue().garments {
        assert_eq!(g.aliases[0].phrase, g.name, "the name is the first alias");
        for a in &g.aliases {
            assert_eq!(normalize_phrase(&a.phrase), a.normalized, "{}", a.phrase);
            n += 1;
        }
    }
    assert_eq!(n, 275);
}

/// `normalizePhrase`'s own results (written by scripts/build-fold-table.mjs with Node's NFKD) for phrases
/// holding every code point the folding table lists and for seeded random phrases from all of Unicode.
#[test]
fn the_port_normalizes_any_phrase_as_normalize_phrase_does() {
    let cases: Vec<(String, String)> = serde_json::from_str(include_str!("fixtures/normalize-phrases.json")).unwrap();
    assert!(cases.len() > 1500);
    let wrong: Vec<String> = cases.iter().filter(|(phrase, want)| normalize_phrase(phrase) != *want).map(|(phrase, want)| format!("{phrase:?}: {:?}, not {want:?}", normalize_phrase(phrase))).collect();
    assert!(wrong.is_empty(), "{} of {} differ: {:?}", wrong.len(), cases.len(), &wrong[..wrong.len().min(5)]);
}

#[tokio::test]
async fn a_phrase_resolves_to_one_garment_or_is_reported_ambiguous_never_guessed() {
    let mut store = MemStore::default();
    let blue = catalogue().get(OXFORD_BLUE).unwrap();
    let describe = [&blue.colour, &blue.fabric, &blue.maker, &blue.size].iter().filter_map(|v| v.as_deref()).collect::<Vec<_>>().join(" / ");

    // The maker's code is an alias: one exact match, with the facts that tell it apart.
    let (status, r) = get(&mut store, "/v1/wardrobe/resolve?phrase=PCF4339").await;
    assert_eq!(status, 200);
    assert_eq!(r, json!({"phrase": "PCF4339", "matches": [{"garmentId": OXFORD_BLUE, "name": "Lightweight oxford — blue", "matchedOn": "PCF4339", "distinguishing": describe}], "ambiguous": false}));
    // The name as the app sends it, percent-encoded with its dash: exact, so only that garment.
    let (_, r) = get(&mut store, "/v1/wardrobe/resolve?phrase=lightweight%20oxford%20%E2%80%94%20BLUE").await;
    assert_eq!((r["phrase"].clone(), r["matches"].as_array().unwrap().len(), r["ambiguous"].clone()), (json!("lightweight oxford — BLUE"), 1, json!(false)));
    // Words only (`+` is a space in a query string): every garment with an alias holding both words,
    // reported as ambiguous with what distinguishes them.
    let (_, r) = get(&mut store, "/v1/wardrobe/resolve?phrase=Lightweight+Oxford").await;
    let expected = catalogue().garments.iter().filter(|g| g.aliases.iter().any(|a| a.normalized.split(' ').any(|w| w == "lightweight") && a.normalized.split(' ').any(|w| w == "oxford"))).count();
    assert!(expected > 1);
    assert_eq!((r["matches"].as_array().unwrap().len(), r["ambiguous"].clone()), (expected, json!(true)));
    assert!(r["matches"].as_array().unwrap().iter().all(|m| !m["distinguishing"].as_str().unwrap().is_empty()));
    let ids: Vec<&str> = r["matches"].as_array().unwrap().iter().map(|m| m["garmentId"].as_str().unwrap()).collect();
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "in garment-ID order, as the TypeScript query reads them");
    assert!(r["matches"].as_array().unwrap().iter().all(|m| m["matchedOn"] == m["name"]), "matched on the first alias that holds the words: the name");
    // A whole word is needed: "oxfor" names nothing, and nothing is made up to match.
    let (_, r) = get(&mut store, "/v1/wardrobe/resolve?phrase=lightweight%20oxfor").await;
    assert_eq!(r["matches"], json!([]));
    let (_, r) = get(&mut store, "/v1/wardrobe/resolve?phrase=Gucci%20horsebit%20loafers").await;
    assert_eq!((r["matches"].clone(), r["ambiguous"].clone()), (json!([]), json!(false)));
    // Each sheet row merged into a garment keeps its own name: the second pair resolves to the one garment.
    for (phrase, matched) in [("Di+Sondrio+walnut+chino+(pair+2)", "Di Sondrio walnut chino (pair 2)"), ("Di+Sondrio+walnut+chino+(pair+1)", "Di Sondrio walnut chino (pair 1)")] {
        let (_, r) = get(&mut store, &format!("/v1/wardrobe/resolve?phrase={phrase}")).await;
        let matches = r["matches"].as_array().unwrap();
        assert_eq!((matches.len(), matches[0]["garmentId"].clone(), matches[0]["matchedOn"].clone(), r["ambiguous"].clone()), (1, json!("gmt_ff25dfaf5876e58a551fe11d"), json!(matched), json!(false)), "{phrase}");
    }
    // Punctuation alone normalizes to nothing: no match, not every garment.
    let (_, r) = get(&mut store, "/v1/wardrobe/resolve?phrase=%E2%80%94").await;
    assert_eq!(r["matches"], json!([]));
    // An assistant reads the same.
    let (status, r) = send(&mut store, "GET", "/v1/wardrobe/resolve?phrase=pcf4339", b"", ASSISTANT_TOKEN).await;
    assert_eq!((status, r["matches"][0]["garmentId"].clone()), (200, json!(OXFORD_BLUE)));

    for bad in ["/v1/wardrobe/resolve", "/v1/wardrobe/resolve?phrase=", "/v1/wardrobe/resolve?phrase=%ZZ"] {
        let (status, e) = get(&mut store, bad).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{bad}: {e}");
    }
    let (status, _) = get(&mut store, &format!("/v1/wardrobe/resolve?phrase={}", "a".repeat(201))).await;
    assert_eq!(status, 400);
    let (status, _) = get(&mut store, &format!("/v1/wardrobe/resolve?phrase={}", "a".repeat(200))).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn a_selector_shows_exactly_the_garments_a_bulk_edit_would_touch() {
    let mut store = MemStore::default();
    let (status, s) = select(&mut store, json!({"category": "socks"})).await;
    assert_eq!(status, 200);
    assert_eq!((s["count"].clone(), s["wardrobeRevision"].clone()), (json!(15), json!(0)));
    let names: Vec<&str> = s["garments"].as_array().unwrap().iter().map(|g| g["name"].as_str().unwrap()).collect();
    let mut sorted = names.clone();
    sorted.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    assert_eq!(names, sorted, "ordered by name within the category");
    assert!(s["garments"].as_array().unwrap().iter().all(|g| g["category"] == "socks" && g["version"] == 1));

    // Every criterion must match; search reads names, makers, products, colours, fabrics and aliases.
    let (_, s) = select(&mut store, json!({"careChannel": "handwash", "search": "merino grey"})).await;
    assert!(s["garments"].as_array().unwrap().iter().any(|g| g["garmentId"] == SOCK_GREY));
    assert!(s["garments"].as_array().unwrap().iter().all(|g| g["category"] == "socks"));
    let (_, s) = select(&mut store, json!({"search": "PCF4339"})).await;
    assert_eq!(s["garments"], json!([{"garmentId": OXFORD_BLUE, "version": 1, "name": "Lightweight oxford — blue", "category": "shirt"}]));
    let (_, s) = select(&mut store, json!({"category": "shirt", "colour": "NAVY"})).await;
    assert!(s["count"].as_u64().unwrap() > 0);
    for g in s["garments"].as_array().unwrap() {
        let colour = catalogue().get(g["garmentId"].as_str().unwrap()).unwrap().colour.clone().unwrap_or_default();
        assert!(colour.to_lowercase().contains("navy"), "{colour}");
    }
    // Keys the selector does not know are ignored, as the contract's parser does.
    let (_, s) = select(&mut store, json!({"category": "belt", "note": "ignored"})).await;
    assert!(s["count"].as_u64().unwrap() > 0);

    // Naming a garment that does not exist refuses the whole selection.
    let (status, e) = select(&mut store, json!({"garmentIds": [OXFORD_BLUE, "gmt_not_a_garment", "gmt_not_a_garment"]})).await;
    assert_eq!((status, e["error"]["code"].clone(), e["error"]["details"]["missing"].clone()), (404, json!("not_found"), json!(["gmt_not_a_garment"])));
    assert_eq!(e["error"]["message"], "unknown garment: gmt_not_a_garment; nothing was written");
    for bad in [json!({}), json!({"category": null}), json!({"category": "hats"}), json!({"garmentIds": []}), json!({"search": ""}), json!({"acquisition": "disposed"}), json!([1])] {
        let (status, e) = select(&mut store, bad.clone()).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{bad}");
    }
    let (status, _) = send(&mut store, "POST", "/v1/wardrobe/selection", b"not json", OWNER_TOKEN).await;
    assert_eq!(status, 400);

    // The versions are the garments' current ones, with the wardrobe revision they were read at.
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0001").await;
    let (_, s) = select(&mut store, json!({"garmentIds": [OXFORD_BLUE]})).await;
    let (_, w) = get(&mut store, "/v1/wardrobe?category=shirt").await;
    let listed = w["items"].as_array().unwrap().iter().find(|i| i["garmentId"] == OXFORD_BLUE).unwrap()["version"].clone();
    assert_eq!((s["garments"][0]["version"].clone(), s["wardrobeRevision"].clone()), (listed, json!(1)));
}

#[tokio::test]
async fn availability_states_what_is_known_and_what_is_only_estimated() {
    let mut store = MemStore::default();
    let s = availability(&mut store, "2026-09-13").await;
    assert_eq!((s["modelVersion"].clone(), s["forDate"].clone(), s["lastBaseline"].clone()), (json!("availability-estimator/1.0.0"), json!("2026-09-13"), Value::Null));
    assert_eq!(s["parameters"], json!({"pUseBoard": 0.85, "pFollowSelection": 0.9, "parameterStatus": "hypothesis"}));
    let garments = s["garments"].as_array().unwrap();
    assert_eq!(garments.len(), 127);
    let keys: Vec<(String, String)> = garments.iter().map(|g| {
        let c = catalogue().get(g["garmentId"].as_str().unwrap()).unwrap();
        (c.category.clone(), c.name.clone())
    }).collect();
    assert!(keys.windows(2).all(|w| (w[0].0.as_bytes(), w[0].1.as_bytes()) <= (w[1].0.as_bytes(), w[1].1.as_bytes())), "category, then name");

    // Imported and never washed since: offerable, as an estimate under the import prior.
    assert_eq!(of(&s, OXFORD_BLUE), &json!({
        "garmentId": OXFORD_BLUE, "status": "estimated", "hardExcluded": false, "pAvailable": 0.8, "inferredWear": [],
        "reasons": ["import_cleanliness_unverified"], "restrictionIds": [], "acquisition": "owned", "planningPolicy": "normal",
        "balances": [{"bucket": "clean", "ref": "", "quantity": 1}], "cleanObserved": 1,
        "basis": ["1 clean unit at home (ledger balance as imported; no wash or return has been reported for it)", "cleanliness imported without an observation; treated as an estimate until a laundry baseline or owner report"],
    }));
    // Never laundered: present is wearable.
    let nb = of(&s, NB_GREY);
    assert_eq!((nb["status"].clone(), nb["pAvailable"].clone(), nb["basis"].clone()), (json!("available"), json!(1), json!(["1 clean unit at home (observed ledger balance)"])));
    // The healing restriction excludes the welted pair, by its ID.
    let reims = of(&s, REIMS);
    assert_eq!((reims["status"].clone(), reims["hardExcluded"].clone(), reims["pAvailable"].clone(), reims["restrictionIds"].clone(), reims["basis"].clone()), (json!("unavailable"), json!(true), json!(0), json!(["rst_profile_sneakers_only"]), json!(["excluded: restricted"])));
    let bed = of(&s, BED_SOCK);
    assert_eq!((bed["status"].clone(), bed["reasons"].clone()), (json!("conditional"), json!(["import_cleanliness_unverified", "indoor_only"])));

    // A report changes what is known: in the wash is unavailable; washed since is observed clean.
    run(&mut store, OWNER, T0, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_PINK}]}), "dirty-0001").await;
    let pink = of(&availability(&mut store, "2026-09-13").await, OXFORD_PINK).clone();
    assert_eq!((pink["status"].clone(), pink["reasons"].clone(), pink["balances"].clone()), (json!("unavailable"), json!(["no_units_at_home", "observed_dirty"]), json!([{"bucket": "dirty", "ref": "", "quantity": 1}])));
    run(&mut store, OWNER, T0 + HOUR, "care.washed", json!({"items": [{"garmentId": OXFORD_PINK}]}), "washed-0001").await;
    let pink = of(&availability(&mut store, "2026-09-13").await, OXFORD_PINK).clone();
    assert_eq!((pink["status"].clone(), pink["pAvailable"].clone(), pink["reasons"].clone(), pink["basis"].clone()), (json!("available"), json!(1), json!([]), json!(["1 clean unit at home (observed ledger balance)"])));

    for bad in ["/v1/availability?date=2026-02-30", "/v1/availability?date=tomorrow"] {
        let (status, e) = get(&mut store, bad).await;
        assert_eq!((status, e["error"]["code"].clone()), (400, json!("invalid_command")), "{bad}");
    }
    // Without a date, the owner's day in London.
    let (_, today) = get(&mut store, "/v1/availability").await;
    assert_eq!(today["forDate"], "2026-09-13");
}

#[tokio::test]
async fn offered_outfits_that_were_not_reported_lower_availability_until_a_wear_resolves_them() {
    let mut store = MemStore::default();
    let board = publish(&mut store, T0, "2026-09-11", "publish-0001").await;
    let board_id = board["result"]["boardId"].as_str().unwrap().to_string();

    // Two unchosen options at pUse 0.85: each garment of one option was worn with probability 0.425.
    let s = availability(&mut store, "2026-09-13").await;
    let blue = of(&s, OXFORD_BLUE);
    assert_eq!(inferred(blue), vec![("2026-09-11".to_string(), 0.425)]);
    assert_eq!(blue["reasons"], json!(["import_cleanliness_unverified", "estimated_possibly_worn"]));
    assert_eq!(blue["basis"][2], "offered on 1 unreported day since the last laundry baseline");
    // One unit: available only if not worn, under the import prior.
    assert!(close(p(blue), (1.0 - 0.425) * 0.8), "{}", p(blue));
    // Two pairs: one unreported wear still leaves one.
    assert!(close(p(of(&s, SOCK_BISCUIT)), 0.8));
    assert_eq!(inferred(of(&s, SOCK_BISCUIT)).len(), 1);
    // Never laundered: wearing it leaves it wearable, so nothing is inferred.
    assert_eq!((of(&s, NB_GREY)["status"].clone(), of(&s, NB_GREY)["inferredWear"].clone()), (json!("available"), json!([])));
    // The board's own day is not before itself: nothing is inferred for a fresh wear that day.
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-11").await, OXFORD_BLUE)), vec![]);
    // Older than the pattern horizon, an offer no longer counts.
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-26").await, OXFORD_BLUE)), vec![]);
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-25").await, OXFORD_BLUE)).len(), 1);

    // A choice moves the probability to the chosen option.
    let first = board["result"]["optionIds"][0].as_str().unwrap().to_string();
    let today = wardrobe::api::read_today(&mut store, T0, Some("2026-09-11")).await.unwrap();
    let blue_option = today["board"]["options"].as_array().unwrap().iter().find(|o| o["garments"].as_array().unwrap().iter().any(|g| g["garmentId"] == OXFORD_BLUE)).unwrap()["optionId"].as_str().unwrap().to_string();
    assert!(!first.is_empty());
    run(&mut store, OWNER, T0 + HOUR, "board.select", json!({"boardId": board_id, "optionId": blue_option}), "select-0001").await;
    let s = availability(&mut store, "2026-09-13").await;
    assert_eq!(inferred(of(&s, OXFORD_BLUE)), vec![("2026-09-11".to_string(), 0.9)]);
    assert_eq!(inferred(of(&s, OXFORD_PINK)), vec![]);
    assert!(!of(&s, OXFORD_PINK)["reasons"].as_array().unwrap().contains(&json!("estimated_possibly_worn")));

    // A second day's board: the biscuit pair is exposed twice and is gone only if worn both days.
    publish(&mut store, T0 + 2 * HOUR, "2026-09-12", "publish-0002").await;
    let s = availability(&mut store, "2026-09-13").await;
    assert_eq!(inferred(of(&s, SOCK_BISCUIT)), vec![("2026-09-11".to_string(), 0.9), ("2026-09-12".to_string(), 0.425)]);
    assert!(close(p(of(&s, SOCK_BISCUIT)), (1.0 - 0.9 * 0.425) * 0.8), "{}", p(of(&s, SOCK_BISCUIT)));

    // The owner reports the 11th: the observation replaces that day's uncertainty, and the worn shirt
    // is in the hamper.
    let wear = run(&mut store, OWNER, T0 + 30 * HOUR, "wear.record", json!({"wearingDate": "2026-09-11", "garmentIds": [OXFORD_BLUE]}), "wear-0001").await;
    let s = availability(&mut store, "2026-09-13").await;
    let blue = of(&s, OXFORD_BLUE);
    assert_eq!((blue["status"].clone(), blue["reasons"].clone()), (json!("unavailable"), json!(["no_units_at_home", "observed_dirty"])));
    assert_eq!(inferred(of(&s, SOCK_BISCUIT)), vec![("2026-09-12".to_string(), 0.425)]);
    assert!(close(p(of(&s, SOCK_BISCUIT)), 0.8));
    assert_eq!(inferred(of(&s, OXFORD_PINK)), vec![("2026-09-12".to_string(), 0.425)]);

    // Undone, the report no longer stands, and the day's options are uncertain again.
    run(&mut store, OWNER, T0 + 31 * HOUR, "command.undo", json!({"commandId": wear["commandId"]}), "undo-0001").await;
    let s = availability(&mut store, "2026-09-13").await;
    assert_eq!(inferred(of(&s, SOCK_BISCUIT)), vec![("2026-09-11".to_string(), 0.9), ("2026-09-12".to_string(), 0.425)]);
    assert_eq!(of(&s, OXFORD_BLUE)["status"], "estimated");
}

#[tokio::test]
async fn a_reported_wash_of_every_unit_ends_the_estimate_from_earlier_offers() {
    // Offered on the 11th and not reported; in the wash and washed on the 12th: the shirt is known clean,
    // so the offer before the wash no longer counts against it (it read 0.575 before this was fixed).
    let mut store = MemStore::default();
    publish(&mut store, T0, "2026-09-11", "publish-0001").await;
    let before = availability(&mut store, "2026-09-13").await;
    assert_eq!(inferred(of(&before, OXFORD_BLUE)).len(), 1);
    let wash_day = T0 + 2 * 24 * HOUR;
    run(&mut store, OWNER, wash_day, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0001").await;
    run(&mut store, OWNER, wash_day + HOUR, "care.washed", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "washed-0001").await;
    let s = availability(&mut store, "2026-09-13").await;
    let blue = of(&s, OXFORD_BLUE);
    assert_eq!((blue["status"].clone(), blue["pAvailable"].clone(), blue["inferredWear"].clone(), blue["reasons"].clone()), (json!("available"), json!(1), json!([]), json!([])));
    // An offer on the day of the wash itself still counts: the wear may have come after it.
    publish(&mut store, wash_day + 2 * HOUR, "2026-09-12", "publish-0002").await;
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-13").await, OXFORD_BLUE)), vec![("2026-09-12".to_string(), 0.425)]);

    // One of two pairs washed says nothing about the other: the earlier offer still counts for them.
    let mut store = MemStore::default();
    publish(&mut store, T0, "2026-09-11", "publish-0001").await;
    run(&mut store, OWNER, wash_day, "care.mark_dirty", json!({"items": [{"garmentId": SOCK_BISCUIT}]}), "dirty-0001").await;
    run(&mut store, OWNER, wash_day + HOUR, "care.washed", json!({"items": [{"garmentId": SOCK_BISCUIT}]}), "washed-0001").await;
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-13").await, SOCK_BISCUIT)).len(), 1);
    // Undone, the wash no longer stands, and the offer counts again.
    let mut store = MemStore::default();
    publish(&mut store, T0, "2026-09-11", "publish-0001").await;
    run(&mut store, OWNER, wash_day, "care.mark_dirty", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "dirty-0001").await;
    let washed = run(&mut store, OWNER, wash_day + HOUR, "care.washed", json!({"items": [{"garmentId": OXFORD_BLUE}]}), "washed-0001").await;
    run(&mut store, OWNER, wash_day + 2 * HOUR, "command.undo", json!({"commandId": washed["commandId"]}), "undo-0001").await;
    let blue = of(&availability(&mut store, "2026-09-13").await, OXFORD_BLUE).clone();
    assert_eq!((blue["status"].clone(), inferred(&blue).len()), (json!("unavailable"), 1), "back in the hamper, and the offer counts again");
}

#[tokio::test]
async fn a_day_already_reported_when_its_board_is_published_carries_no_estimate() {
    // Reported first (the jacket, in neither option), then the board: no option set is written.
    let mut store = MemStore::default();
    let wear = run(&mut store, OWNER, T0, "wear.record", json!({"wearingDate": "2026-09-10", "garmentIds": [GAMES_JACKET]}), "wear-0001").await;
    publish(&mut store, T0 + HOUR, "2026-09-10", "publish-0001").await;
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-11").await, OXFORD_BLUE)), vec![]);
    // Undoing that report afterwards does not create the set the board never wrote.
    run(&mut store, OWNER, T0 + 2 * HOUR, "command.undo", json!({"commandId": wear["commandId"]}), "undo-0001").await;
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-11").await, OXFORD_BLUE)), vec![]);
    // The next revision is written with no wear of that day standing, so its options are a set again.
    publish(&mut store, T0 + 3 * HOUR, "2026-09-10", "publish-0002").await;
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-11").await, OXFORD_BLUE)).len(), 1);

    // The board first, then a report of something no option contained: the options stay uncertain.
    let mut store = MemStore::default();
    publish(&mut store, T0, "2026-09-10", "publish-0001").await;
    run(&mut store, OWNER, T0 + HOUR, "wear.record", json!({"wearingDate": "2026-09-10", "garmentIds": [GAMES_JACKET]}), "wear-0001").await;
    assert_eq!(inferred(of(&availability(&mut store, "2026-09-11").await, OXFORD_BLUE)), vec![("2026-09-10".to_string(), 0.425)]);
}
