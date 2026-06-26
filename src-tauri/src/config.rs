//! Per-job configuration, supplied by the UI and persisted alongside the
//! baseline. Defaults are chosen to be safe: gitignore respected, deletes go to
//! the recycle bin, and a big-delete guard trips at 25% or 100 files.

use crate::model::SyncMode;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IgnorePolicy {
    /// Honor `.gitignore` files (and `.git/info/exclude`) found in each root.
    #[serde(default = "yes")]
    pub use_gitignore: bool,
    /// Honor non-git `.ignore` files.
    #[serde(default = "yes")]
    pub use_dot_ignore: bool,
    /// Include dotfiles / hidden entries.
    #[serde(default)]
    pub include_hidden: bool,
    /// Extra gitignore-syntax globs (a leading `!` re-includes). Applied to both
    /// roots identically.
    #[serde(default)]
    pub custom_globs: Vec<String>,
}

impl Default for IgnorePolicy {
    fn default() -> Self {
        IgnorePolicy {
            use_gitignore: true,
            use_dot_ignore: true,
            include_hidden: false,
            custom_globs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobConfig {
    pub root_a: PathBuf,
    pub root_b: PathBuf,
    /// One-way mode post-filter. Missing on disk => `TwoWay` (the bidirectional
    /// identity). The five-way frontend direction maps to {mode, root-swap} at
    /// fan-out, so the engine only ever sees the A-as-source forms.
    #[serde(default)]
    pub mode: SyncMode,
    #[serde(default)]
    pub ignore: IgnorePolicy,
    /// Hash files whose metadata looks unchanged but whose counterpart differs,
    /// before trusting "unchanged". Slower, catches same-size/same-mtime edits.
    #[serde(default)]
    pub verify_by_hash: bool,
    /// Trip the big-delete guard if deletions exceed this fraction of members.
    #[serde(default = "default_big_delete_pct")]
    pub big_delete_pct: f32,
    /// ...or this absolute count, whichever is smaller.
    #[serde(default = "default_big_delete_abs")]
    pub big_delete_abs: usize,
    /// Route deletions through the OS recycle bin (recoverable) when possible.
    #[serde(default = "yes")]
    pub use_recycle_bin: bool,
    /// Walker threads per root for the directory scan. `0` => auto (the scan picks
    /// a conservative default sized to the CPU; see `scan::resolve_scan_threads`).
    /// A non-zero value is an explicit override (clamped to a sane maximum). The
    /// dominant speed lever over a high-latency network share, but oversubscribing
    /// SMB can starve the connection — hence configurable, defaulting conservative.
    #[serde(default)]
    pub scan_threads: usize,
    /// mtime comparison tolerance in nanoseconds. `0` => the engine default
    /// (`engine::DEFAULT_GRAN_NS`, 10ms). Exposed so users on coarse-granularity
    /// filesystems (FAT/exFAT/some NAS) can widen it to avoid spurious recopies.
    #[serde(default)]
    pub mtime_gran_ns: i64,
}

fn yes() -> bool {
    true
}
fn default_big_delete_pct() -> f32 {
    0.25
}
fn default_big_delete_abs() -> usize {
    100
}
