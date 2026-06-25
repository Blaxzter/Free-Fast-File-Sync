/* TS bindings mirroring the Rust engine serde output (src-tauri/src/model.rs,
 * config.rs, ffs_import.rs). Hand-maintained for Phase 0; mirrored by Zod
 * schemas in domain/schemas.ts and parsed at the IPC boundary so a serde
 * mismatch fails loudly in dev. Keep field names exactly as serde emits them. */

// ---- model.rs enums (serialize to plain enum-variant strings) ----

export type EntryKind = "File" | "Dir" | "Symlink" | "Other";

export type ChangeKind = "Unchanged" | "Created" | "Modified" | "Deleted" | "TypeChanged";

export type Action =
  | "Noop"
  | "CopyAtoB"
  | "CopyBtoA"
  | "DeleteA"
  | "DeleteB"
  | "UpdateBaselineOnly"
  | "Conflict";

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

export type ItemStatus = "Done" | "Skipped" | "Failed" | "Conflict";

// ---- model.rs structs ----

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
  status: ItemStatus;
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

// ---- config.rs ----

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

// ---- lib.rs event payload (sync://progress) ----

export interface Progress {
  done: number;
  total: number;
  path: string;
  action: string;
}

// ---- ffs_import.rs ----

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
