import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** Vitest config for the frontend unit/component tests. jsdom env + the
 * jest-dom matchers setup. Tauri E2E (Playwright/WDIO) is a separate harness (S10). */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,spec}.{ts,tsx}", "src/test/**", "src/vite-env.d.ts"],
    },
  },
});
