import { defineConfig, devices } from "@playwright/test";

/* Tier-1 E2E (PRIMARY, cross-platform, fast).
 *
 * Drives the REAL production React app — real router, Zustand store, TanStack
 * Query, the ipc/* boundary and Zod parsing — against the in-bundle fake engine
 * (e2e/fakeEngine.ts) which swaps Tauri's invoke/listen for canned, serde-shaped
 * data. Only invoke/listen are faked; everything else is the shipping app.
 *
 * The app is built ONCE with VITE_E2E=1 (so main.tsx will boot the fake engine
 * when window.__E2E_SCENARIO__ is set) and served by `vite preview`. Each spec
 * picks its scenario by setting window.__E2E_SCENARIO__ via addInitScript BEFORE
 * navigation. Headless Chromium — no Rust compile, runs identically on the
 * Windows CI runner and any dev machine.
 *
 * To run locally:
 *   pnpm exec playwright install chromium   # one-time
 *   pnpm e2e:mocked
 * If browsers cannot be installed (sandboxed CI/dev), the harness still type-
 * checks and lists:  pnpm exec playwright test --list */

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Build the E2E bundle then serve it. `vite build` honours VITE_E2E via env so
  // main.tsx's E2E branch survives tree-shaking; `vite preview` serves dist on a
  // fixed port. Reused across specs.
  webServer: {
    command: "pnpm run build:e2e && pnpm exec vite preview --port " + PORT + " --strictPort",
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
