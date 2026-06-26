import { ACTION_MEANING } from "../../domain/meaning";
import type { Action } from "../../domain/plan";
import s from "../primitives/primitives.module.css";

/** Filled meaning badge for the resolved Action. Color comes only from the map. */
export function ActionBadge({ action }: { action: Action }) {
  const m = ACTION_MEANING[action];
  return (
    <span className={s.badge} style={{ color: `var(${m.fg})`, background: `var(${m.bg})` }}>
      {m.label}
    </span>
  );
}
