//! Structured, append-only run records — one JSON object per line in
//! `<app_dir>/runs/run-log.jsonl`, written when a preview/execute run finishes
//! (success OR failure). This is the durable, machine-readable audit the future
//! Activity screen will read, and the first thing to inspect after a "the scan
//! seemingly stopped" report: per run it captures every pair's scanned counts per
//! side, errors/skips, ok/failed and wall-clock duration. The same summary is
//! mirrored to the `tracing` diagnostic log.
//!
//! Best-effort by design: a logging failure must NEVER fail a sync, so write
//! errors are traced and swallowed. Runs are serialized by the `RunRegistry`, so
//! there is never a concurrent appender to this file.

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Per-pair scan/plan outcome inside a run.
#[derive(Debug, Clone, Serialize)]
pub struct PairRunLog {
    pub pair_id: String,
    /// Entries recorded on each side after filtering (files + dirs).
    pub entries_a: usize,
    pub entries_b: usize,
    /// Genuine read/stat failures per side. Non-zero => deletions were suppressed
    /// for this pair (an unreadable path is unknown, never a deletion).
    pub errors_a: usize,
    pub errors_b: usize,
    /// Intentionally-skipped entries per side (symlink, reparse/junction, cloud
    /// placeholder, special file).
    pub skipped_a: usize,
    pub skipped_b: usize,
    /// Live cumulative `scanned` counter delta attributed to this pair (both sides
    /// combined) — what the scan-progress UI was showing.
    pub scanned: u64,
    /// Effective walker thread count used for this pair's scan (per root).
    pub threads: usize,
    /// Wall-clock milliseconds for this pair (scan + plan, or scan + apply).
    pub ms: u128,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One full run (all pairs) record.
#[derive(Debug, Clone, Serialize)]
pub struct RunLog {
    pub run_id: String,
    pub job_id: String,
    /// `"preview"` or `"execute"`.
    pub phase: &'static str,
    pub trigger: String,
    pub started: String, // RFC3339 UTC
    pub ended: String,   // RFC3339 UTC
    pub ms: u128,
    pub pair_count: usize,
    pub pairs: Vec<PairRunLog>,
    /// True iff the whole run completed without error AND was not cancelled.
    pub ok: bool,
    /// True iff a user cancel interrupted the run partway (distinct from a clean
    /// finish and from a failure) — so the log can tell "the scan stopped because I
    /// cancelled" apart from "the scan crashed/finished".
    #[serde(skip_serializing_if = "is_false")]
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Accumulates a run record as it progresses, then writes it out once on
/// [`Self::finish`]. Times the whole run from construction.
pub struct RunLogBuilder {
    run_id: String,
    job_id: String,
    phase: &'static str,
    trigger: String,
    started_rfc3339: String,
    started_at: Instant,
    pair_count: usize,
    pairs: Vec<PairRunLog>,
}

impl RunLogBuilder {
    pub fn new(
        run_id: &str,
        job_id: &str,
        phase: &'static str,
        trigger: &str,
        pair_count: usize,
    ) -> Self {
        tracing::info!(
            run = run_id,
            job = job_id,
            phase,
            trigger,
            pair_count,
            "run started"
        );
        RunLogBuilder {
            run_id: run_id.to_string(),
            job_id: job_id.to_string(),
            phase,
            trigger: trigger.to_string(),
            started_rfc3339: crate::timeutil::now_rfc3339(),
            started_at: Instant::now(),
            pair_count,
            pairs: Vec::with_capacity(pair_count),
        }
    }

    /// Record one pair's outcome (also emits a per-pair tracing event).
    pub fn pair(&mut self, p: PairRunLog) {
        tracing::info!(
            run = %self.run_id,
            phase = self.phase,
            pair = %p.pair_id,
            entries_a = p.entries_a,
            entries_b = p.entries_b,
            errors_a = p.errors_a,
            errors_b = p.errors_b,
            skipped_a = p.skipped_a,
            skipped_b = p.skipped_b,
            scanned = p.scanned,
            threads = p.threads,
            ms = p.ms,
            ok = p.ok,
            error = p.error.as_deref().unwrap_or(""),
            "pair done"
        );
        self.pairs.push(p);
    }

    /// Finalize: stamp the end time, write one JSONL line under `app_dir`, and
    /// emit a final tracing event. `error` is `Some` when the run failed; a failure
    /// takes precedence over `cancelled` in the message (an errored run that was
    /// also cancelled is logged as a failure).
    pub fn finish(self, app_dir: &Path, error: Option<String>, cancelled: bool) {
        let ms = self.started_at.elapsed().as_millis();
        let ok = error.is_none() && !cancelled;
        let rec = RunLog {
            run_id: self.run_id,
            job_id: self.job_id,
            phase: self.phase,
            trigger: self.trigger,
            started: self.started_rfc3339,
            ended: crate::timeutil::now_rfc3339(),
            ms,
            pair_count: self.pair_count,
            pairs: self.pairs,
            ok,
            cancelled,
            error,
        };

        if let Some(err) = rec.error.as_deref() {
            tracing::error!(run = %rec.run_id, phase = rec.phase, ms, error = err, "run failed");
        } else if cancelled {
            tracing::warn!(run = %rec.run_id, phase = rec.phase, ms, "run cancelled");
        } else {
            tracing::info!(run = %rec.run_id, phase = rec.phase, ms, "run finished ok");
        }
        append(app_dir, &rec);
    }
}

/// Path of the append-only run log under an app dir.
pub fn run_log_path(app_dir: &Path) -> PathBuf {
    app_dir.join("runs").join("run-log.jsonl")
}

/// Append one record as a single JSON line. Best-effort; never panics.
pub fn append(app_dir: &Path, rec: &RunLog) {
    let path = run_log_path(app_dir);
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!(error = %e, path = %dir.display(), "could not create run-log dir");
            return;
        }
    }
    let line = match serde_json::to_string(rec) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "could not serialize run-log record");
            return;
        }
    };
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "{line}") {
                tracing::warn!(error = %e, path = %path.display(), "could not append run-log line");
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "could not open run-log file");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn pair(id: &str, ok: bool) -> PairRunLog {
        PairRunLog {
            pair_id: id.into(),
            entries_a: 10,
            entries_b: 9,
            errors_a: 0,
            errors_b: 0,
            skipped_a: 1,
            skipped_b: 0,
            scanned: 19,
            threads: 8,
            ms: 42,
            ok,
            error: if ok { None } else { Some("boom".into()) },
        }
    }

    #[test]
    fn append_writes_one_json_line_per_record() {
        let dir = tempdir().unwrap();
        let rec = RunLog {
            run_id: "01RUN".into(),
            job_id: "01JOB".into(),
            phase: "preview",
            trigger: "Manual".into(),
            started: "2026-06-26T00:00:00Z".into(),
            ended: "2026-06-26T00:00:01Z".into(),
            ms: 1000,
            pair_count: 1,
            pairs: vec![pair("01PAIR", true)],
            ok: true,
            cancelled: false,
            error: None,
        };
        append(dir.path(), &rec);
        append(dir.path(), &rec);

        let body = std::fs::read_to_string(run_log_path(dir.path())).unwrap();
        let lines: Vec<_> = body.lines().collect();
        assert_eq!(lines.len(), 2, "one line appended per record");
        // Each line is independently valid JSON.
        for l in lines {
            let v: serde_json::Value = serde_json::from_str(l).unwrap();
            assert_eq!(v["run_id"], "01RUN");
            assert_eq!(v["pairs"][0]["entries_a"], 10);
        }
    }

    #[test]
    fn failed_record_carries_error_ok_records_omit_it() {
        let dir = tempdir().unwrap();
        let ok = RunLog {
            run_id: "ok".into(),
            job_id: "j".into(),
            phase: "preview",
            trigger: "Manual".into(),
            started: "x".into(),
            ended: "y".into(),
            ms: 1,
            pair_count: 0,
            pairs: vec![],
            ok: true,
            cancelled: false,
            error: None,
        };
        let bad = RunLog {
            ok: false,
            error: Some("scan panicked".into()),
            ..ok.clone()
        };
        let cancelled = RunLog {
            ok: false,
            cancelled: true,
            error: None,
            ..ok.clone()
        };
        append(dir.path(), &ok);
        append(dir.path(), &bad);
        append(dir.path(), &cancelled);
        let body = std::fs::read_to_string(run_log_path(dir.path())).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        let v0: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        let v1: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        let v2: serde_json::Value = serde_json::from_str(lines[2]).unwrap();
        assert!(v0.get("error").is_none(), "ok record omits error");
        assert!(
            v0.get("cancelled").is_none(),
            "clean record omits cancelled"
        );
        assert_eq!(v1["error"], "scan panicked");
        assert_eq!(v1["ok"], false);
        // A cancelled run is distinguishable from both a clean run and a failure:
        // ok=false, cancelled=true, and no error string.
        assert_eq!(v2["ok"], false);
        assert_eq!(v2["cancelled"], true);
        assert!(v2.get("error").is_none(), "a cancel is not an error");
    }
}
