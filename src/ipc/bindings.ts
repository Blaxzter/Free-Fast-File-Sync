/* TS bindings mirroring the Rust engine serde output (src-tauri/src/model.rs,
 * config.rs, job.rs, runs.rs, lib.rs, ffs_import.rs). Hand-maintained;
 * mirrored by Zod schemas in domain/schemas.ts and parsed at the IPC boundary
 * so a serde mismatch fails loudly in dev. Keep field names EXACTLY as serde
 * emits them (snake_case: root_a, filter_override, compare_mode, …). */

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

/** model.rs SyncMode — the engine-axis one-way post-filter. */
export type SyncMode = "TwoWay" | "Mirror" | "Update";

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
  /** Engine-axis post-filter (config.rs JobConfig::mode, default TwoWay). */
  mode: SyncMode;
  ignore: IgnorePolicy;
  verify_by_hash: boolean;
  big_delete_pct: number;
  big_delete_abs: number;
  use_recycle_bin: boolean;
}

// ---- job.rs (the persisted Job aggregate) ----

export type CompareMode = "TimeAndSize" | "Content";

/** Persisted 5-way direction (job.rs SyncDirection). Maps to {SyncMode, swap}
 * at fan-out (Rust authoritative; frontend mirror lives in domain/job.ts). */
export type SyncDirection = "TwoWay" | "MirrorAtoB" | "MirrorBtoA" | "UpdateAtoB" | "UpdateBtoA";

/** job.rs DeletionPolicy — serde(tag = "kind"). Versioning is descoped. */
export type DeletionPolicy = { kind: "RecycleBin" } | { kind: "Permanent" };

export interface BigDeleteGuard {
  pct: number;
  abs: number;
}

/** job.rs EndpointPath — serde(tag = "kind"). */
export type EndpointPath =
  | { kind: "Local"; path: string }
  | { kind: "Remote"; endpoint_id: string; path: string };

export interface JobSettings {
  compare_mode: CompareMode;
  direction: SyncDirection;
  deletion: DeletionPolicy;
  big_delete: BigDeleteGuard;
  filter: IgnorePolicy;
  /** Per-job override of the scan walker thread count (per root). Omitted =>
   * inherit the global Settings default. */
  scan_threads?: number;
  /** Per-job override of the mtime comparison tolerance, in milliseconds.
   * Omitted => inherit the global default. */
  mtime_gran_ms?: number;
}

export interface FolderPair {
  id: string;
  label: string;
  root_a: EndpointPath;
  root_b: EndpointPath;
  enabled: boolean;
  filter_override?: IgnorePolicy;
  mode_override?: SyncDirection;
  deletion_override?: DeletionPolicy;
  big_delete_override?: BigDeleteGuard;
}

export interface Job {
  id: string;
  name: string;
  color?: string;
  created_at: string;
  updated_at: string;
  settings: JobSettings;
  pairs: FolderPair[];
}

// ---- settings.rs (global, user-facing defaults) ----

/** Global application settings (settings.rs Settings). Not per-job. */
export interface Settings {
  /** Default scan walker threads per root. 0 => auto (conservative, CPU-sized). */
  scan_threads: number;
  /** Default mtime comparison tolerance, in milliseconds. 0 => engine default (10ms). */
  mtime_gran_ms: number;
  /** Live scan-progress ticker interval, in milliseconds (clamped 30..=2000 at use). */
  scan_ticker_ms: number;
  /** Live scan folder-tree depth: leading path segments to group scan activity by.
   * 1 = top-level folders (default); higher nests deeper; 0 = off (clamped 0..=8). */
  scan_tree_depth: number;
  /** tracing filter directive for the diagnostic log ("info", "debug", …). */
  log_level: string;
}

// ---- lib.rs multi-pair run surface ----

/** One pair's preview inside a run (lib.rs PairPreview). */
export interface PairPreview {
  pair_id: string;
  plan: SyncPlan;
  baseline_status: BaselineStatusKind;
}

/** preview_job(job_id, pair_ids?) -> PreviewJobResult. */
export interface PreviewJobResult {
  run_id: string;
  pairs: PairPreview[];
}

/** One pair's apply report inside a run (lib.rs PairReport). */
export interface PairReport {
  pair_id: string;
  report: ApplyReport;
}

/** execute_job(run_id, resolutions, confirm_big_delete) -> ExecuteJobResult. */
export interface ExecuteJobResult {
  run_id: string;
  pairs: PairReport[];
}

// ---- lib.rs run://* event payloads ----

export interface RunStarted {
  run_id: string;
  job_id: string;
  pair_count: number;
  trigger: string;
}

export interface RunScan {
  run_id: string;
  pair_id: string;
  phase: string;
}

export interface RunProgress {
  run_id: string;
  pair_id: string;
  pair_index: number;
  pair_count: number;
  done: number;
  total: number;
  path: string;
  action: string;
}

export interface RunPairDone {
  run_id: string;
  pair_id: string;
}

export interface RunFinished {
  run_id: string;
}

export interface RunScanProgress {
  run_id: string;
  /** Cumulative entries recorded across the job's pairs so far this scan. */
  scanned: number;
}

/** One shallow folder's live scan activity (lib.rs ScanTreeFolder). */
export interface ScanTreeFolder {
  /** Top-level (or scan_tree_depth-deep) relative folder; "" = root level. */
  path: string;
  count: number;
}

/** Live folder-activity snapshot during the scan phase (lib.rs RunScanTree).
 * Folders are the CURRENT pair only (the tree resets at each pair boundary). */
export interface RunScanTree {
  run_id: string;
  pair_id: string;
  folders: ScanTreeFolder[];
}

/** Live planning-phase progress (lib.rs RunPlanProgress): the post-scan disk
 * probes ("is the file there yet"), the slow part over a NAS. Emitted while the
 * scan count is frozen so the UI shows "checking files" movement, not a freeze. */
export interface RunPlanProgress {
  run_id: string;
  done: number;
  total: number;
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
