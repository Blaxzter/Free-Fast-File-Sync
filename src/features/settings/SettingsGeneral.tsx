import { Link } from "@tanstack/react-router";
import { useStore } from "../../app/store";
import { Toggle } from "../../components/primitives/Toggle";
import { Button } from "../../components/primitives/Button";
import s from "./settings.module.css";

/** Settings — General / Defaults. Density toggle is live; the rest are the
 * documented global-default surfaces (read-only placeholders in Phase 0). */
export function SettingsGeneral() {
  const density = useStore((st) => st.density);
  const setDensity = useStore((st) => st.setDensity);

  function applyDensity(next: "compact" | "cozy") {
    setDensity(next);
    document.documentElement.setAttribute("data-density", next);
  }

  return (
    <div className={s.page}>
      <div className={s.section}>
        <span className={s.sectionTitle}>Appearance</span>
        <Toggle
          label="Cozy density (taller rows)"
          checked={density === "cozy"}
          onChange={(v) => applyDensity(v ? "cozy" : "compact")}
        />
      </div>

      <div className={s.section}>
        <span className={s.sectionTitle}>Defaults for new jobs</span>
        <span className={s.sectionDesc}>
          Compare mode, deletion policy, gitignore-on, and big-delete thresholds inherited by new
          jobs. Editing these lands with the Job aggregate in a later phase. Current engine defaults:
          gitignore on, deletions to recycle bin, big-delete guard at 25% or 100 files.
        </span>
      </div>

      <div className={s.section}>
        <span className={s.sectionTitle}>Migrate</span>
        <span className={s.sectionDesc}>Bring folder pairs over from FreeFileSync.</span>
        <div>
          <Link to="/settings/import">
            <Button variant="secondary">Import from FreeFileSync…</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
