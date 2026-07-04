/* ActivityFeed — the run-history screen. Verifies:
 *  - a row renders per run from a mocked list_activity, resolving the job name
 *    from list_jobs and labeling the phase (execute -> "Sync")
 *  - clicking a run expands its per-pair breakdown
 *  - an empty history shows the empty state
 *
 * IPC is faked with mockIPC; no router is needed (the feed doesn't navigate). */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "../../domain/job";
import { newJob } from "../../domain/job";
import type { PairRunLog, RunLog } from "../../ipc/bindings";
import { ActivityFeed } from "./ActivityFeed";

function job(id: string, name: string): Job {
  const j = newJob(name);
  j.id = id;
  return j;
}

function pair(id: string, extra: Partial<PairRunLog> = {}): PairRunLog {
  return {
    pair_id: id,
    entries_a: 10,
    entries_b: 8,
    errors_a: 0,
    errors_b: 0,
    skipped_a: 0,
    skipped_b: 0,
    scanned: 18,
    threads: 8,
    ms: 42,
    ok: true,
    ...extra,
  };
}

function run(extra: Partial<RunLog> = {}): RunLog {
  return {
    run_id: "01RUN0000000000000000000A",
    job_id: "01JOB0000000000000000000A",
    phase: "execute",
    trigger: "Manual",
    started: "2026-06-26T00:00:00Z",
    ended: "2026-06-26T00:00:01Z",
    ms: 1000,
    pair_count: 1,
    pairs: [pair("01PAIR000000000000000000A")],
    ok: true,
    ...extra,
  };
}

function installIpc(runs: RunLog[]) {
  mockIPC((cmd) => {
    if (cmd === "list_activity") return runs;
    if (cmd === "list_jobs") return [job("01JOB0000000000000000000A", "Docs")];
    return undefined;
  });
}

function renderFeed() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ActivityFeed />
    </QueryClientProvider>,
  );
}

afterEach(() => clearMocks());

describe("ActivityFeed", () => {
  it("renders a run row with the resolved job name and 'Sync' phase label", async () => {
    installIpc([run()]);
    renderFeed();
    expect(await screen.findByText("Docs")).toBeInTheDocument();
    expect(screen.getByText("Sync")).toBeInTheDocument();
  });

  it("expands a run to its per-pair breakdown on click", async () => {
    const user = userEvent.setup();
    installIpc([run()]);
    renderFeed();
    await screen.findByText("Docs");

    // The per-pair table (with the 'threads' column) is hidden until expanded.
    expect(screen.queryByText("threads")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Docs/ }));
    expect(await screen.findByText("threads")).toBeInTheDocument();
  });

  it("shows the empty state when there is no history", async () => {
    installIpc([]);
    renderFeed();
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
  });

  it("surfaces a failed run's error message", async () => {
    installIpc([run({ ok: false, error: "scan panicked" })]);
    renderFeed();
    expect(await screen.findByText("scan panicked")).toBeInTheDocument();
  });
});
