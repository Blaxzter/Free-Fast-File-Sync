/* Typed `listen` wrappers. THE ONLY PLACE (with commands.ts) that calls Tauri
 * `listen`. The run-aware store (app/store.ts) subscribes through these and
 * feeds the live-run mirror so any view can read current progress.
 *
 * Surface mirrors src-tauri/src/lib.rs run://* emits (S6 multi-pair). The
 * retired single-pair onProgress (sync://progress) is gone. Each payload is
 * safeParsed: a drifted/unknown shape is dropped rather than crashing the UI. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  zRunFinished,
  zRunPairDone,
  zRunPlanProgress,
  zRunProgress,
  zRunScan,
  zRunScanProgress,
  zRunScanTree,
  zRunStarted,
} from "../domain/schemas";
import type {
  RunFinished,
  RunPairDone,
  RunPlanProgress,
  RunProgress,
  RunScan,
  RunScanProgress,
  RunScanTree,
  RunStarted,
} from "./bindings";

/** A run claimed the slot; pairs are about to be scanned/applied. */
export function onRunStarted(cb: (e: RunStarted) => void): Promise<UnlistenFn> {
  return listen<unknown>("run://started", (e) => {
    const parsed = zRunStarted.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}

/** A pair entered a scan phase. */
export function onRunScan(cb: (e: RunScan) => void): Promise<UnlistenFn> {
  return listen<unknown>("run://scan", (e) => {
    const parsed = zRunScan.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}

/** Per-item apply progress within the active pair. */
export function onRunProgress(cb: (e: RunProgress) => void): Promise<UnlistenFn> {
  return listen<unknown>("run://progress", (e) => {
    const parsed = zRunProgress.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}

/** Live, cumulative count of entries recorded during the scan (~8/sec). */
export function onRunScanProgress(cb: (e: RunScanProgress) => void): Promise<UnlistenFn> {
  return listen<unknown>("run://scan-progress", (e) => {
    const parsed = zRunScanProgress.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}

/** Live, shallow per-folder scan activity (~ticker cadence; only when enabled). */
export function onRunScanTree(cb: (e: RunScanTree) => void): Promise<UnlistenFn> {
  return listen<unknown>("run://scan-tree", (e) => {
    const parsed = zRunScanTree.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}

/** Live planning-phase progress (post-scan disk probes); only fires while the
 * planning phase is running (total > 0). */
export function onRunPlanProgress(cb: (e: RunPlanProgress) => void): Promise<UnlistenFn> {
  return listen<unknown>("run://plan-progress", (e) => {
    const parsed = zRunPlanProgress.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}

/** A pair finished (preview or apply). */
export function onRunPairDone(cb: (e: RunPairDone) => void): Promise<UnlistenFn> {
  return listen<unknown>("run://pair-done", (e) => {
    const parsed = zRunPairDone.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}

/** The whole run is over; the slot is released. */
export function onRunFinished(cb: (e: RunFinished) => void): Promise<UnlistenFn> {
  return listen<unknown>("run://finished", (e) => {
    const parsed = zRunFinished.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}
