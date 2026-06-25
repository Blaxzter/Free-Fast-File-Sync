import type { Resolution } from "../../domain/plan";
import { RESOLUTION_LABEL } from "../../domain/meaning";
import s from "../primitives/primitives.module.css";

interface Props {
  options: Resolution[];
  value: Resolution | undefined;
  onChange: (r: Resolution) => void;
}

/** Inline conflict-resolution picker. Options from PlanItem.resolution_options,
 * default preselected from PlanItem.default_resolution. */
export function ResolutionSelect({ options, value, onChange }: Props) {
  return (
    <select
      className={s.select}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value as Resolution)}
    >
      {options.map((r) => (
        <option key={r} value={r}>
          {RESOLUTION_LABEL[r] ?? r}
        </option>
      ))}
    </select>
  );
}
