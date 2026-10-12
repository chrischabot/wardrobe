//! UTC instants as the TypeScript contracts write them: ISO 8601 with a `Z`,
//! milliseconds only when they are not zero (`toInstant` in
//! packages/domain/src/util.ts), and parsing of the `Instant` contract pattern
//! `YYYY-MM-DDTHH:MM:SS(.s{1,3})?Z` for real dates only.

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

/// `ms` since the epoch as an instant string.
pub fn instant(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    let (h, mi, s) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    if millis == 0 {
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
    } else {
        format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{millis:03}Z")
    }
}

fn digits(s: &[u8]) -> Option<i64> {
    if s.is_empty() || !s.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut v: i64 = 0;
    for c in s {
        v = v * 10 + i64::from(c - b'0');
    }
    Some(v)
}

/// Parse an instant in the contract's pattern; `None` for anything else,
/// including dates that do not exist.
pub fn parse_instant(text: &str) -> Option<u64> {
    let b = text.as_bytes();
    if b.len() < 20 || b[b.len() - 1] != b'Z' {
        return None;
    }
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let y = digits(&b[0..4])?;
    let mo = digits(&b[5..7])?;
    let d = digits(&b[8..10])?;
    let h = digits(&b[11..13])?;
    let mi = digits(&b[14..16])?;
    let s = digits(&b[17..19])?;
    let frac = &b[19..b.len() - 1];
    let millis = if frac.is_empty() {
        0
    } else {
        if frac[0] != b'.' || frac.len() < 2 || frac.len() > 4 {
            return None;
        }
        let f = &frac[1..];
        let v = digits(f)?;
        match f.len() {
            1 => v * 100,
            2 => v * 10,
            _ => v,
        }
    };
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    let total = (days * 86_400 + h * 3600 + mi * 60 + s) * 1000 + millis;
    u64::try_from(total).ok()
}

/// A `LocalDate` (`YYYY-MM-DD`, a real date) as days since 1970-01-01.
pub fn parse_local_date(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (digits(&b[0..4])?, digits(&b[5..7])?, digits(&b[8..10])?);
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Days since 1970-01-01 as a `LocalDate`.
pub fn local_date(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The earliest calendar date anywhere on Earth at `ms` (UTC-12): a date
/// before it is past for every owner, whatever his timezone.
pub fn earliest_day(ms: u64) -> i64 {
    ((ms / 1000) as i64 - 12 * 3600).div_euclid(86_400)
}

/// The latest calendar date anywhere on Earth at `ms` (UTC+14).
pub fn latest_day(ms: u64) -> i64 {
    ((ms / 1000) as i64 + 14 * 3600).div_euclid(86_400)
}

/// The owner's timezone: the specification's default setting (`DEFAULT_OWNER_SETTINGS.timezone`),
/// the one `GET /v1/settings` reports. No settings command is ported, so it is fixed.
pub const OWNER_TIMEZONE: &str = "Europe/London";

/// The last Sunday of month `m` of year `y`, as days since 1970-01-01 (a Thursday).
fn last_sunday(y: i64, m: i64) -> i64 {
    let last = days_from_civil(y, m, days_in_month(y, m));
    last - (last + 4).rem_euclid(7)
}

/// Europe/London's offset from UTC at `ms`, in seconds: British Summer Time (UTC+1) from 01:00 UTC
/// on the last Sunday of March to 01:00 UTC on the last Sunday of October (the rule in force since
/// 1996), Greenwich Mean Time otherwise.
pub fn london_offset_secs(ms: u64) -> i64 {
    let secs = (ms / 1000) as i64;
    let (y, _, _) = civil_from_days(secs.div_euclid(86_400));
    let starts = last_sunday(y, 3) * 86_400 + 3600;
    let ends = last_sunday(y, 10) * 86_400 + 3600;
    if (starts..ends).contains(&secs) { 3600 } else { 0 }
}

/// The owner's calendar day at `ms` (in `OWNER_TIMEZONE`), as days since 1970-01-01: what
/// `localDateOf(nowMs, owner.settings.timezone)` gives in the TypeScript service.
pub fn owner_day(ms: u64) -> i64 {
    ((ms / 1000) as i64 + london_offset_secs(ms)).div_euclid(86_400)
}

/// "Friday 16 October".
pub fn day_line(days: i64) -> String {
    const WEEKDAYS: [&str; 7] = ["Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"];
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let (_, m, d) = civil_from_days(days);
    format!("{} {d} {}", WEEKDAYS[days.rem_euclid(7) as usize], MONTHS[(m - 1) as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_dates() {
        assert_eq!(parse_local_date("2026-10-16"), Some(days_from_civil(2026, 10, 16)));
        assert_eq!(local_date(parse_local_date("2026-10-16").unwrap() + 16), "2026-11-01");
        assert_eq!(parse_local_date("2026-02-29"), None);
        assert_eq!(parse_local_date("2026-10-16T00:00:00Z"), None);
        assert_eq!(parse_local_date("2026-1-16"), None);
        assert_eq!(day_line(parse_local_date("2026-10-16").unwrap()), "Friday 16 October");
        // The earliest calendar date anywhere at 2026-10-16T05:00Z is the 15th (UTC-12).
        assert_eq!(local_date(earliest_day(parse_instant("2026-10-16T05:00:00Z").unwrap())), "2026-10-15");
    }

    #[test]
    fn the_owners_day_follows_british_summer_time() {
        let at = |s: &str| parse_instant(s).unwrap();
        // 2026: summer time from 29 March 01:00 UTC to 25 October 01:00 UTC.
        assert_eq!(local_date(last_sunday(2026, 3)), "2026-03-29");
        assert_eq!(local_date(last_sunday(2026, 10)), "2026-10-25");
        assert_eq!(london_offset_secs(at("2026-03-29T00:59:59Z")), 0);
        assert_eq!(london_offset_secs(at("2026-03-29T01:00:00Z")), 3600);
        assert_eq!(london_offset_secs(at("2026-10-25T00:59:59Z")), 3600);
        assert_eq!(london_offset_secs(at("2026-10-25T01:00:00Z")), 0);
        // Half past eleven at night UTC is already tomorrow in London in summer, still today in winter.
        assert_eq!(local_date(owner_day(at("2026-06-30T23:30:00Z"))), "2026-07-01");
        assert_eq!(local_date(owner_day(at("2026-12-31T23:30:00Z"))), "2026-12-31");
        assert_eq!(local_date(owner_day(at("2027-03-28T00:30:00Z"))), "2027-03-28");
    }

    #[test]
    fn formats_like_to_instant() {
        // Expected values are JavaScript's `new Date(ms).toISOString()` (what `toInstant` uses).
        assert_eq!(instant(0), "1970-01-01T00:00:00Z");
        assert_eq!(instant(1_789_000_000_000), "2026-09-10T00:26:40Z");
        assert_eq!(instant(1_789_000_000_250), "2026-09-10T00:26:40.250Z");
        assert_eq!(instant(951_782_400_000), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn parses_the_contract_pattern_only() {
        // Expected values are JavaScript's `Date.parse`.
        assert_eq!(parse_instant("2026-09-10T00:26:40Z"), Some(1_789_000_000_000));
        assert_eq!(parse_instant("2026-09-10T00:26:40.25Z"), Some(1_789_000_000_250));
        assert_eq!(parse_instant("2000-02-29T00:00:00Z"), Some(951_782_400_000));
        assert_eq!(parse_instant("2026-02-29T00:00:00Z"), None, "not a real date");
        assert_eq!(parse_instant("2026-09-09T21:46:40+01:00"), None, "UTC only");
        assert_eq!(parse_instant("2026-09-09 21:46:40Z"), None);
        assert_eq!(parse_instant("2026-09-09T21:46:40.1234Z"), None);
    }
}
