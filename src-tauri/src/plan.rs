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
    let PlanInputs {
        cfg,
        a,
        b,
        base,
        status,
        gran_ns,
        warnings,
        suppress_deletes,
    } = inp;
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

        let reconciled = reconcile(a_change, b_change, identical);

        // Apply the one-way SyncMode post-filter immediately AFTER reconcile()
        // and BEFORE the block_deletes clamp, so any delete (or destructive
        // overwrite) the mode introduces is still gated by the same suppression.
        let mut decision = apply_mode(cfg.mode, reconciled, a_change, b_change);

        // Defense in depth: never delete when the baseline is untrustworthy
        // (first sync / corrupt) OR when a scan error means absence is unknown.
        if block_deletes && matches!(decision.action, Action::DeleteA | Action::DeleteB) {
            decision = Decision::plain(Action::Noop);
        }

        // A Mirror revert that overwrites a destination the destination itself
        // changed (Modified/Created/TypeChanged) is MORALLY A DELETE of that
        // edit. When deletes are suppressed it must be neutralized too: the mode
        // turned a CopyBtoA (a B-side change) into a CopyAtoB that would clobber
        // live B data. Detect it as "the post-filter changed the action AND the
        // result overwrites a destination that the destination changed".
        if block_deletes
            && is_mode_induced_destructive_overwrite(reconciled, decision, a_change, b_change)
        {
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

/// Post-filter a reconcile `Decision` under a one-way `SyncMode`. PURE: no IO.
///
/// `a`/`b` are the per-side `ChangeKind`s that produced `d`. `A` is the source
/// of truth for Mirror/Update. `TwoWay` is the identity. This is applied AFTER
/// `reconcile()` and BEFORE the `block_deletes` clamp (wired in S3), so every
/// delete it emits is still gated by first-sync / corrupt / scan-error
/// suppression and counted by the big-delete guard.
///
/// Safety: it never forks the truth table — it only lowers the table's output
/// to other *existing* `Action` variants. `StateDesync` is never collapsed.
fn apply_mode(mode: SyncMode, d: Decision, a: ChangeKind, b: ChangeKind) -> Decision {
    use crate::model::Action::*;
    match mode {
        // Identity — the sacred bidirectional path is preserved exactly.
        SyncMode::TwoWay => d,

        SyncMode::Update => match d.action {
            // `A -> B` additive. Anything that would change `A`, or delete on `B`,
            // is neutralized; a `B`-side change is not pulled back to `A`.
            CopyBtoA => Decision::plain(Noop), // B's change does not flow back to A
            // `(Unchanged, Deleted)` reconciles to DeleteA: B deleted a file A
            // still holds. Update never deletes the source A; but mapping to Noop
            // would re-evaluate this cell forever (B stays Deleted vs an unchanged
            // baseline). Advance the baseline so the cell converges; A's copy is
            // re-propagated A->B on the next run via the normal additive path.
            DeleteA => Decision::plain(UpdateBaselineOnly),
            DeleteB => Decision::plain(Noop), // Update never deletes on B
            Conflict => collapse_conflict_update(d, a),
            // CopyAtoB, Noop, UpdateBaselineOnly pass through unchanged.
            _ => d,
        },

        SyncMode::Mirror => match d.action {
            // Make `B` identical to `A`.
            CopyBtoA => mirror_revert_b(a, b), // a B-side change: revert B toward A
            DeleteA => Decision::plain(Noop),  // never delete the source of truth
            DeleteB => d, // A deleted it => delete on B (propagate). Clamp-gated.
            Conflict => collapse_conflict_mirror(d, a),
            // CopyAtoB, Noop, UpdateBaselineOnly pass through unchanged.
            _ => d,
        },
    }
}

/// A Mirror revert that overwrites live destination data the destination
/// *itself* changed is morally a delete of that edit, even though its `Action`
/// is a `Copy` (so the plain delete clamp above never catches it). Detect that
/// case so the `block_deletes` clamp can neutralize it to `Noop`.
///
/// Conditions, all required:
///  * the mode post-filter actually CHANGED the action (a pure pass-through copy
///    that reconcile itself produced, e.g. a first-sync `CopyAtoB`, is a normal
///    propagation and must NOT be suppressed); and
///  * the resulting action overwrites a destination whose own side changed
///    (`Modified | Created | TypeChanged`) — i.e. there is a live edit on the
///    destination that the overwrite would clobber.
fn is_mode_induced_destructive_overwrite(
    reconciled: Decision,
    filtered: Decision,
    a_change: ChangeKind,
    b_change: ChangeKind,
) -> bool {
    use ChangeKind::*;
    // The filter must have rewritten the action; an unchanged decision is the
    // table's own (already-clamped) output.
    if reconciled.action == filtered.action {
        return false;
    }
    let dst_changed = |c: ChangeKind| matches!(c, Modified | Created | TypeChanged);
    match filtered.action {
        // CopyAtoB overwrites B; destructive only if B itself holds a live edit.
        Action::CopyAtoB => dst_changed(b_change),
        // Defensive symmetric case (engine never emits it under A-as-source).
        Action::CopyBtoA => dst_changed(a_change),
        _ => false,
    }
}

/// Mirror: `B` changed but `A` did not (the only way reconcile yields
/// `CopyBtoA`). Revert `B` to match the source `A`.
#[allow(dead_code)] // exercised by apply_mode (wired in S3) + unit tests
fn mirror_revert_b(a: ChangeKind, b: ChangeKind) -> Decision {
    use crate::model::Action::*;
    use ChangeKind::*;
    match (a, b) {
        // A unchanged, B created an extra -> remove the extra from B (clamp-gated).
        (Unchanged, Created) => Decision::plain(DeleteB),
        // A unchanged, B edited / retyped -> overwrite B with A's content.
        (Unchanged, Modified) | (Unchanged, TypeChanged) => Decision::plain(CopyAtoB),
        // Defensive: reconcile produces CopyBtoA only for the cells above. If it
        // ever yielded another shape, the safe action is to overwrite B from A,
        // never to act on A.
        _ => Decision::plain(CopyAtoB),
    }
}

/// Mirror collapses every resolvable conflict to "A wins": `B` is made to match
/// `A`. The one exception preserving the data-loss invariant: `StateDesync`
/// (inconsistent/desynced baseline) is NEVER auto-collapsed — it stays a
/// `Conflict` so the user must rescan/decide, exactly as in `TwoWay`.
#[allow(dead_code)] // exercised by apply_mode (wired in S3) + unit tests
fn collapse_conflict_mirror(d: Decision, a: ChangeKind) -> Decision {
    use crate::model::Action::*;
    use ChangeKind::*;
    match d.conflict {
        Some(ConflictType::StateDesync) => d, // refuse-to-act preserved
        Some(_) => match a {
            // A still holds live content -> push A over B.
            Created | Modified | TypeChanged | Unchanged => Decision::plain(CopyAtoB),
            // A is the side that deleted (ModifyDelete / DeleteTypeChange with
            // A == Deleted): "A wins" means the file is gone at the source ->
            // delete on B (clamp-gated).
            Deleted => Decision::plain(DeleteB),
        },
        // A Conflict always carries a ConflictType; unreachable in practice.
        None => d,
    }
}

/// Update collapses conflicts only in the additive `A -> B` direction, and NEVER
/// deletes. Where "A wins" would require deleting `B` (an A-side deletion
/// conflict), Update instead leaves the row as a `Conflict` — it cannot delete,
/// and silently keeping B's stale copy would misrepresent the additive intent.
#[allow(dead_code)] // exercised by apply_mode (wired in S3) + unit tests
fn collapse_conflict_update(d: Decision, a: ChangeKind) -> Decision {
    use crate::model::Action::*;
    use ChangeKind::*;
    match d.conflict {
        Some(ConflictType::StateDesync) => d,
        Some(_) => match a {
            Created | Modified | TypeChanged | Unchanged => Decision::plain(CopyAtoB),
            // Would need a delete on B; Update never deletes -> stays Conflict.
            Deleted => d,
        },
        None => d,
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
            items[i].note = "case-only name collision on a case-insensitive filesystem".to_string();
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
        Meta {
            kind: EntryKind::File,
            size,
            mtime_ns: mtime,
            hash: None,
        }
    }

    fn empty_inputs<'a>(
        cfg: &'a JobConfig,
        a: &'a BTreeMap<String, Meta>,
        b: &'a BTreeMap<String, Meta>,
        base: &'a Baseline,
        status: BaselineStatusKind,
    ) -> PlanInputs<'a> {
        PlanInputs {
            cfg,
            a,
            b,
            base,
            status,
            gran_ns: 0,
            warnings: vec![],
            suppress_deletes: false,
        }
    }

    fn cfg(root_a: &Path, root_b: &Path) -> JobConfig {
        JobConfig {
            root_a: root_a.to_path_buf(),
            root_b: root_b.to_path_buf(),
            mode: SyncMode::TwoWay,
            ignore: Default::default(),
            verify_by_hash: false,
            big_delete_pct: 0.25,
            big_delete_abs: 100,
            use_recycle_bin: true,
        }
    }

    fn mirror_cfg(root_a: &Path, root_b: &Path) -> JobConfig {
        let mut c = cfg(root_a, root_b);
        c.mode = SyncMode::Mirror;
        c
    }

    /// Build inputs choosing baseline status and the scan-error suppress flag.
    fn inputs_with<'a>(
        cfg: &'a JobConfig,
        a: &'a BTreeMap<String, Meta>,
        b: &'a BTreeMap<String, Meta>,
        base: &'a Baseline,
        status: BaselineStatusKind,
        suppress_deletes: bool,
    ) -> PlanInputs<'a> {
        PlanInputs {
            cfg,
            a,
            b,
            base,
            status,
            gran_ns: 0,
            warnings: vec![],
            suppress_deletes,
        }
    }

    // ---- S3: SyncMode wired through build_plan + Mirror-revert clamp/archive ----

    /// In Mirror, a B-extra (A unchanged, B created) becomes a DeleteB. That
    /// delete must be SUPPRESSED whenever the baseline is untrustworthy or a scan
    /// error means absence is unknown — exactly like a native delete.
    fn mirror_extra_setup() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        BTreeMap<String, Meta>,
        BTreeMap<String, Meta>,
        Baseline,
    ) {
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        // A unchanged (matches base), B has an extra file not in base.
        let mut a = BTreeMap::new();
        a.insert("keep.txt".to_string(), file(1, 1));
        fs::write(da.path().join("keep.txt"), "x").unwrap();
        let mut b = BTreeMap::new();
        b.insert("keep.txt".to_string(), file(1, 1));
        b.insert("extra.txt".to_string(), file(2, 9));
        fs::write(db.path().join("keep.txt"), "x").unwrap();
        fs::write(db.path().join("extra.txt"), "yy").unwrap();
        let mut base = Baseline::default();
        base.update_entry("keep.txt", Some(file(1, 1)));
        (da, db, a, b, base)
    }

    #[test]
    fn mirror_delete_suppressed_on_first_sync() {
        let (da, db, a, b, base) = mirror_extra_setup();
        let cfg = mirror_cfg(da.path(), db.path());
        let plan = build_plan(inputs_with(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::FirstSync,
            false,
        ));
        let it = plan.items.iter().find(|i| i.path == "extra.txt").unwrap();
        assert_eq!(
            it.action,
            Action::Noop,
            "mirror extra-delete must be suppressed on first sync"
        );
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
    }

    #[test]
    fn mirror_delete_suppressed_on_corrupt_baseline() {
        let (da, db, a, b, base) = mirror_extra_setup();
        let cfg = mirror_cfg(da.path(), db.path());
        let plan = build_plan(inputs_with(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Corrupt,
            false,
        ));
        let it = plan.items.iter().find(|i| i.path == "extra.txt").unwrap();
        assert_eq!(
            it.action,
            Action::Noop,
            "mirror extra-delete must be suppressed on corrupt baseline"
        );
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
    }

    #[test]
    fn mirror_delete_suppressed_on_scan_error() {
        let (da, db, a, b, base) = mirror_extra_setup();
        let cfg = mirror_cfg(da.path(), db.path());
        // Present baseline but a scan error => absence unknown => suppress.
        let plan = build_plan(inputs_with(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Present,
            true,
        ));
        let it = plan.items.iter().find(|i| i.path == "extra.txt").unwrap();
        assert_eq!(
            it.action,
            Action::Noop,
            "mirror extra-delete must be suppressed on scan error"
        );
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
    }

    /// A Mirror revert that overwrites a B-side EDIT (A unchanged, B modified) is
    /// morally a delete of that edit (its Action is CopyAtoB, so the plain delete
    /// clamp never catches it). It must ALSO be neutralized to Noop whenever
    /// deletes are suppressed — this was the data-loss gap the critique flagged.
    fn mirror_revert_setup() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        BTreeMap<String, Meta>,
        BTreeMap<String, Meta>,
        Baseline,
    ) {
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        // base + A both at v1; B edited it (size differs => Modified).
        let mut a = BTreeMap::new();
        a.insert("f.txt".to_string(), file(1, 1));
        fs::write(da.path().join("f.txt"), "a").unwrap();
        let mut b = BTreeMap::new();
        b.insert("f.txt".to_string(), file(99, 500)); // Modified on B
        fs::write(db.path().join("f.txt"), "edited-on-b").unwrap();
        let mut base = Baseline::default();
        base.update_entry("f.txt", Some(file(1, 1)));
        (da, db, a, b, base)
    }

    #[test]
    fn mirror_revert_overwrite_suppressed_on_first_sync() {
        let (da, db, a, b, base) = mirror_revert_setup();
        let cfg = mirror_cfg(da.path(), db.path());
        let plan = build_plan(inputs_with(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::FirstSync,
            false,
        ));
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(
            it.action,
            Action::Noop,
            "mirror revert-overwrite of a B edit must be neutralized on first sync"
        );
    }

    #[test]
    fn mirror_revert_overwrite_suppressed_on_corrupt() {
        let (da, db, a, b, base) = mirror_revert_setup();
        let cfg = mirror_cfg(da.path(), db.path());
        let plan = build_plan(inputs_with(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Corrupt,
            false,
        ));
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(
            it.action,
            Action::Noop,
            "mirror revert-overwrite of a B edit must be neutralized on corrupt baseline"
        );
    }

    #[test]
    fn mirror_revert_overwrite_suppressed_on_scan_error() {
        let (da, db, a, b, base) = mirror_revert_setup();
        let cfg = mirror_cfg(da.path(), db.path());
        let plan = build_plan(inputs_with(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Present,
            true,
        ));
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(
            it.action,
            Action::Noop,
            "mirror revert-overwrite of a B edit must be neutralized on scan error"
        );
    }

    #[test]
    fn mirror_revert_overwrite_happens_when_baseline_trusted() {
        // Control: with a trustworthy baseline and a clean scan, the revert DOES
        // overwrite B (CopyAtoB) — the clamp must not over-suppress.
        let (da, db, a, b, base) = mirror_revert_setup();
        let cfg = mirror_cfg(da.path(), db.path());
        let plan = build_plan(inputs_with(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Present,
            false,
        ));
        let it = plan.items.iter().find(|i| i.path == "f.txt").unwrap();
        assert_eq!(
            it.action,
            Action::CopyAtoB,
            "trusted Mirror must revert B's edit via CopyAtoB"
        );
    }

    #[test]
    fn mirror_extra_delete_counts_toward_big_delete_guard() {
        // Many B-extras under a trusted baseline => many DeleteB => guard trips.
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        let mut c = mirror_cfg(da.path(), db.path());
        c.big_delete_abs = 3;
        c.big_delete_pct = 1.0;
        let a = BTreeMap::new();
        let mut b = BTreeMap::new();
        let base = Baseline::default(); // empty base, but status forced Present
        for i in 0..5 {
            let k = format!("extra{i}.txt");
            b.insert(k.clone(), file(1, 1));
            fs::write(db.path().join(&k), "x").unwrap();
            // A absent, base absent => B Created => CopyBtoA => Mirror => DeleteB.
        }
        let plan = build_plan(inputs_with(
            &c,
            &a,
            &b,
            &base,
            BaselineStatusKind::Present,
            false,
        ));
        assert_eq!(
            plan.summary.delete_b, 5,
            "all five B extras become mirror deletes"
        );
        assert!(
            plan.big_delete.is_some(),
            "mirror-induced deletes must count toward the big-delete guard"
        );
    }

    #[test]
    fn mirror_filtered_file_still_on_disk_not_deleted() {
        // B has a file present on disk but absent from B's scan (newly gitignored).
        // The filtered-file guard runs before any mode decision => never deleted.
        let da = tempdir().unwrap();
        let db = tempdir().unwrap();
        let cfg = mirror_cfg(da.path(), db.path());
        let mut a = BTreeMap::new();
        a.insert("keep.txt".to_string(), file(1, 1));
        fs::write(da.path().join("keep.txt"), "x").unwrap();
        // f.log is in base + A scan but absent from B scan while STILL on disk B.
        a.insert("f.log".to_string(), file(1, 5));
        fs::write(da.path().join("f.log"), "x").unwrap();
        fs::write(db.path().join("f.log"), "still here").unwrap(); // on disk, not scanned
        let mut b = BTreeMap::new();
        b.insert("keep.txt".to_string(), file(1, 1));
        fs::write(db.path().join("keep.txt"), "x").unwrap();
        let mut base = Baseline::default();
        base.update_entry("keep.txt", Some(file(1, 1)));
        base.update_entry("f.log", Some(file(1, 5)));

        let plan = build_plan(inputs_with(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Present,
            false,
        ));
        // f.log excluded entirely: no delete, no overwrite — left alone on disk.
        assert!(plan.items.iter().all(|i| i.path != "f.log"));
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
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

        let plan = build_plan(empty_inputs(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::FirstSync,
        ));
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

        let plan = build_plan(empty_inputs(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Present,
        ));
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

        let plan = build_plan(empty_inputs(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Present,
        ));
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

        let plan = build_plan(empty_inputs(
            &cfg,
            &a,
            &b,
            &base,
            BaselineStatusKind::Present,
        ));
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
        assert_eq!(
            it.action,
            Action::Noop,
            "delete must be suppressed on scan error"
        );
        assert_eq!(plan.summary.delete_a + plan.summary.delete_b, 0);
    }

    // ---- apply_mode (pure post-filter; no IO) ----

    /// The 5 ChangeKinds, in a fixed order, for exhaustive 5x5 = 25-cell sweeps.
    const KINDS: [ChangeKind; 5] = [
        ChangeKind::Unchanged,
        ChangeKind::Created,
        ChangeKind::Modified,
        ChangeKind::Deleted,
        ChangeKind::TypeChanged,
    ];

    /// `identical` is irrelevant for the dangerous/directional cells; sweeping
    /// both values keeps the "all 25 cells, both identity values" coverage honest.
    fn for_all_cells(mut f: impl FnMut(ChangeKind, ChangeKind, bool, Decision)) {
        for &a in &KINDS {
            for &b in &KINDS {
                for identical in [false, true] {
                    let d = reconcile(a, b, identical);
                    f(a, b, identical, d);
                }
            }
        }
    }

    #[test]
    fn twoway_is_identity_over_all_25_cells() {
        for_all_cells(|a, b, _id, d| {
            let out = apply_mode(SyncMode::TwoWay, d, a, b);
            assert_eq!(
                out.action, d.action,
                "TwoWay must not change the action for ({a:?},{b:?})"
            );
            assert_eq!(
                out.conflict, d.conflict,
                "TwoWay must not change the conflict for ({a:?},{b:?})"
            );
        });
    }

    #[test]
    fn mirror_never_acts_on_source_a() {
        // A is the source of truth: Mirror must never delete A and never write to A.
        for_all_cells(|a, b, _id, d| {
            let out = apply_mode(SyncMode::Mirror, d, a, b);
            assert_ne!(
                out.action,
                Action::DeleteA,
                "Mirror deleted source A for ({a:?},{b:?})"
            );
            assert_ne!(
                out.action,
                Action::CopyBtoA,
                "Mirror wrote back to A for ({a:?},{b:?})"
            );
        });
    }

    #[test]
    fn update_never_deletes() {
        for_all_cells(|a, b, _id, d| {
            let out = apply_mode(SyncMode::Update, d, a, b);
            assert_ne!(
                out.action,
                Action::DeleteA,
                "Update deleted A for ({a:?},{b:?})"
            );
            assert_ne!(
                out.action,
                Action::DeleteB,
                "Update deleted B for ({a:?},{b:?})"
            );
        });
    }

    #[test]
    fn update_never_writes_back_to_a() {
        for_all_cells(|a, b, _id, d| {
            let out = apply_mode(SyncMode::Update, d, a, b);
            assert_ne!(
                out.action,
                Action::CopyBtoA,
                "Update wrote back to A for ({a:?},{b:?})"
            );
        });
    }

    #[test]
    fn statedesync_never_collapsed() {
        // The 6 logically-impossible cells reconcile to StateDesync. Neither mode
        // may collapse them — they stay a Conflict carrying StateDesync.
        let desync_cells = [
            (ChangeKind::Created, ChangeKind::Modified),
            (ChangeKind::Created, ChangeKind::Deleted),
            (ChangeKind::Created, ChangeKind::TypeChanged),
            (ChangeKind::Modified, ChangeKind::Created),
            (ChangeKind::Deleted, ChangeKind::Created),
            (ChangeKind::TypeChanged, ChangeKind::Created),
        ];
        for (a, b) in desync_cells {
            let d = reconcile(a, b, false);
            assert_eq!(
                d.conflict,
                Some(ConflictType::StateDesync),
                "precondition ({a:?},{b:?})"
            );
            for mode in [SyncMode::Mirror, SyncMode::Update] {
                let out = apply_mode(mode, d, a, b);
                assert_eq!(
                    out.action,
                    Action::Conflict,
                    "{mode:?} collapsed StateDesync ({a:?},{b:?})"
                );
                assert_eq!(
                    out.conflict,
                    Some(ConflictType::StateDesync),
                    "{mode:?} dropped StateDesync tag ({a:?},{b:?})"
                );
            }
        }
    }

    #[test]
    fn mirror_b_extra_becomes_deleteb() {
        // A unchanged, B created an extra (reconcile => CopyBtoA). Mirror removes it.
        use ChangeKind::*;
        let d = reconcile(Unchanged, Created, false);
        assert_eq!(d.action, Action::CopyBtoA);
        let out = apply_mode(SyncMode::Mirror, d, Unchanged, Created);
        assert_eq!(out.action, Action::DeleteB);
    }

    #[test]
    fn mirror_b_edit_reverts_via_copyatob() {
        use ChangeKind::*;
        for b in [Modified, TypeChanged] {
            let d = reconcile(Unchanged, b, false);
            assert_eq!(
                d.action,
                Action::CopyBtoA,
                "precondition for (Unchanged,{b:?})"
            );
            let out = apply_mode(SyncMode::Mirror, d, Unchanged, b);
            assert_eq!(
                out.action,
                Action::CopyAtoB,
                "Mirror should revert B via CopyAtoB for {b:?}"
            );
        }
    }

    #[test]
    fn mirror_a_delete_propagates_deleteb() {
        use ChangeKind::*;
        let d = reconcile(Deleted, Unchanged, false);
        assert_eq!(d.action, Action::DeleteB);
        let out = apply_mode(SyncMode::Mirror, d, Deleted, Unchanged);
        assert_eq!(
            out.action,
            Action::DeleteB,
            "Mirror propagates a source-side delete to B"
        );
    }

    #[test]
    fn mirror_modifydelete_preserves_live_a() {
        use ChangeKind::*;
        // A modified, B deleted => A holds the live edit; Mirror pushes A over B.
        let d = reconcile(Modified, Deleted, false);
        assert_eq!(d.conflict, Some(ConflictType::ModifyDelete));
        let out = apply_mode(SyncMode::Mirror, d, Modified, Deleted);
        assert_eq!(
            out.action,
            Action::CopyAtoB,
            "Mirror must preserve A's live edit"
        );

        // A deleted, B modified => A is the deleting side; "A wins" => delete on B.
        let d2 = reconcile(Deleted, Modified, false);
        assert_eq!(d2.conflict, Some(ConflictType::ModifyDelete));
        let out2 = apply_mode(SyncMode::Mirror, d2, Deleted, Modified);
        assert_eq!(
            out2.action,
            Action::DeleteB,
            "Mirror: A deleted => mirror the delete to B"
        );
    }

    #[test]
    fn update_modifydelete_with_a_deleted_stays_conflict() {
        use ChangeKind::*;
        // A deleted, B modified: "A wins" would require deleting B, which Update
        // refuses to do, so the row stays a Conflict for the user to resolve.
        let d = reconcile(Deleted, Modified, false);
        assert_eq!(d.conflict, Some(ConflictType::ModifyDelete));
        let out = apply_mode(SyncMode::Update, d, Deleted, Modified);
        assert_eq!(
            out.action,
            Action::Conflict,
            "Update can't delete B => stays Conflict"
        );
        assert_eq!(out.conflict, Some(ConflictType::ModifyDelete));

        // A modified, B deleted: A is live => Update pushes A over B additively.
        let d2 = reconcile(Modified, Deleted, false);
        let out2 = apply_mode(SyncMode::Update, d2, Modified, Deleted);
        assert_eq!(out2.action, Action::CopyAtoB);
    }

    #[test]
    fn update_b_delete_of_unchanged_a_converges_via_baseline_advance() {
        use ChangeKind::*;
        // (Unchanged, Deleted) reconciles to DeleteA. Update never deletes A; to
        // avoid re-evaluating this cell forever it advances the baseline.
        let d = reconcile(Unchanged, Deleted, false);
        assert_eq!(d.action, Action::DeleteA);
        let out = apply_mode(SyncMode::Update, d, Unchanged, Deleted);
        assert_eq!(
            out.action,
            Action::UpdateBaselineOnly,
            "Update records B's delete in the baseline so the cell converges"
        );
    }

    #[test]
    fn apply_mode_is_total() {
        // 3 modes x 25 cells (x both identity values) never panics and always
        // yields a well-formed Decision (Conflict <=> a conflict tag is present).
        for mode in [SyncMode::TwoWay, SyncMode::Mirror, SyncMode::Update] {
            for_all_cells(|a, b, _id, d| {
                let out = apply_mode(mode, d, a, b);
                let is_conflict = out.action == Action::Conflict;
                assert_eq!(
                    is_conflict,
                    out.conflict.is_some(),
                    "{mode:?} produced an inconsistent Decision for ({a:?},{b:?}): {out:?}"
                );
            });
        }
    }
}
