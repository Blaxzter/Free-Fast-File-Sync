//! Core data types shared across the engine. Keys are NFC-normalized,
//! forward-slash relative paths (see `pathutil`). All times are UTC nanoseconds.

use serde::{Deserialize, Serialize};

/// What a directory entry physically is. Symlinks/Other are recorded but never
/// traversed or written through (see scan/fsops).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// Per-path metadata snapshot. `hash` is lazily filled only when content
/// identity actually has to be decided (conflict auto-resolution / verify mode).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    pub kind: EntryKind,
    pub size: u64,
    /// Modification time as signed nanoseconds from the UNIX epoch, UTC.
    pub mtime_ns: i64,
    /// blake3 content hash (hex) for files; `None` until computed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

impl Meta {
    pub fn is_dir(&self) -> bool {
        matches!(self.kind, EntryKind::Dir)
    }
    pub fn is_file(&self) -> bool {
        matches!(self.kind, EntryKind::File)
    }
}

/// One-way post-filter applied to each reconcile `Decision`. It NEVER forks the
/// 25-cell truth table; it is a pure transform of the table's output. `A` is
/// always the canonical "source" for Mirror/Update — the UI flips roots (the
/// five-way `SyncDirection`) by swapping which root is passed as `root_a` in the
/// fan-out helper, so the engine only ever sees the A-as-source forms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SyncMode {
    /// Bidirectional reconciliation — the identity post-filter.
    #[default]
    TwoWay,
    /// `A` is source of truth; `B` becomes a faithful copy of `A` (extras on `B`
    /// are deleted, `B`-side edits are reverted, conflicts collapse to "A wins").
    Mirror,
    /// `A -> B` additive: copy new/changed `A` onto `B`, never delete on `B`,
    /// never write back to `A`. `B`-only files are left untouched.
    Update,
}

/// A side's change relative to the baseline (prior-sync state).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeKind {
    Unchanged,
    Created,
    Modified,
    Deleted,
    TypeChanged,
}

/// The reconciled action for a path. Conflicts carry no direction; the user
/// must pick a `Resolution`. Serializes to a plain string for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Action {
    Noop,
    CopyAtoB,
    CopyBtoA,
    DeleteA,
    DeleteB,
    /// Both sides converged identically (or both deleted): advance baseline, no IO.
    UpdateBaselineOnly,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConflictType {
    /// Both edited the file, results differ.
    EditEdit,
    /// Both created the same new path, contents differ.
    CreateCreate,
    /// One modified, the other deleted — the edit must never be lost silently.
    ModifyDelete,
    /// One deleted, the other replaced file<->dir.
    DeleteTypeChange,
    /// One edited content, the other replaced file<->dir.
    ModifyTypeChange,
    /// Both replaced file<->dir differently.
    TypeChangeTypeChange,
    /// A logically impossible (side_a, side_b) pairing — stale/corrupt baseline,
    /// concurrent external write, or normalization/case mismatch. Refuse to act.
    StateDesync,
}

/// How the user (or a default policy) resolves a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Resolution {
    KeepA,
    KeepB,
    KeepNewer,
    KeepBoth,
    /// For modify/delete: propagate the deletion (discard the edit).
    PropagateDelete,
    /// For modify/delete: keep the modified side (resurrect on the deleted side).
    KeepModified,
    /// For delete/typechange: keep the replacement.
    KeepTypeChanged,
    Skip,
}

/// One reconciliation decision (the action plus an optional conflict tag).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub action: Action,
    pub conflict: Option<ConflictType>,
}

impl Decision {
    pub fn plain(action: Action) -> Self {
        Decision {
            action,
            conflict: None,
        }
    }
    pub fn conflict(ct: ConflictType) -> Self {
        Decision {
            action: Action::Conflict,
            conflict: Some(ct),
        }
    }
    #[allow(dead_code)] // used by the reconcile test suite
    pub fn is_conflict(&self) -> bool {
        self.action == Action::Conflict
    }
}

/// One row of the preview, sent to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct PlanItem {
    pub path: String,
    pub action: Action,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<ConflictType>,
    pub a_change: ChangeKind,
    pub b_change: ChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub a: Option<Meta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub b: Option<Meta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<Meta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_resolution: Option<Resolution>,
    /// Resolution options the UI should offer for this conflict.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub resolution_options: Vec<Resolution>,
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PlanSummary {
    pub total: usize,
    pub copy_a_to_b: usize,
    pub copy_b_to_a: usize,
    pub delete_a: usize,
    pub delete_b: usize,
    pub conflicts: usize,
    pub baseline_only: usize,
    pub noop: usize,
    /// Files that were skipped during scan (symlinks, reparse points, cloud stubs).
    pub skipped: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum BaselineStatusKind {
    /// A valid prior-sync baseline was loaded; deletions may propagate.
    Present,
    /// No baseline yet — first sync. Union-only, zero deletions.
    FirstSync,
    /// Baseline existed but was unreadable/corrupt — fall back to safe union.
    Corrupt,
}

#[derive(Debug, Clone, Serialize)]
pub struct BigDeleteWarning {
    pub deletions: usize,
    pub total_members: usize,
    pub pct: f32,
    pub threshold_pct: f32,
    pub threshold_abs: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncPlan {
    pub root_a: String,
    pub root_b: String,
    pub items: Vec<PlanItem>,
    pub summary: PlanSummary,
    pub baseline_status: BaselineStatusKind,
    /// Set when the run would delete more than the configured threshold.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub big_delete: Option<BigDeleteWarning>,
    /// Non-fatal scan notes (skipped entries, etc.) to show the user.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ItemStatus {
    Done,
    Skipped,
    Failed,
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemOutcome {
    pub path: String,
    pub action: Action,
    pub status: ItemStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ApplyReport {
    pub done: usize,
    pub failed: usize,
    pub skipped: usize,
    pub conflicts: usize,
    pub bytes_copied: u64,
    pub outcomes: Vec<ItemOutcome>,
}
