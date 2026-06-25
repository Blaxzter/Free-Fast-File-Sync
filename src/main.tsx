import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./app/router";
import { queryClient } from "./app/queryClient";
import { subscribeRunEvents } from "./app/store";
import "./styles/tokens.css";
import "./styles/global.css";

// Default density attribute (compact) — Settings can flip it live.
document.documentElement.setAttribute("data-density", "compact");

// The ONE sync://progress subscriber that feeds the Zustand run mirror.
void subscribeRunEvents();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
