import { describe, expect, it } from "vitest";
import { formatNextRun, looksLikeCron, newScheduleConfig, SCHEDULE_POLICIES } from "./schedule";

describe("looksLikeCron", () => {
  it("accepts a standard 5-field expression (whitespace-tolerant)", () => {
    expect(looksLikeCron("0 2 * * *")).toBe(true);
    expect(looksLikeCron("  */15 * * * 1-5  ")).toBe(true);
  });
  it("rejects the wrong field count", () => {
    expect(looksLikeCron("* * * *")).toBe(false);
    expect(looksLikeCron("* * * * * *")).toBe(false);
    expect(looksLikeCron("")).toBe(false);
  });
});

describe("formatNextRun", () => {
  const base = Date.parse("2026-01-01T00:00:00Z");

  it("shows a relative minute/hour/day distance", () => {
    expect(formatNextRun(new Date(base + 30 * 60_000).toISOString(), base)).toMatch(/^in 30m · /);
    expect(formatNextRun(new Date(base + 3 * 3_600_000).toISOString(), base)).toMatch(/^in 3h/);
    expect(formatNextRun(new Date(base + 3 * 86_400_000).toISOString(), base)).toMatch(/^in 3d/);
  });

  it("says 'due' for a past instant", () => {
    expect(formatNextRun(new Date(base - 1000).toISOString(), base)).toMatch(/^due/);
  });

  it("returns a dash for missing/invalid input", () => {
    expect(formatNextRun(undefined)).toBe("—");
    expect(formatNextRun("not-a-date")).toBe("—");
  });
});

describe("newScheduleConfig", () => {
  it("defaults to the recommended ApplyAll policy and a valid cron", () => {
    const c = newScheduleConfig();
    expect(c.policy).toBe("ApplyAll");
    expect(c.enabled).toBe(true);
    expect(looksLikeCron(c.cron)).toBe(true);
    expect(typeof c.tz_offset_minutes).toBe("number");
  });

  it("offers ApplyAll first in the policy list", () => {
    expect(SCHEDULE_POLICIES[0]).toBe("ApplyAll");
  });
});
