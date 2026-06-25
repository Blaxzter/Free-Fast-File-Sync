# fast-file-sync

A reliable, fast **two-way file sync** with a desktop UI — built because
[FreeFileSync](https://freefilesync.org/) has no way to detect and respect
`.gitignore` files in its filters.

The headline feature: the scanner is built on the [`ignore`](https://docs.rs/ignore)
crate (the engine behind ripgrep), so `.gitignore`, `.ignore`, nested ignore
files, and `.git/info/exclude` are honored **natively** — no manual filter lists.

> Status: **working prototype.** The safety-critical sync core is complete and
> covered by tests; some hardening and the live-watch daemon are deferred (see
> [Limitations](#limitations)).

---

## Why two-way sync is the hard part

One-way mirror is easy. Two-way sync, done naively, **silently destroys data** —
e.g. `rsync --delete` run in both directions resurrects just-deleted files or
deletes just-created ones, because direction order (not causality) decides.

This engine avoids that the way mature tools (Unison, Syncthing) do: it keeps a
**baseline** — a snapshot of the last successful sync — and reconciles each path
three ways (side A vs side B vs baseline). The reconciliation rules are encoded
as an exhaustive truth table with one overriding principle:

> **When unsure, raise a conflict. Never guess in a way that can lose data.**

Concretely:

- A **delete racing an edit** (`Modified` vs `Deleted`) is *always* a conflict,
  defaulting to keeping the edited copy. A delete never silently wins.
- **Both sides edited** the same file differently → conflict (identical edits
  auto-converge).
- **Logically impossible** states (a stale/corrupt baseline) → `StateDesync`
  conflict; the engine refuses to act and asks for a rescan.
- **First sync / missing / corrupt baseline** → union only, **zero deletions**.
- Deletions go to the **Recycle Bin** by default, and a **big-delete guard**
  pauses if a run would remove an unusually large fraction of your files.

## Architecture

```
fast-file-sync/
├─ src/                      React + TypeScript UI (Vite)
│  ├─ App.tsx                pick folders → preview plan → resolve conflicts → apply
│  └─ api.ts                 typed wrappers over the Tauri commands
└─ src-tauri/                Rust core (Tauri 2)
   └─ src/
      ├─ model.rs            shared types (Meta, ChangeKind, Action, ConflictType…)
      ├─ reconcile.rs        ★ the 5×5 reconciliation truth table (pure, fully tested)
      ├─ scan.rs             WalkBuilder scan honoring .gitignore + streamed blake3
      ├─ baseline.rs         versioned, checksummed, atomically-written prior-sync state
      ├─ plan.rs             union + classify + safety guards → a SyncPlan
      ├─ fsops.rs            atomic temp+fsync+rename copies, recycle-bin deletes
      ├─ apply.rs            TOCTOU-revalidated execution, per-item baseline updates
      ├─ engine.rs           orchestration: preview() / execute()
      ├─ pathutil.rs         NFC keys, Windows long-path + reserved-name handling
      ├─ config.rs           per-job config + ignore policy
      ├─ error.rs            typed, IPC-serializable errors
      └─ lib.rs              Tauri commands + IPC
```

Data flow: **Preview** scans both roots in parallel, loads the baseline, and
returns a plan (every path + its action + any conflict). You resolve conflicts in
the UI, then **Apply** re-scans, executes the plan item-by-item, and writes a
fresh baseline — only for items that actually succeeded.

### What makes it safe (the invariants)

| Risk | Mitigation |
|---|---|
| Resurrecting/destroying files in two-way sync | Persisted **baseline** + three-way reconcile |
| Delete vs edit | Hard **conflict**, default keeps the edit |
| Missing/corrupt baseline read as "all deleted" | Explicit `Missing`/`Corrupt` → safe **union, no deletes** |
| Crash mid-copy leaving a truncated file | **temp file → fsync → atomic rename**, never write in place |
| Crash mid-run double-wiping via a stale baseline | Baseline advanced **per succeeded item**; a crash just reverts to the pre-run baseline and re-derives safely |
| File changes between preview and apply (TOCTOU) | Re-stat both endpoints immediately before mutating; drift → skip as conflict |
| A newly-`.gitignore`d file looking "deleted" | **Filtered-file delete guard**: a path absent from the scan but still on disk is ignored, never deleted |
| An unreadable subtree (offline drive, locked folder, revoked ACL) misread as a deletion | A scan read-error **suppresses all deletions** that run — absence is treated as *unknown*, never as a removal |
| Accidental mass deletion | **Big-delete guard** requires confirmation |
| Symlinks / junctions / cloud placeholders | Detected and **skipped**, never traversed or read as empty stubs |
| NFC/NFD or case-only name collisions | NFC comparison keys; case-fold collision → conflict |

## Migrating from FreeFileSync

Click **Import .ffs_batch / .ffs_gui** and pick your existing FreeFileSync config.
fast-file-sync parses every folder pair and translates the settings:

- each `<Pair>` → a job's two folders
- `TimeAndSize` vs `Content` compare → metadata vs **verify-by-hash**
- `RecycleBin` deletion → **send deletes to the recycle bin**
- path-based `<Exclude>` filters → glob filters (FFS `*\node_modules\` → `node_modules/`,
  a leading `\` stays root-anchored, a trailing `\` stays a directory match)
- two-way `<Changes>` vs a one-way `<Differences>` mirror → flagged per pair

Pick a pair and it populates the form. Patterns that don't map cleanly (e.g. the
`*.venv |` pipe artifact) are surfaced as review notes, and you'll get a hint when
many excludes (`node_modules`, `.git`, `build`, `dist`, `__pycache__`, `.venv`…) are
already covered by `.gitignore` — the point of switching. One-way mirror pairs are
flagged because the engine currently syncs two-way.

## Running it

Prerequisites: **Rust** (stable, MSVC on Windows), **Node + pnpm**, and the
**WebView2** runtime (preinstalled on Windows 11).

```bash
pnpm install

# Run the desktop app (hot-reload UI + Rust)
pnpm tauri dev

# Run the engine's test suite (truth table + integration scenarios)
cd src-tauri && cargo test

# Build a distributable installer (.msi/.exe on Windows)
pnpm tauri build
```

The first `cargo` build compiles the whole Tauri dependency tree and is slow;
subsequent builds are incremental.

Per-job state (the baseline) is stored in your OS app-data directory, **not**
inside the synced folders, so the sync metadata is never itself synced.

## Limitations (deferred for the prototype)

These are intentionally out of scope for v1 and are non-destructive in their
current handling:

- **Live watch / daemon** — sync is manual (preview → apply); the `notify`-based
  watcher is the next milestone.
- **Rename detection** — a move is modeled as delete + create (safe, but
  re-copies the bytes).
- **Write-ahead journal roll-forward** — crash-safety currently comes from
  per-item baseline updates + atomic file replacement (a crash reverts to the
  pre-run baseline and re-derives). A resumable WAL is a planned upgrade.
- **Hardlink identity, ADS/EFS/ACLs, sparse files** — not preserved; files are
  replicated as independent regular files.
- **Cloud / remote backends** — the architecture (Rust core behind a web UI) is
  designed to grow a sync-to-cloud transport later; not implemented yet.
- **Content-hash verify** defaults off (metadata-based change detection). Turn on
  *Verify by content hash* for maximum safety on filesystems with coarse mtimes.

## License

Prototype — no license chosen yet.
