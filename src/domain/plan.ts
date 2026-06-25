/* Re-exports the engine plan types and pure selectors over a SyncPlan.
 * No React, no IPC. Harvested from the throwaway src/App.tsx (rank, conflict
 * default-resolution prefill, byte formatting). */

import type {
  Action,
  PlanItem,
  Resolution,
  SyncPlan,
} from "../ipc/bindings";

export type {
  Action,
  ApplyReport,
  BaselineStatusKind,
  BigDeleteWarning,
  ChangeKind,
  ConflictType,
  ItemOutcome,
  ItemStatus,
  JobConfig,
  Meta,
  PlanItem,
  PlanSummary,
  Resolution,
  SyncPlan,
} from "../ipc/bindings";

/** Sort rank: conflicts first, then deletes, then copies, noop last. */
export function rank(it: PlanItem): number {
  if (it.action === "Conflict") return 0;
  if (it.action === "DeleteA" || it.action === "DeleteB") return 1;
  if (it.action === "Noop" || it.action === "UpdateBaselineOnly") return 9;
  return 2;
}

/** True for rows that disappear behind the "show in-sync" toggle. */
export function isInSync(it: PlanItem): boolean {
  return it.action === "Noop" || it.action === "UpdateBaselineOnly";
}

/** Visible, sorted rows for the grid given the show-in-sync toggle. */
export function visibleItems(plan: SyncPlan, showInSync: boolean): PlanItem[] {
  return plan.items
    .filter((it) => showInSync || !isInSync(it))
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

/** Build the initial resolution map: prefill each conflict from its default. */
export function defaultResolutions(plan: SyncPlan): Record<string, Resolution> {
  const res: Record<string, Resolution> = {};
  for (const it of plan.items) {
    if (it.action === "Conflict" && it.default_resolution) {
      res[it.path] = it.default_resolution;
    }
  }
  return res;
}

/** Count of conflicts still without a chosen resolution (blocks Apply). */
export function unresolvedConflicts(
  plan: SyncPlan,
  resolutions: Record<string, Resolution>,
): number {
  let n = 0;
  for (const it of plan.items) {
    if (it.action === "Conflict" && !resolutions[it.path]) n++;
  }
  return n;
}

/** Number of items that perform real file IO (copies, deletes, conflicts).
 * Excludes `UpdateBaselineOnly` — those advance the baseline with zero IO — so
 * the `Apply (N)` label reflects actual data movement. */
export function actionableCount(plan: SyncPlan): number {
  return (
    plan.summary.total - plan.summary.noop - plan.summary.baseline_only
  );
}

/** Number of items Apply will touch at all, including zero-IO baseline-only
 * convergences. Gates whether Apply is enabled: a plan with only baseline-only
 * items still needs Apply to advance the baseline, even though it moves no bytes. */
export function applicableCount(plan: SyncPlan): number {
  return plan.summary.total - plan.summary.noop;
}

const ACTION_CLASS: Record<Action, "copy" | "del" | "conflict" | "neutral"> = {
  Noop: "neutral",
  CopyAtoB: "copy",
  CopyBtoA: "copy",
  DeleteA: "del",
  DeleteB: "del",
  UpdateBaselineOnly: "neutral",
  Conflict: "conflict",
};

export function actionClass(a: Action): "copy" | "del" | "conflict" | "neutral" {
  return ACTION_CLASS[a];
}

/** Compact byte formatter for the size column (tabular mono). */
export function formatBytes(n: number): string {
  if (n <= 0) return "—";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const s = v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1);
  return `${s} ${units[i]}`;
}
