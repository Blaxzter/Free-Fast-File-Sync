/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the Tier-1 E2E build (`VITE_E2E=1 pnpm build`). When truthy, main.tsx
   * boots the mocked fake engine instead of talking to the real Tauri backend. */
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Tier-1 E2E scenario selector. The Playwright harness sets this via
   * addInitScript BEFORE the app boots; e2e/fakeEngine.ts reads it to choose
   * which canned engine responses + run://* event scripts to serve. Absent in
   * production. */
  __E2E_SCENARIO__?: string;
  /** Resolves once the fake engine has registered mockIPC, so specs can wait for
   * a deterministic ready signal instead of racing the bundle. */
  __E2E_READY__?: boolean;
}
