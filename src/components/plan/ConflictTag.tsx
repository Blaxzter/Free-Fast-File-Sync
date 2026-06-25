import type { ConflictType } from "../../domain/plan";
import { CONFLICT_MEANING } from "../../domain/meaning";
import s from "../primitives/primitives.module.css";
import p from "./plan.module.css";

/** Outlined sub-tag describing the ConflictType. StateDesync renders DANGER. */
export function ConflictTag({ type }: { type: ConflictType }) {
  const m = CONFLICT_MEANING[type];
  return (
    <span
      className={`${s.badgeOutline} ${p.conflictTag}`}
      style={{ color: `var(${m.fg})`, borderColor: `var(${m.border})` }}
      title={type}
    >
      <span>{m.glyph}</span>
      <span>{m.label}</span>
    </span>
  );
}
