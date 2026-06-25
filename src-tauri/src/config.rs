//! Per-job configuration, supplied by the UI and persisted alongside the
//! baseline. Defaults are chosen to be safe: gitignore respected, deletes go to
//! the recycle bin, and a big-delete guard trips at 25% or 100 files.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
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

impl JobConfig {
    /// A stable identifier for this root pair, used to name the per-job state dir.
    pub fn job_id(&self) -> String {
        let mut h = blake3::Hasher::new();
        h.update(self.root_a.to_string_lossy().as_bytes());
        h.update(b"\x00");
        h.update(self.root_b.to_string_lossy().as_bytes());
        h.finalize().to_hex()[..16].to_string()
    }
}
