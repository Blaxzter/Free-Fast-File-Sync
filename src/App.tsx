import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  type Action,
  type ApplyReport,
  type BaselineStatusKind,
  type FfsImport,
  type ImportedJob,
  type JobConfig,
  type PlanItem,
  type Progress,
  type Resolution,
  type SyncPlan,
  cancelSync,
  errorMessage,
  executeSync,
  getBaselineStatus,
  importFfs,
  onProgress,
  previewSync,
} from "./api";

const ACTION_LABEL: Record<Action, string> = {
  Noop: "in sync",
  CopyAtoB: "A → B",
  CopyBtoA: "B → A",
  DeleteA: "delete A",
  DeleteB: "delete B",
  UpdateBaselineOnly: "record",
  Conflict: "conflict",
};

const RESOLUTION_LABEL: Record<Resolution, string> = {
  KeepA: "Keep A",
  KeepB: "Keep B",
  KeepNewer: "Keep newer",
  KeepBoth: "Keep both",
  PropagateDelete: "Apply delete",
  KeepModified: "Keep edited",
  KeepTypeChanged: "Keep replacement",
  Skip: "Skip",
};

const BASELINE_BADGE: Record<BaselineStatusKind, { text: string; cls: string }> = {
  Present: { text: "Baseline OK · two-way", cls: "ok" },
  FirstSync: { text: "First sync · union only, no deletes", cls: "warn" },
  Corrupt: { text: "Baseline unreadable · safe union, no deletes", cls: "danger" },
};

function defaultConfig(): JobConfig {
  return {
    root_a: "",
    root_b: "",
    ignore: {
      use_gitignore: true,
      use_dot_ignore: true,
      include_hidden: false,
      custom_globs: [],
    },
    verify_by_hash: false,
    big_delete_pct: 0.25,
    big_delete_abs: 100,
    use_recycle_bin: true,
  };
}

export default function App() {
  const [cfg, setCfg] = useState<JobConfig>(defaultConfig);
  const [globText, setGlobText] = useState("");
  const [baseline, setBaseline] = useState<BaselineStatusKind | null>(null);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, Resolution>>({});
  const [confirmBigDelete, setConfirmBigDelete] = useState(false);
  const [busy, setBusy] = useState<"idle" | "preview" | "apply">("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInSync, setShowInSync] = useState(false);
  const [imported, setImported] = useState<FfsImport | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const unlisten = useRef<(() => void) | null>(null);

  useEffect(() => {
    onProgress((p) => setProgress(p)).then((fn) => (unlisten.current = fn));
    return () => unlisten.current?.();
  }, []);

  const withGlobs = (): JobConfig => ({
    ...cfg,
    ignore: {
      ...cfg.ignore,
      custom_globs: globText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    },
  });

  async function pickFolder(side: "root_a" | "root_b") {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      const next = { ...cfg, [side]: picked };
      setCfg(next);
      setPlan(null);
      setReport(null);
      try {
        setBaseline(await getBaselineStatus(next));
      } catch {
        setBaseline(null);
      }
    }
  }

  async function doImportFfs() {
    setError(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "FreeFileSync config", extensions: ["ffs_batch", "ffs_gui"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const result = await importFfs(picked);
      setImported(result);
      setImportNote(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function useImportedJob(job: ImportedJob) {
    const next: JobConfig = {
      ...defaultConfig(),
      root_a: job.left,
      root_b: job.right,
      use_recycle_bin: job.use_recycle_bin,
      verify_by_hash: job.verify_by_hash,
      ignore: { ...defaultConfig().ignore, custom_globs: job.exclude_globs },
    };
    setCfg(next);
    setGlobText(job.exclude_globs.join("\n"));
    setPlan(null);
    setReport(null);
    setImported(null);
    const lines = [...job.warnings];
    if (job.gitignore_hint) lines.push(job.gitignore_hint);
    setImportNote(lines.length ? lines.join("  •  ") : `Loaded “${job.name}” from FreeFileSync.`);
    getBaselineStatus(next).then(setBaseline).catch(() => setBaseline(null));
  }

  async function doPreview() {
    setError(null);
    setReport(null);
    setBusy("preview");
    try {
      const p = await previewSync(withGlobs());
      setPlan(p);
      const res: Record<string, Resolution> = {};
      for (const it of p.items) {
        if (it.action === "Conflict" && it.default_resolution) {
          res[it.path] = it.default_resolution;
        }
      }
      setResolutions(res);
      setConfirmBigDelete(false);
      setBaseline(p.baseline_status);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("idle");
    }
  }

  async function doApply() {
    if (!plan) return;
    setError(null);
    setBusy("apply");
    setProgress(null);
    try {
      const r = await executeSync(withGlobs(), resolutions, confirmBigDelete);
      setReport(r);
      // Refresh the plan so the user sees the converged (empty) state.
      const p = await previewSync(withGlobs());
      setPlan(p);
      setBaseline(p.baseline_status);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("idle");
      setProgress(null);
    }
  }

  const ready = cfg.root_a && cfg.root_b && cfg.root_a !== cfg.root_b;
  const s = plan?.summary;
  const actionable = s ? s.total - s.noop : 0;

  const visibleItems = useMemo(() => {
    if (!plan) return [];
    return plan.items
      .filter((it) => showInSync || it.action !== "Noop")
      .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  }, [plan, showInSync]);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo">⇄</span>
          <div>
            <h1>fast-file-sync</h1>
            <p className="tag">Two-way sync that respects your .gitignore</p>
          </div>
        </div>
        {baseline && (
          <span className={`badge ${BASELINE_BADGE[baseline].cls}`}>
            {BASELINE_BADGE[baseline].text}
          </span>
        )}
      </header>

      <div className="migrate">
        <span>Migrating from FreeFileSync?</span>
        <button className="ghost" onClick={doImportFfs}>
          Import .ffs_batch / .ffs_gui
        </button>
      </div>

      {imported && (
        <div className="import-panel">
          <div className="import-head">
            <strong>{imported.jobs.length} folder pair(s) found</strong>
            <button className="ghost small" onClick={() => setImported(null)}>
              ✕
            </button>
          </div>
          {imported.jobs.map((job, i) => (
            <div className="import-job" key={i}>
              <div className="import-job-main">
                <div className="import-paths">
                  <code>{job.left}</code>
                  <span className="arrow">{job.two_way ? "↔" : "→"}</span>
                  <code>{job.right}</code>
                </div>
                <div className="import-meta">
                  <span className={`tagchip ${job.two_way ? "two" : "one"}`}>
                    {job.two_way ? "two-way" : "one-way mirror"}
                  </span>
                  <span className="tagchip">{job.exclude_globs.length} excludes</span>
                  {job.use_recycle_bin && <span className="tagchip">recycle bin</span>}
                  {job.verify_by_hash && <span className="tagchip">verify hash</span>}
                  {job.warnings.length > 0 && <span className="tagchip warn">⚠ review</span>}
                </div>
              </div>
              <button className="primary small" onClick={() => useImportedJob(job)}>
                Use this pair
              </button>
            </div>
          ))}
          {imported.notes.length > 0 && (
            <details className="import-notes">
              <summary>{imported.notes.length} filter translation note(s)</summary>
              <ul>
                {imported.notes.slice(0, 100).map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {importNote && <div className="banner warn">📥 {importNote}</div>}

      <section className="roots">
        <FolderField label="Folder A" value={cfg.root_a} onPick={() => pickFolder("root_a")} />
        <div className="swap">⇄</div>
        <FolderField label="Folder B" value={cfg.root_b} onPick={() => pickFolder("root_b")} />
      </section>

      <section className="options">
        <fieldset>
          <legend>Filters</legend>
          <Toggle
            label="Respect .gitignore"
            checked={cfg.ignore.use_gitignore}
            onChange={(v) => setCfg({ ...cfg, ignore: { ...cfg.ignore, use_gitignore: v } })}
          />
          <Toggle
            label="Respect .ignore files"
            checked={cfg.ignore.use_dot_ignore}
            onChange={(v) => setCfg({ ...cfg, ignore: { ...cfg.ignore, use_dot_ignore: v } })}
          />
          <Toggle
            label="Include hidden / dotfiles"
            checked={cfg.ignore.include_hidden}
            onChange={(v) => setCfg({ ...cfg, ignore: { ...cfg.ignore, include_hidden: v } })}
          />
          <label className="globs">
            <span>Extra ignore globs (one per line, <code>!</code> re-includes)</span>
            <textarea
              rows={3}
              placeholder={"*.tmp\nnode_modules/\n!keep.tmp"}
              value={globText}
              onChange={(e) => setGlobText(e.target.value)}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>Safety</legend>
          <Toggle
            label="Deletions go to Recycle Bin"
            checked={cfg.use_recycle_bin}
            onChange={(v) => setCfg({ ...cfg, use_recycle_bin: v })}
          />
          <Toggle
            label="Verify by content hash (slower, safest)"
            checked={cfg.verify_by_hash}
            onChange={(v) => setCfg({ ...cfg, verify_by_hash: v })}
          />
          <p className="hint">
            Conflicts are never auto-applied. A delete that races an edit is always a conflict —
            your data is never silently lost.
          </p>
        </fieldset>
      </section>

      <section className="actions">
        <button className="primary" disabled={!ready || busy !== "idle"} onClick={doPreview}>
          {busy === "preview" ? "Scanning…" : "Preview"}
        </button>
        <button
          className="go"
          disabled={!plan || actionable === 0 || busy !== "idle" || hasUnresolvedSkips(plan, resolutions)}
          onClick={doApply}
        >
          {busy === "apply" ? "Syncing…" : `Apply${actionable ? ` (${actionable})` : ""}`}
        </button>
        {busy === "apply" && (
          <button className="ghost" onClick={() => cancelSync()}>
            Cancel
          </button>
        )}
      </section>

      {error && <div className="banner danger">⚠ {error}</div>}

      {plan?.big_delete && (
        <div className="banner warn">
          <strong>Large deletion guard:</strong> this sync would delete {plan.big_delete.deletions}{" "}
          file(s) ({Math.round(plan.big_delete.pct * 100)}% of {plan.big_delete.total_members}).
          <label className="confirm">
            <input
              type="checkbox"
              checked={confirmBigDelete}
              onChange={(e) => setConfirmBigDelete(e.target.checked)}
            />
            I’ve reviewed these — allow the deletions
          </label>
        </div>
      )}

      {busy === "apply" && progress && (
        <div className="progress">
          <div className="bar">
            <div
              className="fill"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
          <span className="pct">
            {progress.done}/{progress.total} · {progress.path}
          </span>
        </div>
      )}

      {report && (
        <div className="banner ok">
          Synced: {report.done} applied · {report.bytes_copied.toLocaleString()} bytes ·{" "}
          {report.failed} failed · {report.skipped} skipped · {report.conflicts} unresolved
        </div>
      )}

      {plan && (
        <section className="results">
          <div className="summary">
            <Chip n={s!.copy_a_to_b} label="A → B" cls="copy" />
            <Chip n={s!.copy_b_to_a} label="B → A" cls="copy" />
            <Chip n={s!.delete_a + s!.delete_b} label="deletes" cls="del" />
            <Chip n={s!.conflicts} label="conflicts" cls="conf" />
            <Chip n={s!.noop} label="in sync" cls="noop" />
            {s!.skipped > 0 && <Chip n={s!.skipped} label="skipped" cls="noop" />}
            <label className="show-insync">
              <input type="checkbox" checked={showInSync} onChange={(e) => setShowInSync(e.target.checked)} />
              show in-sync
            </label>
          </div>

          {plan.warnings.length > 0 && (
            <details className="warnings">
              <summary>{plan.warnings.length} skipped during scan (symlinks, cloud stubs…)</summary>
              <ul>
                {plan.warnings.slice(0, 200).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          {actionable === 0 ? (
            <p className="empty">✓ Everything is in sync.</p>
          ) : (
            <table className="plan">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>A</th>
                  <th>B</th>
                  <th>Action</th>
                  <th>Resolution</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((it) => (
                  <Row
                    key={it.path}
                    it={it}
                    resolution={resolutions[it.path]}
                    onResolve={(r) => setResolutions((prev) => ({ ...prev, [it.path]: r }))}
                  />
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function rank(it: PlanItem): number {
  if (it.action === "Conflict") return 0;
  if (it.action === "DeleteA" || it.action === "DeleteB") return 1;
  if (it.action === "Noop") return 9;
  return 2;
}

function hasUnresolvedSkips(plan: SyncPlan | null, res: Record<string, Resolution>): boolean {
  // Apply is allowed even with skips; this hook is reserved for stricter modes.
  void plan;
  void res;
  return false;
}

function Row({
  it,
  resolution,
  onResolve,
}: {
  it: PlanItem;
  resolution?: Resolution;
  onResolve: (r: Resolution) => void;
}) {
  const isConflict = it.action === "Conflict";
  return (
    <tr className={isConflict ? "conflict" : ""}>
      <td className="path" title={it.note}>
        {it.path}
        {isConflict && <span className="ctype">{it.conflict}</span>}
      </td>
      <td>
        <Change c={it.a_change} />
      </td>
      <td>
        <Change c={it.b_change} />
      </td>
      <td>
        <span className={`act ${actClass(it.action)}`}>{ACTION_LABEL[it.action]}</span>
      </td>
      <td>
        {isConflict ? (
          <select value={resolution} onChange={(e) => onResolve(e.target.value as Resolution)}>
            {it.resolution_options.map((r) => (
              <option key={r} value={r}>
                {RESOLUTION_LABEL[r]}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted">{it.note}</span>
        )}
      </td>
    </tr>
  );
}

function actClass(a: Action): string {
  if (a === "Conflict") return "conf";
  if (a === "DeleteA" || a === "DeleteB") return "del";
  if (a === "Noop" || a === "UpdateBaselineOnly") return "noop";
  return "copy";
}

function Change({ c }: { c: PlanItem["a_change"] }) {
  const map: Record<string, string> = {
    Unchanged: "·",
    Created: "+ new",
    Modified: "~ edit",
    Deleted: "− del",
    TypeChanged: "⇆ type",
  };
  return <span className={`chg ${c.toLowerCase()}`}>{map[c] ?? c}</span>;
}

function FolderField({
  label,
  value,
  onPick,
}: {
  label: string;
  value: string;
  onPick: () => void;
}) {
  return (
    <div className="folder">
      <label>{label}</label>
      <div className="row">
        <input readOnly value={value} placeholder="Choose a folder…" />
        <button onClick={onPick}>Browse</button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Chip({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <span className={`chip ${cls}`}>
      <b>{n}</b> {label}
    </span>
  );
}
