/* meaning.ts guard tests: every serde enum variant the UI colors MUST have a
 * meaning entry (keys driven from the Zod enums, so a new Rust variant fails the
 * guard until a meaning is added), and every color is a CSS var token (starts
 * with "--"), never an inline hex. */

import { describe, expect, it } from "vitest";
import {
  ACTION_MEANING,
  BASELINE_MEANING,
  CHANGE_MEANING,
  CONFLICT_MEANING,
  DELETION_MEANING,
  type Meaning,
  MODE_MEANING,
  STATUS_MEANING,
} from "./meaning";
import {
  zAction,
  zBaselineStatusKind,
  zChangeKind,
  zConflictType,
  zItemStatus,
  zSyncMode,
} from "./schemas";

/** Drive coverage from the Zod enum option lists (the serde variant strings). */
const cases: Array<[string, readonly string[], Record<string, Meaning>]> = [
  ["Action", zAction.options, ACTION_MEANING],
  ["ChangeKind", zChangeKind.options, CHANGE_MEANING],
  ["ConflictType", zConflictType.options, CONFLICT_MEANING],
  ["ItemStatus", zItemStatus.options, STATUS_MEANING],
  ["BaselineStatusKind", zBaselineStatusKind.options, BASELINE_MEANING],
  // zSyncMode is a default()-wrapped enum; unwrap() exposes the inner enum.
  ["SyncMode", zSyncMode.unwrap().options, MODE_MEANING],
];

describe("meaning coverage", () => {
  for (const [name, variants, map] of cases) {
    it(`every ${name} variant has a meaning`, () => {
      for (const v of variants) {
        expect(map[v], `${name} variant "${v}" lacks a meaning`).toBeDefined();
      }
      // No extra/stale keys either.
      expect(Object.keys(map).sort()).toEqual([...variants].sort());
    });
  }

  it("DeletionPolicy kinds (RecycleBin/Permanent) have meanings", () => {
    expect(Object.keys(DELETION_MEANING).sort()).toEqual(["Permanent", "RecycleBin"]);
  });
});

describe("meaning color tokens", () => {
  const allMeanings: Meaning[] = [
    ...Object.values(ACTION_MEANING),
    ...Object.values(CHANGE_MEANING),
    ...Object.values(CONFLICT_MEANING),
    ...Object.values(STATUS_MEANING),
    ...Object.values(BASELINE_MEANING),
    ...Object.values(MODE_MEANING),
    ...Object.values(DELETION_MEANING),
  ];

  it("every fg/bg/border is a CSS var token (starts with '--')", () => {
    for (const m of allMeanings) {
      expect(m.fg.startsWith("--"), `fg "${m.fg}" must be a var token`).toBe(true);
      expect(m.bg.startsWith("--"), `bg "${m.bg}" must be a var token`).toBe(true);
      expect(m.border.startsWith("--"), `border "${m.border}" must be a var token`).toBe(true);
    }
  });

  it("StateDesync is DANGER (refuse-to-act), fg == --danger-fg", () => {
    expect(CONFLICT_MEANING.StateDesync.fg).toBe("--danger-fg");
  });
});
