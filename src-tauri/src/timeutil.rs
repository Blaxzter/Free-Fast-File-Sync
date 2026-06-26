//! Tiny time helpers: RFC3339 UTC timestamps without pulling in a date crate.
//! The project deliberately avoids heavyweight date dependencies (e.g. `chrono`);
//! this is the shared, tested implementation that `store.rs` (job timestamps) and
//! `runlog.rs` (run records) both use.

/// Current time as an RFC3339 UTC string at second precision, e.g.
/// `2026-06-26T14:03:09Z`. A clock before the Unix epoch (impossible in practice)
/// falls back to the epoch.
pub fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    rfc3339_from_unix_secs(secs)
}

/// Format a Unix epoch second count as an RFC3339 UTC string.
pub fn rfc3339_from_unix_secs(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Howard Hinnant's days-from-civil, inverted: civil (y, m, d) from days since the
/// Unix epoch.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_unix_zero() {
        assert_eq!(rfc3339_from_unix_secs(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn known_timestamps_round_trip() {
        // 2000-01-01T00:00:00Z — the well-known Y2K epoch second.
        assert_eq!(rfc3339_from_unix_secs(946_684_800), "2000-01-01T00:00:00Z");
        // 2026-06-26T00:00:00Z = 20630 days * 86400 s/day.
        assert_eq!(
            rfc3339_from_unix_secs(1_782_432_000),
            "2026-06-26T00:00:00Z"
        );
        // …plus 14:03:09 into the day.
        assert_eq!(
            rfc3339_from_unix_secs(1_782_432_000 + 14 * 3600 + 3 * 60 + 9),
            "2026-06-26T14:03:09Z"
        );
    }

    #[test]
    fn now_has_rfc3339_shape() {
        let s = now_rfc3339();
        assert_eq!(s.len(), 20, "YYYY-MM-DDТHH:MM:SSZ is 20 chars: {s}");
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }
}
