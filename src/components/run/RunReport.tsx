import type { ApplyReport } from "../../domain/plan";
import { formatBytes } from "../../domain/plan";
import { Banner } from "../primitives/Banner";
import { Chip } from "../primitives/Chip";

/** Renders an ApplyReport: meaning-colored summary chips + a failure banner. */
export function RunReport({ report }: { report: ApplyReport }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      {report.failed > 0 ? (
        <Banner intent="danger">
          {report.failed} action(s) failed — review the outcomes below.
        </Banner>
      ) : (
        <Banner intent="ok">
          Synced: {report.done.toLocaleString()} applied · {formatBytes(report.bytes_copied)} ·{" "}
          {report.skipped} skipped · {report.conflicts} unresolved.
        </Banner>
      )}
      <div style={{ display: "flex", gap: "var(--sp-3)", flexWrap: "wrap" }}>
        <Chip n={report.done} label="done" color="--ok-fg" />
        <Chip n={report.failed} label="failed" color="--danger-fg" />
        <Chip n={report.skipped} label="skipped" color="--neutral-fg" />
        <Chip n={report.conflicts} label="conflicts" color="--conflict-fg" />
      </div>
    </div>
  );
}
