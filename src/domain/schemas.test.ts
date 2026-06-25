/* Boundary-schema tests: the Zod parsers must accept the exact serde shapes the
 * Rust engine emits and reject drift (unknown enum variants / wrong kinds), so a
 * backend change that breaks the contract fails loudly here, not in the UI. */

import { describe, expect, it } from "vitest";
import {
  zDeletionPolicy,
  zJob,
  zPreviewJobResult,
  zSyncMode,
  zSyncPlan,
} from "./schemas";

/** A captured preview fixture shaped like model.rs SyncPlan serde output,
 * including a conflict row whose resolution_options serde skips when empty (the
 * Noop row) so we exercise the `.default([])` path. */
const previewFixture = {
  root_a: "C:/data/a",
  root_b: "C:/data/b",
  items: [
    {
      path: "docs/readme.md",
      action: "Conflict",
      conflict: "EditEdit",
      a_change: "Modified",
      b_change: "Modified",
      a: { kind: "File", size: 120, mtime_ns: 1700000000000000000 },
      b: { kind: "File", size: 130, mtime_ns: 1700000001000000000 },
      base: { kind: "File", size: 100, mtime_ns: 1699999999000000000 },
      default_resolution: "KeepNewer",
      resolution_options: ["KeepA", "KeepB", "KeepNewer", "KeepBoth", "Skip"],
      note: "both edited",
    },
    {
      // serde skips resolution_options when empty -> the field is absent here.
      path: "docs/new.txt",
      action: "CopyAtoB",
      a_change: "Created",
      b_change: "Unchanged",
      a: { kind: "File", size: 10, mtime_ns: 1700000002000000000 },
      note: "new on A",
    },
    {
      path: "docs/same.txt",
      action: "Noop",
      a_change: "Unchanged",
      b_change: "Unchanged",
      note: "",
    },
  ],
  summary: {
    total: 3,
    copy_a_to_b: 1,
    copy_b_to_a: 0,
    delete_a: 0,
    delete_b: 0,
    conflicts: 1,
    baseline_only: 0,
    noop: 1,
    skipped: 0,
  },
  baseline_status: "Present",
  warnings: [],
};

const sampleJob = {
  id: "01JOBULID00000000000000000",
  name: "Docs",
  color: "#abc",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  settings: {
    compare_mode: "TimeAndSize",
    direction: "TwoWay",
    deletion: { kind: "RecycleBin" },
    big_delete: { pct: 0.25, abs: 100 },
    filter: {
      use_gitignore: true,
      use_dot_ignore: true,
      include_hidden: false,
      custom_globs: [],
    },
  },
  pairs: [
    {
      id: "01PAIR0000000000000000001A",
      label: "docs",
      root_a: { kind: "Local", path: "C:/data/a" },
      root_b: { kind: "Local", path: "C:/data/b" },
      enabled: true,
    },
  ],
};

describe("zSyncPlan", () => {
  it("parses a captured preview fixture and defaults resolution_options to []", () => {
    const plan = zSyncPlan.parse(previewFixture);
    expect(plan.items).toHaveLength(3);
    // The CopyAtoB row had no resolution_options key -> defaulted to [].
    expect(plan.items[1].resolution_options).toEqual([]);
    // The conflict row keeps its options.
    expect(plan.items[0].resolution_options).toContain("KeepNewer");
    expect(plan.summary.conflicts).toBe(1);
  });

  it("rejects an unknown action variant (action: 'Frobnicate')", () => {
    const bad = {
      ...previewFixture,
      items: [{ ...previewFixture.items[2], action: "Frobnicate" }],
    };
    expect(zSyncPlan.safeParse(bad).success).toBe(false);
  });
});

describe("zSyncMode", () => {
  it("round-trips each Rust variant", () => {
    for (const m of ["TwoWay", "Mirror", "Update"]) {
      expect(zSyncMode.parse(m)).toBe(m);
    }
  });

  it("defaults to TwoWay when the field is missing", () => {
    expect(zSyncMode.parse(undefined)).toBe("TwoWay");
  });

  it("rejects an unknown mode", () => {
    expect(zSyncMode.safeParse("Sideways").success).toBe(false);
  });

  it("option list equals the Rust model.rs SyncMode variant strings", () => {
    // model.rs: enum SyncMode { TwoWay, Mirror, Update }. zSyncMode is
    // default()-wrapped; unwrap() exposes the inner enum's options.
    expect(zSyncMode.unwrap().options).toEqual(["TwoWay", "Mirror", "Update"]);
  });
});

describe("zJob", () => {
  it("round-trips a sample job", () => {
    const job = zJob.parse(sampleJob);
    expect(job.name).toBe("Docs");
    expect(job.pairs[0].root_a).toEqual({ kind: "Local", path: "C:/data/a" });
    expect(job.settings.deletion.kind).toBe("RecycleBin");
  });

  it("rejects an unknown direction", () => {
    const bad = { ...sampleJob, settings: { ...sampleJob.settings, direction: "Diagonal" } };
    expect(zJob.safeParse(bad).success).toBe(false);
  });
});

describe("zDeletionPolicy", () => {
  it("accepts RecycleBin and Permanent", () => {
    expect(zDeletionPolicy.parse({ kind: "RecycleBin" }).kind).toBe("RecycleBin");
    expect(zDeletionPolicy.parse({ kind: "Permanent" }).kind).toBe("Permanent");
  });

  it("rejects an unknown kind (e.g. retired Versioning)", () => {
    expect(zDeletionPolicy.safeParse({ kind: "Versioning", archiveDir: "x" }).success).toBe(false);
  });
});

describe("zPreviewJobResult", () => {
  it("parses a run with one pair preview", () => {
    const result = zPreviewJobResult.parse({
      run_id: "01RUNULID0000000000000000",
      pairs: [
        {
          pair_id: "01PAIR0000000000000000001A",
          plan: previewFixture,
          baseline_status: "Present",
        },
      ],
    });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].pair_id).toBe("01PAIR0000000000000000001A");
    expect(result.pairs[0].plan.summary.total).toBe(3);
  });
});
