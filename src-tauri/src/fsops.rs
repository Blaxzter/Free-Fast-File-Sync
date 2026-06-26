//! All real filesystem mutations, each individually crash-atomic. Files are
//! written to a temp file in the SAME directory, fsync'd, then atomically
//! renamed over the target — a crash leaves the destination either fully old or
//! fully new, never truncated. Deletes route to the OS recycle bin (recoverable)
//! and directories are only ever removed when genuinely empty, so ignored/hidden
//! children are never destroyed.

use crate::error::{Result, SyncError};
use crate::model::{EntryKind, Meta};
use crate::pathutil::extended;
use crate::reconcile::mtime_close;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Current on-disk metadata (does not follow symlinks). `None` if absent.
pub fn current_meta(path: &Path) -> Option<Meta> {
    let md = std::fs::symlink_metadata(extended(path)).ok()?;
    let kind = if md.is_dir() {
        EntryKind::Dir
    } else if md.is_file() {
        EntryKind::File
    } else if md.file_type().is_symlink() {
        EntryKind::Symlink
    } else {
        EntryKind::Other
    };
    let mtime_ns = match md.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_nanos().min(i64::MAX as u128) as i64,
            Err(e) => -(e.duration().as_nanos().min(i64::MAX as u128) as i64),
        },
        Err(_) => 0,
    };
    Some(Meta {
        kind,
        size: if kind == EntryKind::File { md.len() } else { 0 },
        mtime_ns,
        hash: None,
    })
}

/// TOCTOU guard: does the live state still match what the plan assumed?
/// Directories ignore size/mtime (only kind matters).
pub fn meta_matches(cur: Option<&Meta>, expected: Option<&Meta>, gran_ns: i64) -> bool {
    match (cur, expected) {
        (None, None) => true,
        (Some(c), Some(e)) => {
            c.kind == e.kind
                && (e.is_dir()
                    || (c.size == e.size && mtime_close(c.mtime_ns, e.mtime_ns, gran_ns)))
        }
        _ => false,
    }
}

/// Copy `src` over `dst` atomically and return the byte count. Preserves the
/// source mtime so an unchanged file compares equal on the next run. The caller
/// is responsible for having TOCTOU-validated both endpoints first.
pub fn atomic_copy(src: &Path, dst: &Path) -> Result<u64> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(extended(parent)).map_err(|e| SyncError::from_io(parent, &e))?;
    }
    let src_md = std::fs::metadata(extended(src)).map_err(|e| SyncError::from_io(src, &e))?;
    let expected = src_md.len();

    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dst.with_file_name(format!(".ffs-tmp-{}-{}", std::process::id(), n));

    let copied = (|| -> std::io::Result<u64> {
        let mut reader = std::fs::File::open(extended(src))?;
        let mut writer = std::fs::File::create(extended(&tmp))?;
        let copied = std::io::copy(&mut reader, &mut writer)?;
        // Preserve mtime, then flush data+metadata durably before the rename.
        if let Ok(mt) = src_md.modified() {
            let _ = writer.set_modified(mt);
        }
        writer.sync_all()?;
        Ok(copied)
    })()
    .map_err(|e| {
        let _ = std::fs::remove_file(extended(&tmp));
        SyncError::from_io(src, &e)
    })?;

    if copied != expected {
        let _ = std::fs::remove_file(extended(&tmp));
        return Err(SyncError::Io {
            path: src.display().to_string(),
            msg: format!("source changed during copy (expected {expected} bytes, read {copied})"),
        });
    }

    std::fs::rename(extended(&tmp), extended(dst)).map_err(|e| {
        let _ = std::fs::remove_file(extended(&tmp));
        SyncError::from_io(dst, &e)
    })?;
    Ok(expected)
}

pub fn ensure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(extended(path)).map_err(|e| SyncError::from_io(path, &e))
}

/// Delete a file, preferring the recycle bin. Never silently hard-deletes when
/// recycling was requested but failed (e.g. network drive) — surfaces the error
/// so the item is marked failed and its baseline entry is preserved.
pub fn recycle_file(path: &Path, use_recycle: bool) -> Result<()> {
    if use_recycle {
        return trash::delete(path).map_err(|e| {
            SyncError::Other(format!(
                "could not move {} to recycle bin: {e}",
                path.display()
            ))
        });
    }
    std::fs::remove_file(extended(path)).map_err(|e| SyncError::from_io(path, &e))
}

/// Remove a directory ONLY if it is truly empty on disk (no hidden/ignored
/// children) — never recursively force-delete real user data we filtered out.
pub fn remove_dir_if_empty(path: &Path, use_recycle: bool) -> Result<()> {
    let mut rd = match std::fs::read_dir(extended(path)) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(SyncError::from_io(path, &e)),
    };
    if rd.next().is_some() {
        return Err(SyncError::Unsupported {
            path: path.display().to_string(),
            reason: "directory still has (possibly ignored/hidden) children; not deleted".into(),
        });
    }
    if use_recycle {
        if let Ok(()) = trash::delete(path) {
            return Ok(());
        }
        // Empty dir: a plain rmdir is itself safe even if recycling failed.
    }
    std::fs::remove_dir(extended(path)).map_err(|e| SyncError::from_io(path, &e))
}

/// Best-effort cleanup of leftover temp files from a previously crashed copy in
/// a given directory (non-recursive).
pub fn gc_orphan_temps(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(extended(dir)) {
        for entry in rd.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".ffs-tmp-") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn atomic_copy_creates_parent_and_preserves_bytes() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src.bin");
        let dst = dir.path().join("nested/deep/dst.bin");
        fs::write(&src, b"some content here").unwrap();

        let n = atomic_copy(&src, &dst).unwrap();
        assert_eq!(n, 17);
        assert_eq!(fs::read(&dst).unwrap(), b"some content here");
        // No temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(dst.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".ffs-tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn atomic_copy_overwrites_existing() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        fs::write(&src, b"new").unwrap();
        fs::write(&dst, b"old-and-longer").unwrap();
        atomic_copy(&src, &dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"new");
    }

    #[test]
    fn remove_dir_if_empty_refuses_nonempty() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("child"), b"x").unwrap();
        assert!(remove_dir_if_empty(&sub, false).is_err());
        assert!(sub.exists());

        fs::remove_file(sub.join("child")).unwrap();
        assert!(remove_dir_if_empty(&sub, false).is_ok());
        assert!(!sub.exists());
    }

    #[test]
    fn meta_matches_detects_drift() {
        let a = Meta {
            kind: EntryKind::File,
            size: 10,
            mtime_ns: 100,
            hash: None,
        };
        let b = Meta {
            kind: EntryKind::File,
            size: 10,
            mtime_ns: 100,
            hash: None,
        };
        let c = Meta {
            kind: EntryKind::File,
            size: 11,
            mtime_ns: 100,
            hash: None,
        };
        assert!(meta_matches(Some(&a), Some(&b), 0));
        assert!(!meta_matches(Some(&a), Some(&c), 0));
        assert!(!meta_matches(None, Some(&a), 0));
    }
}
