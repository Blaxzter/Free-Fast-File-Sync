/* Tier-2 NATIVE smoke (Windows-only, nightly / pre-release).
 *
 * Runs against the GENUINE Tauri app + real Rust engine + real filesystem.
 * Proves the three seams the mocked Tier-1 cannot:
 *   1. real first-sync copy        — a file created on A appears on B, and the
 *      engine writes jobs/<jobId>/pairs/<pairId>/baseline.json to disk
 *   2. real delete                 — a file removed on A is propagated to B
 *      (hard delete, for CI determinism — no Recycle Bin)
 *   3. real serde contract         — a real preview_job result round-trips
 *      through the app's Zod schema with no parse error
 *
 * The seeded A/B temp dirs come from wdio.conf.ts (globalThis.__E2E_SEED__).
 * This spec drives the real UI to create a job over those dirs, then asserts on
 * the actual filesystem.
 *
 * NOTE: this file is compiled+run ONLY by WDIO on Windows; it is intentionally
 * excluded from the app's tsconfig (include: ["src"]) and from the Vitest run.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BaseDirectory } from "@tauri-apps/api/path";
import { zPreviewJobResult } from "../src/domain/schemas";

interface Seed {
  seedRoot: string;
  dirA: string;
  dirB: string;
}
const seed = (globalThis as Record<string, unknown>).__E2E_SEED__ as Seed;

/** List every baseline.json under `root`, for a diagnostic message when the
 * documented layout assertion fails (shows what the engine actually wrote). */
function listBaselines(root: string, depth = 6): string[] {
  if (depth === 0 || !existsSync(root)) return [];
  const hits: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (entry === "baseline.json" && st.isFile()) hits.push(p);
    else if (st.isDirectory()) hits.push(...listBaselines(p, depth - 1));
  }
  return hits;
}

/** Evaluate an invoke inside the webview so we exercise the REAL command +
 * the app's real Zod parse path. Returned value is the raw JSON the engine sent.
 * Rejections are re-thrown as real Errors: Tauri commands reject with plain
 * strings/objects, which WebDriver would otherwise report as an unreadable
 * empty "javascript error: ". */
async function invokeInApp<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return browser.execute(
    (c, a) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__
        .invoke(c, a)
        .catch((e: unknown) => {
          throw new Error(typeof e === "string" ? e : JSON.stringify(e));
        }),
    cmd,
    args,
  ) as Promise<T>;
}

describe("native smoke (real engine)", () => {
  let jobId: string;
  let pairId: string;

  it("creates a job over the seeded dirs (save_job)", async () => {
    // Persist a job pointing at the real temp dirs via the real save_job command.
    const draft = {
      id: "",
      name: "native-smoke",
      created_at: "",
      updated_at: "",
      settings: {
        compare_mode: "TimeAndSize",
        direction: "TwoWay",
        deletion: { kind: "Permanent" }, // hard delete for CI determinism
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
          id: "",
          label: "seed",
          root_a: { kind: "Local", path: seed.dirA },
          root_b: { kind: "Local", path: seed.dirB },
          enabled: true,
        },
      ],
    };
    const saved = await invokeInApp<{ id: string; pairs: { id: string }[] }>("save_job", {
      job: draft,
    });
    jobId = saved.id;
    pairId = saved.pairs[0].id;
    expect(jobId).not.toBe("");
    expect(pairId).not.toBe("");
  });

  it("preview_job round-trips through Zod with no parse error", async () => {
    const raw = await invokeInApp<unknown>("preview_job", { jobId, pairIds: null });
    // The real serde contract: the app's own schema must accept the engine JSON.
    const parsed = zPreviewJobResult.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.error.message);
    expect(parsed.data.pairs.length).toBe(1);

    // Release the parked preview through the same seam the UI's Cancel button
    // uses. The single-slot RunRegistry HOLDS the slot after a successful
    // preview; without this, every later preview in the suite would be Busy.
    await invokeInApp("cancel_run", { runId: parsed.data.run_id });
  });

  it("real first-sync copy: hello.txt appears in B and baseline.json is written", async () => {
    // Preview holds a run; execute it with no conflicts to converge.
    const preview = await invokeInApp<{ run_id: string }>("preview_job", { jobId, pairIds: null });
    await invokeInApp("execute_job", {
      runId: preview.run_id,
      resolutions: {},
      confirmBigDelete: {},
    });

    // The seed file copied A -> B.
    expect(existsSync(join(seed.dirB, "hello.txt"))).toBe(true);

    // The engine persisted a baseline for this pair. Resolve the app-data root
    // from the app itself — BaseDirectory.AppData by NAME, never a raw enum
    // number (those shift between Tauri versions; 12 is Temp, not AppData).
    const appDataDir = await invokeInApp<string>("plugin:path|resolve_directory", {
      directory: BaseDirectory.AppData,
    });
    expect(typeof appDataDir).toBe("string");

    // Assert the DOCUMENTED layout, not merely "a baseline exists somewhere":
    // <appData>/jobs/<jobId>/pairs/<pairId>/baseline.json. The path is derived
    // from the stable ULIDs, so an orphaned baseline (silent FirstSync +
    // suppressed deletes) shows up here as a miss.
    const baseline = join(appDataDir, "jobs", jobId, "pairs", pairId, "baseline.json");
    if (!existsSync(baseline)) {
      throw new Error(
        `expected baseline at ${baseline}; found instead: ${
          JSON.stringify(listBaselines(join(appDataDir, "jobs"))) || "none"
        }`,
      );
    }
    // It's valid JSON.
    JSON.parse(readFileSync(baseline, "utf-8"));
  });

  it("real delete: removing hello.txt on A propagates the delete to B", async () => {
    // Delete on A, then sync again; B's copy must be removed (hard delete).
    rmSync(join(seed.dirA, "hello.txt"), { force: true });

    const preview = await invokeInApp<{ run_id: string }>("preview_job", { jobId, pairIds: null });
    await invokeInApp("execute_job", {
      runId: preview.run_id,
      resolutions: {},
      confirmBigDelete: { [pairId]: true },
    });

    expect(existsSync(join(seed.dirB, "hello.txt"))).toBe(false);
  });
});
