# Scan/compare profiling: FreeFileSync vs. our scanner

Tooling to fairly benchmark **enumeration/compare time** of FreeFileSync against our
own `scanbench`, with a correct **cold/warm** cache methodology over SMB/NAS.

> **Do not run live measurements while the NAS is under load** (e.g. a big backup in
> flight). ARC contention + link saturation make every number meaningless. Run this
> only when the NAS is idle.

Files here:

| File | What |
|---|---|
| `Profile-Compare.ps1` | Orchestrator: evicts cache, times FFS + `scanbench`, tabulates. |
| `CompareOnly.ffs_batch` | Compare-only FFS batch template (all sync directions = `none`). |

---

## 1. Protocol

### 1.0 One-time prereqs

```powershell
# Build our harness once
cd ..\..\src-tauri
cargo build --release --example scanbench

# Get ONE standby-list eviction tool (neither is installed by default):
#   EmptyStandbyList (headless, scriptable — preferred): https://wj32.org/wp/software/empty-standby-list/
#   RAMMap:                                               https://learn.microsoft.com/sysinternals/downloads/rammap
```

Everything that forces a **cold** run needs an **elevated (admin) PowerShell**.

### 1.1 Build the FFS compare-only batch

There is **no compare-only CLI mode** — a batch always runs `compare()` then
`synchronize()`. We neutralize the sync by setting **all six directions to `none`**,
so `synchronize()` is a no-op and the reported time ≈ compare/enumeration time.

Easiest correct path: **build it in the FFS GUI** (set both folders → comparison
variant *File time and size* → sync variant *Custom* with every arrow set to *do
nothing* → File → Save as batch job). FFS's XML format drifts between versions, so a
GUI export for **14.9** beats a hand-written template. `CompareOnly.ffs_batch` is the
shape to aim for; confirm all six directions read `none`.

> **⚠️ A batch is NOT zero-write, even with all directions `none`.** Verified
> empirically (2026-06-28): a `.ffs_batch` always proceeds to the (no-op) sync phase,
> and FFS writes its `sync.ffs_db` baseline (~1.7 MB for ~170k items) to **both** roots
> — *including the NAS* — plus a `sync.ffs_lock` during the run (left stale if the run is
> killed). It does **not** copy/delete file content (that part is genuinely safe), and
> FFS preserves other pairs' db sections, so a real pair's baseline is *usually* intact.
> But if you want a **truly zero-write** compare timing, use the **GUI "Compare" button**
> instead (it scans both trees, shows item count + time, and never writes `sync.ffs_db`).
> Reserve the batch method for when a db write to the target is acceptable.

### 1.2 Run it

```powershell
# Elevated pwsh, NAS idle:
.\Profile-Compare.ps1 `
    -NasPath   '\\NAS\share\folderA' `
    -LocalPath 'C:\local\folderA' `
    -FfsBatch  .\CompareOnly.ffs_batch `
    -Threads   4,8,16 `
    -EvictTool 'C:\tools\EmptyStandbyList.exe' `
    -Mode      Both `
    -Csv       .\results.csv
```

The script times FFS with `Measure-Command` (sub-ms wall) **and** reads FFS's stdout
JSON `totalTimeSec` (present since 14.6, so in 14.9). Note `totalTimeSec` has **second**
granularity — for small/sub-second trees trust the wall time. FFS exit codes:
`0` ok / `1` warning / `2` error / `3` cancelled.

### 1.3 Cold vs warm — what each eviction actually touches

Over a UNC/SMB path, metadata is cached in **two independent places**:

| Cache | Lives on | Evicted by |
|---|---|---|
| SMB redirector caches (Directory/FileInfo lifetime ~10 s) | Windows client | **time** — expire in ≤10 s on their own; *not* your warm-speed driver |
| OS standby list (pages parked after a read) | Windows client | `RAMMap -Et` / `EmptyStandbyList standbylist` / reboot |
| NAS server RAM (ZFS ARC, inodes + dirents) | **the NAS** | **nothing on the client** — only a NAS pool reimport / NAS reboot |

So a client-side eviction gives **"client-cold, server-warm"** — which is exactly the
real-world post-reboot case. The script evicts **before each cold sample** and runs a
**single** thread column per sample (the first pass after eviction warms the standby
list and would poison a multi-column sweep — see `scanbench.rs:18-21`).

### 1.4 Apples-to-apples caveats (the script prints reminders for these)

- **FFS reads BOTH roots; one `scanbench` reads ONE.** The script sums NAS + local
  `scanbench` runs and compares that to the single FFS number.
- **Filtering changes the file set.** Our scanner honors `.gitignore`/`.ignore`/
  `.git/info/exclude` natively (`scan.rs:1-6`, `139-156`); a vanilla FFS batch does
  **not**. If the tree has an ignored `node_modules`/`target`, we walk fewer entries by
  design and look faster for reasons unrelated to enumeration speed. Test a tree with
  no ignore files, or add matching excludes to the FFS batch — and note which.
- **Compare variant.** Keep FFS on *File time and size* and run `scanbench` **without**
  `--hash`, so neither side hashes. Add `--hash` + FFS *File content* only to benchmark
  the verify path (expect both to crater — that's I/O-bound, not metadata-bound).
- **Label every run cold/warm.** Cold-first vs warm-later are not comparable.

---

## 2. "Why no reboot penalty / does FFS have another cache?"

**FreeFileSync keeps NO persistent listing/metadata cache.** Its only on-disk DB,
`sync.ffs_db`, is the **two-way sync baseline** (last-sync state → decides sync
*direction* + move detection), **not** a directory listing. FFS **re-enumerates both
roots live on every compare, by design** — the rescan can't be skipped. Our scanner is
in the same boat (`ignore`'s `WalkBuilder` re-walks every run). Neither tool has a
private listing cache.

So the reason a reboot never feels slower, ranked:

1. **(Dominant) The NAS server-side cache survives a *client* reboot.** ZFS ARC lives
   in the NAS's RAM, managed by the still-running NAS OS — rebooting *your PC* doesn't
   touch it. Your hot dirents/inodes stay in ARC, so a client-cold enumeration is served
   warm from the server. This is usually the whole story.
2. **SSD-backed / SSD-cached NAS** (metadata special vdev, L2ARC) → even an ARC miss is
   sub-ms, so "cold" and "warm" look identical.
3. **Small working set** → metadata-only enumeration is sub-second even when truly cold;
   the cost only bites at tens of thousands of entries over high-latency SMB.
4. **You've probably never run a genuinely cold compare** — reboots are rare and within a
   session the OS keeps buffers warm. The SMB redirector's 10 s caches are far too short
   to explain sustained warm speed (a red herring).

**Settle it definitively:**

- **Test A — client reboot only:** reboot the PC, then immediately run the cold compare
  (no warm-up browsing). *Prediction: still fast* — ARC on the NAS is warm. Proves it's
  server-side, not an FFS cache.
- **Test B — drop the server cache too:** reboot the NAS (or export/reimport the pool),
  then run the same compare. *Prediction: noticeably slower until ARC re-warms.*

If A ≈ warm and B ≫ A, cause #1 is confirmed end-to-end.

---

## 3. Large-fetch Windows enumerator — recommendation

**Measure-first, then almost certainly *don't* do the full custom enumerator.**

Why the upside is small:

- Rust std `read_dir` on Windows **already** uses `FindFirstFileExW` + `FindExInfoBasic`
  and returns per-entry metadata **inline** from `WIN32_FIND_DATAW` (no stat-per-entry
  round-trip). We're not missing inline metadata today.
- The **entire** delta a custom enumerator buys is one flag —
  `FIND_FIRST_EX_LARGE_FETCH` — which std deliberately leaves off. It's a bigger
  `FindNextFile` buffer → fewer round-trips. A **bounded, one-time, non-compounding**
  win, strongest exactly in our quadrant (full walk over high-latency SMB) but with an
  **unmeasured** SMB magnitude here.

Why the cost is asymmetric:

- `ignore` welds the directory walk to `.gitignore`/`.ignore`/`.git/info/exclude`
  matching, nested-ignore precedence, negation, directory pruning, hidden handling, and
  the parallel pool — the product's reason to exist (`scan.rs:1-6`).
- `ignore` exposes **no hook** to substitute a custom `readdir` (hardcoded `fs::read_dir`
  in `ignore/src/walk.rs`). Bypassing it = leaving the `ignore` walker = reimplementing
  the gitignore engine. That's the **Large**, high-risk path (touches Invariant #4 + the
  both-roots-identical-filter symmetry guarantee).

### Do / Measure / Don't

1. **DO first (free, already shipped): tune thread count.** Our documented primary SMB
   lever, already user-tunable (`scan.rs:46-69`; default CPU clamped 4..16, override to
   256). Thread count and LARGE_FETCH attack *different* bottlenecks (in-flight requests
   vs. per-call buffer), so exhaust the free one first:
   ```powershell
   cd ..\..\src-tauri
   cargo run --release --example scanbench -- "\\NAS\share\folderA" 1 4 8 16 32 64   # cold-ish first pass
   cargo run --release --example scanbench -- "\\NAS\share\folderA" 1 4 8 16 32 64   # warm second pass
   ```
   Pick where `entries/s` peaks (note where it collapses — that's the SMB connection-table
   limit the conservative default guards against). The sweet spot is **per-device** (NAS
   wants more in-flight than a local SSD); the knob already supports per-job overrides.
   **If thread tuning gets you to acceptable times, stop here.**

2. **MEASURE (only if thread tuning is insufficient): a Small throwaway A/B probe**, not
   an integration. A temporary (un-shipped) example that enumerates the NAS root
   **non-recursively** two ways and times the `FindNextFile` loop, cold and warm:
   - **A:** `std::fs::read_dir` (baseline — `FindExInfoBasic`, no LARGE_FETCH).
   - **B:** `windows-sys` `FindFirstFileExW` + `FindExInfoBasic` + `FindExSearchNameMatch`
     + `dwAdditionalFlags = FIND_FIRST_EX_LARGE_FETCH`, then a `FindNextFileW` loop.
   If B isn't **clearly and repeatably** faster over the *idle* NAS (say <1.3×),
   **abandon** — there's nothing else to gain. (`windows-sys` is already in `Cargo.lock`
   transitively, so adding it behind `cfg(windows)` for the probe is cheap.)

3. **DON'T hand-roll a standalone enumerator that bypasses `ignore`** (effort **L**, high
   correctness risk). **IF** the probe shows a worthwhile, repeatable win, take the
   low-blast-radius route instead: patch `ignore` at its single `fs::read_dir` seam to
   call a LARGE_FETCH enumerator, and **vendor/upstream** that one-flag patch. Preserves
   the whole gitignore engine + parallel pool. Effort: **M**. (The std source frames the
   missing flag as a conservative default, not a blocker — a clean upstream PR is
   plausible.)

After any code change: `cd src-tauri && cargo fmt && cargo test` (per CLAUDE.md).

---

### Confidence

- **High:** FFS has no listing cache / always re-enumerates; standby-list vs ARC split;
  std already does `FindExInfoBasic` + inline metadata (only delta is one flag); `ignore`
  has no readdir hook; thread count is the cheaper, already-shipped lever.
- **Medium:** the *magnitude* of any LARGE_FETCH SMB win (unmeasured here); the exact 14.9
  `.ffs_batch` field names (GUI-export to be safe); `totalTimeSec` second-granularity.
