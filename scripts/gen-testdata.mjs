#!/usr/bin/env node
/*
 * Generate throwaway two-folder test data for fast-file-sync.
 *
 * OS-independent (pure Node, no deps, no shell) and idempotent:
 *   - `fresh`  wipes + recreates both sides with deterministic content, so every
 *              run yields byte-identical output (seeded PRNG, no Date/Math.random).
 *   - `mutate` is marker-guarded: re-running it converges to the same state
 *              instead of erroring on already-deleted / already-appended files.
 *
 * Nothing here is committed: the default root is <os-tmp>/ffs-testdata, outside
 * the repo. Override with --root <path> or FFS_TESTDATA env var.
 *
 * Usage:
 *   node scripts/gen-testdata.mjs                      # fresh pair
 *   node scripts/gen-testdata.mjs --scenario mutate    # after one sync in the app
 *   node scripts/gen-testdata.mjs --scenario reset
 *   node scripts/gen-testdata.mjs --scenario fresh --scale 5000
 *   node scripts/gen-testdata.mjs --root /tmp/mydata
 *
 * Also available as: pnpm gen:testdata -- --scenario mutate
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// --- args -----------------------------------------------------------------
function parseArgs(argv) {
  const out = { scenario: "fresh", root: null, scale: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--")
      continue; // pnpm/npm forward a bare separator; ignore it
    else if (a === "--scenario") out.scenario = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--scale") out.scale = parseInt(argv[++i], 10) || 0;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    "node scripts/gen-testdata.mjs [--scenario fresh|mutate|reset] [--root <path>] [--scale N]",
  );
  process.exit(0);
}
if (!["fresh", "mutate", "reset"].includes(args.scenario)) {
  throw new Error(`--scenario must be fresh|mutate|reset (got '${args.scenario}')`);
}

const ROOT = resolve(args.root || process.env.FFS_TESTDATA || join(tmpdir(), "ffs-testdata"));

// --- safety: never operate on a root / suspiciously short path ------------
if (ROOT.split(sep).filter(Boolean).length < 2) {
  throw new Error(`Refusing to use suspicious --root '${ROOT}'. Pick a deeper path.`);
}

const L = join(ROOT, "left");
const R = join(ROOT, "right");

// --- deterministic PRNG (mulberry32) seeded per-string so runs reproduce ---
function seedFrom(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fs helpers -----------------------------------------------------------
function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}
function writeText(path, content) {
  ensureDir(dirname(path));
  writeFileSync(path, content); // utf-8, exact bytes (no trailing newline added)
}
function writeBin(path, bytes, seedKey) {
  ensureDir(dirname(path));
  const rng = mulberry32(seedFrom(seedKey));
  const buf = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = Math.floor(rng() * 256);
  writeFileSync(path, buf);
}
function writeBoth(rel, content) {
  writeText(join(L, rel), content);
  writeText(join(R, rel), content);
}
function rmTree(p) {
  rmSync(p, { recursive: true, force: true });
}
function removeIfExists(p) {
  if (existsSync(p)) rmSync(p, { force: true });
}
/** Append `marker + content` only if `marker` not already present (idempotent). */
function appendOnce(path, marker, content) {
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.includes(marker)) return;
  writeFileSync(path, cur + marker + content);
}

/** Deterministic lorem-ish text of `lines` lines, seeded by `key`. */
function lorem(key, lines) {
  const words =
    "sync delta baseline reconcile mirror gitignore conflict copy hash atomic recycle watcher schedule chunk blake3 walk filter".split(
      " ",
    );
  const rng = mulberry32(seedFrom(key));
  const out = [];
  for (let i = 0; i < lines; i++) {
    const n = 6 + Math.floor(rng() * 8);
    const line = [];
    for (let j = 0; j < n; j++) line.push(words[Math.floor(rng() * words.length)]);
    out.push(line.join(" "));
  }
  return out.join("\n") + "\n";
}

// Shared .gitignore — the FreeFileSync-beating feature under test.
const GITIGNORE = ["node_modules/", "dist/", "*.log", ".env", ""].join("\n");

// =========================================================================
function fresh() {
  rmTree(ROOT);
  ensureDir(L);
  ensureDir(R);

  // 1) Identical both sides -> IN-SYNC (baseline-only on first run)
  writeBoth(".gitignore", GITIGNORE);
  writeBoth("README.md", "# Test project\n\nGenerated test data.\n");
  writeBoth("docs/guide.md", lorem("guide", 40));
  writeBoth("docs/api.md", lorem("api", 25));
  writeBoth("src/index.ts", "export const version = '1.0.0';\n");
  writeBoth("src/util/helpers.ts", "export const clamp = (n) => Math.max(0, n);\n");
  writeBoth("assets/logo.txt", "ASCII-LOGO-PLACEHOLDER\n");

  // 2) One side only -> Copy A->B / Copy B->A
  writeText(join(L, "src/left_only_feature.ts"), "export const left = true;\n");
  writeText(join(L, "notes/left-note.txt"), lorem("leftnote", 8));
  writeText(join(R, "src/right_only_feature.ts"), "export const right = true;\n");
  writeText(join(R, "notes/right-note.txt"), lorem("rightnote", 8));

  // 3) Same path, DIFFERENT content, no baseline -> Create/Create CONFLICT
  writeText(join(L, "config.json"), '{ "env": "left", "port": 3000 }\n');
  writeText(join(R, "config.json"), '{ "env": "right", "port": 4000 }\n');
  writeText(join(L, "src/conflict.ts"), "export const side = 'LEFT';\n");
  writeText(join(R, "src/conflict.ts"), "export const side = 'RIGHT';\n");

  // 4) MUST be excluded by .gitignore both sides (never in the plan)
  writeText(join(L, "node_modules/pkg/index.js"), "module.exports = 1;\n");
  writeBin(join(L, "node_modules/pkg/blob.bin"), 8192, "blob");
  writeText(join(R, "node_modules/other/x.js"), "module.exports = 2;\n");
  writeText(join(L, "dist/bundle.js"), "/* built */\n");
  writeText(join(L, "debug.log"), "noisy log line\n");
  writeText(join(R, "debug.log"), "different noisy log\n");
  writeText(join(L, ".env"), "SECRET=left\n");

  // 5) optional filler for scale/perf testing of the virtualized grid
  if (args.scale > 0) {
    for (let i = 0; i < args.scale; i++) {
      const dir = `bulk/d${String(Math.floor(i / 100)).padStart(3, "0")}`;
      const name = `file_${String(i).padStart(5, "0")}.dat`;
      const body = lorem(`bulk${i}`, 1 + (i % 6));
      writeText(join(L, dir, name), body); // identical both sides -> in-sync filler
      writeText(join(R, dir, name), body);
    }
  }

  summaryFresh();
}

function mutate() {
  if (!existsSync(L) || !existsSync(R)) {
    throw new Error(`No data at ${ROOT}. Run --scenario fresh first (and sync once in the app).`);
  }

  // Modify on LEFT only -> Copy A->B
  appendOnce(join(L, "docs/guide.md"), "\n<!-- left-edit -->", "\nAppended on the LEFT.\n");
  // Modify on RIGHT only -> Copy B->A
  appendOnce(join(R, "docs/api.md"), "\n<!-- right-edit -->", "\nAppended on the RIGHT.\n");

  // Modify on BOTH differently -> Edit/Edit CONFLICT
  appendOnce(join(L, "README.md"), "<!-- L -->", "\nLEFT edit.\n");
  appendOnce(join(R, "README.md"), "<!-- R -->", "\nRIGHT edit.\n");

  // Delete on LEFT -> propagate delete to RIGHT
  removeIfExists(join(L, "src/util/helpers.ts"));
  // Delete on RIGHT -> propagate delete to LEFT
  removeIfExists(join(R, "assets/logo.txt"));

  // Modify on LEFT + delete on RIGHT -> Modify/Delete CONFLICT
  appendOnce(join(L, "src/index.ts"), "// left-change", "\n// changed on LEFT\n");
  removeIfExists(join(R, "src/index.ts"));

  // New file each side -> Copy A->B / Copy B->A
  writeText(join(L, "src/added_left.ts"), "export const addedLeft = 1;\n");
  writeText(join(R, "src/added_right.ts"), "export const addedRight = 1;\n");

  // New identical file on BOTH -> baseline-only (zero IO convergence)
  writeBoth("CHANGELOG.md", "# Changelog\n- init\n");

  // Touch an ignored file -> must STILL be excluded
  appendOnce(join(L, "debug.log"), "more-noise", "more noise\n");

  summaryMutate();
}

function reset() {
  rmTree(ROOT);
  console.log(`Removed ${ROOT}`);
}

function summaryFresh() {
  console.log(`\nFRESH test data ready.`);
  console.log(`  Side A : ${L}`);
  console.log(`  Side B : ${R}\n`);
  console.log("Expected on first Preview (no baseline yet):");
  console.log(
    "  in-sync   : .gitignore, README.md, docs/*, src/index.ts, src/util/helpers.ts, assets/logo.txt",
  );
  console.log("  Copy A->B : src/left_only_feature.ts, notes/left-note.txt");
  console.log("  Copy B->A : src/right_only_feature.ts, notes/right-note.txt");
  console.log("  CONFLICT  : config.json, src/conflict.ts  (same path, different content)");
  console.log("  EXCLUDED  : node_modules/**, dist/**, *.log, .env   <- gitignore differentiator");
  if (args.scale > 0) console.log(`  + ${args.scale} in-sync filler files per side under bulk/`);
  console.log("\nNext: sync once in the app, then re-run with --scenario mutate.");
}

function summaryMutate() {
  console.log(`\nMUTATED both sides (idempotent — safe to re-run).`);
  console.log("Re-Preview in the app (baseline from your last sync) to see:");
  console.log("  Copy A->B      : docs/guide.md, src/added_left.ts");
  console.log("  Copy B->A      : docs/api.md, src/added_right.ts");
  console.log("  Delete (->B)   : src/util/helpers.ts   (deleted on A, propagates)");
  console.log("  Delete (->A)   : assets/logo.txt       (deleted on B, propagates)");
  console.log("  Edit/Edit      : README.md             CONFLICT");
  console.log("  Modify/Delete  : src/index.ts          CONFLICT (modified A, deleted B)");
  console.log("  baseline-only  : CHANGELOG.md          (identical new file both sides)");
  console.log("  EXCLUDED       : debug.log             (still gitignored)\n");
}

// --- dispatch -------------------------------------------------------------
({ fresh, mutate, reset })[args.scenario]();
