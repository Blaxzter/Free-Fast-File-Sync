import { CHANGE_MEANING } from "../../domain/meaning";
import type { ChangeKind } from "../../domain/plan";
import s from "./plan.module.css";

/** Bare meaning glyph + 1ch label for an A/B change cell. */
export function ChangeGlyph({ change }: { change: ChangeKind }) {
  const m = CHANGE_MEANING[change];
  return (
    <span className={s.changeGlyph} style={{ color: `var(${m.fg})` }} title={change}>
      <span>{m.glyph}</span>
      {change !== "Unchanged" && <span>{m.label}</span>}
    </span>
  );
}
