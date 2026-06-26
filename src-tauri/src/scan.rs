//! Directory enumeration. Uses the `ignore` crate's `WalkBuilder` so that
//! `.gitignore` / `.ignore` / `.git/info/exclude` are honored natively — the
//! whole reason this tool exists. Both roots are walked with an IDENTICAL filter
//! configuration (no per-machine global gitignore, no parent ignores) so the two
//! sides can't diverge. Symlinks, reparse points/junctions and un-hydrated cloud
//! placeholders are recorded and skipped, never traversed or read.

use crate::config::IgnorePolicy;
use crate::error::{Result, SyncError};
use crate::model::{EntryKind, Meta};
use crate::pathutil::nfc_key;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{WalkBuilder, WalkState};
use std::collections::BTreeMap;
use std::fs::Metadata;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

pub struct ScanResult {
    pub entries: BTreeMap<String, Meta>,
    /// Entries intentionally not synced (symlink, reparse/junction, cloud stub,
    /// special file) — expected, non-fatal.
    pub skipped: Vec<(String, String)>,
    /// Genuine enumeration/stat failures (an unreadable subtree on an offline
    /// drive, revoked ACLs, a controlled-folder lock…). If this is non-empty,
    /// some paths are *unknown*, NOT deleted — the caller MUST suppress deletion
    /// propagation this run so an unreadable file isn't mistaken for a removal.
    pub errors: Vec<(String, String)>,
}

impl ScanResult {
    pub fn had_errors(&self) -> bool {
        !self.errors.is_empty()
    }
}

/// Walk one root into a key→Meta map. Hashes are only computed when `hash_files`
/// (verify-by-hash mode); otherwise change detection is metadata-based.
pub fn scan_root(root: &Path, policy: &IgnorePolicy, hash_files: bool) -> Result<ScanResult> {
    if !root.is_dir() {
        return Err(SyncError::InvalidJob(format!(
            "root is not a directory: {}",
            root.display()
        )));
    }

    let custom = build_custom_matcher(root, &policy.custom_globs)?;
    let custom_for_filter = custom.clone();

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(!policy.include_hidden)
        .ignore(policy.use_dot_ignore)
        .git_ignore(policy.use_gitignore)
        .git_exclude(policy.use_gitignore)
        .git_global(false) // machine-specific ~/.gitignore would break symmetry
        .parents(false) // do not read ignore files above the root
        .require_git(false) // honor .gitignore even when the folder isn't a git repo
        .follow_links(false);

    // Apply the user's custom exclude/include globs with proper gitignore
    // semantics (a leading `!` re-includes). Pruning a directory stops descent.
    builder.filter_entry(move |dent| {
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        !custom_for_filter.matched(dent.path(), is_dir).is_ignore()
    });

    // Walk across a thread pool (the `ignore` crate manages the threads). This is
    // the speed lever over a network share: directory reads and per-entry stats
    // (and hashing in verify mode) overlap instead of serializing one round-trip
    // at a time. Each worker does the expensive metadata/hash work, then briefly
    // locks the shared accumulator to record its result.
    #[derive(Default)]
    struct Acc {
        entries: BTreeMap<String, Meta>,
        skipped: Vec<(String, String)>,
        errors: Vec<(String, String)>,
    }
    let acc = Mutex::new(Acc::default());

    builder.build_parallel().run(|| {
        Box::new(|result| {
            let dent = match result {
                Ok(d) => d,
                Err(e) => {
                    // Could not enumerate a (sub)tree. The mere presence of an
                    // error means part of the tree is unknown, so deletions get
                    // suppressed for the whole run regardless of which path failed.
                    acc.lock()
                        .unwrap()
                        .errors
                        .push((String::new(), format!("walk error: {e}")));
                    return WalkState::Continue;
                }
            };
            let path = dent.path();
            if path == root {
                return WalkState::Continue;
            }
            let rel = match path.strip_prefix(root) {
                Ok(r) => r,
                Err(_) => return WalkState::Continue,
            };
            let key = nfc_key(rel);
            if key.is_empty() {
                return WalkState::Continue;
            }

            // lstat-style metadata (does not follow symlinks).
            let md = match dent.metadata() {
                Ok(m) => m,
                Err(e) => {
                    // A path we KNOW exists but can't stat — unknown, not deleted.
                    acc.lock()
                        .unwrap()
                        .errors
                        .push((key, format!("stat failed: {e}")));
                    return WalkState::Continue;
                }
            };

            if let Some(reason) = unsafe_to_sync(&md, dent.file_type()) {
                acc.lock().unwrap().skipped.push((key, reason.to_string()));
                return WalkState::Continue;
            }

            let kind = if md.is_dir() {
                EntryKind::Dir
            } else if md.is_file() {
                EntryKind::File
            } else {
                acc.lock()
                    .unwrap()
                    .skipped
                    .push((key, "special file (fifo/socket/device)".to_string()));
                return WalkState::Continue;
            };

            // In verify mode, hash file content now so change detection uses
            // content identity, not just size+mtime. A transient read failure
            // degrades to metadata (hash stays None) rather than blocking the run.
            let mut hash = None;
            if kind == EntryKind::File && hash_files {
                match hash_file(path) {
                    Ok(h) => hash = Some(h),
                    Err(e) => acc
                        .lock()
                        .unwrap()
                        .skipped
                        .push((key.clone(), format!("hash unavailable: {e}"))),
                }
            }

            acc.lock().unwrap().entries.insert(
                key,
                Meta {
                    kind,
                    size: if kind == EntryKind::File { md.len() } else { 0 },
                    mtime_ns: mtime_ns(&md),
                    hash,
                },
            );
            WalkState::Continue
        })
    });

    let acc = acc.into_inner().unwrap();
    Ok(ScanResult {
        entries: acc.entries,
        skipped: acc.skipped,
        errors: acc.errors,
    })
}

fn build_custom_matcher(root: &Path, globs: &[String]) -> Result<Gitignore> {
    let mut b = GitignoreBuilder::new(root);
    for g in globs {
        let g = g.trim();
        if g.is_empty() || g.starts_with('#') {
            continue;
        }
        b.add_line(None, g)
            .map_err(|e| SyncError::InvalidJob(format!("invalid glob '{g}': {e}")))?;
    }
    b.build()
        .map_err(|e| SyncError::InvalidJob(format!("could not build ignore matcher: {e}")))
}

/// Returns `Some(reason)` for entries that must never be traversed/copied:
/// symlinks (escape risk + writing through them clobbers the target), Windows
/// reparse points/junctions, and un-hydrated cloud placeholders (reading them
/// either forces a download or yields an empty stub).
fn unsafe_to_sync(md: &Metadata, ft: Option<std::fs::FileType>) -> Option<&'static str> {
    if ft.map(|t| t.is_symlink()).unwrap_or(false) || md.is_symlink() {
        return Some("symlink (not followed)");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE: u32 = 0x0000_0400;
        const OFFLINE: u32 = 0x0000_1000;
        const RECALL_ON_OPEN: u32 = 0x0004_0000;
        const RECALL_ON_DATA: u32 = 0x0040_0000;
        let a = md.file_attributes();
        if a & REPARSE != 0 {
            return Some("reparse point / junction (not traversed)");
        }
        if a & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA) != 0 {
            return Some("cloud placeholder, not hydrated (skipped to avoid data loss)");
        }
    }
    None
}

fn mtime_ns(md: &Metadata) -> i64 {
    match md.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_nanos().min(i64::MAX as u128) as i64,
            Err(e) => -(e.duration().as_nanos().min(i64::MAX as u128) as i64),
        },
        Err(_) => 0,
    }
}

/// Stream a file through blake3 in a bounded buffer (never reads the whole file
/// into memory) and return the hex digest.
pub fn hash_file(path: &Path) -> io::Result<String> {
    let f = std::fs::File::open(crate::pathutil::extended(path))?;
    let mut hasher = blake3::Hasher::new();
    hasher.update_reader(f)?;
    Ok(hasher.finalize().to_hex().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn scan_honors_gitignore() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "ignored.txt\nbuild/\n").unwrap();
        fs::write(root.join("keep.txt"), "hi").unwrap();
        fs::write(root.join("ignored.txt"), "no").unwrap();
        fs::create_dir(root.join("build")).unwrap();
        fs::write(root.join("build").join("out.bin"), "x").unwrap();

        let res = scan_root(root, &IgnorePolicy::default(), false).unwrap();
        assert!(res.entries.contains_key("keep.txt"));
        assert!(!res.entries.contains_key("ignored.txt"));
        assert!(!res.entries.keys().any(|k| k.starts_with("build")));
        // The .gitignore file itself is hidden? No — it's a dotfile; default
        // hidden(true) hides dotfiles, so it should be absent.
        assert!(!res.entries.contains_key(".gitignore"));
    }

    #[test]
    fn custom_globs_exclude_and_negate() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.log"), "1").unwrap();
        fs::write(root.join("b.log"), "2").unwrap();
        fs::write(root.join("c.txt"), "3").unwrap();

        let mut policy = IgnorePolicy::default();
        policy.custom_globs = vec!["*.log".into(), "!b.log".into()];
        let res = scan_root(root, &policy, false).unwrap();
        assert!(!res.entries.contains_key("a.log"));
        assert!(res.entries.contains_key("b.log")); // re-included by negation
        assert!(res.entries.contains_key("c.txt"));
    }

    #[test]
    fn hashing_is_stable() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("f.bin");
        fs::write(&p, b"hello world").unwrap();
        let h1 = hash_file(&p).unwrap();
        let h2 = hash_file(&p).unwrap();
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64); // blake3 = 32 bytes hex
    }
}
