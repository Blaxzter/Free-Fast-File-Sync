//! Background cron scheduler: fires each job's `automation.schedule` at its cron
//! time by routing through [`crate::auto_run_job`] — the SAME guarded pipeline as a
//! manual run, so delete-suppression, the big-delete gate, and baseline-trust all
//! apply. One background task polls the job store; a `Notify` lets
//! `set_schedule`/`pause_schedule`/the master switch wake it immediately.
//!
//! Robust by construction: firing is decided from WALL-CLOCK time over the window
//! since the last check (see [`evaluate`]), so a missed window (laptop suspend,
//! clock jump) fires ONCE on catch-up rather than being lost or replayed N times.
//! Runs are serialized by the single-slot `RunRegistry`; a schedule that collides
//! with an in-flight run is skipped for that occurrence (never queued) — the next
//! poll re-evaluates.

use crate::job::ScheduleConfig;
use crate::timeutil::now_unix;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

/// How often the loop re-evaluates when idle — also the worst-case firing latency
/// and the suspend catch-up granularity. Cron is minute-grained, so 30s is snappy
/// without waking the process needlessly often.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Shared control surface for the scheduler loop, held in `AppState`.
pub struct Scheduler {
    enabled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Scheduler {
    pub fn new(enabled: bool) -> Self {
        Scheduler {
            enabled: Arc::new(AtomicBool::new(enabled)),
            notify: Arc::new(Notify::new()),
        }
    }

    /// Flip the master switch and wake the loop so it applies immediately.
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
        self.poke();
    }

    /// Wake the loop to re-read schedules now (call after any schedule change).
    pub fn poke(&self) {
        self.notify.notify_one();
    }

    /// Spawn the background loop. Call once, AFTER `AppState` is managed — the loop
    /// reads jobs + settings out of managed state each tick.
    pub fn spawn_loop(&self, app: AppHandle) {
        tauri::async_runtime::spawn(run_loop(app, self.enabled.clone(), self.notify.clone()));
    }
}

async fn run_loop(app: AppHandle, enabled: Arc<AtomicBool>, notify: Arc<Notify>) {
    // Anchor the window at "now" so launch never fires a pile of past-due
    // occurrences — a schedule fires on its next real cron tick, not retroactively.
    let mut last_tick = now_unix();
    tracing::info!("scheduler loop started");
    loop {
        // Wait up to POLL_INTERVAL, but wake early on a poke (schedule change /
        // master-switch flip). `timeout` returning Err just means "no poke — the
        // full interval elapsed", which is the normal periodic re-evaluation.
        let _ = tokio::time::timeout(POLL_INTERVAL, notify.notified()).await;

        if !enabled.load(Ordering::Relaxed) {
            // Paused: keep the window fresh so re-enabling doesn't fire everything
            // missed while paused.
            last_tick = now_unix();
            continue;
        }

        let schedules = collect_schedules(&app);
        let now = now_unix();
        let (due, _earliest) = evaluate(&schedules, last_tick, now);
        last_tick = now;

        for i in due {
            let (job_id, cfg) = &schedules[i];
            tracing::info!(job = %job_id, cron = %cfg.cron, "scheduler firing job");
            // Serialized by the single-slot registry; a busy slot skips this
            // occurrence (logged inside auto_run_job), never queues it.
            crate::auto_run_job(app.clone(), job_id.clone(), cfg.clone()).await;
        }
    }
}

/// Read every job's enabled schedule out of the store. Cheap (a handful of small
/// JSON files); re-read each tick so edits are picked up without shared mutable
/// schedule state.
fn collect_schedules(app: &AppHandle) -> Vec<(String, ScheduleConfig)> {
    let state = app.state::<crate::AppState>();
    state
        .store
        .list()
        .into_iter()
        .filter_map(|job| {
            let sched = job.automation?.schedule?;
            sched.enabled.then_some((job.id, sched))
        })
        .collect()
}

/// Pure scheduling decision (unit-testable): over the window `(last_tick, now]`,
/// return the indices of schedules whose fire landed in it (to run now) and the
/// earliest upcoming fire strictly after `now`. A disabled or unparseable schedule
/// is skipped. Each due schedule appears AT MOST ONCE, so a long missed window
/// fires a single catch-up, never a storm.
fn evaluate(
    schedules: &[(String, ScheduleConfig)],
    last_tick: i64,
    now: i64,
) -> (Vec<usize>, Option<i64>) {
    let mut due = Vec::new();
    let mut earliest: Option<i64> = None;
    for (i, (_id, cfg)) in schedules.iter().enumerate() {
        if !cfg.enabled {
            continue;
        }
        let off = cfg.tz_offset_minutes.unwrap_or(0);
        let cron = match crate::cron::Cron::parse(&cfg.cron) {
            Ok(c) => c,
            Err(_) => continue,
        };
        match cron.next_after(last_tick, off) {
            Some(fire) if fire <= now => {
                due.push(i);
                // Its NEXT fire (after `now`) feeds the idle-sleep sizing.
                if let Some(nf) = cron.next_after(now, off) {
                    earliest = Some(earliest.map_or(nf, |e| e.min(nf)));
                }
            }
            Some(fire) => earliest = Some(earliest.map_or(fire, |e| e.min(fire))),
            None => {}
        }
    }
    (due, earliest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::SchedulePolicy;

    /// 2026-01-01T00:00:00Z, matching the `cron`/`timeutil` fixtures.
    const JAN1: i64 = 1_767_225_600;

    fn sched(cron: &str) -> (String, ScheduleConfig) {
        (
            "job".into(),
            ScheduleConfig {
                enabled: true,
                cron: cron.into(),
                tz_offset_minutes: Some(0),
                policy: SchedulePolicy::ApplyAll,
                skip_if_watched: false,
            },
        )
    }

    #[test]
    fn fires_when_the_minute_passed_in_window() {
        let s = vec![sched("0 2 * * *")]; // daily 02:00
        let last = JAN1 + 2 * 3600 - 30; // 01:59:30
        let now = JAN1 + 2 * 3600 + 5; // 02:00:05
        let (due, _) = evaluate(&s, last, now);
        assert_eq!(due, vec![0]);
    }

    #[test]
    fn not_due_before_the_minute_and_reports_earliest() {
        let s = vec![sched("0 2 * * *")];
        let last = JAN1 + 3600; // 01:00
        let now = JAN1 + 3600 + 30; // 01:00:30
        let (due, earliest) = evaluate(&s, last, now);
        assert!(due.is_empty());
        assert_eq!(earliest, Some(JAN1 + 2 * 3600), "today's 02:00");
    }

    #[test]
    fn disabled_schedule_never_fires() {
        let mut s = vec![sched("* * * * *")];
        s[0].1.enabled = false;
        let (due, earliest) = evaluate(&s, JAN1, JAN1 + 120);
        assert!(due.is_empty());
        assert!(earliest.is_none());
    }

    #[test]
    fn bad_cron_is_skipped_not_fatal() {
        let s = vec![sched("nonsense"), sched("* * * * *")];
        let (due, _) = evaluate(&s, JAN1, JAN1 + 120);
        assert_eq!(
            due,
            vec![1],
            "the unparseable schedule is skipped, not fatal"
        );
    }

    #[test]
    fn long_gap_fires_a_single_catch_up_not_a_storm() {
        // every-minute schedule, 8h suspend gap: fires ONCE, not 480 times.
        let s = vec![sched("* * * * *")];
        let (due, _) = evaluate(&s, JAN1, JAN1 + 8 * 3600);
        assert_eq!(due, vec![0]);
    }

    #[test]
    fn multiple_due_schedules_all_fire() {
        let s = vec![sched("0 2 * * *"), sched("* * * * *")];
        let last = JAN1 + 2 * 3600 - 30;
        let now = JAN1 + 2 * 3600 + 5;
        let (due, _) = evaluate(&s, last, now);
        assert_eq!(due, vec![0, 1]);
    }
}
