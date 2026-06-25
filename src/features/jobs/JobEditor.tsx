/* Job Editor (routes /jobs/new and /jobs/$jobId/edit). React-Hook-Form over the
 * Job aggregate shape (job.rs serde, snake_case). Job-level: name/color, filter
 * (FilterEditor -> IgnorePolicy), deletion policy (RecycleBin | Permanent ONLY),
 * big-delete guard (pct / abs), direction (TwoWay; Mirror/Update with a one-way
 * caution), and a useFieldArray of FolderPairs (PairList).
 *
 * Per-field validity (blank name) blocks submit. Cross-pair structural issues
 * are the Rust save_job -> validate_pair_set; its InvalidJob error is surfaced
 * as a form-level banner. Submit -> useSaveJob, then back to /jobs. No invoke
 * here — only the useSaveJob mutation (which goes through ipc/commands). */

import { useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useNavigate } from "@tanstack/react-router";
import type {
  CompareMode,
  DeletionPolicy,
  Job,
  SyncDirection,
} from "../../domain/job";
import { directionMode, newJob } from "../../domain/job";
import { useSaveJob } from "../../ipc/mutations";
import { useJob } from "../../ipc/queries";
import { errorMessage } from "../../ipc/errors";
import { DELETION_MEANING, MODE_MEANING } from "../../domain/meaning";
import { Button } from "../../components/primitives/Button";
import { Banner } from "../../components/primitives/Banner";
import { FilterEditor } from "../../components/filter/FilterEditor";
import { PairList } from "../../components/job/PairList";
import s from "../../components/job/job.module.css";

const DELETION_KINDS: DeletionPolicy["kind"][] = ["RecycleBin", "Permanent"];

const DIRECTIONS: { value: SyncDirection; label: string }[] = [
  { value: "TwoWay", label: "Two-way (bidirectional)" },
  { value: "MirrorAtoB", label: "Mirror A → B" },
  { value: "MirrorBtoA", label: "Mirror B → A" },
  { value: "UpdateAtoB", label: "Update A → B" },
  { value: "UpdateBtoA", label: "Update B → A" },
];

const COMPARE_MODES: { value: CompareMode; label: string }[] = [
  { value: "TimeAndSize", label: "Time & size (fast)" },
  { value: "Content", label: "Content hash (thorough)" },
];

interface Props {
  /** When set, load + edit an existing job; otherwise a fresh job. */
  jobId?: string;
}

export function JobEditor({ jobId }: Props) {
  const navigate = useNavigate();
  const saveJob = useSaveJob();
  const existing = useJob(jobId);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Job>({
    defaultValues: newJob(),
    mode: "onBlur",
  });
  const { register, handleSubmit, control, setValue, reset, watch, formState } = form;

  // Hydrate the form once the existing job loads (edit route).
  useEffect(() => {
    if (jobId && existing.data) reset(existing.data);
  }, [jobId, existing.data, reset]);

  const direction = watch("settings.direction");
  const oneWay = direction !== "TwoWay";

  const onSubmit = handleSubmit(async (job) => {
    setFormError(null);
    try {
      await saveJob.mutateAsync(job);
      await navigate({ to: "/jobs" });
    } catch (e) {
      // Cross-pair structural failures (validate_pair_set) and any other
      // backend error surface here as a form-level banner.
      setFormError(errorMessage(e));
    }
  });

  return (
    <form className={s.editor} onSubmit={onSubmit} noValidate>
      <div className={s.editorHeader}>
        <h1 className={s.editorTitle}>{jobId ? "Edit job" : "New job"}</h1>
        <div className={s.editorActions}>
          <Button type="button" variant="ghost" onClick={() => void navigate({ to: "/jobs" })}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saveJob.isPending}>
            {saveJob.isPending ? "Saving…" : "Save job"}
          </Button>
        </div>
      </div>

      {formError && <Banner intent="danger">{formError}</Banner>}

      {/* Identity */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Job</h2>
        <div className={s.fieldRow}>
          <div className={s.field} style={{ flex: 1 }}>
            <label className={s.fieldLabel} htmlFor="job-name">
              Name
            </label>
            <input
              id="job-name"
              className={s.textInput}
              aria-invalid={Boolean(formState.errors.name)}
              {...register("name", {
                validate: (v) => v.trim().length > 0 || "Job name is required",
              })}
            />
            {formState.errors.name && (
              <span className={s.fieldError} role="alert">
                {formState.errors.name.message}
              </span>
            )}
          </div>
          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor="job-color">
              Color
            </label>
            <input
              id="job-color"
              type="color"
              className={s.colorInput}
              {...register("color")}
            />
          </div>
        </div>
      </section>

      {/* Filter */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Filter</h2>
        <p className={s.sectionHint}>
          Applies to every pair unless a pair overrides it.
        </p>
        <Controller
          control={control}
          name="settings.filter"
          render={({ field }) => (
            <FilterEditor value={field.value} onChange={field.onChange} idPrefix="job-filter" />
          )}
        />
      </section>

      {/* Behavior */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Behavior</h2>
        <div className={s.fieldRow}>
          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor="job-direction">
              Direction
            </label>
            <select id="job-direction" className={s.select} {...register("settings.direction")}>
              {DIRECTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor="job-compare">
              Compare
            </label>
            <select id="job-compare" className={s.select} {...register("settings.compare_mode")}>
              {COMPARE_MODES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor="job-deletion">
              Deleted files
            </label>
            <Controller
              control={control}
              name="settings.deletion"
              render={({ field }) => (
                <select
                  id="job-deletion"
                  className={s.select}
                  value={field.value.kind}
                  onChange={(e) =>
                    field.onChange({ kind: e.target.value as DeletionPolicy["kind"] })
                  }
                >
                  {DELETION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {DELETION_MEANING[k].glyph} {DELETION_MEANING[k].label}
                    </option>
                  ))}
                </select>
              )}
            />
          </div>
        </div>

        {oneWay && (
          <Banner intent="warn">
            One-way {MODE_MEANING[directionMode(direction)].label} sync: changes flow
            in a single direction.
            {direction.startsWith("Mirror")
              ? " Mirror makes the destination a faithful copy — extra files on the destination are deleted."
              : " Update is additive — it copies onto the destination but never deletes there."}
          </Banner>
        )}

        <div className={s.fieldRow}>
          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor="bd-pct">
              Big-delete guard — % of members
            </label>
            <input
              id="bd-pct"
              type="number"
              step="0.01"
              min="0"
              max="1"
              className={`${s.textInput} ${s.numInput}`}
              {...register("settings.big_delete.pct", { valueAsNumber: true })}
            />
          </div>
          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor="bd-abs">
              …or absolute count
            </label>
            <input
              id="bd-abs"
              type="number"
              step="1"
              min="0"
              className={`${s.textInput} ${s.numInput}`}
              {...register("settings.big_delete.abs", { valueAsNumber: true })}
            />
          </div>
        </div>
      </section>

      {/* Pairs */}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>Folder pairs</h2>
        <PairList control={control} setValue={setValue} />
      </section>
    </form>
  );
}
