//! Tauri entry point and IPC surface. All business logic lives in the engine
//! modules; these commands just marshal arguments, run heavy work off the UI
//! thread via `spawn_blocking`, and stream progress events to the frontend.
//!
//! The run surface is multi-pair and job-driven (S6): the frontend sends only
//! `{ job_id, pair_ids? }`; the backend fans the job out to per-pair `JobConfig`s
//! and loops them SEQUENTIALLY in job order through the unchanged
//! `engine::preview`/`engine::execute`. A single `run_id` + per-run cancel token
//! (the `RunRegistry`) covers the whole run; execute RE-SCANS each pair (no
//! frozen plan) so suppress-deletes / baseline-trust are fresh per pair.

mod apply;
mod baseline;
pub mod config;
mod cron;
pub mod engine;
pub mod error;
mod ffs_import;
mod fsops;
pub mod job;
mod logging;
pub mod model;
mod pathutil;
mod plan;
mod reconcile;
pub mod runlog;
pub mod runs;
pub mod scan;
mod scheduler;
pub mod settings;
pub mod store;
mod timeutil;

use error::SyncError;
use job::Job;
use model::{ApplyReport, AutoApplyPolicy, BaselineStatusKind, Resolution, SyncPlan};
use runlog::{PairRunLog, RunLogBuilder};
use runs::{RunDescriptor, RunError, RunRegistry};
use serde::Serialize;
use settings::Settings;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};
use tracing_appender::non_blocking::WorkerGuard;

struct AppState {
    /// App-data dir ROOT. `logs/`, `runs/run-log.jsonl` and `settings.json` live
    /// here; `jobs/` (= `state_dir`) is a child. Never inside a synced root.
    app_dir: PathBuf,
    /// Where per-job baselines and job.json files live (`app_dir/jobs`).
    state_dir: PathBuf,
    /// Persistence for the Job aggregate (one file per job under `state_dir`).
    store: store::Store,
    /// At-most-one-run gate with per-run cancel tokens. Replaces the old
    /// process-global `cancel: Arc<AtomicBool>`.
    runs: Arc<RunRegistry>,
    /// Global, user-facing settings (mutable at runtime via `save_settings`).
    settings: Mutex<Settings>,
    /// Background cron scheduler control surface (master switch + wake handle). The
    /// loop itself is spawned once at startup and fires jobs via `auto_run_job`.
    scheduler: scheduler::Scheduler,
    /// Keeps the non-blocking log appender's background writer thread alive for the
    /// whole process; dropping it would lose buffered log lines. `None` if a
    /// subscriber was already installed.
    _log_guard: Option<WorkerGuard>,
}

/// Stops the scan-progress ticker on drop — including while another panic unwinds
/// — so a panicking run can never leave a ticker thread emitting forever (it exits
/// at its next interval once `stop` is set). Belt-and-suspenders alongside the
/// explicit stop+join on the normal path.
struct TickerGuard {
    stop: Arc<AtomicBool>,
}

impl Drop for TickerGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Fold the global Settings defaults into each resolved pair's `JobConfig` where the
/// pair left a knob on "auto" (`0`). A pair-level value (already in `config`) wins;
/// the global default fills the gap; a still-`0` value means "let the engine pick".
fn apply_global_defaults(resolved: &mut [job::ResolvedPair], settings: &Settings) {
    let default_threads = settings.scan_threads;
    let default_gran = settings.mtime_gran_ns();
    for r in resolved.iter_mut() {
        if r.config.scan_threads == 0 {
            r.config.scan_threads = default_threads;
        }
        if r.config.mtime_gran_ns == 0 {
            r.config.mtime_gran_ns = default_gran;
        }
    }
}

fn busy(e: RunError) -> SyncError {
    let RunError::Busy { run_id } = e;
    SyncError::Busy { run_id }
}

// ---------------------------------------------------------------------------
// Job store commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_jobs(state: State<'_, AppState>) -> Vec<Job> {
    state.store.list()
}

#[tauri::command]
fn get_job(job_id: String, state: State<'_, AppState>) -> Result<Job, SyncError> {
    state.store.load(&job_id)
}

#[tauri::command]
fn save_job(job: Job, state: State<'_, AppState>) -> Result<Job, SyncError> {
    // Cross-pair structural validation the engine's single-pair `validate_job`
    // cannot see (identical/nested/duplicate roots across the whole job).
    job::validate_pair_set(&job)?;
    state.store.save(&job)
}

#[tauri::command]
fn delete_job(job_id: String, state: State<'_, AppState>) -> Result<(), SyncError> {
    state.store.delete(&job_id)
}

/// Deep-copy a job under a new ULID (and fresh pair ULIDs) with a " (copy)"
/// suffix, so its baselines never collide with the source.
#[tauri::command]
fn duplicate_job(job_id: String, state: State<'_, AppState>) -> Result<Job, SyncError> {
    let mut job = state.store.load(&job_id)?;
    job.id = String::new(); // force a fresh ULID on save
    job.created_at = String::new();
    job.name = format!("{} (copy)", job.name);
    for p in &mut job.pairs {
        p.id = String::new(); // fresh pair ULIDs => fresh baseline dirs
    }
    state.store.save(&job)
}

// ---------------------------------------------------------------------------
// Baseline status (per pair)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_pair_baseline_status(
    job_id: String,
    pair_id: String,
    state: State<'_, AppState>,
) -> BaselineStatusKind {
    engine::baseline_status(&state.store.pair_baseline_path(&job_id, &pair_id))
}

// ---------------------------------------------------------------------------
// Multi-pair run surface
// ---------------------------------------------------------------------------

/// One pair's preview result inside a run.
#[derive(Serialize)]
struct PairPreview {
    pair_id: String,
    plan: SyncPlan,
    baseline_status: BaselineStatusKind,
}

#[derive(Serialize)]
struct PreviewJobResult {
    run_id: String,
    pairs: Vec<PairPreview>,
}

/// One pair's apply result inside a run.
#[derive(Serialize)]
struct PairReport {
    pair_id: String,
    report: ApplyReport,
}

#[derive(Serialize)]
struct ExecuteJobResult {
    run_id: String,
    pairs: Vec<PairReport>,
}

#[derive(Clone, Serialize)]
struct RunStarted {
    run_id: String,
    job_id: String,
    pair_count: usize,
    trigger: String,
}

/// Emitted when the scheduler fires a job, right before its run starts, so the
/// Schedules/Activity UI can show a live "scheduled run starting" beat.
#[derive(Clone, Serialize)]
struct ScheduleTick {
    job_id: String,
    run_id: String,
    /// The schedule's apply policy (`"PreviewOnly" | "ApplySafe" | "ApplyAll"`).
    policy: String,
}

#[derive(Clone, Serialize)]
struct RunScan {
    run_id: String,
    pair_id: String,
    phase: String,
}

#[derive(Clone, Serialize)]
struct RunProgress {
    run_id: String,
    pair_id: String,
    pair_index: usize,
    pair_count: usize,
    done: usize,
    total: usize,
    path: String,
    action: String,
}

#[derive(Clone, Serialize)]
struct RunPairDone {
    run_id: String,
    pair_id: String,
}

#[derive(Clone, Serialize)]
struct RunFinished {
    run_id: String,
}

#[derive(Clone, Serialize)]
struct RunScanProgress {
    run_id: String,
    scanned: u64,
}

/// Live, shallow folder-activity snapshot pushed during the scan phase, so the run
/// view can show WHICH folders are being walked, not just a flat count. Counts are
/// merged across both roots of the CURRENT pair (the tree resets at each pair
/// boundary); `pair_id` lets the UI label the snapshot with its folder pair.
#[derive(Clone, Serialize)]
struct RunScanTree {
    run_id: String,
    pair_id: String,
    folders: Vec<ScanTreeFolder>,
}

#[derive(Clone, Serialize)]
struct ScanTreeFolder {
    /// Top-level (or `scan_tree_depth`-deep) relative folder; empty = root level.
    path: String,
    count: u64,
}

/// Live progress of the post-scan planning phase (the filtered-file disk probes —
/// the slow part over a NAS). Emitted while the scan count is frozen so the UI can
/// show "checking files" movement instead of looking stuck.
#[derive(Clone, Serialize)]
struct RunPlanProgress {
    run_id: String,
    done: u64,
    total: u64,
}

/// Cap on folders carried in a single `run://scan-tree` event (busiest first).
const SCAN_TREE_MAX_FOLDERS: usize = 64;

/// Snapshot a [`scan::ScanTree`] into the serializable event payload shape.
fn scan_tree_folders(tree: &scan::ScanTree) -> Vec<ScanTreeFolder> {
    tree.snapshot(SCAN_TREE_MAX_FOLDERS)
        .into_iter()
        .map(|(path, count)| ScanTreeFolder { path, count })
        .collect()
}

/// Build one pair's run-log record from its scan stats + timing. `err` is `Some`
/// when the pair failed (its scan stats are then meaningless and passed as
/// default). `scanned - before` is the live counter delta attributed to this pair.
fn pair_run_log(
    r: &job::ResolvedPair,
    stats: &engine::ScanStats,
    scanned: &AtomicU64,
    before: u64,
    t0: Instant,
    err: Option<&SyncError>,
) -> PairRunLog {
    PairRunLog {
        pair_id: r.pair_id.clone(),
        entries_a: stats.entries_a,
        entries_b: stats.entries_b,
        errors_a: stats.errors_a,
        errors_b: stats.errors_b,
        skipped_a: stats.skipped_a,
        skipped_b: stats.skipped_b,
        scanned: scanned.load(Ordering::Relaxed).saturating_sub(before),
        threads: scan::resolve_scan_threads(r.config.scan_threads),
        ms: t0.elapsed().as_millis(),
        ok: err.is_none(),
        error: err.map(|e| e.to_string()),
    }
}

/// Resolve the enabled pairs for `job`, optionally filtered to `pair_ids`, in job
/// order. A `Some(pair_ids)` filter keeps only those ids (and only if enabled).
fn select_pairs(job: &Job, pair_ids: &Option<Vec<String>>) -> Vec<job::ResolvedPair> {
    let resolved = job.fan_out();
    match pair_ids {
        None => resolved,
        Some(ids) => resolved
            .into_iter()
            .filter(|r| ids.iter().any(|w| w == &r.pair_id))
            .collect(),
    }
}

/// Preview a job: claim the single run slot, then loop the selected enabled pairs
/// SEQUENTIALLY through the unchanged `engine::preview` (each with its own
/// per-(job,pair) baseline). The run slot is HELD until `execute_job` or
/// `cancel_run` releases it, so a concurrent preview/apply of any job is Busy.
#[tauri::command]
async fn preview_job(
    app: tauri::AppHandle,
    job_id: String,
    pair_ids: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<PreviewJobResult, SyncError> {
    let job = state.store.load(&job_id)?;
    let mut resolved = select_pairs(&job, &pair_ids);
    // Fold global Settings defaults (scan threads, mtime granularity) into any pair
    // left on "auto", and snapshot the live-progress ticker interval + tree depth.
    let (ticker_ms, tree_depth) = {
        let s = state.settings.lock().unwrap();
        apply_global_defaults(&mut resolved, &s);
        (s.ticker_ms(), s.tree_depth())
    };
    let selected_ids: Vec<String> = resolved.iter().map(|r| r.pair_id.clone()).collect();

    let runs = state.runs.clone();
    let handle = runs
        .try_start(RunDescriptor {
            job_id: job_id.clone(),
            pair_ids: selected_ids,
        })
        .map_err(busy)?;
    let run_id = handle.run_id.clone();
    let store_dir = state.state_dir.clone();
    let app_dir = state.app_dir.clone();
    let job_id_for_paths = job_id.clone();

    let _ = app.emit(
        "run://started",
        RunStarted {
            run_id: run_id.clone(),
            job_id: job_id.clone(),
            pair_count: resolved.len(),
            trigger: "Manual".into(),
        },
    );

    // The blocking task re-creates a Store from the jobs dir (State can't cross
    // the spawn_blocking boundary); it only needs the dir to compute baseline paths.
    let app_for_task = app.clone();
    let run_id_task = run_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_preview_loop(
            app_for_task,
            run_id_task,
            job_id_for_paths,
            resolved,
            store_dir,
            app_dir,
            ticker_ms,
            tree_depth,
            "Manual".to_string(),
        )
    })
    .await
    .map_err(|e| SyncError::Other(format!("background task failed: {e}")));

    match result {
        Ok(Ok(pairs)) => Ok(PreviewJobResult { run_id, pairs }),
        Ok(Err(e)) => {
            // The run is dead; release the slot so the user can retry.
            runs.finish(&run_id);
            let _ = app.emit("run://finished", RunFinished { run_id });
            Err(e)
        }
        Err(e) => {
            runs.finish(&run_id);
            let _ = app.emit("run://finished", RunFinished { run_id });
            Err(e)
        }
    }
    // NOTE: on success the slot stays HELD until execute_job/cancel_run.
}

/// Execute the run named by `run_id`. Re-loads the held run's job + selected
/// pairs and RE-SCANS each pair through the unchanged `engine::execute` (NO
/// frozen plan), so suppress-deletes / baseline-trust are fresh at apply time.
/// One `run_id` + cancel token covers the whole run; the slot is released when
/// the loop finishes.
#[tauri::command]
async fn execute_job(
    app: tauri::AppHandle,
    run_id: String,
    resolutions: HashMap<String, HashMap<String, Resolution>>,
    confirm_big_delete: HashMap<String, bool>,
    state: State<'_, AppState>,
) -> Result<ExecuteJobResult, SyncError> {
    let runs = state.runs.clone();
    let ctx = runs.context(&run_id).ok_or(SyncError::UnknownRun)?;

    let job = state.store.load(&ctx.job_id)?;
    let pair_ids = Some(ctx.pair_ids.clone());
    let mut resolved = select_pairs(&job, &pair_ids);
    // Same global-default injection as preview, so the apply re-scan uses the same
    // walker thread count and granularity the user previewed with.
    {
        let s = state.settings.lock().unwrap();
        apply_global_defaults(&mut resolved, &s);
    }
    let store_dir = state.state_dir.clone();
    let app_dir = state.app_dir.clone();
    let job_id_for_paths = ctx.job_id.clone();
    let cancel = ctx.cancel.clone();

    let app_for_task = app.clone();
    let run_id_task = run_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_execute_loop(
            app_for_task,
            run_id_task,
            job_id_for_paths,
            resolved,
            store_dir,
            app_dir,
            resolutions,
            confirm_big_delete,
            AutoApplyPolicy::Manual,
            cancel,
            "Manual".to_string(),
        )
    })
    .await
    .map_err(|e| SyncError::Other(format!("background task failed: {e}")));

    // Whatever happened, the run is over: release the slot and tell the UI.
    runs.finish(&run_id);
    let _ = app.emit(
        "run://finished",
        RunFinished {
            run_id: run_id.clone(),
        },
    );

    match result {
        Ok(Ok(pairs)) => Ok(ExecuteJobResult { run_id, pairs }),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(e),
    }
}

/// Cancel a specific run by id. Flips only that run's per-run token; an unknown
/// id is a no-op. Returns `true` iff a matching active run was found.
#[tauri::command]
fn cancel_run(run_id: String, state: State<'_, AppState>) -> bool {
    state.runs.cancel(&run_id)
}

// ---------------------------------------------------------------------------
// Shared run pipeline bodies (called by the manual commands AND the scheduler)
//
// These are the `spawn_blocking` bodies extracted so EVERY run — manual preview,
// manual execute, and scheduled — goes through the SAME guarded loop. That keeps
// delete-suppression, the big-delete gate, and baseline-trust uniform (the locked
// "every run goes through preview -> execute" invariant). `trigger` tags the run
// ("Manual" | "Schedule"); `policy` selects the interactive-vs-automated apply
// behavior (conflict deferral, delete deferral — see `AutoApplyPolicy`).
// ---------------------------------------------------------------------------

/// The preview pair-loop: scan each resolved pair through the unchanged
/// `engine::preview` (with its own per-(job,pair) baseline), stream live scan /
/// plan progress off a ticker thread, and write the structured run-log. Runs
/// INSIDE `spawn_blocking`.
#[allow(clippy::too_many_arguments)]
fn run_preview_loop(
    app: tauri::AppHandle,
    run_id: String,
    job_id: String,
    resolved: Vec<job::ResolvedPair>,
    store_dir: PathBuf,
    app_dir: PathBuf,
    ticker_ms: u64,
    tree_depth: usize,
    trigger: String,
) -> Result<Vec<PairPreview>, SyncError> {
    let store = store::Store::new(store_dir);
    // Live scan progress: a shared counter the parallel walk bumps per entry,
    // polled by a ticker thread that emits run://scan-progress. Cumulative across
    // the job's pairs; the folder tree (when enabled) tallies per-folder activity.
    let scanned = Arc::new(AtomicU64::new(0));
    let tree = (tree_depth > 0).then(|| Arc::new(scan::ScanTree::new(tree_depth)));
    let plan_progress = Arc::new(plan::PlanProgress::default());
    let cur_pair = Arc::new(Mutex::new(String::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let ticker = {
        let app = app.clone();
        let run_id = run_id.clone();
        let scanned = scanned.clone();
        let tree = tree.clone();
        let plan_progress = plan_progress.clone();
        let cur_pair = cur_pair.clone();
        let stop = stop.clone();
        let tree_every = (200 / ticker_ms.max(1)).max(1);
        std::thread::spawn(move || {
            let mut tick: u64 = 0;
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(ticker_ms));
                tick += 1;
                let _ = app.emit(
                    "run://scan-progress",
                    RunScanProgress {
                        run_id: run_id.clone(),
                        scanned: scanned.load(Ordering::Relaxed),
                    },
                );
                let plan_total = plan_progress.total.load(Ordering::Relaxed);
                if plan_total > 0 {
                    let _ = app.emit(
                        "run://plan-progress",
                        RunPlanProgress {
                            run_id: run_id.clone(),
                            done: plan_progress.done.load(Ordering::Relaxed),
                            total: plan_total,
                        },
                    );
                }
                if let Some(t) = &tree {
                    if tick % tree_every == 0 {
                        let pair_id = cur_pair.lock().map(|g| g.clone()).unwrap_or_default();
                        let _ = app.emit(
                            "run://scan-tree",
                            RunScanTree {
                                run_id: run_id.clone(),
                                pair_id,
                                folders: scan_tree_folders(t),
                            },
                        );
                    }
                }
            }
        })
    };
    let _ticker_guard = TickerGuard { stop: stop.clone() };

    let mut rl = RunLogBuilder::new(&run_id, &job_id, "preview", &trigger, resolved.len());
    let mut pairs = Vec::with_capacity(resolved.len());
    let mut run_err: Option<SyncError> = None;

    for r in &resolved {
        if let Some(t) = &tree {
            t.clear();
        }
        plan_progress.done.store(0, Ordering::Relaxed);
        plan_progress.total.store(0, Ordering::Relaxed);
        if let Ok(mut g) = cur_pair.lock() {
            r.pair_id.clone_into(&mut g);
        }
        let _ = app.emit(
            "run://scan",
            RunScan {
                run_id: run_id.clone(),
                pair_id: r.pair_id.clone(),
                phase: "Scanning".into(),
            },
        );
        let before = scanned.load(Ordering::Relaxed);
        let t0 = Instant::now();
        let bpath = store.pair_baseline_path(&job_id, &r.pair_id);
        let status = engine::baseline_status(&bpath);
        match engine::preview_counted_stats(
            &r.config,
            &bpath,
            &scanned,
            tree.as_deref(),
            Some(&plan_progress),
        ) {
            Ok((plan, stats)) => {
                rl.pair(pair_run_log(r, &stats, &scanned, before, t0, None));
                pairs.push(PairPreview {
                    pair_id: r.pair_id.clone(),
                    plan,
                    baseline_status: status,
                });
                let _ = app.emit(
                    "run://pair-done",
                    RunPairDone {
                        run_id: run_id.clone(),
                        pair_id: r.pair_id.clone(),
                    },
                );
            }
            Err(e) => {
                rl.pair(pair_run_log(
                    r,
                    &engine::ScanStats::default(),
                    &scanned,
                    before,
                    t0,
                    Some(&e),
                ));
                run_err = Some(e);
                break;
            }
        }
    }

    stop.store(true, Ordering::Relaxed);
    let _ = ticker.join();
    let _ = app.emit(
        "run://scan-progress",
        RunScanProgress {
            run_id: run_id.clone(),
            scanned: scanned.load(Ordering::Relaxed),
        },
    );
    if let Some(t) = &tree {
        let pair_id = cur_pair.lock().map(|g| g.clone()).unwrap_or_default();
        let _ = app.emit(
            "run://scan-tree",
            RunScanTree {
                run_id: run_id.clone(),
                pair_id,
                folders: scan_tree_folders(t),
            },
        );
    }
    rl.finish(&app_dir, run_err.as_ref().map(|e| e.to_string()), false);
    match run_err {
        Some(e) => Err(e),
        None => Ok(pairs),
    }
}

/// The execute pair-loop: RE-SCAN + apply each resolved pair through the unchanged
/// `engine::execute` under `policy`, stream `run://progress`, and write the run-log.
/// Runs INSIDE `spawn_blocking`. A flipped `cancel` breaks at the next pair/item
/// boundary and marks the run cancelled.
#[allow(clippy::too_many_arguments)]
fn run_execute_loop(
    app: tauri::AppHandle,
    run_id: String,
    job_id: String,
    resolved: Vec<job::ResolvedPair>,
    store_dir: PathBuf,
    app_dir: PathBuf,
    resolutions: HashMap<String, HashMap<String, Resolution>>,
    confirm_big_delete: HashMap<String, bool>,
    policy: AutoApplyPolicy,
    cancel: Arc<AtomicBool>,
    trigger: String,
) -> Result<Vec<PairReport>, SyncError> {
    let store = store::Store::new(store_dir);
    let pair_count = resolved.len();
    let scanned = Arc::new(AtomicU64::new(0));
    let mut rl = RunLogBuilder::new(&run_id, &job_id, "execute", &trigger, resolved.len());
    let mut reports = Vec::with_capacity(resolved.len());
    let mut run_err: Option<SyncError> = None;

    for (pair_index, r) in resolved.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let _ = app.emit(
            "run://scan",
            RunScan {
                run_id: run_id.clone(),
                pair_id: r.pair_id.clone(),
                phase: "Scanning".into(),
            },
        );
        let before = scanned.load(Ordering::Relaxed);
        let t0 = Instant::now();
        let bpath = store.pair_baseline_path(&job_id, &r.pair_id);
        let res_for_pair = resolutions.get(&r.pair_id).cloned().unwrap_or_default();
        let confirm = confirm_big_delete.get(&r.pair_id).copied().unwrap_or(false);

        let pair_id = r.pair_id.clone();
        let run_id_p = run_id.clone();
        let app_p = app.clone();
        match engine::execute_counted_stats(
            &r.config,
            &bpath,
            &res_for_pair,
            policy,
            confirm,
            &cancel,
            &scanned,
            move |p| {
                let _ = app_p.emit(
                    "run://progress",
                    RunProgress {
                        run_id: run_id_p.clone(),
                        pair_id: pair_id.clone(),
                        pair_index,
                        pair_count,
                        done: p.done,
                        total: p.total,
                        path: p.path,
                        action: p.action,
                    },
                );
            },
        ) {
            Ok((report, stats)) => {
                rl.pair(pair_run_log(r, &stats, &scanned, before, t0, None));
                reports.push(PairReport {
                    pair_id: r.pair_id.clone(),
                    report,
                });
                let _ = app.emit(
                    "run://pair-done",
                    RunPairDone {
                        run_id: run_id.clone(),
                        pair_id: r.pair_id.clone(),
                    },
                );
            }
            Err(e) => {
                rl.pair(pair_run_log(
                    r,
                    &engine::ScanStats::default(),
                    &scanned,
                    before,
                    t0,
                    Some(&e),
                ));
                run_err = Some(e);
                break;
            }
        }
    }

    let cancelled = cancel.load(Ordering::Relaxed);
    rl.finish(&app_dir, run_err.as_ref().map(|e| e.to_string()), cancelled);
    match run_err {
        Some(e) => Err(e),
        None => Ok(reports),
    }
}

/// Fire a scheduled (unattended) run for `job_id` under `cfg`, routed through the
/// SAME guarded pipeline as a manual run. Claims the single run slot; if a run
/// already holds it this occurrence is SKIPPED (logged), never queued. Conflicts
/// are never auto-resolved (the pipeline defers them); a big-delete trip aborts an
/// `ApplyAll` run because automated runs never set the confirm flag. Best-effort:
/// errors are logged (and captured in the run-log), never propagated to the caller.
pub(crate) async fn auto_run_job(app: tauri::AppHandle, job_id: String, cfg: job::ScheduleConfig) {
    // Pull what we need out of managed state as owned clones so no State borrow is
    // held across the .await below.
    let (store_dir, app_dir, runs, resolved, ticker_ms, tree_depth) = {
        let state = app.state::<AppState>();
        let job = match state.store.load(&job_id) {
            Ok(j) => j,
            Err(e) => {
                tracing::warn!(job = %job_id, error = %e, "scheduled run: job load failed");
                return;
            }
        };
        let mut resolved = select_pairs(&job, &None);
        let (ticker_ms, tree_depth) = {
            let s = state.settings.lock().unwrap();
            apply_global_defaults(&mut resolved, &s);
            (s.ticker_ms(), s.tree_depth())
        };
        (
            state.state_dir.clone(),
            state.app_dir.clone(),
            state.runs.clone(),
            resolved,
            ticker_ms,
            tree_depth,
        )
    };

    if resolved.is_empty() {
        tracing::info!(job = %job_id, "scheduled run: no enabled local pairs; skipping");
        return;
    }

    let handle = match runs.try_start(RunDescriptor {
        job_id: job_id.clone(),
        pair_ids: resolved.iter().map(|r| r.pair_id.clone()).collect(),
    }) {
        Ok(h) => h,
        Err(RunError::Busy { run_id }) => {
            tracing::info!(job = %job_id, holding = %run_id, "scheduled run skipped: a run already holds the slot");
            return;
        }
    };
    let run_id = handle.run_id.clone();
    let cancel = handle.cancel_token();
    let trigger = "Schedule".to_string();
    let preview_only = cfg.policy.is_preview_only();
    let policy = cfg.policy.auto_apply();

    let _ = app.emit(
        "run://started",
        RunStarted {
            run_id: run_id.clone(),
            job_id: job_id.clone(),
            pair_count: resolved.len(),
            trigger: trigger.clone(),
        },
    );
    let _ = app.emit(
        "schedule://tick",
        ScheduleTick {
            job_id: job_id.clone(),
            run_id: run_id.clone(),
            policy: format!("{:?}", cfg.policy),
        },
    );

    let app_for_task = app.clone();
    let run_id_task = run_id.clone();
    let job_id_task = job_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if preview_only {
            run_preview_loop(
                app_for_task,
                run_id_task,
                job_id_task,
                resolved,
                store_dir,
                app_dir,
                ticker_ms,
                tree_depth,
                trigger,
            )
            .map(|_| ())
        } else {
            run_execute_loop(
                app_for_task,
                run_id_task,
                job_id_task,
                resolved,
                store_dir,
                app_dir,
                HashMap::new(),
                HashMap::new(),
                policy,
                cancel,
                trigger,
            )
            .map(|_| ())
        }
    })
    .await;

    runs.finish(&run_id);
    let _ = app.emit(
        "run://finished",
        RunFinished {
            run_id: run_id.clone(),
        },
    );
    match result {
        Ok(Ok(())) => tracing::info!(job = %job_id, run = %run_id, "scheduled run finished"),
        Ok(Err(e)) => {
            tracing::warn!(job = %job_id, run = %run_id, error = %e, "scheduled run failed")
        }
        Err(e) => {
            tracing::error!(job = %job_id, run = %run_id, error = %e, "scheduled run task panicked")
        }
    }
}

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------

/// Current global settings (defaults if none were ever saved).
#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// Persist global settings and apply them in-process. Returns the saved value.
/// Note: the log level is read at startup, so a changed level takes effect on the
/// next launch; the scan-thread/granularity/ticker values apply to the next run.
#[tauri::command]
fn save_settings(settings: Settings, state: State<'_, AppState>) -> Result<Settings, SyncError> {
    let saved = settings::save(&state.app_dir, &settings)?;
    *state.settings.lock().unwrap() = saved.clone();
    // Keep the running scheduler's master switch in sync with the persisted value
    // (takes effect immediately; a still-running job is unaffected).
    state.scheduler.set_enabled(saved.scheduler_enabled);
    tracing::info!(
        scan_threads = saved.scan_threads,
        mtime_gran_ms = saved.mtime_gran_ms,
        scan_ticker_ms = saved.scan_ticker_ms,
        scheduler_enabled = saved.scheduler_enabled,
        log_level = %saved.log_level,
        "settings saved"
    );
    Ok(saved)
}

// ---------------------------------------------------------------------------
// Activity (run history)
// ---------------------------------------------------------------------------

/// Cap on runs returned by `list_activity`. The Activity feed shows recent
/// history; the full append-only log stays on disk for forensics.
const ACTIVITY_LIMIT: usize = 500;

/// Recent run history, newest first, read from the append-only run log
/// (`<app_dir>/runs/run-log.jsonl`) that every preview/execute run writes on
/// finish. Read-only: this never mutates the log. A missing log => empty history.
#[tauri::command]
fn list_activity(state: State<'_, AppState>) -> Vec<runlog::RunLog> {
    runlog::read_run_log(&state.app_dir, ACTIVITY_LIMIT)
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/// A job's schedule as surfaced to the Schedules screen: the owning job + its cron
/// config + the next computed fire (RFC3339 UTC), so the UI shows cross-job
/// next-run ordering without re-implementing cron.
#[derive(Serialize)]
struct ScheduleView {
    job_id: String,
    job_name: String,
    schedule: job::ScheduleConfig,
    /// Next fire as RFC3339 UTC; `None` when paused, unparseable, or unsatisfiable.
    #[serde(skip_serializing_if = "Option::is_none")]
    next_run: Option<String>,
}

/// Validate a cron string, mapping a parse error to a user-facing `InvalidJob`.
fn validate_cron(expr: &str) -> Result<(), SyncError> {
    cron::Cron::parse(expr)
        .map(|_| ())
        .map_err(|e| SyncError::InvalidJob(format!("invalid cron expression: {e}")))
}

/// Attach or replace a job's cron schedule. Validates the cron up front so a bad
/// expression is rejected at save time (never a schedule that silently never
/// fires). Wakes the scheduler to pick it up immediately. Returns the saved job.
#[tauri::command]
fn set_schedule(
    job_id: String,
    schedule: job::ScheduleConfig,
    state: State<'_, AppState>,
) -> Result<Job, SyncError> {
    validate_cron(&schedule.cron)?;
    let mut job = state.store.load(&job_id)?;
    let mut automation = job.automation.take().unwrap_or_default();
    automation.schedule = Some(schedule);
    job.automation = Some(automation);
    let saved = state.store.save(&job)?;
    state.scheduler.poke();
    Ok(saved)
}

/// Remove a job's schedule entirely (drops an otherwise-empty automation object).
#[tauri::command]
fn clear_schedule(job_id: String, state: State<'_, AppState>) -> Result<Job, SyncError> {
    let mut job = state.store.load(&job_id)?;
    if let Some(a) = job.automation.as_mut() {
        a.schedule = None;
    }
    if matches!(&job.automation, Some(a) if a.schedule.is_none()) {
        job.automation = None;
    }
    let saved = state.store.save(&job)?;
    state.scheduler.poke();
    Ok(saved)
}

/// Pause or resume a job's schedule without discarding its cron.
#[tauri::command]
fn pause_schedule(
    job_id: String,
    paused: bool,
    state: State<'_, AppState>,
) -> Result<Job, SyncError> {
    let mut job = state.store.load(&job_id)?;
    match job.automation.as_mut().and_then(|a| a.schedule.as_mut()) {
        Some(s) => s.enabled = !paused,
        None => return Err(SyncError::InvalidJob("job has no schedule to pause".into())),
    }
    let saved = state.store.save(&job)?;
    state.scheduler.poke();
    Ok(saved)
}

/// Every job's schedule with its next computed fire, soonest-first (paused/unset
/// sort last). The cross-job lens the Schedules screen renders.
#[tauri::command]
fn list_schedules(state: State<'_, AppState>) -> Vec<ScheduleView> {
    let now = timeutil::now_unix();
    let mut views: Vec<ScheduleView> = state
        .store
        .list()
        .into_iter()
        .filter_map(|job| {
            let schedule = job.automation.as_ref()?.schedule.clone()?;
            let next_run = if schedule.enabled {
                cron::Cron::parse(&schedule.cron)
                    .ok()
                    .and_then(|c| c.next_after(now, schedule.tz_offset_minutes.unwrap_or(0)))
                    .map(timeutil::rfc3339_from_unix_secs)
            } else {
                None
            };
            Some(ScheduleView {
                job_id: job.id,
                job_name: job.name,
                schedule,
                next_run,
            })
        })
        .collect();
    views.sort_by(|a, b| match (&a.next_run, &b.next_run) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    views
}

/// Fire a job's scheduled run immediately (the "Run now" button), regardless of its
/// cron time, using its configured policy. Routes through the same guarded
/// `auto_run_job` pipeline. A job without a schedule runs once with the default
/// policy. Skipped (logged) if a run already holds the slot.
#[tauri::command]
async fn run_schedule_now(
    app: tauri::AppHandle,
    job_id: String,
    state: State<'_, AppState>,
) -> Result<(), SyncError> {
    let job = state.store.load(&job_id)?;
    let cfg = job
        .automation
        .and_then(|a| a.schedule)
        .unwrap_or_else(|| job::ScheduleConfig {
            enabled: true,
            cron: "0 0 * * *".into(),
            tz_offset_minutes: None,
            policy: job::SchedulePolicy::default(),
            skip_if_watched: false,
        });
    auto_run_job(app, job_id, cfg).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// FFS import (unchanged)
// ---------------------------------------------------------------------------

/// Parse a FreeFileSync `.ffs_batch`/`.ffs_gui` config into importable jobs.
#[tauri::command]
fn import_ffs(path: String) -> Result<ffs_import::FfsImport, SyncError> {
    let xml = std::fs::read_to_string(&path)
        .map_err(|e| SyncError::from_io(std::path::Path::new(&path), &e))?;
    ffs_import::parse_ffs(&xml).map_err(SyncError::InvalidJob)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // App-data dir ROOT: settings.json, logs/ and runs/ live here; jobs/ is
            // a child. Fall back to a NAMED temp subdir (not the temp root) so a
            // missing app-data dir doesn't scatter logs across the temp directory.
            let app_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("fast-file-sync"));
            let _ = std::fs::create_dir_all(&app_dir);

            // Load settings BEFORE logging so the configured log level applies.
            let settings = settings::load(&app_dir);
            let log_guard = logging::init(&app_dir.join("logs"), &settings.log_level);

            let state_dir = app_dir.join("jobs");
            let _ = std::fs::create_dir_all(&state_dir);

            tracing::info!(app_dir = %app_dir.display(), "fast-file-sync starting");
            let scheduler_enabled = settings.scheduler_enabled;
            app.manage(AppState {
                store: store::Store::new(state_dir.clone()),
                app_dir,
                state_dir,
                runs: Arc::new(RunRegistry::new()),
                settings: Mutex::new(settings),
                scheduler: scheduler::Scheduler::new(scheduler_enabled),
                _log_guard: log_guard,
            });
            // Start the background cron scheduler now that AppState is managed (the
            // loop reads jobs + settings out of managed state each tick).
            app.state::<AppState>()
                .scheduler
                .spawn_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_jobs,
            get_job,
            save_job,
            delete_job,
            duplicate_job,
            get_pair_baseline_status,
            preview_job,
            execute_job,
            cancel_run,
            get_settings,
            save_settings,
            list_activity,
            set_schedule,
            clear_schedule,
            pause_schedule,
            list_schedules,
            run_schedule_now,
            import_ffs
        ])
        .run(tauri::generate_context!())
        .expect("error while running fast-file-sync");
}
