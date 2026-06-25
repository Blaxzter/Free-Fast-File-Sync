import { ComingSoon } from "../ComingSoon";

/** Placeholder until S9. The single-pair Compare Workspace was retired with the
 * single-pair preview_sync/execute_sync IPC surface (S7). The multi-pair,
 * job-driven Compare/Run view (JobDetail) lands in S9, reusing the
 * components/plan/* grid keyed off domain/meaning.ts. */
export function CompareWorkspace() {
  return (
    <ComingSoon
      title="Compare"
      description="The multi-pair compare & run view lands with the job-driven run surface. Open a job from the Jobs list to preview and apply its folder pairs."
    />
  );
}
