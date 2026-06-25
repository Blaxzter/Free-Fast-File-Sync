import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { JobConfig, Resolution, SyncPlan } from "../../domain/plan";
import {
  actionableCount,
  applicableCount,
  defaultResolutions,
  unresolvedConflicts,
  visibleItems,
} from "../../domain/plan";
import { defaultJobConfig } from "../../domain/job";
import { errorMessage } from "../../ipc/errors";
import { useBaselineStatus } from "../../ipc/queries";
import { useApply, usePreview } from "../../ipc/mutations";
import { cancelSync } from "../../ipc/commands";
import { useStore } from "../../app/store";
import { Button } from "../../components/primitives/Button";
import { Toggle } from "../../components/primitives/Toggle";
import { Banner } from "../../components/primitives/Banner";
import { EmptyState } from "../../components/primitives/EmptyState";
import { SummaryChips } from "../../components/plan/SummaryChips";
import { BaselineBadge } from "../../components/plan/BaselineBadge";
import { BigDeleteGate } from "../../components/plan/BigDeleteGate";
import { PlanGrid } from "../../components/plan/PlanGrid";
import { RunReport } from "../../components/run/RunReport";
import { FolderPicker } from "./FolderPicker";
import s from "./compare.module.css";

/** Single-pair Compare Workspace wired end-to-end to the real engine:
 * pick roots -> Preview (preview_sync) -> dense grid -> Apply (execute_sync). */
export function CompareWorkspace() {
  const [cfg, setCfg] = useState<JobConfig>(defaultJobConfig);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [confirmBigDelete, setConfirmBigDelete] = useState(false);
  const [showInSync, setShowInSync] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phase = useStore((st) => st.run.phase);
  const report = useStore((st) => st.run.report);
  const resetRun = useStore((st) => st.resetRun);

  const baseline = useBaselineStatus(cfg);
  const preview = usePreview();
  const apply = useApply();

  const ready = Boolean(cfg.root_a && cfg.root_b && cfg.root_a !== cfg.root_b);

  function setRoot(side: "root_a" | "root_b", path: string) {
    setCfg((c) => ({ ...c, [side]: path }));
    setPlan(null);
    resetRun();
  }

  const rows = useMemo(
    () => (plan ? visibleItems(plan, showInSync) : []),
    [plan, showInSync],
  );

  const unresolved = plan ? unresolvedConflicts(plan, resolutions) : 0;
  // `actionable` (IO ops) labels the button; `applicable` (incl. baseline-only
  // convergences) gates it so a baseline-only plan can still advance.
  const actionable = plan ? actionableCount(plan) : 0;
  const applicable = plan ? applicableCount(plan) : 0;
  const bigDeleteBlocked = Boolean(plan?.big_delete) && !confirmBigDelete;
  const applyDisabled =
    !plan ||
    applicable === 0 ||
    unresolved > 0 ||
    bigDeleteBlocked ||
    phase !== "idle";

  async function doPreview() {
    setError(null);
    resetRun();
    try {
      const p = await preview.mutateAsync(cfg);
      setPlan(p);
      setResolutions(defaultResolutions(p));
      setConfirmBigDelete(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function doApply() {
    if (!plan) return;
    setError(null);
    try {
      await apply.mutateAsync({ cfg, resolutions, confirmBigDelete });
      // Re-preview to show converged state.
      const p = await preview.mutateAsync(cfg);
      setPlan(p);
      setResolutions(defaultResolutions(p));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className={s.workspace}>
      <div className={s.header}>
        <div className={s.headerTop}>
          <span className={s.headerTitle}>Compare</span>
          <div className={s.headerChips}>
            <span className={s.modeChip}>two-way ↔</span>
            <span className={s.modeChip}>gitignore</span>
            <span className={s.modeChip}>{cfg.use_recycle_bin ? "recycle-bin" : "permanent"}</span>
          </div>
          <div className={s.headerActions}>
            {baseline.data && <BaselineBadge status={baseline.data} />}
            <Button
              variant="secondary"
              icon={<RefreshCw size={14} />}
              disabled={!ready || phase !== "idle"}
              onClick={doPreview}
            >
              {phase === "scanning" ? "Scanning…" : "Preview ⌘P"}
            </Button>
            <Button variant="go" disabled={applyDisabled} onClick={doApply}>
              {phase === "applying" ? "Applying…" : `Apply${actionable ? ` (${actionable})` : ""}`}
            </Button>
            {phase === "applying" && (
              <Button variant="ghost" onClick={() => cancelSync()}>
                Cancel
              </Button>
            )}
          </div>
        </div>

        <div className={s.roots}>
          <FolderPicker
            label="Folder A"
            side="a"
            value={cfg.root_a}
            onPick={(p) => setRoot("root_a", p)}
          />
          <span className={s.swap}>⇄</span>
          <FolderPicker
            label="Folder B"
            side="b"
            value={cfg.root_b}
            onPick={(p) => setRoot("root_b", p)}
          />
        </div>

        <div className={s.options}>
          <div className={s.optGroup}>
            <span className={s.optLegend}>Filters</span>
            <Toggle
              label="Respect .gitignore"
              checked={cfg.ignore.use_gitignore}
              onChange={(v) =>
                setCfg((c) => ({ ...c, ignore: { ...c.ignore, use_gitignore: v } }))
              }
            />
            <Toggle
              label="Respect .ignore files"
              checked={cfg.ignore.use_dot_ignore}
              onChange={(v) =>
                setCfg((c) => ({ ...c, ignore: { ...c.ignore, use_dot_ignore: v } }))
              }
            />
            <Toggle
              label="Include hidden / dotfiles"
              checked={cfg.ignore.include_hidden}
              onChange={(v) =>
                setCfg((c) => ({ ...c, ignore: { ...c.ignore, include_hidden: v } }))
              }
            />
          </div>
          <div className={s.optGroup}>
            <span className={s.optLegend}>Safety</span>
            <Toggle
              label="Deletions go to Recycle Bin"
              checked={cfg.use_recycle_bin}
              onChange={(v) => setCfg((c) => ({ ...c, use_recycle_bin: v }))}
            />
            <Toggle
              label="Verify by content hash (safest)"
              checked={cfg.verify_by_hash}
              onChange={(v) => setCfg((c) => ({ ...c, verify_by_hash: v }))}
            />
          </div>
        </div>
      </div>

      {error && <Banner intent="danger">{error}</Banner>}

      {plan?.baseline_status === "Corrupt" && (
        <Banner intent="warn">
          Baseline unreadable — this run is union-only, no deletions.
        </Banner>
      )}
      {plan?.baseline_status === "FirstSync" && (
        <Banner intent="info">First sync — union only, nothing will be deleted.</Banner>
      )}

      {plan?.big_delete && (
        <BigDeleteGate
          warning={plan.big_delete}
          confirmed={confirmBigDelete}
          onConfirm={setConfirmBigDelete}
        />
      )}

      {report && <RunReport report={report} />}

      {!plan && !report && (
        <EmptyState
          title={ready ? "Ready to preview" : "Pick two folders to compare"}
          subline={
            ready
              ? "Press Preview (⌘P) to scan both roots against the baseline."
              : "Choose Folder A and Folder B above. They must be different directories."
          }
        />
      )}

      {plan && (
        <>
          <SummaryChips
            summary={plan.summary}
            conflictsBlock={unresolved}
            showInSync={showInSync}
            onShowInSync={setShowInSync}
          />

          {plan.warnings.length > 0 && (
            <details className={s.warnings}>
              <summary>
                {plan.warnings.length} skipped during scan (symlinks, cloud stubs…) — deletions
                suppressed for affected areas
              </summary>
              <ul>
                {plan.warnings.slice(0, 200).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          {actionable === 0 ? (
            <EmptyState title="Everything's in sync" subline="No changes between the two roots." />
          ) : (
            <PlanGrid
              items={rows}
              resolutions={resolutions}
              onResolve={(path, r) =>
                setResolutions((prev) => ({ ...prev, [path]: r }))
              }
            />
          )}
        </>
      )}
    </div>
  );
}
