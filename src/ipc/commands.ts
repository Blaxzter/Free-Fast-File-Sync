/* Typed wrappers for every engine command. THE ONLY PLACE (with events.ts)
 * that calls Tauri `invoke`. Each wrapper parses the response through a Zod
 * schema at the boundary so a serde/shape mismatch fails loudly. */

import { invoke } from "@tauri-apps/api/core";
import type {
  ApplyReport,
  BaselineStatusKind,
  FfsImport,
  JobConfig,
  Resolution,
  SyncPlan,
} from "./bindings";
import {
  zApplyReport,
  zBaselineStatusKind,
  zFfsImport,
  zSyncPlan,
} from "../domain/schemas";

export function validateJob(cfg: JobConfig): Promise<void> {
  return invoke<void>("validate_job", { cfg });
}

export async function getBaselineStatus(cfg: JobConfig): Promise<BaselineStatusKind> {
  const raw = await invoke("get_baseline_status", { cfg });
  return zBaselineStatusKind.parse(raw);
}

export async function previewSync(cfg: JobConfig): Promise<SyncPlan> {
  const raw = await invoke("preview_sync", { cfg });
  return zSyncPlan.parse(raw) as SyncPlan;
}

export async function executeSync(
  cfg: JobConfig,
  resolutions: Record<string, Resolution>,
  confirmBigDelete: boolean,
): Promise<ApplyReport> {
  const raw = await invoke("execute_sync", { cfg, resolutions, confirmBigDelete });
  return zApplyReport.parse(raw) as ApplyReport;
}

export function cancelSync(): Promise<void> {
  return invoke<void>("cancel_sync");
}

export async function importFfs(path: string): Promise<FfsImport> {
  const raw = await invoke("import_ffs", { path });
  return zFfsImport.parse(raw) as FfsImport;
}
