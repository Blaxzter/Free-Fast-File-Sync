//! A tiny, dependency-free 5-field cron evaluator
//! (`minute hour day-of-month month day-of-week`). The project deliberately avoids
//! date crates (see `timeutil`), so this hand-rolls parsing + next-run over integer
//! Unix seconds. Pure and fully unit-testable: feed a fixed `now` and assert the
//! next fire.
//!
//! Dialect: standard Vixie cron.
//! - fields: minute `0-59`, hour `0-23`, day-of-month `1-31`, month `1-12`,
//!   day-of-week `0-6` (0 = Sunday; `7` also accepted as Sunday).
//! - per field element: `*`, `a`, `a-b`, `*/n`, `a-b/n`, `a/n`, and comma lists of
//!   these.
//! - day-of-month / day-of-week: if BOTH are restricted, a match on EITHER fires
//!   (the classic cron OR rule); if one is `*`, only the other constrains.
//!
//! Times are evaluated in local wall-clock via a fixed UTC offset in minutes
//! (DST-naive by design — a documented v1 limitation; the offset is supplied by the
//! frontend at save time).

use crate::timeutil::civil_from_days;

const SECS_PER_MIN: i64 = 60;
const SECS_PER_DAY: i64 = 86_400;
/// Search horizon. If no minute within ~366 days matches, the expression is
/// unsatisfiable (e.g. `0 0 30 2 *` — Feb 30). Bounded so a bad cron can't spin.
const MAX_LOOKAHEAD_MIN: i64 = 366 * 24 * 60;

/// A parsed 5-field cron expression. Each time field is a bitmask of allowed values
/// (all maxima are < 64, so a `u64` per field suffices).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minute: u64, // bits 0..=59
    hour: u64,   // bits 0..=23
    dom: u64,    // bits 1..=31
    month: u64,  // bits 1..=12
    dow: u64,    // bits 0..=6  (Sun..Sat)
    /// Whether the day-of-month / day-of-week fields were restricted (not `*`),
    /// which selects the OR-vs-AND matching rule below.
    dom_restricted: bool,
    dow_restricted: bool,
}

impl Cron {
    /// Parse a standard 5-field cron string, or return a human-readable error.
    pub fn parse(expr: &str) -> Result<Cron, String> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(format!(
                "cron needs exactly 5 fields (minute hour day-of-month month day-of-week), got {}",
                fields.len()
            ));
        }
        Ok(Cron {
            minute: parse_field(fields[0], 0, 59, "minute")?,
            hour: parse_field(fields[1], 0, 23, "hour")?,
            dom: parse_field(fields[2], 1, 31, "day-of-month")?,
            month: parse_field(fields[3], 1, 12, "month")?,
            dow: parse_dow(fields[4])?,
            dom_restricted: fields[2] != "*",
            dow_restricted: fields[4] != "*",
        })
    }

    /// Does a given local civil minute match? `mo`/`d` are 1-based; `wd` is
    /// 0 = Sunday.
    fn matches(&self, mo: u32, d: u32, wd: u32, h: u32, mi: u32) -> bool {
        if !(bit(self.minute, mi) && bit(self.hour, h) && bit(self.month, mo)) {
            return false;
        }
        let dom_ok = bit(self.dom, d);
        let dow_ok = bit(self.dow, wd);
        match (self.dom_restricted, self.dow_restricted) {
            (true, true) => dom_ok || dow_ok, // classic cron OR
            (true, false) => dom_ok,
            (false, true) => dow_ok,
            (false, false) => true,
        }
    }

    /// Next fire STRICTLY AFTER `now_unix` (UTC seconds), evaluating the expression
    /// in local time given `offset_minutes` (local = UTC + offset). Returns the fire
    /// instant as UTC seconds, or `None` if unsatisfiable within the lookahead
    /// horizon. Fires land on `:00` seconds of a matching minute.
    pub fn next_after(&self, now_unix: i64, offset_minutes: i32) -> Option<i64> {
        let offset = offset_minutes as i64 * SECS_PER_MIN;
        let local_now = now_unix + offset;
        // Start at the next whole minute after `local_now` (strictly after "now",
        // so a match in the current minute doesn't double-fire).
        let mut min_idx = local_now.div_euclid(SECS_PER_MIN) + 1;
        for _ in 0..MAX_LOOKAHEAD_MIN {
            let local = min_idx * SECS_PER_MIN;
            let days = local.div_euclid(SECS_PER_DAY);
            let tod = local.rem_euclid(SECS_PER_DAY);
            let h = (tod / 3600) as u32;
            let mi = ((tod % 3600) / 60) as u32;
            let (_y, mo, d) = civil_from_days(days);
            // 1970-01-01 was a Thursday; Sunday = 0.
            let wd = ((days.rem_euclid(7)) + 4).rem_euclid(7) as u32;
            if self.matches(mo as u32, d as u32, wd, h, mi) {
                return Some(local - offset);
            }
            min_idx += 1;
        }
        None
    }
}

/// Is bit `v` set in `mask`? (Guards `v < 64` so a shift can never overflow.)
fn bit(mask: u64, v: u32) -> bool {
    v < 64 && (mask & (1u64 << v)) != 0
}

/// Parse one field into a bitmask over `[min, max]`. Supports `*`, `a`, `a-b`,
/// `*/n`, `a-b/n`, `a/n` (= `a-max/n`), and comma-separated lists of these.
fn parse_field(field: &str, min: u32, max: u32, name: &str) -> Result<u64, String> {
    if field.is_empty() {
        return Err(format!("{name}: empty field"));
    }
    let mut mask = 0u64;
    for part in field.split(',') {
        let (range_part, step) = match part.split_once('/') {
            Some((r, s)) => {
                let step: u32 = s.parse().map_err(|_| format!("{name}: bad step '{s}'"))?;
                if step == 0 {
                    return Err(format!("{name}: step must be > 0"));
                }
                (r, step)
            }
            None => (part, 1),
        };
        let (lo, hi) = if range_part == "*" {
            (min, max)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let a: u32 = a
                .parse()
                .map_err(|_| format!("{name}: bad range start '{a}'"))?;
            let b: u32 = b
                .parse()
                .map_err(|_| format!("{name}: bad range end '{b}'"))?;
            (a, b)
        } else {
            let n: u32 = range_part
                .parse()
                .map_err(|_| format!("{name}: bad value '{range_part}'"))?;
            // `a/step` steps from a to the max; a bare `a` is just a.
            if step > 1 {
                (n, max)
            } else {
                (n, n)
            }
        };
        if lo < min || hi > max || lo > hi {
            return Err(format!("{name}: '{part}' out of range {min}-{max}"));
        }
        let mut v = lo;
        while v <= hi {
            mask |= 1u64 << v;
            v += step;
        }
    }
    Ok(mask)
}

/// Day-of-week field: `0-6` (Sun..Sat), with `7` accepted as an alias for Sunday.
fn parse_dow(field: &str) -> Result<u64, String> {
    let mut mask = parse_field(field, 0, 7, "day-of-week")?;
    if bit(mask, 7) {
        mask |= 1 << 0; // fold 7 (Sunday) onto 0
        mask &= !(1 << 7);
    }
    Ok(mask)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeutil::rfc3339_from_unix_secs;

    /// 2026-01-01T00:00:00Z (a Thursday), cross-checked against `timeutil`.
    const JAN1: i64 = 1_767_225_600;

    fn fire_str(cron: &str, now: i64, offset: i32) -> String {
        let c = Cron::parse(cron).unwrap();
        rfc3339_from_unix_secs(c.next_after(now, offset).unwrap())
    }

    #[test]
    fn wildcard_fires_next_minute() {
        // 12:34:56 -> next whole minute 12:35:00.
        let now = JAN1 + 12 * 3600 + 34 * 60 + 56;
        assert_eq!(fire_str("* * * * *", now, 0), "2026-01-01T12:35:00Z");
    }

    #[test]
    fn daily_2am_utc() {
        assert_eq!(fire_str("0 2 * * *", JAN1, 0), "2026-01-01T02:00:00Z");
    }

    #[test]
    fn already_passed_today_rolls_to_tomorrow() {
        let now = JAN1 + 3 * 3600; // 03:00, past today's 02:00
        assert_eq!(fire_str("0 2 * * *", now, 0), "2026-01-02T02:00:00Z");
    }

    #[test]
    fn offset_shifts_local_evaluation() {
        // 03:30 LOCAL at UTC+2 == 01:30 UTC.
        assert_eq!(fire_str("30 3 * * *", JAN1, 120), "2026-01-01T01:30:00Z");
    }

    #[test]
    fn negative_offset_evaluates_west_of_utc() {
        // 23:00 LOCAL at UTC-5. Midnight UTC is 2025-12-31T19:00 local, so the next
        // 23:00 local is that same local day == 2026-01-01T04:00:00Z.
        assert_eq!(fire_str("0 23 * * *", JAN1, -300), "2026-01-01T04:00:00Z");
    }

    #[test]
    fn every_15_minutes() {
        let now = JAN1 + 7 * 60; // 00:07
        assert_eq!(fire_str("*/15 * * * *", now, 0), "2026-01-01T00:15:00Z");
    }

    #[test]
    fn step_from_offset_start() {
        // "5/15" in the minute field = 5, 20, 35, 50.
        let now = JAN1 + 6 * 60; // 00:06
        assert_eq!(fire_str("5/15 * * * *", now, 0), "2026-01-01T00:20:00Z");
    }

    #[test]
    fn dom_dow_or_rule_takes_the_earlier() {
        // "0 0 1 * 1" = midnight on the 1st OR any Monday. From Jan 2 (Fri), the
        // next Monday (Jan 5) beats the next 1st (Feb 1).
        let jan2 = JAN1 + SECS_PER_DAY;
        assert_eq!(fire_str("0 0 1 * 1", jan2, 0), "2026-01-05T00:00:00Z");
    }

    #[test]
    fn sunday_is_zero_and_seven() {
        // Jan 4 2026 is the first Sunday after Jan 1.
        let c0 = Cron::parse("0 0 * * 0").unwrap();
        let c7 = Cron::parse("0 0 * * 7").unwrap();
        let f0 = c0.next_after(JAN1, 0).unwrap();
        let f7 = c7.next_after(JAN1, 0).unwrap();
        assert_eq!(rfc3339_from_unix_secs(f0), "2026-01-04T00:00:00Z");
        assert_eq!(f0, f7, "0 and 7 both mean Sunday");
    }

    #[test]
    fn range_and_list() {
        // Weekdays (Mon-Fri) at 09:00; from Sat Jan 3 the next is Mon Jan 5.
        let sat = JAN1 + 2 * SECS_PER_DAY; // Jan 3 is a Saturday
        assert_eq!(fire_str("0 9 * * 1-5", sat, 0), "2026-01-05T09:00:00Z");
    }

    #[test]
    fn unsatisfiable_returns_none() {
        // Feb 30 never occurs.
        let c = Cron::parse("0 0 30 2 *").unwrap();
        assert!(c.next_after(JAN1, 0).is_none());
    }

    #[test]
    fn parse_rejects_bad_expressions() {
        assert!(Cron::parse("* * * *").is_err(), "4 fields");
        assert!(Cron::parse("* * * * * *").is_err(), "6 fields");
        assert!(Cron::parse("60 * * * *").is_err(), "minute > 59");
        assert!(Cron::parse("* 24 * * *").is_err(), "hour > 23");
        assert!(Cron::parse("* * 0 * *").is_err(), "day-of-month < 1");
        assert!(Cron::parse("* * * 13 *").is_err(), "month > 12");
        assert!(Cron::parse("* * * * 8").is_err(), "day-of-week > 7");
        assert!(Cron::parse("*/0 * * * *").is_err(), "zero step");
        assert!(Cron::parse("").is_err(), "empty");
        assert!(Cron::parse("x * * * *").is_err(), "non-numeric");
    }

    #[test]
    fn parse_accepts_common_expressions() {
        for ok in [
            "* * * * *",
            "0 2 * * *",
            "*/15 * * * *",
            "0 0 1 * *",
            "0 9 * * 1-5",
            "30 3,15 * * *",
            "0 0 * * 0",
        ] {
            assert!(Cron::parse(ok).is_ok(), "should parse: {ok}");
        }
    }
}
