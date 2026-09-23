//! From parsed records to the scan root's subtree, in the column shape the
//! Windows listing walk produces ([`tm_walk::WalkOutput`]), so the store, the
//! JSON and the equivalence gate cannot tell the two engines apart.
//!
//! [`RecordTable`] holds the in-use base records by number, with every
//! extension record's attributes merged into its base by the base reference
//! (decision W6-5: `$ATTRIBUTE_LIST` is never read). [`build_tree`] then walks
//! breadth first from the root. A directory's children are every non-DOS
//! `$FILE_NAME` naming it as the parent with its current sequence number (a
//! name naming an older sequence is an orphan of a deleted-and-reused
//! directory), in the order NTFS indexes them: upper-cased through the
//! volume's own `$UpCase` table, unit by unit ([`collate`]). Each name is one
//! entry, so a file with two links is two entries sharing one file reference.
//!
//! Every entry is staged by the listing's own `stage_record`, from the facts
//! the directory's index would have reported — the attributes (with
//! `FILE_ATTRIBUTE_DIRECTORY` from the record header, where NTFS keeps it),
//! the reparse tag, the unnamed stream's size and allocation, the times, the
//! file reference as the file id — so kind, size, flags, times, withheld
//! attributes and the accounting of an entry `lstat` would fail are the
//! listing's rules by construction. The per-entry bookkeeping after that
//! mirrors `tm_walk::walk`: the entry counters, a directory whose name holds
//! a separator refused, and hard-link families found by file-id collision.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt;
use std::path::Path;
use std::time::Instant;

use tm_walk::platform::windows::{
    DirFacts, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, Record as ListedRecord,
    ReparseSource, count_entry_error, filetime_ms, is_dataless, is_dot_entry, stage_record,
};
use tm_walk::platform::{Listing, Meta, thread_cpu_seconds};
use tm_walk::{
    DirRefusal, FLAG_DATALESS, FLAG_REFUSED_DIR, FastPath, KIND_DIR, KIND_FILE, LinkKey, Refusal,
    WalkOutput, WalkStats, hardlink_families,
};

use crate::record::{NAMESPACE_DOS, Record};

/// `$UpCase` holds one upper-case unit for each of the 65,536 UTF-16 units.
pub const UPCASE_UNITS: usize = 65_536;
/// Records 0-15 are NTFS's own metadata files (`$MFT`, `$MFTMirr`,
/// `$LogFile`, `$Volume`, `$AttrDef`, the root `.`, `$Bitmap`, `$Boot`,
/// `$BadClus`, `$Secure`, `$UpCase`, `$Extend` and four reserved), which
/// directory enumeration never returns; the first user record is 16.
pub const FIRST_USER_RECORD: u64 = 16;
/// `ERROR_NOT_A_REPARSE_POINT`: what `FSCTL_GET_REPARSE_POINT` fails with
/// when the listing reads a reparse point whose data is not there — the
/// accounting used for a record flagged as one without a readable value.
pub const ERROR_NOT_A_REPARSE_POINT: u32 = 4390;
/// In-use base records by number, each with its extension records'
/// attributes merged in, and the volume's serial number (the `dev` of every
/// hard-link key, as `GetFileInformationByHandle`'s `dwVolumeSerialNumber`).
#[derive(Clone, Debug, Default)]
pub struct RecordTable {
    volume_serial: u32,
    records: HashMap<u64, Record>,
    /// Extension records read before their base, by the base's number.
    waiting: HashMap<u64, Vec<Record>>,
}

impl RecordTable {
    /// An empty table for the volume whose serial number is `volume_serial`.
    pub fn new(volume_serial: u32) -> Self {
        Self {
            volume_serial,
            ..Self::default()
        }
    }

    /// Adds one parsed record, in any order. A record not in use is dropped.
    /// An extension record is merged into its base (now, or when the base
    /// arrives) only if its base reference names the base's current
    /// sequence number; one whose base never arrives is never used.
    pub fn insert(&mut self, record: Record) {
        if !record.in_use {
            return;
        }
        if record.is_extension() {
            match self.records.get_mut(&record.base) {
                Some(base) => merge(base, record),
                None => self.waiting.entry(record.base).or_default().push(record),
            }
            return;
        }
        let mut base = record;
        for extension in self.waiting.remove(&base.number).unwrap_or_default() {
            merge(&mut base, extension);
        }
        self.records.insert(base.number, base);
    }

    /// The base record numbered `number`, merged.
    pub fn get(&self, number: u64) -> Option<&Record> {
        self.records.get(&number)
    }

    /// How many base records the table holds.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// True when the table holds no base record.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// The volume's serial number.
    pub fn volume_serial(&self) -> u32 {
        self.volume_serial
    }
}

/// Folds an extension record into its base: every name it carries, and each
/// attribute the base does not hold itself (a base's own always wins).
fn merge(base: &mut Record, extension: Record) {
    if extension.base_seq != base.sequence {
        // The base was deleted and its record reused since this was written.
        return;
    }
    base.names.extend(extension.names);
    base.std_info = base.std_info.or(extension.std_info);
    if base.data_size.is_none() {
        base.data_size = extension.data_size;
        base.data_alloc = extension.data_alloc;
    }
    base.reparse = base.reparse.take().or(extension.reparse);
    base.reparse_nonresident |= extension.reparse_nonresident;
}

/// Why no tree was built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildError {
    /// The `$UpCase` table does not hold 65,536 units.
    BadUpcase {
        /// How many it holds.
        units: usize,
    },
    /// The root's record is not in the table (not in use, or never read).
    RootNotFound {
        /// The root's record number.
        root: u64,
    },
    /// The root's record is not a directory.
    RootNotDirectory {
        /// The root's record number.
        root: u64,
    },
    /// The root is a reparse point (a junction, a mount point, a cloud
    /// folder): the listing walk follows or refuses it through the OS, and
    /// where it leads is not in this volume's records.
    RootIsReparsePoint {
        /// The root's record number.
        root: u64,
    },
    /// More nodes than a `u32` column index can number.
    TooManyNodes,
    /// Names past the 4 GiB a `u32` offset can address.
    NamesTooLarge,
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadUpcase { units } => {
                write!(f, "the $UpCase table holds {units} units, not 65,536")
            }
            Self::RootNotFound { root } => write!(f, "record {root} is not an in-use record"),
            Self::RootNotDirectory { root } => write!(f, "record {root} is not a directory"),
            Self::RootIsReparsePoint { root } => write!(f, "record {root} is a reparse point"),
            Self::TooManyNodes => f.write_str("the tree exceeds 4,294,967,294 entries"),
            Self::NamesTooLarge => f.write_str("the names exceed 4 GiB"),
        }
    }
}

impl std::error::Error for BuildError {}

/// NTFS's file-name collation: both names upper-cased unit by unit through
/// the volume's `$UpCase` table (a unit past the table is its own upper
/// case) and compared in order, a prefix first; names equal once upper-cased
/// (only a case-sensitive directory can hold two) are then ordered by their
/// raw units.
pub fn collate(a: &[u16], b: &[u16], upcase: &[u16]) -> Ordering {
    let up = |u: &u16| upcase.get(usize::from(*u)).copied().unwrap_or(*u);
    a.iter()
        .map(up)
        .cmp(b.iter().map(up))
        .then_with(|| a.cmp(b))
}

/// One name of one record inside a directory: the record, and which of its names.
#[derive(Clone, Copy, Debug)]
struct Child {
    record: u64,
    name: usize,
}

/// A name as the listing reports it: up to its first NUL unit.
fn until_nul(units: &[u16]) -> &[u16] {
    units.split(|u| *u == 0).next().unwrap_or(units)
}

/// A name as Node decodes it: UTF-8 with U+FFFD for every lone surrogate.
fn utf8_lossy(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn signed(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// The attributes the directory's index reports for `rec`: `$STANDARD_INFORMATION`'s,
/// with the directory bit NTFS derives from the record header.
fn attributes_of(rec: &Record) -> u32 {
    let dir_bit = if rec.is_dir {
        FILE_ATTRIBUTE_DIRECTORY
    } else {
        0
    };
    rec.std_info.map_or(0, |s| s.attributes) | dir_bit
}

fn reparse_tag(value: &[u8]) -> Option<u32> {
    let bytes = value.get(..4)?;
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

/// A record's reparse data, as `FSCTL_GET_REPARSE_POINT` would return it.
struct RecordReparse<'a>(Option<&'a [u8]>);

impl ReparseSource for RecordReparse<'_> {
    fn reparse_data(&self, _dir: &Path, _name: &[u16]) -> Result<Vec<u8>, u32> {
        self.0.map(<[u8]>::to_vec).ok_or(ERROR_NOT_A_REPARSE_POINT)
    }
}

/// Every non-DOS name of every record, under the directory it names as its
/// parent, with the parent's sequence number as the name recorded it.
fn children_index(records: &RecordTable) -> HashMap<u64, Vec<(u16, Child)>> {
    let mut index: HashMap<u64, Vec<(u16, Child)>> = HashMap::new();
    for rec in records.records.values() {
        for (name, n) in rec.names.iter().enumerate() {
            if n.namespace == NAMESPACE_DOS {
                continue;
            }
            index.entry(n.parent).or_default().push((
                n.parent_seq,
                Child {
                    record: rec.number,
                    name,
                },
            ));
        }
    }
    index
}

fn name_units(records: &RecordTable, child: Child) -> &[u16] {
    records
        .get(child.record)
        .and_then(|r| r.names.get(child.name))
        .map_or(&[], |n| until_nul(&n.name))
}

/// `dir`'s entries in index order: its names that carry its current sequence
/// number, never a metafile's.
fn sorted_children(
    index: &HashMap<u64, Vec<(u16, Child)>>,
    dir: &Record,
    records: &RecordTable,
    upcase: &[u16],
) -> Vec<Child> {
    let mut kids: Vec<Child> = index
        .get(&dir.number)
        .into_iter()
        .flatten()
        .filter(|(seq, child)| *seq == dir.sequence && child.record >= FIRST_USER_RECORD)
        .map(|(_, child)| *child)
        .collect();
    kids.sort_by(|a, b| {
        collate(name_units(records, *a), name_units(records, *b), upcase)
            .then(a.record.cmp(&b.record))
            .then(a.name.cmp(&b.name))
    });
    kids
}

/// Stages one name of one record into `listing` through the listing's own
/// `stage_record`, from the facts the directory's index would report, and
/// says whether it became an entry (the listing omits, and counts, an entry
/// its `lstat` would fail). A reparse point whose value the record does not
/// hold (non-resident, or missing) is counted as the listing counts a failed
/// `FSCTL_GET_REPARSE_POINT`; a record without `$STANDARD_INFORMATION` is
/// kept with unknown times and counted withheld.
fn stage_child(
    records: &RecordTable,
    child: Child,
    facts: DirFacts,
    listing: &mut Listing,
) -> bool {
    let Some(rec) = records.get(child.record) else {
        return false;
    };
    let name: Vec<u8> = until_nul(name_units(records, child))
        .iter()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    // A listing never reports `.` or `..` as an entry, so a record a damaged
    // table gives either name is skipped the same way; a name that is not one
    // name otherwise is `stage_record`’s to count.
    if is_dot_entry(&name) {
        return false;
    }
    let attributes = attributes_of(rec);
    let tag = if attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        0
    } else if let Some(tag) = rec.reparse.as_deref().and_then(reparse_tag) {
        tag
    } else {
        count_entry_error(ERROR_NOT_A_REPARSE_POINT, listing);
        return false;
    };
    let listed = ListedRecord {
        name: &name,
        attributes,
        reparse_tag: tag,
        // A directory has no unnamed stream, and `stage_record` sizes it 0
        // whatever its end of file says.
        end_of_file: signed(rec.data_size.unwrap_or(0)),
        allocation: if rec.is_dir {
            Some(0)
        } else {
            rec.data_alloc.map(signed)
        },
        last_write: rec.std_info.map_or(0, |s| s.last_write),
        last_access: rec.std_info.map_or(0, |s| s.last_access),
        file_id: Some(u128::from(rec.reference())),
    };
    let before = listing.len();
    stage_record(
        &listed,
        facts,
        Path::new(""),
        &RecordReparse(rec.reparse.as_deref()),
        listing,
    );
    if listing.len() == before {
        return false;
    }
    // A record without `$STANDARD_INFORMATION` has no times, and a file
    // without its unnamed stream no size: kept, with the unknown values, and
    // counted withheld — which the listing's own rule no longer infers from
    // a missing allocation (RISKS R55, 23 Sep 2026).
    let no_times = rec.std_info.is_none();
    let no_size = !rec.is_dir && rec.data_size.is_none();
    if no_times || no_size {
        if let Some(entry) = listing.entries.last_mut() {
            if no_times {
                entry.meta.mtime_ms = f64::NAN;
                entry.meta.atime_ms = f64::NAN;
            }
            entry.meta.withheld = true;
        }
    }
    true
}

/// The root's own facts, as the listing walk's `stat_dir` reads the root.
fn root_meta(rec: &Record, want_atime: bool) -> Meta {
    let s = rec.std_info;
    Meta {
        kind: KIND_DIR,
        flags: if is_dataless(s.map_or(0, |s| s.attributes), 0) {
            FLAG_DATALESS
        } else {
            0
        },
        size: 0.0,
        alloc: 0.0,
        mtime_ms: s.map_or(f64::NAN, |s| filetime_ms(s.last_write)),
        atime_ms: match s {
            Some(s) if want_atime => filetime_ms(s.last_access),
            _ => f64::NAN,
        },
        dev: 0.0,
        ino: 0,
        nlink: 0,
        withheld: false,
    }
}

/// The root's own name: its first non-DOS name (`.` for a volume's root).
/// The listing walk names the root after the path it was given, which the
/// records do not know: see [`with_root_name`].
fn root_name(rec: &Record) -> String {
    rec.names
        .iter()
        .find(|n| n.namespace != NAMESPACE_DOS)
        .map(|n| utf8_lossy(until_nul(&n.name)))
        .unwrap_or_default()
}

/// The columns being built and what the walk would have counted.
struct Columns {
    parent: Vec<u32>,
    name_off: Vec<u32>,
    names: Vec<u8>,
    kind: Vec<u8>,
    flags: Vec<u8>,
    size: Vec<f64>,
    alloc: Vec<f64>,
    mtime: Vec<f64>,
    atime: Vec<f64>,
    refusals: Vec<DirRefusal>,
    /// Leaves without a link count, keyed exactly as the walk keys them.
    candidates: Vec<LinkKey>,
    dirs_listed: u64,
    denied: u64,
    unreadable: u64,
    dataless: u64,
}

impl Columns {
    fn new() -> Self {
        Self {
            parent: Vec::new(),
            name_off: vec![0],
            names: Vec::new(),
            kind: Vec::new(),
            flags: Vec::new(),
            size: Vec::new(),
            alloc: Vec::new(),
            mtime: Vec::new(),
            atime: Vec::new(),
            refusals: Vec::new(),
            candidates: Vec::new(),
            dirs_listed: 0,
            denied: 0,
            unreadable: 0,
            dataless: 0,
        }
    }

    /// Appends a node and returns its index; ids stop below `u32::MAX` as
    /// the walk's do.
    fn push(&mut self, parent: u32, name: &[u8], meta: &Meta) -> Result<u32, BuildError> {
        let id = u32::try_from(self.parent.len())
            .ok()
            .filter(|id| *id < u32::MAX)
            .ok_or(BuildError::TooManyNodes)?;
        let end = self
            .names
            .len()
            .checked_add(name.len())
            .and_then(|n| u32::try_from(n).ok())
            .ok_or(BuildError::NamesTooLarge)?;
        self.names.extend_from_slice(name);
        self.name_off.push(end);
        self.parent.push(parent);
        self.kind.push(meta.kind);
        self.flags.push(meta.flags);
        self.size.push(meta.size);
        self.alloc.push(meta.alloc);
        self.mtime.push(meta.mtime_ms);
        self.atime.push(meta.atime_ms);
        Ok(id)
    }

    fn finish(mut self, started: Instant, cpu_started: f64) -> WalkOutput {
        // The walk's own rule, so the two engines cannot drift: a family is an
        // id seen more than once, told apart by the whole reference, never by
        // a double (the pre-landing review of 23 Sep 2026). Nothing here needs
        // the families' refresh — every name of a record reads that record.
        let (hardlinks, _) = hardlink_families(&mut self.candidates);
        self.refusals.sort_by_key(|r| r.node);
        for refusal in &self.refusals {
            if let Some(flags) = self.flags.get_mut(refusal.node as usize) {
                *flags |= FLAG_REFUSED_DIR;
            }
        }
        let entries = u64::try_from(self.parent.len())
            .unwrap_or(u64::MAX)
            .saturating_sub(1);
        WalkOutput {
            parent: self.parent,
            name_off: self.name_off,
            names: self.names,
            kind: self.kind,
            flags: self.flags,
            size: self.size,
            alloc_bytes: self.alloc,
            mtime_ms: self.mtime,
            atime_ms: self.atime,
            hardlinks,
            refusals: self.refusals,
            stats: WalkStats {
                dirs_listed: self.dirs_listed,
                entries,
                wall_ms: started.elapsed().as_secs_f64() * 1e3,
                cpu_seconds: thread_cpu_seconds() - cpu_started,
                // The table was read, not listed (correction 5, M6): the
                // stats say "mft".
                fast_path: FastPath::Mft,
                workers_peak: 1,
                climb_steps: 0,
                denied_entries: self.denied,
                unreadable_entries: self.unreadable,
                dataless: self.dataless,
            },
        }
    }
}

/// The subtree of the directory record `root`, breadth first, a directory's
/// children in `$UpCase` collation order, in the listing walk's column shape.
/// Node 0 carries the root record's own name until [`with_root_name`] gives
/// it the path's. `WalkStats::wall_ms` and `cpu_seconds` measure this build
/// alone; the volume reader adds its own reads.
pub fn build_tree(
    records: &RecordTable,
    root: u64,
    upcase: &[u16],
    want_atime: bool,
) -> Result<WalkOutput, BuildError> {
    let started = Instant::now();
    let cpu_started = thread_cpu_seconds();
    if upcase.len() != UPCASE_UNITS {
        return Err(BuildError::BadUpcase {
            units: upcase.len(),
        });
    }
    let root_record = records.get(root).ok_or(BuildError::RootNotFound { root })?;
    if !root_record.is_dir {
        return Err(BuildError::RootNotDirectory { root });
    }
    // The listing's own test: the attribute NTFS sets with the reparse point.
    if attributes_of(root_record) & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(BuildError::RootIsReparsePoint { root });
    }
    let index = children_index(records);
    let facts = DirFacts {
        dev: records.volume_serial,
        want_atime,
    };
    let mut out = Columns::new();
    out.push(
        0,
        root_name(root_record).as_bytes(),
        &root_meta(root_record, want_atime),
    )?;
    let mut listing = Listing::default();
    let mut queue = VecDeque::from([(0_u32, root)]);
    let mut queued = HashSet::from([root]);
    while let Some((dir_node, number)) = queue.pop_front() {
        let Some(dir) = records.get(number) else {
            continue;
        };
        out.dirs_listed += 1;
        listing.clear();
        let mut staged = Vec::new();
        for child in sorted_children(&index, dir, records, upcase) {
            if stage_child(records, child, facts, &mut listing) {
                staged.push(child.record);
            }
        }
        out.denied += listing.denied_entries;
        out.unreadable += listing.unreadable_entries;
        for (entry, record) in listing.entries.iter().zip(staged) {
            let name = listing.name(entry);
            let meta = entry.meta;
            let id = out.push(dir_node, name, &meta)?;
            if meta.withheld {
                out.unreadable += 1;
            }
            if meta.flags & FLAG_DATALESS != 0 {
                out.dataless += 1;
            }
            if meta.kind == KIND_DIR {
                // A directory already listed or queued under another name (a
                // corrupt table, or a cycle) would be listed twice or forever,
                // so it is refused. (A name holding a separator never gets
                // here: `stage_record` counted it unreadable.)
                if queued.insert(record) {
                    queue.push_back((id, record));
                } else {
                    out.refusals.push(DirRefusal {
                        node: id,
                        why: Refusal::Unreadable,
                    });
                }
            } else if meta.kind == KIND_FILE && !meta.withheld {
                // `stage_record` never reports a link count on Windows, so
                // every readable file is a collision candidate.
                out.candidates.push(LinkKey {
                    dev: meta.dev.to_bits(),
                    ino: meta.ino,
                    node: id,
                    counted: false,
                });
            }
        }
    }
    Ok(out.finish(started, cpu_started))
}

/// `out` with node 0 renamed `name`: the listing walk names the root after
/// the path it was given (its last component, or the whole path when it has
/// none, such as `C:\`), which the volume reader knows and the records do
/// not. An output without nodes is returned as it is.
pub fn with_root_name(mut out: WalkOutput, name: &str) -> Result<WalkOutput, BuildError> {
    let (Some(&start), Some(&end)) = (out.name_off.first(), out.name_off.get(1)) else {
        return Ok(out);
    };
    let old_len = end.saturating_sub(start);
    let new_len = u32::try_from(name.len()).map_err(|_| BuildError::NamesTooLarge)?;
    let mut names = Vec::with_capacity(name.len().saturating_add(out.names.len()));
    names.extend_from_slice(name.as_bytes());
    names.extend_from_slice(out.names.get(end as usize..).unwrap_or_default());
    let name_off = std::iter::once(Ok(0))
        .chain(out.name_off.iter().skip(1).map(|off| {
            off.checked_sub(old_len)
                .and_then(|o| o.checked_add(new_len))
                .ok_or(BuildError::NamesTooLarge)
        }))
        .collect::<Result<Vec<u32>, BuildError>>()?;
    out.names = names;
    out.name_off = name_off;
    Ok(out)
}
