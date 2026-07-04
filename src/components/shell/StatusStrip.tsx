import { useStore } from "../../app/store";
import { useNow } from "../../app/useNow";
import { StatusDot } from "../primitives/StatusDot";
import s from "./shell.module.css";

/** Bottom status strip. During an apply it becomes a live progress readout fed
 * by the single sync://progress subscriber (Zustand run mirror). */
export function StatusStrip() {
  const phase = useStore((st) => st.run.phase);
  const progress = useStore((st) => st.run.progress);
  const scanned = useStore((st) => st.run.scanned);
  const startedAt = useStore((st) => st.run.startedAt);
  const planDone = useStore((st) => st.run.planDone);
  const planTotal = useStore((st) => st.run.planTotal);
  // Local clock so elapsed + rate keep moving between (bursty) scan events.
  const now = useNow(phase === "scanning");

  if (phase === "scanning") {
    // Post-scan disk-probe ("planning") sub-phase: the scan count is frozen, so
    // show DETERMINATE "checking files" progress instead of looking stuck.
    if (planTotal > 0) {
      const pct = (planDone / planTotal) * 100;
      return (
        <footer className={s.statusStrip}>
          <span className={s.statusItem}>
            <StatusDot color="--watch-fg" live />
            PLANNING
          </span>
          <div className={s.progressTrack}>
            <div className={s.progressFill} style={{ width: `${pct}%` }} />
          </div>
          <span className={s.statusMono}>
            checking {planDone.toLocaleString()}/{planTotal.toLocaleString()} files
          </span>
        </footer>
      );
    }
    // Scanning: indeterminate (no known total mid-scan); live count + throughput.
    const secs = startedAt ? (now - startedAt) / 1000 : 0;
    const rate = secs > 0.3 && scanned > 0 ? Math.round(scanned / secs) : 0;
    return (
      <footer className={s.statusStrip}>
        <span className={s.statusItem}>
          <StatusDot color="--watch-fg" live />
          SCANNING
        </span>
        <div className={s.progressIndet}>
          <div className={s.progressIndetBar} />
        </div>
        <span className={s.statusMono}>
          {scanned.toLocaleString()} items
          {secs >= 0.1 ? ` · ${secs.toFixed(1)}s` : ""}
          {rate > 0 ? ` · ${rate.toLocaleString()}/s` : ""}
        </span>
      </footer>
    );
  }

  if (phase === "applying" && progress) {
    const pct = progress.total ? (progress.done / progress.total) * 100 : 0;
    return (
      <footer className={s.statusStrip}>
        <span className={s.statusItem}>
          <StatusDot color="--accent" live />
          APPLYING
        </span>
        <div className={s.progressTrack}>
          <div className={s.progressFill} style={{ width: `${pct}%` }} />
        </div>
        <span className={s.statusMono}>
          {progress.done.toLocaleString()}/{progress.total.toLocaleString()} · {progress.path}
        </span>
      </footer>
    );
  }

  // The scanning phase returned above; only idle / applying-without-progress remain.
  const dotColor = phase === "applying" ? "--accent" : "--neutral-fg";
  const label = phase === "applying" ? "applying" : "idle";

  return (
    <footer className={s.statusStrip}>
      <span className={s.statusItem}>
        <StatusDot color={dotColor} live={phase !== "idle"} />
        engine {label}
      </span>
      <span className={s.statusItem}>0 watchers</span>
      <span className={s.statusItem}>no schedule</span>
      <span className={s.statusGrow} />
    </footer>
  );
}
