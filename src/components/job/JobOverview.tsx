/* At-rest job overview shown on the JobDetail page BEFORE Compare, so the job's
 * shape is visible without scanning: a job-level summary (pair count, default
 * direction, compare mode, deletion, filters) plus one card per enabled pair
 * (roots A→B, effective direction, deletion, and per-pair baseline status).
 *
 * Reuses PairSection's card chrome (run.module.css) and the meaning-keyed badges;
 * colours come only from domain/meaning.ts. No scan/preview needed — everything
 * is read from the already-loaded Job plus the per-pair baseline query. */

import {
  DIRECTION_FANOUT,
  directionMode,
  effectiveCompareMode,
  effectiveDeletion,
  effectiveDirection,
  filterSummary,
  localPath,
  rootTail,
} from "../../domain/job";
import { DELETION_MEANING } from "../../domain/meaning";
import type { FolderPair, Job } from "../../ipc/bindings";
import { usePairBaselineStatus } from "../../ipc/queries";
import { BaselineBadge } from "../plan/BaselineBadge";
import run from "../run/run.module.css";
import s from "./jobOverview.module.css";
import { ModeBadge } from "./ModeBadge";

/** ↔ / → / ← for a pair's effective direction (swap-aware). */
function directionArrow(job: Job, pair: FolderPair): string {
  const fan = DIRECTION_FANOUT[effectiveDirection(job, pair)];
  if (fan.mode === "TwoWay") return "↔";
  return fan.swap ? "←" : "→";
}

function DeletionBadge({ kind }: { kind: "RecycleBin" | "Permanent" }) {
  const del = DELETION_MEANING[kind];
  return (
    <span
      className={run.delBadge}
      style={{ color: `var(${del.fg})`, borderColor: `var(${del.border})` }}
      title={del.label}
    >
      {del.glyph} {del.label}
    </span>
  );
}

function PairOverviewRow({ jobId, job, pair }: { jobId: string; job: Job; pair: FolderPair }) {
  const { data: baseline } = usePairBaselineStatus(jobId, pair.id);
  const mode = directionMode(effectiveDirection(job, pair));
  const a = localPath(pair.root_a);
  const b = localPath(pair.root_b);
  return (
    <section className={run.pairSection}>
      <header className={run.pairHeader}>
        <span className={run.pairRoots} title={`${a} ↔ ${b}`}>
          <span className={run.rootName}>{rootTail(a)}</span>
          <span className={run.rootArrow} aria-hidden>
            {directionArrow(job, pair)}
          </span>
          <span className={run.rootName}>{rootTail(b)}</span>
        </span>
        {pair.label && <span className={run.pairLabel}>{pair.label}</span>}
        <div className={run.pairBadges} style={{ marginLeft: "auto" }}>
          <ModeBadge mode={mode} />
          <DeletionBadge kind={effectiveDeletion(job, pair).kind} />
          {baseline && <BaselineBadge status={baseline} />}
        </div>
      </header>
    </section>
  );
}

export function JobOverview({ jobId, job }: { jobId: string; job: Job }) {
  const enabled = job.pairs.filter((p) => p.enabled);
  const disabledCount = job.pairs.length - enabled.length;

  return (
    <div className={s.overview}>
      <div className={s.summary}>
        <span className={s.summaryItem}>
          {enabled.length} pair{enabled.length === 1 ? "" : "s"}
          {disabledCount > 0 ? ` · ${disabledCount} disabled` : ""}
        </span>
        <ModeBadge mode={directionMode(job.settings.direction)} />
        <span className={s.summaryItem}>
          {effectiveCompareMode(job) === "Content" ? "Content hash" : "Time & size"}
        </span>
        <DeletionBadge kind={job.settings.deletion.kind} />
        <span className={s.summaryItem}>{filterSummary(job.settings.filter)}</span>
      </div>

      {enabled.map((p) => (
        <PairOverviewRow key={p.id || p.label} jobId={jobId} job={job} pair={p} />
      ))}
    </div>
  );
}
