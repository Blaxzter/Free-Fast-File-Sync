/* IgnorePolicy editor: gitignore / .ignore / hidden toggles + an editable glob
 * list (gitignore-syntax; a leading `!` re-includes). Controlled — the parent
 * (a RHF Controller) owns the value and pushes changes up via onChange. No IPC
 * here; purely a value transform over the config.rs IgnorePolicy shape. */

import { Plus, X } from "lucide-react";
import type { IgnorePolicy } from "../../ipc/bindings";
import s from "../job/job.module.css";
import { Button } from "../primitives/Button";
import { Toggle } from "../primitives/Toggle";

interface Props {
  value: IgnorePolicy;
  onChange: (next: IgnorePolicy) => void;
  /** Prefix for input ids/test handles so multiple editors don't collide. */
  idPrefix?: string;
}

export function FilterEditor({ value, onChange, idPrefix = "filter" }: Props) {
  function patch(p: Partial<IgnorePolicy>) {
    onChange({ ...value, ...p });
  }
  function setGlob(i: number, glob: string) {
    const next = value.custom_globs.slice();
    next[i] = glob;
    patch({ custom_globs: next });
  }
  function addGlob() {
    patch({ custom_globs: [...value.custom_globs, ""] });
  }
  function removeGlob(i: number) {
    patch({ custom_globs: value.custom_globs.filter((_, j) => j !== i) });
  }

  return (
    <div className={s.filter}>
      <div className={s.filterToggles}>
        <Toggle
          label="Respect .gitignore"
          checked={value.use_gitignore}
          onChange={(v) => patch({ use_gitignore: v })}
        />
        <Toggle
          label="Respect .ignore"
          checked={value.use_dot_ignore}
          onChange={(v) => patch({ use_dot_ignore: v })}
        />
        <Toggle
          label="Include hidden / dotfiles"
          checked={value.include_hidden}
          onChange={(v) => patch({ include_hidden: v })}
        />
      </div>

      <div className={s.field}>
        <span className={s.fieldLabel}>Exclude globs</span>
        <div className={s.globList}>
          {value.custom_globs.map((glob, i) => (
            <div className={s.globRow} key={i}>
              <input
                className={s.textInput}
                value={glob}
                placeholder="e.g. node_modules/ or !keep.txt"
                aria-label={`${idPrefix} glob ${i}`}
                onChange={(e) => setGlob(i, e.target.value)}
              />
              <Button
                type="button"
                variant="icon"
                aria-label={`Remove glob ${i}`}
                onClick={() => removeGlob(i)}
                icon={<X size={14} />}
              />
            </div>
          ))}
          <div>
            <Button type="button" small onClick={addGlob} icon={<Plus size={14} />}>
              Add glob
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
