import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useStore } from "../../app/store";
import { Button } from "../../components/primitives/Button";
import { Toggle } from "../../components/primitives/Toggle";
import type { Settings } from "../../ipc/bindings";
import { errorMessage } from "../../ipc/errors";
import { useSaveSettings } from "../../ipc/mutations";
import { useSettings } from "../../ipc/queries";
import s from "./settings.module.css";

const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

/** Settings — General / Defaults. The density toggle is local UI state; the global
 * engine defaults (scan threads, mtime granularity, ticker, log level) round-trip
 * through get_settings / save_settings. A job can override the thread count and
 * granularity in the Job editor. */
export function SettingsGeneral() {
  const density = useStore((st) => st.density);
  const setDensity = useStore((st) => st.setDensity);
  const settingsQuery = useSettings();
  const saveSettings = useSaveSettings();

  const [form, setForm] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed/refresh the editable form from the server value.
  useEffect(() => {
    if (settingsQuery.data) setForm(settingsQuery.data);
  }, [settingsQuery.data]);

  function applyDensity(next: "compact" | "cozy") {
    setDensity(next);
    document.documentElement.setAttribute("data-density", next);
  }

  const dirty =
    form != null &&
    settingsQuery.data != null &&
    JSON.stringify(form) !== JSON.stringify(settingsQuery.data);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setSaved(false);
  }

  /** Parse a number input to a non-negative integer (blank/invalid => 0). */
  function intField(v: string): number {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  async function onSave() {
    if (!form) return;
    setError(null);
    try {
      await saveSettings.mutateAsync(form);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
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
        <span className={s.sectionTitle}>Scan &amp; performance</span>
        <span className={s.sectionDesc}>
          Defaults for every job; a job can override the thread count and granularity in its editor.
          Network shares (SMB/NAS) are sensitive to too many concurrent walker threads — if a large
          scan stalls, lower the thread count here.
        </span>
        {form == null ? (
          <span className={s.sectionDesc}>Loading…</span>
        ) : (
          <div className={s.form}>
            <div className={s.field}>
              <label className={s.fieldLabel} htmlFor="set-threads">
                Scan walker threads (per root)
              </label>
              <input
                id="set-threads"
                type="number"
                min={0}
                max={256}
                className={s.numInput}
                value={form.scan_threads}
                onChange={(e) => set("scan_threads", intField(e.target.value))}
              />
              <span className={s.fieldHint}>
                0 = automatic (recommended). Raise for fast local disks; keep low for a flaky NAS.
              </span>
            </div>

            <div className={s.field}>
              <label className={s.fieldLabel} htmlFor="set-gran">
                mtime tolerance (ms)
              </label>
              <input
                id="set-gran"
                type="number"
                min={0}
                className={s.numInput}
                value={form.mtime_gran_ms}
                onChange={(e) => set("mtime_gran_ms", intField(e.target.value))}
              />
              <span className={s.fieldHint}>
                0 = default (10 ms). Widen on coarse-granularity filesystems (FAT/exFAT/some NAS) to
                avoid needless recopies.
              </span>
            </div>

            <div className={s.field}>
              <label className={s.fieldLabel} htmlFor="set-ticker">
                Scan progress refresh (ms)
              </label>
              <input
                id="set-ticker"
                type="number"
                min={30}
                max={2000}
                className={s.numInput}
                value={form.scan_ticker_ms}
                onChange={(e) => set("scan_ticker_ms", intField(e.target.value))}
              />
              <span className={s.fieldHint}>
                How often the scanning item count updates (clamped 30–2000 ms).
              </span>
            </div>
          </div>
        )}
      </div>

      <div className={s.section}>
        <span className={s.sectionTitle}>Diagnostics</span>
        <span className={s.sectionDesc}>
          A rolling diagnostic log and a per-run record are written under the app data folder. Raise
          the level to capture more detail when investigating a scan or sync issue; the log level
          applies on the next launch.
        </span>
        {form != null && (
          <div className={s.field}>
            <label className={s.fieldLabel} htmlFor="set-log">
              Log level
            </label>
            <select
              id="set-log"
              className={s.select}
              value={form.log_level}
              onChange={(e) => set("log_level", e.target.value)}
            >
              {LOG_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && (
        <span className={s.error} role="alert">
          {error}
        </span>
      )}
      <div className={s.actions}>
        <Button
          variant="primary"
          disabled={!dirty || saveSettings.isPending}
          onClick={() => void onSave()}
        >
          {saveSettings.isPending ? "Saving…" : "Save settings"}
        </Button>
        {saved && !dirty && <span className={s.saved}>Saved ✓</span>}
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
