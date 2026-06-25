/* One row in the jobs list: color swatch, name, enabled-pair count, and an
 * aggregated baseline-status badge (Corrupt > FirstSync > Present across the
 * job's enabled pairs). Clicking navigates to the job detail. Baseline color
 * comes from meaning.ts (BASELINE_MEANING) — no hardcoded hex. */

import type { Job } from "../../ipc/bindings";
import { BASELINE_MEANING } from "../../domain/meaning";
import { useJobBaselineStatus } from "../../ipc/queries";
import { StatusDot } from "../primitives/StatusDot";
import s from "./job.module.css";

interface Props {
  job: Job;
  onOpen: (jobId: string) => void;
}

export function JobRow({ job, onOpen }: Props) {
  const { status } = useJobBaselineStatus(job);
  const enabledCount = job.pairs.filter((p) => p.enabled).length;
  const meaning = status ? BASELINE_MEANING[status] : undefined;

  return (
    <button
      type="button"
      className={s.row}
      onClick={() => onOpen(job.id)}
      data-job-id={job.id}
    >
      <span
        className={s.rowSwatch}
        style={job.color ? { background: job.color } : undefined}
        aria-hidden
      />
      <span className={s.rowMain}>
        <span className={s.rowName}>{job.name || "Untitled job"}</span>
        <span className={s.rowMeta}>
          <span>
            {enabledCount} {enabledCount === 1 ? "pair" : "pairs"}
            {enabledCount !== job.pairs.length ? ` of ${job.pairs.length}` : ""}
          </span>
          {meaning && (
            <span className={s.rowBaseline} style={{ color: `var(${meaning.fg})` }}>
              <StatusDot color={meaning.fg} />
              {meaning.label}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
