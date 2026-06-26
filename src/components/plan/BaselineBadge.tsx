import { BASELINE_MEANING } from "../../domain/meaning";
import type { BaselineStatusKind } from "../../domain/plan";
import s from "./plan.module.css";

/** Job-level baseline trust badge. Safety-amber/cyan when not Present. */
export function BaselineBadge({ status }: { status: BaselineStatusKind }) {
  const m = BASELINE_MEANING[status];
  return (
    <span
      className={s.baselineBadge}
      style={{ color: `var(${m.fg})`, borderColor: `var(${m.border})`, background: `var(${m.bg})` }}
    >
      {m.label}
    </span>
  );
}
