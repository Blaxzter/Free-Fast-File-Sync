//! The persisted prior-sync state — the single fact that makes two-way sync safe
//! (it lets us tell "deleted here" from "newly created there"). Stored per job,
//! versioned and checksummed, written atomically (temp + fsync + rename). A
//! missing or corrupt baseline is reported explicitly so the caller falls back
//! to safe first-sync union mode and NEVER misreads it as "everything deleted".

use crate::error::{Result, SyncError};
use crate::model::Meta;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

const BASELINE_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Baseline {
    pub entries: BTreeMap<String, Meta>,
}

#[derive(Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    /// blake3 over the canonical JSON of `entries`; guards against truncation.
    checksum: String,
    entries: BTreeMap<String, Meta>,
}

/// The outcome of trying to load a baseline. The caller MUST treat `Missing` and
/// `Corrupt` as "no trustworthy prior state" → first-sync union, zero deletions.
pub enum LoadOutcome {
    Loaded(Baseline),
    Missing,
    Corrupt,
}

impl Baseline {
    pub fn get(&self, key: &str) -> Option<&Meta> {
        self.entries.get(key)
    }

    /// Update one path after a successfully-applied item. `None` removes it.
    /// Only ever called for items that genuinely succeeded.
    pub fn update_entry(&mut self, key: &str, meta: Option<Meta>) {
        match meta {
            Some(m) => {
                self.entries.insert(key.to_string(), m);
            }
            None => {
                self.entries.remove(key);
            }
        }
    }

    pub fn load(path: &Path) -> LoadOutcome {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LoadOutcome::Missing,
            Err(_) => return LoadOutcome::Corrupt,
        };
        let disk: OnDisk = match serde_json::from_slice(&bytes) {
            Ok(d) => d,
            Err(_) => return LoadOutcome::Corrupt,
        };
        if disk.version != BASELINE_VERSION {
            return LoadOutcome::Corrupt;
        }
        if checksum(&disk.entries) != disk.checksum {
            return LoadOutcome::Corrupt;
        }
        LoadOutcome::Loaded(Baseline {
            entries: disk.entries,
        })
    }

    /// Atomically persist: temp file in the same dir, fsync, then rename over the
    /// target so a crash can never leave a half-written baseline.
    pub fn save_atomic(&self, path: &Path) -> Result<()> {
        let dir = path
            .parent()
            .ok_or_else(|| SyncError::Other("baseline path has no parent".into()))?;
        std::fs::create_dir_all(dir).map_err(|e| SyncError::from_io(dir, &e))?;

        let disk = OnDisk {
            version: BASELINE_VERSION,
            checksum: checksum(&self.entries),
            entries: self.entries.clone(),
        };
        let bytes = serde_json::to_vec(&disk)
            .map_err(|e| SyncError::Other(format!("serialize baseline: {e}")))?;

        let tmp = dir.join(format!(".ffs-tmp-baseline-{}", std::process::id()));
        {
            let mut f = std::fs::File::create(&tmp).map_err(|e| SyncError::from_io(&tmp, &e))?;
            f.write_all(&bytes)
                .map_err(|e| SyncError::from_io(&tmp, &e))?;
            f.sync_all().map_err(|e| SyncError::from_io(&tmp, &e))?;
        }
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            SyncError::from_io(path, &e)
        })?;
        Ok(())
    }
}

fn checksum(entries: &BTreeMap<String, Meta>) -> String {
    // BTreeMap iterates in key order, so the JSON is canonical.
    let json = serde_json::to_vec(entries).unwrap_or_default();
    blake3::hash(&json).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::EntryKind;
    use tempfile::tempdir;

    fn meta() -> Meta {
        Meta {
            kind: EntryKind::File,
            size: 3,
            mtime_ns: 123,
            hash: Some("ab".into()),
        }
    }

    #[test]
    fn round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("baseline.json");
        let mut b = Baseline::default();
        b.update_entry("a/b.txt", Some(meta()));
        b.save_atomic(&path).unwrap();

        match Baseline::load(&path) {
            LoadOutcome::Loaded(loaded) => {
                assert_eq!(loaded.get("a/b.txt"), Some(&meta()));
            }
            _ => panic!("expected loaded"),
        }
    }

    #[test]
    fn missing_is_distinct_from_corrupt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nope.json");
        assert!(matches!(Baseline::load(&path), LoadOutcome::Missing));
    }

    #[test]
    fn truncated_file_is_corrupt_not_empty() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("baseline.json");
        std::fs::write(&path, b"{\"version\":1,\"checksum\":\"x\",\"entries\":{").unwrap();
        assert!(matches!(Baseline::load(&path), LoadOutcome::Corrupt));
    }

    #[test]
    fn tampered_checksum_is_corrupt() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("baseline.json");
        std::fs::write(
            &path,
            b"{\"version\":1,\"checksum\":\"deadbeef\",\"entries\":{}}",
        )
        .unwrap();
        assert!(matches!(Baseline::load(&path), LoadOutcome::Corrupt));
    }

    #[test]
    fn update_entry_none_removes() {
        let mut b = Baseline::default();
        b.update_entry("x", Some(meta()));
        assert!(b.get("x").is_some());
        b.update_entry("x", None);
        assert!(b.get("x").is_none());
    }
}
