import type { BigDeleteWarning } from "../../domain/plan";
import { Banner } from "../primitives/Banner";

interface Props {
  warning: BigDeleteWarning;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
}

/** Never-dismissible big-delete guard. The confirm checkbox wires to
 * execute_sync's confirm_big_delete; Apply stays blocked until it's checked. */
export function BigDeleteGate({ warning, confirmed, onConfirm }: Props) {
  return (
    <Banner intent="danger">
      <strong>Large deletion guard:</strong> this sync would delete{" "}
      {warning.deletions.toLocaleString()} of {warning.total_members.toLocaleString()} members (
      {Math.round(warning.pct * 100)}% &gt; {Math.round(warning.threshold_pct * 100)}%). Review
      before applying.
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-2)",
          marginTop: "var(--sp-3)",
        }}
      >
        <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} />
        I&apos;ve reviewed these — allow the deletions
      </label>
    </Banner>
  );
}
