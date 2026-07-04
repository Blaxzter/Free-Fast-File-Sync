/* Pure helpers over the run-history records (runlog.rs RunLog) surfaced by the
 * Activity feed. No React, no IPC — just derivations the feed and its tests share.
 * Colors for a RunStatus live in domain/meaning.ts (RUN_STATUS_MEANING), keyed by
 * the RunStatus derived here. */

import type { RunLog } from "../ipc/bindings";

/** The tri-state outcome of a run, derived from the log record. A failure takes
 * precedence over a cancel (an errored run that was also cancelled reads as
 * failed) — matching runlog.rs `finish`, where `ok = error.is_none() && !cancelled`. */
export type RunStatus = "ok" | "failed" | "cancelled";

export function runStatus(run: RunLog): RunStatus {
  if (run.error) return "failed";
  if (run.cancelled) return "cancelled";
  return "ok";
}

/** Human label for a run's phase. The backend writes "preview"/"execute"; the UI
 * says "Preview"/"Sync". Anything else is title-cased as a fallback. */
export function phaseLabel(phase: string): string {
  if (phase === "preview") return "Preview";
  if (phase === "execute") return "Sync";
  return phase ? phase[0]!.toUpperCase() + phase.slice(1) : phase;
}

/** Whether a run changed anything on disk (a Sync run). Previews never write. */
export function isApply(run: RunLog): boolean {
  return run.phase === "execute";
}

/** Aggregate per-pair counters into run-level totals for the summary chips. */
export interface RunTotals {
  entries: number;
  errors: number;
  skipped: number;
  scanned: number;
}

export function runTotals(run: RunLog): RunTotals {
  return run.pairs.reduce<RunTotals>(
    (acc, p) => {
      acc.entries += p.entries_a + p.entries_b;
      acc.errors += p.errors_a + p.errors_b;
      acc.skipped += p.skipped_a + p.skipped_b;
      acc.scanned += p.scanned;
      return acc;
    },
    { entries: 0, errors: 0, skipped: 0, scanned: 0 },
  );
}

/** Compact human duration for a run's wall-clock milliseconds. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${m}m ${sec}s`;
}

/** Local, human timestamp for an RFC3339 string. Falls back to the raw value if
 * it isn't a parseable date (a corrupt record must never crash the feed). */
export function formatRunTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}
