/* Typed wrappers for every engine command. THE ONLY PLACE (with events.ts)
 * that calls Tauri `invoke`. Each wrapper parses the response through a Zod
 * schema at the boundary so a serde/shape mismatch fails loudly.
 *
 * Surface mirrors src-tauri/src/lib.rs#invoke_handler (S6 multi-pair, job-driven).
 * The retired single-pair preview_sync/execute_sync/cancel_sync wrappers are gone. */

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import {
  zBaselineStatusKind,
  zExecuteJobResult,
  zFfsImport,
  zJob,
  zPreviewJobResult,
} from "../domain/schemas";
import type {
  BaselineStatusKind,
  ExecuteJobResult,
  FfsImport,
  Job,
  PreviewJobResult,
  Resolution,
} from "./bindings";

// ---- Job store ----

export async function listJobs(): Promise<Job[]> {
  const raw = await invoke("list_jobs");
  return z.array(zJob).parse(raw) as Job[];
}

export async function getJob(jobId: string): Promise<Job> {
  const raw = await invoke("get_job", { jobId });
  return zJob.parse(raw) as Job;
}

export async function saveJob(job: Job): Promise<Job> {
  const raw = await invoke("save_job", { job });
  return zJob.parse(raw) as Job;
}

export function deleteJob(jobId: string): Promise<void> {
  return invoke<void>("delete_job", { jobId });
}

export async function duplicateJob(jobId: string): Promise<Job> {
  const raw = await invoke("duplicate_job", { jobId });
  return zJob.parse(raw) as Job;
}

// ---- Baseline status (per pair) ----

export async function getPairBaselineStatus(
  jobId: string,
  pairId: string,
): Promise<BaselineStatusKind> {
  const raw = await invoke("get_pair_baseline_status", { jobId, pairId });
  return zBaselineStatusKind.parse(raw);
}

// ---- Multi-pair run surface ----

/** preview_job(job_id, pair_ids?) -> { run_id, pairs:[{pair_id, plan, baseline_status}] }.
 * On success the run slot stays HELD until executeJob/cancelRun releases it. */
export async function previewJob(jobId: string, pairIds?: string[]): Promise<PreviewJobResult> {
  const raw = await invoke("preview_job", { jobId, pairIds: pairIds ?? null });
  return zPreviewJobResult.parse(raw) as PreviewJobResult;
}

/** execute_job(run_id, resolutions: {pairId:{path:Resolution}}, confirm_big_delete: {pairId:bool}). */
export async function executeJob(
  runId: string,
  resolutions: Record<string, Record<string, Resolution>>,
  confirmBigDelete: Record<string, boolean>,
): Promise<ExecuteJobResult> {
  const raw = await invoke("execute_job", { runId, resolutions, confirmBigDelete });
  return zExecuteJobResult.parse(raw) as ExecuteJobResult;
}

/** Cancel a run by id. Returns true iff a matching active run was found. */
export async function cancelRun(runId: string): Promise<boolean> {
  const raw = await invoke("cancel_run", { runId });
  return z.boolean().parse(raw);
}

// ---- FFS import ----

export async function importFfs(path: string): Promise<FfsImport> {
  const raw = await invoke("import_ffs", { path });
  return zFfsImport.parse(raw) as FfsImport;
}
