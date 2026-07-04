/* Pure activity helpers: the RunStatus derivation (failure beats cancel), phase
 * labels, per-run totals, and duration formatting. */

import { describe, expect, it } from "vitest";
import type { PairRunLog, RunLog } from "../ipc/bindings";
import {
  formatDuration,
  formatRunTimestamp,
  isApply,
  phaseLabel,
  runStatus,
  runTotals,
} from "./activity";

function pair(extra: Partial<PairRunLog> = {}): PairRunLog {
  return {
    pair_id: "P",
    entries_a: 10,
    entries_b: 8,
    errors_a: 0,
    errors_b: 0,
    skipped_a: 1,
    skipped_b: 0,
    scanned: 18,
    threads: 8,
    ms: 42,
    ok: true,
    ...extra,
  };
}

function run(extra: Partial<RunLog> = {}): RunLog {
  return {
    run_id: "R",
    job_id: "J",
    phase: "execute",
    trigger: "Manual",
    started: "2026-06-26T00:00:00Z",
    ended: "2026-06-26T00:00:01Z",
    ms: 1000,
    pair_count: 1,
    pairs: [pair()],
    ok: true,
    ...extra,
  };
}

describe("runStatus", () => {
  it("is ok for a clean run", () => {
    expect(runStatus(run())).toBe("ok");
  });
  it("is cancelled when cancelled and no error", () => {
    expect(runStatus(run({ ok: false, cancelled: true }))).toBe("cancelled");
  });
  it("is failed when an error is present", () => {
    expect(runStatus(run({ ok: false, error: "boom" }))).toBe("failed");
  });
  it("treats a failure that was also cancelled as failed (failure wins)", () => {
    expect(runStatus(run({ ok: false, cancelled: true, error: "boom" }))).toBe("failed");
  });
});

describe("phaseLabel / isApply", () => {
  it("maps the backend phase strings to display labels", () => {
    expect(phaseLabel("preview")).toBe("Preview");
    expect(phaseLabel("execute")).toBe("Sync");
  });
  it("title-cases an unknown phase rather than dropping it", () => {
    expect(phaseLabel("weird")).toBe("Weird");
  });
  it("isApply is true only for an execute run", () => {
    expect(isApply(run({ phase: "execute" }))).toBe(true);
    expect(isApply(run({ phase: "preview" }))).toBe(false);
  });
});

describe("runTotals", () => {
  it("sums both sides across all pairs", () => {
    const r = run({
      pairs: [
        pair({
          entries_a: 10,
          entries_b: 5,
          errors_a: 1,
          errors_b: 0,
          skipped_a: 2,
          skipped_b: 0,
          scanned: 15,
        }),
        pair({
          entries_a: 3,
          entries_b: 4,
          errors_a: 0,
          errors_b: 2,
          skipped_a: 0,
          skipped_b: 1,
          scanned: 7,
        }),
      ],
    });
    expect(runTotals(r)).toEqual({ entries: 22, errors: 3, skipped: 3, scanned: 22 });
  });
  it("is all-zero for a run with no pairs", () => {
    expect(runTotals(run({ pairs: [] }))).toEqual({
      entries: 0,
      errors: 0,
      skipped: 0,
      scanned: 0,
    });
  });
});

describe("formatDuration", () => {
  it("renders sub-second in ms", () => {
    expect(formatDuration(500)).toBe("500ms");
  });
  it("renders seconds with one decimal", () => {
    expect(formatDuration(1500)).toBe("1.5s");
  });
  it("renders minutes and seconds past a minute", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
  });
  it("guards against a negative/NaN duration", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("formatRunTimestamp", () => {
  it("returns the raw string for an unparseable timestamp (never throws)", () => {
    expect(formatRunTimestamp("not-a-date")).toBe("not-a-date");
  });
  it("parses a valid RFC3339 timestamp into a non-empty local string", () => {
    expect(formatRunTimestamp("2026-06-26T00:00:00Z").length).toBeGreaterThan(0);
  });
});
