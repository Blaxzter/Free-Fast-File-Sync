import { useNavigate } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowRight, FileDown } from "lucide-react";
import { useState } from "react";
import { useStore } from "../../app/store";
import { Banner } from "../../components/primitives/Banner";
import { Button } from "../../components/primitives/Button";
import { jobFromFfsImport } from "../../domain/ffsImport";
import type { FfsImport } from "../../ipc/bindings";
import { importFfs } from "../../ipc/commands";
import { errorMessage } from "../../ipc/errors";
import s from "./settings.module.css";

/** FreeFileSync import entry point. Keeps import_ffs reachable: pick a config,
 * parse it, list the parsed pairs. Full wizard (one Job, N pairs) is a later
 * phase; here we surface the capability and the parsed result. */
export function SettingsImport() {
  const [result, setResult] = useState<FfsImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const setJobDraft = useStore((st) => st.setJobDraft);

  /** Map the parsed pairs into one unsaved Job and open the editor to review. */
  function createJobFromImport() {
    if (!result || result.jobs.length === 0) return;
    setJobDraft(jobFromFfsImport(result));
    void navigate({ to: "/jobs/new" });
  }

  async function doImport() {
    setError(null);
    const picked = await open({
      multiple: false,
      filters: [{ name: "FreeFileSync config", extensions: ["ffs_batch", "ffs_gui"] }],
    });
    if (typeof picked !== "string") return;
    try {
      setResult(await importFfs(picked));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className={s.page}>
      <div className={s.section}>
        <span className={s.sectionTitle}>Import from FreeFileSync</span>
        <span className={s.sectionDesc}>
          Pick a <code>.ffs_batch</code> or <code>.ffs_gui</code> config to parse its folder pairs,
          then create a Job from them. <code>.gitignore</code> stays on, so the imported excludes
          layer on top of it.
        </span>
        <div>
          <Button variant="primary" icon={<FileDown size={14} />} onClick={doImport}>
            Choose FFS config…
          </Button>
        </div>

        {error && <Banner intent="danger">{error}</Banner>}

        {result && (
          <>
            <span className={s.sectionDesc}>
              <strong>{result.jobs.length}</strong> folder pair(s) found.
            </span>
            <div className={s.importList}>
              {result.jobs.map((job, i) => (
                <div className={s.importJob} key={i}>
                  <div className={s.importPaths}>
                    <code title={job.left}>{job.left}</code>
                    <span className={s.arrow}>{job.two_way ? "↔" : "→"}</span>
                    <code title={job.right}>{job.right}</code>
                  </div>
                  <div className={s.importMeta}>
                    <span className={`${s.tagchip} ${job.two_way ? s.tagTwo : ""}`}>
                      {job.two_way ? "two-way" : "one-way mirror"}
                    </span>
                    <span className={s.tagchip}>{job.exclude_globs.length} excludes</span>
                    {job.use_recycle_bin && <span className={s.tagchip}>recycle bin</span>}
                    {job.verify_by_hash && <span className={s.tagchip}>verify hash</span>}
                    {job.warnings.length > 0 && (
                      <span className={`${s.tagchip} ${s.tagWarn}`}>⚠ review</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div>
              <Button
                variant="primary"
                icon={<ArrowRight size={14} />}
                onClick={createJobFromImport}
              >
                Create job from {result.jobs.length} pair{result.jobs.length === 1 ? "" : "s"}
              </Button>
            </div>
            {result.notes.length > 0 && (
              <details className={s.notes}>
                <summary>{result.notes.length} filter translation note(s)</summary>
                <ul>
                  {result.notes.slice(0, 100).map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
