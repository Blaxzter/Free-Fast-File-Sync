//! Ad-hoc scan throughput probe (NOT shipped). Measures how the parallel walk
//! scales with thread count against a real path — esp. a high-latency network
//! share. Each run is capped by a deadline so a slow NAS doesn't run forever.
//!
//!   cargo run --example scanbench -- "\\\\NAS\\share" [gitignore]
//!
//! The 2nd arg (any value) turns gitignore matching ON to measure its overhead.

use ignore::{WalkBuilder, WalkState};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

fn bench(path: &Path, threads: usize, gitignore: bool, cap: Duration) {
    let counter = AtomicU64::new(0);
    let deadline = Instant::now() + cap;
    let start = Instant::now();
    let mut b = WalkBuilder::new(path);
    b.hidden(true)
        .git_ignore(gitignore)
        .git_exclude(gitignore)
        .git_global(false)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .threads(threads);
    b.build_parallel().run(|| {
        Box::new(|res| {
            if Instant::now() > deadline {
                return WalkState::Quit;
            }
            if let Ok(d) = res {
                let _ = d.metadata(); // mimic our scan's per-entry stat
                counter.fetch_add(1, Ordering::Relaxed);
            }
            WalkState::Continue
        })
    });
    let n = counter.load(Ordering::Relaxed);
    let secs = start.elapsed().as_secs_f64();
    let rate = n as f64 / secs.max(0.001);
    println!(
        "  threads={threads:>3}  gitignore={gitignore:<5}  {n:>7} items  {secs:>5.1}s  = {rate:>7.0} items/s"
    );
}

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: scanbench <path> [gitignore]");
    let gitignore = std::env::args().nth(2).is_some();
    let path = Path::new(&path);
    println!("scanning {} (cap 12s/run)", path.display());
    // Vary threads; repeat 4 + 64 to expose any OS-cache warm-up effect.
    for t in [4usize, 16, 32, 64, 128, 4, 64] {
        bench(path, t, gitignore, Duration::from_secs(12));
    }
}
