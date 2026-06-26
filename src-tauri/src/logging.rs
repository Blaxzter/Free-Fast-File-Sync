//! Diagnostic logging setup. Writes a rolling daily log file under
//! `<app_dir>/logs` via the `tracing` ecosystem so a "the scan just stopped"
//! report is diagnosable after the fact (per-pair timing, scan counts, recovered
//! panics, the effective walker thread count).
//!
//! The returned [`tracing_appender::non_blocking::WorkerGuard`] owns the
//! background flush thread of the non-blocking appender and MUST be kept alive for
//! the lifetime of the process — drop it and buffered lines are lost. The Tauri
//! layer stows it in `AppState`.

use std::path::Path;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;

/// Install the global tracing subscriber, writing to a rolling daily file
/// (`ffs.log.YYYY-MM-DD`) in `log_dir`.
///
/// `level` is a tracing filter directive (`"info"`, `"debug"`,
/// `"fast_file_sync_lib=debug"`, …). The `RUST_LOG` environment variable, when
/// set, overrides it. Returns the appender's `WorkerGuard` to keep alive, or
/// `None` if a global subscriber is already installed (e.g. a second call, or a
/// test harness) — in which case this call is a no-op.
#[must_use]
pub fn init(log_dir: &Path, level: &str) -> Option<WorkerGuard> {
    if let Err(e) = std::fs::create_dir_all(log_dir) {
        eprintln!(
            "warning: could not create log dir {}: {e}",
            log_dir.display()
        );
    }

    let file_appender = tracing_appender::rolling::daily(log_dir, "ffs.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(level))
        .unwrap_or_else(|_| EnvFilter::new("info"));

    let installed = tracing_subscriber::fmt()
        .with_writer(writer)
        .with_ansi(false)
        .with_thread_ids(true)
        .with_env_filter(filter)
        .try_init()
        .is_ok();

    if installed {
        tracing::info!(
            log_dir = %log_dir.display(),
            "fast-file-sync logging initialized"
        );
        Some(guard)
    } else {
        // Someone already owns the global default; let our unused appender wind
        // down by dropping the guard.
        None
    }
}
