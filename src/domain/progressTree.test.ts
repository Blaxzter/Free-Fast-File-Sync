/* progressTree (Phase A): the pure helpers behind the apply-phase folder tree.
 * Verifies the will-apply predicate mirrors apply.rs, per-folder totals, and the
 * status/clamp/ordering logic of buildFolderProgress. */

import { describe, expect, it } from "vitest";
import type { PlanItem } from "../ipc/bindings";
import { buildFolderProgress, folderTotals, topSegment, willApply } from "./progressTree";

function item(path: string, action: PlanItem["action"], extra: Partial<PlanItem> = {}): PlanItem {
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

describe("topSegment", () => {
  it("returns the first path segment, or '' for a root-level file", () => {
    expect(topSegment("Photos/2026/a.jpg")).toBe("Photos");
    expect(topSegment("dir/f")).toBe("dir");
    expect(topSegment("root.txt")).toBe("");
  });
});

describe("willApply (mirrors apply.rs effect_for/resolve_conflict)", () => {
  it("copies and deletes always apply", () => {
    expect(willApply(item("x", "CopyAtoB"))).toBe(true);
    expect(willApply(item("x", "CopyBtoA"))).toBe(true);
    expect(willApply(item("x", "DeleteA"))).toBe(true);
    expect(willApply(item("x", "DeleteB"))).toBe(true);
  });

  it("noop and baseline-only never apply", () => {
    expect(willApply(item("x", "Noop"))).toBe(false);
    expect(willApply(item("x", "UpdateBaselineOnly"))).toBe(false);
  });

  it("a conflict applies only when its chosen-or-default resolution is not Skip", () => {
    // no resolution, no default -> backend defaults to Skip -> no apply
    expect(willApply(item("x", "Conflict"))).toBe(false);
    // default drives it when no explicit choice
    expect(willApply(item("x", "Conflict", { default_resolution: "KeepNewer" }))).toBe(true);
    // explicit choice wins over default (Skip suppresses an otherwise-applying default)
    expect(willApply(item("x", "Conflict", { default_resolution: "KeepA" }), "Skip")).toBe(false);
    // explicit choice applies even with no default
    expect(willApply(item("x", "Conflict"), "KeepB")).toBe(true);
  });
});

describe("folderTotals", () => {
  it("counts only will-apply items, bucketed by top-level folder", () => {
    const items = [
      item("a/1", "CopyAtoB"),
      item("a/2", "DeleteB"),
      item("b/1", "CopyBtoA"),
      item("root.txt", "CopyAtoB"),
      item("c/skip", "Noop"),
      item("c/conf", "Conflict"), // no default -> Skip -> excluded
    ];
    const totals = folderTotals(items, {});
    expect(totals.get("a")).toBe(2);
    expect(totals.get("b")).toBe(1);
    expect(totals.get("")).toBe(1);
    expect(totals.has("c")).toBe(false);
  });
});

describe("buildFolderProgress", () => {
  const items = [
    item("a/1", "CopyAtoB"),
    item("a/2", "CopyAtoB"),
    item("b/1", "DeleteB"),
    item("root.txt", "CopyAtoB"),
  ];

  it("marks the active folder active, fully-tallied folders done, the rest pending", () => {
    const rows = buildFolderProgress(items, {}, { a: 2, b: 1 }, "b");
    // ordered: "" (root) first, then a, then b
    expect(rows.map((r) => r.name)).toEqual(["", "a", "b"]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName[""]).toMatchObject({ total: 1, done: 0, status: "pending" });
    expect(byName["a"]).toMatchObject({ total: 2, done: 2, status: "done" });
    // b is fully tallied but is the active folder -> active wins
    expect(byName["b"]).toMatchObject({ total: 1, done: 1, status: "active" });
  });

  it("clamps done to total so a late resolution edit can't render done > total", () => {
    const rows = buildFolderProgress(items, {}, { a: 5 }, null);
    expect(rows.find((r) => r.name === "a")).toMatchObject({ total: 2, done: 2 });
  });
});
