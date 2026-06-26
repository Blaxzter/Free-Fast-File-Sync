//! Scan throughput / thread-scaling probe (NOT shipped).
//!
//! Measures how fast the REAL `scan::scan_root_counted` (panic-safe per-thread
//! accumulators, lstat + skip logic, optional hashing) walks a directory across a
//! range of walker-thread counts, so you can pick a sensible value for a given
//! target (local SSD vs. high-latency SMB/NAS). This is the tool to confirm
//! whether the large-NAS-scan stall is thread oversubscription: watch where
//! entries/s peaks and where it collapses (or where the scan simply stops
//! progressing).
//!
//! Usage:
//!   cargo run --release --example scanbench -- <path> [thread-counts...] [--hash]
//!
//! Examples:
//!   cargo run --release --example scanbench -- "\\\\NAS\\share"
//!   cargo run --release --example scanbench -- C:\big\tree 1 4 8 16 32 --hash
//!
//! `0` (the first default column) is the app's auto default. Note the OS
//! filesystem cache warms after the first pass, so a cold first run and a warm
//! later run are not directly comparable — run the sweep twice (or pin one thread
//! count and repeat) for a fair read.

use fast_file_sync_lib::config::IgnorePolicy;
use fast_file_sync_lib::scan::{resolve_scan_threads, scan_root_counted};
use std::path::Path;
use std::sync::atomic::AtomicU64;
use std::time::Instant;

fn main() {
    let mut paths: Vec<String> = Vec::new();
    let mut thread_counts: Vec<usize> = Vec::new();
    let mut hash = false;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--hash" => hash = true,
            "-h" | "--help" => {
                eprintln!(
                    "usage: scanbench <path> [thread-counts...] [--hash]\n\
                     thread-counts default to 0(auto) 1 2 4 8 16 32 64; 0 = the app's auto default"
                );
                return;
            }
            s => match s.parse::<usize>() {
                Ok(n) => thread_counts.push(n),
                Err(_) => paths.push(arg),
            },
        }
    }

    let Some(path) = paths.first() else {
        eprintln!("usage: scanbench <path> [thread-counts...] [--hash]");
        std::process::exit(2);
    };
    let root = Path::new(path);
    if thread_counts.is_empty() {
        thread_counts = vec![0, 1, 2, 4, 8, 16, 32, 64];
    }

    let policy = IgnorePolicy::default();
    println!(
        "scan benchmark: {}{}",
        root.display(),
        if hash { "  (verify-by-hash)" } else { "" }
    );
    println!(
        "auto default resolves to {} threads",
        resolve_scan_threads(0)
    );
    println!(
        "{:>9}  {:>10}  {:>8}  {:>8}  {:>12}  {:>12}",
        "threads", "entries", "errors", "skipped", "millis", "entries/s"
    );

    for &t in &thread_counts {
        let scanned = AtomicU64::new(0);
        let start = Instant::now();
        match scan_root_counted(root, &policy, hash, &scanned, t) {
            Ok(res) => {
                let secs = start.elapsed().as_secs_f64();
                let rate = res.entries.len() as f64 / secs.max(0.001);
                let label = if t == 0 {
                    format!("auto({})", resolve_scan_threads(0))
                } else {
                    t.to_string()
                };
                println!(
                    "{:>9}  {:>10}  {:>8}  {:>8}  {:>12.1}  {:>12.0}",
                    label,
                    res.entries.len(),
                    res.errors.len(),
                    res.skipped.len(),
                    secs * 1000.0,
                    rate
                );
            }
            Err(e) => println!("{t:>9}  scan failed: {e}"),
        }
    }
}
