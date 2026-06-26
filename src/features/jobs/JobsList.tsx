/* Jobs List: the real persisted list from useJobs(). One JobRow per job (name,
 * enabled-pair count, aggregated baseline status). Top actions: New Job ->
 * /jobs/new, Import from FreeFileSync -> /settings/import. An empty store shows
 * the same actions in an EmptyState. Clicking a row opens its detail. */

import { useNavigate } from "@tanstack/react-router";
import { FolderSync, Plus } from "lucide-react";
import { JobRow } from "../../components/job/JobRow";
import s from "../../components/job/job.module.css";
import { Button } from "../../components/primitives/Button";
import { EmptyState } from "../../components/primitives/EmptyState";
import { useJobs } from "../../ipc/queries";

export function JobsList() {
  const navigate = useNavigate();
  const { data: jobs, isLoading } = useJobs();

  const goNew = () => void navigate({ to: "/jobs/new" });
  const goImport = () => void navigate({ to: "/settings/import" });

  if (!isLoading && (!jobs || jobs.length === 0)) {
    return (
      <EmptyState
        icon={<FolderSync size={28} />}
        title="No saved sync jobs yet"
        subline="Create a job to pair folders and sync them, or import folder pairs from FreeFileSync."
        actions={
          <>
            <Button variant="primary" icon={<Plus size={15} />} onClick={goNew}>
              New job
            </Button>
            <Button variant="ghost" onClick={goImport}>
              Import from FreeFileSync…
            </Button>
          </>
        }
      />
    );
  }

  return (
    <div className={s.list}>
      <div className={s.listHeader}>
        <h1 className={s.listTitle}>Jobs</h1>
        <div className={s.listActions}>
          <Button variant="ghost" onClick={goImport}>
            Import FFS…
          </Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={goNew}>
            New job
          </Button>
        </div>
      </div>

      <div className={s.rows}>
        {(jobs ?? []).map((job) => (
          <JobRow
            key={job.id}
            job={job}
            onOpen={(id) => void navigate({ to: "/jobs/$jobId", params: { jobId: id } })}
          />
        ))}
      </div>
    </div>
  );
}
