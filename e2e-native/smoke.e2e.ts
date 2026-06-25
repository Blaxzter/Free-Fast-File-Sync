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
import { zPreviewJobResult } from "../src/domain/schemas";

interface Seed {
  seedRoot: string;
  dirA: string;
  dirB: string;
}
const seed = (globalThis as Record<string, unknown>).__E2E_SEED__ as Seed;

/** Find baseline.json anywhere under the engine's app-data jobs tree. The exact
 * root is OS-specific (AppData on Windows); we resolve it from the app rather
 * than hardcode it, by scanning for the documented layout
 * jobs/<jobId>/pairs/<pairId>/baseline.json. */
function findBaselineJson(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (entry === "baseline.json" && st.isFile()) return p;
    if (st.isDirectory()) {
      const hit = findBaselineJson(p);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Evaluate an invoke inside the webview so we exercise the REAL command +
 * the app's real Zod parse path. Returned value is the raw JSON the engine sent. */
async function invokeInApp<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return browser.execute(
    (c, a) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
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

    // The engine persisted a baseline for this pair (jobs/<jobId>/pairs/<pairId>/
    // baseline.json). Resolve the app-data root from the app then assert layout.
    const appDataDir = await browser.execute(
      () =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke("plugin:path|resolve_directory", { directory: 12 }), // AppData
    );
    const root = typeof appDataDir === "string" ? appDataDir : seed.seedRoot;
    const baseline = findBaselineJson(root) ?? findBaselineJson(seed.seedRoot);
    // jobs/<jobId>/pairs/<pairId>/baseline.json must exist on disk.
    expect(baseline).toBeDefined();
    if (baseline) {
      expect(baseline).toContain(join("pairs", pairId));
      // It's valid JSON.
      JSON.parse(readFileSync(baseline, "utf-8"));
    }
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
