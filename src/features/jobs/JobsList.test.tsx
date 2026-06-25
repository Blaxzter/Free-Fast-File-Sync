/* JobsList (S8) — the real persisted list. Verifies:
 *  - rows render from a mocked useJobs (list_jobs) response
 *  - "New job" navigates to /jobs/new
 *
 * IPC is faked with mockIPC: list_jobs returns two jobs, get_pair_baseline_status
 * returns a status so the aggregated baseline badge can render. */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { Job } from "../../domain/job";
import { newJob } from "../../domain/job";
import { JobsList } from "./JobsList";

function job(id: string, name: string): Job {
  const j = newJob(name);
  j.id = id;
  j.pairs[0].id = `${id}-p0`;
  return j;
}

const JOBS: Job[] = [job("01JOB0000000000000000000A", "Docs"), job("01JOB0000000000000000000B", "Photos")];

function installIpc() {
  mockIPC((cmd) => {
    if (cmd === "list_jobs") return JOBS;
    if (cmd === "get_pair_baseline_status") return "FirstSync";
    return undefined;
  });
}

function renderList() {
  const rootRoute = createRootRoute();
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    component: JobsList,
  });
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs/new",
    component: () => <div>new-job-editor</div>,
  });
  const importRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/import",
    component: () => <div>import-screen</div>,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs/$jobId",
    component: () => <div>job-detail</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([jobsRoute, newRoute, importRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/jobs"] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => installIpc());
afterEach(() => clearMocks());

describe("JobsList", () => {
  it("renders a row per job from the mocked list", async () => {
    renderList();
    expect(await screen.findByText("Docs")).toBeInTheDocument();
    expect(screen.getByText("Photos")).toBeInTheDocument();
  });

  it("New job navigates to /jobs/new", async () => {
    const user = userEvent.setup();
    const router = renderList();
    await screen.findByText("Docs");

    await user.click(screen.getByRole("button", { name: /new job/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs/new"));
    expect(screen.getByText("new-job-editor")).toBeInTheDocument();
  });
});
