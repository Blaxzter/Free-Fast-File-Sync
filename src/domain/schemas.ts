/* Zod schemas mirroring the Rust serde DTOs. Parsed at the IPC boundary
 * (ipc/commands.ts) so a backend/serde mismatch fails loudly in dev rather
 * than producing silently-wrong UI. Hand-kept in sync with ipc/bindings.ts. */

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

export const zProgress = z.object({
  done: z.number(),
  total: z.number(),
  path: z.string(),
  action: z.string(),
});

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
