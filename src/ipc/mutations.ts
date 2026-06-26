/* TanStack Query mutations over the write/engine commands. The multi-pair
 * run surface (preview_job / execute_job / cancel_run) plus the job-store
 * writes (save / delete / duplicate). Components drive these and never call
 * invoke directly. */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useStore } from "../app/store";
import type { ExecuteJobResult, Job, PreviewJobResult, Resolution, Settings } from "./bindings";
import {
  cancelRun as cancelRunCmd,
  deleteJob,
  duplicateJob,
  executeJob,
  previewJob,
  saveJob,
  saveSettings,
} from "./commands";

// ---- Run surface ----

export interface PreviewArgs {
  jobId: string;
  pairIds?: string[];
}

/** Preview a job (preview_job). The run://started event makes the run active in
 * the store; on success the run slot stays HELD until executeJob/cancelRun. We
 * also seed the active run from the returned run_id in case the event was
 * dropped (e.g. parse drift), so executeJob has an active run to stream into. */
export function usePreviewJob() {
  const beginRun = useStore((s) => s.beginRun);
  return useMutation<PreviewJobResult, unknown, PreviewArgs>({
    mutationFn: async ({ jobId, pairIds }) => {
      const result = await previewJob(jobId, pairIds);
      // Preview is done by the time this resolves; the run slot stays HELD but is
      // idle (ready to apply). The run://started event already made it active;
      // we re-seed to be robust if that event was dropped.
      beginRun(result.run_id, {
        jobId,
        pairCount: result.pairs.length,
        phase: "idle",
      });
      return result;
    },
  });
}

export interface ExecuteArgs {
  runId: string;
  resolutions: Record<string, Record<string, Resolution>>;
  confirmBigDelete: Record<string, boolean>;
}

/** Execute a previewed run (execute_job). Marks the run active+applying so the
 * store's run subscriber streams progress into it; records the final per-pair
 * reports. run://finished returns the mirror to idle. */
export function useExecuteJob() {
  const beginRun = useStore((s) => s.beginRun);
  return useMutation<ExecuteJobResult, unknown, ExecuteArgs>({
    mutationFn: async ({ runId, resolutions, confirmBigDelete }) => {
      beginRun(runId, { phase: "applying" });
      return await executeJob(runId, resolutions, confirmBigDelete);
    },
  });
}

/** Cancel a run by id (cancel_run). Returns true iff a matching run was found. */
export function cancelRun(runId: string): Promise<boolean> {
  return cancelRunCmd(runId);
}

// ---- Job store writes ----

/** Persist a job (save_job). Invalidates the jobs list + the single-job cache. */
export function useSaveJob() {
  const qc = useQueryClient();
  return useMutation<Job, unknown, Job>({
    mutationFn: (job) => saveJob(job),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["jobs"] });
      void qc.invalidateQueries({ queryKey: ["job", saved.id] });
    },
  });
}

/** Delete a job (delete_job). */
export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation<void, unknown, string>({
    mutationFn: (jobId) => deleteJob(jobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}

/** Persist global settings (save_settings). Refreshes the settings cache. */
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation<Settings, unknown, Settings>({
    mutationFn: (settings) => saveSettings(settings),
    onSuccess: (saved) => {
      qc.setQueryData(["settings"], saved);
    },
  });
}

/** Duplicate a job (duplicate_job). */
export function useDuplicateJob() {
  const qc = useQueryClient();
  return useMutation<Job, unknown, string>({
    mutationFn: (jobId) => duplicateJob(jobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}
