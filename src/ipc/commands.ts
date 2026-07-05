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
  zRunLog,
  zScheduleView,
  zSettings,
} from "../domain/schemas";
import type {
  BaselineStatusKind,
  ExecuteJobResult,
  FfsImport,
  Job,
  PreviewJobResult,
  Resolution,
  RunLog,
  ScheduleConfig,
  ScheduleView,
  Settings,
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

// ---- Global settings ----

export async function getSettings(): Promise<Settings> {
  const raw = await invoke("get_settings");
  return zSettings.parse(raw);
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const raw = await invoke("save_settings", { settings });
  return zSettings.parse(raw);
}

// ---- Activity (run history) ----

/** Recent run history, newest first (list_activity). Reads the append-only run
 * log; never mutates it. Empty when there is no history yet. */
export async function listActivity(): Promise<RunLog[]> {
  const raw = await invoke("list_activity");
  return z.array(zRunLog).parse(raw) as RunLog[];
}

// ---- Scheduling ----

/** Every job's schedule with its next computed fire, soonest-first (list_schedules). */
export async function listSchedules(): Promise<ScheduleView[]> {
  const raw = await invoke("list_schedules");
  return z.array(zScheduleView).parse(raw) as ScheduleView[];
}

/** Attach/replace a job's cron schedule (set_schedule). Rejects a bad cron at the
 * boundary. Returns the saved job. */
export async function setSchedule(jobId: string, schedule: ScheduleConfig): Promise<Job> {
  const raw = await invoke("set_schedule", { jobId, schedule });
  return zJob.parse(raw) as Job;
}

/** Remove a job's schedule entirely (clear_schedule). Returns the saved job. */
export async function clearSchedule(jobId: string): Promise<Job> {
  const raw = await invoke("clear_schedule", { jobId });
  return zJob.parse(raw) as Job;
}

/** Pause or resume a job's schedule without discarding its cron (pause_schedule). */
export async function pauseSchedule(jobId: string, paused: boolean): Promise<Job> {
  const raw = await invoke("pause_schedule", { jobId, paused });
  return zJob.parse(raw) as Job;
}

/** Fire a job's scheduled run immediately, regardless of cron (run_schedule_now). */
export function runScheduleNow(jobId: string): Promise<void> {
  return invoke<void>("run_schedule_now", { jobId });
}

// ---- FFS import ----

export async function importFfs(path: string): Promise<FfsImport> {
  const raw = await invoke("import_ffs", { path });
  return zFfsImport.parse(raw) as FfsImport;
}
