//! Deterministic JSON (object keys sorted, as `canonicalJson` in
//! packages/domain/src/util.ts) so a request hash does not depend on the key
//! order a client happened to send.
//!
//! Numbers: the command service accepts only whole numbers from 0 to
//! 2^53 - 1 anywhere in a command ([`numbers_are_whole`]). JavaScript writes
//! every such number as its plain integer digits, however the client wrote it
//! (`1`, `1.0`, `1e0`), and so does [`canonical`]; that is what makes the
//! request hash agree with the TypeScript service's. Other numbers are
//! refused before they are ever hashed.
//!
//! Keys: the command service accepts only plain keys ([`keys_are_plain`]):
//! printable ASCII, not all digits. For those, JavaScript's `sort()` (UTF-16
//! code-unit order) is byte order, and `JSON.stringify` keeps the sorted
//! order (it moves only array-index keys, which are all digits). Keys are
//! still sorted by UTF-16 code units here, as JavaScript does.

use ferrite_app::serde_json::{self, Value};

/// `Number.MAX_SAFE_INTEGER`: the largest integer a JavaScript number holds exactly.
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// A JSON number that is a whole number from 0 to [`MAX_SAFE`], however it
/// was written (`1`, `1.0`, `1e0`), as JavaScript integer validation accepts it.
pub fn whole(v: &Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return (n <= MAX_SAFE).then_some(n);
    }
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f >= 0.0 && f <= MAX_SAFE as f64).then_some(f as u64)
}

/// Whether every number anywhere in `v` is [`whole`].
pub fn numbers_are_whole(v: &Value) -> bool {
    match v {
        Value::Number(_) => whole(v).is_some(),
        Value::Array(items) => items.iter().all(numbers_are_whole),
        Value::Object(map) => map.values().all(numbers_are_whole),
        _ => true,
    }
}

/// Whether every object key anywhere in `v` is printable ASCII (space to
/// `~`), non-empty and not made only of digits.
pub fn keys_are_plain(v: &Value) -> bool {
    match v {
        Value::Array(items) => items.iter().all(keys_are_plain),
        Value::Object(map) => map.iter().all(|(k, x)| {
            !k.is_empty() && k.bytes().all(|b| (0x20..=0x7e).contains(&b)) && !k.bytes().all(|b| b.is_ascii_digit()) && keys_are_plain(x)
        }),
        _ => true,
    }
}

pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            // JavaScript's default sort: UTF-16 code units.
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write(&map[k.as_str()], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(v, out);
            }
            out.push(']');
        }
        // Whole numbers as JavaScript writes them; anything else is refused by
        // the command service before hashing, and written as serde does here.
        Value::Number(_) => match whole(value) {
            Some(n) => out.push_str(&n.to_string()),
            None => out.push_str(&serde_json::to_string(value).unwrap_or_default()),
        },
        other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn key_order_does_not_change_the_text() {
        let a = parse(r#"{"b":1,"a":{"y":[1,{"q":2,"p":1}],"x":null}}"#);
        let b = parse(r#"{"a":{"x":null,"y":[1,{"p":1,"q":2}]},"b":1}"#);
        assert_eq!(canonical(&a), r#"{"a":{"x":null,"y":[1,{"p":1,"q":2}]},"b":1}"#);
        assert_eq!(canonical(&a), canonical(&b));
    }

    #[test]
    fn whole_numbers_hash_the_same_however_they_are_written() {
        // Each expected text is what node prints for JSON.stringify(JSON.parse(input)).
        for (input, want) in [("1", "1"), ("1.0", "1"), ("1e0", "1"), ("-0.0", "0"), ("1e15", "1000000000000000"), ("9007199254740991", "9007199254740991")] {
            assert_eq!(canonical(&parse(input)), want, "{input}");
        }
    }

    #[test]
    fn only_safe_whole_numbers_are_accepted() {
        let n = |s: &str| whole(&parse(s));
        assert_eq!((n("3"), n("3.0"), n("3e0")), (Some(3), Some(3), Some(3)));
        assert_eq!((n("3.5"), n("-1"), n("9007199254740992"), n("1e300"), n("\"3\"")), (None, None, None, None, None));
        assert!(numbers_are_whole(&parse(r#"{"a":[1,2.0,{"b":null}],"c":"x"}"#)));
        assert!(!numbers_are_whole(&parse(r#"{"a":[1,{"b":1424953923781206.25}]}"#)));
        assert!(!numbers_are_whole(&parse(r#"{"a":-2}"#)));
    }

    #[test]
    fn keys_sort_by_utf16_code_units_and_only_plain_keys_are_accepted() {
        // U+FF5E (one UTF-16 unit, 0xFF5E) sorts after U+1F600 (surrogates 0xD83D...) in JavaScript.
        let v = parse("{\"\u{ff5e}\":1,\"\u{1f600}\":2}");
        assert_eq!(canonical(&v), "{\"\u{1f600}\":2,\"\u{ff5e}\":1}");
        assert!(keys_are_plain(&parse(r#"{"type":"x","payload":{"items":[{"garmentId":"a"}]},"garment:gmt_1":1}"#)));
        assert!(!keys_are_plain(&parse(r#"{"a":{"10":1}}"#)));
        assert!(!keys_are_plain(&v));
        assert!(!keys_are_plain(&parse(r#"{"":1}"#)));
    }
}
