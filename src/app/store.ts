/* Zustand store: cross-cutting UI state + a live, run-AWARE engine mirror.
 *
 * S9 generalizes the S7 single-run mirror into `runs: Record<runId, RunMirror>`
 * with per-pair progress + per-pair reports + activePairIndex/pairCount, fed by
 * ONE set of run://* subscribers (subscribeRunEvents). Every view reads the same
 * source. Do NOT put server data here — that is TanStack Query's job.
 *
 * Cross-talk guard: the subscriber DROPS any run://* event whose run_id is not
 * the active run id (the one most recently started, or the one a command set via
 * beginRun). A stale/foreign run can never mutate the live mirror.
 *
 * StatusStrip back-compat: `run` is a live VIEW of the active run (phase +
 * latest progress), so existing consumers keep working unchanged. */

import { create } from "zustand";
import { topSegment } from "../domain/progressTree";
import type {
  ApplyReport,
  Job,
  RunPlanProgress,
  RunProgress,
  RunScanProgress,
  RunScanTree,
  ScanTreeFolder,
} from "../ipc/bindings";
import {
  onRunFinished,
  onRunPairDone,
  onRunPlanProgress,
  onRunProgress,
  onRunScan,
  onRunScanProgress,
  onRunScanTree,
  onRunStarted,
} from "../ipc/events";

export type EnginePhase = "idle" | "scanning" | "applying";

/** Per-pair lifecycle status within a run, keyed by pair_id. Pairs not yet
 * reached are simply absent (the view treats absent as "pending" using the Job's
 * pair order). "aborted" = a pair left mid-flight by cancel or an upstream error
 * (we can't tell which from run://finished alone). */
export type PairRunStatus = "pending" | "scanning" | "applying" | "done" | "aborted";

/** Per-run live mirror: phase, per-pair progress + reports, and where we are in
 * the sequential pair loop. */
export interface RunMirror {
  runId: string;
  jobId: string | null;
  phase: EnginePhase;
  pairCount: number;
  activePairIndex: number;
  /** Live cumulative count of entries recorded during the scan phase. */
  scanned: number;
  /** Live planning-phase progress for the active pair (post-scan disk probes):
   * probes done / total. planTotal > 0 means planning is running (the scan count
   * has stopped); both reset to 0 at each pair's scan start. */
  planDone: number;
  planTotal: number;
  /** Live shallow per-folder scan activity for the pair currently being scanned,
   * replaced wholesale on each run://scan-tree snapshot. Empty when the feature is
   * off or pre-first-tick. */
  scanTree: ScanTreeFolder[];
  /** The pair_id the live scanTree belongs to (for the "which pair" label). */
  scanPairId: string | null;
  /** Per-pair lifecycle status keyed by pair_id (absent => pending). Drives the
   * multi-pair list in ProgressTree. */
  pairStatus: Record<string, PairRunStatus>;
  /** The pair_id currently scanning/applying — the row the view auto-expands to
   * its folder tree. null between pairs and when finished. */
  activePairId: string | null;
  /** Frozen per-pair recap captured at pair-done so collapsed/finished rows keep
   * their numbers (scanned delta + applied count). */
  pairRecap: Record<string, { scanned: number; applied: number }>;
  /** Cumulative `scanned` when the current pair started scanning, to derive that
   * pair's scanned delta on pair-done. */
  scanBaseAtPairStart: number;
  /** Epoch ms when the run started (for elapsed time + throughput). */
  startedAt: number;
  /** Latest progress event per pair_id (per-pair progress strip). */
  progressByPair: Record<string, RunProgress>;
  /** Live count of applied items per top-level folder, per pair_id
   * (pairId -> { topFolder -> count }). Bumped once per run://progress event;
   * feeds the apply-phase folder-activity tree (ProgressTree). */
  doneByFolder: Record<string, Record<string, number>>;
  /** Final apply report per pair_id (filled on pair-done during an apply). */
  reportByPair: Record<string, ApplyReport>;
  /** Most recent progress event for the run (back-compat single-strip view). */
  progress: RunProgress | null;
}

/** The S7-shaped view some components (StatusStrip) still read. Derived from the
 * active run, or idle when there is none. */
export interface RunView {
  phase: EnginePhase;
  runId: string | null;
  progress: RunProgress | null;
  report: ApplyReport | null;
  /** Live scan count + start time of the active run (idle → 0 / null). */
  scanned: number;
  startedAt: number | null;
  /** Live planning-phase probe progress (planTotal > 0 => planning is running). */
  planDone: number;
  planTotal: number;
}

const idleView: RunView = {
  phase: "idle",
  runId: null,
  progress: null,
  report: null,
  scanned: 0,
  startedAt: null,
  planDone: 0,
  planTotal: 0,
};

function newMirror(runId: string, jobId: string | null, pairCount: number): RunMirror {
  return {
    runId,
    jobId,
    phase: "scanning",
    pairCount,
    activePairIndex: 0,
    scanned: 0,
    planDone: 0,
    planTotal: 0,
    scanTree: [],
    scanPairId: null,
    pairStatus: {},
    activePairId: null,
    pairRecap: {},
    scanBaseAtPairStart: 0,
    startedAt: Date.now(),
    progressByPair: {},
    doneByFolder: {},
    reportByPair: {},
    progress: null,
  };
}

/** Project the active run into the legacy single-run view. */
function viewOf(runs: Record<string, RunMirror>, activeRunId: string | null): RunView {
  if (!activeRunId) return idleView;
  const m = runs[activeRunId];
  if (!m) return idleView;
  return {
    phase: m.phase,
    runId: m.runId,
    progress: m.progress,
    report: null,
    scanned: m.scanned,
    startedAt: m.startedAt,
    planDone: m.planDone,
    planTotal: m.planTotal,
  };
}

interface UiState {
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  density: "compact" | "cozy";

  /** A built-but-unsaved Job handed to the editor to prefill from (e.g. an FFS
   * import). The editor consumes it once on mount, then clears it. */
  jobDraft: Job | null;

  /** Every run we have a mirror for, keyed by run id. */
  runs: Record<string, RunMirror>;
  /** The run whose events we accept; others are dropped. */
  activeRunId: string | null;
  /** Legacy single-run view of the active run (StatusStrip et al.). */
  run: RunView;

  toggleSidebar: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setDensity: (d: "compact" | "cozy") => void;
  /** Stash a Job for the editor to prefill from (or clear with null). */
  setJobDraft: (job: Job | null) => void;

  /** Command-driven: a preview/apply for `runId` is now the active run. Seeds a
   * mirror so the very first progress event has a home, and marks the phase. */
  beginRun: (
    runId: string,
    opts?: { jobId?: string; pairCount?: number; phase?: EnginePhase },
  ) => void;
  /** Event-driven mutators (the run subscriber calls these; each ignores events
   * for a non-active run). */
  applyRunStarted: (e: { run_id: string; job_id: string; pair_count: number }) => void;
  applyRunScan: (e: { run_id: string; pair_id: string; phase: string }) => void;
  applyRunScanProgress: (e: RunScanProgress) => void;
  applyRunScanTree: (e: RunScanTree) => void;
  applyRunPlanProgress: (e: RunPlanProgress) => void;
  applyRunProgress: (p: RunProgress) => void;
  applyRunPairDone: (e: { run_id: string; pair_id: string }) => void;
  applyRunFinished: (e: { run_id: string }) => void;
  resetRun: () => void;
}

export const useStore = create<UiState>((set) => {
  /** Mutate the run named by `runId` IFF it is the active run, then refresh the
   * derived view. A no-op (silent drop) for any other run id. */
  const mutateActive = (runId: string, fn: (m: RunMirror) => RunMirror) => {
    set((st) => {
      if (st.activeRunId !== runId) return st; // cross-talk: drop
      const existing = st.runs[runId];
      if (!existing) return st;
      const runs = { ...st.runs, [runId]: fn(existing) };
      return { runs, run: viewOf(runs, st.activeRunId) };
    });
  };

  return {
    sidebarCollapsed: false,
    commandPaletteOpen: false,
    density: "compact",
    jobDraft: null,

    runs: {},
    activeRunId: null,
    run: idleView,

    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
    setDensity: (d) => set({ density: d }),
    setJobDraft: (job) => set({ jobDraft: job }),

    beginRun: (runId, opts) =>
      set((st) => {
        const m: RunMirror = {
          ...newMirror(runId, opts?.jobId ?? null, opts?.pairCount ?? 0),
          phase: opts?.phase ?? "scanning",
        };
        const runs = { ...st.runs, [runId]: m };
        return { runs, activeRunId: runId, run: viewOf(runs, runId) };
      }),

    applyRunStarted: (e) =>
      set((st) => {
        // A started run becomes active. If we already seeded it (beginRun),
        // merge the authoritative pair_count/job_id; otherwise create it.
        const prev = st.runs[e.run_id];
        const m: RunMirror = prev
          ? { ...prev, jobId: e.job_id, pairCount: e.pair_count }
          : newMirror(e.run_id, e.job_id, e.pair_count);
        const runs = { ...st.runs, [e.run_id]: m };
        return { runs, activeRunId: e.run_id, run: viewOf(runs, e.run_id) };
      }),

    applyRunScan: (e) =>
      mutateActive(e.run_id, (m) => ({
        ...m,
        // A pair entered its scan: it becomes the active (auto-expanded) pair.
        // run://scan fires per pair in BOTH preview and execute, so this also
        // reflects execute's per-pair re-scan; the first progress event flips it
        // to "applying".
        phase: "scanning",
        activePairId: e.pair_id,
        scanPairId: e.pair_id,
        scanTree: [], // reset the live tree at the pair boundary
        planDone: 0, // back to the scanning sub-state (planning not started)
        planTotal: 0,
        scanBaseAtPairStart: m.scanned, // anchor the per-pair scanned delta
        pairStatus: { ...m.pairStatus, [e.pair_id]: "scanning" },
      })),

    applyRunScanProgress: (e) => mutateActive(e.run_id, (m) => ({ ...m, scanned: e.scanned })),

    applyRunScanTree: (e) =>
      mutateActive(e.run_id, (m) => ({ ...m, scanTree: e.folders, scanPairId: e.pair_id })),

    applyRunPlanProgress: (e) =>
      mutateActive(e.run_id, (m) => ({ ...m, planDone: e.done, planTotal: e.total })),

    applyRunProgress: (p) =>
      mutateActive(p.run_id, (m) => {
        // Tally this applied item under its top-level folder (per pair) for the
        // apply-phase folder-activity tree. One event == one applied item.
        const folder = topSegment(p.path);
        const pairFolders = m.doneByFolder[p.pair_id] ?? {};
        return {
          ...m,
          phase: "applying",
          activePairIndex: p.pair_index,
          activePairId: p.pair_id,
          pairCount: p.pair_count || m.pairCount,
          progress: p,
          progressByPair: { ...m.progressByPair, [p.pair_id]: p },
          doneByFolder: {
            ...m.doneByFolder,
            [p.pair_id]: { ...pairFolders, [folder]: (pairFolders[folder] ?? 0) + 1 },
          },
          pairStatus: { ...m.pairStatus, [p.pair_id]: "applying" },
        };
      }),

    applyRunPairDone: (e) =>
      mutateActive(e.run_id, (m) => {
        const applied = m.progressByPair[e.pair_id]?.done ?? 0; // 0 in preview (no progress)
        const scanned = Math.max(0, m.scanned - m.scanBaseAtPairStart);
        return {
          ...m,
          activePairIndex: Math.min(m.activePairIndex + 1, Math.max(m.pairCount - 1, 0)),
          // The active row collapses between pairs.
          activePairId: m.activePairId === e.pair_id ? null : m.activePairId,
          scanPairId: m.scanPairId === e.pair_id ? null : m.scanPairId,
          pairStatus: { ...m.pairStatus, [e.pair_id]: "done" },
          pairRecap: { ...m.pairRecap, [e.pair_id]: { scanned, applied } },
        };
      }),

    applyRunFinished: (e) =>
      set((st) => {
        if (st.activeRunId !== e.run_id) return st; // drop foreign finished
        const prev = st.runs[e.run_id];
        const runs = prev
          ? {
              ...st.runs,
              [e.run_id]: {
                ...prev,
                phase: "idle" as EnginePhase,
                progress: null,
                activePairId: null,
                scanPairId: null,
              },
            }
          : st.runs;
        return { runs, activeRunId: null, run: idleView };
      }),

    resetRun: () => set({ runs: {}, activeRunId: null, run: idleView }),
  };
});

/** Wire the ONE set of run subscribers into the store. Call once at bootstrap.
 * Each handler routes through the store, which drops events for a non-active
 * run (no cross-talk). Returns a combined unlisten. */
export async function subscribeRunEvents(): Promise<() => void> {
  const st = () => useStore.getState();
  const unlistens = await Promise.all([
    onRunStarted((e) => st().applyRunStarted(e)),
    onRunScan((e) => st().applyRunScan(e)),
    onRunScanProgress((e) => st().applyRunScanProgress(e)),
    onRunScanTree((e) => st().applyRunScanTree(e)),
    onRunPlanProgress((e) => st().applyRunPlanProgress(e)),
    onRunProgress((p) => st().applyRunProgress(p)),
    onRunPairDone((e) => st().applyRunPairDone(e)),
    onRunFinished((e) => st().applyRunFinished(e)),
  ]);
  return () => {
    for (const un of unlistens) un();
  };
}
