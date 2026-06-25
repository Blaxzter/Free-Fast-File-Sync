import { useStore } from "../../app/store";
import { StatusDot } from "../primitives/StatusDot";
import s from "./shell.module.css";

/** Bottom status strip. During an apply it becomes a live progress readout fed
 * by the single sync://progress subscriber (Zustand run mirror). */
export function StatusStrip() {
  const phase = useStore((st) => st.run.phase);
  const progress = useStore((st) => st.run.progress);

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

  const dotColor =
    phase === "scanning" ? "--watch-fg" : phase === "applying" ? "--accent" : "--neutral-fg";
  const label = phase === "scanning" ? "scanning" : phase === "applying" ? "applying" : "idle";

  return (
    <footer className={s.statusStrip}>
      <span className={s.statusItem}>
        <StatusDot color={dotColor} live={phase !== "idle"} />
        engine {label}
      </span>
      <span className={s.statusItem}>0 watchers</span>
      <span className={s.statusItem}>no schedule</span>
      <span className={s.statusGrow} />
      <span className={s.statusItem}>single-pair · Phase 0</span>
    </footer>
  );
}
