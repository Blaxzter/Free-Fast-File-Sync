/* Tier-1 E2E fake engine.
 *
 * Registers ONE mockIPC handler (from @tauri-apps/api/mocks) keyed by command,
 * plus a run://* event emitter, so Playwright drives the REAL production React
 * app (real router, store, TanStack Query, ipc/* boundary, Zod parsing) with
 * only Tauri's invoke/listen swapped for a scripted engine.
 *
 * One built bundle serves every flow: the scenario is chosen by
 * window.__E2E_SCENARIO__ (set by the Playwright harness via addInitScript).
 * Every payload returned here is shaped EXACTLY like the Rust serde DTOs
 * (snake_case) so the app's Zod schemas parse it without drift — that is the
 * point of Tier 1: it proves the contract end-to-end against the fake.
 *
 * IMPORTANT: this module is imported ONLY by src/main.tsx behind
 * `import.meta.env.VITE_E2E`, so it never enters a production bundle. */

import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  ApplyReport,
  BaselineStatusKind,
  ExecuteJobResult,
  Job,
  PairPreview,
  PlanItem,
  PlanSummary,
  PreviewJobResult,
  SyncPlan,
} from "../src/ipc/bindings";

// ---- ids (ULID-shaped, but any stable string works for the fake) ----
const JOB_ID = "01JOB000000000000000000E2E";
const PAIR_ID = "01PAIR00000000000000000E2E";
const RUN_PREVIEW = "01RUNPREVIEW0000000000000E";
const RUN_APPLY = "01RUNAPPLY00000000000000E2";

// ---- low-level fixture builders ----

function summary(partial: Partial<PlanSummary> = {}): PlanSummary {
  return {
    total: 0,
    copy_a_to_b: 0,
    copy_b_to_a: 0,
    delete_a: 0,
    delete_b: 0,
    conflicts: 0,
    baseline_only: 0,
    noop: 0,
    skipped: 0,
    ...partial,
  };
}

function summaryOf(items: PlanItem[]): PlanSummary {
  const s = summary({ total: items.length });
  for (const it of items) {
    switch (it.action) {
      case "CopyAtoB":
        s.copy_a_to_b += 1;
        break;
      case "CopyBtoA":
        s.copy_b_to_a += 1;
        break;
      case "DeleteA":
        s.delete_a += 1;
        break;
      case "DeleteB":
        s.delete_b += 1;
        break;
      case "Conflict":
        s.conflicts += 1;
        break;
      case "UpdateBaselineOnly":
        s.baseline_only += 1;
        break;
      case "Noop":
        s.noop += 1;
        break;
    }
  }
  return s;
}

function copyItem(path: string, dir: "AtoB" | "BtoA" = "AtoB"): PlanItem {
  return {
    path,
    action: dir === "AtoB" ? "CopyAtoB" : "CopyBtoA",
    a_change: dir === "AtoB" ? "Created" : "Unchanged",
    b_change: dir === "AtoB" ? "Unchanged" : "Created",
    a: { kind: "File", size: 1024, mtime_ns: 1 },
    resolution_options: [],
    note: "",
  };
}

function deleteBItem(path: string): PlanItem {
  return {
    path,
    action: "DeleteB",
    a_change: "Deleted",
    b_change: "Unchanged",
    b: { kind: "File", size: 2048, mtime_ns: 1 },
    resolution_options: [],
    note: "removed on A",
  };
}

function editEditConflict(path: string): PlanItem {
  return {
    path,
    action: "Conflict",
    conflict: "EditEdit",
    a_change: "Modified",
    b_change: "Modified",
    a: { kind: "File", size: 10, mtime_ns: 20 },
    b: { kind: "File", size: 12, mtime_ns: 10 },
    default_resolution: "KeepNewer",
    resolution_options: ["KeepA", "KeepB", "KeepNewer"],
    note: "both sides edited since the last sync",
  };
}

function noopItem(path: string): PlanItem {
  return {
    path,
    action: "Noop",
    a_change: "Unchanged",
    b_change: "Unchanged",
    resolution_options: [],
    note: "",
  };
}

function plan(opts: {
  rootA?: string;
  rootB?: string;
  items: PlanItem[];
  baseline?: BaselineStatusKind;
  bigDelete?: boolean;
  warnings?: string[];
}): SyncPlan {
  const items = opts.items;
  return {
    root_a: opts.rootA ?? "/seed/A",
    root_b: opts.rootB ?? "/seed/B",
    items,
    summary: summaryOf(items),
    baseline_status: opts.baseline ?? "Present",
    big_delete: opts.bigDelete
      ? {
          deletions: 80,
          total_members: 100,
          pct: 0.8,
          threshold_pct: 0.25,
          threshold_abs: 100,
        }
      : undefined,
    warnings: opts.warnings ?? [],
  };
}

function report(items: PlanItem[]): ApplyReport {
  const applied = items.filter((i) => i.action !== "Noop");
  return {
    done: applied.length,
    failed: 0,
    skipped: 0,
    conflicts: 0,
    bytes_copied: applied.length * 1024,
    outcomes: applied.map((i) => ({ path: i.path, action: i.action, status: "Done" as const })),
  };
}

function job(name: string): Job {
  return {
    id: JOB_ID,
    name,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    settings: {
      compare_mode: "TimeAndSize",
      direction: "TwoWay",
      deletion: { kind: "RecycleBin" },
      big_delete: { pct: 0.25, abs: 100 },
      filter: {
        use_gitignore: true,
        use_dot_ignore: true,
        include_hidden: false,
        custom_globs: [],
      },
    },
    pairs: [
      {
        id: PAIR_ID,
        label: "seed pair",
        root_a: { kind: "Local", path: "/seed/A" },
        root_b: { kind: "Local", path: "/seed/B" },
        enabled: true,
      },
    ],
  };
}

// ---- a scenario describes the canned engine for one flow ----

interface Scenario {
  /** Job name + direction shown in the detail header / badges. */
  job: Job;
  /** Per-pair baseline status (job-list + per-pair badge). */
  baseline: BaselineStatusKind;
  /** First preview_job result. */
  preview: PreviewJobResult;
  /** A SECOND preview after a successful apply (converge -> all Noop). When
   * absent, re-preview returns the same plan. */
  rePreview?: PreviewJobResult;
  /** What execute_job reports (per pair). */
  apply: ExecuteJobResult;
  /** When true, the apply emits progress events then PAUSES (never finishes) so
   * the cancel flow can interrupt it; cancel_run then emits run://finished. */
  applyHangsForCancel?: boolean;
}

function pairPreview(pl: SyncPlan): PairPreview {
  return { pair_id: PAIR_ID, plan: pl, baseline_status: pl.baseline_status };
}

function buildScenario(name: string): Scenario {
  switch (name) {
    // Happy path: an EditEdit conflict + a couple of copies. After resolving +
    // applying, a re-preview converges to all-Noop.
    case "converge": {
      const items = [
        editEditConflict("notes.txt"),
        copyItem("new-a.txt"),
        copyItem("new-b.txt", "BtoA"),
      ];
      const converged = [noopItem("notes.txt"), noopItem("new-a.txt"), noopItem("new-b.txt")];
      return {
        job: job("Converge job"),
        baseline: "Present",
        preview: { run_id: RUN_PREVIEW, pairs: [pairPreview(plan({ items }))] },
        rePreview: { run_id: RUN_PREVIEW, pairs: [pairPreview(plan({ items: converged }))] },
        apply: { run_id: RUN_APPLY, pairs: [{ pair_id: PAIR_ID, report: report(items) }] },
      };
    }

    // Mirror A->B: shows DeleteB rows (B-side extras pruned). No conflicts.
    case "mirror": {
      const j = job("Mirror job");
      j.settings.direction = "MirrorAtoB";
      const items = [copyItem("keep.txt"), deleteBItem("extra-on-b.txt"), deleteBItem("stale.txt")];
      return {
        job: j,
        baseline: "Present",
        preview: { run_id: RUN_PREVIEW, pairs: [pairPreview(plan({ items }))] },
        apply: { run_id: RUN_APPLY, pairs: [{ pair_id: PAIR_ID, report: report(items) }] },
      };
    }

    // Big-delete guard tripped: apply blocked until confirmed.
    case "big-delete": {
      const j = job("Big delete job");
      j.settings.direction = "MirrorAtoB";
      const items = Array.from({ length: 5 }, (_, i) => deleteBItem(`gone-${i}.txt`));
      return {
        job: j,
        baseline: "Present",
        preview: { run_id: RUN_PREVIEW, pairs: [pairPreview(plan({ items, bigDelete: true }))] },
        apply: { run_id: RUN_APPLY, pairs: [{ pair_id: PAIR_ID, report: report(items) }] },
      };
    }

    // First sync: union-only, no deletions (baseline FirstSync banner).
    case "first-sync": {
      const items = [copyItem("a-only.txt"), copyItem("b-only.txt", "BtoA")];
      return {
        job: job("First sync job"),
        baseline: "FirstSync",
        preview: {
          run_id: RUN_PREVIEW,
          pairs: [pairPreview(plan({ items, baseline: "FirstSync" }))],
        },
        apply: { run_id: RUN_APPLY, pairs: [{ pair_id: PAIR_ID, report: report(items) }] },
      };
    }

    // Corrupt baseline: safe union fallback banner, no delete rows.
    case "corrupt-baseline": {
      const items = [copyItem("recovered.txt")];
      return {
        job: job("Corrupt baseline job"),
        baseline: "Corrupt",
        preview: {
          run_id: RUN_PREVIEW,
          pairs: [pairPreview(plan({ items, baseline: "Corrupt" }))],
        },
        apply: { run_id: RUN_APPLY, pairs: [{ pair_id: PAIR_ID, report: report(items) }] },
      };
    }

    // Scan-error suppression: a non-fatal scan warning surfaces as a plan warning
    // banner; the plan still has actionable rows.
    case "scan-error": {
      const items = [copyItem("ok.txt")];
      return {
        job: job("Scan error job"),
        baseline: "Present",
        preview: {
          run_id: RUN_PREVIEW,
          pairs: [
            pairPreview(
              plan({
                items,
                warnings: ["2 path(s) skipped: permission denied (suppressed, sync continued)"],
              }),
            ),
          ],
        },
        apply: { run_id: RUN_APPLY, pairs: [{ pair_id: PAIR_ID, report: report(items) }] },
      };
    }

    // Cancel during apply: progress is emitted, then the apply HANGS; cancel_run
    // emits run://finished, returning the mirror to idle.
    case "cancel": {
      const items = Array.from({ length: 6 }, (_, i) => copyItem(`big-${i}.txt`));
      return {
        job: job("Cancel job"),
        baseline: "Present",
        preview: { run_id: RUN_PREVIEW, pairs: [pairPreview(plan({ items }))] },
        apply: { run_id: RUN_APPLY, pairs: [{ pair_id: PAIR_ID, report: report(items) }] },
        applyHangsForCancel: true,
      };
    }

    default:
      // Unknown scenario -> behave like converge so the harness never blanks.
      return buildScenario("converge");
  }
}

// ---- event scripting helpers (drive the run-aware store) ----

async function emitStarted(runId: string, jobId: string, pairCount: number, trigger: string) {
  await emit("run://started", { run_id: runId, job_id: jobId, pair_count: pairCount, trigger });
}

async function emitApplyProgress(runId: string, plan: SyncPlan) {
  const applicable = plan.items.filter((i) => i.action !== "Noop");
  const total = Math.max(applicable.length, 1);
  await emit("run://scan", { run_id: runId, pair_id: PAIR_ID, phase: "apply" });
  for (let i = 0; i < applicable.length; i += 1) {
    await emit("run://progress", {
      run_id: runId,
      pair_id: PAIR_ID,
      pair_index: 0,
      pair_count: 1,
      done: i + 1,
      total,
      path: applicable[i]!.path,
      action: applicable[i]!.action,
    });
  }
}

// ---- the single registration entrypoint ----

let cancelArmed = false;
/** When an apply is hung (cancel scenario), this rejects the pending execute_job
 * promise the way the real engine returns RunError::Cancelled on cancel_run. */
let rejectHungApply: ((reason: unknown) => void) | undefined;

export function installFakeEngine(scenarioName: string): void {
  const sc = buildScenario(scenarioName);
  let previewed = false;

  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "list_jobs":
          return [sc.job];
        case "get_job":
          return sc.job;
        case "get_pair_baseline_status":
          return sc.baseline;
        case "save_job":
          return (a.job as Job) ?? sc.job;
        case "duplicate_job":
          return sc.job;
        case "delete_job":
          return undefined;

        case "preview_job": {
          const result = previewed && sc.rePreview ? sc.rePreview : sc.preview;
          previewed = true;
          // The real backend emits run://started for the held preview run.
          await emitStarted(result.run_id, JOB_ID, result.pairs.length, "manual");
          return result;
        }

        case "execute_job": {
          const planForRun = sc.preview.pairs[0]!.plan;
          await emitStarted(sc.apply.run_id, JOB_ID, 1, "manual");
          if (sc.applyHangsForCancel) {
            cancelArmed = true;
            // Emit a couple of progress ticks, then leave the promise PENDING so
            // the UI sits in "applying" until cancel_run releases it.
            await emit("run://scan", { run_id: sc.apply.run_id, pair_id: PAIR_ID, phase: "apply" });
            await emit("run://progress", {
              run_id: sc.apply.run_id,
              pair_id: PAIR_ID,
              pair_index: 0,
              pair_count: 1,
              done: 1,
              total: planForRun.items.length,
              path: planForRun.items[0]!.path,
              action: planForRun.items[0]!.action,
            });
            // Stays PENDING until cancel_run rejects it (RunError::Cancelled),
            // mirroring the real engine; cancel_run also emits run://finished to
            // free the live run mirror.
            return new Promise<ExecuteJobResult>((_resolve, reject) => {
              rejectHungApply = reject;
            });
          }
          await emitApplyProgress(sc.apply.run_id, planForRun);
          await emit("run://pair-done", { run_id: sc.apply.run_id, pair_id: PAIR_ID });
          await emit("run://finished", { run_id: sc.apply.run_id });
          return sc.apply;
        }

        case "cancel_run": {
          const runId = (a.runId as string) ?? (a.run_id as string) ?? sc.apply.run_id;
          if (cancelArmed) {
            cancelArmed = false;
            await emit("run://finished", { run_id: runId });
            // Settle the hung execute_job the way the real engine does on cancel.
            rejectHungApply?.({ Cancelled: { run_id: runId } });
            rejectHungApply = undefined;
          }
          return true;
        }

        case "import_ffs":
          return { jobs: [], notes: [] };

        default:
          return undefined;
      }
    },
    { shouldMockEvents: true },
  );
}
