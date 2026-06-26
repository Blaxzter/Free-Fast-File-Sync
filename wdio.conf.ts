/* Tier-2 NATIVE E2E (Windows-only, nightly / pre-release).
 *
 * WebdriverIO + tauri-driver drive the GENUINE Tauri app — the real Rust engine,
 * real filesystem, real baseline.json on disk — through WebView2 automation.
 * This is the slow, flake-prone smoke suite that proves the seams the mocked
 * Tier-1 cannot: real copy/delete IO and a real preview_job round-tripping
 * through the app's Zod schemas.
 *
 * Platform: Windows ONLY. tauri-driver targets msedgedriver (Windows) /
 * WebKitWebDriver (Linux); there is NO WKWebView driver, so macOS is excluded
 * (its coverage is the cross-platform Tier-1 + the Rust test suite).
 *
 * Footgun guarded here: msedgedriver MUST match the runner's installed Edge or
 * the session HANGS. CI fetches a pinned msedgedriver (see .github/workflows/
 * ci.yml, the e2e-native job) and points MSEDGEDRIVER_PATH at it.
 *
 * Run (Windows):
 *   pnpm app:build  # or: pnpm tauri build --debug   (produces the .exe)
 *   cargo install tauri-driver --locked              # once
 *   pnpm e2e:native
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The built debug binary (mainBinaryName defaults to the Cargo crate name).
const APP_BINARY = join(
  process.cwd(),
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "fast-file-sync.exe" : "fast-file-sync",
);

// Two seeded temp dirs so the smoke test has a real A/B to sync. Recorded on
// globalThis so the spec can read the paths it must operate on.
const seedRoot = mkdtempSync(join(tmpdir(), "ffs-e2e-"));
const dirA = join(seedRoot, "A");
const dirB = join(seedRoot, "B");
mkdirSync(dirA, { recursive: true });
mkdirSync(dirB, { recursive: true });
// A single seed file on side A, B empty -> a deterministic first-sync copy.
writeFileSync(join(dirA, "hello.txt"), "hello from A\n");

(globalThis as Record<string, unknown>).__E2E_SEED__ = { seedRoot, dirA, dirB };

let tauriDriver: ChildProcess | undefined;

// tauri-driver proxies WebDriver to the native webview. On Windows it shells out
// to msedgedriver; pin it via MSEDGEDRIVER_PATH (CI sets this to a version
// matched to the runner's Edge — otherwise the session hangs).
const MSEDGEDRIVER = process.env.MSEDGEDRIVER_PATH;

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e-native/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      // tauri-driver's custom capability points at the app binary.
      // @ts-expect-error tauri:options is a tauri-driver extension capability.
      "tauri:options": {
        application: APP_BINARY,
        // Pass the seeded dirs to the app via args/env so the run is hermetic.
        env: {
          FFS_E2E_DIR_A: dirA,
          FFS_E2E_DIR_B: dirB,
          FFS_E2E_SEED_ROOT: seedRoot,
        },
      },
      "wdio:maxInstances": 1,
      browserName: "wry",
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  logLevel: "info",
  waitforTimeout: 30_000,

  // Boot tauri-driver before the session, tear it down after.
  onPrepare: () => {
    if (process.platform === "darwin") {
      throw new Error(
        "Native E2E (tauri-driver) is unsupported on macOS (no WKWebView driver). " +
          "Use Tier-1 Playwright + the Rust test suite for macOS coverage.",
      );
    }
    // Fail fast with a clear message if the debug binary wasn't built.
    const built = spawnSync(process.platform === "win32" ? "where" : "which", [APP_BINARY], {
      shell: true,
    });
    if (built.status !== 0) {
      // `where`/`which` won't resolve an absolute path; just warn — WDIO will
      // surface the real launch error if it's genuinely missing.
      // eslint-disable-next-line no-console
      console.warn(
        `[wdio] expecting built app at ${APP_BINARY} (run \`pnpm tauri build --debug\`)`,
      );
    }
  },

  beforeSession: () =>
    new Promise<void>((resolve, reject) => {
      const args = MSEDGEDRIVER ? ["--native-driver", MSEDGEDRIVER] : [];
      tauriDriver = spawn("tauri-driver", args, { stdio: [null, process.stdout, process.stderr] });
      tauriDriver.on("error", (e) =>
        reject(new Error(`failed to spawn tauri-driver: ${e.message}`)),
      );
      // tauri-driver needs a moment to bind its port before the session opens.
      setTimeout(resolve, 2_000);
    }),

  afterSession: () => {
    tauriDriver?.kill();
  },

  onComplete: () => {
    try {
      rmSync(seedRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  },
};
