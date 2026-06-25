import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---- Types mirroring the Rust engine (serde output) ----

export type Action =
  | "Noop"
  | "CopyAtoB"
  | "CopyBtoA"
  | "DeleteA"
  | "DeleteB"
  | "UpdateBaselineOnly"
  | "Conflict";

export type ChangeKind = "Unchanged" | "Created" | "Modified" | "Deleted" | "TypeChanged";

export type ConflictType =
  | "EditEdit"
  | "CreateCreate"
  | "ModifyDelete"
  | "DeleteTypeChange"
  | "ModifyTypeChange"
  | "TypeChangeTypeChange"
  | "StateDesync";

export type Resolution =
  | "KeepA"
  | "KeepB"
  | "KeepNewer"
  | "KeepBoth"
  | "PropagateDelete"
  | "KeepModified"
  | "KeepTypeChanged"
  | "Skip";

export type BaselineStatusKind = "Present" | "FirstSync" | "Corrupt";
export type EntryKind = "File" | "Dir" | "Symlink" | "Other";

export interface Meta {
  kind: EntryKind;
  size: number;
  mtime_ns: number;
  hash?: string;
}

export interface PlanItem {
  path: string;
  action: Action;
  conflict?: ConflictType;
  a_change: ChangeKind;
  b_change: ChangeKind;
  a?: Meta;
  b?: Meta;
  base?: Meta;
  default_resolution?: Resolution;
  resolution_options: Resolution[];
  note: string;
}

export interface PlanSummary {
  total: number;
  copy_a_to_b: number;
  copy_b_to_a: number;
  delete_a: number;
  delete_b: number;
  conflicts: number;
  baseline_only: number;
  noop: number;
  skipped: number;
}

export interface BigDeleteWarning {
  deletions: number;
  total_members: number;
  pct: number;
  threshold_pct: number;
  threshold_abs: number;
}

export interface SyncPlan {
  root_a: string;
  root_b: string;
  items: PlanItem[];
  summary: PlanSummary;
  baseline_status: BaselineStatusKind;
  big_delete?: BigDeleteWarning;
  warnings: string[];
}

export interface ItemOutcome {
  path: string;
  action: Action;
  status: "Done" | "Skipped" | "Failed" | "Conflict";
  error?: string;
}

export interface ApplyReport {
  done: number;
  failed: number;
  skipped: number;
  conflicts: number;
  bytes_copied: number;
  outcomes: ItemOutcome[];
}

export interface IgnorePolicy {
  use_gitignore: boolean;
  use_dot_ignore: boolean;
  include_hidden: boolean;
  custom_globs: string[];
}

export interface JobConfig {
  root_a: string;
  root_b: string;
  ignore: IgnorePolicy;
  verify_by_hash: boolean;
  big_delete_pct: number;
  big_delete_abs: number;
  use_recycle_bin: boolean;
}

export interface Progress {
  done: number;
  total: number;
  path: string;
  action: string;
}

export interface ImportedJob {
  name: string;
  left: string;
  right: string;
  two_way: boolean;
  use_recycle_bin: boolean;
  verify_by_hash: boolean;
  exclude_globs: string[];
  warnings: string[];
  gitignore_hint?: string;
}

export interface FfsImport {
  jobs: ImportedJob[];
  notes: string[];
}

// A SyncError serializes as { kind, detail }.
export interface SyncError {
  kind: string;
  detail?: unknown;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "kind" in e) {
    const se = e as SyncError;
    const detail =
      typeof se.detail === "string"
        ? se.detail
        : se.detail
          ? JSON.stringify(se.detail)
          : "";
    return detail ? `${se.kind}: ${detail}` : se.kind;
  }
  return String(e);
}

// ---- Command wrappers ----

export const validateJob = (cfg: JobConfig) => invoke<void>("validate_job", { cfg });

export const getBaselineStatus = (cfg: JobConfig) =>
  invoke<BaselineStatusKind>("get_baseline_status", { cfg });

export const previewSync = (cfg: JobConfig) => invoke<SyncPlan>("preview_sync", { cfg });

export const executeSync = (
  cfg: JobConfig,
  resolutions: Record<string, Resolution>,
  confirmBigDelete: boolean,
) => invoke<ApplyReport>("execute_sync", { cfg, resolutions, confirmBigDelete });

export const cancelSync = () => invoke<void>("cancel_sync");

export const importFfs = (path: string) => invoke<FfsImport>("import_ffs", { path });

export const onProgress = (cb: (p: Progress) => void): Promise<UnlistenFn> =>
  listen<Progress>("sync://progress", (e) => cb(e.payload));
