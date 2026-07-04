/* Live run progress for the JobDetail run surface.
 *
 * Shows ALL of the job's enabled pairs as a list — pending / scanning / applying
 * / done / aborted — with the pair currently being worked expanded to its live
 * folder tree (the scan-phase shallow folder activity, or the apply-phase
 * per-folder breakdown). Pairs scan/apply sequentially, so this is the "where are
 * we across the whole job" view, not just the active pair.
 *
 * Presentational (like PlanGrid / the meaning badges) — NOT a Radix component.
 * Status colours come from CSS tokens via run.module.css; bars scale via
 * transform (composited, no layout thrash); folders render in a STABLE order so
 * rows don't jump as counts change. Labels/order come from the Job (props),
 * because during the scan there is no preview result yet. */

import { Fragment } from "react";
import type { PairRunStatus } from "../../app/store";
import { useStore } from "../../app/store";
import { useNow } from "../../app/useNow";
import { buildFolderProgress, topSegment } from "../../domain/progressTree";
import type { PairPreview, Resolution } from "../../ipc/bindings";
import run from "./run.module.css";

interface Props {
  /** Previewed pairs — supplies the active pair's plan items (apply phase). */
  pairs: PairPreview[];
  /** Chosen resolutions per pair; decides which conflict items will apply. */
  resolutions: Record<string, Record<string, Resolution>>;
  /** pair_id → label, for the pair rows + heading during the scan. */
  pairLabels: Record<string, string>;
  /** Enabled pair ids in run order. */
  pairOrder: string[];
}

const PAIR_GLYPH: Record<PairRunStatus, string> = {
  pending: "·",
  scanning: "▸",
  applying: "▸",
  done: "✓",
  aborted: "⦸",
};
const PAIR_CLASS: Record<PairRunStatus, string> = {
  pending: run.pairPending,
  scanning: run.pairActive,
  applying: run.pairActive,
  done: run.pairDone,
  aborted: run.pairAborted,
};

const FOLDER_GLYPH = { active: "▸", done: "✓", pending: "·" } as const;
const FOLDER_CLASS = {
  active: run.folderActive,
  done: run.folderDone,
  pending: run.folderPending,
} as const;

/** A bar that scales via transform (composited) rather than width (layout). */
function Bar({ frac, className }: { frac: number; className: string }) {
  return (
    <div className={run.folderTrack}>
      <div
        className={className}
        style={{ transform: `scaleX(${Math.max(0, Math.min(1, frac))})` }}
      />
    </div>
  );
}

export function ProgressTree({ pairs, resolutions, pairLabels, pairOrder }: Props) {
  const mirror = useStore((st) => (st.activeRunId ? st.runs[st.activeRunId] : undefined));
  const phase = mirror?.phase ?? "idle";
  const now = useNow(phase === "scanning");

  if (!mirror || phase === "idle") return null;

  const { activePairId, progress, scanned, startedAt } = mirror;

  // ---- active pair's expanded body (folder tree) ----
  const scanFolders =
    phase === "scanning" ? [...mirror.scanTree].sort((a, b) => a.path.localeCompare(b.path)) : [];
  const scanPeak = scanFolders.reduce((m, f) => Math.max(m, f.count), 0);

  const activePair = activePairId ? pairs.find((p) => p.pair_id === activePairId) : undefined;
  const applyFolders =
    phase === "applying" && activePair && progress
      ? buildFolderProgress(
          activePair.plan.items,
          resolutions[activePairId as string] ?? {},
          mirror.doneByFolder[activePairId as string] ?? {},
          topSegment(progress.path),
        )
      : [];

  function activeBody() {
    if (phase === "scanning") {
      return scanFolders.map((f) => (
        <li
          key={`f:${f.path}`}
          className={`${run.folderRow} ${run.folderRowNested} ${run.folderActive}`}
        >
          <span className={run.folderGlyph} aria-hidden>
            ▸
          </span>
          <span className={run.folderName} title={f.path || "(root)"}>
            {f.path === "" ? "(root)" : f.path}
          </span>
          <Bar frac={scanPeak > 0 ? f.count / scanPeak : 0} className={run.folderFill} />
          <span className={run.folderCount}>{f.count.toLocaleString()}</span>
        </li>
      ));
    }
    return applyFolders.map((f) => (
      <li
        key={`f:${f.name}`}
        className={`${run.folderRow} ${run.folderRowNested} ${FOLDER_CLASS[f.status]}`}
      >
        <span className={run.folderGlyph} aria-hidden>
          {FOLDER_GLYPH[f.status]}
        </span>
        <span className={run.folderName} title={f.name || "(root)"}>
          {f.name === "" ? "(root)" : f.name}
        </span>
        <Bar frac={f.total ? f.done / f.total : 0} className={run.folderFill} />
        <span className={run.folderCount}>
          {f.done.toLocaleString()}/{f.total.toLocaleString()}
        </span>
      </li>
    ));
  }

  function pairCountLabel(status: PairRunStatus, pid: string): string {
    switch (status) {
      case "pending":
        return "pending";
      case "scanning":
        return mirror!.planTotal > 0
          ? `planning · ${mirror!.planDone.toLocaleString()}/${mirror!.planTotal.toLocaleString()}`
          : `scanning · ${Math.max(0, scanned - mirror!.scanBaseAtPairStart).toLocaleString()}`;
      case "applying":
        return progress
          ? `${progress.done.toLocaleString()}/${progress.total.toLocaleString()}`
          : "applying";
      case "done": {
        const r = mirror!.pairRecap[pid];
        return r ? `done · ${(r.applied || r.scanned).toLocaleString()}` : "done";
      }
      case "aborted":
        return "aborted";
    }
  }

  // ---- header ----
  // planTotal > 0 during the scanning phase = the post-scan disk-probe ("checking
  // files") sub-phase, where the scan count is frozen; show it as determinate.
  const pairIdx = activePairId ? Math.max(0, pairOrder.indexOf(activePairId)) : 0;
  const planning = phase === "scanning" && mirror.planTotal > 0;
  const planPct = mirror.planTotal > 0 ? mirror.planDone / mirror.planTotal : 0;

  let heading: string;
  if (phase === "applying") {
    heading = `Applying pair ${mirror.activePairIndex + 1}/${mirror.pairCount || 1}`;
  } else if (planning) {
    heading =
      pairOrder.length > 1 ? `Planning pair ${pairIdx + 1}/${pairOrder.length}` : "Planning…";
  } else {
    heading =
      pairOrder.length > 1 ? `Scanning pair ${pairIdx + 1}/${pairOrder.length}` : "Scanning…";
  }

  const secs = startedAt ? (now - startedAt) / 1000 : 0;
  const rate = secs > 0.3 && scanned > 0 ? Math.round(scanned / secs) : 0;
  const headerRight = planning ? (
    <span className={run.runStripMono}>
      checking {mirror.planDone.toLocaleString()}/{mirror.planTotal.toLocaleString()} files
    </span>
  ) : phase === "scanning" ? (
    <span className={run.runStripMono}>
      {scanned.toLocaleString()} items{secs >= 0.1 ? ` · ${secs.toFixed(1)}s` : ""}
      {rate > 0 ? ` · ${rate.toLocaleString()}/s` : ""}
    </span>
  ) : progress ? (
    <span className={run.runStripMono}>
      {progress.done.toLocaleString()}/{progress.total.toLocaleString()} · {progress.path}
    </span>
  ) : null;

  const applyPct = progress?.total ? progress.done / progress.total : 0;

  return (
    <div className={run.progressTree} role="status" aria-label="run progress">
      <div className={run.progressTreeHead}>
        <span>{heading}</span>
        {phase === "applying" && progress && <Bar frac={applyPct} className={run.runStripFill} />}
        {planning && <Bar frac={planPct} className={run.runStripFill} />}
        {headerRight}
      </div>

      <ul className={run.folderList}>
        {pairOrder.map((pid) => {
          const isActive = pid === activePairId;
          const status: PairRunStatus = isActive
            ? phase === "applying"
              ? "applying"
              : "scanning"
            : (mirror.pairStatus[pid] ?? "pending");
          return (
            <Fragment key={pid}>
              <li className={`${run.folderRow} ${PAIR_CLASS[status]}`}>
                <span className={run.folderGlyph} aria-hidden>
                  {PAIR_GLYPH[status]}
                </span>
                <span className={run.folderName} title={pairLabels[pid] ?? pid}>
                  {pairLabels[pid] ?? pid}
                </span>
                <span className={run.pairSpacer} />
                <span className={run.folderCount}>{pairCountLabel(status, pid)}</span>
              </li>
              {isActive && activeBody()}
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
}
