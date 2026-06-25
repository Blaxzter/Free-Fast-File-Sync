/* The Job aggregate (frontend model, Phase-1 backend). In Phase 0 the engine is
 * single-pair, so the Compare Workspace drives one JobConfig directly. These
 * types + the default-config helper exist so later phases drop in without a
 * model rewrite, and so the Compare Workspace can carry a job-ish shape. */

import type { IgnorePolicy, JobConfig } from "../ipc/bindings";

export type CompareMode = "TimeAndSize" | "Content";
export type SyncDirection =
  | "TwoWay"
  | "MirrorAtoB"
  | "MirrorBtoA"
  | "UpdateAtoB"
  | "UpdateBtoA";

export type DeletionPolicy =
  | { kind: "RecycleBin" }
  | { kind: "Permanent" }
  | { kind: "Versioning"; archiveDir: string };

export interface BigDeleteGuard {
  pct: number;
  abs: number;
}

export type EndpointPath =
  | { kind: "Local"; path: string }
  | { kind: "Remote"; endpointId: string; path: string };

export interface FolderPair {
  id: string;
  label: string;
  rootA: EndpointPath;
  rootB: EndpointPath;
  enabled: boolean;
  filterOverride?: IgnorePolicy;
}

export interface Job {
  id: string;
  name: string;
  color?: string;
  createdAt: string;
  updatedAt: string;
  compareMode: CompareMode;
  direction: SyncDirection;
  deletion: DeletionPolicy;
  bigDelete: BigDeleteGuard;
  filter: IgnorePolicy;
  pairs: FolderPair[];
}

/** Engine default ignore policy (matches config.rs IgnorePolicy::default). */
export function defaultIgnorePolicy(): IgnorePolicy {
  return {
    use_gitignore: true,
    use_dot_ignore: true,
    include_hidden: false,
    custom_globs: [],
  };
}

/** A safe default single-pair JobConfig (matches config.rs defaults). */
export function defaultJobConfig(): JobConfig {
  return {
    root_a: "",
    root_b: "",
    ignore: defaultIgnorePolicy(),
    verify_by_hash: false,
    big_delete_pct: 0.25,
    big_delete_abs: 100,
    use_recycle_bin: true,
  };
}
