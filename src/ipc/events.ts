/* Typed `listen` wrappers. THE ONLY PLACE (with commands.ts) that calls Tauri
 * `listen`. A single subscriber (app/store.ts wiring) feeds these into the
 * Zustand live-run mirror so any view can read current progress. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Progress } from "./bindings";
import { zProgress } from "../domain/schemas";

/** Subscribe to the engine's apply progress stream (sync://progress). */
export function onProgress(cb: (p: Progress) => void): Promise<UnlistenFn> {
  return listen<unknown>("sync://progress", (e) => {
    const parsed = zProgress.safeParse(e.payload);
    if (parsed.success) cb(parsed.data);
  });
}
