# fast-file-sync — Product & UI Design

---

> A modern, fast, reliable FreeFileSync competitor that natively respects .gitignore.
> Direction: full sidebar desktop app · dark dev-tool aesthetic · one job = many folder pairs · architected for scheduling, real-time watch, and cloud/multi-device.

---

## Executive Summary

fast-file-sync is a local-first file synchronization tool positioned as a modern FreeFileSync competitor. Its moat is already built: a tested, pure 5x5 three-way reconciliation engine over a checksummed, atomically-written baseline, with layered safety guards (delete suppression on scan errors, big-delete gate, first-sync union mode, case-collision detection, TOCTOU re-validation, atomic temp+rename copies, recycle-bin deletes, deterministic keep-both conflict copies) and gitignore-syntax filtering. The gap is the product layer: today there is no persisted named-job model, no multi-pair jobs, no one-way mirror/update modes, no scheduling/watch/remote, and only a throwaway UI over six stateless IPC commands.

The design direction is a dark, dense, keyboard-first developer tool whose entire reason to exist is making a powerful-but-dangerous engine legible and trustworthy. Every screen separates "what changed" from "what we'll do," names sync directions by their plain-English outcome rather than jargon, recommends a per-row action the user can override inline, and never auto-applies a conflict. The IA introduces a Job aggregate (one Job -> shared settings + N Pairs, each with an optional filter override) that fans out to today's per-pair engine config with zero changes to the reconcile truth table, so the shell ships additively over the existing engine.

This document is the product and UI design specification. It contains: the ground-truth audit of engine vs. product layer; the FreeFileSync parity matrix and prioritization; the locked Job/Pair information architecture and app-shell layout; the UX principles distilled from competitor research (FreeFileSync, Syncthing, Unison, Dropbox/OneDrive); the color/meaning token system; and a four-phase roadmap (Phase 0 shell + typed IPC, Phase 1 job persistence + mirror/update modes, Phase 2 activity audit + scheduling + watch, Phase 3 cloud/multi-device behind an Fs trait).

---

## Design Principles

- Name directions by outcome, not jargon: pair every direction control with a literal arrow and a plain-English sentence of what will happen, avoiding Syncthing's send/receive-only confusion.
- Separate observation from action: 'what changed' and 'what we'll do' are two explicit, labeled, color-coded columns, never a single cryptic center glyph (FreeFileSync's failure mode).
- Flat grid first: a virtualized, sortable, filterable row grid is the primary diff view; a tree is at most an optional grouping toggle (FFS's tree redesign was reverted after backlash).
- Recommend, then let the user override: show an auto-recommended action per row, visually distinct from user-overridden choices (Unison's green/blue model), with keyboard-first per-row resolution.
- Conflicts are sacred and never auto-applied: surface them as both a filterable grid category and a durable Activity/Inbox queue, with side-by-side versions and keep-left/right/both verbs.
- Two clearly-scoped filter levels (Job vs Pair-override) with a live effective-result preview; support include-after-exclude/negation and avoid FFS's additive-only, backslash-as-directory traps.
- Progress is three explicit phases - Scanning (indeterminate + count), Planning, Applying (determinate) - with current file, throughput, an ETA explicitly labeled 'estimate', remaining count, and a scrolling per-item log; Pause/Cancel always visible and pause lands on a file boundary.
- Adopt the learned Dropbox/OneDrive status vocabulary (green=ok, blue=syncing, orange/red=attention, cloud=remote) and render it inside the app, not via unreliable OS shell overlay icons.
- Color encodes meaning only and consistently: copy=blue, delete=orange, conflict=magenta, ok=green, muted=gray, plus a reserved safety-amber used exclusively for guard/suppression states (first-sync, corrupt baseline, big-delete, scan-error).
- Progressive disclosure everywhere: Basic/Advanced split, inline help on every non-obvious field, and never make a required action reachable only through a transient modal or toast (Syncthing's vanishing-dialog failures).
- Safety is legible from first contact: first-run is a guided job-creation flow defaulting to a non-destructive Preview/dry-run, with an explicit 'Save job' vs 'Preview & sync' distinction (the exact step FFS users stumble on).

---

## Product & Feature Plan

# fast-file-sync — Product & Feature Plan

## 1. Where the code actually is today (ground truth)

Read of `engine.rs`, `plan.rs`, `reconcile.rs`, `apply.rs`, `baseline.rs`, `config.rs`, `model.rs`, `ffs_import.rs`, `lib.rs`:

**The engine is genuinely strong and is the moat.** It is a tested, pure 5×5 three-way reconciliation table (`reconcile.rs`) over a checksummed, atomically-written baseline (`baseline.rs`), with layered safety: filtered-file delete guard, first-sync/corrupt-baseline union mode, scan-error delete suppression, big-delete guard, case-collision detection (`plan.rs`), TOCTOU re-validation per item, atomic temp+rename copies, recycle-bin deletes, deterministic `sync-conflict` keep-both copies (`apply.rs`). gitignore/.ignore/custom-globs respected via the `ignore` crate (`config.rs::IgnorePolicy`).

**But the product layer barely exists.** Critical gaps the plan must close:
- **No job store / persistence.** `JobConfig` is single-pair (`root_a`, `root_b`); only a per-job `baseline.json` is persisted, keyed by `blake3(root_a\0root_b)`. There is no concept of a saved, named job, no list of jobs, no settings file. The UI is a throwaway prototype.
- **No multi-pair Job.** The locked data model (one Job → many FolderPairs) is NOT in the Rust types. The FFS importer even emits **N separate `ImportedJob`s** (one per `<Pair>`), the opposite of the target model where one `.ffs_batch` → one Job with N pairs.
- **Two-way ONLY.** `Action`/`reconcile` have no mirror/one-way mode. The importer literally *warns* when FFS had a one-way mirror because we can't honor it. This is a parity hole, not just a UX gap.
- **No scheduling, no watch/daemon, no cloud/remote, no multi-device.** No remote filesystem abstraction; everything is `std::fs` on local/UNC paths.
- IPC (`lib.rs`) is stateless per call (`validate_job`, `preview_sync`, `execute_sync`, `cancel_sync`, `get_baseline_status`, `import_ffs`). One global `cancel: AtomicBool` — cannot run/track multiple syncs.

## 2. FreeFileSync parity matrix

| FFS feature | FFS has it | We have today | Priority |
|---|---|---|---|
| Two-way sync (mirror of changes) | Yes | **Yes** — three-way baseline reconcile, fully tested | — (done, ahead) |
| One-way **Mirror** (left→right, deletes extras) | Yes | **No** — engine is two-way only; importer warns | **P0** |
| One-way **Update** (left→right, no deletes) | Yes | No | P1 |
| **Custom** per-direction rules (per change-type) | Yes | No (we infer two-way/mirror only) | P2 |
| Multiple folder pairs in one config | Yes | **No** — single root pair per JobConfig | **P0** |
| Per-pair local filter overriding global | Yes | Partially (importer merges globs; no runtime model) | **P0** |
| Compare by **time+size** | Yes | **Yes** (default; mtime granularity-aware) | — |
| Compare by **content/hash** | Yes | **Yes** — `verify_by_hash` (blake3) | — |
| Include/Exclude filters (glob) | Yes | **Yes** — `custom_globs`, gitignore-syntax | — |
| Size / date filters | Yes | **No** | P2 |
| Recycle-bin deletions | Yes | **Yes** — `use_recycle_bin` | — |
| **Versioning** (timestamped deleted-file archive) | Yes | **No** (we recycle/conflict-copy only) | **P1** |
| Conflict detection & handling | Partial (FFS is timestamp-led) | **Yes, stronger** — typed conflicts, never auto-applied | — (ahead) |
| Batch / headless run (`.ffs_batch`) | Yes | **No runner** (we only *import* the file) | P1 |
| **Scheduling** (via OS Task Scheduler / RTS) | External | **No** | P1 |
| **Real-time sync** (RealTimeSync watcher) | Separate tool | **No** | P1 |
| Run a script/command on completion | Yes | No | P3 |
| Email/log on completion | Yes | No (we have `ApplyReport`) | P2 |
| Copy locked files (VSS) | Yes (Donation Ed.) | No | P3 |
| Network share / UNC | Yes | **Yes** (local FS; importer flags UNC) | — |
| **Symlink handling** (follow/copy) | Yes (configurable) | Recorded but never traversed/written (safe-skip) | P2 |
| Copy file permissions/ACLs | Yes | **No** (content + mtime only) | P2 |
| Two-config comparison / grid view | Yes | No (we have a richer `PlanItem` stream) | P2 |
| **gitignore-native** filtering | **No** | **Yes** — headline differentiator | — (ahead) |
| Progress + cancel | Yes | **Yes** — `sync://progress`, `cancel_sync` | — |
| Crash-safety / atomic baseline | Partial | **Yes, stronger** — checksum + atomic rename | — (ahead) |

**Net:** our *engine safety + gitignore* already beat FFS. The parity debt is entirely **product/model** (one-way modes, multi-pair jobs, persistence, a runner/scheduler/watcher), not core algorithm.

## 3. Differentiators (lead with these)

1. **gitignore-native** (`ignore` crate): point at a repo, dev junk (`node_modules`, `target`, `dist`, `__pycache__`) vanishes with zero hand-written filters. FFS *cannot* do this — our importer quantifies it (`gitignore_hint`). This is the wedge for the developer audience.
2. **Safety is legible, not buried.** Typed conflicts (`ConflictType`) that are *never auto-applied*; recoverable deletes; scan read-error → deletions suppressed; corrupt/first-sync baseline → union-only; big-delete guard requiring explicit `confirm_big_delete`. The UI must *surface* each of these as a trust signal (badges, banners), turning correctness into a visible feature.
3. **Modern dev-tool UX** replacing FFS's dated grid: dark, dense, monospace paths, color-by-meaning (copy=blue, delete=orange, conflict=magenta, ok=green), keyboard-first, fast preview streaming.
4. **One app, future-proofed for cloud/multi-device.** FFS needs RealTimeSync + Windows Task Scheduler as *separate* tools; we ship Jobs, Schedules, Activity, Watch, and Cloud/Devices as first-class sidebar sections from day one.
5. **Frictionless migration:** native `.ffs_batch` importer (already built) that also *advises* dropping redundant excludes in favor of gitignore.

## 4. Prioritized roadmap

**P0 — Make it a real product (model + modes the rest depends on).**
- Introduce the **Job → many FolderPairs** model in Rust + a persisted **job store** (jobs.json in app-data, alongside the existing per-pair baselines). Key each pair's baseline by its own root-pair hash (reuse the existing `job_id()` hash as the pair id).
- **One-way Mirror & Update modes** in the engine: add a `SyncMode` to the reconcile layer (Mirror: extras on right are deleted to match left; Update: copy/overwrite, never delete). This is the biggest parity hole and unblocks honoring imported FFS mirror pairs.
- Rework `import_ffs` to emit **one Job with N pairs + shared settings** (matches locked model); per-pair filter overrides preserved.
- Build the **real shell**: persistent left sidebar (Jobs / Schedules / Activity / Cloud-Devices / Settings), Job detail with pair list, streaming preview grid, conflict resolution UI, safety banners. Replace prototype `App.tsx`.
- Stateful IPC: `list_jobs`, `save_job`, `delete_job`, `preview_job`/`execute_job` keyed by job+pair; replace the single global `cancel` with a per-run handle/registry.

**P1 — Trust, automation, parity depth.**
- **Versioning** deletion policy (timestamped archive) as an alternative to recycle-bin; surfaces as a per-job/pair setting.
- **Scheduling**: cron-like per-job schedules (a `Schedule` entity, a background runner). Activity log of past runs (persist `ApplyReport`s).
- **Watch / real-time auto-sync daemon** (debounced FS watcher per pair → triggers preview/execute). Architect the run-registry now so watch + schedule + manual all share it.
- **Batch/headless runner** for imported `.ffs_batch` jobs (CLI + scheduled).

**P2 — Polish & long-tail parity.**
- Size/date filters; per-pair filter editing UI; symlink follow/copy option; permission/ACL preservation option; completion notifications; richer Activity (diffs, byte totals from `ApplyReport`).

**P3 — Cloud & multi-device.**
- Remote filesystem abstraction (trait behind the scanner/fsops) for S3 / remote NAS / peer devices; accounts; the Cloud/Devices section becomes functional. Locked-file/VSS, post-sync scripts.

## 5. Architecture notes for the engineer
- The reconcile **truth table is sacred** — add modes *around* it (a mode-aware post-filter on `Decision`, e.g. Mirror reinterprets `CopyBtoA`/`CreateOnB`-extras as `DeleteB`), don't fork `reconcile()`. Keep the 25-cell tests green.
- Every new surface (watch, schedule, cloud) must route through `preview`→`execute` so the **safety guards (delete suppression, big-delete, baseline trust) apply uniformly**. Do not let the watcher bypass them.
- Persistence lives in app-data next to `jobs/<pair_id>/baseline.json`; never inside a synced root (already the convention in `lib.rs`).

---

## Competitor UX Research

## How comparable sync tools structure their UIs — research synthesis for fast-file-sync

Sources are listed at the bottom. This is distilled into concrete, implementation-ready patterns mapped to our locked design (left sidebar, dev-tool dark, one-job/N-pairs, conflict safety).

### Tool-by-tool teardown

**FreeFileSync (our closest analog & primary competitor)**
- *Model that we are correctly copying:* one config = N folder pairs sharing job-level settings (compare variant, sync direction, deletion policy, global filter); each pair can override the filter. This is the proven mental model — keep it. Our importer already maps 1 ffs_batch -> 1 job with N pairs, so the IA is consistent end-to-end.
- *The center compare grid is its strongest idea AND its biggest liability.* It shows left-attributes | center direction-symbol | right-attributes per row, with a category column. Users praise the power; the recurring complaints are: looks "amateurish/outdated", information-dense to the point of overwhelming, and the 10.25 tree-view redesign was hated badly enough that 11.0 reverted to a flat grid ("solved almost all issues"). **Lesson: a flat, sortable, filterable row grid beats a tree; do not ship a tree as the primary diff view.** A collapsible tree can be an optional grouping toggle only.
- *Direction/category column is load-bearing but cryptic.* The middle column encodes both "what changed" and "what we'll do" via tiny glyphs; new users can't decode it and complain the "exists on left/right only" indicator is ambiguous. **Lesson: split "change detected" from "action to take" into two explicit, labeled, color-coded columns; never rely on an unlabeled glyph alone.**
- *Filters are the #1 confusion.* "Global vs local" naming is non-obvious (global = applies to >1 pair; local = one pair). The killer footgun: a local filter is *additive* and **cannot un-exclude** what the global filter excluded, and exclusions are relative to the pair root with backslash-means-directory semantics. Users resort to duplicating folder pairs to express "exclude X except *.txt". **Lessons:** (a) rename to "Job filter" / "Pair filter (overrides)"; (b) show effective/merged filter result live; (c) since our differentiator is .gitignore, we must make include-after-exclude (negation, `!pattern`) a first-class, working concept — it's exactly what FFS can't do cleanly.
- *Onboarding is widely called complex/convoluted* ("looks extremely complicated"; saving vs running a sync is unclear; the batch-job concept is opaque). The save-config vs run-now distinction trips everyone.

**Syncthing (cautionary tale on terminology & silent state)**
- Folder-type/transfer modes ("Send Only / Receive Only / Send & Receive") are repeatedly cited as the worst confusion — users "can't tell which way data will transfer," and help text references undefined terms ("the cluster"). **Lesson: name our directions by *outcome* not jargon — e.g. "Two-way", "Mirror left→right (right is a copy)", "Update left→right (never delete on right)" — and render a literal arrow + plain-English sentence of what will happen.**
- First-run review: too much complexity up front; advanced fields (dynamic, compression, introducer) shown inline with no descriptions; **dialogs that vanish on "Close" with no way to reopen** were called a critical workflow break. **Lessons: progressive disclosure (Basic / Advanced tabs), inline help on every non-obvious field, and never make a needed action reachable only through a transient modal.**
- Missed events: share/add-device prompts could be missed if the UI wasn't open. **Lesson: a persistent Activity/Inbox section (we already have one) must durably queue everything needing attention — conflicts, scan errors, pending approvals — so nothing is lost to a dismissed toast.**
- Conflict handling is `.sync-conflict-*` sidecar files with no in-app resolver; the community explicitly asks for a UI list of conflicts to pick a winner. **This is a gap we can win on.**

**Resilio Sync** — same P2P model as Syncthing but consistently rated more usable because of a polished web UI, real **selective sync** (choose which folders/files sync to which device), and a central management console. **Lesson: selective sync (per-device subset) and a fleet/console view validate our planned Cloud/Devices section; design the pair list so a pair can later carry per-device selection state.**

**Unison-GTK (best conflict/direction interaction model found)**
- Two-pane reconcile list where each item shows a **proposed-action arrow**. Key UX win: **color encodes provenance** — green arrow = Unison's recommendation, blue arrow = a user override. Users press `<` / `>` to force direction per item, Enter to accept and advance. **Lessons we should adopt directly:** (a) show a recommended action per row and let the user override it inline; (b) visually distinguish "auto-recommended" from "user-overridden"; (c) keyboard-first per-row resolution (force-left / force-right / skip) — perfect for our dev-tool, dense, fast aesthetic.

**rsync GUIs / Beyond Compare (progress patterns)**
- Live progress wants: per-file current item, throughput, ETA, count remaining, plus resumability. Two honest pitfalls: (1) a long "Calculating…" scan phase before any progress, and (2) ETA computed from short-window throughput jumps wildly. (3) Pause can only act at file boundaries, not mid-file. **Lessons: show the scan/count phase as its own distinct indeterminate stage; smooth ETA over a longer window and label it "estimate"; make Pause/Cancel always visible but document that pause lands at the next file boundary; surface a live scrolling per-file log (k9s-style) for the dense look.**

**Dropbox / OneDrive (status iconography)**
- Universally legible vocabulary: green check = synced/ok, blue circular arrows = syncing, red X = error, cloud = remote-only/not-yet-local. **Lesson: adopt this exact, culturally-learned status vocabulary for per-pair and per-row state badges.** Avoid relying on OS shell overlay icons (only ~11 Windows overlay slots; apps fight over them and lose) — render status **inside our own UI**, not via Explorer overlays.

---

### Mapping to our six required surfaces

**1. Multi-job sidebar** — persistent left rail, sections Jobs / Schedules / Activity / Cloud&Devices / Settings (already locked). Each Job row: name + last-run status badge (Dropbox vocabulary) + a tiny direction glyph + counts (e.g. "12↑ 3↓ 1⚠"). A job expands to its N pairs; a pair row shows left/right roots in monospace, its own status badge, and "filter overridden" tag if local filter present. Selecting job vs pair scopes the main panel. Keep it information-dense, color only for meaning.

**2. Per-pair compare grid** — flat, virtualized, sortable rows (not a tree; tree is an optional grouping toggle). Columns: [select] · relative path (monospace, ellipsize in middle) · left attrs (size/mtime) · **Change column** (created/modified/deleted/moved/conflict — labeled + colored: copy=blue, delete=orange, conflict=magenta, ok=green) · **Action column** (the proposed action, overridable inline à la Unison; user-overridden rows visually distinct from auto-recommended) · right attrs. Sticky header, count summary bar, filter-as-you-type. Honor color semantics from the brief exactly. A pair selector (tabs or dropdown) switches between the job's pairs without leaving the grid.

**3. Conflict resolution** — conflicts are NEVER auto-applied (locked safety value); surface them as their own filterable category in the grid AND as a durable queue in Activity. Per-row inline resolver with keyboard verbs: keep-left / keep-right / keep-both(rename) / skip. Show both versions' size+mtime side by side; offer "keep newer/larger" bulk helpers but require an explicit click. Adopt Unison's green=recommended / accent=user-override coloring. Never use vanishing modals — resolution state persists in the plan.

**4. Filter editing** — two scopes clearly labeled "Job filter" and "Pair filter (overrides job)". Live preview: as the user edits patterns, show how many items become included/excluded and let them toggle a "show excluded" view in the grid. Make negation/include-after-exclude actually work (our .gitignore edge over FFS) and show the *effective merged* rule set. Provide a ".gitignore: respected" toggle as a visible, explained switch with a link to what it does. Avoid FFS's additive-only trap and the backslash-means-dir ambiguity by using explicit "Files / Folders / Both" target selectors.

**5. Progress** — three explicit phases: Scanning (indeterminate, with running count) → Planning → Applying (determinate). During apply: overall bar + current file (monospace) + throughput + smoothed ETA labeled "est." + remaining count + a scrolling per-item result log (ok/copied/deleted/error, color-coded). Pause (lands at next file boundary — say so) and Cancel always visible. On completion show an ApplyReport summary (copied/deleted/conflicts-left/errors) with errors expandable. Make the scan-error-suppresses-deletes safety rule visibly stated when it triggers ("3 deletions held back because a folder couldn't be fully read").

**6. First-run** — avoid Syncthing/FFS overwhelm. Guided "Create your first job": name → add first folder pair (left/right folder pickers, not raw paths) → pick direction by *outcome* with a plain-English preview sentence and arrow → optional .gitignore toggle → **Preview (dry-run) is the default next step, never an immediate destructive sync.** Make the save-config vs run-now distinction explicit (two clearly different buttons: "Save job" vs "Preview & sync") — the exact thing FFS users stumble on. Progressive disclosure everywhere; advanced settings collapsed.

---

### Trust/safety made legible (our differentiator)
- Always dry-run/preview before apply; "Sync" button is gated behind a reviewed plan.
- Deletes route to recycle bin and say so per row; big-delete guard shows an explicit confirmation with the count and a sample.
- Scan read-error visibly suppresses deletions, with a named reason in the UI.
- Conflicts shown, queued, never silently resolved.
- Baseline status ("vs last sync") surfaced so the three-way reconciliation is understandable, not magic.

---

## Information Architecture

## fast-file-sync — Information Architecture

### 0. Grounding (what the IA must wrap)
The Rust engine today is **per-root-pair**: `JobConfig { root_a, root_b, ignore, verify_by_hash, big_delete_*, use_recycle_bin }`, driven by a locked two-phase flow `preview_sync → SyncPlan → (resolve conflicts) → execute_sync → ApplyReport`, with `sync://progress` events and `cancel_sync`. The FFS importer already turns ONE config into **N `ImportedJob`s** (each = a pair). The IA introduces a **Job aggregate** above the engine: one Job = job-level settings (compare mode, direction/mirror, deletion policy, gitignore/filter, safety thresholds) + an ordered list of **Pairs**, where each Pair carries its own `root_a`/`root_b` and an OPTIONAL filter override. At execution the Job fans out to one engine `JobConfig` per Pair (job settings merged with pair override → today's `JobConfig`). This is purely additive — no engine change required to ship the shell.

```
Job (aggregate, persisted as job.json)
 ├─ identity:   id, name, color/tag, createdAt
 ├─ shared:     compareMode (TimeAndSize | Content=verify_by_hash)
 │              direction   (TwoWay | MirrorAtoB | MirrorBtoA)
 │              deletion    (RecycleBin | Permanent) + bigDelete {pct, abs}
 │              filter      (IgnorePolicy: gitignore, dotIgnore, hidden, customGlobs)
 ├─ pairs[]:    { id, label, rootA, rootB, enabled, filterOverride?: IgnorePolicy }
 ├─ automation: watch {enabled, debounceMs}  schedule {cron, enabled}  (Phase 2+)
 └─ remote:     endpointRef? (local | S3 | NAS/SFTP | peer)            (Phase 3+)
```
Each Pair → one engine `JobConfig` and one persisted baseline (`job_id()` is already derived from the root pair, so per-pair baselines drop in cleanly).

---

### 1. App shell
Persistent **left sidebar** + main content + a global **top bar** (breadcrumb, global Sync-Now / Sync-All, command palette ⌘K) and a thin **bottom status strip** (active watchers count, next scheduled run, last activity result, remote connectivity dot). Dark, dense, monospace for every path. Color encodes meaning only: **copy=blue, delete=orange, conflict=magenta, ok=green, muted=gray**, plus a **safety-amber** used exclusively for guard/suppression states (FirstSync, Corrupt baseline, big-delete, scan-error). The shell is a single React tree with hash/memory routing (Tauri webview); no server round-trips for navigation.

---

### 2. Sidebar sections (every section has a home from day 1)

1. **Jobs** — the spine. List of all Jobs (name, color tag, pair count, mode badge, baseline/health dot, last-run result, watch/schedule indicators). Primary place users live. Drill into a Job → its Pairs and Preview/Apply.
2. **Activity** — chronological run history + the live run console. Every preview/apply (manual, watch-triggered, scheduled, remote) lands here as an Activity record with its `ApplyReport`/`SyncPlan` summary. The single source of "what did it do / what is it doing".
3. **Schedules** — cross-job calendar/list of all cron triggers; create/pause/run-now. A management lens over the per-Job `schedule` field, so users see contention and next-run ordering across jobs.
4. **Watch** — live watchers dashboard: which Jobs/Pairs have the real-time daemon armed, current debounce/queue state, pause-all kill switch. Management lens over per-Job `watch`. (Folded under Activity until Phase 2 lands, but reserved as its own slot now.)
5. **Cloud / Devices** — remote endpoints (S3, NAS/SFTP, peers), linked devices, accounts/credentials, connection health, conflict/queue state for remote syncs. Where a Pair's `rootB` (or both roots) can be a remote target. (Phase 3.)
6. **Settings** — global defaults inherited by new Jobs (default compare/deletion/filter, gitignore on by default, big-delete thresholds), recycle-bin behavior, theme/density, FFS **Import** entry point, baseline storage location, telemetry/safety toggles, keybindings.

Footer of sidebar: **+ New Job**, **Import from FreeFileSync**, global health/connectivity indicator.

---

### 3. Complete screen inventory

**Jobs domain**
- **Jobs List** (`/jobs`) — table of Jobs; row actions: Open, Sync now, Preview, Duplicate, Pause automation, Delete. Empty state → New Job / Import FFS.
- **New Job Wizard** (`/jobs/new`) — 3 steps: (1) choose Job-level shared settings (direction incl. mirror, compare mode, deletion policy, gitignore/filter defaults); (2) add Pairs (one or many rootA/rootB rows, each pickable, each with optional filter override); (3) review safety summary → save. Can also be entered pre-filled by Import.
- **Job Overview** (`/jobs/:jobId`) — header (name, mode, color), shared-settings summary, **Pairs panel** (each pair: paths in monospace, enabled toggle, baseline health dot, last-run mini-summary, "override filter" badge), aggregate health, buttons: Preview All / Sync All, Edit, Watch toggle, Schedule.
- **Job Settings** (`/jobs/:jobId/settings`) — edit shared compare/direction/deletion/filter/thresholds; mirror-mode selector with safety copy ("mirror propagates deletions one-way"). Tabs: General · Filter · Safety · Automation · Remote.
- **Pair Editor** (`/jobs/:jobId/pairs/:pairId`) — rootA/rootB pickers, enable, **filter override editor** (inherits job filter, shows effective globs incl. gitignore note), per-pair baseline status + "reset baseline".
- **Preview / Plan** (`/jobs/:jobId/preview`) — the heart, built from `SyncPlan`. Per-pair sections (or merged virtualized table) of `PlanItem` rows: monospace path, A-change / B-change chips (`ChangeKind`), action chip (copy/delete/conflict colored), inline **Resolution** dropdown for conflicts (from `resolution_options`, defaulting to `default_resolution`). Top: summary chips from `PlanSummary` (A→B, B→A, deletes, conflicts, in-sync, skipped) and the **baseline badge** (Present/FirstSync/Corrupt → safety-amber when not Present). Filters: hide in-sync, show conflicts only. Banners for `big_delete` (with the explicit "I reviewed — allow deletions" confirm gate wired to `confirm_big_delete`) and `warnings` (scan read-errors → "deletions suppressed this run"). Apply button disabled until conflicts resolved / big-delete confirmed.
- **Run / Apply Console** (`/jobs/:jobId/run`) — live `sync://progress` (done/total, current path, action), Cancel (`cancel_sync`), then the `ApplyReport` outcome list (done/failed/skipped/conflicts, bytes, per-item `ItemOutcome`). On completion offers re-preview to show converged state. This view is shared by manual, scheduled, and watch-triggered runs.

**Activity domain**
- **Activity Feed** (`/activity`) — all runs across jobs, filterable by job/result/trigger(manual|watch|schedule|remote). Each entry → summary of plan + report.
- **Activity Detail** (`/activity/:runId`) — frozen snapshot of that run's `SyncPlan` + `ApplyReport` (immutable audit), including which conflicts were resolved how, what was suppressed, recycle-bin destinations for recovered deletes.
- **Conflicts Inbox** (`/activity/conflicts`) — cross-job aggregation of all currently-unresolved conflicts (from latest previews / watch-deferred runs), so safety items never hide inside one job. Resolve here or jump to the pair.

**Schedules domain**
- **Schedules List** (`/schedules`) — every cron trigger across jobs, next-run column, enable/pause, run-now.
- **Schedule Editor** (`/schedules/:jobId` or modal) — cron expression builder, window/timezone, "skip if watcher already synced", conflict policy ("never auto-apply conflicts — defer to Conflicts Inbox").

**Watch domain**
- **Watchers Dashboard** (`/watch`) — armed Jobs/Pairs, event/debounce state, queued auto-runs, global **Pause all watching** switch; per-watcher policy (auto-apply safe changes vs preview-only / require approval for deletes & conflicts).

**Cloud / Devices domain**
- **Endpoints List** (`/cloud`) — remotes (S3 bucket, SFTP/NAS, peer device) with health dots, used-by-jobs, last-contact.
- **Endpoint Editor** (`/cloud/:endpointId`) — type, credentials/account, path root, test-connection.
- **Devices** (`/cloud/devices`) — paired peers/devices for multi-device sync, trust/pair flow, per-device status.

**Settings domain**
- **Settings — General / Defaults** (`/settings`) — defaults for new jobs (direction, compare, deletion, filter, gitignore-on, big-delete thresholds), theme/density.
- **Settings — Import** (`/settings/import`) — FFS importer UI: pick `.ffs_batch`/`.ffs_gui` → calls `import_ffs` → shows `FfsImport.jobs` with two-way/mirror, exclude counts, gitignore-redundancy hint, review notes → "Create Job from these N pairs" (one Job, N Pairs) or per-pair cherry-pick.
- **Settings — Safety** (`/settings/safety`) — recycle-bin policy, verify-by-hash default, baseline storage path, scan-error behavior (read-only display of the locked guarantees).
- **Settings — Accounts** (`/settings/accounts`) — credentials store for cloud (Phase 3).

---

### 4. Primary navigation flows

- **Create & first sync:** Sidebar → Jobs → New Job → set shared settings → add Pair(s) → Save → Job Overview → Preview All → resolve any conflicts (baseline badge shows FirstSync = union-only/no-deletes) → Apply → Run Console → converged.
- **Migrate from FreeFileSync:** Sidebar → Settings → Import (or Jobs empty-state CTA) → pick config → review imported pairs + gitignore hint → "Create Job from N pairs" → lands in New Job Wizard pre-filled → Save → Preview.
- **Routine sync:** Jobs List → row "Sync now" (preview-then-apply) OR top-bar Sync-All → Run Console; result also appears in Activity.
- **Resolve conflicts:** Activity → Conflicts Inbox (or Preview's conflicts-only filter) → pick Resolution per item → Apply.
- **Investigate a past run:** Activity Feed → Activity Detail (immutable plan+report, recovery info).
- **Adjust filter for one pair only:** Job → Pair Editor → enable filter override → see effective globs (gitignore-aware) → Preview to confirm.

---

### 5. How Watch, Schedule, Cloud slot in without redesign

- **Real-time Watch:** lives as `job.watch` (and per-pair enable). Triggers the EXISTING `preview_sync` on FS events (debounced); per-watcher policy decides auto-apply-safe vs require-approval. Conflicts/deletes are never auto-applied — they flow to **Conflicts Inbox** and a notification, satisfying the safety rule. Reuses Run Console + Activity. Sidebar slot **Watch** + bottom-strip watcher count exist from day 1; backend can land later with zero IA change.
- **Scheduling:** `job.schedule.cron` per Job; a backend scheduler invokes the same preview→(safe)apply path. **Schedules** section gives the cross-job lens (next-run, contention, pause). Scheduled runs are just Activity records tagged `trigger=schedule`. No new screens needed when it ships — only the cron field and the scheduler.
- **Cloud / Multi-device:** a Pair's `rootA`/`rootB` generalize from a local `PathBuf` to an **endpoint ref** (`local | S3 | SFTP/NAS | peer`). **Cloud/Devices** holds endpoints, credentials, and device pairing; the engine's scan/apply gain a remote provider behind the same `JobConfig` fan-out. Mirror modes (`MirrorAtoB/BtoA`) are already a Job-level `direction` value, so one-way cloud backup needs no structural change. UNC/network warnings the importer already emits map onto endpoint health dots.

This IA exposes safety as a first-class, always-visible value (baseline badge, big-delete gate, scan-error suppression banner, Conflicts Inbox, recoverable-delete provenance in Activity) and accommodates watch/schedule/cloud/mirror by data-model slots and reserved sidebar sections that exist from day 1, so none of them forces a later redesign.

---

## Visual Design System

# fast-file-sync — Visual Design System (v1)

Dark, dense, technical dev-tool. Linear / GitHub-dark / k9s energy. Monospace for every filesystem path; compact rows; color used ONLY to carry meaning. This system maps 1:1 to the Rust enums in `model.rs` (`Action`, `ChangeKind`, `ConflictType`, `BaselineStatusKind`, `ItemStatus`) and the IA in the locked design direction (Jobs / Schedules / Activity / Cloud-Devices / Settings; one job → N folder pairs).

Implementation target: React/TS + Tauri. Tokens are delivered as CSS custom properties on `:root` and consumed via plain CSS or a thin TS token object. No runtime theming engine required for v1 (single dark theme), but tokens are namespaced so a light theme is a drop-in later.

---

## 1. Color Tokens

### 1.1 Surfaces (neutral ramp, cool blue-gray)
Five-step elevation ramp. Higher index = closer to the viewer. Never use pure black; never use pure white.

| Token | Hex | Use |
|---|---|---|
| `--bg-base` | `#0d1117` | App background, behind everything (window chrome) |
| `--bg-sidebar` | `#0f1419` | Persistent left sidebar |
| `--bg-surface` | `#161b22` | Default panel / card / table body |
| `--bg-surface-2` | `#1c2230` | Raised: input fields, table header, code chips, hover target base |
| `--bg-surface-3` | `#232b3a` | Popover / menu / modal body / active row |
| `--bg-overlay` | `rgba(2,6,12,0.66)` | Modal scrim |
| `--bg-hover` | `#1e2632` | Row / list-item hover |
| `--bg-active` | `#26304180` | Selected row, active nav item (use over hover) |
| `--bg-inset` | `#0b0f14` | Recessed wells: log viewport, diff gutter, progress track |

### 1.2 Borders & dividers
Borders carry structure, not decoration. One-pixel, low contrast.

| Token | Hex | Use |
|---|---|---|
| `--border` | `#2a3340` | Default 1px border (panels, inputs, table outline) |
| `--border-subtle` | `#1f2630` | Internal dividers, row separators (very quiet) |
| `--border-strong` | `#3a4656` | Hovered input, focused container edge |
| `--border-focus` | `#4f9cf9` | Keyboard focus ring (2px, see Focus) |

### 1.3 Text
| Token | Hex | Use |
|---|---|---|
| `--text` | `#e6edf3` | Primary text |
| `--text-secondary` | `#aeb9c7` | Secondary labels, metadata |
| `--text-muted` | `#7d8a9b` | Tertiary: timestamps, hints, placeholder-ish |
| `--text-faint` | `#5a6675` | Disabled text, separators like `↔`, watermarks |
| `--text-on-accent` | `#0a0e14` | Text on a saturated/filled accent button |
| `--text-inverse` | `#0d1117` | Text on solid status fills |

### 1.4 Brand / interactive accent (blue)
Blue is BOTH the brand accent AND the meaning of "copy" — intentional: the primary action in a sync tool is moving bytes. Keep them the same hue so the UI reads coherently.

| Token | Hex | Use |
|---|---|---|
| `--accent` | `#4f9cf9` | Links, focus, primary interactive, brand |
| `--accent-hover` | `#6cb0ff` | Hover state of accent |
| `--accent-press` | `#3a82da` | Active/pressed |
| `--accent-fg` | `#0a0e14` | Text/icon on a filled accent button |
| `--accent-bg` | `#11233d` | Tinted accent background (chips, selected) |
| `--accent-border` | `#274869` | Border for accent-tinted surfaces |

### 1.5 Semantic meaning colors (THE CORE OF THE SYSTEM)
Each maps to engine concepts. Every color ships as a triplet: `-fg` (text/icon/dot), `-bg` (tinted fill ~10% alpha equivalent, baked as hex), `-border` (saturated edge).

**COPY (blue) — `Action::CopyAtoB` / `Action::CopyBtoA`**
| Token | Hex |
|---|---|
| `--copy-fg` | `#4f9cf9` |
| `--copy-bg` | `#11233d` |
| `--copy-border` | `#274869` |

**DELETE (orange) — `Action::DeleteA` / `Action::DeleteB`**
| Token | Hex |
|---|---|
| `--del-fg` | `#f0883e` |
| `--del-bg` | `#38220f` |
| `--del-border` | `#5c3a1c` |

**CONFLICT (magenta/pink) — `Action::Conflict`, all `ConflictType`**
| Token | Hex |
|---|---|
| `--conflict-fg` | `#db61a2` |
| `--conflict-bg` | `#380f2a` |
| `--conflict-border` | `#5c2447` |

**OK / SUCCESS (green) — `ItemStatus::Done`, in-sync, `Action::UpdateBaselineOnly`**
| Token | Hex |
|---|---|
| `--ok-fg` | `#3fb950` |
| `--ok-bg` | `#0f2417` |
| `--ok-border` | `#1f4d2c` |

**WARN (amber) — big-delete guard, `ChangeKind::Modified`, scan warnings, one-way mirror caution**
| Token | Hex |
|---|---|
| `--warn-fg` | `#d4a017` |
| `--warn-bg` | `#2e2408` |
| `--warn-border` | `#574516` |

**DANGER / FAIL (red) — `ItemStatus::Failed`, errors, `StateDesync`, destructive confirm**
| Token | Hex |
|---|---|
| `--danger-fg` | `#f85149` |
| `--danger-bg` | `#2a0e0e` |
| `--danger-border` | `#5c2626` |

**NEUTRAL / NOOP — `Action::Noop`, `Action::UpdateBaselineOnly` (silent), `ItemStatus::Skipped`, unchanged**
| Token | Hex |
|---|---|
| `--neutral-fg` | `#7d8a9b` |
| `--neutral-bg` | `#1c2230` |
| `--neutral-border` | `#2a3340` |

**INFO / WATCH (cyan) — reserved for future live-watch / daemon / "active" state so it never collides with copy-blue**
| Token | Hex |
|---|---|
| `--watch-fg` | `#39c5cf` |
| `--watch-bg` | `#0c2629` |
| `--watch-border` | `#1d4a4f` |

### 1.6 Enum → token map (authoritative — engineers wire to this)
**`ChangeKind`** (per-side change vs baseline, used in A-change / B-change columns):
- `Unchanged` → `--neutral-fg`, label `·` or `—` (de-emphasized)
- `Created` → `--ok-fg`, glyph `+`
- `Modified` → `--warn-fg`, glyph `~`
- `Deleted` → `--del-fg`, glyph `−`
- `TypeChanged` → `--conflict-fg`, glyph `⇄` (file↔dir)

**`Action`** (resolved action column / badge):
- `Noop` → `--neutral-*`, label `in sync`
- `CopyAtoB` → `--copy-*`, label `A → B`
- `CopyBtoA` → `--copy-*`, label `B → A`
- `DeleteA` → `--del-*`, label `del A`
- `DeleteB` → `--del-*`, label `del B`
- `UpdateBaselineOnly` → `--neutral-*`, label `baseline` (muted; "both converged, no IO")
- `Conflict` → `--conflict-*`, label `conflict`

**`ConflictType`** (sub-tag inside a conflict row; magenta family, glyph differs):
`EditEdit ✎✎`, `CreateCreate ++`, `ModifyDelete ✎✕`, `DeleteTypeChange ✕⇄`, `ModifyTypeChange ✎⇄`, `TypeChangeTypeChange ⇄⇄`, `StateDesync ⚠` → **`StateDesync` uses `--danger-fg`** not magenta (it's a refuse-to-act safety stop, distinct from a user-resolvable conflict).

**`BaselineStatusKind`** (job-level trust banner):
- `Present` → `--ok-fg`, "Baseline loaded · deletions enabled"
- `FirstSync` → `--watch-fg`, "First sync · union only, no deletions"
- `Corrupt` → `--warn-fg`, "Baseline unreadable · safe union fallback"

**`ItemStatus`** (Activity / apply report):
- `Done` → `--ok-fg`, `Skipped` → `--neutral-fg`, `Failed` → `--danger-fg`, `Conflict` → `--conflict-fg`

### 1.7 Direction colors (A vs B sides)
To keep the two roots legible at a glance in the compare table and pair headers, tint the side identity subtly (NOT a meaning color — a quiet hue brand):
- `--side-a` `#5b8cce` (cool blue-slate), `--side-b` `#9d7fd6` (cool violet). Used only for the small `A`/`B` pills and root path labels, never for action meaning.

---

## 2. Typography

Two families. UI sans for chrome/labels; monospace for **every filesystem path, glob, hash, size, byte count, mtime, and log line**.

```
--font-sans: "Inter", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif;
--font-mono: "Cascadia Code", "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;
```
Enable mono ligatures off for paths (`font-variant-ligatures: none;`) so `->` in a path can't fuse. Use `font-feature-settings: "tnum" 1, "ss01" 1;` on sans for tabular numerals in size/count columns.

### Type scale (rem on a 16px root; values in px for clarity)
Dense tool → base UI text is **13px**, never below 11px for interactive text.

| Token | px / line-height | weight | Use |
|---|---|---|---|
| `--fs-display` | 20 / 26 | 650 | App title, empty-state headline |
| `--fs-h1` | 16 / 22 | 620 | Section header (page title in content area) |
| `--fs-h2` | 14 / 20 | 600 | Card title, modal title, job name |
| `--fs-body` | 13 / 18 | 450 | Default UI text, buttons, inputs |
| `--fs-sm` | 12 / 16 | 450 | Secondary labels, table cells, chips |
| `--fs-xs` | 11 / 14 | 500 | Badges, tags, status text, table headers (uppercase) |
| `--fs-micro` | 10 / 13 | 600 | Count superscripts, dense legend |
| `--fs-mono` | 12.5 / 17 | 450 | **Paths in table rows, globs, hashes** |
| `--fs-mono-sm` | 11.5 / 15 | 450 | Log viewport, dense path lists, code chips |

**Heading treatment:** section/table headers use `--fs-xs`, `text-transform: uppercase`, `letter-spacing: 0.5px`, color `--text-muted`. This is the dev-tool "column header" signature.

**Path rendering rule:** paths are mono, `--text` for the basename and `--text-muted` for the parent dirs when space allows (middle-ellipsis on overflow, never wrap in a table row — wrap is allowed only in the expanded detail drawer). Tauri/Windows: store native `\` paths but render forward-slash keys (matches engine NFC forward-slash keys) for visual consistency; show native form in tooltips.

---

## 3. Spacing & Density

4px base unit. Dense by default; one "comfortable" override token set for first-run/marketing-y empty states only.

| Token | px | Use |
|---|---|---|
| `--sp-0` | 0 | — |
| `--sp-1` | 2 | Icon-to-text hairline, badge inner |
| `--sp-2` | 4 | Tight inline gaps |
| `--sp-3` | 6 | Chip padding-y, compact gap |
| `--sp-4` | 8 | Default small gap, input padding-y |
| `--sp-5` | 12 | Card inner padding, control gap |
| `--sp-6` | 16 | Section gap, panel padding |
| `--sp-7` | 20 | Page padding |
| `--sp-8` | 24 | Major section separation |
| `--sp-9` | 32 | Empty-state breathing room |

### Density / sizing primitives
| Token | px | Use |
|---|---|---|
| `--row-h` | 30 | Compare-table row, list row (dense default) |
| `--row-h-lg` | 38 | Job card row, nav item |
| `--ctrl-h` | 30 | Buttons, inputs, selects (matches row) |
| `--ctrl-h-sm` | 24 | Toolbar icon buttons, inline chips |
| `--sidebar-w` | 232 | Left sidebar width (collapsible → 56) |
| `--topbar-h` | 44 | Top bar |
| `--radius-sm` | 4 | Chips, badges, inputs, buttons |
| `--radius-md` | 8 | Cards, panels, modals |
| `--radius-lg` | 12 | Empty-state container, large modal |
| `--radius-pill` | 999 | Status dots, pill counts |

**Density modes:** ship a `data-density="compact|cozy"` attribute on `<html>`. `compact` (default) uses `--row-h:28`; `cozy` uses `--row-h:34`. Only `--row-h`, `--ctrl-h`, and table cell padding change — everything else is fixed. Power users live in compact.

---

## 4. Borders, Elevation, Focus

**Philosophy:** flat. Depth comes from the surface ramp + 1px borders, NOT heavy shadows. Shadows appear only on truly floating layers (popover, menu, modal, toast).

| Token | Value | Use |
|---|---|---|
| `--shadow-pop` | `0 4px 16px rgba(0,0,0,0.45)` | Dropdown, select menu, popover |
| `--shadow-modal` | `0 16px 48px rgba(0,0,0,0.6)` | Modal/dialog |
| `--shadow-toast` | `0 6px 22px rgba(0,0,0,0.5)` | Toast stack |
| `--ring-focus` | `0 0 0 2px var(--bg-base), 0 0 0 4px var(--accent)` | Keyboard focus (double ring so it reads on any surface) |
| `--ring-danger` | `0 0 0 2px var(--bg-base), 0 0 0 4px var(--danger-fg)` | Focus on destructive control |

**Border rules:** every panel/card/input has `1px solid var(--border)`. Hover raises to `--border-strong`. Conflict rows get a 2px left border in `--conflict-fg`; danger/StateDesync rows a 2px left border in `--danger-fg`. Selected nav item: 2px left accent bar inside `--bg-active`.

**Focus rule:** keyboard focus ALWAYS visible via `--ring-focus` (use `:focus-visible`, never remove outline). Mouse focus does not show the ring. This is a keyboard-driven tool — focus legibility is non-negotiable.

**Motion:** fast and minimal. `--dur-fast: 90ms`, `--dur: 140ms`, `--ease: cubic-bezier(0.2,0,0,1)`. Hover/press color transitions only. No slide-in for rows. Respect `prefers-reduced-motion` (kill the progress shimmer + toast slide).

---

## 5. Component Catalog

Each component lists structure, sizing tokens, states, and engine wiring.

### 5.1 App shell
3-zone CSS grid: `[sidebar 232px] [main 1fr]`, with main split into `[topbar 44px] [content auto]`. Sidebar and topbar are fixed; only content scrolls. Window is borderless Tauri; topbar doubles as the drag region (`-webkit-app-region: drag`, interactive children `no-drag`).

### 5.2 Sidebar (persistent left nav)
- Width `--sidebar-w`, bg `--bg-sidebar`, right border `--border-subtle`. Collapsible to 56px (icon-only) via a bottom toggle; collapsed state persists.
- **Top:** app mark (16px mono glyph `⇄` in `--accent`) + wordmark `fast-file-sync` (`--fs-h2`). Subtitle `.gitignore-aware` in `--fs-micro --text-faint` (the differentiator, stated quietly).
- **Nav sections** (locked IA), each a 38px-tall item: icon (16px) + label (`--fs-sm`) + optional right-aligned count/dot badge.
  - `Jobs` (count = # jobs), `Schedules`, `Activity` (dot = `--watch-fg` if a run is live, `--danger-fg` if last run failed), `Cloud / Devices` (badge `soon` in `--neutral`), `Settings`.
- **States:** default `--text-secondary`; hover `--bg-hover` + `--text`; active `--bg-active` + `--text` + 2px left `--accent` bar. Icons inherit text color.
- **Footer (pinned bottom):** global sync-engine status pill ("idle" `--neutral` / "watching 3" `--watch` / "syncing…" `--accent`), and a collapse toggle. Architected so the live daemon and device-account chips slot in here later.

### 5.3 Top bar
- Height `--topbar-h`, bg `--bg-surface`, bottom border `--border`.
- **Left:** breadcrumb (`Jobs / MyDocuments` — section in `--text-muted`, current in `--text`, `--fs-sm`). 
- **Center/flex:** contextual actions for the current view (e.g. on a job: `Preview` button (default), `Sync` button (primary-go), kebab menu).
- **Right:** global search (`⌘K` command palette trigger — icon + faint "Search jobs, paths…"), then window controls region. Keep it sparse.

### 5.4 Job card / row (one job = N folder pairs)
Two presentations of the same model.

**List row (Jobs list, dense):** height `--row-h-lg`, grid: `[status-dot 16] [name 1fr] [pairs-summary auto] [mode-badges auto] [last-run auto] [kebab 24]`.
- status-dot: aggregate health (green in-sync / amber pending changes / magenta conflicts present / red last-run failed / cyan watching).
- name: `--fs-h2 --text`; below it (`--fs-micro --text-muted`) "3 pairs · two-way · gitignore on".
- mode-badges: small tags for direction (`two-way ↔` / `mirror →`), `verify`, `recycle`, `gitignore`.
- last-run: relative time `--fs-xs --text-muted` ("12m ago"), colored if failed.
- Row hover `--bg-hover`; click → opens job detail (pairs + compare). Whole row is the hit target.

**Expanded job header (in detail view):** card `--bg-surface`, `--radius-md`, `--border`. Title row = name + edit + the global `Preview`/`Sync` actions. Below: the **BaselineStatusKind banner** (§5.13) and a horizontal strip of **shared settings chips** (compare mode, direction, deletion policy → recycle, gitignore on/off, big-delete guard 25%/100). Then a list of **folder-pair sub-rows**: each shows `[A pill] root_a … [↔/→] [B pill] root_b … [pair filter override? badge] [per-pair change count]`. Roots in mono, middle-ellipsized, side-tinted pills (`--side-a`/`--side-b`).

### 5.5 Compare-table row (the heart of the app)
A virtualized table (thousands of rows). One row per `PlanItem`. Monospace path, fixed columns, no wrap.

Grid columns (left→right):
1. **select** (24px) — checkbox to include/exclude this item from apply.
2. **path** (1fr, min 240px) — mono `--fs-mono`; parent dirs `--text-muted`, basename `--text`; middle-ellipsis; left-border meaning stripe (conflict→magenta 2px, StateDesync→red 2px, else none).
3. **A** (`ChangeKind` of side A) — glyph + color from §1.6, `--fs-xs`, fixed 64px, centered.
4. **dir** (28px) — the flow arrow (`→`, `←`, `↔`, `·`) colored to the action.
5. **B** (`ChangeKind` of side B) — same as A, 64px.
6. **action** (`Action` badge, §5.7) — fixed 96px.
7. **size** (right-aligned, mono, tabular, 84px) — formatted bytes; show delta (`+1.2 MB` green / `−` del color) when meaningful; `—` for dirs.
8. **resolve** (only for `Action::Conflict`) — inline select of `resolution_options` defaulting to `default_resolution`; otherwise empty.

Row states: height `--row-h`; zebra OFF (use `--border-subtle` row dividers — cleaner for scanning paths). Hover `--bg-hover`. Selected `--bg-active`. Conflict row tinted `--conflict-bg` at ~20% (`#380f2a33`) + the left stripe. `Noop`/`UpdateBaselineOnly` rows render `--text-muted` and are hidden behind a "show in-sync" toggle by default (matches prototype `.show-insync`). Click a row → expands a detail drawer (full path wrapped, A/B/baseline `Meta`: size, mtime, hash if present, the `note` string).

**Table header:** sticky, `--bg-surface-2`, `--fs-xs` uppercase muted, sortable (path / size / action). A summary bar above the table mirrors `PlanSummary` as chips (§5.6).

### 5.6 Summary chips (PlanSummary / ApplyReport)
Pill, `--radius-pill`, `--bg-surface`, `--border`, `--fs-sm`. Label in `--text-muted`, count in bold colored to meaning: `42 copy A→B` (copy), `7 del B` (del), `3 conflicts` (conflict), `1.1k in sync` (neutral), `2 skipped` (neutral). Big-delete and failure counts escalate to warn/danger. Row of chips sits between top bar and the table.

### 5.7 Action & change badges
- **Action badge:** inline-flex, height 20px, `--radius-sm`, `--fs-xs` weight 600, `padding 2px 7px`. `color: <meaning>-fg; background: <meaning>-bg`. No border (fill carries it). Label per §1.6.
- **Change cell (A/B):** not a pill — a bare glyph + 1ch label in the meaning color (`+ new`, `~ mod`, `− del`, `⇄ type`, `·`). Keeps the table airy.
- **ConflictType sub-tag:** tiny outlined tag next to the action badge: `1px solid --conflict-border`, `--conflict-fg`, glyph + short code (`✎✎ edit/edit`). `StateDesync` switches to danger tokens and reads `⚠ desync · refusing`.

### 5.8 Status dots
`--radius-pill`, 8px diameter, solid `<meaning>-fg`. A "live" dot (watching / syncing) gets a 2px ring `<meaning>-bg` and a slow pulse (opacity 1→0.55, 1.6s; killed under reduced-motion). Used in sidebar, job rows, and the engine footer. 10px variant for the job header.

### 5.9 Buttons
Height `--ctrl-h` (30), `--radius-sm`, `--fs-body` weight 600, `padding 0 14px`, gap 6px to leading icon. Variants:
- **default (secondary):** bg `--bg-surface-2`, border `--border`, text `--text`; hover bg `#232c38` + border `--border-strong`.
- **primary:** bg `--accent`, text `--accent-fg`, no border; hover `--accent-hover`, press `--accent-press`. For the main commit/save.
- **go (sync/apply):** the green "execute" affordance — bg `--ok-bg`, border `--ok-border`, text `--ok-fg`; hover bg `#143020`. Used for `execute_sync`.
- **danger:** bg `--danger-bg`, border `--danger-border`, text `--danger-fg`; hover intensifies. Confirm-typed for destructive (big-delete override).
- **ghost:** transparent, `--text-secondary`; hover `--bg-hover`. For toolbar/kebab.
- **icon button:** square `--ctrl-h-sm`, ghost styling, 16px icon.
- States: `:disabled` opacity 0.45 + not-allowed; `:focus-visible` → `--ring-focus` (danger → `--ring-danger`); loading → spinner replaces leading icon, label stays.

### 5.10 Inputs, selects, toggles
- **Text input:** height `--ctrl-h`, bg `--bg-surface-2`, border `--border`, `--radius-sm`, `--fs-body`, padding `0 10px`. Path inputs use `--font-mono`. Hover `--border-strong`; focus `--ring-focus` + border `--accent`. Placeholder `--text-faint`. Invalid → border `--danger-border` + `--ring-danger`, helper text `--danger-fg`.
- **Path input + Browse:** input flex-1 (mono) + secondary "Browse…" button invoking the Tauri dialog. Trailing inline validity dot (green = exists/reachable, amber = UNC/offline, red = missing) — wires to `validate_job`.
- **Select:** styled trigger like input + chevron `--text-muted`; menu is a popover (`--bg-surface-3`, `--shadow-pop`, `--border`), items 28px, hover `--bg-hover`, selected `--accent-bg` + check. Used for resolution pickers and compare-mode.
- **Toggle/switch:** 30×16 track; off `--bg-surface-3` border `--border`, on `--accent`; knob 12px `--text`. Label left `--fs-sm`. Used for gitignore, hidden, verify, recycle, "show in-sync".
- **Checkbox:** 16px, `--radius-sm`, border `--border`; checked `--accent` fill + `--accent-fg` check. Row-select + per-item include.
- **Number/threshold:** for big-delete `pct`/`abs` — narrow mono inputs with unit suffix (`%`, `files`).

### 5.11 Filter / ignore editor (the .gitignore differentiator — make it shine)
A dedicated panel (job-level, overridable per-pair). Sections:
1. **Toggles strip:** `Respect .gitignore` (default on, with a tiny `★ unique` accent tag since FFS can't), `Respect .ignore`, `Include hidden`, `Verify by hash`. Each is a toggle row (§5.10) with a one-line `--text-muted` explanation.
2. **Custom globs editor:** a mono multi-line list (one glob per line) — `--bg-inset`, `--font-mono --fs-mono-sm`, line numbers in `--text-faint`. Leading `!` lines render `--ok-fg` (re-include); normal excludes `--text`. Live-validate each line; bad glob → red squiggle + inline reason.
3. **gitignore hint banner (`ImportedJob.gitignore_hint`):** when present, an info banner (watch/cyan tint) "N of these excludes are usually covered by .gitignore — you can likely drop them," with a "Remove covered" action.
4. **Per-pair override:** a toggle "Override job filter for this pair"; when on, the pair gets its own globs editor (visually nested, left-indented with a `--side` accent bar to signal scope). Maps to the locked per-pair-filter-override requirement.
5. **Preview affordance:** "Test filter" shows a live count of matched/ignored entries against the current roots.

### 5.12 Modal / dialog
Centered, max-width 560px (640 for the FFS import review), `--bg-surface-3`, `--radius-lg`, `--border`, `--shadow-modal`, over `--bg-overlay`. Header: `--fs-h2` title + ghost close (`×`). Body padding `--sp-6`, scrolls if tall. Footer: right-aligned button row (cancel ghost + confirm primary/go/danger by intent). Used for: job create/edit, FFS import review (renders `ImportedJob` rows with two-way/mirror tags + warnings + gitignore_hint), big-delete confirmation (danger, requires typed/explicit confirm), conflict bulk-resolve. `Esc` closes (except mid-destructive-confirm); focus trapped; focus returns to invoker.

### 5.13 Banner / inline alert (trust-legibility surfaces)
Full-width, `--radius-md`, 1px border, left-accent 3px in the meaning color, `--fs-sm`, icon + text + optional inline action. Four intents map to engine states:
- **info/baseline (`FirstSync`):** watch/cyan — "First sync: union only, nothing will be deleted."
- **ok (`Present`):** green — "Baseline loaded · deletions enabled · recycle bin on."
- **warn (`Corrupt`, scan warnings, one-way mirror import):** amber.
- **danger (`big_delete`, `StateDesync` present):** red — "This run would delete 312 files (38% of B). Review before applying," with an embedded checkbox/typed confirm. Big-delete guard is a first-class, visible safety surface, never a silent toast.

### 5.14 Toast
Bottom-right stack, `--bg-surface-3`, `--border`, `--radius-md`, `--shadow-toast`, max-width 360, `--fs-sm`. Leading status dot + message + optional action ("Undo" / "View report") + close. Auto-dismiss 5s (success/info), sticky for danger. Used for: sync complete (`ApplyReport` summary), cancel acknowledged, import done. Never used for conflicts or big-delete (those demand banners/modals — safety must not be dismissible).

### 5.15 Progress
- **Determinate bar:** track `--bg-inset`, 6px, `--radius-pill`; fill linear-gradient `--accent-press → --accent`; below it `--fs-xs --text-muted` "1,204 / 3,880 · 142 MB/s · current/path/in/mono" (current path mono, middle-ellipsized). Wires to `execute_sync` progress events; a `Cancel` ghost-danger button sits inline (`cancel_sync`).
- **Indeterminate:** during scan/`preview_sync` — a sliding sheen on the track (reduced-motion → static striped). 
- **Per-item micro-progress:** in the Activity log, each `ItemOutcome` row gets a leading `ItemStatus` dot.

### 5.16 Empty states
Centered in content area, max-width 420, `--sp-9` padding. 24px muted icon, `--fs-display` headline, `--fs-sm --text-muted` subline, one primary action.
- **No jobs:** "No sync jobs yet" → `+ New job` (primary) and `Import from FreeFileSync…` (ghost) — surfaces the importer immediately.
- **In sync (after preview, zero non-noop):** green check, "Everything's in sync" (matches prototype `.empty`), subline shows roots + last compared time.
- **Schedules/Cloud (not built):** muted "Coming soon" with a one-line description of the planned capability, so the IA never shows a dead end.

### 5.17 Activity view (architected for the future daemon)
A reverse-chronological log: each run = a collapsible group (job name, trigger source `manual`/`scheduled`/`watch`, timestamp, `ApplyReport` summary chips, duration). Expanded → virtualized `ItemOutcome` rows (status dot + action badge + mono path + error in `--danger-fg`). This same surface receives live-watch and scheduled-run events later with no structural change — `trigger source` is the seam.

---

## 6. Token delivery (engineer note)
Ship `tokens.css` (`:root { --bg-base:#0d1117; … }`) imported once, plus `tokens.ts` exporting the same values as a typed object for inline styles and the virtualized table (which needs JS access for row coloring). Meaning colors are exposed as a `MEANING` map keyed by `Action`/`ChangeKind`/`ItemStatus`/`ConflictType` string serializations (they serialize to plain enum names — see `model.rs` derives) so a row renderer does `MEANING.action[item.action]` → `{fg,bg,label,glyph}`. This keeps the enum→color mapping in exactly one place.

---

# Screen Designs

---

I have enough grounding. Now I'll write the Jobs Dashboard design section.

## Jobs Dashboard

**(1) Purpose:** The app home — a scannable, action-dense list of every saved Job (each = N folder pairs sharing settings), surfacing live status, last/next run, and per-job quick actions (Preview, Sync, Pause/Resume, Edit) plus global New Job, Import-from-FFS, and bulk Run-all — without leaving the keyboard.

**(2) Mockup** (sidebar shell, topbar drag region, populated state at row-h 30 density; mono = paths/sizes/times):

```
┌──────────────┬───────────────────────────────────────────────────────────────────────────────────────┐
│ ▸ fast-file  │  Jobs                                            [⌕ filter jobs…]  [▶ Run all] [+ New ▾] │ 44 topbar (drag)
│  sync        │                                                                                          │
│              │  6 jobs · 1 watching · 1 needs review · 218 pending changes                              │ summary chips
│ ▣ Jobs       │ ┌─────────────────────────────────────────────────────────────────────────────────────┐│
│ ⏱ Schedules  │ │● Photos Backup            2 pairs·two-way·gitignore   ⌫recycle    last 2h ago  [···]  ││ ← in-sync (green dot)
│ ≋ Activity   │ │  ✓ in sync                                                  next ⏱ 03:00            ││
│ ☁ Cloud/Dev  │ │  ╴ D:\Photos              ↔  \\nas\photos                                            ││ ← pairs collapsed (mono)
│ ⚙ Settings   │ │  ╴ D:\Phone\DCIM          ↔  \\nas\photos\phone                                      ││
│              │ ├─────────────────────────────────────────────────────────────────────────────────────┤│
│              │ │● Code Mirror              1 pair·mirror→·gitignore★               last 9m ago  [···]  ││ ← changes (blue dot)
│              │ │  ◆ 47 changes  [+38] [~6] [−3]                          [Preview] [⟳ Sync] [✎]        ││ ← action chips colored
│              │ │  ╴ E:\proj\app            →  \\build\app                                              ││
│              │ ├─────────────────────────────────────────────────────────────────────────────────────┤│
│              │ │◐ Docs Sync                3 pairs·two-way·gitignore               syncing…    [···]  ││ ← syncing (pulse ring)
│              │ │  ⟳ 112 / 340  ▓▓▓▓▓▓▓�wright░░░░░░░░  copying  src/api/handlers.rs        [■ Cancel]   ││ ← progress + mono path
│              │ │  ╴ C:\work\docs           ↔  G:\team\docs   (+2 more)                                ││
│              │ ├─────────────────────────────────────────────────────────────────────────────────────┤│
│              │ │● Music Library            1 pair·two-way                          last 1d ago  [···]  ││ ← conflict (magenta)
│              │ │  ◈ 3 conflicts · 12 changes        ⚠ needs review     [Resolve →] [Preview] [✎]      ││ ← magenta L-stripe+tint
│              │ │  ╴ D:\Music               ↔  H:\Music                                                ││
│              │ ├─────────────────────────────────────────────────────────────────────────────────────┤│
│              │ │◉ Laptop ⇄ Desktop         2 pairs·two-way·gitignore  ≋watching    debounce 2s [···]  ││ ← watching (cyan ring-pulse)
│              │ │  ≋ live · idle · 0 pending                          [⏸ Pause]                         ││
│              │ │  ╴ C:\Users\me\dev        ↔  \\desktop\dev    (+1 more)                               ││
│              │ ├─────────────────────────────────────────────────────────────────────────────────────┤│
│              │ │✕ Archive Roll             1 pair·update                           failed 4h  [···]  ││ ← error (danger dot)
│              │ │  ✕ E:\arc unreachable: scan read-error — deletions suppressed     [Retry] [Details]  ││ ← danger banner inline
│              │ │  ╴ E:\arc                 →  \\cold\arc                                               ││
│              │ └─────────────────────────────────────────────────────────────────────────────────────┘│
│ ◍ engine idle│                                                                                          │ sidebar footer
└──────────────┴───────────────────────────────────────────────────────────────────────────────────────┘
```

**(3) Layout & components** (design-system mapping):

- **Shell:** grid `[sidebar 232][topbar 44 / content]`. Sidebar active item = `Jobs` with `bg-active` + 2px accent left bar; footer = engine status dot (`◍ idle` neutral / `◉ running` accent ring-pulse). Topbar is the drag region.
- **Topbar (in-content header):** `h2` "Jobs" title; right cluster = filter input (`h30 surface-2`, mono placeholder, fuzzy over job name + pair roots), **Run all** (primary, h30), **+ New ▾** (split button: New Job / Import from FreeFileSync…).
- **Summary strip:** pill chips colored to meaning — `N jobs` (neutral), `N watching` (WATCH cyan), `N needs review` (CONFLICT magenta), `N pending changes` (COPY blue). Drives nothing; pure at-a-glance. Mirrors `PlanSummary`/aggregate.
- **Job card** (`surface`, radius md8, flat 1px border; the unit of the list, virtualized for many jobs):
  - **Header row** (row-h 30): `status-dot 8px` + **name** (sans) + meta string `"N pairs·<mode>·gitignore[★]"` + mode/deletion badges (`⌫recycle` neutral) + last-run (mono, right) + `[···]` overflow icon-button.
  - **Status line** (the colored, stateful row): glyph + headline + summary chips (`[+38] [~6] [−3]` = Created/Modified/Deleted, colored ok/warn/del) + inline quick-action buttons.
  - **Pairs block** (collapsed by default): one mono line per pair `leftRoot  <dir-glyph>  rightRoot`; dir glyph from mode/`modeOverride` (`↔` two-way, `→` mirror/update, `←`). Truncate with `(+N more)` past 2 pairs; click expands inline.
- **Status dot** = `BaselineStatusKind`/run-state colored: green=in-sync, blue=changes, magenta=conflict, cyan ring-pulse=watching, accent ring-pulse=syncing, danger=error, warn-hollow=paused. `★` on gitignore = the unique-feature flag.
- **Action badges/buttons:** chips use MEANING fill (no border); buttons h30 ghost except **Sync** = `go` green (`execute_sync`), **Resolve** = magenta-outlined (routes to Conflict Resolution), **Cancel** = danger ghost (`cancel_sync`).
- **Progress** (syncing card): inset track + accent fill, mono current path, live `done/total` from `sync://progress`, Cancel.

**(4) All states:**

- **Empty (no jobs):** centered empty state in content — green/neutral illustration glyph, `h1` "No jobs yet", body "Create a folder-pair job or import your FreeFileSync batch.", buttons `[+ New Job]` (primary) `[Import from FreeFileSync]` (default). Sidebar still visible; summary strip hidden.
- **Loading:** skeleton job cards (3–5 shimmer rows at row-h 30, muted `surface-2` blocks for dot/name/pairs); topbar actions disabled; summary strip = `loading…` muted. Shown while reading `jobs.json` + firing `get_baseline_status` per pair.
- **Populated (idle):** as mockup. Cards with a valid `Present` baseline and zero diff show `✓ in sync` (OK green); only `[Preview] [⟳ Sync] [✎]` + `[···]`. Hover row reveals actions if hidden for density.
- **In-progress (syncing):** dot → accent ring-pulse, status line becomes progress (`◐`, track, mono path, Cancel); other quick actions disabled on that card; card pinned to keep visible. Footer engine status flips to `◉ running`.
- **Changes (pending):** blue dot, `◆ N changes` + `[+x][~y][−z]` chips, `[Preview] [Sync] [✎]`. `FirstSync` baseline shows a small WATCH-cyan `first sync` sub-tag (union-only, zero deletes) so users know deletions won't propagate yet.
- **Conflict:** magenta dot + **2px magenta left-stripe + faint magenta tint** on the card, `◈ N conflicts`, non-dismissible inline `⚠ needs review`; primary action = **Resolve →**; **Sync is disabled** until resolved (safety = visible; conflicts never auto-applied). `StateDesync` items render as **DANGER red** ("desync — refuse to act"), not magenta, with a Details link.
- **Error:** danger dot `✕`, danger-tinted status line with the cause; if cause is a **scan read-error**, copy explicitly states *"deletions suppressed"* (legible safety). Actions `[Retry] [Details]`. `Corrupt` baseline → WARN amber sub-tag "baseline corrupt — safe union" (non-blocking).
- **Paused:** warn-hollow dot, meta `paused`, status line muted `⏸ paused`; only action `[▶ Resume]`. Big-delete-tripped previews surface a WARN `guard: NN deletes` chip that requires the typed confirm modal before Sync.
- **Watch/Scheduled variant:** watching job = cyan `◉` ring-pulse dot, `≋watching` badge, status `≋ live · idle/active · N pending`, action `[⏸ Pause]`. Scheduled job shows `next ⏱ HH:MM` (mono) on the header right and a `⏱` badge; both Schedule and Watch attach at **job level** (operate over all enabled pairs).

**(5) Interactions & keyboard:**

- `j/k` or ↑/↓ move card selection; `→`/`Enter` opens **Job Detail / Compare Workspace** (runs `preview_sync` per pair); `←`/`Esc` collapses/deselects.
- `Space` = Preview selected; `s` = Sync selected (→ confirm modal if big-delete); `p` = Pause/Resume; `e` = Edit (Job Editor); `r` = Resolve (if conflicts).
- `n` = New Job; `i` = Import FFS; `R` = Run all (preview-then-confirm, sequential per job; conflict/error jobs auto-skipped and listed). `/` focuses filter; `Esc` clears it.
- `[···]` overflow menu: Edit, Duplicate, Reveal pairs in Explorer, Reset baseline (danger, typed confirm), Delete job (danger). Click a pair line → jump straight to that pair in Compare. Bulk: checkbox mode via `x` to multi-select cards → Run-all acts on selection.
- All `:focus-visible` rings always visible; row-hover reveals dense actions; motion 90–140ms. Toasts (bottom-right) only on completion success/info; safety states stay as in-card banners, never toasts.

**(6) Tauri commands & events:**

- **Reused:** `get_baseline_status` (per pair on load → dot/sub-tags); `validate_job` (per pair on load → reachability/error dot); `preview_sync` (Preview, and Run-all's pre-pass → change counts, conflict count, big-delete flag, summary chips); `execute_sync` (Sync / Run-all, with `resolutions` + `confirm_big_delete`); `cancel_sync` (Cancel); `import_ffs` (+ New ▾ → Import). Listens to existing event **`sync://progress`** for the in-card progress bar.
- **NEW commands needed** (additive; each pair still compiles to one existing `JobConfig`, engine unchanged):
  - `list_jobs() -> Vec<Job>` and `get_job(id) -> Job` — read/parse `jobs.json` (the Job→pairs model).
  - `save_job(job) / delete_job(id) / duplicate_job(id)` — persistence for create/edit/overflow.
  - `set_job_paused(id, bool)` — Pause/Resume (P1 watch/schedule gate; no-op-safe today).
  - `run_all(ids: Vec<String>) -> RunBatchHandle` — orchestrate sequential preview+execute over selected jobs/pairs, skipping conflict/error.
  - `reset_baseline(jobId, pairId)` — overflow "Reset baseline" (typed-confirm).
  - *(P1 placeholders, IA-ready, may stub):* `set_schedule(jobId, Schedule)`, `set_watch(jobId, WatchConfig)`.
- **NEW events needed** (for live dashboard without polling):
  - `jobs://status` — per-(job,pair) status deltas (idle→syncing→done/error, pending counts) to update dots/chips live.
  - `jobs://run-batch` — Run-all progress (current job index, per-job ApplyReport rollup, skipped list).
  - `watch://event` (P1) — daemon pending-count + idle/active for the watching variant.
  - `schedule://tick` (P1) — next-run countdown / fired notifications for the scheduled badge.

Grounding files read: `src-tauri/src/model.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/config.rs`.

---

I now have everything I need. Here is the deliverable.

## Job Detail / Compare Workspace

**(1) Purpose.** Open one Job, scan all its enabled folder pairs against their baselines, and present the computed `SyncPlan` per pair as a dense, virtualized compare grid — with conflicts surfaced, a job-wide summary, safety banners, and Preview / Apply / Cancel driving the engine pair-by-pair.

---

**(2) Mockup (inside the persistent sidebar shell, ~1360×820, populated + one conflict + big-delete guard tripped on pair 2).**

```
┌──────────────┬──────────────────────────────────────────────────────────────────────────────────────────────┐
│ fast-file-   │  ⠿ Photos & Docs                    two-way · gitignore · recycle-bin     [⌘P Preview][▷ Apply]│ 44 topbar (drag)
│   sync   ◉   │  3 pairs · baseline present · scanned 2026-06-25 14:02:11           [↻][⚙ Edit job][⋯]        │
│              ├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ Jobs    ◀  │ ▌ JOB SUMMARY  ╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴│
│   Schedules  │  ( 124 →A▸B )  ( 37 A◂B← )  ( 12 − del )  ( 3 ⬥ conflict )  ( 1.4k · noop )  ( 8 skip )         │
│   Activity   │                                                                  ► 3 conflicts block apply      │
│   Cloud/Dev  ├──────────────────────────────────────────────────────────────────────────────────────────────┤
│   Settings   │ [⌕ filter rows: path/glob… ][▾ All actions][▾ A chg][▾ B chg] □ show in-sync  ↕ path  ⬥ next-conf│ 30 toolbar
│              ├──────────────────────────────────────────────────────────────────────────────────────────────┤
│              │ ⏷ ◉ PAIR 1   D:\Photos  ⇄  E:\Backup\Photos     gitignore         84 changes  ·  2 conflicts    │ pair hdr 30
│              │ ┌────┬─────────────────────────────────────────┬────┬────┬────┬──────────────┬───────┬────────┐│
│              │ │ ☑  │ path                                   1fr│ A  │ ⇄  │ B  │ action     96│ size R│ resolve││ col hdr
│              │ ├────┼─────────────────────────────────────────┼────┼────┼────┼──────────────┼───────┼────────┤│
│              │ │ ☑  │ 2021/spain/IMG_0192.cr2                 │ +  │ →  │ ·  │ ▣ Copy A▸B   │ 24.1MB│        ││ 30
│              │ │ ☑  │ 2021/spain/IMG_0193.cr2                 │ ·  │ ← │ +  │ ▣ Copy B▸A   │ 23.7MB│        ││
│              │▐│ ☑  │ 2022/edits/cover.psd                    │ ~  │ ⬥  │ ~  │ ▣ Conflict   │ 512MB │[Keep▾] ││◀ magenta L-stripe + tint
│              │▐│ ☑  │ 2022/raw/_old/                          │ −  │ →  │ ·  │ ▣ Delete B   │  —    │        ││
│              │▐│ ☑  │ 2023/proj/scratch.tmp                   │ ~  │ ⬥  │ −  │ ▣ Conflict   │ 4.0kB │[Keep▾] ││ ModifyDelete sub-tag
│              │ │            … 79 more rows (virtualized) …                                                     ││
│              │ └────┴─────────────────────────────────────────┴────┴────┴────┴──────────────┴───────┴────────┘│
│              │ ⏷ ◉ PAIR 2   C:\Work  ⇄  \\nas\work        filter override        61 changes  ·  1 conflict     │
│              │ ▌▲ BIG-DELETE GUARD  this pair would delete 53 of 190 members (28% > 25%).  Review before apply.│ danger banner
│              │ │ ☑  │ archive/2019/.../report.docx            │ ·  │ ← │ −  │ ▣ Delete A   │ 88kB  │        ││
│              │ │            … 60 more rows …                                                                   ││
│              │ ⏵ ◌ PAIR 3   G:\Music  ⇄  E:\Backup\Music    (collapsed · in sync ✓ · 0 changes)                │
│              ├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ───────────  │ baseline present · deletes → recycle bin · 3 conflicts unresolved                              │ status strip
│ ◉ engine idle│ Selected: 161 actions, 12 deletes · est 1.9 GB        [Resolve all conflicts to enable ▷ Apply]│
└──────────────┴──────────────────────────────────────────────────────────────────────────────────────────────┘
```

In-progress overlay of the status strip during `execute_sync`:

```
│ ▌ APPLYING  pair 2/3 · 88/161 · ████████████▒▒▒▒▒▒▒▒ 54%  copying  C:\Work\db\dump.sql → \\nas\work\…   [■ Cancel]│
```

---

**(3) Layout / components breakdown** (design-system names in parens).

- **Topbar (44, drag region).** Status-dot + job name + inherited-mode badges (`two-way`/`gitignore`/`recycle-bin` = NEUTRAL chips, mode badge colored when MIRROR/UPDATE). Right cluster: **Preview** (default Button), **Apply** (`go` green Button, disabled while conflicts>0 or scanning). Second line: `N pairs`, `BaselineStatus` chip (Present=ok / FirstSync=watch / Corrupt=warn), last scan mtime (mono), `↻` rescan (icon Button), **Edit job** (ghost → Job Editor), `⋯` overflow.
- **Job Summary bar (Summary chips, pill).** Aggregated across every pair's `PlanSummary`: `copy_a_to_b` (COPY), `copy_b_to_a` (COPY), `delete_a+delete_b` (DELETE), `conflicts` (CONFLICT), `noop` (NEUTRAL, hidden count), `skipped` (WARN). A right-aligned CONFLICT callout when any conflict exists: "► N conflicts block apply".
- **Filter/diff toolbar (Inputs h30).** Mono row-filter input (path substring / glob); `All actions` / `A chg` / `B chg` dropdowns (filter by `Action` / `ChangeKind`); `show in-sync` toggle (reveals `Noop`/`UpdateBaselineOnly` rows, hidden by default); sort `↕ path`; `⬥ next-conflict` jump button.
- **Per-pair section.** Collapsible **pair header (Job-row styling, 30)**: chevron, status-dot, `rootLeft ⇄ rootRight` (mono), `filter override`/`mode override` badge when the pair overrides job settings, per-pair change count + conflict count. Body = the **compare grid (virtualized)**.
- **Compare grid row (30, columns per cheatsheet):** `[☑ select]` `[path mono 1fr]` `[A change glyph]` `[dir →/←/⇄/·]` `[B change glyph]` `[action badge 96]` `[size mono right]` `[resolve select — only on Conflict]`. Glyphs map `ChangeKind`: Created `+` (ok), Modified `~` (warn), Deleted `−` (del), TypeChanged `⇄` (conflict), Unchanged `·` (neutral). Action badge = filled `<meaning>-bg/fg`, xs 600, no border, keyed off `Action`. `ConflictType` renders as an outlined sub-tag under the badge (EditEdit, ModifyDelete, CreateCreate, …). Conflict rows get a magenta left-stripe + tint; `StateDesync` rows render DANGER (red), are non-selectable, and show "refuse to act".
- **Resolve select** (Inputs, only on `Conflict`): options come straight from `PlanItem.resolution_options`, default preselected from `PlanItem.default_resolution` (KeepA/KeepB/KeepNewer/KeepBoth/PropagateDelete/KeepModified/KeepTypeChanged/Skip). `StateDesync` offers only Skip.
- **Banners (never-dismissible, per cheatsheet "SAFETY visible").** Per-pair **big-delete guard** (DANGER) when `SyncPlan.big_delete` is `Some`, showing `deletions/total_members` and `pct vs threshold`. `Corrupt` baseline → WARN banner ("safe union, no deletions"). Any `StateDesync` present → DANGER job banner.
- **Status strip (sidebar footer continuation + content footer).** Engine status dot (idle/scanning/applying = live ring+pulse). Footer shows selected action/byte estimate and the apply-gating reason.
- **Tabs within the workspace:** `Compare` (default) and `Report` (the last `ApplyReport`, see states).

---

**(4) All states.**

- **Empty (job has 0 enabled pairs):** body shows Empty-state ("No folder pairs in this job") + **Add folder pair** / **Edit job** buttons. Apply disabled.
- **Idle / not-yet-previewed:** grid placeholders per pair: "Not scanned — press ⌘P to preview". Summary chips greyed. Apply disabled.
- **Loading (preview running):** topbar dot → scanning (pulse). Each pair header shows a skeleton + "scanning… N entries" (driven by a new `sync://scan` event); rows stream in or appear when the pair's `SyncPlan` resolves. Preview button becomes **Cancel preview**. Sequential: pair 1 can be populated while pair 3 still scans.
- **Populated (default):** as mocked. `noop`/`UpdateBaselineOnly` collapsed behind `show in-sync`. In-sync pairs auto-collapse with a green ✓.
- **Conflict:** conflict rows pinned visible (never hidden by `show in-sync`), magenta stripe, resolve select required. Job Summary shows CONFLICT count; **Apply disabled until every conflict has a non-pending resolution** (footer reason: "Resolve all conflicts to enable Apply"). `⬥ next-conflict` cycles them. Deep dives go to the dedicated **Conflict Resolution** screen (cross-nav) but inline resolve is the fast path.
- **In-progress (execute):** status strip becomes the **Progress** component (inset track + accent fill) reading `sync://progress`; mono current-path, `pair k/N` + item counts, **Cancel** (`cancel_sync`). Grid rows live-update status; the rest of the UI locks (Preview/Edit disabled).
- **Error:** (a) `validate_job` failure → invalid pair root shows red validity dot in the pair header + DANGER banner, that pair excluded from preview. (b) `preview_sync` error for a pair → that pair header shows DANGER "scan failed: <SyncError>", its grid empty, other pairs still usable. (c) Per-item apply failure → row badge → DANGER `Failed` with `ItemOutcome.error` tooltip.
- **Report (post-apply):** **Report** tab/auto-switch shows `ApplyReport`: chips `done`/`failed`/`skipped`/`conflicts` (meaning-colored) + `bytes_copied` (mono). `outcomes` render as a filtered grid (default filter = Failed). Success toast (bottom-right). Failed>0 → DANGER banner "N actions failed — review report".
- **Watch / scheduled variant:** if `job.watch.enabled`, topbar dot → WATCH (teal, ring+pulse) "watching · auto-sync"; the grid becomes a live activity feed driven by the watcher, Preview/Apply hidden in favor of "Pause watch". If `job.schedule.enabled`, a WATCH chip shows `nextRun` (mono) and "manual run still available" — manual Preview/Apply remain enabled. (Both are P1; render read-only "Coming soon" affordances until the daemon ships.)

---

**(5) Key interactions & keyboard affordances.**

- `⌘/Ctrl-P` Preview · `⌘/Ctrl-↵` Apply (only when enabled) · `Esc` Cancel (preview or apply).
- `↑/↓` move row · `Space` toggle row selection · `⌘/Ctrl-A` select all in focused pair · `⇧` range-select.
- `1..8` on a focused conflict row picks the nth offered `Resolution`; `[` / `]` jump prev/next conflict (= `⬥ next-conflict`).
- `←/→` collapse/expand the focused pair section; `⌘/Ctrl-clicking` a pair header solos it.
- `/` focuses the row filter; `h` toggles `show in-sync`.
- Click action badge → cycles direction only where the engine allows (Copy A▸B ↔ Skip); deletes require the row stay selected. Click path → reveal-in-OS context action (`⋯`).
- Per-pair "select none / select conflicts only" in the pair header overflow. Bulk resolve: "Apply KeepNewer to all EditEdit in this pair".
- `:focus-visible` ring always rendered (2px base + 4px accent). Motion 90–140ms on expand/collapse and progress fill.

---

**(6) Tauri commands & events.**

Reused existing (one `JobConfig` compiled per enabled `FolderPair` = resolved roots + `IgnorePolicy` + `verify_by_hash` + bigDelete*):
- `validate_job(cfg)` — on open and on Edit, per pair; drives the validity dot.
- `get_baseline_status(cfg)` — per pair; drives the BaselineStatus chip + Corrupt banner.
- `preview_sync(cfg) -> SyncPlan` — Preview, called once per enabled pair; results keyed by pair id.
- `execute_sync(cfg, resolutions: Map<path,Resolution>, confirm_big_delete) -> ApplyReport` — Apply, per pair, passing that pair's collected inline resolutions and the user's big-delete confirmation; emits `sync://progress`.
- `cancel_sync()` — Cancel button / `Esc` (sets the shared atomic; affects the running pair).
- `import_ffs(path)` — only reachable from this screen via `⋯ → Import pairs from FFS` (one `.ffs_batch` → pairs appended to this job).

**NEW commands needed** (additive; engine unchanged):
- `load_job(jobId) -> Job` / `save_job(job)` — persist `jobs.json` (the Job→FolderPairs model); this screen reads the open job and writes inline edits (pair enable, resolution memory).
- `preview_job(jobId) -> Vec<{pairId, SyncPlan}>` — convenience that resolves inheritance and previews all enabled pairs server-side (sequential, cancellable), so the UI doesn't reassemble `JobConfig`s. Wraps existing `engine::preview`.
- `execute_job(jobId, resolutions: Map<pairId, Map<path,Resolution>>, confirm_big_delete: Map<pairId,bool>) -> Vec<{pairId, ApplyReport}>` — drives all enabled pairs in order, honoring per-pair big-delete confirmation. Wraps existing `engine::execute`.
- `reveal_path(root, relPath)` — OS reveal for the path context action.

**NEW events needed:**
- `sync://scan` `{ pairId, scanned, phase }` — incremental scan progress so the Loading state isn't a black box.
- `sync://progress` (existing payload) extended/wrapped with `{ pairId, pairIndex, pairCount }` so the Progress bar can show `pair k/N` across a multi-pair run.
- `sync://pair-done` `{ pairId, plan | report }` — lets the UI populate/finalize a pair's grid as soon as it completes, while later pairs are still running.

---

I have enough grounding in the model, config, FFS importer, and Tauri command surface. Here is the spec.

## Job Editor (create / edit)

**(1) Purpose.** A single modal/route for authoring one Job — its name, its ordered list of folder pairs, the shared `JobSettings` (mode, compare, deletion policy, job-level filter), per-pair filter/mode overrides, and the (P1) schedule + watch toggles — with live `validate_job` feedback per pair before anything can be saved.

**(2) Mockup** (full shell; Job Editor open as a route in the content pane; `surface-3` overlay panels live inside it, not a tiny dialog — this screen is too dense for a modal):

```
┌──────────────┬───────────────────────────────────────────────────────────────────────────────────┐
│ fast-file-   │  ▏ Jobs ▸ Edit Job                                              [⌘S Save]  [Esc Cancel]│ 44 topbar (drag)
│   sync   ▢▢▢ ├───────────────────────────────────────────────────────────────────────────────────┤
│              │                                                                                       │
│ ▸ JOBS     ◀ │   NAME                                                                                 │
│   Schedules  │   ┌─────────────────────────────────────────────────────────────┐ ● valid            │
│   Activity   │   │ Documents ↔ NAS                                              │  (name ok)         │
│   Cloud/Dev  │   └─────────────────────────────────────────────────────────────┘                    │
│   Settings   │                                                                                       │
│              │   ┌── SYNC ─────────────────────────────────────────────────────────────────────┐    │
│              │   │ DIRECTION   (●Two-way ↔ )( ○Mirror L→R )( ○Mirror R←L )                       │    │
│              │   │ COMPARE     (●Size+Time)( ○Content-hash )   ⓘ hash is slower, catches edits  │    │
│              │   │ ON DELETE   (●Recycle bin)( ○Permanent ⚠ )( ○Versioned ·soon )               │    │
│              │   │ GUARD       Big-delete trips at [ 25 ]%  or  [ 100 ] files   (whichever first)│    │
│              │   └─────────────────────────────────────────────────────────────────────────────┘    │
│              │                                                                                       │
│              │   ┌── FILTER (job default) ──────────────────────── inherited by all pairs ──────┐    │
│              │   │ [★ Respect .gitignore  �®on ]  [ .ignore �®on ]  [ Hidden files ▢off ]         │    │
│              │   │ ┌ custom globs (gitignore syntax · ! re-includes) ───────────────────────┐    │    │
│              │   │ │ 1  node_modules/                                                        │    │    │
│              │   │ │ 2  *.tmp                                                                 │    │    │
│              │   │ │ 3  !keep.tmp                                          (! = ok-green)     │    │    │
│              │   │ │ 4  ▌                                                                     │    │    │
│              │   │ └─────────────────────────────────────────────────────────────────────────┘    │    │
│              │   │ ✦ gitignore covers node_modules/.git/dist — you can likely drop those.       │    │
│              │   └─────────────────────────────────────────────────────────────────────────────┘    │
│              │                                                                                       │
│              │   FOLDER PAIRS  (2)                                              [ + Add pair ]        │
│              │   ┌─────────────────────────────────────────────────────────────────────────────┐    │
│              │   │ ⠿ 1  ● valid · baseline:present                                    [⌄][⧉][✕]  │    │
│              │   │    LEFT  [ E:/MyDocuments                              ]·mono [Browse] ●        │    │
│              │   │    RIGHT [ //NAS/home/MyDocuments                      ]·mono [Browse] ●        │    │
│              │   │    label [ Documents                  ]   filter: inherit · mode: inherit       │    │
│              │   │    [ + override filter ]  [ + override mode ]                                   │    │
│              │   ├─────────────────────────────────────────────────────────────────────────────┤    │
│              │   │ ⠿ 2  ◐ checking… · baseline:first-sync                             [⌄][⧉][✕]  │    │
│              │   │    LEFT  [ E:/Programming                             ]·mono [Browse] ●         │    │
│              │   │    RIGHT [ //NAS/home/Programming                     ]·mono [Browse] ◐         │    │
│              │   │    label [ Code                       ]   mode: Mirror L→R (override) ✎         │    │
│              │   │    ▏ FILTER OVERRIDE (replaces job filter for this pair)            [ remove ]  │    │
│              │   │    ▏ [★ .gitignore �®on][ .ignore ▢off ][ Hidden ▢off ]                         │    │
│              │   │    ▏ 1  target/                                                                 │    │
│              │   │    ▏ 2  !target/keep/                                                           │    │
│              │   └─────────────────────────────────────────────────────────────────────────────┘    │
│              │                                                                                       │
│              │   ┌── AUTOMATION (optional) ────────────────────────────────────────── ·soon ───┐    │
│              │   │ [ ▢ Schedule ]  cron [ 0 3 * * *        ]·mono  next: Thu 03:00   (disabled)  │    │
│              │   │ [ ▢ Watch    ]  debounce [ 800 ]ms   live auto-sync over all pairs (disabled)  │    │
│              │   └─────────────────────────────────────────────────────────────────────────────┘    │
│ ───────────  │                                                                                       │
│ ◉ engine idle│   ⚠ Pair 2 RIGHT nests inside Pair 1 RIGHT — overlapping roots are not allowed.       │ ← banner (danger)
│ 232          │   ┌──────────────────────────────────────────────────────────────────────────────┐   │
└──────────────┤   │   [ Cancel ]                       [ Preview all pairs ]   [ Save job ]  ◀go  │   │ sticky footer
               └───────────────────────────────────────────────────────────────────────────────────┘
```

**(3) Layout / components** (design-system names verbatim):

- **Route, not modal.** Lives in the content pane (sidebar `Jobs` stays active). Reserve the `surface-3` lg modal only for sub-flows it spawns (FFS import review, big-delete confirm, browse). `topbar` is the drag region and carries the `⌘S Save` / `Esc Cancel` ghost buttons.
- **Sections** are flat 1px `border` cards on `surface` over `base`, header = xs 11 UPPER muted. Order: Name → Sync → Filter(job) → Folder Pairs → Automation.
- **NAME**: `Input` h30 `surface-2` sans (the one non-mono input here) + a validity `status dot` (ok/danger) — empty name = danger.
- **SYNC card**:
  - DIRECTION = segmented control of 3 pills → maps `JobSettings.mode`: Two-way = `TwoWay`, Mirror L→R / R←L = `Mirror` (+ a direction flag the engine reads as which root is source). Selected pill uses ACCENT(copy) fill.
  - COMPARE = segmented Size+Time vs Content-hash → `JobConfig.verify_by_hash` (Content = true). Content shows a WARN-tinted `ⓘ` hint.
  - ON DELETE = segmented → `deletePolicy`: Recycle bin (`use_recycle_bin=true`), Permanent (DANGER-tinted, `use_recycle_bin=false`), Versioned (NEUTRAL, `·soon` disabled).
  - GUARD = two mono numeric `Input`s (h30) → `big_delete_pct` (÷100) and `big_delete_abs`. Defaults 25 / 100 from `config.rs`.
- **FILTER (job default) card** → `JobSettings.filter: IgnorePolicy`:
  - Three toggle chips: `★ Respect .gitignore` (the unique-value chip, ACCENT star) = `use_gitignore`; `.ignore` = `use_dot_ignore`; `Hidden files` = `include_hidden`.
  - Mono glob list editor: numbered lines (mono 12.5), each line = one `custom_globs` entry; lines starting `!` render in OK-green (re-include). Trailing empty line is the add row.
  - `gitignore_hint` banner (✦, NEUTRAL/info) appears when the heuristic from `ffs_import::gitignore_hint` fires (reused post-import).
- **FOLDER PAIRS** (the core; `pairs: FolderPair[]`, ≥1):
  - Header shows count + `[+ Add pair]` primary-ghost.
  - Each pair = a card row, drag handle `⠿` (reorder), a per-pair `status dot` + inline tags `baseline:present|first-sync|corrupt` (from `get_baseline_status`, colored ok/watch/warn), and row actions `[⌄]` collapse · `[⧉]` duplicate · `[✕]` remove.
  - LEFT / RIGHT = mono path `Input`s h30 + `[Browse]` (Tauri dialog) + a per-field validity `status dot` (live `validate_job`).
  - `label` = optional sans `Input` (the per-pair label; stored on `FolderPair`, falls back to `derive_name`).
  - Override affordances: `[+ override filter]` expands an **indented filter sub-panel** (left ACCENT side-bar `▏`, "replaces job filter for this pair" — matching `filterOverride` REPLACE semantics, not merge). `[+ override mode]` swaps mode inline → `modeOverride`. When set, a `remove` link reverts to inherit (`null`).
- **AUTOMATION card** (P1, disabled `·soon`): `Schedule` toggle + mono cron `Input` + computed `next:`; `Watch` toggle + debounce ms `Input`. Render but `disabled` — present so the IA already has a home (`Schedule`, `WatchConfig`).
- **Banner** (above footer, non-dismissible, `SAFETY=visible`): validation errors aggregated (nested/identical roots in DANGER; warnings like one-way-mirror-imported in WARN).
- **Sticky footer**: `[Cancel]` ghost · `[Preview all pairs]` default · `[Save job]` go(green). Save disabled until every pair validates.

**(4) States:**

- **Empty / Create**: one blank pair pre-seeded, name empty (danger dot), Save disabled. Filter defaults to `IgnorePolicy::default()` (gitignore on, .ignore on, hidden off). Footer Save greyed with tooltip "Name and at least one valid pair required."
- **Loading (edit existing)**: skeleton rows in `surface-2` shimmer while `jobs.json` loads; per-pair baseline dots show `◐ checking…` until `get_baseline_status` resolves.
- **Populated**: as drawn — N pairs, mix of inherit/override, valid dots green.
- **Validating (in-progress)**: each path edit (debounced ~250ms) flips that pair's dot to `◐ checking…` while `validate_job` runs; resolves to `● valid` or `✕ invalid` with the `SyncError` message inline under the offending field.
- **Error**: `validate_job` rejects (missing root, unreadable, identical roots, nested roots). Field dot DANGER, message inline, aggregated into the non-dismissible banner, Save blocked. The editor's own client checks (two pairs sharing/nesting roots, duplicate empty pair) are caught before invoking the command.
- **Conflict / safety variant**: not a per-file conflict screen (that's Conflict Resolution), but the editor surfaces *configuration* hazards: Permanent-delete selected → DANGER tint + a confirm checkbox "I understand deletes won't be recoverable"; `baseline:corrupt` on a pair → WARN banner "baseline unreadable, next run is union-only (no deletions)"; an imported one-way mirror that the engine still treats two-way → WARN until the user picks a real Mirror mode.
- **Watch / Scheduled variant**: when Schedule or Watch is enabled (P1), the topbar gains a WATCH(`#39c5cf`) status chip "scheduled" / "watching"; the Automation card border tints WATCH; the footer Save label becomes "Save & arm". While disabled (P0) the whole card is `·soon` and inert.

**(5) Interactions & keyboard:**

- `⌘S / Ctrl+S` Save · `Esc` Cancel (prompts if dirty) · `⌘↵` Save & Preview.
- `⌘N` / `Alt+A` Add pair; `⌘D` on a focused pair duplicates (`⧉`); `Del` on a focused pair removes (with undo toast); `Alt+↑/↓` reorder focused pair; drag `⠿` to reorder.
- Glob editor: `Enter` commits a line + opens the next; `Backspace` on an empty line removes it; lines validated as gitignore syntax (bad glob → DANGER underline).
- `[Browse]` opens the Tauri dialog plugin folder picker; on return the path is normalized to forward-slash mono and triggers validation.
- Tab order: Name → Sync controls → Filter toggles → glob list → each pair (left, right, label, overrides) → Automation → footer. `:focus-visible` ring always shown (2px base + 4px accent).
- Segmented controls are radio groups (←/→ to move). Toggle chips are space/enter.
- Live: on any path change, debounce → `validate_job` for that pair and `get_baseline_status` to refresh its baseline tag.

**(6) Tauri commands & events:**

Reused as-is:
- `validate_job(cfg: JobConfig)` — per pair, on path edit/blur; drives the per-field/per-pair validity dots and inline errors. (Editor compiles each `FolderPair` → one `JobConfig` exactly as the data-model spec prescribes: `rootLeft/Right` + resolved `IgnorePolicy` (override ?? job filter) + `verify_by_hash` + `big_delete_*` + `use_recycle_bin`.)
- `get_baseline_status(cfg)` — per pair, to show `present|first-sync|corrupt` tags.
- `preview_sync(cfg)` — `[Preview all pairs]` runs it per enabled pair and routes to the Compare Workspace (one preview per pair).
- `import_ffs(path)` — entry path "New from FreeFileSync" lands an `FfsImport` here as a pre-filled Job: the N `ImportedJob`s become N `FolderPair`s of ONE Job, `two_way`→mode, `use_recycle_bin`/`verify_by_hash`→settings, `exclude_globs`→ filter custom_globs, `gitignore_hint`/`warnings`/`notes`→ the filter banner and per-pair WARN tags.
- `execute_sync` / `cancel_sync` — NOT called from the editor; they belong to the Compare Workspace after preview.

New commands/events needed (persistence + IA the existing surface lacks):
- `list_jobs() -> Vec<Job>` — load `jobs.json`.
- `get_job(jobId) -> Job` — populate editor on edit.
- `save_job(job: Job) -> Job` — create/update; persists `jobs.json`, allocates per-pair `id` (= today's `job_id()` blake3 of left+right) and per-pair `jobs/<pairId>/baseline.json` dir. Returns canonical Job (ids filled).
- `delete_job(jobId)` — used from Jobs Dashboard, listed here for completeness.
- `validate_pair_set(pairs: FolderPair[]) -> Vec<PairIssue>` — server-side cross-pair check (nested/identical/duplicate roots across the whole job, since `validate_job` only knows one pair). Could alternatively be a client-side check, but a command keeps path-normalization (NFC, separator) consistent with the engine's `pathutil`.
- `pick_folder() -> Option<String>` — thin wrapper over the dialog plugin returning an engine-normalized path (or call the dialog plugin directly from JS and normalize on the Rust side at validate time).
- Event `job://baseline-status` (optional) — if baseline checks are made async/streamed for many pairs, to update tags without blocking; otherwise the awaited `get_baseline_status` per pair suffices.

Note: `JobConfig` (config.rs) has no `mode`/`deletePolicy` enum yet — Mirror/Update and Versioned require extending `JobConfig` (e.g. a `mode: SyncMode` and richer deletion policy) per the data-model P0/P1 plan; the editor UI is built for them now, with Versioned/Update rendered `·soon` until the engine lands them.

---

I have everything I need. The engine already supplies `resolution_options` and `default_resolution` per-conflict in each `PlanItem`, and `execute_sync` takes a `HashMap<String, Resolution>`. Here is the design.

## Conflict Resolution

**(1) Purpose:** A focused, safety-first surface — a right-docked panel over the Job Detail compare workspace — where the user inspects each conflicting path side-by-side (A vs B metadata + preview) and assigns the engine-supplied `Resolution` per path (or in bulk), with "no data is ever lost" made structurally obvious before anything executes.

**(2) Mockup** (within the sidebar shell, populated state, panel docked right over the compare list):

```
┌──────────┬──────────────────────────────────────────────────────────────────────────────────────┐
│ ▟ ffsync │  Photos ⇄ NAS                                          ● engine idle   [Preview] [Sync]│ 44 topbar (drag)
├──────────┼───────────────────────────────────────────────────┬──────────────────────────────────┤
│ ▸ Jobs ◂ │ COMPARE  src ⇄ //nas/photos   312 items            │ ▌RESOLVE CONFLICTS            7  │  ← panel header, magenta L-bar
│ ⏱ Sched. │ ──────────────────────────────────────────────────│ ──────────────────────────────── │
│ ≋ Activ. │ ✓ path                    A   →←↔  B   action   sz │  ⚠ 7 conflicts block this sync.  │  ← non-dismissible banner
│ ☁ Cloud  │ ░░░ 2024/IMG_0421.cr2 ~  →✗←  ~ ⟨EditEdit⟩  4.2M  │    Nothing runs until each is    │
│ ⚙ Settng │   src/report.docx      ~   →   ·  copy A→B   88K  │    resolved or skipped.          │
│          │   src/old/.cache       ·   −   ✗  del A      12K  │ ──────────────────────────────── │
│          │ ▌ 2024/IMG_0421.cr2  ~  ✗  ~  CONFLICT  4.2M ◂────┼─ selected row (magenta tint+stripe)│
│          │ ▌ notes/todo.md      ~  ✗  −  CONFLICT  1.1K     │ ⟨EditEdit⟩  2024/IMG_0421.cr2    │  ← mono path, outlined type tag
│          │ ▌ assets/logo.png    +  ✗  +  CONFLICT  240K     │                                  │
│          │ ▌ db/notes.sqlite    ~  ✗  −  CONFLICT  9.0M     │  ┌── A  src ───────┬── B //nas ─┐ │
│          │   …201 in-sync hidden                            │  │ size  4.20 MB   │ 4.18 MB   │ │  ← mono diff grid
│          │                                                  │  │ mtime 06-24     │ 06-25 ▲   │ │     ▲ = newer
│          │                                                  │  │       14:02:11  │ 09:31:40  │ │
│          │                                                  │  │ hash  9f3a1c…  │ b7e0d2…   │ │
│          │                                                  │  │ kind  file      │ file      │ │
│          │                                                  │  └─────────────────┴───────────┘ │
│          │                                                  │  ┌ preview (text/img) ──────────┐ │
│          │                                                  │  │ A │ binary · 4.2M · no preview│ │
│          │                                                  │  └───┴──────────────────────────┘ │
│          │                                                  │                                  │
│          │                                                  │  RESOLUTION                      │  ← xs UPPER muted header
│          │                                                  │  ( ) Keep both  (rename B ~B)  ★ │  ← ★ = default, focus ring
│          │                                                  │  ( ) Keep A (src)  → overwrites B│  ← orange "overwrites" hint
│          │                                                  │  ( ) Keep B (//nas)→ overwrites A│
│          │                                                  │  ( ) Keep newer  (B, 06-25)      │
│          │                                                  │  (•) Skip — leave both untouched │  ← green: zero data loss
│          │                                                  │                                  │
│          │                                                  │  ✓ No data lost: both copies kept│  ← live green assurance line
│          │                                                  │ ──────────────────────────────── │
│          │                                                  │ BULK  apply to ▸ EditEdit (3) ▾  │
│          │                                                  │  [Keep both] [Keep newer] [Skip] │
│ ───────  │                                                  │ ──────────────────────────────── │
│ ● idle   │ [show in-sync]      4 resolved · 3 left          │ 4 of 7 resolved   [Apply & Sync]▸│  ← go=green, disabled until 0 left
└──────────┴──────────────────────────────────────────────────┴──────────────────────────────────┘
```

**(3) Layout / components** (design-system tokens):
- **Shell:** persistent sidebar (232, Jobs active = `bg-active` + 2px accent bar) + 44 topbar drag region. Panel is a `surface-2` right dock (≈420w) over the virtualized compare list; opened by clicking a conflict row or the "RESOLVE CONFLICTS N" summary chip. (Same component renders as a centered `surface-3` lg modal+scrim when launched standalone, e.g. from Activity.)
- **Conflict queue (left of panel):** the existing virtualized compare row `[✓][path mono 1fr][A chg glyph][→←↔/✗][B chg][action badge 96][size mono R]`. Conflict rows get a magenta (`CONFLICT #db61a2`) left stripe + tint; direction cell shows `✗` (refuse-to-act). `Action::Conflict` badge is filled CONFLICT-bg; `ConflictType` shown as an **outlined sub-tag** `⟨EditEdit⟩`. Non-conflict rows stay but de-emphasized; `Noop` hidden behind "show in-sync".
- **Panel header:** magenta L-bar + "RESOLVE CONFLICTS" + count pill. Below it a **non-dismissible safety Banner** (per cheatsheet: SAFETY = visible, never a toast).
- **Detail body** (selected `PlanItem`): outlined `ConflictType` tag + mono path; an **A│B diff grid** (mono `size`/`mtime`/`hash`/`kind` from `PlanItem.a`/`.b`/`.base`; newer mtime gets a `▲` in WARN `#d4a017`, differing cells tinted). Optional **preview pane** (text head / image thumb; binary → "no preview").
- **Resolution control:** radio list built **verbatim from `PlanItem.resolution_options`**, default pre-selected from `PlanItem.default_resolution` (★). Each option carries a meaning-colored consequence hint: destructive picks (`KeepA`/`KeepB`/`KeepNewer`/`PropagateDelete`/`KeepTypeChanged`) → DELETE-orange "→ overwrites X" / "discards the edit"; non-destructive (`KeepBoth`, `Skip`) → OK-green. A live **"No data lost / ⚠ B's copy is replaced"** assurance line updates per selection.
- **Bulk bar:** scope select grouped by `ConflictType` ("apply to EditEdit (3)" / "all conflicts") + buttons rendered from that group's intersection of `resolution_options`.
- **Footer:** "[show in-sync]" toggle, `N resolved · M left`, and **go-green `[Apply & Sync]`** (disabled while any conflict is unresolved AND not skipped). Engine status dot bottom-left of sidebar.

**(4) All states:**
- **Empty (no conflicts):** panel/section not auto-opened; compare workspace shows OK-green check "In sync — 0 conflicts." If opened manually: centered muted "No conflicts to resolve ✓".
- **Loading:** triggered by `preview_sync`. Compare list shows skeleton rows; panel header shows a pulse ring on the engine dot + "Scanning… [Cancel]" (calls `cancel_sync`). Diff grid shows shimmer placeholders.
- **Populated:** as mockup; first unresolved conflict auto-selected, its `default_resolution` highlighted.
- **In-progress (applying):** after `[Apply & Sync]` → `execute_sync`. Footer becomes a progress bar (inset track, accent fill) with mono current path + per-item tick from `sync://progress`; `[Cancel]` calls `cancel_sync`. Resolution radios lock (read-only). On finish, panel folds into an `ApplyReport` summary: pill chips `done/skipped/failed/conflicts` colored to meaning, mono per-path `ItemOutcome` list (Failed = DANGER `#f85149`).
- **Error:** (a) item-level — `ItemOutcome.status=Failed` row in DANGER with `error` string + per-row [Retry]. (b) `SyncError` from `preview_sync`/`execute_sync` → non-dismissible DANGER banner with message + [Retry preview]. (c) `BaselineStatusKind::Corrupt` → WARN banner "Baseline corrupt — safe union, deletions suppressed"; `FirstSync` → WATCH banner "First sync — zero deletions."
- **Conflict subtype = `StateDesync`:** treated as DANGER, not magenta (per cheatsheet "refuse-to-act"): row gets DANGER stripe; detail header reads "Desync — refusing to act"; options (`Skip`,`KeepA`,`KeepB`,`KeepBoth`) default to **Skip**, and the banner explains the baseline/state mismatch. `big_delete` present → danger Banner + typed-confirm requirement folds into the safety banner ("type DELETE to allow N deletions", sets `confirm_big_delete`).
- **Watch / scheduled variant:** when the job has `watch`/`schedule`, conflicts can arrive unattended. Daemon **never auto-resolves** — instead a WATCH-teal (`#39c5cf`) badge "AUTO-PAUSED · 7 conflicts await you" appears in the job row, Activity, and this panel header; auto-sync of *this pair* is held until resolved. A per-job toggle "Auto-apply default resolutions on watch" (off by default, surfaced here) would switch defaults to `KeepBoth`-safe behavior; destructive defaults stay manual.

**(5) Interactions & keyboard:**
- `↑/↓` or `j/k` move through the conflict queue; selection drives the detail panel.
- `1`–`5` select the Nth listed `resolution_options` entry; `Enter` confirms current + advances to next unresolved.
- `b` opens bulk scope; `Shift+Enter` applies current resolution to the whole `ConflictType` group.
- `s` = Skip current; `[` toggles "show in-sync"; `Esc` closes panel back to compare (resolutions persist in component state).
- `Ctrl+Enter` = Apply & Sync (only when 0 unresolved). Destructive picks show the orange consequence inline; `KeepBoth`/`Skip` never warn.
- `:focus-visible` always shows the 2px-base + 4px-accent ring; radios are real radios (a11y). Hovering an option live-updates the assurance line so the loss/no-loss outcome is legible before commit.

**(6) Tauri commands:**
- **Reuse:** `validate_job` (on open), `get_baseline_status` (drives Corrupt/FirstSync banners), `preview_sync` (source of conflict `PlanItem`s incl. `conflict`, `a`/`b`/`base`, `resolution_options`, `default_resolution`), `execute_sync(cfg, resolutions: HashMap<path,Resolution>, confirm_big_delete)` (the assigned resolutions are this map), `cancel_sync`, plus event `sync://progress` for the in-progress bar. `import_ffs` only on the FFS path (not here).
- **NEW commands needed:**
  - `get_preview_content(cfg, pair_id, path, side: "A"|"B", max_bytes) -> PreviewBlob { kind: Text|Image|Binary|TooLarge, bytes/text, truncated }` — for the preview pane (preview is not in `PlanItem`).
  - `compute_hashes(cfg, pair_id, path) -> { a: Option<String>, b: Option<String> }` — `Meta.hash` is lazily `None`; the diff grid requests it on demand to show real content identity.
  - `reveal_in_os(path)` *(optional)* — "open in file manager" affordance per side.
  - Since today's `execute_sync` runs one `JobConfig`, multi-pair jobs need a per-pair invocation wrapper: **NEW** `execute_pair_sync(job_id, pair_id, resolutions, confirm_big_delete)` (and `preview_pair_sync(job_id, pair_id)`) that resolves a `FolderPair` → existing `JobConfig` and calls the unchanged engine.
- **NEW events:** `watch://conflicts-detected { job_id, pair_id, count }` (drives the AUTO-PAUSED watch badge), and `sync://item-outcome { ItemOutcome }` (optional finer-grained streaming so failed rows render live rather than only in the final `ApplyReport`).

---

I have enough grounding from the model, config, and the design system cheatsheet. Here is the deliverable.

## Schedules

**Purpose:** A job-level control surface for unattended runs — list every job's cron-like schedule, show next/last fire and outcome, toggle enable/disable, build a recurrence with a friendly builder (or raw cron), and pre-decide on-conflict behavior — all rendered as a "coming soon" preview that still looks and behaves like a real screen.

---

### (2) Mockup — within the sidebar shell (populated state)

```
┌──────────────┬──────────────────────────────────────────────────────────────────────────────────┐
│ fast-file-   │  Schedules                          [ preview ]            [ + New schedule ]  ⟳    │ ← topbar 44, drag
│   sync       ├──────────────────────────────────────────────────────────────────────────────────┤
│              │  ⚠ Scheduling is coming soon. You can design schedules now; they won't run yet.  ✕? │ ← Banner (warn, non-dismiss)
│ ▸ Jobs       ├──────────────────────────────────────────────────────────────────────────────────┤
│ ▸ Schedules ◀│  ◷ 3 schedules · 2 enabled · next: Photos backup in 00:41:12                       │ ← summary chips (pill)
│ ▸ Activity   │                                                                                    │
│ ▸ Cloud/Dev  │  ●  Photos backup            every day at 02:00            on-conflict: notify      │
│ ▸ Settings   │     job · Photos→NAS  ·  2 pairs · two-way · gitignore                              │
│              │     next  Thu 02:00  (in 00:41:12)      last  Wed 02:00  ✓ 1,204 copied  0 conflict │
│              │     ┌──────────────────────────────────────────────────────────────────────────┐   │
│              │     │ [✓ Enabled]   [ Edit ]  [ Run now ]  [ View runs ]                    ⋯   │   │
│              │     └──────────────────────────────────────────────────────────────────────────┘   │
│              │  ──────────────────────────────────────────────────────────────────────────────   │
│              │  ●  Docs mirror              every 15 min                 on-conflict: notify      │
│              │     job · Docs→S3  ·  1 pair · mirror → · gitignore                                 │
│              │     next  18:45  (in 00:09:03)         last  18:30  ⚠ 2 conflicts (held)           │ ← warn: held conflicts
│              │     [✓ Enabled]   [ Edit ]  [ Run now ]  [ View runs ]                         ⋯   │
│              │  ──────────────────────────────────────────────────────────────────────────────   │
│              │  ○  Laptop ⇄ Desktop         0 9-17 * * 1-5   (cron)       on-conflict: auto-safe   │
│              │     job · Peers  ·  3 pairs · two-way · gitignore                                   │
│              │     next  —  (disabled)                last  Mon 09:00  ✗ scan error (no deletes)   │ ← danger: last failed
│              │     [  Disabled ]   [ Edit ]  [ Run now ]  [ View runs ]                       ⋯   │
│              │                                                                                    │
│              ├──────────────────────────────────────────────────────────────────────────────────┤
│ ◍ engine idle│                                                                                    │ ← sidebar footer status
└──────────────┴──────────────────────────────────────────────────────────────────────────────────┘
```

**Editor (slide-over / modal, surface-3, lg radius + shadow over scrim) — the friendly builder:**

```
┌─ Edit schedule · Photos backup ─────────────────────────────────────────────  ✕ ┐
│                                                                                  │
│  Job        Photos→NAS   ▾        (read-only · runs all enabled pairs)           │
│  Enabled    [ ●━━ on ]                                                            │
│                                                                                  │
│  RECURRENCE                                                                      │
│   ( ) Every  [ 15 ]  [ minutes ▾ ]                                               │
│   ( ) Hourly        at minute  [ 00 ]                                            │
│   (•) Daily         at  [ 02:00 ]                                                │
│   ( ) Weekly        on [M][T][W][T][F][S][S]  at [ 02:00 ]                       │
│   ( ) Cron (raw)    [ 0 2 * * *                              ]  ◷ valid          │ ← mono input + validity dot
│        ↳ next 5: Thu 02:00 · Fri 02:00 · Sat 02:00 · Sun 02:00 · Mon 02:00       │ ← live preview (mono)
│   Timezone  [ Local (Europe/Berlin) ▾ ]                                          │
│                                                                                  │
│  ON CONFLICT (safety — never auto-applied unless you opt in)                     │
│   (•) Notify only — run copies/deletes, HOLD conflicts for review   ← default    │
│   ( ) Auto-resolve safe — apply KeepNewer where unambiguous; HOLD the rest       │
│   ( ) Skip run if any conflict (strict)                                          │
│   ⓘ StateDesync & big-delete guard always pause and notify, regardless.          │ ← inline safety note
│                                                                                  │
│  IF MISSED (laptop asleep)   (•) Run once at next wake   ( ) Skip                 │
│  CATCH-UP OVERLAP            [✓] Skip if previous run still in progress           │
│                                                                                  │
│                                        [ Cancel ]   [ Validate ]   [ Save ]      │ ← Save disabled until valid
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### (3) Layout / components breakdown (design-system mapping)

- **Shell:** standard `[sidebar 232][topbar 44 / content]` grid; `Schedules` sidebar item = active (`bg-active` + 2px accent left bar). Topbar carries page title, a `[ preview ]` NEUTRAL pill, the **primary** `+ New schedule` button (h30), and a ghost `⟳` refresh icon-button.
- **Coming-soon Banner:** `WARN` banner (`#d4a017` fg / `#2e2408` bg / `#574516` border), pinned, **not** a dismissible toast — consistent with the "safety/state is visible, never a toast" rule. Carries a `?` for a tooltip explaining preview mode.
- **Summary chips:** pill row (count + label), the `next:` chip counts down live (mono timer). Mirrors `PlanSummary`/`ApplyReport` chip language.
- **Schedule row (one per job's schedule):** a compact card, two text rows + an action sub-bar.
  - **status dot 8px** solid: enabled+armed = `OK green` with `live ring+pulse` when `next` is imminent/firing; enabled+last-failed shows `DANGER`; disabled = `NEUTRAL` hollow `○`.
  - **Line 1:** `name` (sans) · recurrence summary (human, e.g. "every day at 02:00") · `on-conflict: <mode>` tag.
  - **Line 2 (job tie-in, muted/mono):** `job · <JobName>` + the exact Job-row descriptor from the design system — `N pairs · <mode> · gitignore` — so a schedule reads as "this is a clock bolted onto that job."
  - **Line 3:** `next <abs> (in <countdown>)` and `last <abs> <outcome>`. Outcome reuses MEANING colors: `✓ N copied` = OK, `⚠ N conflicts (held)` = CONFLICT/WARN, `✗ scan error (no deletes)` = DANGER (and explicitly states deletions were suppressed — the scan-read-error safety rule, made legible).
  - **Action sub-bar:** `[✓ Enabled]` toggle (go/green when on), `Edit` (default), `Run now` (**go/green**, the execute affordance), `View runs` (ghost → deep-links to Activity filtered to job), `⋯` overflow (Duplicate, Delete schedule (danger), Copy cron).
- **Recurrence builder (editor):** radio group of modes; each compiles to a cron string. Raw-cron mode is a **mono path-style input** with a `validity dot` (green = parseable, danger = invalid) and a **live "next 5 fires" preview** in mono — the same input+validity-dot pattern used for path fields. Timezone select (h30, surface-2).
- **On-conflict control:** radio group whose options map straight to engine semantics — *Notify* holds all `Conflict` items; *Auto-resolve safe* applies `Resolution::KeepNewer` only where unambiguous and holds the rest; *Strict* skips the whole run on any conflict. Inline note states `StateDesync` and the big-delete guard **always** pause regardless (DANGER refuse-to-act stays manual).
- **Modal:** `surface-3`, lg radius, shadow over scrim — same class as FFS-import review / big-delete confirm. Save is **primary**, disabled until `Validate` passes.

---

### (4) All states

- **Empty (no schedules):** centered empty state — "No schedules yet" + muted "Run jobs automatically on a timer (coming soon)" + `[ New schedule ]` primary and a secondary `[ Browse jobs ]`. Matches the Schedules/Cloud "Coming soon" empty-state direction.
- **Loading:** header + chips render; 3 skeleton rows (shimmer on the dot, name, and `next/last` mono cells). No spinner blocking the page.
- **Populated:** as mocked — rows grouped/sorted by soonest `next`; disabled schedules sink to the bottom, dimmed.
- **In-progress (a schedule firing / `Run now`):** that row's dot becomes **live ring+pulse**; an inset progress track appears under Line 3 (accent fill, mono current path) with an inline **Cancel** (→ `cancel_sync`). Action bar disables `Run now`/`Edit` for that row mid-run.
- **Error states:**
  - *Last run failed (scan error):* `✗ scan error (no deletes)` in DANGER on Line 3; row dot DANGER. Deletions-suppressed phrasing is mandatory.
  - *Invalid cron in editor:* validity dot DANGER, "next 5" replaced by a DANGER hint ("Unparseable — expected 5 fields"), Save disabled.
  - *Validation (job)* failed: a DANGER inline strip under the Job field ("Pair root B unreachable") sourced from `validate_job`.
- **Conflict variant:** `⚠ N conflicts (held)` (CONFLICT magenta count) on the row; the schedule does **not** silently apply them. `View runs`/clicking the conflict count deep-links into **Conflict Resolution** for that (job,pair,run). A persistent (non-toast) **Banner** appears at top when any scheduled run has produced held conflicts awaiting review.
- **Big-delete guard variant:** if a scheduled run trips the guard, it pauses, last-run shows `⏸ paused · big delete (62%)` in WARN, and a non-dismissible Banner prompts manual confirm — the typed big-delete confirm modal is reused on click. Never auto-confirmed by a schedule.
- **Watch/scheduled distinction:** schedules and the future watch daemon are siblings on the Job. A schedule whose job also has `watch` enabled shows a small **WATCH** tag (`#39c5cf`, "watch") next to the recurrence summary, signaling "this job is also live-watched"; the row's countdown still reflects the cron timer. `StateDesync` outcomes always render **DANGER, not magenta** (refuse-to-act), consistent with the cheatsheet.

---

### (5) Key interactions & keyboard affordances

- **List:** `↑/↓` move row selection; `Enter` = Edit; `Space` = toggle Enabled; `R` = Run now (confirms if mode involves deletes); `V` = View runs; `Del` = Delete schedule (typed danger confirm); `N` = New schedule; `/` focuses a filter/search box (by job name).
- **Live countdown:** `next (in …)` ticks once/sec client-side; soonest schedule's chip mirrors it in the summary bar.
- **Editor:** mode radios reachable by arrow keys; raw-cron input debounced (~120ms) → re-renders "next 5" + validity dot; `Cmd/Ctrl+Enter` = Save (only when valid); `Esc` = Cancel; focus-visible ring (`0 0 0 2px base, 0 0 0 4px accent`) on every control.
- **Coming-soon affordance:** all destructive/exec actions remain interactive and persist config, but `Run now` and `Save` show a tooltip "Saved — scheduler runs in a future build"; the preview pill in the topbar is the global signal. Nothing is fake-disabled, so the IA is fully exercisable now.

---

### (6) Tauri commands & events

**Reused (existing):**
- `validate_job` — called in the editor (per pair of the bound job) to surface unreachable roots before a schedule can be saved/armed; drives the Job-field validity strip.
- `get_baseline_status` — shown per job/pair so a schedule warns when a pair is `FirstSync` (union-only, no deletes) or `Corrupt` (`WARN`) before its first unattended run.
- `preview_sync` — used by **Run now** preview and by the "what would this run do" hover, and by the future scheduler to build the plan.
- `execute_sync` — backs **Run now** today; the future scheduler invokes the same path per enabled pair.
- `cancel_sync` — the inline Cancel on an in-progress scheduled/Run-now row.
- `import_ffs` — not called here, but FFS-imported jobs (one Job→N pairs) appear as schedulable jobs in the editor's Job picker.

**NEW commands needed (P1, design the surface now):**
- `list_schedules() -> Schedule[]` — id, jobId, cron, enabled, onConflict, ifMissed, skipOverlap, timezone, lastRun{ts,status,report-summary}, nextRun.
- `upsert_schedule(Schedule) -> Schedule` — create/edit; server validates cron + that jobId exists.
- `delete_schedule(scheduleId)`.
- `set_schedule_enabled(scheduleId, bool)` — the row toggle (cheap path, no full upsert).
- `validate_cron(expr, timezone) -> { valid, error?, next: ts[5] }` — powers the raw-cron validity dot and "next 5 fires" preview without round-tripping a save.
- `run_schedule_now(scheduleId) -> runId` — convenience that resolves the job's enabled pairs → `preview_sync`/`execute_sync` per pair under the schedule's on-conflict policy.

**NEW events (emit):**
- `schedule:tick` (or client-side timer) — keeps countdowns honest after sleep/wake skew.
- `schedule:fired { scheduleId, runId }`, `schedule:run-progress { runId, pairId, done, total, path }`, `schedule:run-finished { scheduleId, runId, report }` — drive the live dot, inset progress, and `last` outcome cell.
- `schedule:conflicts-held { scheduleId, runId, count }` — raises the persistent held-conflicts Banner and the magenta count, linking into Conflict Resolution.

**Data note:** `Schedule` attaches at the **Job** level (`Job.schedule`, per the data model) and operates over all enabled pairs; persisted in `jobs.json`. Per-run results write an `ApplyReport` per `(job,pair,run)` that the **Activity** section reads, so `View runs` is a deep-link, not a separate store.

---

I have enough grounding from `model.rs` (ItemStatus, ItemOutcome, ApplyReport, Action, ConflictType, BaselineStatusKind) and `lib.rs` (command surface, `sync://progress` event). I'll write the Activity screen design now.

## Activity / Log & History

**(1) Purpose.** A unified, reverse-chronological timeline of every sync run across all jobs and pairs — each run's result (done / failed / skipped / conflicts, bytes moved), expandable to its per-file `ItemOutcome` rows, with errors and safety events (scan-error delete-suppression, big-delete guard, baseline corrupt, StateDesync) surfaced as first-class warnings, and a forward path to per-run versioning/undo. Filterable by job, pair, date, and result.

---

**(2) Mockup** (full shell, 232px sidebar + 44px topbar; realistic density, row-h 30):

```
┌──────────────┬──────────────────────────────────────────────────────────────────────────────────────┐
│ ⚡ fast-file  │  Activity                                  [⟳ Live]   [Export ▾]   [Clear history…]     │  ← topbar 44, drag region
│              ├──────────────────────────────────────────────────────────────────────────────────────┤
│  Jobs        │  Job:[ All jobs ▾]  Pair:[ All ▾]  Result:[ All ▾]  When:[ Last 7 days ▾]   ⌕ filter…  │  ← filter bar h30
│  Schedules   ├──────────────────────────────────────────────────────────────────────────────────────┤
│  Activity ▌  │  ▸ ◉ Photos backup · Drive→NAS         RUNNING   1,204/3,318 · 84.2 MB/s   [Cancel]    │  ← live: ring+pulse dot
│  Cloud/Dev   │     ⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿░░░░░░░░░  copying  D:/photos/2026/03/IMG_0421.CR3            │     inset track, accent fill
│  Settings    │  ──────────────────────────────────────────────────────────────────────────────────── │
│              │  TODAY                                                                                   │  ← xs UPPER muted date sep
│              │  ▸ ● Work docs · Laptop↔Server        done      14:32  ·  +18 ~3 −2 · 42.1 MB · 1.8s    │  ← green dot · summary chips
│              │  ▾ ⚠ Music sync · Mac→Drive           done*     13:05  ·  +6 ~0 −0 · 12.0 MB · warns 1  │  ← warn: delete-suppressed
│              │     ┌──────────────────────────────────────────────────────────────────────────────┐  │
│              │     │ ⚠ Deletions SUPPRESSED — right root scan hit 3 read errors; 41 deletes held.  │  │  ← WARN banner (in-row)
│              │     │   path mono                                        action      size            │  │
│              │     │ + Albums/2026/Coachella/track-07.flac             copy A→B     28.4 MB   done   │  │  ← per-file ItemOutcome
│              │     │ ~ Albums/Live/setlist.txt                         copy A→B      1.2 KB   done   │  │
│              │     │ − Albums/_trash/old.flac                          delete B      —        held   │  │  ← suppressed (neutral)
│              │     │ ✕ Albums/Live/dj-set.aiff                         copy A→B     —         failed │  │  ← DANGER row, err below
│              │     │     └ os error 32: file in use by another process                              │  │
│              │     └──────────────────────────────────────────────────────────────────────────────┘  │
│              │  ▸ ✕ Photos backup · Drive→NAS         failed    09:11  ·  3 of 211 failed · 1.1 GB     │  ← DANGER dot
│              │  ▸ ⬤ Code mirror · repo↔backup         conflict  08:40  ·  2 conflicts unresolved      │  ← CONFLICT (magenta) dot
│              │  YESTERDAY                                                                              │
│              │  ▸ ● Work docs · Laptop↔Server         done      18:20  ·  ·in sync· · 0 B · 0.4s       │  ← noop run, neutral chips
│              │  ▸ ⊘ Photos backup · Drive→NAS         skipped   06:00  ·  scheduled · big-delete guard │  ← WATCH/sched origin tag
│ ───────────  │  JUN 23                                                                                 │
│ ◉ engine ok  │  ▸ ● Work docs · Laptop↔Server        done      14:32  ·  +2 ~1 −0 · 0.9 MB · 0.3s     │  ← sidebar footer = engine
└──────────────┴──────────────────────────────────────────────────────────────────────────────────────┘
```

Row anatomy (collapsed): `[disclosure ▸][status-dot 8px][job · pair name][result badge][time][summary chips: +created ~modified −deleted · bytes · duration | warns N]`. Origin tag (`scheduled`/`watch`/`manual`) shown when not manual. Expanded: optional safety banner, then a virtualized per-file table `[glyph][path mono 1fr][action badge 96][size mono R][status R]` with failed rows showing the error string indented beneath.

---

**(3) Layout / components** (design-system mapping):

- **Shell**: standard `[sidebar][topbar/content]` grid. Sidebar `Activity` item = `bg-active + 2px accent bar`. Footer = engine status dot.
- **Topbar (h44, drag region)**: title `h2`; right-aligned controls — `[⟳ Live]` ghost toggle (ring+pulse when streaming), `Export ▾` ghost (CSV/NDJSON), `Clear history…` danger-ghost (opens typed-confirm modal).
- **Filter bar (h30)**: four `surface-2` selects (Job, Pair, Result, When) + a mono `⌕ filter…` text input matching path/job substrings. Pair select is disabled/auto-narrowed when a single Job is chosen.
- **Date separators**: `xs UPPER muted` sticky headers (`TODAY` / `YESTERDAY` / `MMM DD`).
- **Run row (h30, virtualized)**: status-dot (solid 8px; live = ring+pulse), name in sans + `· pair` in muted, **result badge** = filled `<meaning>-bg/fg` xs 600 no border:
  - `done` → OK green; `done*`/`done + warns` → WARN amber (`db61a2`? no — amber `d4a017`); `failed` → DANGER red; `conflict` → CONFLICT magenta; `skipped`/`noop` → NEUTRAL.
  - **Summary chips** = pills colored to meaning: `+N` OK, `~N` WARN, `−N` DELETE, bytes/duration NEUTRAL mono, `warns N` WARN, `conflicts N` CONFLICT.
- **Safety banner (in expanded row)**: non-dismissible `Banner` styled to the event meaning — delete-suppression & big-delete guard = WARN; StateDesync & failed = DANGER; baseline Corrupt = WARN; FirstSync = WATCH. This is the "SAFETY is visible" surface, reused from the Compare workspace banners.
- **Per-file table**: glyphs per ChangeKind (`+ ~ − ⇄ ·`); **action badge** (CopyAtoB/BtoA blue, DeleteA/B orange, Conflict magenta outlined sub-tag for ConflictType); status column maps `ItemStatus` → `Done`(green) / `Skipped`(neutral) / `held`(neutral, suppressed) / `Failed`(red). Mono for path/size; failed rows expand a red error line (`ItemOutcome.error`).
- **Live run block**: pinned to top above date list; `Progress` inset track + accent fill + mono current path + `Cancel` button (`cancel_sync`).
- **Right detail drawer (optional, on row activation)**: `surface-3` panel with full run metadata (config snapshot, baseline status at run time, roots mono, full `ApplyReport`, and a disabled **`Undo this run`** button + `Versioning: coming soon` chip — the P1/versioning attach point).

---

**(4) States:**

- **Empty (no history)**: centered empty state — muted clock glyph, "No sync runs yet", subtext "Runs you preview and execute will appear here", `[Go to Jobs]` primary. (First-run variant of the global empty-state pattern.)
- **Empty (filtered)**: "No runs match these filters" + `[Clear filters]` ghost; keeps filter bar populated.
- **Loading**: filter bar live; list area shows 6–8 skeleton run rows (shimmer at `surface-2`) — no spinner blocking the shell.
- **Populated**: date-grouped virtualized list as mocked; collapsed by default; last run per job optionally pinned.
- **In-progress (live)**: top live block with ring+pulse dot, `RUNNING` badge (accent), progress track, mono current path, `Cancel`. Driven by the `sync://progress` stream; on completion it animates (90–140ms) into a normal completed row and a success **Toast** (bottom-right) fires.
- **Error**: run row DANGER dot + `failed` red badge; summary `M of N failed`; expand shows failed `ItemOutcome` rows with red error lines. If the whole run aborted (validate/scan failure), banner = DANGER with the `SyncError` message and a `[Retry]` ghost (re-runs `preview_sync`/`execute_sync`).
- **Conflict**: run row CONFLICT magenta dot + `conflict` badge + `N conflicts unresolved` chip; magenta left-stripe + tint on the row; per-file conflict rows carry the outlined `ConflictType` sub-tag; row action `[Resolve →]` deep-links to the Conflict Resolution screen for that job/pair (never auto-applied).
- **Watch / scheduled variant**: origin tag chip (`scheduled` / `watch` in WATCH teal) replaces `manual`; a watch-triggered debounced burst can collapse into a single grouped row `Music sync · watch · 7 runs · last 14:59` that expands into its constituent runs. Skipped-by-guard scheduled runs render NEUTRAL with the guard reason inline (as mocked).

---

**(5) Interactions & keyboard:**

- `Enter` / click on a run row → toggle expand; `→` expand, `←` collapse; `↑/↓` move selection; `Shift+→` expand all in date group.
- `Space` / `O` → open right detail drawer for selected run; `Esc` closes drawer / clears filter focus.
- `/` focuses the `⌕ filter…` input; `g` then `j` jumps to Jobs (vim-style global nav, consistent with other screens).
- `C` on a live run → Cancel (`cancel_sync`), with focus-visible confirm.
- `R` on a failed/conflict run → Retry / Resolve respectively.
- `E` → Export; `L` → toggle Live follow.
- `:focus-visible` ring on every interactive element (`0 0 0 2px base, 0 0 0 4px accent`). Sticky date headers remain visible while scrolling the virtualized list.
- Clicking a job/pair name filters the list to it (sets the Job/Pair selects).

---

**(6) Tauri commands & events:**

*Reused (existing):*
- `cancel_sync` — Cancel button on the live run block.
- listens to the existing **`sync://progress`** event to render the in-progress block (job id, current path, copied/total, throughput).
- `execute_sync` / `preview_sync` — invoked by Retry / Resolve deep-links (they live on the Job Detail screen but Activity initiates re-runs through them).
- `get_baseline_status` — to label a run's baseline state (Present/FirstSync/Corrupt) in the detail drawer.

*New commands needed (history is not yet persisted — `ApplyReport` is currently returned and dropped):*
- `list_runs(filter: { job_id?, pair_id?, result?, since?, until?, query?, limit, cursor }) -> RunPage` — paginated, reverse-chronological run summaries.
- `get_run(run_id) -> RunDetail` — full `ApplyReport` + `outcomes: Vec<ItemOutcome>` + config snapshot + roots + baseline status + origin + warnings; backs row-expansion and the drawer.
- `clear_history(before?: timestamp, job_id?) -> usize` — backs `Clear history…` (typed-confirm modal).
- `export_runs(filter, format: Csv | Ndjson) -> path` (or stream to a `tauri_plugin_dialog` save path) — backs `Export ▾`.
- `get_activity_stats(filter) -> { total_bytes, runs, failed, conflicts }` — optional, for header counts.

*New events needed (to keep the timeline live without polling):*
- **`activity://run-started`** `{ run_id, job_id, pair_id, origin }` — insert/replace the top live block.
- **`activity://run-finished`** `{ run_id, ApplyReport }` — collapse live block into a completed row + fire success/failure toast.
- (scheduler/watch, P1) **`activity://run-queued`** — show scheduled/queued rows before execution begins.

*Persistence requirement this implies (engine side):* `execute_sync` must write each completed `ApplyReport` (plus job/pair ids, origin, timestamps, baseline status, warnings) to a `runs` log under app-data (e.g. `jobs/<pairId>/runs/<ts>.json` or an append-only `activity.ndjson`), and emit the two `activity://` events — without which this screen has no data source. This is the single new backend dependency; everything else reuses the tested engine path.

---

I have enough grounding. The data model defines `RemoteRef { kind: Local|S3|SMB|Peer, accountId }`, `remote` on Job, `remoteOverride` on FolderPair, behind a `RemoteFs` trait at scan/fsops. Now I'll write the Cloud/Devices screen design.

## Cloud / Devices

**Purpose:** A single place to connect remote backends (S3 / remote NAS / peer devices) and sign into accounts, see per-endpoint health, and let any folder pair target a remote root instead of a local path — the daemon/scheduling/remote pillar's home, honest about what ships today vs. later.

---

### Mockup — populated (within the shell)

```
┌────────────┬───────────────────────────────────────────────────────────────────────────────────┐
│ ≡ fast-file-sync          ⟂ drag region (topbar 44)                                  ⌕  ⚙  ◷    │
├────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│            │  CLOUD / DEVICES                                            [ + Connect endpoint ▾] │
│  ▸ Jobs    │  ┌─ PREVIEW ──────────────────────────────────────────────────────────────────┐   │
│  ▸ Schedules│ │ ⚠ Remote backends are in preview. Local sync is fully supported today;       │   │
│  ▸ Activity│  │   S3 / NAS / peer endpoints are read-write-tested but unversioned.  Learn ↗  │   │
│ ▶ Cloud/Dev│  └─────────────────────────────────────────────────────────────────────────────┘   │
│  ▸ Settings│                                                                                      │
│            │  ENDPOINTS                                                  filter: [all ▾] ⌕ ____   │
│            │  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│            │  │ ● S3   media-backup            s3://acme-media/                       2 pairs  │  │
│            │  │   ok · us-east-1 · acct "frederic@…" · 14ms · last ok 2m ago         [⋯]      │  │
│            │  ├──────────────────────────────────────────────────────────────────────────────┤  │
│            │  │ ● SMB  nas-attic               smb://192.168.1.12/attic               1 pair   │  │
│            │  │   ok · mounted · 0.9ms · last ok 11s ago                             [⋯]      │  │
│            │  ├──────────────────────────────────────────────────────────────────────────────┤  │
│            │  │ ◐ Peer laptop-13              peer:8f3a…c1 (LAN)                       0 pairs  │  │
│            │  │   connecting · last seen 4m ago · relay fallback                     [⋯]      │  │
│            │  ├──────────────────────────────────────────────────────────────────────────────┤  │
│            │  │ ● S3   glacier-archive         s3://acme-cold/                         1 pair   │  │
│            │  │   ⚠ auth expires in 3d · eu-central-1 · 22ms                  [Re-auth] [⋯]   │  │
│            │  ├──────────────────────────────────────────────────────────────────────────────┤  │
│            │  │ ● Peer desktop-tower          peer:1a90…ff (relay)                     1 pair   │  │
│            │  │   ✗ unreachable · last ok 2h ago · 3 retries                 [Retry]  [⋯]    │  │
│            │  └──────────────────────────────────────────────────────────────────────────────┘  │
│            │                                                                                      │
│            │  ACCOUNTS                                                          [ + Add account ] │
│            │  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│            │  │ ● AWS   frederic@acme        signed in · 1 endpoint · key …J4F7    [Sign out] │  │
│            │  │ ◌ Peer  this device          id peer:8f3a…c1 · pairing code: 4471-22  [Copy]  │  │
│            │  └──────────────────────────────────────────────────────────────────────────────┘  │
│            ├──────────────────────────────────────────────────────────────────────────────────┤  │
│ ● engine   │  4 endpoints · 1 connecting · 1 unreachable · daemon: off          last poll 11s    │
└────────────┴───────────────────────────────────────────────────────────────────────────────────┘
```

### Mockup — "target a remote in a folder pair" (Job Editor pair-root affordance, shown here for cross-nav)

```
PAIR 2                                                          [filter override ▾]  [✕ remove]
  Left   ○local ◉remote  [ s3://acme-media/  ▾ media-backup ]  /photos/2026          ●  Browse…
  Right  ◉local ○remote  [ E:\Photos\2026                  ]                          ●  Browse…
         ⓘ endpoint resolves at run time via RemoteFs; baseline stored locally under jobs/<pairId>/
```

---

### Layout / components breakdown

- **Page header:** `h2` "CLOUD / DEVICES" + primary **Button** `[+ Connect endpoint ▾]` (split menu: S3 · SMB/NAS · Peer device). Right-aligned, h30.
- **Preview banner (never-dismissible):** `Banner` component, WARN tokens (`#d4a017` fg / `#2e2408` bg / `#574516` border). This is the honest coming-soon/preview surface — it states the support level instead of hiding the section. Persistent like the baseline/StateDesync banners.
- **ENDPOINTS section:** `xs` UPPER muted header + inline `filter:[all▾]` select + search input (h30, surface-2). The list is a `surface` card of compact **endpoint rows** (row-h 30, two-line: identity line + meta line, mono for URIs/IDs/latency):
  - `[status dot 8px]` + `kind chip` (NEUTRAL pill: S3 / SMB / Peer) + **name** (sans) + **URI** (mono, muted) + **"N pairs"** count chip (right) + `[⋯]` icon Button.
  - Meta line `sm muted`: health verb + region/mount + account + latency (mono) + relative "last ok". Inline action Button appears only when actionable (`[Re-auth]`, `[Retry]`).
  - Status dot maps to MEANING tokens: ok→OK green `#3fb950`; connecting→WATCH cyan `#39c5cf` with pulse ring (`◐`); auth-expiring→WARN amber; unreachable→DANGER red `#f85149` (`✗`).
- **ACCOUNTS section:** `xs` UPPER header + `[+ Add account]` ghost Button. Rows: provider chip + account label + `signed in`/`id` + endpoint count + mono key/peer-id fragment + `[Sign out]`/`[Copy]`. "This device" peer identity always present (own pairing code).
- **Sidebar footer (engine status):** aggregate health counts + `daemon: off` (WATCH-future) + `last poll`. Reuses the existing footer slot.
- **Remote-target affordance (in Job Editor pair):** each pair root gets a `○local ◉remote` segmented toggle. Remote mode swaps the mono path input for an **endpoint select** (lists connected endpoints) + a mono subpath field. A trailing **validity dot** mirrors `validate_job`. Mirrors the design-system "path inputs mono + validity dot" rule; the endpoint select replaces the Browse(Tauri dialog) Browse with a remote browser.

---

### States

- **Empty (no endpoints, no accounts):** centered empty state inside the card — green-tinted aspirational, not error. Headline "No remote endpoints yet" + one paragraph stating the vision (S3 backups, NAS, encrypted peer-to-peer device sync, all respecting `.gitignore`). Two Buttons: primary `[Connect endpoint]`, ghost `[Add account]`. Below: a **Coming-soon checklist** rendered as muted mono rows with WATCH-cyan glyphs — `◷ real-time watch daemon`, `◷ scheduled remote runs`, `◷ multi-device mesh` — each tagged `planned`. Honest: it shows the roadmap rather than a fake "0".
  ```
  ┌──────────────────────────────────────────────────────────┐
  │                        ☁  (cyan)                          │
  │              No remote endpoints yet                      │
  │   Back up to S3, sync a NAS, or pair another device.      │
  │   Every transfer honors your .gitignore — like local.     │
  │                                                           │
  │        [ Connect endpoint ]      [ Add account ]          │
  │                                                           │
  │   ROADMAP                                                 │
  │   ◷ real-time watch daemon ……………………………… planned          │
  │   ◷ scheduled remote runs ……………………………… planned          │
  │   ◷ encrypted multi-device mesh ……………… planned          │
  └──────────────────────────────────────────────────────────┘
  ```
- **Loading (initial probe / refresh):** rows render as **skeleton** shimmer at fixed row-h 30 (mono-width placeholders for URI/latency); status dots are NEUTRAL hollow `◌`; footer shows `polling…` with the live ring on the engine dot. No layout shift.
- **Populated:** as in the main mockup. Counts in footer colored to meaning.
- **In-progress (active remote transfer):** an endpoint with a running pair shows a WATCH-cyan **live dot (ring+pulse)** and an inline **Progress** strip under its row: inset track + accent fill + mono current path + throughput (mono, e.g. `4.2 MB/s`) + `[Cancel]` Button → `cancel_sync`. Multiple concurrent pairs stack their strips. The `[⋯]` menu disables destructive items mid-run.
- **Error (unreachable / mount lost / network):** DANGER row — red dot `✗`, red left-stripe tint (`#2a0e0e`), meta line states cause + retry count, inline `[Retry]` Button. Aggregate surfaces a non-dismissible **Banner** only if an *enabled, scheduled/watched* pair targets the dead endpoint (safety-legible: a job can't silently run against a dead remote).
- **Auth error / expiring:** WARN row, `[Re-auth]` opens the account sign-in **Modal**. Expiry (`auth expires in 3d`) is amber and proactive; full expiry flips the row to DANGER.
- **Conflict (identity / desync):** if a peer presents a mismatched device identity or a remote baseline can't be trusted, the row uses **DANGER** styling (not magenta — mirrors `StateDesync` → refuse-to-act) with verb `identity mismatch — refusing to sync` and a `[Inspect]` action. Per the cheatsheet, desync is DANGER, and per-pair file conflicts still resolve in the Compare Workspace, never here.
- **Watch / scheduled variant:** an endpoint backing a watched job shows a small **WATCH chip** `⟳ watch` (cyan tokens) on the identity line; scheduled jobs show `◷ daily 02:00` (muted) and the footer's `daemon:` flips to `on (3 jobs)` with a live ring. These are render-only until the daemon ships (the IA reserves the slot now).

---

### Key interactions & keyboard affordances

- `↑/↓` move row selection; `Enter` opens endpoint detail panel; `Space` toggles the `[⋯]` menu.
- `c` Connect endpoint; `a` Add account; `r` Retry/refresh selected; `/` focuses the endpoints search; `Esc` closes any open Modal/menu.
- `:focus-visible` ring on every row/Button (0 0 0 2px base, 0 0 0 4px accent). Row `[⋯]` menu: Edit · Re-auth · Browse remote · Disconnect (danger, confirm Modal) · Copy URI.
- Connect-endpoint Modal (`surface-3`, lg) is a typed form: kind → connection fields (mono) → account picker → **Test connection** Button (runs a probe, shows latency + validity dot) before Save.
- Disconnecting an endpoint that backs N pairs opens a **danger confirm Modal** listing affected pairs (those pairs revert to disabled until re-pointed) — same legibility as the big-delete confirm.

---

### Tauri commands & events

**Reused (unchanged):**
- `validate_job` — when a pair targets a remote root, validation runs against the resolved remote config; the pair's validity dot reflects it.
- `preview_sync` / `execute_sync` / `cancel_sync` — a remote-backed pair compiles (per data model) to one `JobConfig` whose `root_a`/`root_b` resolve through `RemoteFs`; these commands work as-is. The Progress strip and `[Cancel]` reuse the existing `sync://progress` event + `cancel_sync`.
- `get_baseline_status` — baseline stays local at `jobs/<pairId>/baseline.json`; status banner per remote-backed pair is unchanged.
- `import_ffs` — unchanged here (FFS has no remote concept); imported jobs land local and can later be re-pointed to an endpoint.

**New commands needed (this screen owns them):**
- `list_endpoints() -> Vec<Endpoint>` — persisted endpoints + their `pairs` usage counts.
- `add_endpoint(spec: EndpointSpec) -> Endpoint` / `update_endpoint` / `remove_endpoint(id)` — CRUD; `remove` returns affected pair ids for the confirm Modal.
- `test_endpoint(spec | id) -> EndpointHealth { ok, latency_ms, region, error }` — the Modal's Test connection + row Retry.
- `probe_endpoints() -> Vec<EndpointHealth>` — periodic health poll feeding dots/footer.
- `list_accounts() -> Vec<Account>` / `add_account(provider) -> AuthFlow` / `reauth_account(id)` / `sign_out_account(id)` — sign-in/Re-auth Modal; OAuth/credential flows.
- `browse_remote(endpointId, subpath) -> Vec<RemoteEntry>` — the remote "Browse…" replacing the Tauri dialog for remote pair roots.
- `device_identity() -> { peerId, pairingCode }` and `pair_device(code) -> Endpoint` — peer "this device" card + peer pairing.

**New events needed:**
- `endpoint://status` — push per-endpoint health changes (ok ↔ connecting ↔ unreachable / auth-expiring) so dots and the footer update without polling once the daemon lands.
- `endpoint://transfer` — (future, mirrors `sync://progress`) per-endpoint active-transfer ticks for the in-progress strips when watch/daemon drives them.

All new types serialize like the existing model (string enums) so `tokens.ts`'s enum→color MEANING map extends to `EndpointKind`/`EndpointHealthKind` with no new color system.

**Relevant files (grounding):** `E:\Programming\projects\fast-file-sync\src-tauri\src\lib.rs`, `E:\Programming\projects\fast-file-sync\src-tauri\src\config.rs`, `E:\Programming\projects\fast-file-sync\src-tauri\src\model.rs`.

---

Now I have the grounding I need. Here is the Settings screen spec.

## Settings

**Purpose:** App-wide defaults and machine-local preferences that seed every new Job/pair and govern the engine, surfaced in one scrollable, sectioned panel where every control's reach (global default vs. machine-local) is legible and overridable per-job downstream.

---

### Mockup (within the persistent sidebar shell, ~1100×680)

```
┌──────────────┬──────────────────────────────────────────────────────────────────────────┐
│ fast-file-   │  Settings                                              ⌘, · unsaved ●      │ 44 topbar (drag)
│ sync     ⠿   ├──────────────────────────────────────────────────────────────────────────┤
│              │ ┌─────────────┐ ┌──────────────────────────────────────────────────────┐  │
│  Jobs        │ │ Appearance  │ │  APPEARANCE                                          │  │
│  Schedules   │ │ Sync default│ │  ───────────────────────────────────────────────    │  │
│  Activity    │ │ Deletion    │ │  Theme        ( Dark ▾ )   System · Dark · (Light¹)  │  │
│  Cloud/Dev   │ │ Performance │ │  Accent       ●blue ●green ●pink ●amber ●cyan        │  │
│  Settings ◀  │ │ Notifs      │ │  Density      ( Compact ▾ ) Compact·Cozy  row-h 30   │  │
│              │ │ Startup     │ │  Mono font    [ Cascadia Mono            ▾ ]  Aa 12.5 │  │
│              │ │ About       │ │                                                      │  │
│              │ └─────────────┘ ├──────────────────────────────────────────────────────┤  │
│              │  (sticky        │  SYNC DEFAULTS        seeds new jobs · per-job override│ │
│              │   sub-nav,      │  ───────────────────────────────────────────────    │  │
│              │   scroll-spy)   │  Default mode     ( Two-way ▾ ) TwoWay·Mirror·Update │  │
│              │                 │  Compare by       (•) Time + size   ( ) Content/hash │  │
│              │                 │  Verify by hash   [○──]  off   slower, catches silent│  │
│              │                 │                          same-size/mtime edits       │  │
│              │                 ├──────────────────────────────────────────────────────┤  │
│              │                 │  DELETION                          ⛨ SAFE DEFAULTS    │  │
│              │                 │  ───────────────────────────────────────────────    │  │
│              │                 │  Policy   ( Recycle bin ▾ )  Recycle·Versioning¹·Perm│  │
│              │                 │  ⚠ Permanent disables recovery. Recycle bin recommended│ │
│              │                 │  Big-delete guard                                    │  │
│              │                 │    trip at  [ 25 ]% of members  OR  [ 100 ] files    │  │
│              │                 │    ▓▓▓▓▓░░░░░░░░░░░░░░ whichever is smaller (=25 of 100)│ │
│              │                 ├──────────────────────────────────────────────────────┤  │
│              │                 │  PERFORMANCE                              machine-local│ │
│              │                 │  ───────────────────────────────────────────────    │  │
│              │                 │  Scan/copy threads [ Auto (16) ▾ ]  1 ───●──── 32    │  │
│              │                 │  Hashing          [○──] off  blake3 · 8 threads      │  │
│              │                 │  Buffer size      [ 1 MiB ▾ ]                         │  │
│              │                 ├──────────────────────────────────────────────────────┤  │
│              │                 │  NOTIFICATIONS                                       │  │
│              │                 │  ───────────────────────────────────────────────    │  │
│              │                 │  On completion    [●─]  OS toast                     │  │
│              │                 │  On conflict      [●─]  OS toast + badge   (always on)│ │
│              │                 │  On failure       [●─]  OS toast                     │  │
│              │                 │  On big-delete    [●─]  OS toast (never silent)       │ │
│              │                 ├──────────────────────────────────────────────────────┤  │
│              │                 │  STARTUP & TRAY                  watch daemon · P1    │  │
│              │                 │  ───────────────────────────────────────────────    │  │
│              │                 │  Launch at login  [○──] off                          │  │
│              │                 │  Run in tray      [○──] off   close → tray, keep watch│  │
│              │                 │  Watch debounce   [ 800 ] ms        (default for jobs)│  │
│              │                 │  ⓘ Watch/auto-sync arrives in a later release  ·grey  │  │
│              │                 ├──────────────────────────────────────────────────────┤  │
│              │                 │  ABOUT                                               │  │
│              │                 │  ───────────────────────────────────────────────    │  │
│              │                 │  fast-file-sync  0.4.1   engine 0.4.1  ·  Tauri 2    │  │
│              │                 │  blake3 1.5 · ignore 0.4   [Copy] [Release notes ↗]  │  │
│              │                 │  Safety guarantees ───────────────────────────────  │  │
│              │                 │   ✓ Conflicts never auto-applied — you resolve each  │  │
│              │                 │   ✓ Deletes are recoverable (recycle bin default)    │  │
│              │                 │   ✓ A scan read-error suppresses deletions that run  │  │
│              │                 │   ✓ Big-delete guard halts runaway deletions         │  │
│              │                 │   ✓ First sync / corrupt baseline = union, 0 deletes │  │
│              │                 │  [ Export settings ] [ Import ] [ Reset to defaults ]  │ │
│              │                 └──────────────────────────────────────────────────────┘  │
│  ● engine    │  ┌────────────────────────────────────────────────────────────────────┐  │
│    idle      │  │ Defaults changed. Existing jobs keep their settings.  [Discard][Save]│ │ sticky footer bar
└──────────────┴──┴────────────────────────────────────────────────────────────────────┴──┘
```
¹ items tagged `¹` (Light theme, Versioning policy) render as disabled "Coming soon" rows (NEUTRAL muted text + chip), keeping their home from day 1.

---

### Layout & component breakdown (design-system mapping)

- **Shell:** standard `[sidebar 232][topbar 44 / content]` grid; Settings sidebar item shows `active` = `bg-active` + 2px accent bar. Topbar is the drag region; right side shows `⌘,` hint and an `unsaved ●` dot (WARN dot when dirty, hidden when clean).
- **Two-column content:** a left **sticky sub-nav** card (`surface`, radius md) with scroll-spy section links; right is the scrollable settings column. Each section is a flat card (`surface`, 1px `border`, radius md) with an `xs UPPER muted` header (`APPEARANCE`, `SYNC DEFAULTS`, …) and a 1px `subtle` divider.
- **Reach tags** on section headers, right-aligned `xs muted`: `seeds new jobs · per-job override` (sync/deletion — these map to `JobSettings`/`IgnorePolicy` defaults), `machine-local` (performance, startup — not persisted into `jobs.json`). Makes inheritance legible.
- **Controls** are all `h30`:
  - Selects (Theme, Density, Mono font, Default mode, Deletion policy, Threads, Buffer) = `surface-2` dropdowns, radius sm.
  - Accent = a row of 8px solid swatch dots from the MEANING palette; selected gets focus ring.
  - Compare-by = radio pair (TimeSize/Content → `JobConfig.verify_by_hash` is the explicit toggle below).
  - Toggles (`verify_by_hash`, hashing, notifications, launch/tray) = pill switches; ON = accent track.
  - Big-delete = two mono number inputs (`%` → `big_delete_pct`, `files` → `big_delete_abs`) + an `inset` track bar visualizing "whichever is smaller".
- **Deletion section** carries an `⛨ SAFE DEFAULTS` OK-green chip; selecting `Permanent` flips it to a non-dismissible inline **WARN banner** (`#d4a017`), and `Versioning` is the disabled `¹` row.
- **About** = mono version block + a green-checked **Safety guarantees** list (the visible-trust requirement), `[Copy]`/`[Release notes ↗]` ghost buttons, and `[Export]/[Import]/[Reset]` ghost+danger buttons.
- **Sticky save bar** (footer of content, above engine status): appears only when dirty; `[Discard]` ghost + `[Save]` primary. Mono microcopy clarifies "existing jobs keep their settings."
- **Engine status** in sidebar footer (`● engine idle`) is shared chrome, not part of Settings.

---

### All states

- **Empty / first run:** no `settings.json` yet → every control shows its Rust-side default (gitignore on, recycle bin, TimeSize, verify off, 25% / 100, threads Auto). A one-time `ⓘ` note at top: "Showing built-in defaults." No dirty bar.
- **Loading:** brief skeleton — section headers render immediately, control rows are 30px `inset` shimmer bars. Sub-nav is interactive (scroll targets exist).
- **Populated (clean):** values from `load_settings`; `unsaved ●` hidden; save bar collapsed.
- **In-progress (saving):** `[Save]` shows spinner + disabled; controls remain readable but non-editable; on success → bottom-right **success toast** "Settings saved" and bar collapses. **Reset** and **Import** route through a `surface-3` confirm **modal** (destructive = typed/explicit for Reset).
- **Error:** `save_settings`/`import_settings` failure → non-dismissible **DANGER banner** under topbar: "Couldn't write settings.json — <reason>. Changes kept in memory. [Retry] [Reveal file]." Per-field validation errors (e.g. big-delete `%` out of 0–100, threads > cpu*4) show a DANGER L-stripe + inline mono message on that input; `[Save]` disabled while any field invalid.
- **Conflict (settings-file conflict):** if `settings.json` changed on disk since load (another window / external edit), Save surfaces a WARN banner: "Settings changed on disk. [Reload] [Overwrite]." This reuses the StateDesync "refuse to silently clobber" philosophy at the config layer.
- **Watch / scheduled variant:** the **Startup & Tray** section is the watch-daemon home. Until the daemon ships, `Run in tray` / `Launch at login` render disabled with a `WATCH`-colored "Coming soon" chip; `Watch debounce` is editable now (it just seeds `WatchConfig.debounceMs` defaults). When the daemon exists, a live `WATCH` status dot (ring+pulse) appears: "Watching 3 jobs · last event 12s ago," and toggling tray off while jobs are watching raises a WARN confirm ("Watching stops when the app fully quits").

---

### Key interactions & keyboard affordances

- `⌘,` / `Ctrl+,` opens Settings from anywhere; `Esc` with a dirty state focuses the save bar (does not discard).
- `⌘S` / `Ctrl+S` = Save (only when dirty & valid); `⌘Z` reverts the last changed field while unsaved.
- `Tab` order follows visual top-to-bottom; every `:focus-visible` shows the 2px base + 4px accent ring. Toggles operate on `Space`/`Enter`; selects open on `Enter`/`↓`.
- Sub-nav links jump-scroll (smooth, ≤140ms) and update scroll-spy active state; `↑/↓` within the sub-nav moves sections.
- Number inputs accept `↑/↓` step (`%` by 5, files by 10) and reject non-numeric; the big-delete track updates live.
- Theme/accent/density apply **optimistically/live** (instant preview) but still require Save to persist — the dirty bar reflects this so a live preview is never mistaken for a saved choice.
- Hovering a "Coming soon" row shows a tooltip naming the release phase (P1/P3).

---

### Tauri commands & events

**Reused:** none of the sync commands fire from Settings directly. `validate_job` is *seeded* by these defaults (the editor inherits them) but is not invoked here. (`preview_sync`, `execute_sync`, `cancel_sync`, `get_baseline_status`, `import_ffs` are unrelated to this screen.)

**New commands needed:**
- `load_settings() -> AppSettings` — returns the global settings struct (appearance, sync/deletion/perf defaults, notifications, startup/tray, watch debounce). Missing file → struct of Rust-side defaults from `config.rs`.
- `save_settings(settings: AppSettings) -> Result<(), String>` — atomic temp+rename write of `settings.json` in app-data (mirrors the engine's atomic-write discipline); returns the on-disk mtime/version for conflict detection.
- `reset_settings() -> AppSettings` — restore built-in defaults and persist.
- `export_settings(path) -> Result<()>` / `import_settings(path) -> Result<AppSettings, String>` — JSON round-trip via Tauri file dialog; import is validated before apply.
- `get_app_info() -> AppInfo` — app/engine/Tauri/blake3/ignore-crate versions + build hash for the About block (avoids hardcoding versions in the frontend).
- `set_launch_at_login(enabled: bool) -> Result<()>` — OS-level autostart registration (P1; stubbed/disabled until watch ships).
- `reveal_path(path)` — open the OS file manager at `settings.json` (used by the error banner's `[Reveal file]`).

**New events:**
- `settings-changed` — emitted after a successful save so other open windows/sections (e.g. a Job Editor showing inherited defaults) refresh.
- `settings-file-conflict` — emitted by a settings-file watcher when `settings.json` mtime changes externally, driving the conflict banner.

**Shapes:** `AppSettings` persists the appearance block + `JobSettings`-shaped defaults (`mode`, `compare`, `filter`, `deletePolicy`, `bigDeletePct`, `bigDeleteAbs`) that the Job Editor reads as seed values, plus machine-local `performance`, `notifications`, and `startup` blocks (the latter not exported, since they're device-specific).

---

I have everything needed. Here is the screen specification.

## Import from FreeFileSync

**Purpose:** A guided, trustworthy migration wizard that turns a single `.ffs_batch`/`.ffs_gui` file into one real fast-file-sync Job with N folder pairs — surfacing every translated filter, review note, and one-way→two-way safety implication before anything is persisted.

---

### (2) Mockup — within the sidebar shell (1280×800, dense)

```
┌──────────────┬──────────────────────────────────────────────────────────────────────────────┐
│ fast-file-   │  Import from FreeFileSync                          [ Cancel ]  [ Create Job → ] │ topbar 44 (drag)
│   sync   ▷   ├──────────────────────────────────────────────────────────────────────────────┤
│              │  ┌─ SOURCE ──────────────────────────────────────────────────────────────────┐ │
│  Jobs        │  │ ● NASSyncSettings.ffs_batch                                                 │ │
│  Schedules   │  │ E:\MyDocuments\NASSyncSettings.ffs_batch   BATCH·XmlFormat 23   [ Choose…  ] │ │ mono path
│ ▸Activity    │  └────────────────────────────────────────────────────────────────────────────┘ │
│  Cloud/Dev   │                                                                                  │
│  Settings    │  ┌─ NEW JOB ─────────────────────────────────────────────────────────────────┐ │
│              │  │ Name  [ NASSyncSettings ............................ ]   3 pairs · 1 mirror │ │
│  ────────    │  │ SHARED  compare TimeAndSize ▾   delete RecycleBin ▾   ☑ Respect .gitignore  │ │
│              │  └────────────────────────────────────────────────────────────────────────────┘ │
│              │                                                                                  │
│  ▒ IMPORT    │  ⚠ gitignore assist · 6 of 8 excludes (node_modules, .git, build, __pycache__…)  │ banner WARN
│              │     are usually covered by .gitignore. Drop them? [ Drop redundant (6) ] [ Keep ]│ (not dismissible)
│              │                                                                                  │
│              │  ┌─ FOLDER PAIRS (3) ─────────────────────────────────── [ Show in-sync ⌄ ] ──┐ │
│              │  │ ☑ ● Screenshots                          two-way ↔     8 excl   network ⚠   │ │ row-h 30
│              │  │     C:\Users\mail\Documents\ShareX\Screenshots                              │ │ mono
│              │  │     ↔  \\NAS\home\Screenshots                                               │ │
│              │  │ ──────────────────────────────────────────────────────────────────────────│ │
│              │  │ ☑ ● MyDocuments                          two-way ↔     8 excl   network ⚠   │ │
│              │  │     E:\MyDocuments   ↔   \\NAS\home\MyDocuments                             │ │
│              │  │ ──────────────────────────────────────────────────────────────────────────│ │
│              │  │ ┃☑ ● Programming           [mirror →] [two-way ↔]    9 excl   network ⚠   ▾│ │ magenta L-stripe
│              │  │ ┃    E:\Programming   →   \\NAS\home\Programming                            │ │ (review)
│              │  │ ┃   ┌ REVIEW ─────────────────────────────────────────────────────────────┐│ │
│              │  │ ┃   │ ⚠ FFS had this as a one-way mirror (left → right). Two-way would also  ││ │
│              │  │ ┃   │   propagate deletions back from the right. Keep as Mirror, or switch. ││ │
│              │  │ ┃   │ FILTER (override) · inherits job + 1 local           [ Edit globs ⌄ ] ││ │
│              │  │ ┃   │   node_modules/         .git/            __pycache__/   *.gdoc         ││ │ mono globs
│              │  │ ┃   │   /System Volume Information/            *desktop.ini   /bin/          ││ │
│              │  │ ┃   │   .ruff_cache        ← local (pair filter)                             ││ │
│              │  │ ┃   └──────────────────────────────────────────────────────────────────────┘│ │
│              │  └────────────────────────────────────────────────────────────────────────────┘ │
│              │                                                                                  │
│              │  REVIEW NOTES (2)                                                                 │
│              │   ~ Review imported exclude: '*.venv |'  →  '*.venv'                              │ mono, WARN ~
│              │   ⇄ Trailing '\*' (contents-of) has no exact gitignore equal — verify '/bin/*'    │
├──────────────┤                                                                                  │
│ ◉ engine idle│  ☑ Run preview after creating (no changes are written)                            │
└──────────────┴──────────────────────────────────────────────────────────────────────────────┘
```

---

### (3) Layout & components breakdown

- **Shell:** standard `[sidebar 232][topbar 44 / content]` grid. Sidebar `IMPORT` is a transient highlighted entry under Jobs (active = `bg-active` + 2px accent bar); it is a sub-route of Jobs, not a permanent section. Topbar carries title + the primary actions (`Cancel` ghost, `Create Job →` **primary** accent, disabled until ≥1 pair is enabled and Source is valid).
- **SOURCE card** (`surface`, radius md): status dot + filename (sans) + full path (**mono 12.5**) + parsed badges (`BATCH`/`GUI`, `XmlFormat N`) as NEUTRAL pills + `Choose…` (default button h30, opens Tauri file dialog).
- **NEW JOB card:** Name input (h30, `surface-2`) + a right-aligned summary line `N pairs · M mirror`. SHARED row = the inheritable `JobSettings`: `compare` select (TimeAndSize→`TimeSize`/Content→`verify_by_hash`), `delete` select (`RecycleBin`/Versioning/Permanent), and the unique `☑ Respect .gitignore` toggle (★ the differentiator) feeding `IgnorePolicy.use_gitignore`.
- **gitignore-assist Banner** (WARN `#d4a017`, never a toast — it's a safety/quality decision): only shown when any pair returns `gitignore_hint`. Inline actions `Drop redundant (n)` / `Keep`.
- **FOLDER PAIRS list** (virtualized, `surface`): each pair = a compare-style row → `[☑ enable][status-dot ●][name][mode badge: two-way ↔ / mirror →][N excl mono][network ⚠ if UNC][expand ▾]` with the two roots on a mono sub-line joined by the resolved direction glyph (`↔`/`→`). Pairs needing review carry a **magenta L-stripe + tint** (matches Conflict treatment). `Show in-sync ⌄` header toggle is a no-op placeholder here (kept for cross-screen consistency with the Compare workspace) and is disabled during import.
- **Mode toggle:** the segmented `[mirror →][two-way ↔]` control sets `FolderPair.modeOverride` (`Mirror` vs `TwoWay`). Default selection mirrors `ImportedJob.two_way`.
- **REVIEW (expanded pair):** WARN callout for the one-way warning; a filter editor showing the translated `exclude_globs` as a **mono glob list** (`!`-prefixed lines render OK-green), with `← local` annotations distinguishing pair-level globs from inherited job globs; per-pair filter override shown as an **indented side-bar** block. UNC `network ⚠` warnings render as WARN sub-tags.
- **REVIEW NOTES** (file-level `FfsImport.notes`): mono lines, `~` (WARN, ambiguous) and `⇄` (TypeChanged-style, no clean mapping) glyphs from the cheatsheet.
- **Footer strip:** `☑ Run preview after creating` (post-create `preview_sync` per pair, writes nothing) + engine-status dot in the sidebar footer.

---

### (4) All states

- **Empty (initial):** only SOURCE card with a large `Choose .ffs_batch / .ffs_gui…` drop-zone (dashed `border-subtle`, mono helper `Drag a FreeFileSync config here`). NEW JOB / pairs / notes hidden. `Create Job →` disabled. Matches the global empty-state language ("No jobs → New / Import FFS").
- **Loading (parsing):** Source card shows the path with a pulsing `●` ring + mono `parsing…`; skeleton rows (3) in the PAIRS card. Brief — `import_ffs` is synchronous file read + parse.
- **Populated:** the mockup above. All cards present, `Create Job →` enabled.
- **In-progress (creating):** on `Create Job →`, the topbar button becomes `Creating…` with inset progress track; if `Run preview` is on, an inset progress bar per pair shows `preview_sync` running with mono current path + `Cancel` (calls `cancel_sync`). Sidebar engine dot → live ring+pulse.
- **Error (parse/IO):** if `import_ffs` returns `SyncError` (not valid XML / not a FreeFileSync config / no folder pairs / IO), SOURCE card flips to a DANGER banner (`#f85149`): `Couldn't read this config — <message>` with `Choose another…`. Non-dismissible (safety = legible). Rest of screen stays empty.
- **Conflict / review variant:** pairs with `!two_way`, UNC paths, or `warnings`/`notes` carry the magenta review stripe and force-expand the first such pair. `Create Job →` stays enabled but shows a NEUTRAL count `2 pairs need review` next to it; nothing is auto-resolved — the user must consciously pick Mirror vs two-way (conflicts are never auto-applied).
- **Post-create success:** route to the new **Job Detail / Compare Workspace**; bottom-right success toast `Imported "NASSyncSettings" — 3 pairs`. If `Run preview` was on, the Compare workspace is already populated from the `preview_sync` results.
- **Watch / Scheduled variant:** import never creates a watcher or schedule (those attach at JOB level, P1). A NEUTRAL footer hint reads `Schedule & Watch can be added after import (Job → Schedules)`, keeping IA consistent without promising P1 behavior. If the source FFS config used `RunMinimized`/auto-run batch semantics, a single note surfaces: `This was a FreeFileSync batch — set up Watch/Schedule on the new job to reproduce auto-run.`

---

### (5) Interactions & keyboard affordances

- `Ctrl/⌘+O` → Choose file. Drag-and-drop a `.ffs_batch`/`.ffs_gui` onto the SOURCE zone parses it.
- `Space` toggles the focused pair's enable checkbox; `Enter`/`→`/`←` expands/collapses the focused pair; `↑/↓` move row focus (roving tabindex over the virtualized list).
- `m` while a pair row is focused toggles its mode (Mirror ↔ two-way); the segmented control is also a 2-option arrow-key group.
- `Enter` from the Name field, or `Ctrl/⌘+Enter` anywhere → `Create Job →`. `Esc` → Cancel (with a confirm only if edits were made).
- `g` applies the gitignore-assist banner's `Drop redundant`; banner is keyboard-reachable, not auto-applied.
- Focus rings: `:focus-visible` → `0 0 0 2px base, 0 0 0 4px accent` on every control. Motion 90–140ms on expand/collapse.
- All path/glob fields are read-only-mono by default; `Edit globs` makes the list an editable mono textarea (gitignore syntax, line numbers, `!` re-include rendered green) writing back to the pair's `filterOverride`.

---

### (6) Tauri commands & required new endpoints

**Reused (existing):**
- `import_ffs(path: String) -> FfsImport` — backing the parse on file choose. Returns `{ jobs: ImportedJob[], notes }`; the screen groups all `jobs` (each an `ImportedJob` = one pair) under one new Job, mapping `two_way→modeOverride`, `exclude_globs→IgnorePolicy.custom_globs`, `use_recycle_bin/verify_by_hash→JobSettings`, `gitignore_hint→assist banner`, `warnings→per-pair review`.
- `validate_job(...)` — called per resolved pair (root_a/root_b reachable, especially UNC `\\NAS\…`) to drive each pair's validity status-dot before create.
- `preview_sync(...)` — invoked per pair after create when `Run preview` is on (writes nothing); feeds the Compare workspace.
- `cancel_sync(...)` — cancels an in-flight post-create preview.
- `get_baseline_status(...)` — after create, each new pair is `FirstSync` (WATCH-colored) since no baseline exists yet; shown on the destination Job Detail.

**NEW commands/events needed (explicit):**
- `import_ffs_text(xml: String) -> FfsImport` — parse drag-dropped content / paste without a path round-trip (current `import_ffs` only takes a path). *(Optional but recommended for the drop-zone.)*
- `create_job_from_import(payload: CreateJobFromImport) -> Job` — **required.** Persists the reviewed result to `jobs.json`: takes `{ name, settings: JobSettings, pairs: [{ rootLeft, rootRight, modeOverride, filterOverride, enabled }] }`, computes each `FolderPair.id` via the existing `job_id()` hash, and returns the created `Job`. `import_ffs` only *parses*; nothing today persists a multi-pair Job.
- `validate_ffs_path(path) -> { exists, kind: Batch|Gui, xmlFormat }` *(optional)* — cheap header sniff to render the SOURCE badges and enable/disable Choose feedback without full parse.
- **Event** `import://preview-progress` (payload `{ pairId, done, total, currentPath }`) — drives the per-pair inset progress + mono path during the post-create preview run, mirroring the normal sync progress event channel.

No new persistence model is introduced beyond the locked `Job`/`FolderPair`/`JobSettings` shapes; `create_job_from_import` is simply the write-path counterpart to the read-only `import_ffs`.

---

I have sufficient grounding. The importer returns a flat `Vec<ImportedJob>` today (one ImportedJob per pair), and the design calls for reworking that into one Job with N pairs — relevant to the import empty-state flow. Now I'll write the spec.

## First-run / Empty States

**(1) Purpose** — Give every zero-data surface in the app a confident, technical home: on first launch (no `jobs.json`), greet the user with the differentiator (native `.gitignore`) and the safety promise, and route them straight into *New job* or *Import from FreeFileSync*; everywhere else, reuse one consistent set of empty / loading / error / in-sync states so a blank screen never looks broken.

---

**(2) Mockup — first launch, no jobs (within the shell)**

```
┌────────────┬──────────────────────────────────────────────────────────────────────────┐
│ ▣ fast-file│  ░░░░░░░░░░░░░░░░░░ topbar · drag region ░░░░░░░░░░░░░░░  [Import .ffs] [+ New job]│ 44
│   -sync    ├──────────────────────────────────────────────────────────────────────────┤
│            │                                                                            │
│ ▸ Jobs   ● │                                                                            │
│ ▸ Schedules│                          ▣  fast-file-sync                                 │
│ ▸ Activity │              ──────────────────────────────────────────────               │
│ ▸ Cloud    │            Fast, reliable two-way folder sync that natively                │
│ ▸ Settings │            respects  .gitignore — so node_modules, build/, and             │
│            │            dist/ never sync. FreeFileSync can't do that.                   │
│            │                                                                            │
│            │            Safe by design: conflicts are never auto-applied,               │
│            │            deletes go to the recycle bin, and a scan read-error            │
│            │            suppresses deletions.                                           │
│            │                                                                            │
│            │      ┌───────────────────────────┐   ┌───────────────────────────┐        │
│            │      │ + New job              ▸   │   │ ⭳ Import from FreeFileSync│        │
│            │      │ ─────────────────────────  │   │ ───────────────────────── │        │
│            │      │ Pick two folders and a    │   │ Open a .ffs_batch / .ffs_ │        │
│            │      │ sync mode. Preview before │   │ gui — folder pairs, modes │        │
│            │      │ anything is written.      │   │ & filters come across.    │        │
│            │      │            [primary ⏎]    │   │            [default]      │        │
│            │      └───────────────────────────┘   └───────────────────────────┘        │
│            │                                                                            │
│            │      gitignore is on by default · ⌘N new · ⌘I import · ? shortcuts         │
│            │                                                                            │
│            ├──────────────────────────────────────────────────────────────────────────┤
│ engine ● idle  ·  baseline store ready  ·  v0.1.0                                      │
└────────────┴──────────────────────────────────────────────────────────────────────────┘
```

Sidebar rows render normally (not disabled) so the IA is legible from second zero; clicking *Schedules* / *Cloud* lands on their own "Coming soon" empties (below).

---

**(3) Layout / components breakdown**

- **Shell** — standard `[sidebar 232][topbar 44 / content]` grid. Sidebar always present (never hidden on first run); active section = `bg-active` + 2px accent bar. Footer = engine status dot (`idle` → NEUTRAL) + baseline-store readiness + version.
- **Topbar** — drag region; right-aligned **ghost** `[Import .ffs]` and **primary** `[+ New job]`. These duplicate the hero CTAs so muscle memory works once the dashboard is populated.
- **Hero block** — centered column, max-width ~560px. App glyph + `display20` wordmark, a `border-subtle` hairline rule, then two `body13`/`sec` paragraphs. Differentiator paragraph renders `.gitignore`, `node_modules`, `build/`, `dist/` in **mono** (`text`) so the unique feature reads as technical fact. Safety paragraph uses `muted`.
- **CTA cards** — two `surface-2`, `radius-md`, `border` cards side-by-side (stack vertically < 720px). Each = title row (icon + `h2`), `sm`/`muted` description, footer button. Left card button is **primary**; right card button is **default**. Whole card is a click target with `:hover` → `surface-3`; `:focus-visible` ring per token spec.
- **Hint line** — single `xs`/`faint` row stating defaults (`gitignore on`) and key shortcuts; the `gitignore` word in mono.
- **Generic primitives (used app-wide, defined here):**
  - `EmptyState{ icon, title(h2), body(sm muted), actions[] }` — centered, no border.
  - `LoadingState{ label }` — centered spinner (accent, pulse) + `sm muted` mono label; optional inset skeleton rows (`surface-2`, 30px row-h) for list surfaces.
  - `ErrorState{ title(DANGER fg), detail(mono sm), retry, secondary }` — `DANGER` icon, message in `surface` card with `danger` left-stripe; detail is selectable mono.
  - `ComingSoon{ section }` — `WATCH`-tinted icon, `h2` "Coming soon", one-line what-it-will-do.

---

**(4) All states**

| State | Where | Render |
|---|---|---|
| **Empty — first run** | Jobs, no `jobs.json` | The hero mockup above. |
| **Empty — Jobs after delete** | Jobs list emptied later | Same hero but condensed: title "No jobs yet", same two CTAs, drop the long marketing copy (keep one differentiator line). |
| **Empty — Schedules / Cloud-Devices** | those sections, P1/P3 | `ComingSoon` — Schedules: "Cron-like schedules per job, running all pairs. Coming soon." Cloud: "S3, SMB/NAS and device-to-device sync. Coming soon." `WATCH`-tinted glyph; no CTA. |
| **Empty — in-sync (per job)** | Job Detail after a clean preview | `EmptyState` with **OK** green check, `h2` "In sync", `sm muted` "0 changes across N pairs · baseline current"; secondary `[Re-scan]`. (Distinct from "no jobs" — this is success, not absence.) |
| **Loading — app boot** | shell mount while reading `jobs.json` | Sidebar shows; content = `LoadingState` "loading jobs…" (mono). Resolves to hero or dashboard. Footer dot pulses. |
| **Loading — preview/scan** | New job / Job Detail | inset skeleton compare-rows + progress affordance; this is the in-progress state below. |
| **Populated** | Jobs has ≥1 job | First-run screen is replaced by the **Jobs Dashboard** (separate screen); first-run only owns the zero state. |
| **In-progress** | first preview from New-job dialog | `LoadingState` swaps to a progress affordance: inset track + accent fill, mono current path, `[Cancel]` (calls `cancel_sync`). Driven by `sync://progress` events. |
| **Error — boot/load failed** | `jobs.json` unreadable/corrupt | `ErrorState`, DANGER: "Couldn't load your jobs", detail = mono error + path, `[Retry]` (re-read) + ghost `[Open data folder]`. Hero CTAs still offered below so the user isn't stuck. |
| **Error — import failed** | after `import_ffs` rejects | Non-dismissible `Banner` (DANGER) above the two cards: "Not a FreeFileSync config" / parser message in mono; `[Choose another file]`. (Mirrors `parse_ffs` errors: bad XML, wrong root, "no folder pairs found".) |
| **Conflict** (variant) | n/a on true first run — no baseline yet, so first sync is `BaselineStatus::FirstSync` (WATCH) | Surface a WATCH-tinted **first-run note** when entering a freshly-created job's preview: "First sync — no baseline yet; everything will be compared fresh and nothing is deleted on a first run." Real `Conflict` (magenta) states live in the Compare screen, not here. |
| **Watch / Scheduled** (variant) | Jobs empty but daemon/schedule features visible | In the hero hint line, the future capabilities are *named but inert*. On the Schedules/Cloud `ComingSoon`, the `WATCH` accent signals "daemon-future" per the cheatsheet. No live watch state exists with zero jobs. |

---

**(5) Interactions & keyboard affordances**

- `⌘N` / `Ctrl+N` → open **New job** editor (same as primary card / topbar).
- `⌘I` / `Ctrl+I` → open native file dialog for **Import** (Tauri dialog plugin, `*.ffs_batch;*.ffs_gui`).
- `Enter` while hero focused → activates primary (New job); `Tab` cycles topbar → New-job card → Import card → hint links, all with visible `:focus-visible` rings.
- `?` → shortcuts overlay (modal, `surface-3`).
- CTA cards are buttons (role=button): click anywhere on card, not just the inner button.
- Drag-and-drop a `.ffs_batch` onto the content area → routes into the import flow (same as `⌘I`).
- Error states: `R` retries when an `ErrorState` is focused; "Open data folder" reveals the app-data `jobs/` dir.
- All motion 90–140ms; spinner pulse on the boot loader and engine footer dot.

---

**(6) Tauri commands & events**

*Reused (existing):*
- `import_ffs(path)` — invoked by the **Import** card / `⌘I` / drag-drop. NOTE for the engineer: today it returns `FfsImport { jobs: Vec<ImportedJob>, notes }` where **one `ImportedJob` == one pair** (`ffs_import.rs`). Per the locked data model, the import-review step must fold these into **one Job with N FolderPairs** (shared `JobSettings` from the common fields; per-pair `filterOverride`/`modeOverride` where a pair's `two_way`/`exclude_globs`/`verify_by_hash` diverge). The first-run screen only launches the flow; the folding happens in the Import-review modal.
- `validate_job(cfg)` — called as the user fills the New-job editor that this screen opens (path validity dots).
- `get_baseline_status(cfg)` — drives the **FirstSync (WATCH)** first-run note once a new job exists.
- `preview_sync`, `execute_sync`, `cancel_sync` — not called by the empty state itself; they belong to the New-job/Compare screens this screen navigates to. Listed for cross-nav: the in-progress affordance shown here subscribes to the `sync://progress` event and wires `[Cancel]` → `cancel_sync`.

*New commands/events needed:*
- **`list_jobs() -> Vec<Job>`** — read `jobs.json`; emptiness of the result is what selects first-run vs dashboard. (No load API exists today.) Errors here drive the **Error — boot** state.
- **`get_app_paths() -> { dataDir, jobsDir, version }`** — powers the footer ("baseline store ready", version) and the "Open data folder" error action.
- **`reveal_path(path)`** — open the OS file manager at the data folder (error-state secondary action). Can be the `tauri-plugin-opener`/shell reveal rather than a custom command.
- **Event `app://boot-status`** (optional) — emit `loading | ready | error{detail}` during setup so the shell can show the boot `LoadingState`/`ErrorState` before `list_jobs` resolves. If omitted, the frontend derives the same three states from the `list_jobs` promise (pending/resolved/rejected).
- No new command is required for *New job* — it opens the Job Editor screen client-side; persistence (a future `save_job`) belongs to the Job Editor spec, not here.

---

# Frontend Architecture

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

**Key invariants for the engineer:** (1) only `ipc/commands.ts`/`events.ts` may call `invoke`/`listen`. (2) Every run — manual, watch, schedule, remote — goes through `preview_job → execute_job` so delete-suppression, big-delete gate, and baseline trust apply once, everywhere. (3) The reconcile 25-cell truth table is sacred; mirror/update are a post-filter on `Decision`, never a fork of `reconcile()`. (4) Colors come only from `domain/meaning.ts` keyed by the serde enum string — never hardcoded in components.

---

## Product Decisions (resolved)

The product owner resolved the open questions; these are now **requirements**.

### 1. Big-delete guard — on by default, fully configurable
Keep the guard on by default, but make its threshold a per-job setting the user can tune or disable, expressed as **either a percentage of the sync's files OR an absolute file count** (the user picks the mode). A user who routinely makes large changes must not be forced through the conflict inbox every run.
- Config (per job, optional per-pair override): `bigDeleteGuard = Off | Percent(p) | Count(n)`.
- Applies to Mirror/Update deletions too — a mistyped root must never silently wipe a drive — but the user can deliberately raise or disable it.

### 2. Watcher behavior — user-configurable per job
The real-time watcher's autonomy is a per-job setting:
`WatchPolicy = PreviewOnly | AutoApplySafe (adds + content updates; defer deletes & conflicts to the inbox) | AutoApplyAll (fully automatic, incl. deletes)`.
Default **AutoApplySafe**; the user opts into AutoApplyAll knowingly.

### 3. Undo — conditional, best-effort (gated on recoverability)
Offer an **Undo** on a per-run basis, but **only when that run is actually reversible** given what was retained. This is *not* a heavyweight transaction-log-with-rollback engine — it reuses two things we already build:
- the **Activity run record** (the exact actions that were applied — kept anyway), and
- a **recoverable deletion/overwrite policy** (recycle bin or Versioned archive, Decision 4) so prior file versions still exist on disk.

Undo reverses each recorded action: a *created* file is sent to the trash; a *deleted* file is restored from the recycle bin / archive; an *overwritten* file is restored from its archived previous version. For an overwrite to be reversible, the policy must have **captured the overwritten version** — which the **Versioned** policy does (it archives both deletions and overwrites); a plain recycle-bin policy only captures deletions.

**UI.** Activity shows each past run's undo-ability up front. With logging + a recoverable policy configured, the user gets a real **Undo run** button (and per-file restore). If a run used Permanent deletes — or overwrote without versioning — undo is disabled or partial for the unrecoverable items, with a plain-language explanation of why. So undo is a feature you *enable* by choosing a recoverable policy, not a promise we make unconditionally.

### 4. Deletion policy — versioned archive with a user-chosen location
Alongside recycle-bin and permanent delete, offer a **versioned archive**: deleted/overwritten files are moved into an archive folder and kept as timestamped versions inside it.
- The **archive location is user-chosen**, settable **per folder pair, or once for the whole job**.
- A sensible default (e.g. `.ffs-versions/` beside the destination root), but the user can point it anywhere — important for NAS targets that have no recycle bin.
- `DeletionPolicy = RecycleBin | Permanent | Versioned { location, retention }`.

### 5. Cross-platform — design for multi-OS from the start
Do **not** lock to Windows. Put the OS-specific pieces (trash mechanism, path handling, case-sensitivity, timestamp granularity) behind **swappable platform abstractions** so macOS/Linux is a later flip, not a rewrite. Windows-only capabilities are allowed where genuinely needed, but always behind the abstraction.

### 6. Remote/cloud backends — capability-driven, best-effort, stubbable
Model every backend (local, S3, SFTP, peer…) as an `Fs`-style **interface that also reports a capability descriptor** (e.g. `supportsAtomicRename`, `supportsRecycleBin`, `supportsAcl`, `supportsSymlinks`, `supportsVersioning`, `supportsHashing`…). The frontend reads capabilities and adapts: it shows what a backend supports, **stubs the rest with an in-window warning**, and more gets implemented on demand. Every **safety** feature must be *possible* on every backend (best-effort allowed); where a backend can't guarantee one (e.g. no atomic rename on S3) the UI surfaces the reduced guarantee explicitly.

### 7. Metadata parity — content + mtime, plus whatever is cheap
Baseline = **content + modified-time** (today's behavior). Add any metadata that is **easy/cheap** to support; decide each remaining item (ACL/permission preservation, symlink follow-vs-copy, locked-file/VSS copy) **case-by-case on implementation cost**, not as a blanket promise.

### 8. Concurrency — no concurrent runs
A given job/pair may have only **one active run** at a time. A second trigger (manual/schedule/watch) arriving mid-run is **queued or skipped**, never run concurrently. The run registry holds a per-pair lock; no overlapping baseline mutation.