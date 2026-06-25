/* Pure plan-selector tests: rank/visibility ordering, conflict default prefill,
 * unresolved counting, the actionable-vs-applicable distinction, and byte
 * formatting boundaries. No React, no IPC. */

import { describe, expect, it } from "vitest";
import type { Action, PlanItem, Resolution, SyncPlan } from "./plan";
import {
  actionableCount,
  applicableCount,
  defaultResolutions,
  formatBytes,
  rank,
  unresolvedConflicts,
  visibleItems,
} from "./plan";

function item(path: string, action: Action, extra: Partial<PlanItem> = {}): PlanItem {
  return {
    path,
    action,
    a_change: "Unchanged",
    b_change: "Unchanged",
    resolution_options: [],
    note: "",
    ...extra,
  };
}

function plan(items: PlanItem[]): SyncPlan {
  const copy_a_to_b = items.filter((i) => i.action === "CopyAtoB").length;
  const copy_b_to_a = items.filter((i) => i.action === "CopyBtoA").length;
  const delete_a = items.filter((i) => i.action === "DeleteA").length;
  const delete_b = items.filter((i) => i.action === "DeleteB").length;
  const conflicts = items.filter((i) => i.action === "Conflict").length;
  const baseline_only = items.filter((i) => i.action === "UpdateBaselineOnly").length;
  const noop = items.filter((i) => i.action === "Noop").length;
  return {
    root_a: "a",
    root_b: "b",
    items,
    summary: {
      total: items.length,
      copy_a_to_b,
      copy_b_to_a,
      delete_a,
      delete_b,
      conflicts,
      baseline_only,
      noop,
      skipped: 0,
    },
    baseline_status: "Present",
    warnings: [],
  };
}

describe("rank / visibleItems", () => {
  it("ranks conflicts first, deletes next, copies after, in-sync last", () => {
    expect(rank(item("x", "Conflict"))).toBe(0);
    expect(rank(item("x", "DeleteA"))).toBe(1);
    expect(rank(item("x", "DeleteB"))).toBe(1);
    expect(rank(item("x", "CopyAtoB"))).toBe(2);
    expect(rank(item("x", "Noop"))).toBe(9);
    expect(rank(item("x", "UpdateBaselineOnly"))).toBe(9);
  });

  it("hides in-sync rows unless showInSync, sorted by rank then path", () => {
    const p = plan([
      item("z-copy", "CopyAtoB"),
      item("a-noop", "Noop"),
      item("m-conflict", "Conflict"),
      item("b-baseline", "UpdateBaselineOnly"),
    ]);

    const hidden = visibleItems(p, false);
    expect(hidden.map((i) => i.path)).toEqual(["m-conflict", "z-copy"]);

    const shown = visibleItems(p, true);
    // conflict (0) < copy (2) < in-sync (9, ties broken by path).
    expect(shown.map((i) => i.path)).toEqual([
      "m-conflict",
      "z-copy",
      "a-noop",
      "b-baseline",
    ]);
  });
});

describe("defaultResolutions / unresolvedConflicts", () => {
  it("prefills each conflict from its default_resolution", () => {
    const p = plan([
      item("c1", "Conflict", { default_resolution: "KeepNewer" }),
      item("c2", "Conflict"), // no default -> not prefilled
      item("copy", "CopyAtoB", { default_resolution: "KeepA" }), // non-conflict ignored
    ]);
    const res = defaultResolutions(p);
    expect(res).toEqual({ c1: "KeepNewer" });
  });

  it("counts conflicts still missing a resolution", () => {
    const p = plan([
      item("c1", "Conflict", { default_resolution: "KeepNewer" }),
      item("c2", "Conflict"),
    ]);
    const res = defaultResolutions(p); // resolves c1 only
    expect(unresolvedConflicts(p, res)).toBe(1);

    const chosen: Record<string, Resolution> = { ...res, c2: "KeepA" };
    expect(unresolvedConflicts(p, chosen)).toBe(0);
  });
});

describe("actionableCount vs applicableCount", () => {
  it("actionable excludes noop and baseline-only; applicable excludes only noop", () => {
    const p = plan([
      item("copy", "CopyAtoB"),
      item("del", "DeleteB"),
      item("conf", "Conflict"),
      item("base", "UpdateBaselineOnly"),
      item("noop", "Noop"),
    ]);
    // total 5, noop 1, baseline_only 1.
    expect(actionableCount(p)).toBe(3); // copy + del + conflict
    expect(applicableCount(p)).toBe(4); // + baseline-only convergence
  });
});

describe("formatBytes boundaries", () => {
  it("formats zero/negative as em dash", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(-5)).toBe("—");
  });

  it("formats bytes and unit boundaries", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 kB");
    expect(formatBytes(1536)).toBe("1.5 kB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(100 * 1024)).toBe("100 kB"); // >=100 -> no decimal
  });
});
