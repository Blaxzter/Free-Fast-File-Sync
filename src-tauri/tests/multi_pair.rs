//! S6 integration: the multi-pair fan-out + per-pair baseline run layer.
//!
//! These drive the SAME pipeline the `preview_job`/`execute_job` Tauri commands
//! use, minus the AppHandle: `job::Job::fan_out` -> per-pair `JobConfig`, each
//! pair looped SEQUENTIALLY through the unchanged `engine::preview`/`execute`
//! with its own `store::Store::pair_baseline_path`. The point of S6 is that
//! pairs are INDEPENDENT: distinct ULID baselines, per-pair suppress-deletes,
//! per-pair filters — and that nothing freezes a plan between preview and apply.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use fast_file_sync_lib::engine;
use fast_file_sync_lib::job::{
    BigDeleteGuard, DeletionPolicy, EndpointPath, FolderPair, Job, JobSettings, SyncDirection,
};
use fast_file_sync_lib::model::{Action, BaselineStatusKind};
use fast_file_sync_lib::runs::{RunDescriptor, RunError, RunRegistry};
use fast_file_sync_lib::store::Store;

use tempfile::TempDir;

// --- helpers ---------------------------------------------------------------

fn local(p: &Path) -> EndpointPath {
    EndpointPath::Local {
        path: p.to_string_lossy().to_string(),
    }
}

fn pair(id: &str, a: &Path, b: &Path) -> FolderPair {
    FolderPair {
        id: id.into(),
        label: String::new(),
        root_a: local(a),
        root_b: local(b),
        enabled: true,
        filter_override: None,
        mode_override: None,
        deletion_override: None,
        big_delete_override: None,
    }
}

fn job(pairs: Vec<FolderPair>) -> Job {
    Job {
        id: "01JOBMULTI000000000000000001".into(),
        name: "multi".into(),
        color: None,
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        // Hard-delete by default so tests don't pollute the recycle bin (no shell).
        settings: JobSettings {
            deletion: DeletionPolicy::Permanent,
            big_delete: BigDeleteGuard {
                pct: 0.99,
                abs: 10_000,
            },
            ..Default::default()
        },
        pairs,
    }
}

/// Run a single resolved pair through execute (establishes / advances baseline).
fn run_pair(store: &Store, job_id: &str, r: &fast_file_sync_lib::job::ResolvedPair) {
    let bpath = store.pair_baseline_path(job_id, &r.pair_id);
    let cancel = AtomicBool::new(false);
    engine::execute(&r.config, &bpath, &HashMap::new(), true, &cancel, |_| {}).unwrap();
}

fn preview_pair(
    store: &Store,
    job_id: &str,
    r: &fast_file_sync_lib::job::ResolvedPair,
) -> fast_file_sync_lib::model::SyncPlan {
    let bpath = store.pair_baseline_path(job_id, &r.pair_id);
    engine::preview(&r.config, &bpath).unwrap()
}

// --- tests -----------------------------------------------------------------

/// Two pairs get distinct ULID baseline dirs. After establishing both, editing a
/// file under pair-1's root and re-previewing pair-1 must still see a Present
/// baseline (NOT degrade to FirstSync) — proving the baseline is keyed by the
/// stable pair ULID, not orphaned, and is independent of pair-2.
#[test]
fn two_pairs_have_independent_baselines() {
    let a1 = TempDir::new().unwrap();
    let b1 = TempDir::new().unwrap();
    let a2 = TempDir::new().unwrap();
    let b2 = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let store = Store::new(state.path().to_path_buf());

    fs::write(a1.path().join("one.txt"), "1").unwrap();
    fs::write(a2.path().join("two.txt"), "2").unwrap();

    let j = job(vec![
        pair("01PAIR0000000000000000000P1", a1.path(), b1.path()),
        pair("01PAIR0000000000000000000P2", a2.path(), b2.path()),
    ]);
    let resolved = j.fan_out();
    assert_eq!(resolved.len(), 2);

    // First sync each pair: establishes its own baseline.
    for r in &resolved {
        let plan = preview_pair(&store, &j.id, r);
        assert_eq!(plan.baseline_status, BaselineStatusKind::FirstSync);
        run_pair(&store, &j.id, r);
    }

    // Distinct baseline files on disk under distinct pair ULID dirs.
    let bp1 = store.pair_baseline_path(&j.id, &resolved[0].pair_id);
    let bp2 = store.pair_baseline_path(&j.id, &resolved[1].pair_id);
    assert!(bp1.exists() && bp2.exists());
    assert_ne!(bp1, bp2);

    // Edit a file under pair-1's root, then re-preview pair-1: it must still load
    // its OWN baseline (Present), not silently FirstSync.
    fs::write(a1.path().join("one.txt"), "1 edited longer").unwrap();
    let plan1 = preview_pair(&store, &j.id, &resolved[0]);
    assert_eq!(
        plan1.baseline_status,
        BaselineStatusKind::Present,
        "pair-1 baseline must survive a root edit (stable ULID keying)"
    );
    // Pair-2 baseline is likewise still Present and unaffected.
    let plan2 = preview_pair(&store, &j.id, &resolved[1]);
    assert_eq!(plan2.baseline_status, BaselineStatusKind::Present);
}

/// One job containing a Mirror pair and a TwoWay pair: each pair is fanned out to
/// the correct engine SyncMode and produces the mode-correct decision for the
/// same B-only-extra situation (Mirror => DeleteB, TwoWay => CopyBtoA).
#[test]
fn fan_out_runs_each_pair_through_preview_execute() {
    let am = TempDir::new().unwrap();
    let bm = TempDir::new().unwrap();
    let at = TempDir::new().unwrap();
    let bt = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let store = Store::new(state.path().to_path_buf());

    // Seed a shared file on both pairs so a baseline exists.
    fs::write(am.path().join("seed.txt"), "s").unwrap();
    fs::write(at.path().join("seed.txt"), "s").unwrap();

    let mut mirror = pair("01PAIRMIRROR00000000000001", am.path(), bm.path());
    mirror.mode_override = Some(SyncDirection::MirrorAtoB);
    let twoway = pair("01PAIRTWOWAY00000000000001", at.path(), bt.path());

    let j = job(vec![mirror, twoway]);
    let resolved = j.fan_out();
    assert_eq!(resolved.len(), 2);
    assert_eq!(
        resolved[0].config.mode,
        fast_file_sync_lib::model::SyncMode::Mirror
    );
    assert_eq!(
        resolved[1].config.mode,
        fast_file_sync_lib::model::SyncMode::TwoWay
    );

    // Establish baselines for both pairs.
    for r in &resolved {
        run_pair(&store, &j.id, r);
    }

    // Introduce a B-only extra on BOTH pairs.
    fs::write(bm.path().join("b_extra.txt"), "x").unwrap();
    fs::write(bt.path().join("b_extra.txt"), "x").unwrap();

    let mirror_plan = preview_pair(&store, &j.id, &resolved[0]);
    let twoway_plan = preview_pair(&store, &j.id, &resolved[1]);

    let m_extra = mirror_plan
        .items
        .iter()
        .find(|i| i.path == "b_extra.txt")
        .unwrap();
    let t_extra = twoway_plan
        .items
        .iter()
        .find(|i| i.path == "b_extra.txt")
        .unwrap();
    assert_eq!(
        m_extra.action,
        Action::DeleteB,
        "Mirror deletes a B-only extra"
    );
    assert_eq!(
        t_extra.action,
        Action::CopyBtoA,
        "TwoWay pulls a B-only extra to A"
    );

    // Execute both and confirm the disk converges accordingly.
    run_pair(&store, &j.id, &resolved[0]);
    run_pair(&store, &j.id, &resolved[1]);
    assert!(
        !bm.path().join("b_extra.txt").exists(),
        "Mirror removed the B extra"
    );
    assert!(
        at.path().join("b_extra.txt").exists(),
        "TwoWay copied the extra to A"
    );
}

/// A disabled pair is skipped by fan_out: it is never scanned and gets no
/// baseline directory.
#[test]
fn disabled_pair_is_skipped() {
    let a1 = TempDir::new().unwrap();
    let b1 = TempDir::new().unwrap();
    let a2 = TempDir::new().unwrap();
    let b2 = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let store = Store::new(state.path().to_path_buf());

    fs::write(a1.path().join("f.txt"), "x").unwrap();

    let mut disabled = pair("01PAIRDISABLED0000000000001", a2.path(), b2.path());
    disabled.enabled = false;

    let j = job(vec![
        pair("01PAIRENABLED00000000000001", a1.path(), b1.path()),
        disabled,
    ]);
    let resolved = j.fan_out();
    assert_eq!(resolved.len(), 1, "only the enabled pair fans out");
    assert_eq!(resolved[0].pair_id, "01PAIRENABLED00000000000001");

    run_pair(&store, &j.id, &resolved[0]);

    // No baseline dir was ever created for the disabled pair.
    let disabled_bp = store.pair_baseline_path(&j.id, "01PAIRDISABLED0000000000001");
    assert!(!disabled_bp.exists(), "disabled pair must have no baseline");
    assert!(store
        .pair_baseline_path(&j.id, "01PAIRENABLED00000000000001")
        .exists());
}

/// A scan error on ONE pair suppresses that pair's deletes only; a clean pair
/// in the same job still propagates a legitimate delete. Each pair derives its
/// own suppress_deletes from its own scan — there is no shared/global flag.
#[test]
fn one_pair_scan_error_does_not_suppress_deletes_on_a_clean_pair() {
    let a_clean = TempDir::new().unwrap();
    let b_clean = TempDir::new().unwrap();
    let a_err = TempDir::new().unwrap();
    let b_err = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let store = Store::new(state.path().to_path_buf());

    // Both pairs: seed a file, establish a baseline.
    fs::write(a_clean.path().join("keep.txt"), "x").unwrap();
    fs::write(a_err.path().join("keep.txt"), "x").unwrap();
    let denied = a_err.path().join("locked_dir");
    fs::create_dir(&denied).unwrap();
    fs::write(denied.join("inner.txt"), "y").unwrap();

    let j = job(vec![
        pair("01PAIRCLEAN000000000000001", a_clean.path(), b_clean.path()),
        pair("01PAIRERR00000000000000001", a_err.path(), b_err.path()),
    ]);
    let resolved = j.fan_out();
    for r in &resolved {
        run_pair(&store, &j.id, r);
    }

    // Make the error pair's subdir unreadable so its scan reports an error.
    deny_read(&denied);

    // Delete keep.txt on A for BOTH pairs.
    fs::remove_file(a_clean.path().join("keep.txt")).unwrap();
    fs::remove_file(a_err.path().join("keep.txt")).unwrap();

    let clean_plan = preview_pair(&store, &j.id, &resolved[0]);
    let err_plan = preview_pair(&store, &j.id, &resolved[1]);

    // Sanity: the error pair really did hit a scan error (deletes suppressed).
    if err_plan.warnings.iter().all(|w| !w.contains("SUPPRESSED")) {
        // ACL deny didn't take (e.g. elevated). Restore + skip the strict half.
        restore_read(&denied);
        eprintln!("note: could not induce a scan error; skipping suppression half");
    } else {
        let err_keep = err_plan.items.iter().find(|i| i.path == "keep.txt");
        assert!(
            err_keep.map(|i| i.action) != Some(Action::DeleteB),
            "scan-error pair must SUPPRESS the delete"
        );
        restore_read(&denied);
    }

    // The clean pair is unaffected: its delete propagates as DeleteB.
    let clean_keep = clean_plan
        .items
        .iter()
        .find(|i| i.path == "keep.txt")
        .unwrap();
    assert_eq!(
        clean_keep.action,
        Action::DeleteB,
        "a scan error on another pair must NOT suppress deletes on a clean pair"
    );
}

/// A per-pair filter override changes that pair's membership without touching the
/// job-level filter or the other pairs.
#[test]
fn per_pair_filter_override_changes_membership() {
    use fast_file_sync_lib::config::IgnorePolicy;

    let a1 = TempDir::new().unwrap();
    let b1 = TempDir::new().unwrap();
    let a2 = TempDir::new().unwrap();
    let b2 = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let store = Store::new(state.path().to_path_buf());

    // Both pairs have a `.log` file on A.
    fs::write(a1.path().join("data.txt"), "d").unwrap();
    fs::write(a1.path().join("debug.log"), "l").unwrap();
    fs::write(a2.path().join("data.txt"), "d").unwrap();
    fs::write(a2.path().join("debug.log"), "l").unwrap();

    // Pair 2 overrides the filter to exclude *.log; pair 1 inherits (no exclusion).
    let mut p2 = pair("01PAIRFILTER00000000000002", a2.path(), b2.path());
    p2.filter_override = Some(IgnorePolicy {
        custom_globs: vec!["*.log".into()],
        ..Default::default()
    });

    let j = job(vec![
        pair("01PAIRFILTER00000000000001", a1.path(), b1.path()),
        p2,
    ]);
    let resolved = j.fan_out();

    let plan1 = preview_pair(&store, &j.id, &resolved[0]);
    let plan2 = preview_pair(&store, &j.id, &resolved[1]);

    assert!(
        plan1.items.iter().any(|i| i.path == "debug.log"),
        "pair-1 (inherited filter) still sees debug.log"
    );
    assert!(
        plan2.items.iter().all(|i| i.path != "debug.log"),
        "pair-2 filter override excludes debug.log from membership"
    );
    // The shared file is present in both.
    assert!(plan1.items.iter().any(|i| i.path == "data.txt"));
    assert!(plan2.items.iter().any(|i| i.path == "data.txt"));
}

/// Proves NO frozen-plan apply: stage a clean preview (delete would propagate),
/// then introduce a scan error BEFORE execute. Because execute re-scans, the
/// fresh suppress_deletes neutralizes the delete at apply time — the file
/// survives even though the staged preview said DeleteB.
#[test]
fn execute_rescans_fresh_suppress_deletes() {
    let a = TempDir::new().unwrap();
    let b = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    let store = Store::new(state.path().to_path_buf());

    fs::write(a.path().join("keep.txt"), "x").unwrap();
    let denied = a.path().join("sub");
    fs::create_dir(&denied).unwrap();
    fs::write(denied.join("inner.txt"), "y").unwrap();

    let j = job(vec![pair(
        "01PAIRRESCAN000000000000001",
        a.path(),
        b.path(),
    )]);
    let resolved = j.fan_out();
    run_pair(&store, &j.id, &resolved[0]); // baseline; B now has keep.txt

    // Stage a CLEAN preview: deleting keep.txt on A would propagate to B.
    fs::remove_file(a.path().join("keep.txt")).unwrap();
    let staged = preview_pair(&store, &j.id, &resolved[0]);
    let staged_keep = staged.items.iter().find(|i| i.path == "keep.txt").unwrap();
    assert_eq!(
        staged_keep.action,
        Action::DeleteB,
        "clean preview would delete B"
    );

    // Now introduce a scan error BEFORE execute.
    deny_read(&denied);

    let bpath = store.pair_baseline_path(&j.id, &resolved[0].pair_id);
    let cancel = AtomicBool::new(false);
    let _report = engine::execute(
        &resolved[0].config,
        &bpath,
        &HashMap::new(),
        true,
        &cancel,
        |_| {},
    )
    .unwrap();

    let suppressed = b.path().join("keep.txt").exists();
    restore_read(&denied);

    assert!(
        suppressed,
        "execute must RE-SCAN: a scan error introduced after preview suppresses the delete \
         (no frozen-plan apply)"
    );
}

/// The single-slot gate: while a run for job J holds the slot (as an apply
/// would), a second `try_start` (what `preview_job` does) is rejected Busy with
/// the active run's id.
#[test]
fn preview_of_job_rejected_while_same_job_applying() {
    let reg = RunRegistry::new();
    let job_id = "01JOBBUSY0000000000000000001".to_string();

    // An apply of J holds the single slot.
    let applying = reg
        .try_start(RunDescriptor {
            job_id: job_id.clone(),
            pair_ids: vec![],
        })
        .expect("apply claims the slot");

    // A preview of the SAME job tries to start and is rejected Busy.
    match reg.try_start(RunDescriptor {
        job_id: job_id.clone(),
        pair_ids: vec![],
    }) {
        Err(RunError::Busy { run_id }) => {
            assert_eq!(run_id, applying.run_id, "Busy reports the active run id");
        }
        Ok(_) => panic!("a second run must be rejected while one is active"),
    }

    // Once the apply finishes, a preview can start.
    reg.finish(&applying.run_id);
    assert!(reg
        .try_start(RunDescriptor {
            job_id,
            pair_ids: vec![]
        })
        .is_ok());
}

// --- OS-specific read-deny helpers ----------------------------------------

#[cfg(windows)]
fn deny_read(dir: &Path) {
    // Deny the current user List/Read on the directory so the walker errors.
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "Users".into());
    let _ = std::process::Command::new("icacls")
        .arg(dir)
        .arg("/deny")
        .arg(format!("{user}:(OI)(CI)(RX)"))
        .output();
}

#[cfg(windows)]
fn restore_read(dir: &Path) {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "Users".into());
    let _ = std::process::Command::new("icacls")
        .arg(dir)
        .arg("/remove:d")
        .arg(&user)
        .output();
}

#[cfg(not(windows))]
fn deny_read(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o000));
}

#[cfg(not(windows))]
fn restore_read(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o755));
}
