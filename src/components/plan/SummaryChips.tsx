import type { PlanSummary } from "../../domain/plan";
import { Chip } from "../primitives/Chip";
import { Toggle } from "../primitives/Toggle";
import s from "./plan.module.css";

interface Props {
  summary: PlanSummary;
  conflictsBlock: number;
  showInSync: boolean;
  onShowInSync: (v: boolean) => void;
}

/** PlanSummary chips, meaning-colored, with the conflict-block callout and the
 * show-in-sync toggle. */
export function SummaryChips({ summary, conflictsBlock, showInSync, onShowInSync }: Props) {
  return (
    <div className={s.summary}>
      <Chip n={summary.copy_a_to_b} label="A → B" color="--copy-fg" />
      <Chip n={summary.copy_b_to_a} label="B → A" color="--copy-fg" />
      <Chip n={summary.delete_a + summary.delete_b} label="deletes" color="--del-fg" />
      <Chip n={summary.conflicts} label="conflicts" color="--conflict-fg" />
      <Chip n={summary.noop} label="in sync" color="--neutral-fg" />
      {summary.skipped > 0 && <Chip n={summary.skipped} label="skipped" color="--warn-fg" />}
      <span className={s.summaryGrow} />
      {conflictsBlock > 0 && (
        <span className={s.summaryCallout}>► {conflictsBlock} conflicts block apply</span>
      )}
      <Toggle label="show in-sync" checked={showInSync} onChange={onShowInSync} />
    </div>
  );
}
