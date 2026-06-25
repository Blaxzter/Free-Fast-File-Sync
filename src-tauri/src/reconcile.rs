//! The reconciliation keystone: pure functions from (change_a, change_b,
//! content-identity) to an `Action`. No IO. This encodes the full 5x5 truth
//! table exactly and is the single source of reconciliation truth.
//!
//! Safety invariants enforced here:
//!  1. No cell deletes a side that shows Modified/Created/TypeChanged on the other.
//!  2. The only auto-deletions are Unchanged-vs-Deleted (propagate) and
//!     Deleted-vs-Deleted (converged, no live data remains).
//!  3. Every ambiguous or logically-impossible state yields a Conflict, never a guess.

use crate::model::{ChangeKind, ConflictType, Decision, Meta, Resolution};

use ChangeKind::*;

/// Classify one side's state against the baseline. Metadata-only (size + mtime);
/// content hashing is deferred to the caller for the cells that actually need it.
pub fn classify_change(side: Option<&Meta>, base: Option<&Meta>, gran_ns: i64) -> ChangeKind {
    match (side, base) {
        (None, None) => Unchanged, // not a member of the universe; caller filters these out
        (Some(_), None) => Created,
        (None, Some(_)) => Deleted,
        (Some(s), Some(b)) => {
            if s.kind != b.kind {
                TypeChanged
            } else if s.is_dir() {
                // Directories carry no content; their children reconcile independently.
                Unchanged
            } else if let (Some(sh), Some(bh)) = (&s.hash, &b.hash) {
                // Verify-by-hash mode filled both hashes: trust content identity,
                // not mtime. Catches same-size/same-mtime in-place edits that the
                // metadata heuristic would miss.
                if sh == bh {
                    Unchanged
                } else {
                    Modified
                }
            } else if s.size == b.size && mtime_close(s.mtime_ns, b.mtime_ns, gran_ns) {
                Unchanged
            } else {
                Modified
            }
        }
    }
}

/// mtime equality within filesystem granularity (FAT/exFAT = 2s, NTFS ~100ns).
pub fn mtime_close(a: i64, b: i64, gran_ns: i64) -> bool {
    (a - b).abs() <= gran_ns
}

/// The full 5x5 reconciliation table. `identical` is only consulted for the
/// three "both changed the same way" cells, where byte+type identity collapses
/// the conflict to a baseline advance.
pub fn reconcile(a: ChangeKind, b: ChangeKind, identical: bool) -> Decision {
    use crate::model::Action::*;
    use ConflictType::*;

    match (a, b) {
        // ---- one side unchanged: safe directional propagation ----
        (Unchanged, Unchanged) => Decision::plain(Noop),
        (Unchanged, Created) | (Unchanged, Modified) | (Unchanged, TypeChanged) => {
            Decision::plain(CopyBtoA)
        }
        (Created, Unchanged) | (Modified, Unchanged) | (TypeChanged, Unchanged) => {
            Decision::plain(CopyAtoB)
        }
        (Unchanged, Deleted) => Decision::plain(DeleteA),
        (Deleted, Unchanged) => Decision::plain(DeleteB),

        // ---- both changed the same way: converge or conflict ----
        (Created, Created) => {
            if identical { Decision::plain(UpdateBaselineOnly) } else { Decision::conflict(CreateCreate) }
        }
        (Modified, Modified) => {
            if identical { Decision::plain(UpdateBaselineOnly) } else { Decision::conflict(EditEdit) }
        }
        (TypeChanged, TypeChanged) => {
            if identical { Decision::plain(UpdateBaselineOnly) } else { Decision::conflict(TypeChangeTypeChange) }
        }

        // ---- both deleted: convergent, the only safe symmetric destroy ----
        (Deleted, Deleted) => Decision::plain(UpdateBaselineOnly),

        // ---- DANGER cells: a delete races a change. Never lose the live data. ----
        (Modified, Deleted) | (Deleted, Modified) => Decision::conflict(ModifyDelete),
        (TypeChanged, Deleted) | (Deleted, TypeChanged) => Decision::conflict(DeleteTypeChange),
        (Modified, TypeChanged) | (TypeChanged, Modified) => Decision::conflict(ModifyTypeChange),

        // ---- logically impossible under a consistent baseline ----
        // (a path cannot be Created on one side yet Modified/Deleted/TypeChanged
        //  on the other). Reaching here means the baseline assumptions were
        //  violated — refuse to act and force a rescan.
        (Created, Modified) | (Created, Deleted) | (Created, TypeChanged)
        | (Modified, Created) | (Deleted, Created) | (TypeChanged, Created) => {
            Decision::conflict(StateDesync)
        }
    }
}

/// The data-preserving default resolution offered for each conflict type.
pub fn default_resolution(ct: ConflictType) -> Resolution {
    use ConflictType::*;
    match ct {
        EditEdit | CreateCreate | TypeChangeTypeChange | ModifyTypeChange => Resolution::KeepBoth,
        ModifyDelete => Resolution::KeepModified,
        DeleteTypeChange => Resolution::KeepTypeChanged,
        StateDesync => Resolution::Skip,
    }
}

/// The resolution choices the UI should present for a conflict type. The first
/// element matches `default_resolution`.
pub fn resolution_options(ct: ConflictType) -> Vec<Resolution> {
    use ConflictType::*;
    use Resolution::*;
    match ct {
        EditEdit | CreateCreate | TypeChangeTypeChange => {
            vec![KeepBoth, KeepA, KeepB, KeepNewer, Skip]
        }
        ModifyDelete => vec![KeepModified, PropagateDelete, KeepBoth, Skip],
        DeleteTypeChange => vec![KeepTypeChanged, PropagateDelete, KeepBoth, Skip],
        ModifyTypeChange => vec![KeepBoth, KeepA, KeepB, Skip],
        StateDesync => vec![Skip, KeepA, KeepB, KeepBoth],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Action::*;
    use crate::model::{Action, EntryKind};

    fn file(size: u64, mtime: i64) -> Meta {
        Meta { kind: EntryKind::File, size, mtime_ns: mtime, hash: None }
    }
    fn dir() -> Meta {
        Meta { kind: EntryKind::Dir, size: 0, mtime_ns: 0, hash: None }
    }

    // ---- classify_change ----

    #[test]
    fn classify_created_deleted_unchanged_modified_typechanged() {
        assert_eq!(classify_change(Some(&file(1, 100)), None, 0), Created);
        assert_eq!(classify_change(None, Some(&file(1, 100)), 0), Deleted);
        assert_eq!(classify_change(Some(&file(1, 100)), Some(&file(1, 100)), 0), Unchanged);
        assert_eq!(classify_change(Some(&file(2, 100)), Some(&file(1, 100)), 0), Modified);
        assert_eq!(classify_change(Some(&file(1, 999)), Some(&file(1, 100)), 0), Modified);
        assert_eq!(classify_change(Some(&dir()), Some(&file(1, 100)), 0), TypeChanged);
        assert_eq!(classify_change(Some(&file(1, 100)), Some(&dir()), 0), TypeChanged);
    }

    #[test]
    fn classify_mtime_tolerance_absorbs_fs_granularity() {
        // Within 2s (exFAT) granularity, same size => Unchanged.
        let gran = 2_000_000_000i64;
        assert_eq!(classify_change(Some(&file(10, 1_000_000_000)), Some(&file(10, 0)), gran), Unchanged);
        // Beyond tolerance => Modified.
        assert_eq!(classify_change(Some(&file(10, 3_000_000_000)), Some(&file(10, 0)), gran), Modified);
    }

    #[test]
    fn classify_dirs_with_same_kind_are_unchanged() {
        assert_eq!(classify_change(Some(&dir()), Some(&dir()), 0), Unchanged);
    }

    // ---- the full 25-cell table ----

    fn act(a: ChangeKind, b: ChangeKind, identical: bool) -> Action {
        reconcile(a, b, identical).action
    }
    fn conf(a: ChangeKind, b: ChangeKind) -> ConflictType {
        reconcile(a, b, false).conflict.expect("expected a conflict")
    }

    #[test]
    fn table_unchanged_row() {
        assert_eq!(act(Unchanged, Unchanged, false), Noop);
        assert_eq!(act(Unchanged, Created, false), CopyBtoA);
        assert_eq!(act(Unchanged, Modified, false), CopyBtoA);
        assert_eq!(act(Unchanged, Deleted, false), DeleteA);
        assert_eq!(act(Unchanged, TypeChanged, false), CopyBtoA);
    }

    #[test]
    fn table_mirror_of_unchanged_row() {
        assert_eq!(act(Created, Unchanged, false), CopyAtoB);
        assert_eq!(act(Modified, Unchanged, false), CopyAtoB);
        assert_eq!(act(Deleted, Unchanged, false), DeleteB);
        assert_eq!(act(TypeChanged, Unchanged, false), CopyAtoB);
    }

    #[test]
    fn table_both_changed_same_way_converge_when_identical() {
        assert_eq!(act(Created, Created, true), UpdateBaselineOnly);
        assert_eq!(act(Modified, Modified, true), UpdateBaselineOnly);
        assert_eq!(act(TypeChanged, TypeChanged, true), UpdateBaselineOnly);
    }

    #[test]
    fn table_both_changed_same_way_conflict_when_differing() {
        assert_eq!(conf(Created, Created), ConflictType::CreateCreate);
        assert_eq!(conf(Modified, Modified), ConflictType::EditEdit);
        assert_eq!(conf(TypeChanged, TypeChanged), ConflictType::TypeChangeTypeChange);
    }

    #[test]
    fn table_both_deleted_converges_to_baseline_only() {
        assert_eq!(act(Deleted, Deleted, false), UpdateBaselineOnly);
    }

    #[test]
    fn table_danger_cells_are_conflicts_never_deletes() {
        // The whole point: a delete must never silently win over a live change.
        assert_eq!(conf(Modified, Deleted), ConflictType::ModifyDelete);
        assert_eq!(conf(Deleted, Modified), ConflictType::ModifyDelete);
        assert_eq!(conf(TypeChanged, Deleted), ConflictType::DeleteTypeChange);
        assert_eq!(conf(Deleted, TypeChanged), ConflictType::DeleteTypeChange);
        assert_eq!(conf(Modified, TypeChanged), ConflictType::ModifyTypeChange);
        assert_eq!(conf(TypeChanged, Modified), ConflictType::ModifyTypeChange);

        for (a, b) in [
            (Modified, Deleted), (Deleted, Modified),
            (TypeChanged, Deleted), (Deleted, TypeChanged),
            (Modified, TypeChanged), (TypeChanged, Modified),
        ] {
            let d = reconcile(a, b, false);
            assert!(d.is_conflict());
            assert_ne!(d.action, DeleteA);
            assert_ne!(d.action, DeleteB);
        }
    }

    #[test]
    fn table_impossible_cells_are_state_desync() {
        for (a, b) in [
            (Created, Modified), (Created, Deleted), (Created, TypeChanged),
            (Modified, Created), (Deleted, Created), (TypeChanged, Created),
        ] {
            assert_eq!(reconcile(a, b, false).conflict, Some(ConflictType::StateDesync));
        }
    }

    #[test]
    fn table_is_total_and_symmetric_in_safety() {
        // Every one of the 25 cells produces a decision, and no cell auto-deletes
        // a side that the other side shows as Created/Modified/TypeChanged.
        let kinds = [Unchanged, Created, Modified, Deleted, TypeChanged];
        for a in kinds {
            for b in kinds {
                let d = reconcile(a, b, false);
                // Safety invariant #1.
                if d.action == DeleteA {
                    assert_eq!(a, Unchanged, "DeleteA only when A unchanged");
                }
                if d.action == DeleteB {
                    assert_eq!(b, Unchanged, "DeleteB only when B unchanged");
                }
            }
        }
    }

    #[test]
    fn defaults_preserve_data() {
        assert_eq!(default_resolution(ConflictType::ModifyDelete), Resolution::KeepModified);
        assert_eq!(default_resolution(ConflictType::EditEdit), Resolution::KeepBoth);
        assert_eq!(default_resolution(ConflictType::DeleteTypeChange), Resolution::KeepTypeChanged);
        assert_eq!(default_resolution(ConflictType::StateDesync), Resolution::Skip);
        // The first offered option is always the default.
        for ct in [
            ConflictType::EditEdit, ConflictType::CreateCreate, ConflictType::ModifyDelete,
            ConflictType::DeleteTypeChange, ConflictType::ModifyTypeChange,
            ConflictType::TypeChangeTypeChange, ConflictType::StateDesync,
        ] {
            assert_eq!(resolution_options(ct)[0], default_resolution(ct));
        }
    }
}
