/* TanStack Query hooks over the read commands. Components consume these and
 * never touch invoke directly. */

import { useQueries, useQuery } from "@tanstack/react-query";
import type { BaselineStatusKind, Job } from "./bindings";
import { getJob, getPairBaselineStatus, listJobs } from "./commands";

/** All persisted jobs (list_jobs). */
export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: listJobs,
  });
}

/** A single job by id (get_job). Disabled until an id is supplied. */
export function useJob(jobId: string | undefined) {
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => getJob(jobId as string),
    enabled: Boolean(jobId),
  });
}

/** The worst (most cautionary) baseline status wins when aggregating a job's
 * pairs into one badge: Corrupt > FirstSync > Present. An empty list => undefined. */
export function aggregateBaseline(kinds: BaselineStatusKind[]): BaselineStatusKind | undefined {
  if (kinds.length === 0) return undefined;
  if (kinds.includes("Corrupt")) return "Corrupt";
  if (kinds.includes("FirstSync")) return "FirstSync";
  return "Present";
}

/** Baseline status for every ENABLED pair of a job, aggregated into one kind for
 * the jobs-list row badge. Drives one get_pair_baseline_status query per pair. */
export function useJobBaselineStatus(job: Job): {
  status: BaselineStatusKind | undefined;
  isLoading: boolean;
} {
  const enabled = job.pairs.filter((p) => p.enabled);
  const results = useQueries({
    queries: enabled.map((p) => ({
      queryKey: ["pair-baseline", job.id, p.id] as const,
      queryFn: () => getPairBaselineStatus(job.id, p.id),
      enabled: Boolean(job.id && p.id),
    })),
  });
  const isLoading = results.some((r) => r.isLoading);
  const kinds = results.map((r) => r.data).filter((d): d is BaselineStatusKind => Boolean(d));
  return { status: aggregateBaseline(kinds), isLoading };
}

/** Baseline status for one pair of a job (get_pair_baseline_status). */
export function usePairBaselineStatus(jobId: string | undefined, pairId: string | undefined) {
  const ready = Boolean(jobId && pairId);
  return useQuery({
    queryKey: ["pair-baseline", jobId, pairId],
    queryFn: () => getPairBaselineStatus(jobId as string, pairId as string),
    enabled: ready,
  });
}
