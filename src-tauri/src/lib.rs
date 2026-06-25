//! Tauri entry point and IPC surface. All business logic lives in the engine
//! modules; these commands just marshal arguments, run heavy work off the UI
//! thread via `spawn_blocking`, and stream progress events to the frontend.

mod apply;
mod baseline;
mod config;
mod engine;
mod error;
mod ffs_import;
mod fsops;
mod model;
mod pathutil;
mod plan;
mod reconcile;
mod scan;

use config::JobConfig;
use error::SyncError;
use model::{ApplyReport, BaselineStatusKind, Resolution, SyncPlan};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

struct AppState {
    /// Where per-job baselines live (OS app-data dir; never inside a synced root).
    state_dir: PathBuf,
    cancel: Arc<AtomicBool>,
}

#[tauri::command]
fn validate_job(cfg: JobConfig) -> Result<(), SyncError> {
    engine::validate_job(&cfg)
}

#[tauri::command]
fn get_baseline_status(
    cfg: JobConfig,
    state: State<'_, AppState>,
) -> Result<BaselineStatusKind, SyncError> {
    Ok(engine::baseline_status(&state.state_dir, &cfg))
}

#[tauri::command]
async fn preview_sync(
    cfg: JobConfig,
    state: State<'_, AppState>,
) -> Result<SyncPlan, SyncError> {
    let dir = state.state_dir.clone();
    tauri::async_runtime::spawn_blocking(move || engine::preview(&cfg, &dir))
        .await
        .map_err(|e| SyncError::Other(format!("background task failed: {e}")))?
}

#[tauri::command]
async fn execute_sync(
    app: tauri::AppHandle,
    cfg: JobConfig,
    resolutions: HashMap<String, Resolution>,
    confirm_big_delete: bool,
    state: State<'_, AppState>,
) -> Result<ApplyReport, SyncError> {
    let dir = state.state_dir.clone();
    let cancel = state.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        engine::execute(&cfg, &dir, &resolutions, confirm_big_delete, &cancel, |p| {
            let _ = app.emit("sync://progress", p);
        })
    })
    .await
    .map_err(|e| SyncError::Other(format!("background task failed: {e}")))?
}

#[tauri::command]
fn cancel_sync(state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

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
                state_dir,
                cancel: Arc::new(AtomicBool::new(false)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            validate_job,
            get_baseline_status,
            preview_sync,
            execute_sync,
            cancel_sync,
            import_ffs
        ])
        .run(tauri::generate_context!())
        .expect("error while running fast-file-sync");
}
