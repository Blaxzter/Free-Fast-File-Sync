//! Builds a `SyncPlan` from the two scans plus the baseline. This is where the
//! pure truth table meets real-world safety guards:
//!  * the *filtered-file delete guard* — a path absent from a side's scan but
//!    still present on disk is ignored, not deleted (prevents asymmetric- and
//!    changed-gitignore data loss);
//!  * *first-sync / corrupt-baseline* forces union-only, zero deletions;
//!  * a *big-delete guard*; and
//!  * *case-only collision* detection for case-insensitive destinations.

use crate::baseline::Baseline;
use crate::config::JobConfig;
use crate::model::*;
use crate::pathutil::{case_fold, extended, os_path};
use crate::reconcile::{classify_change, default_resolution, reconcile, resolution_options};
use crate::scan::hash_file;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub struct PlanInputs<'a> {
    pub cfg: &'a JobConfig,
    pub a: &'a BTreeMap<String, Meta>,
    pub b: &'a BTreeMap<String, Meta>,
    pub base: &'a Baseline,
    pub status: BaselineStatusKind,
    pub gran_ns: i64,
    pub warnings: Vec<String>,
    /// Set when a scan reported read errors. While true, NO deletion is
    /// propagated: an unreadable path must never be mistaken for a removal.
    pub suppress_deletes: bool,
}

pub fn build_plan(inp: PlanInputs) -> SyncPlan {
    let PlanInputs { cfg, a, b, base, status, gran_ns, warnings, suppress_deletes } = inp;
    let trust_baseline = status == BaselineStatusKind::Present;
    let block_deletes = !trust_baseline || suppress_deletes;

    let mut universe: BTreeSet<&String> = BTreeSet::new();
    universe.extend(a.keys());
    universe.extend(b.keys());
    universe.extend(base.entries.keys());

    let mut items: Vec<PlanItem> = Vec::new();

    for key in universe {
        let a_meta = a.get(key);
        let b_meta = b.get(key);

        // Filtered-file delete guard: a key missing from a side's scan but still
        // physically present means it was ignored (asymmetric or newly-added
        // gitignore rule), NOT deleted. It is not a sync member — leave it alone.
        if a_meta.is_none() && disk_exists(&os_path(&cfg.root_a, key)) {
            continue;
        }
        if b_meta.is_none() && disk_exists(&os_path(&cfg.root_b, key)) {
            continue;
        }

        let base_meta = base.get(key);
        if a_meta.is_none() && b_meta.is_none() && base_meta.is_none() {
            continue;
        }

        let a_change = classify_change(a_meta, base_meta, gran_ns);
        let b_change = classify_change(b_meta, base_meta, gran_ns);

        // Only the "both changed the same way" cells need content identity, which
        // is the only place we read file bytes during planning.
        let identical = needs_identity(a_change, b_change)
            && content_identical(&cfg.root_a, &cfg.root_b, key, a_meta, b_meta);

        let mut decision = reconcile(a_change, b_change, identical);

        // Defense in depth: never delete when the baseline is untrustworthy
        // (first sync / corrupt) OR when a scan error means absence is unknown.
        if block_deletes && matches!(decision.action, Action::DeleteA | Action::DeleteB) {
            decision = Decision::plain(Action::Noop);
        }

        let (default_resolution, resolution_options, note) = match decision.conflict {
            Some(ct) => (
                Some(default_resolution(ct)),
                resolution_options(ct),
                conflict_note(ct),
            ),
            None => (None, Vec::new(), action_note(decision.action)),
        };

        items.push(PlanItem {
            path: key.clone(),
            action: decision.action,
            conflict: decision.conflict,
            a_change,
            b_change,
            a: a_meta.cloned(),
            b: b_meta.cloned(),
            base: base_meta.cloned(),
            default_resolution,
            resolution_options,
            note,
        });
    }

    detect_case_collisions(&mut items);

    let summary = summarize(&items);
    let big_delete = big_delete_guard(cfg, &summary, a.len().max(b.len()));

    SyncPlan {
        root_a: cfg.root_a.display().to_string(),
        root_b: cfg.root_b.display().to_string(),
        items,
        summary,
        baseline_status: status,
        big_delete,
        warnings,
    }
}

fn needs_identity(a: ChangeKind, b: ChangeKind) -> bool {
    use ChangeKind::*;
    matches!(
        (a, b),
        (Created, Created) | (Modified, Modified) | (TypeChanged, TypeChanged)
    )
}

/// Are the two live versions byte+type identical? Reads file content (only for
/// the rare conflict-candidate cells).
fn content_identical(
    root_a: &Path,
    root_b: &Path,
    key: &str,
    a_meta: Option<&Meta>,
    b_meta: Option<&Meta>,
) -> bool {
    let (am, bm) = match (a_meta, b_meta) {
        (Some(a), Some(b)) => (a, b),
        _ => return false,
    };
    if am.kind != bm.kind {
        return false;
    }
    match am.kind {
        EntryKind::Dir => true, // two directories of the same name converge
        EntryKind::File => {
            if am.size != bm.size {
                return false;
            }
            match (
                hash_file(&os_path(root_a, key)),
                hash_file(&os_path(root_b, key)),
            ) {
                (Ok(ha), Ok(hb)) => ha == hb,
                _ => false, // if we can't read to be sure, treat as a conflict
            }
        }
        _ => false,
    }
}

/// Flag two distinct keys that fold to the same name (e.g. README.md vs
/// readme.md) on a case-insensitive destination — applying both would overwrite
/// one. Convert the colliding actionable items to conflicts.
fn detect_case_collisions(items: &mut [PlanItem]) {
    let mut folded: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, it) in items.iter().enumerate() {
        if matches!(it.action, Action::Noop | Action::UpdateBaselineOnly) {
            continue;
        }
        folded.entry(case_fold(&it.path)).or_default().push(i);
    }
    for idxs in folded.values() {
        if idxs.len() < 2 {
            continue;
        }
        // More than one distinct path collides under case folding.
        let distinct: BTreeSet<&str> = idxs.iter().map(|&i| items[i].path.as_str()).collect();
        if distinct.len() < 2 {
            continue;
        }
        for &i in idxs {
            items[i].action = Action::Conflict;
            items[i].conflict = Some(ConflictType::StateDesync);
            items[i].default_resolution = Some(Resolution::Skip);
            items[i].resolution_options = resolution_options(ConflictType::StateDesync);
            items[i].note =
                "case-only name collision on a case-insensitive filesystem".to_string();
        }
    }
}

fn summarize(items: &[PlanItem]) -> PlanSummary {
    let mut s = PlanSummary::default();
    for it in items {
        s.total += 1;
        match it.action {
            Action::CopyAtoB => s.copy_a_to_b += 1,
            Action::CopyBtoA => s.copy_b_to_a += 1,
            Action::DeleteA => s.delete_a += 1,
            Action::DeleteB => s.delete_b += 1,
            Action::Conflict => s.conflicts += 1,
            Action::UpdateBaselineOnly => s.baseline_only += 1,
            Action::Noop => s.noop += 1,
        }
    }
    s
}

fn big_delete_guard(cfg: &JobConfig, s: &PlanSummary, members: usize) -> Option<BigDeleteWarning> {
    let deletions = s.delete_a + s.delete_b;
    if deletions == 0 {
        return None;
    }
    let pct = if members == 0 {
        1.0
    } else {
        deletions as f32 / members as f32
    };
    if deletions >= cfg.big_delete_abs || pct >= cfg.big_delete_pct {
        Some(BigDeleteWarning {
            deletions,
            total_members: members,
            pct,
            threshold_pct: cfg.big_delete_pct,
            threshold_abs: cfg.big_delete_abs,
        })
    } else {
        None
    }
}

fn disk_exists(p: &Path) -> bool {
    std::fs::symlink_metadata(extended(p)).is_ok()
}

fn action_note(a: Action) -> String {
    match a {
        Action::Noop => "in sync",
        Action::CopyAtoB => "copy A → B",
        Action::CopyBtoA => "copy B → A",
        Action::DeleteA => "delete on A (was removed on B)",
        Action::DeleteB => "delete on B (was removed on A)",
        Action::UpdateBaselineOnly => "already converged; record baseline",
        Action::Conflict => "conflict",
    }
    .to_string()
}

fn conflict_note(ct: ConflictType) -> String {
    match ct {
        ConflictType::EditEdit => "both sides edited this file",
        ConflictType::CreateCreate => "both sides created this path with different contents",
        ConflictType::ModifyDelete => "one side edited it, the other deleted it",
        ConflictType::DeleteTypeChange => "one side deleted it, the other replaced file/dir",
        ConflictType::ModifyTypeChange => "one side edited it, the other replaced file/dir",
        ConflictType::TypeChangeTypeChange => "both sides replaced file/dir differently",
        ConflictType::StateDesync => "inconsistent state — rescan recommended",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn file(size: u64, mtime: i64) -> Meta {
        Meta { kind: EntryKind::File, size, mtime_ns: mtime, hash: None }
    }

    fn empty_inputs<'a>(
        cfg: &'a JobConfig,
        a: &'a BTreeMap<String, Meta>,
        b: &'a BTreeMap<String, Meta>,
        base: &'a Baseline,
        status: BaselineStatusKind,
    ) -> PlanInputs<'a> {
        PlanInputs { cfg, a, b, base, status, gran_ns: 0, warnings: vec![], suppress_deletes: false }
    }

    fn cfg(root_a: &Path, root_b: &Path) -> JobConfig {
        JobConfig {
            root_a: root_a.to_path_buf(),
            root_b: root_b.to_path_buf(),
            ignore: Default::default(),
            verify_by_hash: false,
            big_delete_pct: 0.25,
            big_delete_abs: 100,
            use_recycle_bin: true,
        }
    }

    #[test]
    fn first_sync_never_deletes_and_unions() {
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        let cfg = cfg(da.path(), db.path());
        // A has only.txt; B is empty. base empty (first sync).
        let mut a = BTreeMap::new();
        a.insert("only.txt".to_string(), file(1, 1));
        fs::write(da.path().join("only.txt"), "x").unwrap();
        let b = BTreeMap::new();
        let base = Baseline::default();

        let plan = build_plan(empty_inputs(&cfg, &a, &b, &base, BaselineStatusKind::FirstSync));
        let it = plan.items.iter().find(|i| i.path == "only.txt").unwrap();
        assert_eq!(it.action, Action::CopyAtoB);
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
    }

    #[test]
    fn deleted_on_a_propagates_to_b_with_baseline() {
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        let cfg = cfg(da.path(), db.path());
        // base + B have f.txt; A deleted it (absent from A scan AND absent on disk A).
        let a = BTreeMap::new();
        let mut b = BTreeMap::new();
        b.insert("f.txt".to_string(), file(1, 5));
        fs::write(db.path().join("f.txt"), "x").unwrap();
        let mut base = Baseline::default();
        base.update_entry("f.txt", Some(file(1, 5)));

        let plan = build_plan(empty_inputs(&cfg, &a, &b, &base, BaselineStatusKind::Present));
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(it.action, Action::DeleteB);
    }

    #[test]
    fn filtered_file_still_on_disk_is_not_deleted() {
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        let cfg = cfg(da.path(), db.path());
        // base + B have f.log; A "deleted" it from the scan but it's STILL on disk
        // (it just got newly gitignored). Must NOT propagate a delete to B.
        let a = BTreeMap::new();
        fs::write(da.path().join("f.log"), "still here").unwrap(); // present on disk A
        let mut b = BTreeMap::new();
        b.insert("f.log".to_string(), file(1, 5));
        fs::write(db.path().join("f.log"), "x").unwrap();
        let mut base = Baseline::default();
        base.update_entry("f.log", Some(file(1, 5)));

        let plan = build_plan(empty_inputs(&cfg, &a, &b, &base, BaselineStatusKind::Present));
        // The key is excluded entirely — no delete, no action.
        assert!(plan.items.iter().all(|i| i.path != "f.log"));
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
    }

    #[test]
    fn modify_delete_is_conflict() {
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        let cfg = cfg(da.path(), db.path());
        // base has f.txt; A deleted (gone from disk), B modified.
        let a = BTreeMap::new();
        let mut b = BTreeMap::new();
        b.insert("f.txt".to_string(), file(99, 500)); // changed size => Modified
        fs::write(db.path().join("f.txt"), "x").unwrap();
        let mut base = Baseline::default();
        base.update_entry("f.txt", Some(file(1, 5)));

        let plan = build_plan(empty_inputs(&cfg, &a, &b, &base, BaselineStatusKind::Present));
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(it.action, Action::Conflict);
        assert_eq!(it.conflict, Some(ConflictType::ModifyDelete));
        assert_eq!(it.default_resolution, Some(Resolution::KeepModified));
    }

    #[test]
    fn scan_error_suppresses_deletes() {
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        let cfg = cfg(da.path(), db.path());
        // baseline + B have f.txt; A's scan lacks it AND it's not on disk A — which
        // would normally be DeleteB. But a scan error means absence is *unknown*,
        // so the deletion MUST be suppressed (the data-loss fix).
        let a = BTreeMap::new();
        let mut b = BTreeMap::new();
        b.insert("f.txt".to_string(), file(1, 5));
        fs::write(db.path().join("f.txt"), "x").unwrap();
        let mut base = Baseline::default();
        base.update_entry("f.txt", Some(file(1, 5)));

        let plan = build_plan(PlanInputs {
            cfg: &cfg,
            a: &a,
            b: &b,
            base: &base,
            status: BaselineStatusKind::Present,
            gran_ns: 0,
            warnings: vec![],
            suppress_deletes: true,
        });
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(it.action, Action::Noop, "delete must be suppressed on scan error");
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
    }
}
