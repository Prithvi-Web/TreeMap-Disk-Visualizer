//! Position paths (design §S.2): a node's place in its tree as the index of each step among
//! its parent's children, from the root down. Every order the aggregate's answers need is
//! read from them, never from ids, which a block-numbered walk hands out in no fixed order.

use std::cmp::Ordering;

/// A node's place in its tree: the index of each step among its parent's children, from the
/// root down, packed so that comparing two paths as bytes compares their indices in order, a
/// prefix first — pre-order.
///
/// Each index is a prefix code of one to five bytes, the leading ones of its first byte
/// counting the bytes after it: `0xxxxxxx`, `10xxxxxx` + 1, `110xxxxx` + 2, `1110xxxx` + 3,
/// `11110000` + 4, the value big-endian in the bits that are left. A longer code holds a
/// larger index and starts with a larger byte, and no code is the start of another, so byte
/// order is index order, and one path is a byte prefix of another exactly when it is an
/// ancestor.
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PositionPath {
    bytes: Vec<u8>,
}

impl PositionPath {
    /// The root's: no steps.
    pub fn root() -> Self {
        Self::default()
    }

    /// The path of `indices`, the root's first.
    pub fn from_indices(indices: &[u32]) -> Self {
        let mut path = Self::root();
        for &index in indices {
            push_index(&mut path.bytes, index);
        }
        path
    }

    /// The path of this node's child at `index`.
    #[must_use]
    pub fn child(&self, index: u32) -> Self {
        let mut bytes = Vec::with_capacity(self.bytes.len() + 5);
        bytes.extend_from_slice(&self.bytes);
        push_index(&mut bytes, index);
        Self { bytes }
    }

    /// The indices, the root's first.
    pub fn indices(&self) -> Vec<u32> {
        let mut out = Vec::new();
        let mut bytes = self.bytes.iter().copied();
        while let Some(first) = bytes.next() {
            let (more, bits) = code(first);
            let mut value = u32::from(bits);
            for _ in 0..more {
                let Some(byte) = bytes.next() else {
                    return out;
                };
                value = (value << 8) | u32::from(byte);
            }
            out.push(value);
        }
        out
    }

    /// How many steps from the root: the root's is 0.
    pub fn depth(&self) -> u32 {
        let mut depth = 0u32;
        let mut at = 0usize;
        while let Some(&first) = self.bytes.get(at) {
            let (more, _) = code(first);
            at += 1 + usize::from(more);
            depth += 1;
        }
        depth
    }

    /// The packed bytes.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Pre-order (design §S.2): the indices compared in order, a prefix — an ancestor —
    /// first. The same as `Ord`.
    pub fn pre_order(&self, other: &Self) -> Ordering {
        self.bytes.cmp(&other.bytes)
    }

    /// Post-order (design §S.2): a descendant before its ancestor, and otherwise the
    /// indices compared in order.
    pub fn post_order(&self, other: &Self) -> Ordering {
        let (mine, theirs) = (&self.bytes, &other.bytes);
        if mine.len() < theirs.len() && theirs.starts_with(mine) {
            Ordering::Greater
        } else if theirs.len() < mine.len() && mine.starts_with(theirs) {
            Ordering::Less
        } else {
            mine.cmp(theirs)
        }
    }

    /// Breadth-first order (design §S.2): the shallower first, and at one depth the
    /// indices compared in order — the order a FIFO breadth-first walk visits nodes in
    /// (Lemma 3).
    pub fn breadth_first(&self, other: &Self) -> Ordering {
        self.depth()
            .cmp(&other.depth())
            .then_with(|| self.bytes.cmp(&other.bytes))
    }
}

/// How many bytes follow a code's first byte, and the value bits the first byte holds.
fn code(first: u8) -> (u8, u8) {
    match first {
        0x00..=0x7F => (0, first),
        0x80..=0xBF => (1, first & 0x3F),
        0xC0..=0xDF => (2, first & 0x1F),
        0xE0..=0xEF => (3, first & 0x0F),
        0xF0..=0xFF => (4, 0),
    }
}

/// Appends `index`'s code.
fn push_index(bytes: &mut Vec<u8>, index: u32) {
    let [b0, b1, b2, b3] = index.to_be_bytes();
    if index < 0x80 {
        bytes.push(b3);
    } else if index < 0x4000 {
        bytes.extend_from_slice(&[0x80 | b2, b3]);
    } else if index < 0x20_0000 {
        bytes.extend_from_slice(&[0xC0 | b1, b2, b3]);
    } else if index < 0x1000_0000 {
        bytes.extend_from_slice(&[0xE0 | b0, b1, b2, b3]);
    } else {
        bytes.extend_from_slice(&[0xF0, b0, b1, b2, b3]);
    }
}
