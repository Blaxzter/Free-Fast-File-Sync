/* Mode badge: renders a SyncMode (engine axis) using MODE_MEANING ONLY — no
 * hardcoded color. Used in the job editor / pair headers to show which way a
 * pair runs. The five-way SyncDirection is collapsed to its SyncMode via
 * directionMode() before this renders. */

import type { SyncMode } from "../../ipc/bindings";
import { MODE_MEANING } from "../../domain/meaning";
import s from "./job.module.css";

interface Props {
  mode: SyncMode;
}

export function ModeBadge({ mode }: Props) {
  const m = MODE_MEANING[mode];
  return (
    <span
      className={s.modeBadge}
      data-mode={mode}
      style={{
        color: `var(${m.fg})`,
        background: `var(${m.bg})`,
        borderColor: `var(${m.border})`,
      }}
      title={m.label}
    >
      {m.glyph && <span aria-hidden>{m.glyph}</span>}
      {m.label}
    </span>
  );
}
