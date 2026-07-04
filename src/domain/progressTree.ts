/* Pure helpers for the live apply-phase folder-activity view (ProgressTree).
 * No React, no IPC.
 *
 * The apply engine (src-tauri/src/apply.rs) emits one `run://progress` event per
 * APPLIED item — copies, deletes, keep-both — and NEVER for noop / baseline-only
 * / skipped-conflict items. Each event carries the running `done` count and the
 * item's relative `path`. Because the preview plan already enumerates every item,
 * we can show, per TOP-LEVEL folder, how many of its will-apply items are done
 * and which folder is currently live.
 *
 * Top-level only for now (Phase A). Deeper nesting + the scan-phase tree arrive
 * with the backend scan-tree feed — see docs/ARCHITECTURE.md §8. */

import type { PlanItem, Resolution } from "./plan";

/** Sentinel folder name for items that live directly under a pair root (no "/").
 * Rendered as "(root)" by the view; tallied under this key by the store. */
export const ROOT_FOLDER = "";

/** The first path segment ("" for a root-level file with no "/"). This is the
 * key the live done-tally is bucketed under in app/store.ts. */
export function topSegment(path: string): string {
  const i = path.indexOf("/");
  return i < 0 ? ROOT_FOLDER : path.slice(0, i);
}

/** Will this item actually be applied — i.e. emit a `run://progress` event?
 * Mirrors apply.rs `effect_for`/`resolve_conflict`: copies/deletes always apply;
 * a Conflict applies unless its chosen-or-default resolution is Skip (or unset);
 * Noop and UpdateBaselineOnly never emit progress. */
export function willApply(item: PlanItem, resolution?: Resolution): boolean {
  switch (item.action) {
    case "CopyAtoB":
    case "CopyBtoA":
    case "DeleteA":
    case "DeleteB":
      return true;
    case "Conflict": {
      const r = resolution ?? item.default_resolution;
      return r != null && r !== "Skip";
    }
    default: // Noop, UpdateBaselineOnly
      return false;
  }
}

/** Count of will-apply items per top-level folder for one pair's plan. */
export function folderTotals(
  items: PlanItem[],
  resolutions: Record<string, Resolution>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const it of items) {
    if (!willApply(it, resolutions[it.path])) continue;
    const f = topSegment(it.path);
    totals.set(f, (totals.get(f) ?? 0) + 1);
  }
  return totals;
}

export interface FolderProgress {
  /** Top-level folder name; "" for root-level files (render as "(root)"). */
  name: string;
  total: number;
  done: number;
  status: "pending" | "active" | "done";
}

/** Merge static per-folder totals with the live done-tally + active folder into
 * a display-ordered list. `done` is clamped to `total` so a late resolution edit
 * can never render "5/3". The active folder always shows as active; a folder with
 * every will-apply item accounted for shows done; everything else is pending.
 * Sorted by name (root-level files, key "", sort first). */
export function buildFolderProgress(
  items: PlanItem[],
  resolutions: Record<string, Resolution>,
  doneByFolder: Record<string, number>,
  activeFolder: string | null,
): FolderProgress[] {
  const totals = folderTotals(items, resolutions);
  const out: FolderProgress[] = [];
  for (const [name, total] of totals) {
    const done = Math.min(doneByFolder[name] ?? 0, total);
    const status: FolderProgress["status"] =
      name === activeFolder ? "active" : total > 0 && done >= total ? "done" : "pending";
    out.push({ name, total, done, status });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
