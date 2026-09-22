//! Every platform without a native listing (macOS, Windows and Linux have
//! one). The probe says so in words and `start` refuses, so the Node side runs
//! the legacy chain with the reason in the stats.

use std::path::Path;

use crate::{FastPath, Probe};

/// The sentence the probe and [`crate::WalkError::Unsupported`] carry.
pub fn reason() -> String {
    format!(
        "the native listing is not built for {} yet",
        std::env::consts::OS
    )
}

/// [`crate::probe`] here: unavailable, with the reason.
pub fn probe(_root: &Path) -> Probe {
    Probe {
        fast_path: FastPath::Unavailable,
        reason: reason(),
    }
}
