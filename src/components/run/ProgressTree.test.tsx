/* ProgressTree — the scan-phase live folder tree (Phase B). Seeds the run-aware
 * store directly (no IPC) and asserts the scanning branch renders the folder
 * snapshot; the apply branch is covered by JobDetail.test.tsx. */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../../app/store";
import { ProgressTree } from "./ProgressTree";

beforeEach(() => useStore.getState().resetRun());
afterEach(() => useStore.getState().resetRun());

describe("ProgressTree", () => {
  it("renders all pairs with the active one expanded to its folder tree", () => {
    const st = useStore.getState();
    st.applyRunStarted({ run_id: "R", job_id: "J", pair_count: 2 }); // phase: scanning
    st.applyRunScan({ run_id: "R", pair_id: "P1", phase: "Scanning" }); // P1 active
    st.applyRunScanProgress({ run_id: "R", scanned: 1203 });
    st.applyRunScanTree({
      run_id: "R",
      pair_id: "P1",
      folders: [
        { path: "Photos", count: 1000 },
        { path: "", count: 5 },
      ],
    });

    render(
      <ProgressTree
        pairs={[]}
        resolutions={{}}
        pairLabels={{ P0: "Docs", P1: "Camera" }}
        pairOrder={["P0", "P1"]}
      />,
    );
    const strip = screen.getByLabelText("run progress");
    expect(strip).toHaveTextContent("Scanning pair 2/2"); // position across pairs
    expect(strip).toHaveTextContent("1,203 items");
    // Both pairs listed by label; the active one (P1) is expanded to its tree.
    expect(strip).toHaveTextContent("Docs"); // P0, pending
    expect(strip).toHaveTextContent("Camera"); // P1, active
    expect(strip).toHaveTextContent("Photos");
    expect(strip).toHaveTextContent("(root)"); // the "" bucket renders as (root)
  });

  it("renders nothing when idle", () => {
    const { container } = render(
      <ProgressTree pairs={[]} resolutions={{}} pairLabels={{}} pairOrder={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
