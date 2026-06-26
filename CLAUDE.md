# fast-file-sync — agent guide

Reliable, fast two-way file sync that natively respects `.gitignore`. Rust core
(`src-tauri/`) + Tauri 2 + React/TS (`src/`), pnpm.

## Formatting (run before finishing — both are idempotent)

- **Rust:** `cd src-tauri && cargo fmt` (config: `src-tauri/rustfmt.toml`, edition 2021)
- **Frontend:** `pnpm format` (Biome — `biome.json`; formatter + organize-imports; the
  linter is intentionally off for now and can be enabled incrementally later)
- The whole tree is already canonical, so these are **no-ops on files you didn't touch** —
  do NOT hand-format, and do NOT run a whole-tree format expecting churn. CI gates on
  `cargo fmt --check` and `pnpm format:check`; both run `--check` only and never rewrite.
- Biome ignores `src-tauri/**` and CSS (CSS is hand-maintained).

## Tests

- **Rust:** `cd src-tauri && cargo test` (unit suites + `tests/multi_pair.rs`)
- **Frontend unit:** `pnpm test` (Vitest)
- **E2E:** `pnpm e2e:mocked` (Playwright, mocked IPC, fast, cross-platform);
  `pnpm e2e:native` (WDIO + tauri-driver, Windows-only)
- **Test data:** `pnpm gen:testdata` (`scripts/gen-testdata.mjs`) — throwaway two-folder
  fixtures under the OS temp dir.

## Invariants (do not violate)

1. **`reconcile()` truth table** (`src-tauri/src/reconcile.rs`) is the single source of
   reconciliation truth. `SyncMode {TwoWay,Mirror,Update}` is a POST-FILTER on the
   `Decision` (`apply_mode` in `plan.rs`), never a fork. Semantics are frozen by
   `golden_truth_table_is_frozen` + the per-cell tests — the file may be reformatted, but a
   changed cell must be intentional and reviewed. (It is no longer required to be
   byte-identical; the tests are the guard.)
2. Every run path goes through `engine::preview`/`execute`, so delete-suppression, the
   big-delete guard, baseline-trust (first-sync/corrupt → no deletes), and scan-error
   suppression apply uniformly. No bypass; no frozen-plan apply (execute always re-scans).
3. No concurrent runs: the single-slot `RunRegistry` + per-run `Arc<AtomicBool>` cancel.
4. **Frontend:** `invoke` only in `src/ipc/commands.ts`; `listen` only in
   `src/ipc/events.ts`. All meaning colors/labels/glyphs come from `src/domain/meaning.ts`
   keyed by serde enum strings — never hardcode meaning hex in components. Zod parses every
   IPC response at the boundary.

## Docs

Product + UI design: `docs/DESIGN.md`. Architecture + roadmap: `docs/ARCHITECTURE.md`.
