/* JobDetail (S9) — the multi-pair Compare/Run view. Verifies, with a mockIPC
 * fake engine + mocked events (shouldMockEvents):
 *  - one PairSection renders per pair returned by preview_job
 *  - a conflict row preselects its default_resolution
 *  - Apply is DISABLED until every conflict across all pairs is resolved
 *  - a pair that tripped the big-delete guard blocks Apply until confirmed
 *  - a run://progress event for the ACTIVE run updates the live strip, while an
 *    event for a DIFFERENT runId is ignored (cross-talk guard)
 *
 * The per-row pair id comes from the PreviewJobResult wrapper, never PlanItem. */

import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @tanstack/react-virtual computes an empty viewport under jsdom (no real
// layout), so the virtualized PlanGrid renders zero rows. Mock the virtualizer
// to render EVERY row so the conflict <select> rows are present in tests.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 30,
        size: 30,
      })),
  }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import userEvent from "@testing-library/user-event";
import { subscribeRunEvents, useStore } from "../../app/store";
import type { Job } from "../../domain/job";
import { newJob } from "../../domain/job";
import type { PairPreview, PlanItem, PreviewJobResult, SyncPlan } from "../../ipc/bindings";
import { JobDetail } from "./JobDetail";

const RUN_ID = "01RUN0000000000000000000A";

// ---- Fixtures ----

function conflictItem(path: string): PlanItem {
  return {
    path,
    action: "Conflict",
    conflict: "EditEdit",
    a_change: "Modified",
    b_change: "Modified",
    default_resolution: "KeepNewer",
    resolution_options: ["KeepA", "KeepB", "KeepNewer"],
    note: "both edited",
  };
}

function deleteItem(path: string): PlanItem {
  return {
    path,
    action: "DeleteB",
    a_change: "Deleted",
    b_change: "Unchanged",
    resolution_options: [],
    note: "",
  };
}

function plan(opts: {
  rootA: string;
  rootB: string;
  items: PlanItem[];
  conflicts?: number;
  deleteB?: number;
  bigDelete?: boolean;
}): SyncPlan {
  return {
    root_a: opts.rootA,
    root_b: opts.rootB,
    items: opts.items,
    summary: {
      total: opts.items.length,
      copy_a_to_b: opts.items.filter((i) => i.action === "CopyAtoB").length,
      copy_b_to_a: 0,
      delete_a: 0,
      delete_b: opts.deleteB ?? 0,
      conflicts: opts.conflicts ?? 0,
      baseline_only: 0,
      noop: 0,
      skipped: 0,
    },
    baseline_status: "Present",
    big_delete: opts.bigDelete
      ? {
          deletions: 80,
          total_members: 100,
          pct: 0.8,
          threshold_pct: 0.25,
          threshold_abs: 100,
        }
      : undefined,
    warnings: [],
  };
}

// Pair P0: a single EditEdit conflict. Pair P1: a big-delete-tripped delete.
const PAIR0: PairPreview = {
  pair_id: "PAIR_0",
  baseline_status: "Present",
  plan: plan({ rootA: "/a0", rootB: "/b0", items: [conflictItem("c.txt")], conflicts: 1 }),
};
const PAIR1: PairPreview = {
  pair_id: "PAIR_1",
  baseline_status: "Present",
  plan: plan({
    rootA: "/a1",
    rootB: "/b1",
    items: [deleteItem("d.txt")],
    deleteB: 1,
    bigDelete: true,
  }),
};

const PREVIEW: PreviewJobResult = { run_id: RUN_ID, pairs: [PAIR0, PAIR1] };

function makeJob(): Job {
  const j = newJob("Two-pair job");
  j.id = "01JOB0000000000000000000A";
  j.pairs = [
    { ...j.pairs[0], id: "PAIR_0", label: "first" },
    {
      id: "PAIR_1",
      label: "second",
      root_a: { kind: "Local", path: "/a1" },
      root_b: { kind: "Local", path: "/b1" },
      enabled: true,
    },
  ];
  return j;
}

function installIpc() {
  mockIPC(
    (cmd) => {
      if (cmd === "get_job") return makeJob();
      if (cmd === "preview_job") return PREVIEW;
      if (cmd === "execute_job")
        return {
          run_id: RUN_ID,
          pairs: [
            {
              pair_id: "PAIR_0",
              report: {
                done: 1,
                failed: 0,
                skipped: 0,
                conflicts: 0,
                bytes_copied: 1,
                outcomes: [],
              },
            },
            {
              pair_id: "PAIR_1",
              report: {
                done: 1,
                failed: 0,
                skipped: 0,
                conflicts: 0,
                bytes_copied: 1,
                outcomes: [],
              },
            },
          ],
        };
      if (cmd === "cancel_run") return true;
      if (cmd === "get_pair_baseline_status") return "Present";
      return undefined;
    },
    { shouldMockEvents: true },
  );
}

function renderDetail() {
  const rootRoute = createRootRoute();
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/jobs/$jobId",
    component: () => <JobDetail jobId="01JOB0000000000000000000A" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/jobs/01JOB0000000000000000000A"] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

function applyButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Apply/ }) as HTMLButtonElement;
}

beforeEach(() => {
  useStore.getState().resetRun();
  installIpc();
});
afterEach(() => clearMocks());

describe("JobDetail", () => {
  it("renders one PairSection per pair after Compare", async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Two-pair job");

    await user.click(screen.getByRole("button", { name: /compare/i }));

    // One section per pair (data-pair-id wrapper on each PairSection).
    await waitFor(() => expect(document.querySelectorAll("[data-pair-id]")).toHaveLength(2));
    expect(document.querySelector('[data-pair-id="PAIR_0"]')).not.toBeNull();
    expect(document.querySelector('[data-pair-id="PAIR_1"]')).not.toBeNull();
  });

  it("preselects a conflict row's default_resolution", async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Two-pair job");
    await user.click(screen.getByRole("button", { name: /compare/i }));

    // The conflict in PAIR_0 prefills KeepNewer in its <select>.
    const section0 = (await waitFor(() =>
      document.querySelector('[data-pair-id="PAIR_0"]'),
    )) as HTMLElement;
    const select = within(section0).getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("KeepNewer");
  });

  it("blocks Apply until conflicts resolved AND big-delete confirmed", async () => {
    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Two-pair job");
    await user.click(screen.getByRole("button", { name: /compare/i }));

    await waitFor(() => expect(document.querySelectorAll("[data-pair-id]")).toHaveLength(2));

    // Conflict is prefilled (KeepNewer) so the conflict gate is satisfied, but
    // PAIR_1 tripped the big-delete guard -> Apply still disabled.
    expect(applyButton()).toBeDisabled();

    // Confirm the big-delete for PAIR_1.
    const section1 = document.querySelector('[data-pair-id="PAIR_1"]') as HTMLElement;
    const confirm = within(section1).getByRole("checkbox", { name: /allow the deletions/i });
    await user.click(confirm);

    // Now both gates pass -> Apply enabled.
    await waitFor(() => expect(applyButton()).toBeEnabled());
  });

  it("an unresolved conflict (no default) keeps Apply disabled until resolved", async () => {
    // Re-install IPC so PAIR_0's conflict has NO default_resolution and PAIR_1
    // has no big-delete: the ONLY thing blocking Apply is the open conflict.
    clearMocks();
    const openConflict: PlanItem = {
      path: "x.txt",
      action: "Conflict",
      conflict: "EditEdit",
      a_change: "Modified",
      b_change: "Modified",
      resolution_options: ["KeepA", "KeepB"],
      note: "",
    };
    const previewOpen: PreviewJobResult = {
      run_id: RUN_ID,
      pairs: [
        {
          pair_id: "PAIR_0",
          baseline_status: "Present",
          plan: plan({ rootA: "/a0", rootB: "/b0", items: [openConflict], conflicts: 1 }),
        },
      ],
    };
    mockIPC((cmd) => {
      if (cmd === "get_job") return makeJob();
      if (cmd === "preview_job") return previewOpen;
      if (cmd === "get_pair_baseline_status") return "Present";
      return undefined;
    });

    const user = userEvent.setup();
    renderDetail();
    await screen.findByText("Two-pair job");
    await user.click(screen.getByRole("button", { name: /compare/i }));

    const section0 = (await waitFor(() =>
      document.querySelector('[data-pair-id="PAIR_0"]'),
    )) as HTMLElement;
    // Open conflict -> Apply blocked.
    expect(applyButton()).toBeDisabled();

    // Resolve it -> Apply enabled.
    const select = (await within(section0).findByRole("combobox")) as HTMLSelectElement;
    await user.selectOptions(select, "KeepB");
    await waitFor(() => expect(applyButton()).toBeEnabled());
  });

  it("updates the live strip for the active run and ignores a foreign runId", async () => {
    const user = userEvent.setup();
    const unsub = await subscribeRunEvents();
    try {
      renderDetail();
      await screen.findByText("Two-pair job");
      await user.click(screen.getByRole("button", { name: /compare/i }));
      // preview makes RUN_ID the active run (usePreviewJob -> beginRun).
      await waitFor(() => expect(useStore.getState().activeRunId).toBe(RUN_ID));

      // A foreign run's progress must be dropped: no strip, no mirror mutation.
      await emit("run://progress", {
        run_id: "OTHER_RUN",
        pair_id: "PAIR_0",
        pair_index: 0,
        pair_count: 2,
        done: 3,
        total: 10,
        path: "ignored.txt",
        action: "CopyAtoB",
      });
      await Promise.resolve();
      expect(useStore.getState().runs["OTHER_RUN"]).toBeUndefined();
      expect(screen.queryByLabelText("run progress")).toBeNull();

      // The active run's progress updates the mirror + renders the strip.
      await emit("run://progress", {
        run_id: RUN_ID,
        pair_id: "PAIR_1",
        pair_index: 1,
        pair_count: 2,
        done: 4,
        total: 10,
        path: "live.txt",
        action: "DeleteB",
      });
      await waitFor(() => expect(useStore.getState().runs[RUN_ID]!.progress?.done).toBe(4));
      const strip = await screen.findByLabelText("run progress");
      expect(strip).toHaveTextContent("live.txt");
      expect(strip).toHaveTextContent("Applying pair 2/2");
    } finally {
      unsub();
    }
  });
});
