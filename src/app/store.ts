/* Zustand store: cross-cutting UI state + a live "current run" mirror.
 *
 * The live run mirror is fed by ONE sync://progress subscriber
 * (subscribeRunEvents), so every view (Compare Workspace status strip, future
 * Activity/StatusStrip) reads the same source. Do NOT put server data here —
 * that is TanStack Query's job. */

import { create } from "zustand";
import type { ApplyReport, Progress } from "../ipc/bindings";
import { onProgress } from "../ipc/events";

export type EnginePhase = "idle" | "scanning" | "applying";

export interface RunMirror {
  /** What the engine is doing right now. */
  phase: EnginePhase;
  /** Latest progress event during an apply, or null. */
  progress: Progress | null;
  /** The most recent finished apply report, or null. */
  report: ApplyReport | null;
}

interface UiState {
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  density: "compact" | "cozy";
  run: RunMirror;

  toggleSidebar: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setDensity: (d: "compact" | "cozy") => void;

  // Run-mirror mutators (called by the single subscriber + commands wrappers).
  setPhase: (phase: EnginePhase) => void;
  setProgress: (p: Progress | null) => void;
  setReport: (r: ApplyReport | null) => void;
  resetRun: () => void;
}

const initialRun: RunMirror = { phase: "idle", progress: null, report: null };

export const useStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  density: "compact",
  run: initialRun,

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setDensity: (d) => set({ density: d }),

  setPhase: (phase) => set((s) => ({ run: { ...s.run, phase } })),
  setProgress: (progress) => set((s) => ({ run: { ...s.run, progress } })),
  setReport: (report) => set((s) => ({ run: { ...s.run, report } })),
  resetRun: () => set({ run: initialRun }),
}));

/** Wire the ONE progress subscriber into the store. Call once at bootstrap. */
export function subscribeRunEvents(): Promise<() => void> {
  return onProgress((p) => {
    useStore.getState().setProgress(p);
  });
}
