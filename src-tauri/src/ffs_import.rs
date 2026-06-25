//! Best-effort importer for FreeFileSync `.ffs_batch` / `.ffs_gui` configs so an
//! existing setup migrates without re-entering every folder pair and exclude by
//! hand. The mapping:
//!   * each `<Pair>` Left/Right        -> a job's two roots
//!   * `<Compare><Variant>Content`     -> verify_by_hash
//!   * `<DeletionPolicy>RecycleBin`    -> use_recycle_bin
//!   * path-based `<Exclude><Item>`s   -> custom_globs (applied to both roots)
//!   * two-way `<Changes>` vs one-way `<Differences>` mirror -> two_way flag
//!
//! FreeFileSync filters are path globs with `\` separators, a leading `\` to
//! anchor at the root, a trailing `\` for "this directory", and a `*\` prefix
//! meaning "at any depth" — all of which translate cleanly to gitignore-style
//! globs. Anything that doesn't map cleanly is flagged for the user to review.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ImportedJob {
    pub name: String,
    pub left: String,
    pub right: String,
    /// false => FreeFileSync had this as a one-way mirror (Left -> Right).
    pub two_way: bool,
    pub use_recycle_bin: bool,
    pub verify_by_hash: bool,
    pub exclude_globs: Vec<String>,
    pub warnings: Vec<String>,
    /// A hint when many excludes are redundant with .gitignore.
    pub gitignore_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FfsImport {
    pub jobs: Vec<ImportedJob>,
    pub notes: Vec<String>,
}

type Node<'a> = roxmltree::Node<'a, 'a>;

pub fn parse_ffs(xml: &str) -> Result<FfsImport, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("not valid XML: {e}"))?;
    let root = doc.root_element();
    if !root.has_tag_name("FreeFileSync") {
        return Err("this is not a FreeFileSync config (missing <FreeFileSync> root)".into());
    }

    let global_verify = compare_is_content(child(root, "Compare"));
    let global_sync = child(root, "Synchronize");
    let global_two_way = detect_two_way(global_sync);
    let global_recycle = deletion_is_recycle(global_sync);
    let (global_excludes, mut notes) = collect_excludes(child(root, "Filter"));

    let mut jobs = Vec::new();
    if let Some(pairs) = child(root, "FolderPairs") {
        for pair in pairs.children().filter(|n| n.has_tag_name("Pair")) {
            let left = child(pair, "Left")
                .and_then(|n| n.text())
                .unwrap_or("")
                .trim()
                .to_string();
            let right = child(pair, "Right")
                .and_then(|n| n.text())
                .unwrap_or("")
                .trim()
                .to_string();
            if left.is_empty() || right.is_empty() {
                continue;
            }

            let pair_sync = child(pair, "Synchronize");
            let two_way = match pair_sync {
                Some(_) => detect_two_way(pair_sync),
                None => global_two_way,
            };
            let recycle = match pair_sync {
                Some(_) => deletion_is_recycle(pair_sync),
                None => global_recycle,
            };
            let verify = match child(pair, "Compare") {
                Some(c) => compare_is_content(Some(c)),
                None => global_verify,
            };

            // FreeFileSync combines a pair's local filter with the global one.
            let mut globs = global_excludes.clone();
            if child(pair, "Filter").is_some() {
                let (local, mut local_notes) = collect_excludes(child(pair, "Filter"));
                globs.extend(local);
                notes.append(&mut local_notes);
            }
            dedup(&mut globs);

            let mut warnings = Vec::new();
            if !two_way {
                warnings.push(
                    "FreeFileSync had this pair as a one-way mirror (left → right). \
                     fast-file-sync currently does two-way sync, which would also propagate \
                     deletions back from the right side — review before applying."
                        .into(),
                );
            }
            if left.starts_with("\\\\") || right.starts_with("\\\\") {
                warnings.push(
                    "This pair targets a network share (UNC path); it must be online to sync."
                        .into(),
                );
            }
            let gitignore_hint = gitignore_hint(&globs);

            jobs.push(ImportedJob {
                name: derive_name(&left, &right),
                left,
                right,
                two_way,
                use_recycle_bin: recycle,
                verify_by_hash: verify,
                exclude_globs: globs,
                warnings,
                gitignore_hint,
            });
        }
    }

    dedup(&mut notes);
    if jobs.is_empty() {
        return Err("no folder pairs found in this config".into());
    }
    Ok(FfsImport { jobs, notes })
}

fn child<'a>(n: Node<'a>, tag: &str) -> Option<Node<'a>> {
    n.children().find(|c| c.has_tag_name(tag))
}

fn compare_is_content(compare: Option<Node>) -> bool {
    compare
        .and_then(|c| child(c, "Variant"))
        .and_then(|v| v.text())
        .map(|t| t.eq_ignore_ascii_case("Content"))
        .unwrap_or(false)
}

fn deletion_is_recycle(sync: Option<Node>) -> bool {
    sync.and_then(|s| child(s, "DeletionPolicy"))
        .and_then(|d| d.text())
        .map(|t| t.eq_ignore_ascii_case("RecycleBin"))
        .unwrap_or(true) // FreeFileSync's default is the recycle bin
}

fn detect_two_way(sync: Option<Node>) -> bool {
    let sync = match sync {
        Some(s) => s,
        None => return true,
    };
    if child(sync, "TwoWay").is_some() {
        return true;
    }
    if let Some(changes) = child(sync, "Changes") {
        let left_to_right = child(changes, "Left").map(|l| attrs_point(l, "right")).unwrap_or(false);
        let right_to_left = child(changes, "Right").map(|r| attrs_point(r, "left")).unwrap_or(false);
        return left_to_right && right_to_left;
    }
    if let Some(diff) = child(sync, "Differences") {
        let vals: Vec<&str> = ["LeftOnly", "LeftNewer", "RightNewer", "RightOnly"]
            .iter()
            .filter_map(|a| diff.attribute(*a))
            .collect();
        if vals.is_empty() {
            return true;
        }
        // All directions identical => a one-way mirror, not two-way.
        let uniform = vals.iter().all(|v| *v == vals[0]);
        return !uniform;
    }
    true
}

fn attrs_point(n: Node, dir: &str) -> bool {
    ["Create", "Update", "Delete"]
        .iter()
        .any(|a| n.attribute(*a) == Some(dir))
}

fn collect_excludes(filter: Option<Node>) -> (Vec<String>, Vec<String>) {
    let mut globs = Vec::new();
    let mut notes = Vec::new();
    if let Some(f) = filter {
        if let Some(excl) = child(f, "Exclude") {
            for item in excl.children().filter(|c| c.has_tag_name("Item")) {
                if let Some(text) = item.text() {
                    let (g, note) = ffs_to_glob(text);
                    if let Some(g) = g {
                        globs.push(g);
                    }
                    if let Some(note) = note {
                        notes.push(note);
                    }
                }
            }
        }
    }
    (globs, notes)
}

/// Translate one FreeFileSync filter item to a gitignore-style glob. Returns the
/// glob plus an optional review note when the source didn't map cleanly.
fn ffs_to_glob(item: &str) -> (Option<String>, Option<String>) {
    let raw = item.trim();
    let mut review = false;

    // FFS uses ' | ' inside a field to separate include from exclude; in an
    // Exclude item that's unusual — take the first non-empty token and flag it.
    let pat = if raw.contains('|') {
        review = true;
        raw.split('|').map(|s| s.trim()).find(|s| !s.is_empty()).unwrap_or("")
    } else {
        raw
    };
    if pat.is_empty() {
        return (None, None);
    }
    // A trailing `\*` (contents-of) doesn't have an exact gitignore equivalent.
    if pat.ends_with("\\*") {
        review = true;
    }

    let mut g = pat.replace('\\', "/");
    // `*/foo` in FFS means "foo at any depth"; a gitignore pattern without a
    // leading slash already matches at any depth, so drop the prefix.
    if let Some(stripped) = g.strip_prefix("*/") {
        g = stripped.to_string();
    }

    let note = if review {
        Some(format!("Review imported exclude: '{}'  →  '{}'", raw, g))
    } else {
        None
    };
    (Some(g), note)
}

fn gitignore_hint(globs: &[String]) -> Option<String> {
    const COMMON: &[&str] = &[
        "node_modules", ".git", "build", "dist", "__pycache__", "venv", ".venv", ".nuxt",
        ".angular", ".yarn", ".idea", ".terraform", ".pytest_cache", ".ruff_cache", ".settings",
        "target", ".metadata", "bin",
    ];
    let n = globs
        .iter()
        .filter(|g| {
            let s = g.trim_start_matches('/').trim_end_matches('/');
            COMMON.iter().any(|c| s == *c || s.ends_with(c))
        })
        .count();
    if n >= 3 {
        Some(format!(
            "{n} of these excludes (node_modules, .git, build, dist, __pycache__, .venv…) are \
             usually already covered by .gitignore. With “Respect .gitignore” on you can likely \
             drop most of them."
        ))
    } else {
        None
    }
}

fn derive_name(left: &str, right: &str) -> String {
    let last = |p: &str| {
        p.trim_end_matches(['\\', '/'])
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(p)
            .to_string()
    };
    let l = last(left);
    if l.is_empty() {
        format!("{left} ↔ {right}")
    } else {
        l
    }
}

fn dedup(v: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    v.retain(|x| seen.insert(x.clone()));
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<FreeFileSync XmlType="BATCH" XmlFormat="23">
  <Compare><Variant>TimeAndSize</Variant><Symlinks>Exclude</Symlinks></Compare>
  <Synchronize>
    <Changes>
      <Left Create="right" Update="right" Delete="right"/>
      <Right Create="left" Update="left" Delete="left"/>
    </Changes>
    <DeletionPolicy>RecycleBin</DeletionPolicy>
  </Synchronize>
  <Filter>
    <Include><Item>*</Item></Include>
    <Exclude>
      <Item>\System Volume Information\</Item>
      <Item>*\node_modules\</Item>
      <Item>*\.git\</Item>
      <Item>*.gdoc</Item>
      <Item>*\__pycache__\</Item>
      <Item>*.venv |</Item>
      <Item>*desktop.ini</Item>
      <Item>\bin\</Item>
    </Exclude>
  </Filter>
  <FolderPairs>
    <Pair>
      <Left Threads="4">C:\Users\mail\Documents\ShareX\Screenshots</Left>
      <Right Threads="4">\\NAS\home\Screenshots</Right>
    </Pair>
    <Pair>
      <Left Threads="4">E:\MyDocuments</Left>
      <Right Threads="4">\\NAS\home\MyDocuments</Right>
    </Pair>
    <Pair>
      <Left Threads="4">E:\Programming</Left>
      <Right Threads="4">\\NAS\home\Programming</Right>
      <Synchronize>
        <Differences LeftOnly="right" LeftNewer="right" RightNewer="right" RightOnly="right"/>
        <DeletionPolicy>RecycleBin</DeletionPolicy>
      </Synchronize>
      <Filter>
        <Include><Item>*</Item></Include>
        <Exclude><Item>*\.ruff_cache</Item></Exclude>
      </Filter>
    </Pair>
  </FolderPairs>
</FreeFileSync>"#;

    #[test]
    fn parses_pairs_and_modes() {
        let imp = parse_ffs(SAMPLE).unwrap();
        assert_eq!(imp.jobs.len(), 3);
        assert_eq!(imp.jobs[1].left, "E:\\MyDocuments");
        assert_eq!(imp.jobs[1].right, "\\\\NAS\\home\\MyDocuments");
        assert_eq!(imp.jobs[1].name, "MyDocuments");
        // pairs 1 & 2 are two-way; pair 3 is a one-way mirror.
        assert!(imp.jobs[0].two_way);
        assert!(imp.jobs[1].two_way);
        assert!(!imp.jobs[2].two_way);
        assert!(imp.jobs[0].use_recycle_bin);
        assert!(!imp.jobs[0].verify_by_hash); // TimeAndSize, not Content
    }

    #[test]
    fn translates_filters() {
        let g = &parse_ffs(SAMPLE).unwrap().jobs[0].exclude_globs;
        assert!(g.contains(&"/System Volume Information/".to_string()));
        assert!(g.contains(&"node_modules/".to_string()));
        assert!(g.contains(&".git/".to_string()));
        assert!(g.contains(&"__pycache__/".to_string()));
        assert!(g.contains(&"*.gdoc".to_string()));
        assert!(g.contains(&"*desktop.ini".to_string()));
        assert!(g.contains(&"/bin/".to_string()));
        assert!(g.contains(&"*.venv".to_string())); // from "*.venv |"
    }

    #[test]
    fn local_filter_combines_with_global() {
        let imp = parse_ffs(SAMPLE).unwrap();
        // pair 3 keeps the global excludes AND its own .ruff_cache.
        assert!(imp.jobs[2].exclude_globs.contains(&"node_modules/".to_string()));
        assert!(imp.jobs[2].exclude_globs.iter().any(|x| x.contains(".ruff_cache")));
    }

    #[test]
    fn flags_gitignore_redundancy_and_review_notes() {
        let imp = parse_ffs(SAMPLE).unwrap();
        assert!(imp.jobs[0].gitignore_hint.is_some());
        assert!(imp.notes.iter().any(|n| n.contains("*.venv")));
    }

    #[test]
    fn rejects_non_ffs() {
        assert!(parse_ffs("<html></html>").is_err());
        assert!(parse_ffs("not xml at all <").is_err());
    }

    // Opt-in smoke test against a real config:
    //   FFS_FILE="E:\MyDocuments\NASSyncSettings.ffs_batch" cargo test real_file -- --ignored --nocapture
    #[test]
    #[ignore = "set FFS_FILE to a real .ffs_batch path to run"]
    fn real_file() {
        let path = std::env::var("FFS_FILE").expect("set FFS_FILE");
        let xml = std::fs::read_to_string(path).unwrap();
        let imp = parse_ffs(&xml).unwrap();
        eprintln!("\n{} folder pair(s):", imp.jobs.len());
        for j in &imp.jobs {
            eprintln!(
                "  • {}  [{}]  {} excludes{}",
                j.name,
                if j.two_way { "two-way" } else { "one-way mirror" },
                j.exclude_globs.len(),
                if j.gitignore_hint.is_some() { "  (gitignore can cover most)" } else { "" },
            );
            eprintln!("      {}  {}  {}", j.left, if j.two_way { "<->" } else { "-->" }, j.right);
        }
        eprintln!("\nsample translated globs (pair 1):");
        for g in imp.jobs[0].exclude_globs.iter().take(12) {
            eprintln!("    {g}");
        }
        eprintln!("\n{} review note(s)", imp.notes.len());
        assert!(!imp.jobs.is_empty());
    }
}
