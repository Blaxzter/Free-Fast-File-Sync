//! Persists Job aggregates one-file-per-job, atomically (temp + fsync + rename,
//! the same discipline as baseline.rs), versioned + checksummed so a truncated
//! file is reported, never silently half-read. Layout (locked):
//!
//!   <jobs_dir>/<jobId>/job.json
//!   <jobs_dir>/<jobId>/pairs/<pairId>/baseline.json
//!
//! A job and its pair baselines live and delete together: deleting a job removes
//! the whole `<jobId>/` dir, leaving no orphan baselines.

use crate::error::{Result, SyncError};
use crate::job::{validate_job_aggregate, Job};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

const JOB_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    /// blake3 over the canonical JSON of `job`; guards against truncation.
    checksum: String,
    job: Job,
}

pub struct Store {
    /// The existing per-app "jobs" dir (never inside a synced root).
    jobs_dir: PathBuf,
}

impl Store {
    pub fn new(jobs_dir: PathBuf) -> Self {
        Store { jobs_dir }
    }

    pub fn job_dir(&self, job_id: &str) -> PathBuf {
        self.jobs_dir.join(job_id)
    }

    fn job_file(&self, job_id: &str) -> PathBuf {
        self.job_dir(job_id).join("job.json")
    }

    /// Canonical per-(job, pair) baseline path. Keyed by stable ULIDs so editing a
    /// pair's roots never orphans its baseline.
    pub fn pair_baseline_path(&self, job_id: &str, pair_id: &str) -> PathBuf {
        self.job_dir(job_id)
            .join("pairs")
            .join(pair_id)
            .join("baseline.json")
    }

    /// Scan `<jobs_dir>/*/job.json`. A single corrupt/unreadable job is SKIPPED,
    /// never aborts the whole list (one bad file must not hide all jobs). A missing
    /// jobs dir lists empty, not an error.
    pub fn list(&self) -> Vec<Job> {
        let entries = match std::fs::read_dir(&self.jobs_dir) {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        let mut jobs = Vec::new();
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            match self.load(&id) {
                Ok(job) => jobs.push(job),
                Err(_) => {
                    // Skip a corrupt/unreadable job; do not abort the list.
                    continue;
                }
            }
        }
        jobs
    }

    pub fn load(&self, job_id: &str) -> Result<Job> {
        let path = self.job_file(job_id);
        let bytes = std::fs::read(&path).map_err(|e| SyncError::from_io(&path, &e))?;
        let disk: OnDisk = serde_json::from_slice(&bytes)
            .map_err(|e| SyncError::Other(format!("corrupt job file {}: {e}", path.display())))?;
        if disk.version != JOB_VERSION {
            return Err(SyncError::Other(format!(
                "unsupported job version {} at {}",
                disk.version,
                path.display()
            )));
        }
        if checksum(&disk.job) != disk.checksum {
            return Err(SyncError::Other(format!(
                "job checksum mismatch at {} (file is corrupt)",
                path.display()
            )));
        }
        Ok(disk.job)
    }

    /// Upsert. Validates the aggregate, mints ULIDs for any empty job/pair id,
    /// stamps `created_at`/`updated_at`, then atomically writes the canonical Job
    /// and returns it (so the frontend never invents ids).
    pub fn save(&self, job: &Job) -> Result<Job> {
        let mut job = job.clone();
        let now = now_rfc3339();

        if job.id.trim().is_empty() {
            job.id = ulid::Ulid::new().to_string();
            job.created_at = now.clone();
        } else if job.created_at.trim().is_empty() {
            job.created_at = now.clone();
        }
        job.updated_at = now;

        for p in &mut job.pairs {
            if p.id.trim().is_empty() {
                p.id = ulid::Ulid::new().to_string();
            }
        }

        // Validate AFTER minting ids so a freshly-minted set passes uniqueness.
        validate_job_aggregate(&job)?;

        let path = self.job_file(&job.id);
        let disk = OnDisk {
            version: JOB_VERSION,
            checksum: checksum(&job),
            job: job.clone(),
        };
        let bytes = serde_json::to_vec(&disk)
            .map_err(|e| SyncError::Other(format!("serialize job: {e}")))?;
        write_atomic(&path, &bytes)?;
        Ok(job)
    }

    /// Remove the whole job dir (job.json + all pairs/<id>/baseline.json) so a
    /// deleted job leaves no orphan baselines. Deleting a missing job is a no-op.
    pub fn delete(&self, job_id: &str) -> Result<()> {
        let dir = self.job_dir(job_id);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(SyncError::from_io(&dir, &e)),
        }
    }
}

fn checksum(job: &Job) -> String {
    let json = serde_json::to_vec(job).unwrap_or_default();
    blake3::hash(&json).to_hex().to_string()
}

fn now_rfc3339() -> String {
    // RFC3339 UTC without an external chrono dependency.
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (h, m, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Howard Hinnant's days-from-civil, inverted: civil date from days since epoch.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Atomic write: temp file in the same dir, fsync, then rename over the target.
/// Identical discipline to `Baseline::save_atomic`.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| SyncError::Other("job path has no parent".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| SyncError::from_io(dir, &e))?;

    let tmp = dir.join(format!(".ffs-tmp-job-{}", std::process::id()));
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
    use crate::job::{EndpointPath, FolderPair, Job, JobSettings};
    use tempfile::tempdir;

    fn pair(id: &str) -> FolderPair {
        FolderPair {
            id: id.into(),
            label: String::new(),
            root_a: EndpointPath::Local { path: "/a".into() },
            root_b: EndpointPath::Local { path: "/b".into() },
            enabled: true,
            filter_override: None,
            mode_override: None,
            deletion_override: None,
            big_delete_override: None,
        }
    }

    fn job(id: &str, pairs: Vec<FolderPair>) -> Job {
        Job {
            id: id.into(),
            name: "demo".into(),
            color: None,
            created_at: String::new(),
            updated_at: String::new(),
            settings: JobSettings::default(),
            pairs,
        }
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let saved = store
            .save(&job(
                "01JOBSAVE000000000000000001",
                vec![pair("01PAIRA0000000000000000001")],
            ))
            .unwrap();
        let loaded = store.load(&saved.id).unwrap();
        assert_eq!(saved, loaded);
        assert!(!loaded.updated_at.is_empty());
    }

    #[test]
    fn save_mints_ulid_when_id_empty() {
        let dir = tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let mut j = job("", vec![pair("")]);
        j.created_at = String::new();
        let saved = store.save(&j).unwrap();
        assert!(!saved.id.is_empty(), "job id minted");
        assert!(!saved.pairs[0].id.is_empty(), "pair id minted");
        assert!(!saved.created_at.is_empty(), "created_at stamped");
        assert!(!saved.updated_at.is_empty(), "updated_at stamped");
        // And the minted id round-trips on disk.
        assert_eq!(store.load(&saved.id).unwrap(), saved);
    }

    #[test]
    fn jobs_json_atomic_write_leaves_no_temp() {
        let dir = tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let saved = store
            .save(&job(
                "01JOBTEMP000000000000000001",
                vec![pair("01PAIRA0000000000000000001")],
            ))
            .unwrap();
        let job_dir = store.job_dir(&saved.id);
        let leftovers: Vec<_> = std::fs::read_dir(&job_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".ffs-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "no temp file left behind");
        assert!(job_dir.join("job.json").exists());
    }

    #[test]
    fn missing_job_dir_lists_empty_not_error() {
        let dir = tempdir().unwrap();
        // Point at a non-existent subdir.
        let store = Store::new(dir.path().join("does-not-exist"));
        assert!(store.list().is_empty());
    }

    #[test]
    fn corrupt_job_json_is_skipped_in_list_and_load_errs_without_overwrite() {
        let dir = tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let good = store
            .save(&job(
                "01JOBGOOD000000000000000001",
                vec![pair("01PAIRA0000000000000000001")],
            ))
            .unwrap();

        // Plant a corrupt job dir.
        let bad_id = "01JOBBAD0000000000000000001";
        let bad_file = store.job_dir(bad_id).join("job.json");
        std::fs::create_dir_all(bad_file.parent().unwrap()).unwrap();
        std::fs::write(&bad_file, b"{\"version\":1,\"checksum\":\"x\",\"job\":{").unwrap();

        // list() skips the corrupt one but keeps the good one.
        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, good.id);

        // load() errors on the corrupt one and does NOT overwrite the file.
        let before = std::fs::read(&bad_file).unwrap();
        assert!(store.load(bad_id).is_err());
        let after = std::fs::read(&bad_file).unwrap();
        assert_eq!(before, after, "load must not touch a corrupt file");
    }

    #[test]
    fn delete_removes_job_dir_and_baselines() {
        let dir = tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());
        let saved = store
            .save(&job(
                "01JOBDEL0000000000000000001",
                vec![pair("01PAIRA0000000000000000001")],
            ))
            .unwrap();

        // Plant a pair baseline so we can confirm it's removed too.
        let bpath = store.pair_baseline_path(&saved.id, &saved.pairs[0].id);
        std::fs::create_dir_all(bpath.parent().unwrap()).unwrap();
        std::fs::write(&bpath, b"x").unwrap();
        assert!(bpath.exists());

        store.delete(&saved.id).unwrap();
        assert!(!store.job_dir(&saved.id).exists());
        assert!(!bpath.exists());

        // Deleting again is a no-op, not an error.
        assert!(store.delete(&saved.id).is_ok());
    }

    #[test]
    fn pair_baseline_path_is_stable_across_root_edit() {
        let dir = tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());

        let job_id = "01JOBSTABLE0000000000000001";
        let pair_id = "01PAIRSTABLE000000000000001";

        // Path is derived from the stable ULIDs, never from the roots, so editing
        // root_a / root_b must NOT move the baseline (an orphaned baseline silently
        // degrades to FirstSync and suppresses legitimate deletes).
        let before = store.pair_baseline_path(job_id, pair_id);

        let _edited_pair = FolderPair {
            root_a: EndpointPath::Local {
                path: "/totally/different/a".into(),
            },
            root_b: EndpointPath::Local {
                path: "/totally/different/b".into(),
            },
            ..pair(pair_id)
        };
        let after = store.pair_baseline_path(job_id, pair_id);

        assert_eq!(before, after, "same job+pair id => same baseline path");
        assert!(before.ends_with(
            std::path::Path::new(job_id)
                .join("pairs")
                .join(pair_id)
                .join("baseline.json")
        ));
    }

    #[test]
    fn two_pairs_have_distinct_baseline_paths() {
        let dir = tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf());

        let job_id = "01JOBTWO00000000000000000001";
        let pair_a = "01PAIRAAA0000000000000000001";
        let pair_b = "01PAIRBBB0000000000000000001";

        let pa = store.pair_baseline_path(job_id, pair_a);
        let pb = store.pair_baseline_path(job_id, pair_b);

        assert_ne!(pa, pb, "distinct pairs => distinct baseline files");
        // ULID dirs, not a root hash: the pair id appears verbatim in the path.
        assert!(pa.to_string_lossy().contains(pair_a));
        assert!(pb.to_string_lossy().contains(pair_b));
        // Both live under the same job dir.
        assert_eq!(
            pa.parent().unwrap().parent().unwrap(),
            store.job_dir(job_id).join("pairs")
        );
        assert_eq!(
            pb.parent().unwrap().parent().unwrap(),
            store.job_dir(job_id).join("pairs")
        );
    }
}
