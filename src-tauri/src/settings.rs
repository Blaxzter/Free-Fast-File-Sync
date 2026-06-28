//! Global application Settings — user-facing defaults that are NOT per-job.
//! Persisted as a single `settings.json` under the app data dir (atomic
//! temp + fsync + rename, the same discipline as the job store and baselines).
//! Every field has a serde default so an older or partial file still loads.
//!
//! These are the surfaced knobs behind the project rule "every configurable
//! belongs to the user, not a hardcoded constant": the scan walker thread count,
//! the mtime comparison granularity, the live scan-progress ticker interval, and
//! the diagnostic log level. A per-job override (where it makes sense) wins over
//! these; these win over the built-in engine defaults.

use crate::error::{Result, SyncError};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// Default scan walker threads per root. `0` => auto (a conservative,
    /// CPU-sized default; see `scan::resolve_scan_threads`). A per-job value
    /// overrides this.
    #[serde(default)]
    pub scan_threads: usize,
    /// Default mtime comparison tolerance, in MILLISECONDS. `0` => the engine
    /// default (`engine::DEFAULT_GRAN_NS`, 10ms). A per-job value overrides this.
    #[serde(default)]
    pub mtime_gran_ms: u64,
    /// Live scan-progress ticker interval, in milliseconds (how often the scanning
    /// UI updates its item count). Clamped to a sane band at use.
    #[serde(default = "default_ticker_ms")]
    pub scan_ticker_ms: u64,
    /// Live scan folder-tree depth: how many leading path segments to group live
    /// scan activity by. `1` => top-level folders (default); higher nests deeper;
    /// `0` => the live folder tree is off. Clamped to a sane max at use.
    #[serde(default = "default_scan_tree_depth")]
    pub scan_tree_depth: usize,
    /// `tracing` filter directive for the diagnostic log (`"info"`, `"debug"`,
    /// `"fast_file_sync_lib=debug"`, …). Applied at startup; `RUST_LOG` overrides.
    #[serde(default = "default_log_level")]
    pub log_level: String,
}

fn default_ticker_ms() -> u64 {
    120
}
fn default_scan_tree_depth() -> usize {
    1
}
fn default_log_level() -> String {
    "info".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            scan_threads: 0,
            mtime_gran_ms: 0,
            scan_ticker_ms: default_ticker_ms(),
            scan_tree_depth: default_scan_tree_depth(),
            log_level: default_log_level(),
        }
    }
}

impl Settings {
    /// Ticker interval clamped to a sane band: fast enough to feel live, slow
    /// enough not to flood the event channel. Guards against a hostile/zero value.
    pub fn ticker_ms(&self) -> u64 {
        self.scan_ticker_ms.clamp(30, 2000)
    }

    /// The mtime granularity as nanoseconds (`0` => use the engine default).
    pub fn mtime_gran_ns(&self) -> i64 {
        (self.mtime_gran_ms as i64).saturating_mul(1_000_000)
    }

    /// Live scan folder-tree depth, clamped to a sane maximum. `0` keeps the live
    /// folder tree OFF; a deeper value is bounded so a hostile setting can't blow
    /// up the per-folder map cardinality.
    pub fn tree_depth(&self) -> usize {
        self.scan_tree_depth.min(8)
    }
}

pub fn settings_path(app_dir: &Path) -> PathBuf {
    app_dir.join("settings.json")
}

/// Load settings, or defaults when the file is missing OR unreadable/corrupt.
/// Settings are non-critical: a bad file must never block the app, so a parse
/// error is logged and the defaults are returned (the caller can re-save to heal).
pub fn load(app_dir: &Path) -> Settings {
    let path = settings_path(app_dir);
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %path.display(),
                    "settings.json is corrupt; falling back to defaults"
                );
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}

/// Persist settings atomically (temp file + fsync + rename over the target).
pub fn save(app_dir: &Path, settings: &Settings) -> Result<Settings> {
    let path = settings_path(app_dir);
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|e| SyncError::Other(format!("serialize settings: {e}")))?;
    write_atomic(&path, &bytes)?;
    Ok(settings.clone())
}

/// Atomic write: temp file in the same dir, fsync, then rename over the target.
/// Mirrors `store::write_atomic` / `Baseline::save_atomic`.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| SyncError::Other("settings path has no parent".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| SyncError::from_io(dir, &e))?;

    let tmp = dir.join(format!(".ffs-tmp-settings-{}", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| SyncError::from_io(&tmp, &e))?;
        f.write_all(bytes)
            .map_err(|e| SyncError::from_io(&tmp, &e))?;
        f.sync_all().map_err(|e| SyncError::from_io(&tmp, &e))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        SyncError::from_io(path, &e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_file_loads_defaults() {
        let dir = tempdir().unwrap();
        let s = load(dir.path());
        assert_eq!(s, Settings::default());
        assert_eq!(s.scan_threads, 0);
        assert_eq!(s.scan_ticker_ms, 120);
        assert_eq!(s.scan_tree_depth, 1);
        assert_eq!(s.log_level, "info");
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir().unwrap();
        let s = Settings {
            scan_threads: 8,
            mtime_gran_ms: 2000,
            scan_ticker_ms: 250,
            scan_tree_depth: 2,
            log_level: "debug".into(),
        };
        let saved = save(dir.path(), &s).unwrap();
        assert_eq!(saved, s);
        assert_eq!(load(dir.path()), s);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults_without_erroring() {
        let dir = tempdir().unwrap();
        std::fs::write(settings_path(dir.path()), b"{ not json").unwrap();
        // Load must not panic or error — settings are non-critical.
        assert_eq!(load(dir.path()), Settings::default());
    }

    #[test]
    fn partial_file_fills_missing_with_defaults() {
        let dir = tempdir().unwrap();
        std::fs::write(settings_path(dir.path()), br#"{"scan_threads":4}"#).unwrap();
        let s = load(dir.path());
        assert_eq!(s.scan_threads, 4);
        assert_eq!(
            s.scan_ticker_ms, 120,
            "missing field gets its serde default"
        );
        assert_eq!(s.log_level, "info");
    }

    fn with_ticker(ms: u64) -> Settings {
        Settings {
            scan_ticker_ms: ms,
            ..Default::default()
        }
    }

    #[test]
    fn ticker_is_clamped_to_band() {
        assert_eq!(with_ticker(0).ticker_ms(), 30);
        assert_eq!(with_ticker(100_000).ticker_ms(), 2000);
        assert_eq!(with_ticker(250).ticker_ms(), 250);
    }

    #[test]
    fn tree_depth_is_clamped_and_zero_means_off() {
        let depth = |d: usize| {
            Settings {
                scan_tree_depth: d,
                ..Default::default()
            }
            .tree_depth()
        };
        assert_eq!(depth(0), 0, "0 keeps the live tree off");
        assert_eq!(depth(1), 1);
        assert_eq!(depth(100), 8, "clamped to the sane max");
    }

    #[test]
    fn gran_ms_converts_to_ns() {
        let s = Settings {
            mtime_gran_ms: 2000,
            ..Default::default()
        };
        assert_eq!(s.mtime_gran_ns(), 2_000_000_000);
        assert_eq!(Settings::default().mtime_gran_ns(), 0);
    }

    #[test]
    fn save_leaves_no_temp_file() {
        let dir = tempdir().unwrap();
        save(dir.path(), &Settings::default()).unwrap();
        let temps: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".ffs-tmp"))
            .collect();
        assert!(temps.is_empty(), "no temp file left behind");
        assert!(settings_path(dir.path()).exists());
    }
}
