import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { queryClient } from "./app/queryClient";
import { router } from "./app/router";
import { subscribeRunEvents } from "./app/store";
import "./styles/tokens.css";
import "./styles/global.css";

// Default density attribute (compact) — Settings can flip it live.
document.documentElement.setAttribute("data-density", "compact");

function mount() {
  // The ONE run://* subscriber that feeds the Zustand run mirror. In the E2E
  // build it subscribes through the already-installed mocked event plugin.
  void subscribeRunEvents();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

// Tier-1 E2E only: when built with VITE_E2E=1 AND the Playwright harness has set
// window.__E2E_SCENARIO__, register the mocked fake engine (mockIPC + run://*
// emitter) BEFORE subscribing/rendering so the IPC boundary is exercised against
// canned data. The dynamic import is code-split, so production builds never pull
// the e2e/ fake engine into the runtime path. Guarded by import.meta.env.VITE_E2E
// so the branch is dead-code-eliminated in normal builds.
if (import.meta.env.VITE_E2E && typeof window.__E2E_SCENARIO__ === "string") {
  void import("../e2e/fakeEngine")
    .then((m) => m.installFakeEngine(window.__E2E_SCENARIO__ as string))
    .then(() => {
      window.__E2E_READY__ = true;
      mount();
    });
} else {
  mount();
}
