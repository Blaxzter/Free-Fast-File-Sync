/* Typed `listen` wrappers. THE ONLY PLACE (with commands.ts) that calls Tauri
 * `listen`. The run-aware store (app/store.ts) subscribes through these and
 * feeds the live-run mirror so any view can read current progress.
 *
 * Surface mirrors src-tauri/src/lib.rs run://* emits (S6 multi-pair). The
 * retired single-pair onProgress (sync://progress) is gone. Each payload is
 * safeParsed: a drifted/unknown shape is dropped rather than crashing the UI. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  RunFinished,
  RunPairDone,
  RunProgress,
  RunScan,
  RunStarted,
} from "./bindings";
import {
  zRunFinished,
  zRunPairDone,
  zRunProgress,
  zRunScan,
  zRunStarted,
} from "../domain/schemas";

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
