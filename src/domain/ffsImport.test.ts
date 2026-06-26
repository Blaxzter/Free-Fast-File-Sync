import { describe, expect, it } from "vitest";
import type { FfsImport, ImportedJob } from "../ipc/bindings";
import { jobFromFfsImport } from "./ffsImport";

function pair(over: Partial<ImportedJob>): ImportedJob {
  return {
    name: "NAS",
    left: "C:\\src",
    right: "\\\\NAS\\dst",
    two_way: true,
    use_recycle_bin: true,
    verify_by_hash: false,
    exclude_globs: [],
    warnings: [],
    ...over,
  };
}

// Mirrors the user's real config: 2 two-way + 1 one-way mirror, all recycle bin.
const sample: FfsImport = {
  jobs: [
    pair({
      left: "C:\\Users\\me\\Documents\\ShareX\\Screenshots",
      right: "\\\\NAS\\home\\Screenshots",
      exclude_globs: ["node_modules/"],
    }),
    pair({
      left: "E:\\MyDocuments",
      right: "\\\\NAS\\home\\MyDocuments",
      exclude_globs: ["*.tmp", "cache/"],
    }),
    pair({
      left: "E:\\Programming",
      right: "\\\\NAS\\home\\Programming",
      two_way: false,
      exclude_globs: ["target/"],
    }),
  ],
  notes: [],
};

describe("jobFromFfsImport", () => {
  it("builds one unsaved multi-pair Job (blank ids, name from the config)", () => {
    const job = jobFromFfsImport(sample);
    expect(job.id).toBe("");
    expect(job.created_at).toBe("");
    expect(job.name).toBe("NAS");
    expect(job.pairs).toHaveLength(3);
    expect(job.pairs.every((p) => p.id === "")).toBe(true);
  });

  it("maps roots, derives a basename label, and enables each pair", () => {
    const [p0, , p2] = jobFromFfsImport(sample).pairs;
    expect(p0.root_a).toEqual({
      kind: "Local",
      path: "C:\\Users\\me\\Documents\\ShareX\\Screenshots",
    });
    expect(p0.root_b).toEqual({ kind: "Local", path: "\\\\NAS\\home\\Screenshots" });
    expect(p0.label).toBe("Screenshots");
    expect(p2.label).toBe("Programming");
    expect(p0.enabled).toBe(true);
  });

  it("takes the job default from the first pair and overrides only the differing pair", () => {
    const job = jobFromFfsImport(sample);
    expect(job.settings.direction).toBe("TwoWay");
    expect(job.pairs[0].mode_override).toBeUndefined(); // matches default
    expect(job.pairs[1].mode_override).toBeUndefined();
    expect(job.pairs[2].mode_override).toBe("MirrorAtoB"); // one-way mirror
  });

  it("carries excludes as a per-pair filter override with gitignore still ON", () => {
    const f = jobFromFfsImport(sample).pairs[0].filter_override;
    expect(f?.use_gitignore).toBe(true);
    expect(f?.custom_globs).toEqual(["node_modules/"]);
  });

  it("keeps recycle bin at job level with no per-pair override when uniform", () => {
    const job = jobFromFfsImport(sample);
    expect(job.settings.deletion).toEqual({ kind: "RecycleBin" });
    expect(job.pairs.every((p) => p.deletion_override === undefined)).toBe(true);
  });

  it("overrides deletion only for a pair that differs (permanent)", () => {
    const job = jobFromFfsImport({
      jobs: [pair({}), pair({ use_recycle_bin: false })],
      notes: [],
    });
    expect(job.settings.deletion).toEqual({ kind: "RecycleBin" });
    expect(job.pairs[1].deletion_override).toEqual({ kind: "Permanent" });
  });

  it("uses Content compare only when every pair asked for it", () => {
    expect(jobFromFfsImport(sample).settings.compare_mode).toBe("TimeAndSize");
    const allHash = jobFromFfsImport({
      jobs: [pair({ verify_by_hash: true }), pair({ verify_by_hash: true })],
      notes: [],
    });
    expect(allHash.settings.compare_mode).toBe("Content");
  });

  it("falls back to a default name and TwoWay on an empty import", () => {
    const job = jobFromFfsImport({ jobs: [], notes: [] });
    expect(job.name).toBe("FreeFileSync import");
    expect(job.settings.direction).toBe("TwoWay");
    expect(job.pairs).toHaveLength(0);
  });
});
