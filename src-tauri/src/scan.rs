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
use std::collections::{BTreeMap, HashMap};
use std::fs::Metadata;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

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

/// Absolute upper bound for an EXPLICIT thread-count override. A scan over a
/// network share keeps one OS thread (and one SMB handle) busy per in-flight
/// request; past a few dozen the connection table is the bottleneck, and a runaway
/// value could exhaust handles. Power users can still dial up to here.
const MAX_SCAN_THREADS: usize = 256;

/// The auto (default) walker thread count when the caller passes `0`.
///
/// A directory scan — especially over a high-latency network share (SMB/NAS) — is
/// bound by per-entry round-trip latency, not CPU, so SOME oversubscription helps
/// keep requests in flight. But too many threads holding SMB handles can stall or
/// exhaust the connection (the large-NAS-scan hang this default guards against), so
/// the auto value is deliberately conservative: the CPU count, clamped to a modest
/// band. Users who want the old aggressive value set an explicit override in
/// Settings (global) or per job.
fn default_scan_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().clamp(4, 16))
        .unwrap_or(8)
}

/// Resolve the effective walker thread count. `0` => the conservative auto
/// default; any other value is an explicit override, clamped to a sane maximum.
pub fn resolve_scan_threads(requested: usize) -> usize {
    if requested == 0 {
        default_scan_threads()
    } else {
        requested.clamp(1, MAX_SCAN_THREADS)
    }
}

/// Live, shallow folder-activity tracker for the scan phase. The parallel walk
/// bumps a per-folder count as each entry is recorded; the run layer's scan
/// ticker polls [`snapshot`](ScanTree::snapshot) to drive the live folder tree in
/// the UI.
///
/// Buckets are keyed by the first `depth` path segments (`depth == 1` => top-level
/// folders), so cardinality is bounded to the breadth of the tree's SHALLOW levels
/// — cheap to hold and to snapshot, and the dominant reason the per-entry cost
/// stays negligible on the (already perf-tuned) scan hot loop. Sharded so that
/// per-entry increment under many walker threads doesn't serialize on one lock.
/// Distinct keys per shard are capped (overflow folds into the root bucket) so a
/// pathologically deep `depth` can never grow the map without bound.
pub struct ScanTree {
    depth: usize,
    shards: Vec<Mutex<HashMap<String, u64>>>,
}

/// Per-shard distinct-key cap (overflow folds into the root bucket).
const SCAN_TREE_MAX_KEYS_PER_SHARD: usize = 256;
/// Shard count — a small power of two; trades a little memory for far less lock
/// contention on the hot loop. Snapshotting merges across all shards.
const SCAN_TREE_SHARDS: usize = 16;

impl ScanTree {
    /// `depth` is the number of leading path segments to key on (clamped to >= 1).
    pub fn new(depth: usize) -> ScanTree {
        let mut shards = Vec::with_capacity(SCAN_TREE_SHARDS);
        for _ in 0..SCAN_TREE_SHARDS {
            shards.push(Mutex::new(HashMap::new()));
        }
        ScanTree {
            depth: depth.max(1),
            shards,
        }
    }

    /// The bucket an entry contributes to: the first `depth` segments of the folder
    /// it lives in (a file's PARENT dir; a directory entry ITSELF). Root-level files
    /// map to `""`. Returns a borrow of `key` — no allocation on the hot path.
    fn bucket<'a>(&self, key: &'a str, is_dir: bool) -> &'a str {
        let dir_path: &str = if is_dir {
            key
        } else {
            match key.rfind('/') {
                Some(i) => &key[..i],
                None => "",
            }
        };
        if dir_path.is_empty() {
            return "";
        }
        match dir_path.match_indices('/').nth(self.depth - 1) {
            Some((i, _)) => &dir_path[..i],
            None => dir_path,
        }
    }

    /// Record one recorded entry under its bucket. One short lock on a single
    /// shard; allocates only when first seeing a bucket. A poisoned lock is ignored
    /// — live progress is non-critical and must never panic the scan.
    pub fn record(&self, key: &str, is_dir: bool) {
        let bucket = self.bucket(key, is_dir);
        let shard = &self.shards[shard_index(bucket)];
        if let Ok(mut map) = shard.lock() {
            if let Some(c) = map.get_mut(bucket) {
                *c += 1;
            } else if map.len() < SCAN_TREE_MAX_KEYS_PER_SHARD {
                map.insert(bucket.to_string(), 1);
            } else {
                *map.entry(String::new()).or_insert(0) += 1;
            }
        }
    }

    /// Reset all per-folder counts. Called at each pair boundary so the live view
    /// shows only the pair currently being scanned (scans run pair-sequentially).
    pub fn clear(&self) {
        for shard in &self.shards {
            if let Ok(mut map) = shard.lock() {
                map.clear();
            }
        }
    }

    /// Merge all shards into a count-descending list, capped to `max` folders.
    /// Called only by the poller (~ticker cadence), so the merge cost is irrelevant.
    pub fn snapshot(&self, max: usize) -> Vec<(String, u64)> {
        let mut merged: HashMap<String, u64> = HashMap::new();
        for shard in &self.shards {
            if let Ok(map) = shard.lock() {
                for (k, v) in map.iter() {
                    *merged.entry(k.clone()).or_insert(0) += *v;
                }
            }
        }
        let mut folders: Vec<(String, u64)> = merged.into_iter().collect();
        folders.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        folders.truncate(max);
        folders
    }
}

/// Pick a shard for `key` via a tiny FNV-1a hash. Stable and allocation-free.
fn shard_index(key: &str) -> usize {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h as usize) % SCAN_TREE_SHARDS
}

/// Per-thread accumulator. Every walker thread fills its OWN `Acc` (no shared
/// lock), then ships it back over a channel exactly once when the thread's visitor
/// is dropped (`Outbox::drop`). This replaces the previous shared `Mutex<Acc>` +
/// per-entry `.lock().unwrap()`: that pattern poisoned the mutex if any single
/// worker panicked, after which every other worker's `.lock().unwrap()` panicked
/// too — a one-off failure cascaded into a total scan crash. With per-thread
/// accumulators there is no shared lock to poison.
#[derive(Default)]
struct Acc {
    entries: BTreeMap<String, Meta>,
    skipped: Vec<(String, String)>,
    errors: Vec<(String, String)>,
}

impl Acc {
    fn absorb(&mut self, other: Acc) {
        self.entries.extend(other.entries);
        self.skipped.extend(other.skipped);
        self.errors.extend(other.errors);
    }
}

/// Owns a thread-local `Acc` and the channel back to the collector. On drop —
/// including during unwinding — it sends whatever it accumulated, so a partial
/// scan is never silently lost. `send` on a live channel cannot panic, so this
/// drop is safe to run while another panic unwinds (no double-panic / abort).
struct Outbox {
    acc: Acc,
    tx: mpsc::Sender<Acc>,
}

impl Drop for Outbox {
    fn drop(&mut self) {
        let _ = self.tx.send(std::mem::take(&mut self.acc));
    }
}

/// Walk one root into a key→Meta map. Hashes are only computed when `hash_files`
/// (verify-by-hash mode); otherwise change detection is metadata-based. `scanned`
/// is bumped once per recorded entry so a caller on another thread can poll live
/// scan progress (e.g. to emit a progress event). When `tree` is `Some`, each
/// recorded entry is also tallied into its shallow folder bucket for the live
/// folder-activity view. `threads` is the requested walker-thread count per root
/// (`0` => the conservative auto default).
pub fn scan_root_counted(
    root: &Path,
    policy: &IgnorePolicy,
    hash_files: bool,
    scanned: &AtomicU64,
    threads: usize,
    tree: Option<&ScanTree>,
) -> Result<ScanResult> {
    if !root.is_dir() {
        return Err(SyncError::InvalidJob(format!(
            "root is not a directory: {}",
            root.display()
        )));
    }

    let effective_threads = resolve_scan_threads(threads);
    let span = tracing::info_span!(
        "scan_root",
        root = %root.display(),
        threads = effective_threads,
        verify = hash_files
    );
    let _enter = span.enter();
    let started = Instant::now();

    let custom_for_filter = build_custom_matcher(root, &policy.custom_globs)?;

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(!policy.include_hidden)
        .ignore(policy.use_dot_ignore)
        .git_ignore(policy.use_gitignore)
        .git_exclude(policy.use_gitignore)
        .git_global(false) // machine-specific ~/.gitignore would break symmetry
        .parents(false) // do not read ignore files above the root
        .require_git(false) // honor .gitignore even when the folder isn't a git repo
        .follow_links(false)
        .threads(effective_threads);

    // Apply the user's custom exclude/include globs with proper gitignore
    // semantics (a leading `!` re-includes). Pruning a directory stops descent.
    builder.filter_entry(move |dent| {
        let is_dir = dent.file_type().map(|t| t.is_dir()).unwrap_or(false);
        !custom_for_filter.matched(dent.path(), is_dir).is_ignore()
    });

    // Walk across a thread pool (the `ignore` crate manages the threads). This is
    // the speed lever over a network share: directory reads and per-entry stats
    // (and hashing in verify mode) overlap instead of serializing one round-trip
    // at a time. Each worker records into its OWN `Acc`; results are merged after.
    let (tx, rx) = mpsc::channel::<Acc>();
    let walk = builder.build_parallel();

    // `ignore` joins its worker threads with `handle.join().unwrap()`, so a panic
    // in any visitor re-raises HERE. Catch it so a scan crash becomes a clean,
    // logged error (slot released, UI recovers) instead of an opaque cascade that
    // unwinds through spawn_blocking. The channel/`Acc` are discarded on a panic;
    // we never build a plan from a half-finished scan.
    let tx_for_walk = tx.clone();
    let walk_panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        walk.run(|| {
            let mut out = Outbox {
                acc: Acc::default(),
                tx: tx_for_walk.clone(),
            };
            Box::new(move |result| {
                let dent = match result {
                    Ok(d) => d,
                    Err(e) => {
                        // Could not enumerate a (sub)tree. The mere presence of an
                        // error means part of the tree is unknown, so deletions get
                        // suppressed for the whole run regardless of which path failed.
                        out.acc
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
                        out.acc.errors.push((key, format!("stat failed: {e}")));
                        return WalkState::Continue;
                    }
                };

                if let Some(reason) = unsafe_to_sync(&md, dent.file_type()) {
                    out.acc.skipped.push((key, reason.to_string()));
                    return WalkState::Continue;
                }

                let kind = if md.is_dir() {
                    EntryKind::Dir
                } else if md.is_file() {
                    EntryKind::File
                } else {
                    out.acc
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
                        Err(e) => out
                            .acc
                            .skipped
                            .push((key.clone(), format!("hash unavailable: {e}"))),
                    }
                }

                // Tally into the live folder tree BEFORE `key` is moved into the
                // entry map; symmetric with the `scanned` counter below.
                if let Some(t) = tree {
                    t.record(&key, kind == EntryKind::Dir);
                }
                out.acc.entries.insert(
                    key,
                    Meta {
                        kind,
                        size: if kind == EntryKind::File { md.len() } else { 0 },
                        mtime_ns: mtime_ns(&md),
                        hash,
                    },
                );
                scanned.fetch_add(1, Ordering::Relaxed);
                WalkState::Continue
            })
        });
    }))
    .is_err();

    // Drop the original sender so the receiver iteration below terminates once
    // every per-thread `Outbox` (each holding a clone) has been dropped.
    drop(tx);

    if walk_panic {
        let elapsed = started.elapsed();
        tracing::error!(
            root = %root.display(),
            elapsed_ms = elapsed.as_millis(),
            "scan worker panicked; treating the scan as failed"
        );
        return Err(SyncError::Other(format!(
            "directory scan crashed while walking {} (a worker thread panicked)",
            root.display()
        )));
    }

    let mut acc = Acc::default();
    for partial in rx {
        acc.absorb(partial);
    }

    let elapsed = started.elapsed();
    tracing::info!(
        root = %root.display(),
        entries = acc.entries.len(),
        errors = acc.errors.len(),
        skipped = acc.skipped.len(),
        threads = effective_threads,
        elapsed_ms = elapsed.as_millis(),
        "scan_root done"
    );

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

        let res = scan_root_counted(
            root,
            &IgnorePolicy::default(),
            false,
            &AtomicU64::new(0),
            0,
            None,
        )
        .unwrap();
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

        let policy = IgnorePolicy {
            custom_globs: vec!["*.log".into(), "!b.log".into()],
            ..Default::default()
        };
        let res = scan_root_counted(root, &policy, false, &AtomicU64::new(0), 0, None).unwrap();
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

    #[test]
    fn counter_matches_recorded_entry_count() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "1").unwrap();
        fs::write(root.join("b.txt"), "2").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("c.txt"), "3").unwrap();

        let scanned = AtomicU64::new(0);
        let res =
            scan_root_counted(root, &IgnorePolicy::default(), false, &scanned, 0, None).unwrap();
        // Every recorded entry (files + the dir) bumps the counter exactly once.
        assert_eq!(scanned.load(Ordering::Relaxed) as usize, res.entries.len());
        assert!(res.entries.len() >= 4);
    }

    fn snap_map(tree: &ScanTree) -> HashMap<String, u64> {
        tree.snapshot(64).into_iter().collect()
    }

    #[test]
    fn scan_tree_buckets_by_top_level_folder() {
        let tree = ScanTree::new(1);
        tree.record("Photos/a.jpg", false); // file -> parent "Photos"
        tree.record("Photos/2026/b.jpg", false); // deeper file -> still "Photos"
        tree.record("Photos", true); // the dir entry itself -> "Photos"
        tree.record("readme.txt", false); // root-level file -> ""
        let map = snap_map(&tree);
        assert_eq!(map.get("Photos").copied(), Some(3));
        assert_eq!(map.get("").copied(), Some(1));
    }

    #[test]
    fn scan_tree_depth_two_keys_two_segments() {
        let tree = ScanTree::new(2);
        tree.record("a/b/c.txt", false); // parent a/b -> "a/b"
        tree.record("a/x.txt", false); // parent a (one segment) -> "a"
        tree.record("a/b", true); // dir a/b -> "a/b"
        let map = snap_map(&tree);
        assert_eq!(map.get("a/b").copied(), Some(2));
        assert_eq!(map.get("a").copied(), Some(1));
    }

    #[test]
    fn scan_root_populates_tree_when_provided() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("c.txt"), "3").unwrap();
        fs::write(root.join("top.txt"), "1").unwrap();

        let tree = ScanTree::new(1);
        let scanned = AtomicU64::new(0);
        scan_root_counted(
            root,
            &IgnorePolicy::default(),
            false,
            &scanned,
            0,
            Some(&tree),
        )
        .unwrap();
        let map = snap_map(&tree);
        // "sub" dir + "sub/c.txt" => 2 under "sub"; "top.txt" => 1 under root "".
        assert_eq!(map.get("sub").copied(), Some(2));
        assert_eq!(map.get("").copied(), Some(1));
        // Tree total equals the scanned counter (same recorded-entry set).
        let total: u64 = map.values().sum();
        assert_eq!(total, scanned.load(Ordering::Relaxed));
    }

    #[test]
    fn resolve_threads_auto_and_explicit() {
        // 0 => conservative auto default, inside the clamp band.
        let auto = resolve_scan_threads(0);
        assert!(
            (4..=16).contains(&auto),
            "auto thread count in band: {auto}"
        );
        // An explicit value is honored…
        assert_eq!(resolve_scan_threads(3), 3);
        assert_eq!(resolve_scan_threads(32), 32);
        // …but clamped to the sane maximum so a runaway override can't exhaust
        // handles.
        assert_eq!(resolve_scan_threads(100_000), MAX_SCAN_THREADS);
    }

    #[test]
    fn result_is_independent_of_thread_count() {
        // The per-thread accumulator merge must produce the SAME entry set
        // regardless of how many walker threads are used (no lost/duplicated rows
        // under concurrency). Build a wide+deep tree so multiple threads engage.
        let dir = tempdir().unwrap();
        let root = dir.path();
        for d in 0..12 {
            let sub = root.join(format!("dir{d:02}"));
            fs::create_dir(&sub).unwrap();
            for f in 0..30 {
                fs::write(sub.join(format!("f{f:02}.txt")), format!("{d}-{f}")).unwrap();
            }
        }

        let single = scan_root_counted(
            root,
            &IgnorePolicy::default(),
            false,
            &AtomicU64::new(0),
            1,
            None,
        )
        .unwrap();
        let many = scan_root_counted(
            root,
            &IgnorePolicy::default(),
            false,
            &AtomicU64::new(0),
            16,
            None,
        )
        .unwrap();

        let keys_single: Vec<_> = single.entries.keys().cloned().collect();
        let keys_many: Vec<_> = many.entries.keys().cloned().collect();
        assert_eq!(keys_single, keys_many, "same entries regardless of threads");
        // 12 dirs + 12*30 files = 372 recorded entries.
        assert_eq!(single.entries.len(), 12 + 12 * 30);
        assert!(single.errors.is_empty() && many.errors.is_empty());
    }
}
