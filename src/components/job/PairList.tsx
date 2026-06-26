/* The useFieldArray of FolderPairs inside the Job Editor form. Each pair: two
 * FolderPickers (root_a / root_b as EndpointPath Local), a label, an enabled
 * toggle, and an effective ModeBadge (pair mode_override ?? job direction,
 * collapsed to its SyncMode). Add / remove pairs mutates the field array, which
 * is what the submitted Job carries. No IPC.
 *
 * Complex (non-text) values — the EndpointPath roots, the enabled bool — are
 * written with RHF setValue (the documented way to set programmatic values),
 * not a register().onChange hack. */

import { Plus, Trash2 } from "lucide-react";
import { type Control, type UseFormSetValue, useFieldArray, useWatch } from "react-hook-form";
import type { Job } from "../../domain/job";
import { directionMode, newFolderPair } from "../../domain/job";
import { FolderPicker } from "../../features/jobs/FolderPicker";
import { Button } from "../primitives/Button";
import { Toggle } from "../primitives/Toggle";
import s from "./job.module.css";
import { ModeBadge } from "./ModeBadge";

interface Props {
  control: Control<Job>;
  setValue: UseFormSetValue<Job>;
}

export function PairList({ control, setValue }: Props) {
  const { fields, append, remove } = useFieldArray({ control, name: "pairs" });
  const jobDirection = useWatch({ control, name: "settings.direction" });

  return (
    <div className={s.pairs}>
      {fields.map((field, i) => (
        <PairCard
          key={field.id}
          control={control}
          setValue={setValue}
          index={i}
          jobDirection={jobDirection}
          canRemove={fields.length > 1}
          onRemove={() => remove(i)}
        />
      ))}
      <div>
        <Button type="button" onClick={() => append(newFolderPair())} icon={<Plus size={14} />}>
          Add folder pair
        </Button>
      </div>
    </div>
  );
}

interface CardProps {
  control: Control<Job>;
  setValue: UseFormSetValue<Job>;
  index: number;
  jobDirection: Job["settings"]["direction"];
  canRemove: boolean;
  onRemove: () => void;
}

function PairCard({ control, setValue, index, jobDirection, canRemove, onRemove }: CardProps) {
  const pair = useWatch({ control, name: `pairs.${index}` });
  const direction = pair?.mode_override ?? jobDirection;
  const mode = directionMode(direction);
  const enabled = pair?.enabled ?? true;
  const rootA = pair?.root_a?.kind === "Local" ? pair.root_a.path : "";
  const rootB = pair?.root_b?.kind === "Local" ? pair.root_b.path : "";

  const opts = { shouldDirty: true, shouldValidate: true } as const;

  return (
    <div className={s.pairCard} data-pair-index={index}>
      <div className={s.pairHeader}>
        <input
          className={s.textInput}
          placeholder="Pair label (optional)"
          aria-label={`Pair ${index} label`}
          value={pair?.label ?? ""}
          onChange={(e) => setValue(`pairs.${index}.label`, e.target.value, opts)}
        />
        <ModeBadge mode={mode} />
        <Button
          type="button"
          variant="icon"
          aria-label={`Remove pair ${index}`}
          disabled={!canRemove}
          onClick={onRemove}
          icon={<Trash2 size={15} />}
        />
      </div>

      <div className={s.pairRoots}>
        <FolderPicker
          label="Root A"
          side="a"
          value={rootA}
          onPick={(path) => setValue(`pairs.${index}.root_a`, { kind: "Local", path }, opts)}
        />
        <FolderPicker
          label="Root B"
          side="b"
          value={rootB}
          onPick={(path) => setValue(`pairs.${index}.root_b`, { kind: "Local", path }, opts)}
        />
      </div>

      <div className={s.pairFooter}>
        <Toggle
          label="Enabled"
          checked={enabled}
          onChange={(v) => setValue(`pairs.${index}.enabled`, v, opts)}
        />
      </div>
    </div>
  );
}
