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
pub mod engine;
pub mod error;
mod ffs_import;
mod fsops;
pub mod job;
pub mod model;
mod pathutil;
mod plan;
mod reconcile;
pub mod runs;
mod scan;
pub mod store;

use error::SyncError;
use job::Job;
use model::{ApplyReport, BaselineStatusKind, Resolution, SyncPlan};
use runs::{RunDescriptor, RunError, RunRegistry};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

struct AppState {
    /// Where per-job baselines and job.json files live (OS app-data dir; never
    /// inside a synced root).
    #[allow(dead_code)]
    state_dir: PathBuf,
    /// Persistence for the Job aggregate (one file per job under `state_dir`).
    store: store::Store,
    /// At-most-one-run gate with per-run cancel tokens. Replaces the old
    /// process-global `cancel: Arc<AtomicBool>`.
    runs: Arc<RunRegistry>,
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
    let resolved = select_pairs(&job, &pair_ids);
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
        let store = store::Store::new(store_dir);
        // Live scan progress: a shared counter the parallel walk bumps per entry,
        // polled by a ticker thread that emits run://scan-progress (~8/sec). The
        // count is cumulative across the job's pairs.
        let scanned = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let ticker = {
            let app = app_for_task.clone();
            let run_id = run_id_task.clone();
            let scanned = scanned.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(120));
                    let _ = app.emit(
                        "run://scan-progress",
                        RunScanProgress {
                            run_id: run_id.clone(),
                            scanned: scanned.load(Ordering::Relaxed),
                        },
                    );
                }
            })
        };

        // Wrapped so an early `?` still stops the ticker + emits the final count.
        let pairs = (|| -> std::result::Result<Vec<PairPreview>, SyncError> {
            let mut pairs = Vec::with_capacity(resolved.len());
            for r in &resolved {
                let _ = app_for_task.emit(
                    "run://scan",
                    RunScan {
                        run_id: run_id_task.clone(),
                        pair_id: r.pair_id.clone(),
                        phase: "Scanning".into(),
                    },
                );
                let bpath = store.pair_baseline_path(&job_id_for_paths, &r.pair_id);
                let status = engine::baseline_status(&bpath);
                let plan = engine::preview_counted(&r.config, &bpath, &scanned)?;
                pairs.push(PairPreview {
                    pair_id: r.pair_id.clone(),
                    plan,
                    baseline_status: status,
                });
                let _ = app_for_task.emit(
                    "run://pair-done",
                    RunPairDone {
                        run_id: run_id_task.clone(),
                        pair_id: r.pair_id.clone(),
                    },
                );
            }
            Ok(pairs)
        })();

        stop.store(true, Ordering::Relaxed);
        let _ = ticker.join();
        // One final exact count once the walk has settled.
        let _ = app_for_task.emit(
            "run://scan-progress",
            RunScanProgress {
                run_id: run_id_task.clone(),
                scanned: scanned.load(Ordering::Relaxed),
            },
        );
        pairs
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
    let resolved = select_pairs(&job, &pair_ids);
    let store_dir = state.state_dir.clone();
    let job_id_for_paths = ctx.job_id.clone();
    let cancel = ctx.cancel.clone();

    let app_for_task = app.clone();
    let run_id_task = run_id.clone();
    let pair_count = resolved.len();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let store = store::Store::new(store_dir);
        let mut reports = Vec::with_capacity(resolved.len());
        for (pair_index, r) in resolved.iter().enumerate() {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            let _ = app_for_task.emit(
                "run://scan",
                RunScan {
                    run_id: run_id_task.clone(),
                    pair_id: r.pair_id.clone(),
                    phase: "Scanning".into(),
                },
            );
            let bpath = store.pair_baseline_path(&job_id_for_paths, &r.pair_id);
            let res_for_pair = resolutions.get(&r.pair_id).cloned().unwrap_or_default();
            let confirm = confirm_big_delete.get(&r.pair_id).copied().unwrap_or(false);

            let pair_id = r.pair_id.clone();
            let run_id_p = run_id_task.clone();
            let app_p = app_for_task.clone();
            let report = engine::execute(
                &r.config,
                &bpath,
                &res_for_pair,
                confirm,
                &cancel,
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
            )?;
            reports.push(PairReport {
                pair_id: r.pair_id.clone(),
                report,
            });
            let _ = app_for_task.emit(
                "run://pair-done",
                RunPairDone {
                    run_id: run_id_task.clone(),
                    pair_id: r.pair_id.clone(),
                },
            );
        }
        Ok::<_, SyncError>(reports)
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
            let state_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("jobs");
            let _ = std::fs::create_dir_all(&state_dir);
            app.manage(AppState {
                store: store::Store::new(state_dir.clone()),
                state_dir,
                runs: Arc::new(RunRegistry::new()),
            });
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
            import_ffs
        ])
        .run(tauri::generate_context!())
        .expect("error while running fast-file-sync");
}
