//! Path handling. Comparison keys are NFC-normalized, forward-slash relative
//! strings so that NFC/NFD variants of "the same" name collapse to one logical
//! entry. Actual IO joins the key onto a root and (on Windows) opts into
//! extended-length `\\?\` paths only when needed, to avoid the MAX_PATH ceiling
//! without disturbing ordinary paths.

use crate::error::{Result, SyncError};
use std::path::{Component, Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

/// Build the canonical comparison key for a relative path: NFC-normalized,
/// forward-slash separated, no leading slash.
pub fn nfc_key(rel: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for comp in rel.components() {
        if let Component::Normal(os) = comp {
            parts.push(os.to_string_lossy().nfc().collect::<String>());
        }
    }
    parts.join("/")
}

/// Reconstruct an on-disk path for `key` under `root`.
pub fn os_path(root: &Path, key: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for seg in key.split('/') {
        if !seg.is_empty() {
            p.push(seg);
        }
    }
    p
}

/// Case-folded key for collision detection against case-insensitive destinations.
pub fn case_fold(key: &str) -> String {
    key.to_lowercase()
}

/// On Windows, prefix with the extended-length namespace when the resulting path
/// risks exceeding MAX_PATH (260). Leaves short/relative paths untouched so the
/// common case is unaffected.
#[cfg(windows)]
pub fn extended(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\?\") || s.len() < 248 {
        return p.to_path_buf();
    }
    let backslashed = s.replace('/', r"\");
    if let Some(unc) = backslashed.strip_prefix(r"\\") {
        return PathBuf::from(format!(r"\\?\UNC\{unc}"));
    }
    if p.is_absolute() {
        return PathBuf::from(format!(r"\\?\{backslashed}"));
    }
    p.to_path_buf()
}

#[cfg(not(windows))]
pub fn extended(p: &Path) -> PathBuf {
    p.to_path_buf()
}

/// Reject keys that cannot be represented as files on the current OS rather than
/// silently mangling them (Windows strips trailing dots/spaces, forbids a set of
/// characters, and reserves device names).
#[cfg(windows)]
pub fn validate_representable(key: &str) -> Result<()> {
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    for seg in key.split('/') {
        if seg.is_empty() {
            continue;
        }
        if seg.ends_with(' ') || seg.ends_with('.') {
            return Err(SyncError::NotRepresentable {
                path: key.to_string(),
                reason: format!("segment '{seg}' has a trailing space or dot"),
            });
        }
        if let Some(bad) = seg.chars().find(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
            return Err(SyncError::NotRepresentable {
                path: key.to_string(),
                reason: format!("segment '{seg}' contains illegal character '{bad}'"),
            });
        }
        let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
        if RESERVED.contains(&stem.as_str()) {
            return Err(SyncError::NotRepresentable {
                path: key.to_string(),
                reason: format!("segment '{seg}' is a reserved device name"),
            });
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn validate_representable(_key: &str) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfc_key_uses_forward_slashes() {
        let p = Path::new("a").join("b").join("c.txt");
        assert_eq!(nfc_key(&p), "a/b/c.txt");
    }

    #[test]
    fn nfc_normalizes_decomposed_forms() {
        // U+0065 U+0301 (e + combining acute) must fold to U+00E9 (é).
        let decomposed = "cafe\u{0301}";
        let composed = "caf\u{00e9}";
        assert_eq!(nfc_key(Path::new(decomposed)), nfc_key(Path::new(composed)));
    }

    #[test]
    fn os_path_round_trips_segments() {
        let root = Path::new(if cfg!(windows) { r"C:\root" } else { "/root" });
        let p = os_path(root, "a/b/c.txt");
        assert!(p.ends_with("c.txt"));
        assert!(p.starts_with(root));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_reserved_and_illegal_names() {
        assert!(validate_representable("a/CON/b.txt").is_err());
        assert!(validate_representable("a/b.txt").is_ok());
        assert!(validate_representable("a/na:me.txt").is_err());
        assert!(validate_representable("a/trailing .txt").is_ok()); // dot/space only at segment END
        assert!(validate_representable("a/trailing ").is_err());
    }
}
