//! Typed engine error. Serializes across the Tauri IPC boundary as a rejected
//! promise. Distinguishes transient (locked/sharing-violation), permanent
//! (ACL/path-too-long) and logic (baseline/desync) failures so the apply step
//! can decide retry-vs-skip and never count a failed op as success.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, thiserror::Error, Serialize, Clone)]
#[serde(tag = "kind", content = "detail")]
pub enum SyncError {
    #[error("io error at {path}: {msg}")]
    Io { path: String, msg: String },

    #[error("file is locked (in use): {path}")]
    Locked { path: String },

    #[error("permission denied: {path}")]
    PermissionDenied { path: String },

    #[error("path too long for the target filesystem: {path}")]
    PathTooLong { path: String },

    #[error("path not representable on this OS: {path} ({reason})")]
    NotRepresentable { path: String, reason: String },

    #[error("unsupported entry {path}: {reason}")]
    Unsupported { path: String, reason: String },

    #[error("invalid job: {0}")]
    InvalidJob(String),

    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, SyncError>;

impl SyncError {
    /// Classify an `io::Error` against a path, mapping Windows sharing/ACL codes
    /// so the caller can treat them as transient-vs-permanent.
    pub fn from_io(path: &Path, e: &std::io::Error) -> Self {
        let p = path.display().to_string();
        // Windows-specific raw codes that ErrorKind doesn't surface yet.
        #[cfg(windows)]
        if let Some(code) = e.raw_os_error() {
            match code {
                32 | 33 => return SyncError::Locked { path: p }, // SHARING / LOCK violation
                5 => return SyncError::PermissionDenied { path: p }, // ACCESS_DENIED
                206 | 3 => return SyncError::PathTooLong { path: p }, // FILENAME_EXCED_RANGE / PATH_NOT_FOUND on overlong
                _ => {}
            }
        }
        match e.kind() {
            std::io::ErrorKind::PermissionDenied => SyncError::PermissionDenied { path: p },
            _ => SyncError::Io { path: p, msg: e.to_string() },
        }
    }

    /// True when retrying later (e.g. an antivirus/editor lock cleared) is sane.
    /// Reserved for the retry policy in the watcher milestone.
    #[allow(dead_code)]
    pub fn is_transient(&self) -> bool {
        matches!(self, SyncError::Locked { .. })
    }
}
