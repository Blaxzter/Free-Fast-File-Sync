import { Link } from "@tanstack/react-router";
import { FolderSync } from "lucide-react";
import { EmptyState } from "../../components/primitives/EmptyState";
import { Button } from "../../components/primitives/Button";

/** Jobs List. Phase 0 has no persisted job store yet, so this is the empty
 * state that surfaces the two entry points: open the single-pair Compare
 * Workspace, or import from FreeFileSync. */
export function JobsList() {
  return (
    <EmptyState
      icon={<FolderSync size={28} />}
      title="No saved sync jobs yet"
      subline="Persisted jobs land in a later phase. For now, open the single-pair compare workspace or import folder pairs from FreeFileSync."
      actions={
        <>
          <Link to="/jobs/compare">
            <Button variant="primary">Open compare workspace</Button>
          </Link>
          <Link to="/settings/import">
            <Button variant="ghost">Import from FreeFileSync…</Button>
          </Link>
        </>
      }
    />
  );
}
