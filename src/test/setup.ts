/* Vitest global setup: register @testing-library/jest-dom matchers and clean up
 * the DOM between tests. */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no window.scrollTo; TanStack Router's scroll restoration calls it on
// every navigation. Stub it so router-driven tests don't spew "Not implemented".
if (!window.scrollTo) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  window.scrollTo = vi.fn();
} else {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
}

// jsdom has no ResizeObserver; some libs (e.g. virtualizers) reference it.
// A no-op shim keeps them from throwing. Tests that need real virtual rows mock
// the virtualizer directly (see JobDetail.test.tsx).
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});
