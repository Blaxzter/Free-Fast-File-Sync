/* store (S9): the run-aware mirror keyed by runId, and the cross-talk guard.
 * Verifies:
 *  - runs are keyed by runId; a started run becomes active and seeds a mirror
 *  - a progress event for the ACTIVE run updates its mirror
 *  - a progress event for an UNKNOWN/foreign runId is DROPPED (no cross-talk) */

import { describe, expect, it, beforeEach } from "vitest";
import { useStore } from "./store";
import type { RunProgress } from "../ipc/bindings";

function progress(runId: string, pairId: string, done: number): RunProgress {
  return {
    run_id: runId,
    pair_id: pairId,
    pair_index: 0,
    pair_count: 1,
    done,
    total: 10,
    path: `f${done}.txt`,
    action: "CopyAtoB",
  };
}

beforeEach(() => {
  useStore.getState().resetRun();
});

describe("run-aware store", () => {
  it("keys runs by runId; a started run becomes active", () => {
    const st = useStore.getState();
    st.applyRunStarted({ run_id: "RUN_A", job_id: "JOB", pair_count: 2 });

    const s = useStore.getState();
    expect(s.activeRunId).toBe("RUN_A");
    expect(s.runs["RUN_A"]).toBeDefined();
    expect(s.runs["RUN_A"]!.pairCount).toBe(2);
    expect(s.runs["RUN_A"]!.jobId).toBe("JOB");
  });

  it("a progress event for the active run updates its mirror", () => {
    const st = useStore.getState();
    st.applyRunStarted({ run_id: "RUN_A", job_id: "JOB", pair_count: 1 });
    st.applyRunProgress(progress("RUN_A", "P0", 5));

    const s = useStore.getState();
    expect(s.runs["RUN_A"]!.progress?.done).toBe(5);
    expect(s.runs["RUN_A"]!.progressByPair["P0"]?.done).toBe(5);
    expect(s.runs["RUN_A"]!.phase).toBe("applying");
    // Legacy view tracks the active run too.
    expect(s.run.progress?.done).toBe(5);
  });

  it("drops a progress event for an unknown/foreign runId", () => {
    const st = useStore.getState();
    st.applyRunStarted({ run_id: "RUN_A", job_id: "JOB", pair_count: 1 });

    // Foreign run: not the active id. Must be ignored entirely.
    st.applyRunProgress(progress("RUN_B", "PX", 7));

    const s = useStore.getState();
    expect(s.activeRunId).toBe("RUN_A");
    expect(s.runs["RUN_B"]).toBeUndefined();
    expect(s.runs["RUN_A"]!.progress).toBeNull();
    expect(s.run.progress).toBeNull();
  });

  it("run finished for the active run returns the mirror to idle", () => {
    const st = useStore.getState();
    st.applyRunStarted({ run_id: "RUN_A", job_id: "JOB", pair_count: 1 });
    st.applyRunProgress(progress("RUN_A", "P0", 5));
    st.applyRunFinished({ run_id: "RUN_A" });

    const s = useStore.getState();
    expect(s.activeRunId).toBeNull();
    expect(s.run.phase).toBe("idle");
    // a foreign finished is dropped
    st.applyRunStarted({ run_id: "RUN_C", job_id: "J", pair_count: 1 });
    st.applyRunFinished({ run_id: "RUN_OTHER" });
    expect(useStore.getState().activeRunId).toBe("RUN_C");
  });
});
