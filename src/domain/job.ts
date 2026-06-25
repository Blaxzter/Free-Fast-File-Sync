/* The persisted Job aggregate (frontend model), shaped EXACTLY like the Rust
 * serde DTOs in src-tauri/src/job.rs (snake_case: root_a, filter_override,
 * compare_mode, …). Re-exports the binding types and supplies pure factory
 * helpers (defaults / newJob) + the five-way SyncDirection -> {SyncMode, swap}
 * mapping table.
 *
 * The mapping table is a FRONTEND MIRROR of job.rs#resolve_pair, used only by
 * the editor preview ("which way will this pair run?"). The AUTHORITATIVE
 * fan-out is the Rust resolve_pair — never trust this for safety-critical IO. */

import type {
  BigDeleteGuard,
  CompareMode,
  DeletionPolicy,
  EndpointPath,
  FolderPair,
  IgnorePolicy,
  Job,
  JobConfig,
  JobSettings,
  SyncDirection,
  SyncMode,
} from "../ipc/bindings";

export type {
  BigDeleteGuard,
  CompareMode,
  DeletionPolicy,
  EndpointPath,
  FolderPair,
  Job,
  JobSettings,
  SyncDirection,
  SyncMode,
} from "../ipc/bindings";

/** Engine default ignore policy (matches config.rs IgnorePolicy::default). */
export function defaultIgnorePolicy(): IgnorePolicy {
  return {
    use_gitignore: true,
    use_dot_ignore: true,
    include_hidden: false,
    custom_globs: [],
  };
}

/** Default big-delete guard (job.rs BigDeleteGuard::default: 25% / 100 files). */
export function defaultBigDeleteGuard(): BigDeleteGuard {
  return { pct: 0.25, abs: 100 };
}

/** Job-level defaults (job.rs JobSettings::default). */
export function defaultJobSettings(): JobSettings {
  return {
    compare_mode: "TimeAndSize",
    direction: "TwoWay",
    deletion: { kind: "RecycleBin" },
    big_delete: defaultBigDeleteGuard(),
    filter: defaultIgnorePolicy(),
  };
}

/** A fresh local folder pair with empty roots. `id` is minted server-side on
 * save (the Rust store assigns a ULID when id is empty); blank here is fine. */
export function newFolderPair(): FolderPair {
  return {
    id: "",
    label: "",
    root_a: { kind: "Local", path: "" },
    root_b: { kind: "Local", path: "" },
    enabled: true,
  };
}

/** A fresh, unsaved Job with one empty pair. id/created_at/updated_at are filled
 * by the Rust store on save. */
export function newJob(name = ""): Job {
  return {
    id: "",
    name,
    created_at: "",
    updated_at: "",
    settings: defaultJobSettings(),
    pairs: [newFolderPair()],
  };
}

/** A safe default single-pair JobConfig (matches config.rs JobConfig defaults).
 * Used by the editor preview only; the engine derives JobConfig from the Job. */
export function defaultJobConfig(): JobConfig {
  return {
    root_a: "",
    root_b: "",
    mode: "TwoWay",
    ignore: defaultIgnorePolicy(),
    verify_by_hash: false,
    big_delete_pct: 0.25,
    big_delete_abs: 100,
    use_recycle_bin: true,
  };
}

/** Extract the local filesystem path from an endpoint, or "" for remote. */
export function localPath(e: EndpointPath): string {
  return e.kind === "Local" ? e.path : "";
}

/** How a five-way SyncDirection collapses onto the engine axis. `swap` means
 * roots A/B are passed swapped so the engine only ever sees "A is source".
 * MIRROR of job.rs#resolve_pair — editor preview ONLY, never safety-critical. */
export interface ResolvedDirection {
  mode: SyncMode;
  swap: boolean;
}

export const DIRECTION_FANOUT: Record<SyncDirection, ResolvedDirection> = {
  TwoWay: { mode: "TwoWay", swap: false },
  MirrorAtoB: { mode: "Mirror", swap: false },
  MirrorBtoA: { mode: "Mirror", swap: true },
  UpdateAtoB: { mode: "Update", swap: false },
  UpdateBtoA: { mode: "Update", swap: true },
};

/** The engine-axis SyncMode a direction resolves to (editor preview mirror). */
export function directionMode(d: SyncDirection): SyncMode {
  return DIRECTION_FANOUT[d].mode;
}

/** Resolve a pair's effective settings against job defaults (override wins).
 * Frontend mirror of job.rs#resolve_pair's merge step — editor preview only. */
export function effectiveDirection(job: Job, pair: FolderPair): SyncDirection {
  return pair.mode_override ?? job.settings.direction;
}

export function effectiveDeletion(job: Job, pair: FolderPair): DeletionPolicy {
  return pair.deletion_override ?? job.settings.deletion;
}

export function effectiveFilter(job: Job, pair: FolderPair): IgnorePolicy {
  return pair.filter_override ?? job.settings.filter;
}

export function effectiveBigDelete(job: Job, pair: FolderPair): BigDeleteGuard {
  return pair.big_delete_override ?? job.settings.big_delete;
}

export function effectiveCompareMode(job: Job): CompareMode {
  return job.settings.compare_mode;
}

// ---- Pure validation (frontend mirror of job.rs#validate_job_aggregate) ----
// Used for per-field/blur validity in the editor. The AUTHORITATIVE structural
// check (identical/nested roots across pairs) is the Rust save_job →
// validate_pair_set; its InvalidJob error is surfaced as a form-level error.

/** True if an endpoint resolves to a non-empty local path. */
export function pairHasLocalRoots(pair: FolderPair): boolean {
  return localPath(pair.root_a).trim() !== "" && localPath(pair.root_b).trim() !== "";
}

/** A blank job name is invalid (mirrors the Rust "job name is required"). */
export function isValidName(name: string): boolean {
  return name.trim().length > 0;
}

/** A job needs at least one pair (mirrors the Rust "needs at least one pair"). */
export function hasAtLeastOnePair(job: Job): boolean {
  return job.pairs.length > 0;
}
