/* Tier-2 NATIVE E2E (Windows-only, nightly / pre-release).
 *
 * WebdriverIO + msedgedriver drive the GENUINE Tauri app — the real Rust engine,
 * real filesystem, real baseline.json on disk — through WebView2 automation.
 * This is the slow, flake-prone smoke suite that proves the seams the mocked
 * Tier-1 cannot: real copy/delete IO and a real preview_job round-tripping
 * through the app's Zod schemas.
 *
 * Mechanism: the ATTACH approach from Microsoft's WebView2 WebDriver docs.
 * msedgedriver's "launch" mode (used by tauri-driver) hands the app binary to
 * the driver, which then waits for a DevToolsActivePort file in a user-data
 * folder it chooses — a handshake that never completes for Tauri v2 apps on
 * the CI runners (wry pins its own WebView2 environment options), failing with
 * "session not created: DevToolsActivePort file doesn't exist". So instead:
 *   1. the app is built with `--remote-debugging-port=9222` baked in via the
 *      src-tauri/tauri.e2e.conf.json overlay (NEVER in the production config),
 *   2. beforeSession spawns the app itself and waits for the CDP port,
 *   3. msedgedriver (spawned on :4444) attaches via ms:edgeOptions
 *      .debuggerAddress — no launch handshake, no tauri-driver.
 *
 * Platform: Windows ONLY. There is NO WKWebView driver, so macOS is excluded
 * (its coverage is the cross-platform Tier-1 + the Rust test suite).
 *
 * Footgun guarded here: msedgedriver MUST match the runner's WebView2 Runtime
 * major version or the session fails. CI resolves the preinstalled matching
 * driver (see .github/workflows/ci.yml, the native job) and points
 * MSEDGEDRIVER_PATH at it.
 *
 * Run (Windows):
 *   pnpm tauri build --debug --config src-tauri/tauri.e2e.conf.json
 *   # msedgedriver matching your WebView2 Runtime on PATH, or MSEDGEDRIVER_PATH
 *   pnpm e2e:native
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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

// Must match the --remote-debugging-port baked in by tauri.e2e.conf.json.
const CDP_PORT = 9222;

// Where we run msedgedriver; `port` below must agree, or WDIO would dial a
// different address than beforeSession starts the driver on.
const DRIVER_PORT = 4444;

// msedgedriver pinned to the runner's WebView2 Runtime (CI sets this); local
// runs may have a matching one on PATH.
const MSEDGEDRIVER = process.env.MSEDGEDRIVER_PATH ?? "msedgedriver";

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

let appProcess: Spawned | undefined;
let edgeDriver: Spawned | undefined;

/** How long a spawned process gets to open its port. Generous on purpose: on a
 * cold CI runner msedgedriver's own startup ("Starting…" → "was started
 * successfully") has taken well over 15s — the first cut of this used 15s and
 * flaked on exactly that. Waiting longer costs nothing when the port is up in
 * two seconds, because the poll exits as soon as it connects. */
const PORT_TIMEOUT_MS = 90_000;

/** A spawned process plus its spawn failure, if any. `spawn` reports a failure
 * to start (ENOENT, …) via an async 'error' event — throwing from that listener
 * would escape the promise chain as an unhandled exception, so record it and
 * let waitForPort surface it. */
interface Spawned {
  child: ChildProcess;
  spawnError?: Error;
}

function spawnTracked(cmd: string, args: string[], stdio: "ignore" | "inherit"): Spawned {
  const s: Spawned = {
    child: spawn(cmd, args, {
      stdio: stdio === "inherit" ? [null, process.stdout, process.stderr] : "ignore",
    }),
  };
  s.child.on("error", (e) => {
    s.spawnError = e;
  });
  return s;
}

/** Poll a local TCP port until something listens on it. Fails fast — without
 * burning the whole timeout — if the process that was supposed to open it never
 * started or has already exited. */
function waitForPort(
  port: number,
  what: string,
  proc: Spawned,
  timeoutMs = PORT_TIMEOUT_MS,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const { child, spawnError } = proc;
      if (spawnError) {
        reject(new Error(`failed to spawn ${what}: ${spawnError.message}`));
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(
          new Error(
            `${what} exited (code=${child.exitCode}, signal=${child.signalCode}) ` +
              `before opening port ${port}`,
          ),
        );
        return;
      }
      const socket = connect({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        const waited = Date.now() - started;
        if (waited > timeoutMs) {
          reject(new Error(`${what} did not open port ${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e-native/**/*.e2e.ts"],
  maxInstances: 1,
  // We manage the driver ourselves (beforeSession spawns msedgedriver on
  // :4444). Without an explicit hostname/port WDIO >=8 tries to download+start
  // a driver for `browserName` itself; setting them marks the driver as
  // remote/user-managed so WDIO just connects.
  hostname: "127.0.0.1",
  port: DRIVER_PORT,
  path: "/",
  capabilities: [
    {
      // The documented WebView2 attach capability: the app is already running
      // with CDP on :9222 (baked in by tauri.e2e.conf.json); msedgedriver
      // attaches to it instead of launching + handshaking itself.
      browserName: "webview2",
      "ms:edgeOptions": {
        debuggerAddress: `127.0.0.1:${CDP_PORT}`,
      },
      "wdio:maxInstances": 1,
      // msedgedriver speaks classic WebDriver only here; without this WDIO >=9
      // asks for a BiDi session (webSocketUrl: true) that cannot be served.
      "wdio:enforceWebDriverClassic": true,
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

  onPrepare: () => {
    if (process.platform !== "win32") {
      throw new Error(
        "Native E2E (WebView2 attach) is Windows-only. " +
          "Use Tier-1 Playwright + the Rust test suite elsewhere.",
      );
    }
    // Fail fast with a clear message if the debug binary wasn't built.
    if (!existsSync(APP_BINARY)) {
      throw new Error(
        `[wdio] built app not found at ${APP_BINARY} — run ` +
          "`pnpm tauri build --debug --config src-tauri/tauri.e2e.conf.json`",
      );
    }
  },

  // Boot the app (CDP enabled) + msedgedriver before the session. WDIO only
  // LOGS a beforeSession rejection and then attempts the session anyway, so the
  // real cause would otherwise be buried above a misleading "Unable to connect
  // to 127.0.0.1:4444" — re-log it prominently before rethrowing.
  beforeSession: async () => {
    try {
      appProcess = spawnTracked(APP_BINARY, [], "ignore");
      // The CDP port opens once the webview exists; only then can a driver attach.
      await waitForPort(CDP_PORT, `the app (${APP_BINARY})`, appProcess);

      edgeDriver = spawnTracked(MSEDGEDRIVER, [`--port=${DRIVER_PORT}`], "inherit");
      await waitForPort(DRIVER_PORT, `msedgedriver (${MSEDGEDRIVER})`, edgeDriver);
    } catch (e) {
      console.error(`\n[wdio] SESSION SETUP FAILED: ${(e as Error).message}\n`);
      edgeDriver?.child.kill();
      appProcess?.child.kill();
      throw e;
    }
  },

  afterSession: () => {
    edgeDriver?.child.kill();
    appProcess?.child.kill();
  },

  // NOTE: app/driver teardown lives in afterSession (worker process) — this
  // hook runs in the launcher, which never sees those child handles.
  onComplete: () => {
    try {
      rmSync(seedRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  },
};
