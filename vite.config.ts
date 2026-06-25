import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port; it injects TAURI_* env vars during `tauri dev`.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  // Prevent Vite from clearing the screen so Rust/Tauri logs stay visible.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: {
      // Don't watch the Rust side; cargo handles that.
      ignored: ["**/src-tauri/**"],
    },
  },
});
