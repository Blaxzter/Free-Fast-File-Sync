//! The persisted Job aggregate: one Job = ordered FolderPairs sharing job-level
//! settings, each pair able to override filter / direction / deletion / big-delete.
//! A Job is NEVER handed to the engine directly; `resolve_pair` derives today's
//! single-pair `JobConfig` (plus the carried SyncDirection + DeletionPolicy) per
//! enabled pair, so the engine and its 25-cell reconcile table stay single-pair
//! and untouched.
//!
//! Note on naming vs the engine: the *engine* SyncMode {TwoWay, Mirror, Update}
//! (model.rs, added in a later step) is the post-filter the reconcile Decision is
//! clamped against. The *persisted* direction is the 5-way [`SyncDirection`]
//! below; the 5-way -> {SyncMode, swap_roots} mapping happens only in the fan-out
//! helper of a sibling area. This area persists the user's choice and merges
//! per-pair overrides; it does not run reconcile.

use crate::config::{IgnorePolicy, JobConfig};
use crate::model::SyncMode;
use serde::{Deserialize, Serialize};

/// Compare strategy. `Content` maps onto today's `verify_by_hash`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum CompareMode {
    #[default]
    TimeAndSize,
    Content,
}

/// Persisted 5-way direction. POST-FILTER on the reconcile Decision (a sibling
/// area owns the actual filter + the 5-way -> {SyncMode, swap_roots} mapping);
/// persisted here so a pair can override the job default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum SyncDirection {
    #[default]
    TwoWay,
    MirrorAtoB,
    MirrorBtoA,
    UpdateAtoB,
    UpdateBtoA,
}

/// Where deleted/overwritten files go. `serde(tag = "kind")` => the TS
/// discriminated union `{ kind: "RecycleBin" } | { kind: "Permanent" }`.
/// Versioned is DESCOPED from Phase 1.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum DeletionPolicy {
    #[default]
    RecycleBin,
    Permanent,
}

/// Big-delete guard (Product Decision 1). The two-field struct matches the locked
/// TS verbatim and the existing engine `JobConfig` fields. `Off`/single-arm is
/// encoded by sentinel: disable the pct arm with `pct >= 1.0`, the abs arm with
/// `abs == usize::MAX`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BigDeleteGuard {
    /// Fraction-of-members threshold (today's `big_delete_pct`).
    #[serde(default = "default_big_delete_pct")]
    pub pct: f32,
    /// Absolute-count threshold (today's `big_delete_abs`).
    #[serde(default = "default_big_delete_abs")]
    pub abs: usize,
}
fn default_big_delete_pct() -> f32 {
    0.25
}
fn default_big_delete_abs() -> usize {
    100
}
impl Default for BigDeleteGuard {
    fn default() -> Self {
        BigDeleteGuard {
            pct: 0.25,
            abs: 100,
        }
    }
}

/// Job-level defaults; every pair inherits these unless it overrides.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct JobSettings {
    #[serde(default)]
    pub compare_mode: CompareMode,
    #[serde(default)]
    pub direction: SyncDirection,
    #[serde(default)]
    pub deletion: DeletionPolicy,
    #[serde(default)]
    pub big_delete: BigDeleteGuard,
    #[serde(default)]
    pub filter: IgnorePolicy,
    /// Per-job override of the scan walker thread count. `None` => inherit the
    /// global Settings default (which itself may be auto). Surfaced so a job that
    /// targets a flaky NAS can pin a low value without changing the global.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scan_threads: Option<usize>,
    /// Per-job override of the mtime comparison tolerance, in MILLISECONDS. `None`
    /// => inherit the global default. Useful on coarse-granularity targets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_gran_ms: Option<u64>,
}

/// Local-today, remote-ready endpoint (P3). `serde(tag = "kind")`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum EndpointPath {
    Local { path: String },
    Remote { endpoint_id: String, path: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FolderPair {
    /// Stable ULID. Pair baseline lives at jobs/<job.id>/pairs/<id>/baseline.json.
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub root_a: EndpointPath,
    pub root_b: EndpointPath,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// None => inherit `job.settings.filter`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_override: Option<IgnorePolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_override: Option<SyncDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletion_override: Option<DeletionPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub big_delete_override: Option<BigDeleteGuard>,
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub id: String, // ULID
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub created_at: String, // RFC3339
    pub updated_at: String,
    #[serde(default)]
    pub settings: JobSettings,
    pub pairs: Vec<FolderPair>,
}

/// One pair, fully resolved to what the EXISTING engine consumes. `JobConfig` is
/// a derived view — never persisted. `direction`/`deletion` ride alongside for the
/// sibling post-filter; they do NOT enter reconcile().
#[derive(Debug, Clone)]
pub struct ResolvedPair {
    pub pair_id: String,
    pub config: JobConfig,
    /// The engine-axis post-filter mode (mirrors `config.mode`). The five-way
    /// `direction` (with its root-swap) has already been collapsed into
    /// `{config.mode, swapped roots}` by `resolve_pair`.
    pub mode: SyncMode,
    pub direction: SyncDirection,
    pub deletion: DeletionPolicy,
}

impl Job {
    /// Resolve every ENABLED pair to a `JobConfig`. The run pipeline loops these.
    pub fn fan_out(&self) -> Vec<ResolvedPair> {
        self.pairs
            .iter()
            .filter(|p| p.enabled)
            .filter_map(|p| self.resolve_pair(p))
            .collect()
    }

    /// Local pairs resolve to a `JobConfig`; Remote endpoints return None until P3
    /// (the run layer surfaces them as "remote — not yet supported").
    pub fn resolve_pair(&self, p: &FolderPair) -> Option<ResolvedPair> {
        let s = &self.settings;
        let root_a = local_path(&p.root_a)?;
        let root_b = local_path(&p.root_b)?;
        let direction = p.mode_override.unwrap_or(s.direction);
        let deletion = p
            .deletion_override
            .clone()
            .unwrap_or_else(|| s.deletion.clone());
        let guard = p.big_delete_override.unwrap_or(s.big_delete);
        let ignore = p
            .filter_override
            .clone()
            .unwrap_or_else(|| s.filter.clone());

        // Map the five-way frontend direction to the engine's two-way axis:
        // {SyncMode, swap_roots}. The engine only ever implements "A is source",
        // so a *BtoA direction is expressed by swapping which root is passed as
        // root_a (the safety-critical Rust never holds a direction boolean).
        let (mode, swap) = match direction {
            SyncDirection::TwoWay => (SyncMode::TwoWay, false),
            SyncDirection::MirrorAtoB => (SyncMode::Mirror, false),
            SyncDirection::MirrorBtoA => (SyncMode::Mirror, true),
            SyncDirection::UpdateAtoB => (SyncMode::Update, false),
            SyncDirection::UpdateBtoA => (SyncMode::Update, true),
        };
        let (root_a, root_b) = if swap {
            (root_b, root_a)
        } else {
            (root_a, root_b)
        };

        let config = JobConfig {
            root_a,
            root_b,
            mode,
            ignore,
            verify_by_hash: matches!(s.compare_mode, CompareMode::Content),
            big_delete_pct: guard.pct,
            big_delete_abs: guard.abs,
            use_recycle_bin: !matches!(deletion, DeletionPolicy::Permanent),
            // `0` here means "no per-job override"; the run layer substitutes the
            // global Settings default (which may itself be auto) before scanning.
            scan_threads: s.scan_threads.unwrap_or(0),
            mtime_gran_ns: s
                .mtime_gran_ms
                .map(|ms| (ms as i64).saturating_mul(1_000_000))
                .unwrap_or(0),
        };
        Some(ResolvedPair {
            pair_id: p.id.clone(),
            config,
            mode,
            direction,
            deletion,
        })
    }
}

fn local_path(e: &EndpointPath) -> Option<std::path::PathBuf> {
    match e {
        EndpointPath::Local { path } => Some(path.into()),
        EndpointPath::Remote { .. } => None,
    }
}

/// Structural, cross-pair validation that one `JobConfig` can't see. Does NOT touch
/// the filesystem — a job may be saved while a drive is offline; per-pair fs validity
/// is the engine's `validate_job` at preview/execute time.
pub fn validate_job_aggregate(job: &Job) -> crate::error::Result<()> {
    use crate::error::SyncError;
    if job.name.trim().is_empty() {
        return Err(SyncError::InvalidJob("job name is required".into()));
    }
    if job.pairs.is_empty() {
        return Err(SyncError::InvalidJob(
            "a job needs at least one folder pair".into(),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for p in &job.pairs {
        if !p.id.is_empty() && !seen.insert(p.id.as_str()) {
            return Err(SyncError::InvalidJob("duplicate folder-pair id".into()));
        }
    }
    Ok(())
}

/// Cross-pair structural validation `validate_job` (which sees one pair) cannot do:
/// no two LOCAL roots across the whole job may be identical or nested in one
/// another. Two pairs writing into overlapping trees would race each other's
/// baselines and propagate the same file twice. Roots are compared NFC- and
/// separator-normalized so `C:\Foo` and `c:/foo/` collide. Remote endpoints are
/// skipped (resolved-out at fan-out time).
///
/// This is a pure, no-fs check (a job may be saved while a drive is offline);
/// per-pair existence is still the engine's `validate_job` at run time.
pub fn validate_pair_set(job: &Job) -> crate::error::Result<()> {
    use crate::error::SyncError;

    // (normalized root, human label) for every local endpoint of every pair.
    let mut roots: Vec<(String, String)> = Vec::new();
    for p in &job.pairs {
        for e in [&p.root_a, &p.root_b] {
            if let EndpointPath::Local { path } = e {
                if path.trim().is_empty() {
                    continue;
                }
                roots.push((normalize_root(path), path.clone()));
            }
        }
    }

    for i in 0..roots.len() {
        for j in (i + 1)..roots.len() {
            let (a, a_disp) = (&roots[i].0, &roots[i].1);
            let (b, b_disp) = (&roots[j].0, &roots[j].1);
            if a == b {
                return Err(SyncError::InvalidJob(format!(
                    "two folder pairs use the same folder: {a_disp}"
                )));
            }
            if is_ancestor_of(a, b) || is_ancestor_of(b, a) {
                return Err(SyncError::InvalidJob(format!(
                    "one folder is nested inside another across pairs: {a_disp} / {b_disp}"
                )));
            }
        }
    }
    Ok(())
}

/// NFC-normalize, unify path separators to `/`, drop a trailing separator, and
/// (on Windows, where the fs is case-insensitive) case-fold so logically-equal
/// roots compare equal without touching the disk.
fn normalize_root(path: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nfc: String = path.nfc().collect();
    let unified = nfc.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    let s = if trimmed.is_empty() { "/" } else { trimmed };
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// True when `parent` is a path-component ancestor of `child` (or no relation).
/// Uses segment boundaries so `/a/foo` is NOT considered nested under `/a/f`.
fn is_ancestor_of(parent: &str, child: &str) -> bool {
    if parent == child {
        return true;
    }
    let mut p = parent.split('/').filter(|s| !s.is_empty());
    let mut c = child.split('/').filter(|s| !s.is_empty());
    loop {
        match (p.next(), c.next()) {
            (Some(pp), Some(cc)) if pp == cc => continue,
            (None, _) => return true, // parent exhausted => child extends it
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(p: &str) -> EndpointPath {
        EndpointPath::Local { path: p.into() }
    }

    fn pair(id: &str) -> FolderPair {
        FolderPair {
            id: id.into(),
            label: String::new(),
            root_a: local("/a"),
            root_b: local("/b"),
            enabled: true,
            filter_override: None,
            mode_override: None,
            deletion_override: None,
            big_delete_override: None,
        }
    }

    fn job_with(pairs: Vec<FolderPair>) -> Job {
        Job {
            id: "01JOBULID00000000000000000".into(),
            name: "demo".into(),
            color: Some("#abc".into()),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            settings: JobSettings::default(),
            pairs,
        }
    }

    #[test]
    fn job_round_trips() {
        let mut p1 = pair("01PAIR0000000000000000001A");
        p1.label = "docs".into();
        let mut p2 = pair("01PAIR0000000000000000002B");
        p2.label = "photos".into();
        p2.filter_override = Some(IgnorePolicy {
            include_hidden: true,
            ..Default::default()
        });
        p2.mode_override = Some(SyncDirection::MirrorAtoB);
        p2.deletion_override = Some(DeletionPolicy::Permanent);
        p2.big_delete_override = Some(BigDeleteGuard { pct: 0.5, abs: 7 });
        p2.enabled = false;

        let mut job = job_with(vec![p1, p2]);
        job.settings.compare_mode = CompareMode::Content;
        job.settings.direction = SyncDirection::UpdateBtoA;
        job.settings.deletion = DeletionPolicy::Permanent;

        let bytes = serde_json::to_vec(&job).unwrap();
        let back: Job = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(job, back);
    }

    #[test]
    fn pair_to_jobconfig_merges_overrides() {
        let mut job = job_with(vec![pair("01PAIR0000000000000000001A")]);
        // Job defaults: gitignore on (filter default), TwoWay, RecycleBin, TimeAndSize.
        job.settings.filter = IgnorePolicy {
            include_hidden: false,
            ..Default::default()
        };
        job.settings.deletion = DeletionPolicy::RecycleBin;

        // Pair overrides filter (include_hidden) and deletion (Permanent).
        let mut p = pair("01PAIR0000000000000000002B");
        p.filter_override = Some(IgnorePolicy {
            include_hidden: true,
            ..Default::default()
        });
        p.deletion_override = Some(DeletionPolicy::Permanent);
        job.pairs.push(p);

        // Pair 0 inherits everything.
        let r0 = job.resolve_pair(&job.pairs[0]).unwrap();
        assert!(!r0.config.ignore.include_hidden, "inherits job filter");
        assert!(
            r0.config.use_recycle_bin,
            "inherits RecycleBin => recoverable"
        );
        assert_eq!(r0.deletion, DeletionPolicy::RecycleBin);
        assert_eq!(r0.direction, SyncDirection::TwoWay);

        // Pair 1: filter_override wins, deletion Permanent => use_recycle_bin false.
        let r1 = job.resolve_pair(&job.pairs[1]).unwrap();
        assert!(r1.config.ignore.include_hidden, "filter_override wins");
        assert!(!r1.config.use_recycle_bin, "Permanent => not recoverable");
        assert_eq!(r1.deletion, DeletionPolicy::Permanent);
    }

    #[test]
    fn content_compare_sets_verify_by_hash() {
        let mut job = job_with(vec![pair("01PAIR0000000000000000001A")]);
        job.settings.compare_mode = CompareMode::Content;
        let r = job.resolve_pair(&job.pairs[0]).unwrap();
        assert!(r.config.verify_by_hash);
    }

    #[test]
    fn fan_out_skips_disabled_and_remote() {
        let mut p_disabled = pair("01PAIR0000000000000000003C");
        p_disabled.enabled = false;
        let mut p_remote = pair("01PAIR0000000000000000004D");
        p_remote.root_b = EndpointPath::Remote {
            endpoint_id: "host".into(),
            path: "/x".into(),
        };

        let job = job_with(vec![
            pair("01PAIR0000000000000000001A"),
            p_disabled,
            p_remote,
        ]);
        let resolved = job.fan_out();
        assert_eq!(
            resolved.len(),
            1,
            "only the enabled, fully-local pair resolves"
        );
        assert_eq!(resolved[0].pair_id, "01PAIR0000000000000000001A");
    }

    #[test]
    fn serde_field_names_snake_case() {
        let mut p = pair("01PAIR0000000000000000001A");
        p.filter_override = Some(IgnorePolicy::default());
        let job = job_with(vec![p]);
        let v: serde_json::Value = serde_json::to_value(&job).unwrap();
        let pair0 = &v["pairs"][0];
        assert!(pair0.get("root_a").is_some(), "root_a snake_case");
        assert!(pair0.get("root_b").is_some(), "root_b snake_case");
        assert!(
            pair0.get("filter_override").is_some(),
            "filter_override snake_case"
        );
        assert!(
            v["settings"].get("compare_mode").is_some(),
            "compare_mode snake_case"
        );
        // serde tag on EndpointPath
        assert_eq!(pair0["root_a"]["kind"], "Local");
    }

    #[test]
    fn validate_rejects_empty_name() {
        let mut job = job_with(vec![pair("01PAIR0000000000000000001A")]);
        job.name = "   ".into();
        assert!(matches!(
            validate_job_aggregate(&job),
            Err(crate::error::SyncError::InvalidJob(_))
        ));
    }

    #[test]
    fn validate_rejects_zero_pairs() {
        let job = job_with(vec![]);
        assert!(matches!(
            validate_job_aggregate(&job),
            Err(crate::error::SyncError::InvalidJob(_))
        ));
    }

    #[test]
    fn validate_rejects_duplicate_pair_id() {
        let job = job_with(vec![
            pair("01PAIRDUP00000000000000001"),
            pair("01PAIRDUP00000000000000001"),
        ]);
        assert!(matches!(
            validate_job_aggregate(&job),
            Err(crate::error::SyncError::InvalidJob(_))
        ));
    }

    #[test]
    fn validate_accepts_valid_job() {
        let job = job_with(vec![pair("01PAIR0000000000000000001A")]);
        assert!(validate_job_aggregate(&job).is_ok());
    }
}
