//! `tm-store`: the finalized scan store, built in Rust (Phase 4).
//!
//! [`build`](fn@build) takes the walk's columns ([`tm_walk::WalkOutput`], discovery order) and
//! produces `PackedScanStore`'s own columns (`src/services/scanStore.ts`): breadth-first
//! ids, each folder's children in one consecutive range, the same flag bits, the same
//! extension dictionary, names in one pool — with every fact the Node ingest
//! (`ingestColumns` in `src/services/scan/nativeEngine.ts`) derives, derived the same way,
//! so Node can adopt the columns as a finished store and emit byte-identical JSON.
//!
//! Two rules stay in Node, where their single source of truth lives, as passes over the
//! nodes the build names: the cloud-provider rule (a path regex,
//! `src/services/cloudFolders.ts`) over [`Store::cloud_candidates`], and JavaScript's
//! `toLowerCase` over [`Store::text_candidates`] (see [`derive::decided_here`]).
//! Neither list is short on every volume. Where the walk has no allocation size it
//! records 0 allocated — a Windows volume listed through `FindFirstFileExW` (tm-walk's
//! fallback, which its sources name for FAT32 and exFAT), and a macOS or Linux entry
//! whose allocation the file system withheld — so every file there that claims bytes
//! and is not a link is a cloud candidate. Every node whose name holds a non-ASCII byte
//! and a dot is a text candidate, however many there are.
//!
//! * [`derive`](mod@derive): the per-node rules, pure.
//! * [`finalize`]: the store's ids.
//! * [`build`](mod@build): the columns, the counters and the candidates.
//! * [`column`](mod@column): one column's storage.

pub mod build;
pub mod column;
pub mod derive;
pub mod finalize;

pub use build::{BuildOptions, Counters, Store, StoreMode, build};
pub use column::Column;
pub use derive::ContainerRule;

/// The store's flag bits: `Flag` in `src/services/scanStore.ts`, bit for bit.
pub mod flag {
    /// A folder.
    pub const DIR: u16 = 1;
    /// A children array exists (every folder; a file only once a container is expanded).
    pub const HAS_CHILD_ARRAY: u16 = 2;
    /// The name starts with a dot.
    pub const HIDDEN: u16 = 4;
    /// A later name of a hard-linked file: its bytes are counted at the first name.
    pub const HARDLINK_DUP: u16 = 8;
    /// A symbolic link.
    pub const SYMLINK: u16 = 16;
    /// A cloud placeholder: its bytes are not on this disk.
    pub const CLOUD_PLACEHOLDER: u16 = 32;
    /// A folder with a `.git` folder in it.
    pub const GIT_REPO: u16 = 64;
    /// A node inside an expanded container (never set by a scan).
    pub const VIRTUAL: u16 = 128;
    /// An access time was recorded.
    pub const HAS_ACCESSED: u16 = 256;
    /// Detached by `removeNode()` (never set by a scan).
    pub const REMOVED: u16 = 512;
}

/// The extension column's value for "no extension".
pub const EXT_NONE: u16 = 0;
/// The extension column's value for an extension past the dictionary's 65,534 entries,
/// whose text is in [`Store::ext_overflow`] (`extOverflow` in `scanStore.ts`).
pub const EXT_OVERFLOW: u16 = 0xffff;

/// Why a store could not be built.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum StoreError {
    /// The walk's columns break a promise the walk makes (lengths, order, offsets).
    #[error("the walk's output is malformed: {0}")]
    Malformed(String),
    /// More rows than the store's 32-bit signed ids can number.
    #[error("{rows} rows do not fit the store's 32-bit ids")]
    TooManyRows {
        /// The rows asked for, headroom included.
        rows: u64,
    },
    /// More name bytes than the store's 32-bit offsets reach.
    #[error("the names take {bytes} bytes, more than the store's 32-bit offsets reach")]
    NamesTooLong {
        /// The bytes the names would take.
        bytes: u64,
    },
    /// A container rule the build cannot apply as `detectContainerKind` would.
    #[error("container rule {index} ({text:?}) cannot be used: {why}")]
    BadContainerRule {
        /// Its place in the table.
        index: usize,
        /// Its text.
        text: String,
        /// What is wrong with it.
        why: &'static str,
    },
    /// A storage mode this build does not make yet.
    #[error("the {0:?} store is not built by this version")]
    ModeNotBuilt(StoreMode),
}
