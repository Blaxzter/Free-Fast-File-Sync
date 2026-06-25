## fast-file-sync — Future-Proof Frontend Architecture + Backend Evolution

This is grounded in the actual code: stateless IPC in `src-tauri/src/lib.rs` (one global `AtomicBool` cancel, six commands), the single-pair `JobConfig { root_a, root_b, ignore, verify_by_hash, big_delete_*, use_recycle_bin }` in `config.rs`, the `Action`/`ConflictType`/`Resolution`/`PlanItem`/`SyncPlan`/`ApplyReport` enums in `model.rs`, the per-pair baseline keyed by `cfg.job_id()` = `blake3(root_a\0root_b)[..16]`, the throwaway single-file `src/App.tsx`, and the hand-written serde mirror in `src/api.ts`. The frontend below is a **clean rebuild**; the backend evolution is **additive** — the reconcile truth table and engine facade are untouched; we wrap them in a Job aggregate, a persisted store, and a run registry.

---

### 1. Stack choices (with rationale)

| Concern | Choice | Rationale |
|---|---|---|
| Build/bundler | **Vite + React 18 + TypeScript (strict)** | Already the Tauri default; keep it. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` on — the data model has many optional fields (`PlanItem.a?`, `conflict?`) and we want them load-bearing. |
| Routing | **TanStack Router** with a **memory/hash history** | Tauri webview has no server; never use `BrowserRouter`. TanStack Router gives typed routes + typed search params (the Preview view needs `?filter=conflicts&showInSync=false` to be shareable/restorable), file-free code-based route tree, and `loader`s that pair naturally with TanStack Query. The IA's URL scheme (`/jobs/:jobId/preview`, `/activity/:runId`, `/schedules`, `/watch`, `/cloud`) maps 1:1 to a typed route tree. If you prefer zero deps, React Router v6 in `createMemoryRouter` mode is an acceptable fallback, but you lose typed params. |
| Server-state / async cache | **TanStack Query** | Every Tauri `invoke` is conceptually an async query/mutation. Query gives caching, dedupe, background refetch, and `invalidateQueries` — exactly what `list_jobs`, `get_baseline_status`, `preview_job` need. Job list, baseline status, schedules, watchers, activity feed all become queries keyed by `['jobs']`, `['baseline', pairId]`, etc. Mutations (`save_job`, `execute_job`) invalidate the relevant keys. This replaces the ad-hoc `busy`/`useState` soup in the current `App.tsx`. |
| Client/UI state | **Zustand** (one small store) for cross-cutting UI only | Selected job, command-palette open, sidebar collapsed, theme/density, and the **live run registry mirror** (active runs + streamed progress) live here. Do NOT put server data in Zustand — that's Query's job. Live `sync://progress`/`run://*` events are pushed into Zustand by a single subscriber so any view (Activity, Run Console, bottom status strip) can read them. |
| Forms (Job/Pair/Schedule editors) | **React Hook Form + Zod** | The Job/Pair editors have nested, conditional fields (filter override inherits-or-overrides; mirror-mode shows extra safety copy). Zod schemas double as the **runtime validation boundary** for IPC payloads (see §4). |
| Virtualized grid | **TanStack Virtual** | The Preview/Plan grid must render 100k+ `PlanItem` rows at 60fps (UX principle: flat virtualized sortable grid is the primary diff view, not a tree). Plain `<table>` as in today's `App.tsx` will not scale. |
| Icons | **Lucide React** | Tree-shakeable, consistent 1.5px stroke, matches the dark dev-tool aesthetic. Reserve a small `glyph` map for the **meaning-encoded** ChangeKind/Action symbols from the cheatsheet (`+ ~ − ⇄ ·`, `↔ → ←`) rendered as styled spans, NOT icons — those are semantic text, color-coded, and must stay mono-aligned in the grid. |
| Styling | **CSS variables (`tokens.css`) + CSS Modules** | The DESIGN CHEATSHEET is already a token spec. Emit `tokens.css` (surfaces/border/text/accent + the MEANING map) and a `tokens.ts` that exports the **enum→color map keyed by the exact serde string** (`"CopyAtoB" → copy`, `"Conflict" → conflict`, `"StateDesync" → danger`). Single source of truth; the grid colors a row by looking up `MEANING[item.action]`. No Tailwind — the design is token-driven and dense; utility classes fight the mono-grid alignment. CSS Modules keep component styles local. |
| Dialogs | `@tauri-apps/plugin-dialog` (already a dep) | Folder pickers for rootA/rootB, file picker for `.ffs_batch`. |

**Rejected:** Redux (overkill; Query+Zustand cover it). Tailwind (token-driven dense UI). MUI/Chakra (consumer-app look, fights the k9s/Linear aesthetic). `BrowserRouter` (no server in webview).

---

### 2. Folder / component structure

```
src/
  main.tsx                      # mounts <App/>, QueryClientProvider, RouterProvider
  app/
    router.tsx                  # TanStack Router tree (all routes from the IA)
    queryClient.ts             # QueryClient + default options (staleTime, retry:false for IPC)
    store.ts                    # Zustand: ui state + live run registry mirror
  ipc/                          # THE ONLY PLACE THAT CALLS invoke()/listen()
    bindings.ts                 # generated/maintained TS types (see §3, §4)
    commands.ts                 # typed wrappers: previewJob(), executeJob(), listJobs()...
    events.ts                   # typed event subscriptions: onRunProgress, onWatchEvent...
    errors.ts                   # SyncError shape + errorMessage() (ported from api.ts)
    queries.ts                  # useJobs(), useBaseline(pairId), useActivity()... (Query hooks)
    mutations.ts               # useSaveJob(), useDeleteJob(), useRunJob()...
  domain/                       # pure TS: types + helpers, no React, no IPC
    job.ts                      # Job, FolderPair, SyncDirection, CompareMode, DeletionPolicy
    plan.ts                     # re-exports PlanItem etc + selectors (rank, group-by-pair)
    meaning.ts                  # tokens.ts MEANING map keyed by enum string
    schemas.ts                  # Zod schemas mirroring domain types (validation boundary)
  components/
    shell/                      # AppShell, Sidebar, TopBar (⌘K, breadcrumb, Sync-All), StatusStrip
    primitives/                 # Button, Toggle, Chip, StatusDot, Badge, Banner, Modal, Select, Toast, PathInput
    plan/                       # PlanGrid (virtualized), PlanRow, ChangeGlyph, ActionBadge,
                                #   ResolutionSelect, SummaryChips, BaselineBadge, BigDeleteGate, SafetyBanners
    job/                        # JobRow, PairList, PairRow, SharedSettingsSummary, ModeBadge
    filter/                     # FilterEditor (toggles + mono glob list + gitignore_hint + override side-bar)
    run/                        # RunConsole (progress phases + ItemOutcome log), CancelButton
  features/                     # route-level screens (one folder per IA domain)
    jobs/   JobsList, NewJobWizard, JobOverview, JobSettings, PairEditor, PreviewView, RunView
    activity/ ActivityFeed, ActivityDetail, ConflictsInbox
    schedules/ SchedulesList, ScheduleEditor
    watch/  WatchersDashboard
    cloud/  EndpointsList, EndpointEditor, DevicesList
    settings/ SettingsGeneral, SettingsImport, SettingsSafety, SettingsAccounts
  styles/
    tokens.css                  # the cheatsheet, verbatim, as CSS vars
    global.css                  # resets, mono/sans font stacks, grid layout
```

**Layering rule (enforced by lint boundaries):** `features/*` and `components/*` may import from `ipc/queries|mutations` and `domain/*`, but must NEVER call `invoke`/`listen` directly. Only `ipc/commands.ts` and `ipc/events.ts` touch Tauri. This is what makes cloud/watch/schedule additions a matter of adding hooks, not rewiring components — and makes the whole UI testable by mocking the `ipc` layer.

---

### 3. TS data model (Job-with-many-Pairs)

This is the **locked aggregate**, expressed so the Job fans out to today's per-pair `JobConfig` at execution. Keys are stable IDs so baselines, schedules, and watchers can reference a pair.

```ts
// domain/job.ts
export type CompareMode = "TimeAndSize" | "Content";            // Content => verify_by_hash
export type SyncDirection = "TwoWay" | "MirrorAtoB" | "MirrorBtoA" | "UpdateAtoB" | "UpdateBtoA";
export type DeletionPolicy =
  | { kind: "RecycleBin" }
  | { kind: "Permanent" }
  | { kind: "Versioning"; archiveDir: string };                  // P1

export interface IgnorePolicy {                                  // matches config.rs exactly
  use_gitignore: boolean; use_dot_ignore: boolean;
  include_hidden: boolean; custom_globs: string[];
}

export interface BigDeleteGuard { pct: number; abs: number; }    // 0.25 / 100 defaults

export interface FolderPair {
  id: string;                 // ulid; stable. Pair baseline keyed by pairBaselineId() (see §4)
  label: string;
  rootA: EndpointPath;        // see Endpoint — local today, remote-ready (P3)
  rootB: EndpointPath;
  enabled: boolean;
  filterOverride?: IgnorePolicy;   // undefined => inherit job.filter
}

export interface JobAutomation {                                 // slots exist day 1, backend P1/P2
  watch?:    { enabled: boolean; debounceMs: number; policy: WatchPolicy };
  schedule?: { enabled: boolean; cron: string; tz?: string; skipIfWatched: boolean };
}
export type WatchPolicy = "PreviewOnly" | "AutoApplySafe";       // never auto-applies conflicts/deletes

export interface Job {
  id: string; name: string; color?: string; createdAt: string; updatedAt: string;
  compareMode: CompareMode;
  direction: SyncDirection;
  deletion: DeletionPolicy;
  bigDelete: BigDeleteGuard;
  filter: IgnorePolicy;             // job-level; pairs may override
  pairs: FolderPair[];
  automation?: JobAutomation;
}

// Endpoint: local today, the seam for cloud/multi-device (P3). rootA/rootB are EndpointPath.
export type EndpointPath =
  | { kind: "Local"; path: string }
  | { kind: "Remote"; endpointId: string; path: string };       // S3/SFTP/peer, resolved via Cloud section
```

**Fan-out (frontend never does this — Rust does):** at preview/execute, the backend merges `job.{compareMode,direction,deletion,bigDelete,filter}` with each enabled pair (`filterOverride ?? job.filter`, `rootA/rootB`) into one engine `JobConfig` + one `SyncMode`, runs the existing `engine::preview/execute`, and tags results with `pairId`. The UI only ever sends `{ jobId, pairIds? }`.

`PlanItem`, `SyncPlan`, `ApplyReport`, `Action`, `ConflictType`, `Resolution`, `ChangeKind`, `BaselineStatusKind`, `Meta`, `BigDeleteWarning`, `ItemOutcome` stay **exactly as in `model.rs`** and are re-exported from `domain/plan.ts`. The only addition to `SyncPlan`/`PlanItem` is an optional `pairId: string` so the merged multi-pair grid can group rows per pair.

---

### 4. IPC layer organization + type safety

**Generate, don't hand-maintain, the bindings.** Today `src/api.ts` hand-mirrors serde — it will drift the moment the Job aggregate lands. Adopt **`tauri-specta`** (specta `#[derive(Type)]` on the Rust DTOs + `tauri-specta` export) to emit `ipc/bindings.ts` (types + command signatures) on every `cargo build`. This makes the Rust enums (`Action`, `ConflictType`, …) the single source of truth and eliminates the `api.ts` drift class of bugs. Where a generator isn't wanted, keep `bindings.ts` hand-written but mirror it with **Zod schemas in `domain/schemas.ts`** and parse every IPC response at the boundary so a backend/serde mismatch fails loudly in dev.

`ipc/commands.ts` — thin typed wrappers, one per command, all returning `Promise<T>` and normalizing errors through `errors.ts` (the existing `SyncError { kind, detail }` shape and `errorMessage()` port directly):

```ts
// reads
listJobs(): Promise<Job[]>
getJob(jobId): Promise<Job>
getBaselineStatus(jobId, pairId): Promise<BaselineStatusKind>
listActivity(filter): Promise<RunRecord[]>
getRun(runId): Promise<RunRecord>          // frozen SyncPlan + ApplyReport
listSchedules(): Promise<ScheduleView[]>
listWatchers(): Promise<WatcherView[]>
listEndpoints(): Promise<Endpoint[]>
// mutations
saveJob(job): Promise<Job>                 // upsert; returns canonical (ids filled)
deleteJob(jobId): Promise<void>
duplicateJob(jobId): Promise<Job>
previewJob(jobId, pairIds?): Promise<{ runId: string; plan: SyncPlan }>
executeJob(runId, resolutions, confirmBigDelete): Promise<void>  // streams; report via event
cancelRun(runId): Promise<void>            // per-run, NOT global
resetPairBaseline(jobId, pairId): Promise<void>
importFfsAsJob(path): Promise<Job>         // ONE job with N pairs (see §5)
setWatch(jobId, cfg): Promise<void>; setSchedule(jobId, cfg): Promise<void>
saveEndpoint(ep): Promise<Endpoint>; testEndpoint(epId): Promise<EndpointHealth>
```

`ipc/events.ts` — typed `listen` wrappers, all keyed by `runId` (critical: events must be addressable per run so two concurrent runs don't cross-talk — today's single `sync://progress` cannot do this):

```ts
onRunProgress(cb: (e: { runId; phase: "Scanning"|"Planning"|"Applying"; done; total; path; action }) => void)
onRunOutcome(cb: (e: { runId; item: ItemOutcome }) => void)     // streaming per-item log
onRunFinished(cb: (e: { runId; report: ApplyReport }) => void)
onWatchEvent(cb: (e: { jobId; pairId; queued: number; state }) => void)
onScheduleTick(cb: (e: { jobId; runId }) => void)
```

A single bootstrap subscriber wires these into Zustand's run registry; views select from it.

---

### 5. New Tauri commands / events / persisted storage (backend evolution)

The reconcile truth table and `engine::preview/execute` are **untouched**. Everything below wraps them.

**A. Job store (P0).** New `store.rs`: persist `Job` aggregates as `app_data_dir/jobs/<jobId>/job.json` (atomic temp+rename, same discipline as `baseline.rs`). Add `store::list/load/save/delete`. New commands: `list_jobs, get_job, save_job, delete_job, duplicate_job`. Baselines move from `jobs/<job_id()>/baseline.json` to `jobs/<jobId>/pairs/<pairId>/baseline.json`; `pairId` is the pair's stable ulid (or, for back-compat, derive the legacy `blake3(rootA\0rootB)` and migrate it once — see §6).

**B. Multi-pair fan-out + SyncMode (P0).** Add `SyncMode { TwoWay, MirrorAtoB, MirrorBtoA, UpdateAtoB, UpdateBtoA }` and a `mode_post_filter(decision, mode)` that re-maps the existing `Decision` AROUND `reconcile()` (Mirror: a B-side extra/`CreateOnB` → `DeleteB`; Update: drop all `Delete*`). The 25-cell reconcile tests stay green. A new `job.rs::fan_out(job) -> Vec<(pairId, JobConfig, SyncMode)>` produces today's `JobConfig` per enabled pair (filter = `pair.filterOverride ?? job.filter`). `preview_job(jobId, pairIds?)` loops pairs, runs `engine::preview` per pair, tags items with `pairId`, merges into one `SyncPlan` (now carrying `pairId` per item), registers a `runId`, and returns it.

**C. Run registry (P0) — replaces the global `AtomicBool`.** New `runs.rs`: `RunRegistry { Mutex<HashMap<RunId, RunHandle>> }` in `AppState`, each handle holding its own `cancel: AtomicBool` + the frozen `SyncPlan`. `execute_job(runId, resolutions, confirmBigDelete)` looks up the handle, runs `engine::execute` with that handle's cancel, emits `run://progress`, `run://outcome`, `run://finished` **tagged with `runId`**. `cancel_run(runId)` flips only that handle. This is the single chokepoint every trigger (manual, watch, schedule, remote) routes through, so the safety guards (delete suppression, big-delete gate, baseline trust) apply uniformly — the IA's hard rule.

**D. Activity persistence (P1).** On every finished run, persist a `RunRecord { runId, jobId, trigger: Manual|Watch|Schedule|Remote, startedAt, plan, report }` to `app_data_dir/activity/<runId>.json` (append-only audit). Commands: `list_activity(filter), get_run(runId)`. Conflicts Inbox = `list_activity` filtered to unresolved conflicts from latest previews.

**E. Scheduling (P1).** Add `tokio-cron-scheduler`. New `scheduler.rs` reads each `job.automation.schedule`, registers cron jobs that call the same `preview_job → (auto-apply only safe, never conflicts/deletes) → execute_job` path, tagging the run `trigger=Schedule`. Commands: `set_schedule(jobId,cfg), list_schedules, pause_schedule, run_schedule_now`. Event: `schedule://tick`.

**F. Real-time Watch (P1).** Add the **`notify`** crate (cross-platform; ReadDirectoryChangesW on Windows). New `watch.rs`: per-armed-pair debounced (`notify-debouncer-full`) watcher; on settle it enqueues a `preview_job`. Per `WatchPolicy`: `PreviewOnly` surfaces to Conflicts Inbox + a toast; `AutoApplySafe` auto-executes ONLY non-delete/non-conflict items (deletes & conflicts always defer). Commands: `set_watch(jobId,cfg), list_watchers, pause_all_watch`. Events: `watch://event`, `watch://state`. The watcher must IGNORE the baseline/state dir and respect the same `IgnorePolicy` so it doesn't self-trigger on `node_modules` churn (reuse the `ignore` crate matcher).

**G. Cloud / endpoints (P3).** Introduce a `Fs` trait (scan/stat/read/write/delete) behind `scan.rs`/`fsops.rs`; `LocalFs` today, `S3Fs`/`SftpFs`/`PeerFs` later. `EndpointPath::Remote` resolves through a stored `Endpoint`. Commands: `list_endpoints, save_endpoint, test_endpoint, list_devices, pair_device`. No structural change to the Job model — `rootA/rootB` are already `EndpointPath`.

**Persisted layout (all in `app_data_dir`, never inside a synced root — existing convention):**
```
jobs/<jobId>/job.json
jobs/<jobId>/pairs/<pairId>/baseline.json
activity/<runId>.json
settings.json                # global defaults (compare/deletion/filter, gitignore-on, thresholds, theme/density)
endpoints/<endpointId>.json  # P3
```

---

### 6. Build-out from the prototype (clean project — no back-compat)

This is a clean new project: no users, no shipped data, no persisted jobs or baselines that matter (everything so far lives in throwaway temp/app-data dirs). There is **no internal migration** — choose the right shapes from the start and delete the scaffolding.

1. **Delete the prototype, build clean.** Today's `App.tsx`/`api.ts`/`styles.css` are throwaway scaffolding — remove them (git history is the only archive needed) and stand up the shell (§2) with `tokens.css` first, so every screen is visually correct from row 1.
2. **Reuse the engine commands as-is, wrapped.** `validate_job, preview_sync, execute_sync, cancel_sync, get_baseline_status, import_ffs` keep working. New Job-level commands are thin **wrappers** that, per pair, construct a `JobConfig` and call the existing engine functions. Nothing in `engine.rs` changes on day one.
3. **Port the reusable parts of `api.ts`**: `errorMessage()`, the `SyncError` shape, and the `model.rs`-mirroring types (`PlanItem`, `Action`, `Resolution`, …) move into `ipc/bindings.ts` + `domain/`. The Preview-grid logic in today's `App.tsx` (`rank()`, conflict default-resolution prefill, big-delete gate, baseline badge map) is sound — re-implement it in `components/plan/*` as real components.
4. **Key baselines per pair from the start.** Store each pair's baseline at `jobs/<jobId>/pairs/<pairId>/baseline.json` (reuse the existing `job_id()` hash as the pair id). No re-keying and no fallback path — there are no existing baselines to preserve.
5. **Build `import_ffs` to return ONE Job with N pairs.** (Today it returns N `ImportedJob`s.) Keep the existing parser; change only the assembly: shared settings on the Job, per-pair excludes as `filterOverride`, and the `two_way` flag → `direction`. A one-way FFS pair simply becomes a **Mirror** pair once Mirror mode lands (P1) — there is no "lossy import" concern.

---

### 7. Ordered implementation roadmap

See the structured `roadmap` field. Summary: **Phase 0** scaffolds the typed shell, tokens, and `ipc/` boundary over the *existing* engine commands (single-pair, no model change) so the app looks and routes right immediately. **Phase 1** lands the Job aggregate, job store, run registry (kills the global cancel), multi-pair fan-out + SyncMode (mirror/update — the biggest parity hole), and rebuilds Preview/Run/Conflicts as real components. **Phase 2** adds Activity persistence, Scheduling, and the `notify`-based Watch daemon — all routing through the one run registry so safety guards stay uniform. **Phase 3** adds the `Fs` trait + remote endpoints + devices, making Cloud/Devices functional with zero Job-model change.

**Planned conflict-UX enhancements** (see DESIGN.md → *Conflict Resolution* (7), not built in Phase 0): (a) a **"peek both" side-by-side / diff preview** for text conflicts — read-side command `get_preview_content` + client-side diff, capability-gated via the backend's `can_preview`, lands with Phase 1 (polish in Phase 2); (b) a **standing `conflict_policy`** ("always resolve as X", scopes global→job→pair) that pre-fills the `resolutions` map with HARD carve-outs (StateDesync and big-delete never auto-resolve) — per-job in Phase 1, the unattended/scheduled projection in Phase 2. Both reuse existing engine primitives (`resolution_options`/`default_resolution`/the resolutions map); neither touches `reconcile()`.

**Key invariants for the engineer:** (1) only `ipc/commands.ts`/`events.ts` may call `invoke`/`listen`. (2) Every run — manual, watch, schedule, remote — goes through `preview_job → execute_job` so delete-suppression, big-delete gate, and baseline trust apply once, everywhere. (3) The reconcile 25-cell truth table is sacred; mirror/update are a post-filter on `Decision`, never a fork of `reconcile()`. (4) Colors come only from `domain/meaning.ts` keyed by the serde enum string — never hardcoded in components.