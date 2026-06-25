/* JobEditor (S8) — RHF over the Job aggregate. Verifies:
 *  - adding/removing pairs via the field array changes the submitted Job's
 *    pair count (the array drives save_job's payload)
 *  - save with an empty name is blocked (per-field validation; no save_job)
 *  - the deletion-policy selector offers ONLY RecycleBin / Permanent
 *  - the effective ModeBadge renders a MODE_MEANING label/var (no inline hex)
 *
 * IPC is faked with @tauri-apps/api/mocks mockIPC: save_job echoes the job back
 * (and we capture its argument to assert the submitted shape). */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
import { JobEditor } from "./JobEditor";

// Capture of the last save_job payload so a test can inspect the submitted Job.
let lastSaved: Job | null = null;

function installIpc() {
  mockIPC((cmd, args) => {
    if (cmd === "save_job") {
      const job = (args as { job: Job }).job;
      lastSaved = job;
      // Echo back a "persisted" job (server fills id/timestamps).
      return { ...job, id: job.id || "01JOBNEW0000000000000000", created_at: "x", updated_at: "y" };
    }
    if (cmd === "get_job") {
      throw new Error("get_job should not be called for /jobs/new");
    }
    return undefined;
  });
}

/** Mount the editor inside a real memory router (so useNavigate works) + a
 * QueryClient (so useSaveJob / useJob work). The /jobs landing is a stub. */
function renderEditor() {
  const rootRoute = createRootRoute();
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs/new",
    component: () => <JobEditor />,
  });
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs",
    component: () => <div>jobs-landing</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([newRoute, jobsRoute]),
    history: createMemoryHistory({ initialEntries: ["/jobs/new"] }),
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

beforeEach(() => {
  lastSaved = null;
  installIpc();
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

describe("JobEditor", () => {
  it("adding then removing pairs changes the submitted Job's pair count", async () => {
    const user = userEvent.setup();
    renderEditor();

    await screen.findByText("New job");
    await user.type(screen.getByLabelText("Name"), "Docs");

    // Starts with one pair.
    expect(screen.getAllByText("Root A")).toHaveLength(1);

    // Add two more pairs.
    const addBtn = screen.getByRole("button", { name: /add folder pair/i });
    await user.click(addBtn);
    await user.click(addBtn);
    expect(screen.getAllByText("Root A")).toHaveLength(3);

    // Remove the second pair.
    await user.click(screen.getByRole("button", { name: /remove pair 1/i }));
    expect(screen.getAllByText("Root A")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /save job/i }));
    await waitFor(() => expect(lastSaved).not.toBeNull());
    expect(lastSaved!.name).toBe("Docs");
    expect(lastSaved!.pairs).toHaveLength(2);
  });

  it("blocks save when the name is empty (no save_job call)", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText("New job");

    // Name left blank -> submit should be blocked by RHF validation.
    await user.click(screen.getByRole("button", { name: /save job/i }));

    await screen.findByText(/job name is required/i);
    expect(lastSaved).toBeNull();
  });

  it("offers only RecycleBin and Permanent in the deletion selector", async () => {
    renderEditor();
    await screen.findByText("New job");

    const select = screen.getByLabelText("Deleted files") as HTMLSelectElement;
    const values = within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(["RecycleBin", "Permanent"]);
  });

  it("renders the ModeBadge from MODE_MEANING (label + css var, no inline hex)", async () => {
    renderEditor();
    await screen.findByText("New job");

    // Default direction TwoWay -> MODE_MEANING.TwoWay.label === "two-way".
    const badges = screen.getAllByTitle("two-way");
    expect(badges.length).toBeGreaterThan(0);
    const badge = badges[0];
    expect(badge).toHaveTextContent("two-way");
    // Color must be a CSS var token, never a raw hex.
    expect(badge.getAttribute("style") ?? "").toContain("var(--neutral-fg)");
    expect(badge.getAttribute("style") ?? "").not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
