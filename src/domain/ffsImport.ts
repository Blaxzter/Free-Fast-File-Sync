/* Map a parsed FreeFileSync import into our Job model. One .ffs config = one
 * multi-pair Job (FFS semantics: one sync, many folder pairs — exactly our
 * "Job = many FolderPairs"). Roots, direction, excludes, and deletion policy are
 * carried per pair; .gitignore stays ON so the imported excludes layer on top of
 * it (the whole reason this tool exists). The returned Job is UNSAVED (blank
 * ids) — feed it to the editor for review before save. Pure, no IO, no React. */

import type { FfsImport, ImportedJob } from "../ipc/bindings";
import type { DeletionPolicy, FolderPair, Job, SyncDirection } from "./job";
import { defaultIgnorePolicy, defaultJobSettings } from "./job";

/** Last non-empty path segment, for a human-friendly pair label. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function directionOf(p: ImportedJob): SyncDirection {
  // FFS "one-way mirror" = left is the source of truth -> A→B.
  return p.two_way ? "TwoWay" : "MirrorAtoB";
}

function deletionOf(p: ImportedJob): DeletionPolicy {
  return p.use_recycle_bin ? { kind: "RecycleBin" } : { kind: "Permanent" };
}

function folderPairFromImported(
  p: ImportedJob,
  jobDirection: SyncDirection,
  jobDeletion: DeletionPolicy,
): FolderPair {
  const pair: FolderPair = {
    id: "",
    label: basename(p.left),
    root_a: { kind: "Local", path: p.left },
    root_b: { kind: "Local", path: p.right },
    enabled: true,
  };
  // Only override where this pair differs from the job-level default, so the
  // editor shows clean inheritance for the common case.
  const dir = directionOf(p);
  if (dir !== jobDirection) pair.mode_override = dir;
  const del = deletionOf(p);
  if (del.kind !== jobDeletion.kind) pair.deletion_override = del;
  // Each pair's FFS excludes become a per-pair filter override, with gitignore
  // still on (override REPLACES the job filter, so it must re-enable gitignore).
  if (p.exclude_globs.length > 0) {
    pair.filter_override = { ...defaultIgnorePolicy(), custom_globs: [...p.exclude_globs] };
  }
  return pair;
}

/** Build one unsaved multi-pair Job from a parsed FfsImport. */
export function jobFromFfsImport(imp: FfsImport, fallbackName = "FreeFileSync import"): Job {
  const pairs = imp.jobs;
  // Job-level defaults taken from the first pair; the rest override as needed.
  const jobDirection: SyncDirection = pairs.length ? directionOf(pairs[0]) : "TwoWay";
  const jobDeletion: DeletionPolicy = pairs.length ? deletionOf(pairs[0]) : { kind: "RecycleBin" };
  const allVerify = pairs.length > 0 && pairs.every((p) => p.verify_by_hash);

  const settings = defaultJobSettings();
  settings.direction = jobDirection;
  settings.deletion = jobDeletion;
  // Compare mode has no per-pair override in the model; use Content only if every
  // pair asked for it, else the fast time+size compare.
  settings.compare_mode = allVerify ? "Content" : "TimeAndSize";

  const name = pairs[0]?.name?.trim() ? pairs[0].name.trim() : fallbackName;

  return {
    id: "",
    name,
    created_at: "",
    updated_at: "",
    settings,
    pairs: pairs.map((p) => folderPairFromImported(p, jobDirection, jobDeletion)),
  };
}
