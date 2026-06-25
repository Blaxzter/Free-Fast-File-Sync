//! Process-wide registry of the single in-flight sync run.
//!
//! Replaces the old global `AppState.cancel: Arc<AtomicBool>` with a per-run
//! cancel token and enforces the locked "no concurrent runs" decision: at most
//! one run (preview OR apply) holds the pipeline at a time. A second
//! [`RunRegistry::try_start`] while one is active returns
//! [`RunError::Busy`] with the id of the run holding the slot; it is rejected,
//! never queued (a queued plan would go stale and defeat the preview-then-apply
//! safety contract).
//!
//! Cancellation is per-run: every run owns its own `Arc<AtomicBool>` and
//! [`RunRegistry::cancel`] flips only that run's token. Cancelling some other
//! (or unknown) id is a no-op and can never stop the active run. Runs are
//! serialized today, so this is also structurally correct for the future
//! watch/schedule fan-in.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Server-minted run id: a sortable, monotonic, collision-free ULID string.
pub type RunId = String;

/// What a caller knows about a run before it is granted a slot. The `run_id` is
/// minted by the registry, not supplied here.
#[derive(Debug, Clone)]
pub struct RunDescriptor {
    /// Stable job identity (ULID). Carried for diagnostics / future per-job UX
    /// and so `execute_job` can re-load the job for the held run.
    pub job_id: String,
    /// The subset of pair ids this run covers (empty => all enabled pairs). The
    /// run layer re-scans these at execute time; NO plan is frozen here.
    pub pair_ids: Vec<String>,
}

/// The single active run holding the pipeline slot.
struct ActiveRun {
    run_id: RunId,
    job_id: String,
    pair_ids: Vec<String>,
    cancel: Arc<AtomicBool>,
}

/// What `execute_job` needs to re-drive a held run: its job, selected pairs, and
/// the per-run cancel token. Deliberately NOT a frozen plan — execute re-scans.
#[derive(Clone)]
pub struct RunContext {
    pub run_id: RunId,
    pub job_id: String,
    pub pair_ids: Vec<String>,
    pub cancel: Arc<AtomicBool>,
}

/// Reasons a [`RunRegistry::try_start`] can be refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum RunError {
    /// Another run already holds the pipeline. Carries the id of that run so the
    /// UI can address it (e.g. offer to cancel it).
    Busy { run_id: RunId },
}

/// Handle returned to the caller that won the slot. Carries the minted `run_id`
/// (to tag events / call `finish`) and exposes the per-run cancel flag to hand
/// into `engine::execute` / `apply_plan`.
pub struct RunHandle {
    pub run_id: RunId,
    cancel: Arc<AtomicBool>,
}

impl RunHandle {
    /// The per-run cancel token, for passing to the apply loop
    /// (`engine::execute` takes `&AtomicBool`). Flipped only by
    /// `RunRegistry::cancel(this run_id)`. (Used by tests and the S6 apply path;
    /// the current single-pair command path uses `cancel_token`.)
    #[allow(dead_code)]
    pub fn cancel_flag(&self) -> &AtomicBool {
        &self.cancel
    }

    /// A shared clone of the per-run cancel token, for handing to a worker that
    /// must read it across a thread/`spawn_blocking` boundary. Same underlying
    /// bool as [`Self::cancel_flag`].
    pub fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// True once this run's token has been flipped (by `cancel`). Used to label
    /// a finished apply as Cancelled vs Done in the S6 path.
    #[allow(dead_code)]
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// At-most-one-run registry. The single slot serializes every preview and apply
/// process-wide.
#[derive(Default)]
pub struct RunRegistry {
    inner: Mutex<Option<ActiveRun>>,
}

impl RunRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn new_id() -> RunId {
        ulid::Ulid::new().to_string()
    }

    /// Atomically claim the single pipeline slot. Returns a [`RunHandle`] on
    /// success, or [`RunError::Busy`] carrying the active run's id when one is
    /// already running. The check-and-insert is under one lock so two
    /// simultaneous attempts can never both win.
    pub fn try_start(&self, descriptor: RunDescriptor) -> Result<RunHandle, RunError> {
        let mut slot = self.inner.lock().unwrap();
        if let Some(active) = slot.as_ref() {
            return Err(RunError::Busy {
                run_id: active.run_id.clone(),
            });
        }
        let run_id = Self::new_id();
        let cancel = Arc::new(AtomicBool::new(false));
        *slot = Some(ActiveRun {
            run_id: run_id.clone(),
            job_id: descriptor.job_id,
            pair_ids: descriptor.pair_ids,
            cancel: cancel.clone(),
        });
        Ok(RunHandle { run_id, cancel })
    }

    /// Snapshot the active run's context IFF it matches `run_id`. Used by
    /// `execute_job` to re-load the job and reuse the held run's cancel token.
    /// Returns None for an unknown/stale id (the slot is free or holds another run).
    pub fn context(&self, run_id: &str) -> Option<RunContext> {
        let slot = self.inner.lock().unwrap();
        slot.as_ref()
            .filter(|a| a.run_id == run_id)
            .map(|a| RunContext {
                run_id: a.run_id.clone(),
                job_id: a.job_id.clone(),
                pair_ids: a.pair_ids.clone(),
                cancel: a.cancel.clone(),
            })
    }

    /// Flip the cancel token of `run_id`. No-op for an unknown id (already
    /// finished, or never existed). Returns `true` iff a matching active run was
    /// found and flipped. Crucially this only ever touches the run named by
    /// `run_id`, so cancelling one run cannot stop another.
    pub fn cancel(&self, run_id: &str) -> bool {
        let slot = self.inner.lock().unwrap();
        match slot.as_ref() {
            Some(active) if active.run_id == run_id => {
                active.cancel.store(true, Ordering::Relaxed);
                true
            }
            _ => false,
        }
    }

    /// Release the slot held by `run_id`. No-op if the active run is a different
    /// id (or there is none), so a stale `finish` can never evict a newer run.
    pub fn finish(&self, run_id: &str) {
        let mut slot = self.inner.lock().unwrap();
        if matches!(slot.as_ref(), Some(active) if active.run_id == run_id) {
            *slot = None;
        }
    }

    /// The id of the active run, if any.
    pub fn active(&self) -> Option<RunId> {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.run_id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn desc() -> RunDescriptor {
        RunDescriptor {
            job_id: ulid::Ulid::new().to_string(),
            pair_ids: Vec::new(),
        }
    }

    /// At most one run holds the slot: a second `try_start` is `Busy` until the
    /// first one finishes.
    #[test]
    fn single_run_at_a_time() {
        let reg = RunRegistry::new();
        let h1 = reg.try_start(desc()).expect("first start should win");

        match reg.try_start(desc()) {
            Err(RunError::Busy { run_id }) => assert_eq!(run_id, h1.run_id),
            Ok(_) => panic!("second start must be rejected while one is active"),
        }

        reg.finish(&h1.run_id);
        // Slot is free again.
        let h2 = reg
            .try_start(desc())
            .expect("start after finish should win");
        assert_ne!(h1.run_id, h2.run_id);
    }

    /// `finish` releases the slot.
    #[test]
    fn finish_releases_slot() {
        let reg = RunRegistry::new();
        let h = reg.try_start(desc()).unwrap();
        assert_eq!(reg.active().as_deref(), Some(h.run_id.as_str()));
        reg.finish(&h.run_id);
        assert!(reg.active().is_none());
        // And a fresh run can start.
        assert!(reg.try_start(desc()).is_ok());
    }

    /// Cancelling a different (here: stale/unknown) run id must NOT flip the
    /// active run's token. Cancel is strictly per-run, never global.
    #[test]
    fn cancel_is_per_run_not_global() {
        let reg = RunRegistry::new();
        let h = reg.try_start(desc()).unwrap();

        let other_id = ulid::Ulid::new().to_string();
        assert_ne!(other_id, h.run_id);
        let flipped = reg.cancel(&other_id);

        assert!(!flipped, "cancel of a non-active id must report no-op");
        assert!(
            !h.is_cancelled(),
            "the active run's token must NOT be flipped by cancelling another id"
        );

        // Cancelling the right id does flip it.
        assert!(reg.cancel(&h.run_id));
        assert!(h.is_cancelled());
    }

    /// Cancelling an id that no run holds is a silent no-op.
    #[test]
    fn cancel_unknown_run_is_noop() {
        let reg = RunRegistry::new();
        // No active run at all.
        assert!(!reg.cancel("01ARZ3NDEKTSV4RRFFQ69G5FAV"));

        // With an active run, an unrelated id is still a no-op.
        let h = reg.try_start(desc()).unwrap();
        assert!(!reg.cancel("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
        assert!(!h.is_cancelled());
    }

    /// Many threads race to start; exactly one wins the slot, the rest see Busy.
    #[test]
    fn concurrent_try_start_exactly_one_wins() {
        use std::sync::Barrier;

        let reg = Arc::new(RunRegistry::new());
        let n = 16;
        let barrier = Arc::new(Barrier::new(n));
        let wins = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let mut handles = Vec::new();
        for _ in 0..n {
            let reg = reg.clone();
            let barrier = barrier.clone();
            let wins = wins.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                match reg.try_start(desc()) {
                    Ok(_h) => {
                        wins.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(RunError::Busy { .. }) => {}
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(
            wins.load(Ordering::Relaxed),
            1,
            "exactly one thread may claim the single run slot"
        );
        // The winner never called finish (handle dropped), so the slot is still
        // held by exactly one run.
        assert!(reg.active().is_some());
    }

    /// A long apply loop observes a mid-flight cancel via the per-run flag,
    /// breaks at the next item boundary, and leaves a safely-partial result.
    #[test]
    fn cancel_observed_by_apply_loop() {
        let reg = Arc::new(RunRegistry::new());
        let h = reg.try_start(desc()).unwrap();
        let run_id = h.run_id.clone();

        // The worker sees only an Arc<AtomicBool>, exactly like the apply loop
        // inside engine::execute / apply_plan reads its &AtomicBool.
        let cancel = h.cancel_token();

        let processed = thread::scope(|scope| {
            // Background canceller: flip this run's token partway through, from
            // "another part of the system" (the cancel_run command path).
            let worker = scope.spawn(move || {
                let total = 1000usize;
                let mut done = 0usize;
                for i in 0..total {
                    if cancel.load(Ordering::Relaxed) {
                        break; // cancel observed: stop applying, leave partial.
                    }
                    done += 1;
                    if i == 100 {
                        reg.cancel(&run_id); // flips THIS run's token only
                    }
                }
                done
            });
            worker.join().unwrap()
        });

        assert!(
            processed < 1000,
            "apply loop must break early on cancel (processed {processed})"
        );
        assert!(
            processed >= 100,
            "loop should have made progress before the cancel landed"
        );
        assert!(h.is_cancelled(), "run token stays flipped after cancel");
    }
}
