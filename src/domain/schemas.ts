/* Zod schemas mirroring the Rust serde DTOs. Parsed at the IPC boundary
 * (ipc/commands.ts, ipc/events.ts) so a backend/serde mismatch fails loudly in
 * dev rather than producing silently-wrong UI. Hand-kept in sync with
 * ipc/bindings.ts. */

import { z } from "zod";

export const zEntryKind = z.enum(["File", "Dir", "Symlink", "Other"]);

export const zChangeKind = z.enum(["Unchanged", "Created", "Modified", "Deleted", "TypeChanged"]);

export const zAction = z.enum([
  "Noop",
  "CopyAtoB",
  "CopyBtoA",
  "DeleteA",
  "DeleteB",
  "UpdateBaselineOnly",
  "Conflict",
]);

export const zConflictType = z.enum([
  "EditEdit",
  "CreateCreate",
  "ModifyDelete",
  "DeleteTypeChange",
  "ModifyTypeChange",
  "TypeChangeTypeChange",
  "StateDesync",
]);

export const zResolution = z.enum([
  "KeepA",
  "KeepB",
  "KeepNewer",
  "KeepBoth",
  "PropagateDelete",
  "KeepModified",
  "KeepTypeChanged",
  "Skip",
]);

export const zBaselineStatusKind = z.enum(["Present", "FirstSync", "Corrupt"]);

export const zItemStatus = z.enum(["Done", "Skipped", "Failed", "Conflict"]);

/** model.rs SyncMode. Default TwoWay (config.rs JobConfig::mode #[serde(default)]). */
export const zSyncMode = z.enum(["TwoWay", "Mirror", "Update"]).default("TwoWay");

export const zCompareMode = z.enum(["TimeAndSize", "Content"]);

export const zSyncDirection = z.enum([
  "TwoWay",
  "MirrorAtoB",
  "MirrorBtoA",
  "UpdateAtoB",
  "UpdateBtoA",
]);

export const zMeta = z.object({
  kind: zEntryKind,
  size: z.number(),
  mtime_ns: z.number(),
  hash: z.string().optional(),
});

export const zPlanItem = z.object({
  path: z.string(),
  action: zAction,
  conflict: zConflictType.optional(),
  a_change: zChangeKind,
  b_change: zChangeKind,
  a: zMeta.optional(),
  b: zMeta.optional(),
  base: zMeta.optional(),
  default_resolution: zResolution.optional(),
  // serde skips this field when empty; default to [].
  resolution_options: z.array(zResolution).default([]),
  note: z.string(),
});

export const zPlanSummary = z.object({
  total: z.number(),
  copy_a_to_b: z.number(),
  copy_b_to_a: z.number(),
  delete_a: z.number(),
  delete_b: z.number(),
  conflicts: z.number(),
  baseline_only: z.number(),
  noop: z.number(),
  skipped: z.number(),
});

export const zBigDeleteWarning = z.object({
  deletions: z.number(),
  total_members: z.number(),
  pct: z.number(),
  threshold_pct: z.number(),
  threshold_abs: z.number(),
});

export const zSyncPlan = z.object({
  root_a: z.string(),
  root_b: z.string(),
  items: z.array(zPlanItem),
  summary: zPlanSummary,
  baseline_status: zBaselineStatusKind,
  big_delete: zBigDeleteWarning.optional(),
  warnings: z.array(z.string()),
});

export const zItemOutcome = z.object({
  path: z.string(),
  action: zAction,
  status: zItemStatus,
  error: z.string().optional(),
});

export const zApplyReport = z.object({
  done: z.number(),
  failed: z.number(),
  skipped: z.number(),
  conflicts: z.number(),
  bytes_copied: z.number(),
  outcomes: z.array(zItemOutcome),
});

// ---- config.rs ----

export const zIgnorePolicy = z.object({
  use_gitignore: z.boolean(),
  use_dot_ignore: z.boolean(),
  include_hidden: z.boolean(),
  custom_globs: z.array(z.string()),
});

// ---- job.rs aggregate ----

export const zDeletionPolicy = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RecycleBin") }),
  z.object({ kind: z.literal("Permanent") }),
]);

export const zEndpointPath = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Local"), path: z.string() }),
  z.object({ kind: z.literal("Remote"), endpoint_id: z.string(), path: z.string() }),
]);

export const zBigDeleteGuard = z.object({
  pct: z.number(),
  abs: z.number(),
});

export const zJobSettings = z.object({
  compare_mode: zCompareMode,
  direction: zSyncDirection,
  deletion: zDeletionPolicy,
  big_delete: zBigDeleteGuard,
  filter: zIgnorePolicy,
  scan_threads: z.number().int().nonnegative().optional(),
  mtime_gran_ms: z.number().int().nonnegative().optional(),
});

// ---- settings.rs (global) ----

export const zSettings = z.object({
  scan_threads: z.number().int().nonnegative(),
  mtime_gran_ms: z.number().int().nonnegative(),
  scan_ticker_ms: z.number().int().nonnegative(),
  scan_tree_depth: z.number().int().nonnegative(),
  log_level: z.string(),
  // serde(default = true) on the Rust side; default it so an older settings.json parses.
  scheduler_enabled: z.boolean().default(true),
});

export const zFolderPair = z.object({
  id: z.string(),
  label: z.string(),
  root_a: zEndpointPath,
  root_b: zEndpointPath,
  enabled: z.boolean(),
  filter_override: zIgnorePolicy.optional(),
  mode_override: zSyncDirection.optional(),
  deletion_override: zDeletionPolicy.optional(),
  big_delete_override: zBigDeleteGuard.optional(),
});

export const zSchedulePolicy = z.enum(["PreviewOnly", "ApplySafe", "ApplyAll"]);

export const zScheduleConfig = z.object({
  enabled: z.boolean(),
  cron: z.string(),
  tz_offset_minutes: z.number().int().optional(),
  policy: zSchedulePolicy,
  // serde(default) on the Rust side; default it so an older job.json still parses.
  skip_if_watched: z.boolean().default(false),
});

export const zJobAutomation = z.object({
  schedule: zScheduleConfig.optional(),
});

export const zJob = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  settings: zJobSettings,
  pairs: z.array(zFolderPair),
  automation: zJobAutomation.optional(),
});

// ---- lib.rs multi-pair run surface ----

export const zPairPreview = z.object({
  pair_id: z.string(),
  plan: zSyncPlan,
  baseline_status: zBaselineStatusKind,
});

export const zPreviewJobResult = z.object({
  run_id: z.string(),
  pairs: z.array(zPairPreview),
});

export const zPairReport = z.object({
  pair_id: z.string(),
  report: zApplyReport,
});

export const zExecuteJobResult = z.object({
  run_id: z.string(),
  pairs: z.array(zPairReport),
});

// ---- lib.rs run://* event payloads ----

export const zRunStarted = z.object({
  run_id: z.string(),
  job_id: z.string(),
  pair_count: z.number(),
  trigger: z.string(),
});

export const zRunScan = z.object({
  run_id: z.string(),
  pair_id: z.string(),
  phase: z.string(),
});

export const zRunProgress = z.object({
  run_id: z.string(),
  pair_id: z.string(),
  pair_index: z.number(),
  pair_count: z.number(),
  done: z.number(),
  total: z.number(),
  path: z.string(),
  action: z.string(),
});

export const zRunPairDone = z.object({
  run_id: z.string(),
  pair_id: z.string(),
});

export const zRunFinished = z.object({
  run_id: z.string(),
});

export const zRunScanProgress = z.object({
  run_id: z.string(),
  scanned: z.number(),
});

export const zScanTreeFolder = z.object({
  path: z.string(),
  count: z.number(),
});

export const zRunScanTree = z.object({
  run_id: z.string(),
  pair_id: z.string(),
  folders: z.array(zScanTreeFolder),
});

export const zRunPlanProgress = z.object({
  run_id: z.string(),
  done: z.number(),
  total: z.number(),
});

// ---- lib.rs scheduling ----

export const zScheduleView = z.object({
  job_id: z.string(),
  job_name: z.string(),
  schedule: zScheduleConfig,
  next_run: z.string().optional(),
});

export const zScheduleTick = z.object({
  job_id: z.string(),
  run_id: z.string(),
  policy: z.string(),
});

// ---- runlog.rs (Activity / run history) ----

export const zPairRunLog = z.object({
  pair_id: z.string(),
  entries_a: z.number(),
  entries_b: z.number(),
  errors_a: z.number(),
  errors_b: z.number(),
  skipped_a: z.number(),
  skipped_b: z.number(),
  scanned: z.number(),
  threads: z.number(),
  ms: z.number(),
  ok: z.boolean(),
  error: z.string().optional(),
});

/** `cancelled` is omitted on disk for a clean run (serde skip); default it to
 * false so the parsed record always carries a boolean. `error` is absent unless
 * the run failed. */
export const zRunLog = z.object({
  run_id: z.string(),
  job_id: z.string(),
  phase: z.string(),
  trigger: z.string(),
  started: z.string(),
  ended: z.string(),
  ms: z.number(),
  pair_count: z.number(),
  pairs: z.array(zPairRunLog),
  ok: z.boolean(),
  cancelled: z.boolean().optional().default(false),
  error: z.string().optional(),
});

// ---- ffs_import.rs ----

export const zImportedJob = z.object({
  name: z.string(),
  left: z.string(),
  right: z.string(),
  two_way: z.boolean(),
  use_recycle_bin: z.boolean(),
  verify_by_hash: z.boolean(),
  exclude_globs: z.array(z.string()),
  warnings: z.array(z.string()),
  gitignore_hint: z.string().optional(),
});

export const zFfsImport = z.object({
  jobs: z.array(zImportedJob),
  notes: z.array(z.string()),
});
