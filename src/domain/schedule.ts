/* Pure frontend helpers for the Schedules screen: policy copy, cron presets, the
 * local UTC offset the backend cron evaluator wants, and next-run formatting. No
 * React, no IPC. The AUTHORITATIVE cron evaluation is the Rust `cron` module; these
 * are display/UX helpers only. */

import type { ScheduleConfig, SchedulePolicy } from "../ipc/bindings";

/** Human label per schedule policy. */
export const SCHEDULE_POLICY_LABEL: Record<SchedulePolicy, string> = {
  PreviewOnly: "Preview only",
  ApplySafe: "Apply safe (no deletes)",
  ApplyAll: "Apply all (deletes on)",
};

/** One-line description of what each policy does, unattended. */
export const SCHEDULE_POLICY_DESC: Record<SchedulePolicy, string> = {
  PreviewOnly:
    "Scan and record what changed, but write nothing. Anything actionable waits for you in Activity.",
  ApplySafe: "Apply copies and updates; never delete. Deletes and conflicts always defer.",
  ApplyAll:
    "Full sync minus conflicts: copies, updates, and deletes all apply. A big-delete trip aborts the run; conflicts always defer.",
};

/** Offered order (default first). */
export const SCHEDULE_POLICIES: SchedulePolicy[] = ["ApplyAll", "ApplySafe", "PreviewOnly"];

export interface CronPreset {
  label: string;
  cron: string;
}

/** One-click cron presets for the editor (standard 5-field). */
export const CRON_PRESETS: CronPreset[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily · 2am", cron: "0 2 * * *" },
  { label: "Weekdays · 9am", cron: "0 9 * * 1-5" },
  { label: "Every 15 min", cron: "*/15 * * * *" },
  { label: "Weekly · Sun 3am", cron: "0 3 * * 0" },
];

/** The browser's current UTC offset in MINUTES (local = UTC + offset), the value
 * the backend cron evaluator expects. `getTimezoneOffset()` returns minutes BEHIND
 * UTC (positive west of UTC), so negate it: Berlin summer => +120. */
export function localOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/** A fresh schedule with the browser's offset baked in and the recommended default
 * policy, for the "New schedule" editor. */
export function newScheduleConfig(): ScheduleConfig {
  return {
    enabled: true,
    cron: "0 2 * * *",
    tz_offset_minutes: localOffsetMinutes(),
    policy: "ApplyAll",
    skip_if_watched: false,
  };
}

/** Format an RFC3339 next-run instant as compact "relative · HH:MM", e.g.
 * "in 3h · 02:00". Missing/invalid => "—". */
export function formatNextRun(rfc3339: string | undefined, now = Date.now()): string {
  if (!rfc3339) return "—";
  const t = Date.parse(rfc3339);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${relativeShort(t - now)} · ${hh}:${mm}`;
}

function relativeShort(ms: number): string {
  if (ms <= 0) return "due";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

/** Cheap sanity check mirroring the backend's 5-field requirement, so the editor
 * can disable Save before a round-trip. The backend `set_schedule` is authoritative
 * (it fully parses and rejects a bad cron). */
export function looksLikeCron(cron: string): boolean {
  return cron.trim().split(/\s+/).length === 5;
}
