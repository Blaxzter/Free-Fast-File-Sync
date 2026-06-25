/* TanStack Query hooks over the read commands. Components consume these and
 * never touch invoke directly. */

import { useQuery } from "@tanstack/react-query";
import { getBaselineStatus } from "./commands";
import type { JobConfig } from "./bindings";

/** Baseline status for a root pair. Disabled until both roots are chosen.
 * The two roots are separate key segments so no separator char is needed. */
export function useBaselineStatus(cfg: JobConfig) {
  const ready = Boolean(cfg.root_a && cfg.root_b && cfg.root_a !== cfg.root_b);
  return useQuery({
    queryKey: ["baseline", cfg.root_a, cfg.root_b],
    queryFn: () => getBaselineStatus(cfg),
    enabled: ready,
  });
}
