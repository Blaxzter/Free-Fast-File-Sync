/* Activity: run history, newest first, read from the append-only run log
 * (list_activity). Each finished preview/execute run is one row; clicking a row
 * expands its per-pair scan/plan breakdown. Read-only — this screen never mutates
 * the log or triggers runs. Status color comes ONLY from meaning.ts
 * (RUN_STATUS_MEANING), keyed by the derived RunStatus. */

import { Activity as ActivityIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "../../components/primitives/EmptyState";
import { StatusDot } from "../../components/primitives/StatusDot";
import {
  formatDuration,
  formatRunTimestamp,
  isApply,
  phaseLabel,
  runStatus,
  runTotals,
} from "../../domain/activity";
import { RUN_STATUS_MEANING } from "../../domain/meaning";
import type { RunLog } from "../../ipc/bindings";
import { useActivity, useJobs } from "../../ipc/queries";
import s from "./activity.module.css";

export function ActivityFeed() {
  const { data: runs, isLoading } = useActivity();
  const { data: jobs } = useJobs();

  const jobNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of jobs ?? []) m.set(j.id, j.name);
    return m;
  }, [jobs]);

  if (!isLoading && (!runs || runs.length === 0)) {
    return (
      <EmptyState
        icon={<ActivityIcon size={28} />}
        title="No runs yet"
        subline="Preview or sync a job and it shows up here. Activity is the durable history of every run — what it scanned, how long it took, and whether it succeeded."
      />
    );
  }

  return (
    <div className={s.list}>
      <div className={s.listHeader}>
        <h1 className={s.listTitle}>Activity</h1>
        {runs && runs.length > 0 && (
          <span className={s.count}>
            {runs.length.toLocaleString()} recent run{runs.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className={s.rows}>
        {(runs ?? []).map((run) => (
          <ActivityRow key={run.run_id} run={run} jobName={jobNames.get(run.job_id)} />
        ))}
      </div>
    </div>
  );
}

function ActivityRow({ run, jobName }: { run: RunLog; jobName: string | undefined }) {
  const [open, setOpen] = useState(false);
  const status = runStatus(run);
  const m = RUN_STATUS_MEANING[status];
  const totals = runTotals(run);
  const apply = isApply(run);

  return (
    <div className={s.run} data-status={status}>
      <button
        type="button"
        className={s.runHeader}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <StatusDot color={m.fg} title={m.label} />
        <span className={s.phase} data-apply={apply}>
          {phaseLabel(run.phase)}
        </span>
        <span className={s.name} title={jobName ?? run.job_id}>
          {jobName ?? shortId(run.job_id)}
        </span>
        <span className={s.trigger}>{run.trigger}</span>
        <span className={s.spacer} />
        <span className={s.meta}>{formatRunTimestamp(run.started)}</span>
        <span className={s.dot}>·</span>
        <span className={s.meta}>{formatDuration(run.ms)}</span>
        <span className={s.dot}>·</span>
        <span className={s.meta}>
          {run.pair_count} pair{run.pair_count === 1 ? "" : "s"}
        </span>
        {totals.errors > 0 && (
          <span className={s.errors} title="scan/stat errors — deletions were suppressed">
            {totals.errors.toLocaleString()} err
          </span>
        )}
      </button>

      {run.error && <div className={s.errorLine}>{run.error}</div>}

      {open && (
        <div className={s.detail}>
          <div className={s.summaryRow}>
            <Stat label="scanned" value={totals.scanned} />
            <Stat label="entries" value={totals.entries} />
            <Stat label="skipped" value={totals.skipped} />
            <Stat label="errors" value={totals.errors} danger={totals.errors > 0} />
          </div>
          <table className={s.pairs}>
            <thead>
              <tr>
                <th>pair</th>
                <th>A</th>
                <th>B</th>
                <th>errors</th>
                <th>skipped</th>
                <th>threads</th>
                <th>ms</th>
              </tr>
            </thead>
            <tbody>
              {run.pairs.map((p) => (
                <tr key={p.pair_id} data-ok={p.ok}>
                  <td className={s.pairId} title={p.pair_id}>
                    {shortId(p.pair_id)}
                  </td>
                  <td>{p.entries_a.toLocaleString()}</td>
                  <td>{p.entries_b.toLocaleString()}</td>
                  <td data-danger={p.errors_a + p.errors_b > 0}>
                    {(p.errors_a + p.errors_b).toLocaleString()}
                  </td>
                  <td>{(p.skipped_a + p.skipped_b).toLocaleString()}</td>
                  <td>{p.threads}</td>
                  <td>{p.ms.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <span className={s.stat}>
      <b style={danger ? { color: "var(--danger-fg)" } : undefined}>{value.toLocaleString()}</b>{" "}
      {label}
    </span>
  );
}

/** A ULID is 26 chars; show a short, stable tail so long ids don't blow the row
 * width while staying recognizable (full value is in the title tooltip). */
function shortId(id: string): string {
  return id.length > 10 ? `…${id.slice(-8)}` : id;
}
