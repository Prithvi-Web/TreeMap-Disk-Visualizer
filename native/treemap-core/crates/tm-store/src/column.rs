//! One column of the store.

/// One column: its rows in memory. Phase 4's spill step adds a private mapping of a
/// spill file beside `Owned`. Plain Node accepts external typed arrays, so a column can
/// reach JavaScript with no copy. Electron 31, the desktop app, refuses them
/// (`napi_no_external_buffers_allowed`), and napi-rs 3.4 then copies the rows into memory
/// V8 allocates, so there every column is copied and a mapping reaches JavaScript only as
/// a copy (RISKS R72, measured 23 Sep 2026).
#[derive(Clone, PartialEq, Debug)]
pub enum Column<T> {
    /// Rows in a `Vec` whose allocation has room for the store's headroom.
    Owned(Vec<T>),
}

impl<T> Column<T> {
    /// The rows.
    pub fn as_slice(&self) -> &[T] {
        match self {
            Self::Owned(rows) => rows,
        }
    }

    /// How many rows there are.
    pub fn len(&self) -> usize {
        self.as_slice().len()
    }

    /// Whether there are none.
    pub fn is_empty(&self) -> bool {
        self.as_slice().is_empty()
    }

    /// How many rows the allocation holds without growing.
    pub fn capacity(&self) -> usize {
        match self {
            Self::Owned(rows) => rows.capacity(),
        }
    }
}
