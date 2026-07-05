/* Schedules — the cross-job lens over every job's cron trigger (list_schedules),
 * with next-run ordering, pause/resume, run-now, and an inline add/edit editor.
 * A schedule lives ON its job (job.automation.schedule); this screen is a
 * management view. Policy color comes ONLY from meaning.ts. Read/write goes
 * through the ipc hooks — never invoke directly. */

import { Link } from "@tanstack/react-router";
import { CalendarClock, Pencil, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { Banner } from "../../components/primitives/Banner";
import { Button } from "../../components/primitives/Button";
import { EmptyState } from "../../components/primitives/EmptyState";
import { StatusDot } from "../../components/primitives/StatusDot";
import { Toggle } from "../../components/primitives/Toggle";
import { SCHEDULE_POLICY_MEANING } from "../../domain/meaning";
import {
  CRON_PRESETS,
  formatNextRun,
  looksLikeCron,
  newScheduleConfig,
  SCHEDULE_POLICIES,
  SCHEDULE_POLICY_DESC,
  SCHEDULE_POLICY_LABEL,
} from "../../domain/schedule";
import type { Job, ScheduleConfig, SchedulePolicy, ScheduleView } from "../../ipc/bindings";
import { errorMessage } from "../../ipc/errors";
import {
  useClearSchedule,
  usePauseSchedule,
  useRunScheduleNow,
  useSetSchedule,
} from "../../ipc/mutations";
import { useJobs, useSchedules, useSettings } from "../../ipc/queries";
import s from "./schedules.module.css";

/** The editor's target: a new schedule for a pickable job, or an existing one. */
type EditorTarget = { mode: "new" } | { mode: "edit"; jobId: string; jobName: string };

export function SchedulesList() {
  const { data: schedules, isLoading } = useSchedules();
  const { data: jobs } = useJobs();
  const { data: settings } = useSettings();
  const [editor, setEditor] = useState<EditorTarget | null>(null);

  const scheduledJobIds = new Set((schedules ?? []).map((v) => v.job_id));
  const unscheduledJobs = (jobs ?? []).filter((j) => !scheduledJobIds.has(j.id));
  const globallyPaused = settings != null && !settings.scheduler_enabled;

  if (!isLoading && (schedules?.length ?? 0) === 0 && editor == null) {
    return (
      <div className={s.page}>
        {globallyPaused && <GlobalPauseBanner />}
        <EmptyState
          icon={<CalendarClock size={28} />}
          title="No schedules yet"
          subline="Give a job a cron trigger and it runs on its own — safely: conflicts always defer, and a big-delete always aborts an unattended run."
          actions={
            (jobs?.length ?? 0) > 0 ? (
              <Button variant="primary" onClick={() => setEditor({ mode: "new" })}>
                New schedule
              </Button>
            ) : (
              <Link to="/jobs">
                <Button variant="primary">Create a job first</Button>
              </Link>
            )
          }
        />
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>Schedules</h1>
        {schedules && schedules.length > 0 && (
          <span className={s.count}>
            {schedules.length} schedule{schedules.length === 1 ? "" : "s"}
          </span>
        )}
        <span className={s.spacer} />
        {editor == null && unscheduledJobs.length > 0 && (
          <Button variant="primary" small onClick={() => setEditor({ mode: "new" })}>
            New schedule
          </Button>
        )}
      </div>

      {globallyPaused && <GlobalPauseBanner />}

      {editor != null && (
        <ScheduleEditor
          target={editor}
          unscheduledJobs={unscheduledJobs}
          existing={
            editor.mode === "edit"
              ? schedules?.find((v) => v.job_id === editor.jobId)?.schedule
              : undefined
          }
          onClose={() => setEditor(null)}
        />
      )}

      <div className={s.rows}>
        {(schedules ?? []).map((view) => (
          <ScheduleRow
            key={view.job_id}
            view={view}
            onEdit={() => setEditor({ mode: "edit", jobId: view.job_id, jobName: view.job_name })}
          />
        ))}
      </div>
    </div>
  );
}

function GlobalPauseBanner() {
  return (
    <Banner intent="warn">
      Scheduling is paused globally — no schedule will fire. Re-enable it in{" "}
      <Link to="/settings" className={s.inlineLink}>
        Settings
      </Link>
      .
    </Banner>
  );
}

function ScheduleRow({ view, onEdit }: { view: ScheduleView; onEdit: () => void }) {
  const pause = usePauseSchedule();
  const clear = useClearSchedule();
  const runNow = useRunScheduleNow();
  const { schedule } = view;
  const m = SCHEDULE_POLICY_MEANING[schedule.policy];
  const enabled = schedule.enabled;

  return (
    <div className={s.row} data-enabled={enabled}>
      <StatusDot
        color={enabled ? "--ok-fg" : "--text-faint"}
        title={enabled ? "active" : "paused"}
      />
      <span className={s.job} title={view.job_id}>
        {view.job_name}
      </span>
      <code className={s.cron}>{schedule.cron}</code>
      <span
        className={s.policy}
        style={{
          color: `var(${m.fg})`,
          borderColor: `var(${m.border})`,
          background: `var(${m.bg})`,
        }}
        title={SCHEDULE_POLICY_DESC[schedule.policy]}
      >
        {SCHEDULE_POLICY_LABEL[schedule.policy]}
      </span>
      <span className={s.next}>{enabled ? formatNextRun(view.next_run) : "paused"}</span>
      <span className={s.spacer} />
      <div className={s.rowControls}>
        <Toggle
          label=""
          checked={enabled}
          disabled={pause.isPending}
          onChange={(on) => pause.mutate({ jobId: view.job_id, paused: !on })}
        />
        <Button
          variant="ghost"
          small
          icon={<Play size={14} />}
          disabled={runNow.isPending}
          onClick={() => runNow.mutate(view.job_id)}
          title="Run this schedule now"
        >
          Run now
        </Button>
        <Button variant="icon" icon={<Pencil size={14} />} onClick={onEdit} title="Edit schedule" />
        <Button
          variant="icon"
          icon={<Trash2 size={14} />}
          disabled={clear.isPending}
          onClick={() => clear.mutate(view.job_id)}
          title="Remove schedule"
        />
      </div>
    </div>
  );
}

function ScheduleEditor({
  target,
  unscheduledJobs,
  existing,
  onClose,
}: {
  target: EditorTarget;
  unscheduledJobs: Job[];
  existing: ScheduleConfig | undefined;
  onClose: () => void;
}) {
  const setSchedule = useSetSchedule();
  const [jobId, setJobId] = useState(
    target.mode === "edit" ? target.jobId : (unscheduledJobs[0]?.id ?? ""),
  );
  const [cfg, setCfg] = useState<ScheduleConfig>(existing ?? newScheduleConfig());
  const [error, setError] = useState<string | null>(null);

  const canSave = jobId !== "" && looksLikeCron(cfg.cron) && !setSchedule.isPending;

  async function onSave() {
    setError(null);
    try {
      await setSchedule.mutateAsync({ jobId, schedule: cfg });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className={s.editor}>
      <div className={s.editorTitle}>
        {target.mode === "edit" ? `Edit schedule · ${target.jobName}` : "New schedule"}
      </div>

      {target.mode === "new" && (
        <div className={s.field}>
          <label className={s.fieldLabel} htmlFor="sched-job">
            Job
          </label>
          <select
            id="sched-job"
            className={s.select}
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
          >
            {unscheduledJobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className={s.field}>
        <label className={s.fieldLabel} htmlFor="sched-cron">
          Cron expression
        </label>
        <input
          id="sched-cron"
          className={s.cronInput}
          value={cfg.cron}
          spellCheck={false}
          onChange={(e) => setCfg({ ...cfg, cron: e.target.value })}
          placeholder="minute hour day-of-month month day-of-week"
        />
        <div className={s.presets}>
          {CRON_PRESETS.map((p) => (
            <button
              type="button"
              key={p.cron}
              className={s.preset}
              data-active={cfg.cron.trim() === p.cron}
              onClick={() => setCfg({ ...cfg, cron: p.cron })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className={s.fieldHint}>
          Standard 5-field cron, evaluated in your local time. e.g. <code>0 2 * * *</code> = every
          day at 02:00.
        </span>
      </div>

      <div className={s.field}>
        <label className={s.fieldLabel} htmlFor="sched-policy">
          When it fires, apply
        </label>
        <select
          id="sched-policy"
          className={s.select}
          value={cfg.policy}
          onChange={(e) => setCfg({ ...cfg, policy: e.target.value as SchedulePolicy })}
        >
          {SCHEDULE_POLICIES.map((p) => (
            <option key={p} value={p}>
              {SCHEDULE_POLICY_LABEL[p]}
            </option>
          ))}
        </select>
        <span className={s.fieldHint}>{SCHEDULE_POLICY_DESC[cfg.policy]}</span>
      </div>

      <Toggle
        label="Enabled"
        checked={cfg.enabled}
        onChange={(on) => setCfg({ ...cfg, enabled: on })}
      />

      {error && (
        <span className={s.error} role="alert">
          {error}
        </span>
      )}

      <div className={s.editorActions}>
        <Button variant="primary" disabled={!canSave} onClick={() => void onSave()}>
          {setSchedule.isPending ? "Saving…" : target.mode === "edit" ? "Save" : "Create schedule"}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
