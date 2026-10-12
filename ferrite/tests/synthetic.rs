//! Board rules the owner's real inventory cannot exercise, on a clearly
//! synthetic catalogue: the real seed plus invented garments (IDs `syn_*`)
//! that the owner does not own. The real inventory has no one-piece garment
//! and a single accessory, so these cases exist only here.
//!
//! - A jacket over a one-piece is held to the 14-16 C jacket rule: the
//!   one-piece itself must be of the required fabric class.
//! - A swap of a role the outfit fills twice (two accessories) is refused as
//!   ambiguous.

use ferrite_app::serde_json::{json, Value};
use wardrobe::board::{self, Day, Slot};
use wardrobe::ledger::{replay, Ctx};
use wardrobe::seed::{catalogue, Catalogue, Garment};

const T0: u64 = 1_789_000_000_000; // 2026-09-10T00:26:40Z
const DAY: &str = "2026-09-11";
const OXFORD_BLUE: &str = "gmt_3894b6a6295908d5e687af4f";
const AKITA_CREAM: &str = "gmt_0bd82c642c7606199361d3d4";
const SOCK_GREY: &str = "gmt_67d3228f744d17138e400729";
const NB_OLIVE: &str = "gmt_185ccf753d109848f21f7cec";
const BELT_BROWN: &str = "gmt_6335e17bcb19fb15f77c31bf";
const GAMES_JACKET: &str = "gmt_0573b00364cad2ee03e8b70f";
const POCKET_SQUARE: &str = "gmt_ba4e4b4619f0eac05412a17a";

fn synthetic() -> Catalogue {
    let real = catalogue();
    let base = |id: &str| real.get(id).expect("real seed garment").clone();
    let mut garments = real.garments.clone();
    let shirt = base(OXFORD_BLUE);
    let one_piece = |id: &str, fabric: &str| {
        let mut g: Garment = shirt.clone();
        g.id = id.into();
        g.name = format!("Synthetic one-piece ({fabric})");
        g.roles = vec!["one_piece".into()];
        g.attributes.insert("fabricClass".into(), json!(fabric));
        g
    };
    garments.push(one_piece("syn_one_piece_heavy", "heavy_oxford"));
    garments.push(one_piece("syn_one_piece_light", "lightweight_oxford"));
    let mut accessory = base(POCKET_SQUARE);
    accessory.id = "syn_accessory_2".into();
    accessory.name = "Synthetic second accessory".into();
    garments.push(accessory);
    Catalogue {
        garments,
        source_name: real.source_name.clone(),
        source_sha256: real.source_sha256.clone(),
        import_run_id: real.import_run_id.clone(),
        unit_count: real.unit_count,
        rules: real.rules.clone(),
        healing_restriction_id: real.healing_restriction_id.clone(),
    }
}

fn slots(pairs: &[(&str, &str)]) -> Vec<Slot> {
    pairs.iter().map(|(r, g)| Slot { role: r.to_string(), garment_id: g.to_string() }).collect()
}

#[test]
fn a_jacket_over_a_one_piece_is_held_to_the_jacket_rule() {
    let cat = synthetic();
    let day = Day { cat: &cat, stock: replay(&cat, &[]) };
    let outfit = |one: &str| slots(&[("one_piece", one), ("outer", GAMES_JACKET), ("socks", SOCK_GREY), ("footwear", NB_OLIVE)]);
    let heavy = board::validate(&day, &outfit("syn_one_piece_heavy"), &[], &[]);
    let jacket: Vec<_> = heavy.blocking().into_iter().filter(|v| v.code == "jacket_band_unverified").collect();
    assert_eq!(jacket.len(), 1, "{:?}", heavy.violations);
    assert!(jacket[0].garment_ids.contains(&"syn_one_piece_heavy".to_string()) && jacket[0].message.contains("Synthetic one-piece (heavy_oxford)"), "{:?}", jacket[0]);
    // Named by the owner, the jacket is admitted with the rule stated as an advisory.
    let named = board::validate(&day, &outfit("syn_one_piece_heavy"), &[], &[GAMES_JACKET.to_string()]);
    assert!(named.violations.iter().any(|v| v.code == "jacket_band_unverified" && !v.blocking));
    // A one-piece of the required class qualifies on its own.
    let light = board::validate(&day, &outfit("syn_one_piece_light"), &[], &[]);
    assert!(light.violations.iter().all(|v| v.code != "jacket_band_unverified"), "{:?}", light.violations);
}

#[test]
fn a_swap_of_a_role_the_outfit_fills_twice_is_refused_as_ambiguous() {
    let cat = synthetic();
    let day = Day { cat: &cat, stock: replay(&cat, &[]) };
    let ctx = Ctx { cat: &cat, command_id: "cmd_synthetic_publish_0001", now_ms: T0, occurred_at_ms: T0 };
    let outfit = json!({
        "slots": [
            {"role": "top", "garmentId": OXFORD_BLUE}, {"role": "bottom", "garmentId": AKITA_CREAM}, {"role": "belt", "garmentId": BELT_BROWN},
            {"role": "socks", "garmentId": SOCK_GREY}, {"role": "footwear", "garmentId": NB_OLIVE},
            {"role": "accessory", "garmentId": POCKET_SQUARE}, {"role": "accessory", "garmentId": "syn_accessory_2"},
        ],
        "explicitGarmentIds": [POCKET_SQUARE, "syn_accessory_2"],
        "reason": "",
    });
    let input = board::publish_input(&json!({"localDate": DAY, "requestedCount": 1, "options": [outfit]})).unwrap();
    let published = board::publish(&ctx, &day, None, input).unwrap();
    assert_eq!(published.plan.result["offered"], 1, "{}", published.plan.result);
    let option: Value = published.plan.result["optionIds"][0].clone();
    let ctx = Ctx { cat: &cat, command_id: "cmd_synthetic_swap_0001", now_ms: T0, occurred_at_ms: T0 };
    let payload = json!({"boardId": published.board.board_id, "optionId": option, "role": "accessory", "garmentId": POCKET_SQUARE});
    let e = board::swap(&ctx, &day, Some(&published.board), &payload).err().expect("refused");
    assert_eq!((e.code, e.details["role"].clone()), ("invalid_command", json!("accessory")));
    assert!(e.message.contains("ambiguous"), "{}", e.message);
    // A role it fills once is still swappable.
    let one = json!({"boardId": published.board.board_id, "optionId": option, "role": "belt"});
    assert!(board::swap(&ctx, &day, Some(&published.board), &one).is_ok());
}
