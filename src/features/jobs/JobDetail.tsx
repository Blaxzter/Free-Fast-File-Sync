/* JobDetail (route /jobs/$jobId): the multi-pair Compare/Run view (S9).
 *
 * Drives the single multi-pair run surface: previewJob -> per-pair PlanGrid (via
 * PairSection), collect resolutions as Record<pairId, Record<path, Resolution>>,
 * executeJob, cancelRun. invoke/listen stay confined to ipc/*; colors stay in
 * meaning.ts. The live run strip reads the run-aware store (active run only).
 *
 * Apply is blocked until EVERY conflict across ALL pairs is resolved AND every
 * pair whose plan tripped the big-delete guard is confirmed. */

import { useMemo, useState } from "react";
import { Play, Check, X } from "lucide-react";
import type {
  PairPreview,
  PreviewJobResult,
  Resolution,
} from "../../ipc/bindings";
import type { PlanSummary } from "../../domain/plan";
import {
  defaultResolutions,
  unresolvedConflicts,
} from "../../domain/plan";
import type { Job } from "../../domain/job";
import {
  directionMode,
  effectiveDeletion,
  effectiveDirection,
} from "../../domain/job";
import { useJob } from "../../ipc/queries";
import {
  cancelRun as cancelRunCmd,
  useExecuteJob,
  usePreviewJob,
} from "../../ipc/mutations";
import { useStore } from "../../app/store";
import { Button } from "../../components/primitives/Button";
import { Banner } from "../../components/primitives/Banner";
import { SummaryChips } from "../../components/plan/SummaryChips";
import { PairSection } from "../../components/run/PairSection";
import { RunReport } from "../../components/run/RunReport";
import compare from "./compare.module.css";
import run from "../../components/run/run.module.css";

const EMPTY_SUMMARY: PlanSummary = {
  total: 0,
  copy_a_to_b: 0,
  copy_b_to_a: 0,
  delete_a: 0,
  delete_b: 0,
  conflicts: 0,
  baseline_only: 0,
  noop: 0,
  skipped: 0,
};

/** Sum every pair's PlanSummary into one aggregate for the top chips. */
function aggregateSummary(pairs: PairPreview[]): PlanSummary {
  return pairs.reduce<PlanSummary>((acc, p) => {
    const s = p.plan.summary;
    return {
      total: acc.total + s.total,
      copy_a_to_b: acc.copy_a_to_b + s.copy_a_to_b,
      copy_b_to_a: acc.copy_b_to_a + s.copy_b_to_a,
      delete_a: acc.delete_a + s.delete_a,
      delete_b: acc.delete_b + s.delete_b,
      conflicts: acc.conflicts + s.conflicts,
      baseline_only: acc.baseline_only + s.baseline_only,
      noop: acc.noop + s.noop,
      skipped: acc.skipped + s.skipped,
    };
  }, { ...EMPTY_SUMMARY });
}

/** Build the initial resolution map for every pair, prefilling each conflict
 * from its default_resolution (Record<pairId, Record<path, Resolution>>). */
function seedResolutions(pairs: PairPreview[]): Record<string, Record<string, Resolution>> {
  const out: Record<string, Record<string, Resolution>> = {};
  for (const p of pairs) out[p.pair_id] = defaultResolutions(p.plan);
  return out;
}

export function JobDetail({ jobId }: { jobId: string }) {
  const { data: job, isLoading } = useJob(jobId);
  const preview = usePreviewJob();
  const execute = useExecuteJob();

  const [result, setResult] = useState<PreviewJobResult | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Record<string, Resolution>>>({});
  const [bigDeleteConfirmed, setBigDeleteConfirmed] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showInSync, setShowInSync] = useState(false);

  // Live run mirror (active run only; foreign-run events are dropped upstream).
  const runId = useStore((st) => st.activeRunId);
  const runMirror = useStore((st) => (st.activeRunId ? st.runs[st.activeRunId] : undefined));
  const phase = runMirror?.phase ?? "idle";

  const pairs = result?.pairs ?? [];

  // Per-pair header metadata (engine-axis mode + deletion) resolved from the Job.
  const pairMeta = useMemo(() => {
    const map: Record<string, { mode: ReturnType<typeof directionMode>; deletion: "RecycleBin" | "Permanent"; label: string }> = {};
    if (!job) return map;
    for (const fp of job.pairs) {
      map[fp.id] = {
        mode: directionMode(effectiveDirection(job as Job, fp)),
        deletion: effectiveDeletion(job as Job, fp).kind,
        label: fp.label,
      };
    }
    return map;
  }, [job]);

  const summary = useMemo(() => aggregateSummary(pairs), [pairs]);

  // Apply gating: no unresolved conflicts anywhere, and every tripped
  // big-delete pair confirmed.
  const totalUnresolved = useMemo(
    () =>
      pairs.reduce(
        (n, p) => n + unresolvedConflicts(p.plan, resolutions[p.pair_id] ?? {}),
        0,
      ),
    [pairs, resolutions],
  );
  const unconfirmedBigDelete = useMemo(
    () => pairs.filter((p) => p.plan.big_delete && !bigDeleteConfirmed[p.pair_id]),
    [pairs, bigDeleteConfirmed],
  );

  const applicable = summary.total - summary.noop;
  const canApply =
    pairs.length > 0 &&
    applicable > 0 &&
    totalUnresolved === 0 &&
    unconfirmedBigDelete.length === 0 &&
    phase === "idle" &&
    !execute.isPending;

  const isBusy = phase !== "idle" || preview.isPending || execute.isPending;

  const onPreview = async () => {
    const res = await preview.mutateAsync({ jobId });
    setResult(res);
    setResolutions(seedResolutions(res.pairs));
    setBigDeleteConfirmed({});
    setCollapsed({});
  };

  const onApply = async () => {
    if (!runId) return;
    try {
      await execute.mutateAsync({
        runId,
        resolutions,
        confirmBigDelete: bigDeleteConfirmed,
      });
    } catch {
      // Apply failed or was cancelled (RunError::Cancelled). The mutation moves
      // to its error state and the run mirror is returned to idle by
      // run://finished; swallow so a cancel doesn't surface as an unhandled
      // rejection.
    }
  };

  const onCancel = () => {
    if (runId) void cancelRunCmd(runId);
  };

  const resolveIn = (pairId: string, path: string, r: Resolution) =>
    setResolutions((prev) => ({
      ...prev,
      [pairId]: { ...(prev[pairId] ?? {}), [path]: r },
    }));

  const reports = useMemo(() => {
    const map: Record<string, NonNullable<typeof execute.data>["pairs"][number]["report"]> = {};
    for (const pr of execute.data?.pairs ?? []) map[pr.pair_id] = pr.report;
    return map;
  }, [execute.data]);

  if (isLoading) {
    return <div className={compare.workspace}>Loading…</div>;
  }

  return (
    <div className={compare.workspace}>
      <div className={compare.header}>
        <div className={compare.headerTop}>
          <span className={compare.headerTitle}>{job?.name ?? "Job"}</span>
          <div className={compare.headerActions}>
            <Button
              variant="secondary"
              icon={<Play size={14} />}
              onClick={() => void onPreview()}
              disabled={isBusy}
            >
              {preview.isPending ? "Comparing…" : "Compare"}
            </Button>
            <Button
              variant="go"
              icon={<Check size={14} />}
              onClick={() => void onApply()}
              disabled={!canApply}
            >
              Apply{applicable > 0 ? ` (${applicable})` : ""}
            </Button>
            <Button
              variant="danger"
              icon={<X size={14} />}
              onClick={onCancel}
              disabled={!isBusy || !runId}
            >
              Cancel
            </Button>
          </div>
        </div>

        {pairs.length > 0 && (
          <SummaryChips
            summary={summary}
            conflictsBlock={totalUnresolved}
            showInSync={showInSync}
            onShowInSync={setShowInSync}
          />
        )}
      </div>

      {phase === "applying" && runMirror?.progress && (
        <div className={run.runStrip} role="status" aria-label="run progress">
          <span>
            Applying pair {runMirror.activePairIndex + 1}/{runMirror.pairCount || 1}
          </span>
          <div className={run.runStripTrack}>
            <div
              className={run.runStripFill}
              style={{
                width: `${
                  runMirror.progress.total
                    ? (runMirror.progress.done / runMirror.progress.total) * 100
                    : 0
                }%`,
              }}
            />
          </div>
          <span className={run.runStripMono}>{runMirror.progress.path}</span>
        </div>
      )}

      {unconfirmedBigDelete.length > 0 && (
        <Banner intent="warn">
          {unconfirmedBigDelete.length} pair(s) tripped the large-deletion guard —
          confirm each below before applying.
        </Banner>
      )}

      {pairs.length === 0 && !preview.isPending && (
        <Banner intent="info">
          Press Compare to scan this job&apos;s folder pairs and preview the changes.
        </Banner>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
        {pairs.map((p) => {
          const meta = pairMeta[p.pair_id];
          const rep = reports[p.pair_id];
          return (
            <div key={p.pair_id} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              <PairSection
                pair={p}
                pairId={p.pair_id}
                label={meta?.label}
                mode={meta?.mode}
                deletion={meta?.deletion}
                collapsed={collapsed[p.pair_id] ?? false}
                onToggle={() =>
                  setCollapsed((prev) => ({ ...prev, [p.pair_id]: !(prev[p.pair_id] ?? false) }))
                }
                showInSync={showInSync}
                resolutions={resolutions[p.pair_id] ?? {}}
                onResolve={(path, r) => resolveIn(p.pair_id, path, r)}
                bigDeleteConfirmed={bigDeleteConfirmed[p.pair_id] ?? false}
                onConfirmBigDelete={(v) =>
                  setBigDeleteConfirmed((prev) => ({ ...prev, [p.pair_id]: v }))
                }
              />
              {rep && <RunReport report={rep} />}
            </div>
          );
        })}
      </div>

    </div>
  );
}
