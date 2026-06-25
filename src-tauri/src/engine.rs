//! Orchestration facade the Tauri commands call. `preview` scans both roots in
//! parallel, loads (and safely interprets) the baseline, and builds a plan.
//! `execute` re-scans, applies the plan with the user's resolutions, and
//! persists the new baseline atomically — only after the apply finishes.

use crate::apply::{apply_plan, Progress};
use crate::baseline::{Baseline, LoadOutcome};
use crate::config::JobConfig;
use crate::error::{Result, SyncError};
use crate::fsops;
use crate::model::*;
use crate::plan::{build_plan, PlanInputs};
use crate::scan::scan_root;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// mtime comparison tolerance. 10ms absorbs serialization jitter without masking
/// a genuine edit (which essentially always also changes size). Cross-filesystem
/// rounding (FAT/exFAT 2s) merely causes a harmless one-time recopy, never loss.
pub const DEFAULT_GRAN_NS: i64 = 10_000_000;

pub fn baseline_path(state_dir: &Path, cfg: &JobConfig) -> PathBuf {
    state_dir.join(cfg.job_id()).join("baseline.json")
}

fn load_baseline(path: &Path) -> (Baseline, BaselineStatusKind) {
    match Baseline::load(path) {
        LoadOutcome::Loaded(b) => (b, BaselineStatusKind::Present),
        LoadOutcome::Missing => (Baseline::default(), BaselineStatusKind::FirstSync),
        LoadOutcome::Corrupt => (Baseline::default(), BaselineStatusKind::Corrupt),
    }
}

pub fn baseline_status(state_dir: &Path, cfg: &JobConfig) -> BaselineStatusKind {
    load_baseline(&baseline_path(state_dir, cfg)).1
}

pub fn validate_job(cfg: &JobConfig) -> Result<()> {
    if cfg.root_a.as_os_str().is_empty() || cfg.root_b.as_os_str().is_empty() {
        return Err(SyncError::InvalidJob("both folders must be set".into()));
    }
    if !cfg.root_a.is_dir() {
        return Err(SyncError::InvalidJob(format!(
            "folder A does not exist: {}",
            cfg.root_a.display()
        )));
    }
    if !cfg.root_b.is_dir() {
        return Err(SyncError::InvalidJob(format!(
            "folder B does not exist: {}",
            cfg.root_b.display()
        )));
    }
    let ca = std::fs::canonicalize(&cfg.root_a).unwrap_or_else(|_| cfg.root_a.clone());
    let cb = std::fs::canonicalize(&cfg.root_b).unwrap_or_else(|_| cfg.root_b.clone());
    if ca == cb {
        return Err(SyncError::InvalidJob("the two folders are the same".into()));
    }
    if ca.starts_with(&cb) || cb.starts_with(&ca) {
        return Err(SyncError::InvalidJob(
            "one folder is inside the other; nested roots are not supported".into(),
        ));
    }
    Ok(())
}

/// Scans both roots in parallel. The returned bool is `true` when EITHER scan
/// hit read errors — in that case deletions must be suppressed this run.
fn scan_both(
    cfg: &JobConfig,
) -> Result<(crate::scan::ScanResult, crate::scan::ScanResult, Vec<String>, bool)> {
    let (ra, rb) = rayon::join(
        || scan_root(&cfg.root_a, &cfg.ignore, cfg.verify_by_hash),
        || scan_root(&cfg.root_b, &cfg.ignore, cfg.verify_by_hash),
    );
    let ra = ra?;
    let rb = rb?;
    let scan_error = ra.had_errors() || rb.had_errors();

    let mut warnings = Vec::new();
    if scan_error {
        warnings.push(
            "⚠ Some files or folders could not be read this run (offline drive, permissions, \
             or locks). Deletions are SUPPRESSED until the scan is clean, so unreadable files \
             are never mistaken for deletions."
                .to_string(),
        );
        for (k, reason) in &ra.errors {
            warnings.push(format!("A · could not read {} — {reason}", display_key(k)));
        }
        for (k, reason) in &rb.errors {
            warnings.push(format!("B · could not read {} — {reason}", display_key(k)));
        }
    }
    for (k, reason) in &ra.skipped {
        warnings.push(format!("A: {} — {reason}", display_key(k)));
    }
    for (k, reason) in &rb.skipped {
        warnings.push(format!("B: {} — {reason}", display_key(k)));
    }
    Ok((ra, rb, warnings, scan_error))
}

fn display_key(k: &str) -> &str {
    if k.is_empty() {
        "(unknown)"
    } else {
        k
    }
}

pub fn preview(cfg: &JobConfig, state_dir: &Path) -> Result<SyncPlan> {
    validate_job(cfg)?;
    let (base, status) = load_baseline(&baseline_path(state_dir, cfg));
    let (ra, rb, warnings, scan_error) = scan_both(cfg)?;
    Ok(build_plan(PlanInputs {
        cfg,
        a: &ra.entries,
        b: &rb.entries,
        base: &base,
        status,
        gran_ns: DEFAULT_GRAN_NS,
        warnings,
        suppress_deletes: scan_error,
    }))
}

pub fn execute(
    cfg: &JobConfig,
    state_dir: &Path,
    resolutions: &HashMap<String, Resolution>,
    confirm_big_delete: bool,
    cancel: &AtomicBool,
    progress: impl FnMut(Progress),
) -> Result<ApplyReport> {
    validate_job(cfg)?;
    let bpath = baseline_path(state_dir, cfg);
    let (mut base, status) = load_baseline(&bpath);
    let (ra, rb, warnings, scan_error) = scan_both(cfg)?;
    let plan = build_plan(PlanInputs {
        cfg,
        a: &ra.entries,
        b: &rb.entries,
        base: &base,
        status,
        gran_ns: DEFAULT_GRAN_NS,
        warnings,
        suppress_deletes: scan_error,
    });

    if plan.big_delete.is_some() && !confirm_big_delete {
        return Err(SyncError::InvalidJob(
            "this sync would delete an unusually large number of files; confirmation required"
                .into(),
        ));
    }

    if let Some(parent) = bpath.parent() {
        std::fs::create_dir_all(parent).map_err(|e| SyncError::from_io(parent, &e))?;
        fsops::gc_orphan_temps(parent);
    }

    let report = apply_plan(cfg, &plan, resolutions, &mut base, DEFAULT_GRAN_NS, cancel, progress);
    base.save_atomic(&bpath)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::sync::atomic::AtomicBool;
    use tempfile::tempdir;

    fn cfg(a: &Path, b: &Path) -> JobConfig {
        JobConfig {
            root_a: a.to_path_buf(),
            root_b: b.to_path_buf(),
            ignore: Default::default(),
            verify_by_hash: false,
            big_delete_pct: 0.9,
            big_delete_abs: 10_000,
            use_recycle_bin: false, // hard-delete in tests (no shell)
        }
    }

    fn run(cfg: &JobConfig, state: &Path) -> ApplyReport {
        let cancel = AtomicBool::new(false);
        execute(cfg, state, &HashMap::new(), true, &cancel, |_| {}).unwrap()
    }

    #[test]
    fn full_two_way_lifecycle() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let state = tempdir().unwrap();
        let cfg = cfg(a.path(), b.path());

        // 1. A has a file; first sync copies it to B (no deletes ever).
        fs::write(a.path().join("hello.txt"), "world").unwrap();
        let plan = preview(&cfg, state.path()).unwrap();
        assert_eq!(plan.baseline_status, BaselineStatusKind::FirstSync);
        run(&cfg, state.path());
        assert_eq!(fs::read_to_string(b.path().join("hello.txt")).unwrap(), "world");

        // 2. B creates a new file; next sync brings it back to A.
        fs::write(b.path().join("from_b.txt"), "bbb").unwrap();
        run(&cfg, state.path());
        assert_eq!(fs::read_to_string(a.path().join("from_b.txt")).unwrap(), "bbb");

        // 3. Modify on A; propagates to B.
        fs::write(a.path().join("hello.txt"), "world v2 longer").unwrap();
        run(&cfg, state.path());
        assert_eq!(
            fs::read_to_string(b.path().join("hello.txt")).unwrap(),
            "world v2 longer"
        );

        // 4. Delete on A; propagates as a delete to B (baseline makes this safe).
        fs::remove_file(a.path().join("hello.txt")).unwrap();
        let plan = preview(&cfg, state.path()).unwrap();
        let it = plan.items.iter().find(|i| i.path == "hello.txt").unwrap();
        assert_eq!(it.action, Action::DeleteB);
        run(&cfg, state.path());
        assert!(!b.path().join("hello.txt").exists());
    }

    #[test]
    fn concurrent_edit_is_conflict_and_resolves_keep_a() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let state = tempdir().unwrap();
        let cfg = cfg(a.path(), b.path());

        // Seed both sides identically and establish a baseline.
        fs::write(a.path().join("f.txt"), "base").unwrap();
        run(&cfg, state.path()); // copies to B, baseline now knows f.txt

        // Both sides edit f.txt differently => EditEdit conflict.
        fs::write(a.path().join("f.txt"), "AAA from a").unwrap();
        fs::write(b.path().join("f.txt"), "BB from b").unwrap();
        let plan = preview(&cfg, state.path()).unwrap();
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(it.action, Action::Conflict);
        assert_eq!(it.conflict, Some(ConflictType::EditEdit));

        // Resolve KeepA: A's content wins on both sides.
        let mut res = HashMap::new();
        res.insert("f.txt".to_string(), Resolution::KeepA);
        let cancel = AtomicBool::new(false);
        execute(&cfg, state.path(), &res, true, &cancel, |_| {}).unwrap();
        assert_eq!(fs::read_to_string(a.path().join("f.txt")).unwrap(), "AAA from a");
        assert_eq!(fs::read_to_string(b.path().join("f.txt")).unwrap(), "AAA from a");

        // And it's converged now: a follow-up sync is a no-op.
        let plan = preview(&cfg, state.path()).unwrap();
        assert!(plan
            .items
            .iter()
            .all(|i| matches!(i.action, Action::Noop) || i.path != "f.txt"));
    }

    #[test]
    fn keep_both_preserves_both_versions() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let state = tempdir().unwrap();
        let cfg = cfg(a.path(), b.path());

        fs::write(a.path().join("doc.txt"), "seed").unwrap();
        run(&cfg, state.path());
        fs::write(a.path().join("doc.txt"), "from A side").unwrap();
        fs::write(b.path().join("doc.txt"), "from B side!!").unwrap();

        let mut res = HashMap::new();
        res.insert("doc.txt".to_string(), Resolution::KeepBoth);
        let cancel = AtomicBool::new(false);
        execute(&cfg, state.path(), &res, true, &cancel, |_| {}).unwrap();

        // A wins the canonical name on both sides...
        assert_eq!(fs::read_to_string(a.path().join("doc.txt")).unwrap(), "from A side");
        assert_eq!(fs::read_to_string(b.path().join("doc.txt")).unwrap(), "from A side");
        // ...and B's version survives as a conflict copy on BOTH sides.
        let has_conflict = |root: &Path| {
            fs::read_dir(root)
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().contains("sync-conflict"))
        };
        assert!(has_conflict(a.path()));
        assert!(has_conflict(b.path()));
    }

    #[test]
    fn keep_both_on_modify_delete_converges() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let state = tempdir().unwrap();
        let cfg = cfg(a.path(), b.path());

        fs::write(a.path().join("x.txt"), "orig").unwrap();
        run(&cfg, state.path()); // baseline; B now has x.txt

        // A deletes, B edits => ModifyDelete conflict.
        fs::remove_file(a.path().join("x.txt")).unwrap();
        fs::write(b.path().join("x.txt"), "edited on b").unwrap();
        let plan = preview(&cfg, state.path()).unwrap();
        assert_eq!(
            plan.items.iter().find(|i| i.path == "x.txt").unwrap().conflict,
            Some(ConflictType::ModifyDelete)
        );

        // KeepBoth on a one-sided conflict must converge (not re-conflict forever).
        let mut res = HashMap::new();
        res.insert("x.txt".to_string(), Resolution::KeepBoth);
        let cancel = AtomicBool::new(false);
        execute(&cfg, state.path(), &res, true, &cancel, |_| {}).unwrap();
        assert_eq!(fs::read_to_string(a.path().join("x.txt")).unwrap(), "edited on b");
        assert_eq!(fs::read_to_string(b.path().join("x.txt")).unwrap(), "edited on b");

        // Converged: a follow-up sync does nothing for x.txt and spawns no extra
        // conflict copies.
        let plan2 = preview(&cfg, state.path()).unwrap();
        assert!(plan2
            .items
            .iter()
            .all(|i| i.path != "x.txt" || i.action == Action::Noop));
        let dup = fs::read_dir(a.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("sync-conflict"))
            .count();
        assert_eq!(dup, 0, "no stray conflict copies for a one-sided keep-both");
    }

    #[test]
    fn verify_by_hash_detects_same_size_same_mtime_edit() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let state = tempdir().unwrap();
        let mut cfg = cfg(a.path(), b.path());
        cfg.verify_by_hash = true;

        let p = a.path().join("f.txt");
        fs::write(&p, "abc").unwrap();
        run(&cfg, state.path()); // baseline records A's content hash

        let orig = fs::metadata(&p).unwrap().modified().unwrap();
        // Stealth edit: identical byte length, then restore the original mtime so
        // the metadata heuristic would call it Unchanged.
        fs::write(&p, "xyz").unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(orig).unwrap();
        drop(f);

        let plan = preview(&cfg, state.path()).unwrap();
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(it.action, Action::CopyAtoB, "verify-by-hash must catch the stealth edit");
    }

    #[test]
    fn corrupt_baseline_falls_back_to_safe_union_no_delete() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let state = tempdir().unwrap();
        let cfg = cfg(a.path(), b.path());

        // Establish a baseline with one file on both sides.
        fs::write(a.path().join("keep.txt"), "x").unwrap();
        run(&cfg, state.path());

        // Corrupt the baseline, then delete the file on A. Without a trustworthy
        // baseline the engine must NOT propagate the deletion to B.
        fs::write(baseline_path(state.path(), &cfg), b"garbage{{{").unwrap();
        fs::remove_file(a.path().join("keep.txt")).unwrap();

        let plan = preview(&cfg, state.path()).unwrap();
        assert_eq!(plan.baseline_status, BaselineStatusKind::Corrupt);
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
        run(&cfg, state.path());
        assert!(b.path().join("keep.txt").exists(), "B's file must survive");
    }
}
