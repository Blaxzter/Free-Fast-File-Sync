/* TanStack Query mutations over the write/engine commands. The Compare
 * Workspace drives Preview/Apply through these; the live progress mirror in the
 * Zustand store is updated by phase transitions here + the single subscriber. */

import { useMutation } from "@tanstack/react-query";
import { executeSync, previewSync } from "./commands";
import type { ApplyReport, JobConfig, Resolution, SyncPlan } from "./bindings";
import { useStore } from "../app/store";

/** Preview (preview_sync). Flips the engine phase to scanning while it runs. */
export function usePreview() {
  const setPhase = useStore((s) => s.setPhase);
  return useMutation<SyncPlan, unknown, JobConfig>({
    mutationFn: async (cfg) => {
      setPhase("scanning");
      try {
        return await previewSync(cfg);
      } finally {
        setPhase("idle");
      }
    },
  });
}

export interface ApplyArgs {
  cfg: JobConfig;
  resolutions: Record<string, Resolution>;
  confirmBigDelete: boolean;
}

/** Apply (execute_sync). Streams progress via the store subscriber; flips the
 * engine phase to applying and records the final report. */
export function useApply() {
  const setPhase = useStore((s) => s.setPhase);
  const setReport = useStore((s) => s.setReport);
  const setProgress = useStore((s) => s.setProgress);
  return useMutation<ApplyReport, unknown, ApplyArgs>({
    mutationFn: async ({ cfg, resolutions, confirmBigDelete }) => {
      setPhase("applying");
      setReport(null);
      setProgress(null);
      try {
        const report = await executeSync(cfg, resolutions, confirmBigDelete);
        setReport(report);
        return report;
      } finally {
        setPhase("idle");
        setProgress(null);
      }
    },
  });
}
