/* TanStack Router tree for the full IA. Code-based (no file routes), memory
 * history (Tauri webview has no server — never BrowserRouter). Sections not yet
 * built render a proper "Coming soon" empty state, never a blank screen. */

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "../components/shell/AppShell";
import { ComingSoon } from "../features/ComingSoon";
import { CompareWorkspace } from "../features/jobs/CompareWorkspace";
import { JobDetail } from "../features/jobs/JobDetail";
import { JobEditor } from "../features/jobs/JobEditor";
import { JobsList } from "../features/jobs/JobsList";
import { SettingsGeneral } from "../features/settings/SettingsGeneral";
import { SettingsImport } from "../features/settings/SettingsImport";

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/jobs" });
  },
});

// ---- Jobs domain ----
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs",
  component: JobsList,
});
const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/compare",
  component: CompareWorkspace,
});
const jobNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/new",
  component: () => <JobEditor />,
});
const jobEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/$jobId/edit",
  component: function JobEditRoute() {
    const { jobId } = jobEditRoute.useParams();
    return <JobEditor jobId={jobId} />;
  },
});
// Job detail: the multi-pair Compare/Run view (S9). Preview/Apply/Cancel a job's
// folder pairs over the single multi-pair run surface.
const jobDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/$jobId",
  component: function JobDetailRoute() {
    const { jobId } = jobDetailRoute.useParams();
    return <JobDetail jobId={jobId} />;
  },
});

// ---- Activity domain ----
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  component: () => (
    <ComingSoon
      title="Activity"
      description="Run history and the live run console land with the run registry in a later phase."
    />
  ),
});
const conflictsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity/conflicts",
  component: () => (
    <ComingSoon
      title="Conflicts Inbox"
      description="Cross-job aggregation of unresolved conflicts. Resolve conflicts inline in the compare workspace for now."
    />
  ),
});

// ---- Schedules domain ----
const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schedules",
  component: () => (
    <ComingSoon
      title="Schedules"
      description="Cross-job cron triggers, next-run ordering, and pause/run-now arrive with the scheduler."
    />
  ),
});

// ---- Watch domain ----
const watchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/watch",
  component: () => (
    <ComingSoon
      title="Watch"
      description="The real-time file-system watcher dashboard arrives with the notify-based daemon."
    />
  ),
});

// ---- Cloud / Devices domain ----
const cloudRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cloud",
  component: () => (
    <ComingSoon
      title="Cloud / Devices"
      description="Remote endpoints (S3, SFTP/NAS, peers) and paired devices arrive with the Fs trait backend."
    />
  ),
});

// ---- Settings domain ----
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsGeneral,
});
const settingsImportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/import",
  component: SettingsImport,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  jobsRoute,
  compareRoute,
  jobNewRoute,
  jobEditRoute,
  jobDetailRoute,
  activityRoute,
  conflictsRoute,
  schedulesRoute,
  watchRoute,
  cloudRoute,
  settingsRoute,
  settingsImportRoute,
]);

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/jobs"] }),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
