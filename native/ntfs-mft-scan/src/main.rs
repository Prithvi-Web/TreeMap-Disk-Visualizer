//! Dumps surviving NTFS FileName-attribute edges as NDJSON.
//!
//! "Surviving" = namespace is not pure DOS (an 8.3 short-name alias, not a
//! real second hardlink — see docs/superpowers/specs/2026-07-24-ntfs-mft-
//! engine-design.md §3.1), and at most one edge per (record, parent) pair
//! (a Posix + Win32 name for the SAME link collapses to one, preferring
//! Win32AndDos > Win32 > Posix).
//!
//! Usage:
//!   ntfs-mft-scan --volume C --out <path> [--log <path>]
//!   ntfs-mft-scan --volume C --root "Users\foo" --out <path> [--log <path>]
//!
//! With `--root`, only the requested subtree is written (plus a `_meta` line
//! carrying `targetRecordNo`). Whole-volume dumps are still supported when
//! `--root` is omitted. `--log` mirrors phase lines as `+<ms> msg` for the
//! Node timing journal (elevated stderr is otherwise invisible).
//!
//! Requires an elevated process token (enforced by ntfs_reader::Volume::new).
//!
//! Names are JSON-escaped (NOT Rust Debug `{:?}`): Debug emits `\u{…}` which
//! is invalid JSON and breaks the Node parser.

use ntfs_reader::api::{ntfs_to_unix_time, NtfsAttributeType, NtfsFileNamespace};
use ntfs_reader::mft::Mft;
use ntfs_reader::volume::Volume;
use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::process::ExitCode;
use std::time::Instant;

const ROOT_RECORD_NO: u64 = 5;

struct Args {
    volume: String,
    out: String,
    /// Path under the volume root, using `\` or `/` separators (e.g. `Users\foo`).
    root: Option<String>,
    /// Optional phase log (`+<ms> message` per line) for the Node timing journal.
    log: Option<String>,
}

struct PhaseLog {
    t0: Instant,
    file: Option<BufWriter<File>>,
}

impl PhaseLog {
    fn new(path: Option<&str>) -> Self {
        let file = path.and_then(|p| {
            File::create(p)
                .ok()
                .map(|f| BufWriter::with_capacity(64 * 1024, f))
        });
        Self {
            t0: Instant::now(),
            file,
        }
    }

    fn log(&mut self, msg: &str) {
        let ms = self.t0.elapsed().as_millis();
        let line = format!("+{ms}ms {msg}");
        eprintln!("{line}");
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    }
}

struct Edge {
    record_no: u64,
    parent_record_no: u64,
    name: String,
    size: u64,
    is_dir: bool,
    mtime_ms: i64,
}

fn parse_args() -> Option<Args> {
    let mut volume = None;
    let mut out = None;
    let mut root = None;
    let mut log = None;
    let mut it = env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--volume" => volume = it.next(),
            "--out" => out = it.next(),
            "--root" => root = it.next(),
            "--log" => log = it.next(),
            _ => {}
        }
    }
    Some(Args {
        volume: volume?,
        out: out?,
        root,
        log,
    })
}

/// Vendored verbatim from `ntfs-reader` 0.4.5's `src/mft.rs`
/// (`Mft::fixup_record`) — MIT OR Apache-2.0, Copyright (c) 2022 Matteo
/// Bernacchia (https://github.com/kikijiki/ntfs-reader). That function is
/// private to the crate (`fn fixup_record`, no `pub`), so it can't be called
/// from here directly. Copied rather than reimplemented from scratch: this
/// is NTFS's Update Sequence Array repair, and a subtly-wrong reimplementation
/// would silently corrupt every record read back rather than fail loudly.
/// See docs/superpowers/specs/2026-07-24-ntfs-mft-turbo-v2-design.md §3.
fn fixup_record(record_number: u64, data: &mut [u8]) -> ntfs_reader::errors::NtfsReaderResult<()> {
    use ntfs_reader::api::{NtfsFileRecordHeader, SECTOR_SIZE};
    use ntfs_reader::errors::NtfsReaderError;

    if data.len() < core::mem::size_of::<NtfsFileRecordHeader>() {
        return Err(NtfsReaderError::CorruptMftRecord { number: record_number });
    }
    let header =
        unsafe { core::ptr::read_unaligned(data.as_ptr() as *const NtfsFileRecordHeader) };

    let usn_start = header.update_sequence_offset as usize;
    if usn_start + 2 > data.len() {
        return Err(NtfsReaderError::CorruptMftRecord { number: record_number });
    }
    let usa_start = usn_start + 2;
    let usa_end =
        usn_start.saturating_add((header.update_sequence_length as usize).saturating_mul(2));
    if usa_end > data.len() {
        return Err(NtfsReaderError::CorruptMftRecord { number: record_number });
    }

    let usn0 = data[usn_start];
    let usn1 = data[usn_start + 1];

    let mut sector_off = SECTOR_SIZE - 2;
    for usa_off in (usa_start..usa_end).step_by(2) {
        if sector_off + 2 > data.len() {
            break;
        }

        let mut usa = [0u8; 2];
        usa.copy_from_slice(&data[usa_off..usa_off + 2]);

        let d0 = data[sector_off];
        let d1 = data[sector_off + 1];
        if d0 != usn0 || d1 != usn1 {
            return Err(NtfsReaderError::CorruptMftRecord { number: record_number });
        }

        data[sector_off..sector_off + 2].copy_from_slice(&usa);
        sector_off += SECTOR_SIZE;
    }
    Ok(())
}

/** Preference order when a record has multiple surviving names at the SAME
 *  parent (Posix+Win32 for one link): higher wins. */
fn namespace_rank(ns: u8) -> u8 {
    match ns {
        x if x == NtfsFileNamespace::Win32AndDos as u8 => 3,
        x if x == NtfsFileNamespace::Win32 as u8 => 2,
        x if x == NtfsFileNamespace::Posix as u8 => 1,
        _ => 0, // Dos-only never reaches here, filtered out below
    }
}

/// JSON string body rules: quote/control escapes only; UTF-8 passes through.
fn write_json_string<W: Write>(w: &mut W, s: &str) -> std::io::Result<()> {
    w.write_all(b"\"")?;
    for ch in s.chars() {
        match ch {
            '"' => w.write_all(b"\\\"")?,
            '\\' => w.write_all(b"\\\\")?,
            '\u{08}' => w.write_all(b"\\b")?,
            '\u{0c}' => w.write_all(b"\\f")?,
            '\n' => w.write_all(b"\\n")?,
            '\r' => w.write_all(b"\\r")?,
            '\t' => w.write_all(b"\\t")?,
            c if (c as u32) < 0x20 => write!(w, "\\u{:04x}", c as u32)?,
            c => {
                let mut buf = [0u8; 4];
                w.write_all(c.encode_utf8(&mut buf).as_bytes())?;
            }
        }
    }
    w.write_all(b"\"")
}

fn write_edge<W: Write>(w: &mut W, e: &Edge) -> std::io::Result<()> {
    write!(
        w,
        "{{\"recordNo\":{},\"parentRecordNo\":{},\"name\":",
        e.record_no, e.parent_record_no
    )?;
    write_json_string(w, &e.name)?;
    write!(
        w,
        ",\"size\":{},\"isDir\":{},\"mtimeMs\":{}}}\n",
        e.size, e.is_dir, e.mtime_ms
    )
}

fn resolve_target(
    edges_by_parent: &HashMap<u64, Vec<usize>>,
    edges: &[Edge],
    root: &str,
) -> Option<u64> {
    let components: Vec<&str> = root.split(['\\', '/']).filter(|c| !c.is_empty()).collect();
    if components.is_empty() {
        return Some(ROOT_RECORD_NO);
    }
    let mut current = ROOT_RECORD_NO;
    for part in components {
        let children = edges_by_parent.get(&current)?;
        let match_idx = children.iter().copied().find(|&i| {
            let e = &edges[i];
            e.is_dir && e.name.eq_ignore_ascii_case(part)
        })?;
        current = edges[match_idx].record_no;
    }
    Some(current)
}

/** Indices of edges whose parent is inside the target subtree (BFS). */
fn subtree_edge_indices(
    edges_by_parent: &HashMap<u64, Vec<usize>>,
    edges: &[Edge],
    target: u64,
) -> Vec<usize> {
    let mut out = Vec::new();
    let mut seen_dirs = HashSet::new();
    let mut q = VecDeque::new();
    seen_dirs.insert(target);
    q.push_back(target);
    while let Some(parent) = q.pop_front() {
        let Some(children) = edges_by_parent.get(&parent) else {
            continue;
        };
        for &idx in children {
            out.push(idx);
            let e = &edges[idx];
            if e.is_dir && seen_dirs.insert(e.record_no) {
                q.push_back(e.record_no);
            }
        }
    }
    out
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Some(a) => a,
        None => {
            eprintln!(
                "usage: ntfs-mft-scan --volume C [--root Users\\foo] --out <path> [--log <path>]"
            );
            return ExitCode::FAILURE;
        }
    };

    let mut phase = PhaseLog::new(args.log.as_deref());
    phase.log("start");

    // Create the out file before the slow Volume/Mft open so the parent can
    // see the elevated process has started (file exists, size still 0).
    let out_file = match File::create(&args.out) {
        Ok(f) => f,
        Err(e) => {
            phase.log(&format!("failed to create output file: {e}"));
            return ExitCode::FAILURE;
        }
    };
    let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, out_file);

    let volume_path = format!("\\\\.\\{}:", args.volume);
    phase.log(&format!("opening volume {volume_path}"));
    let volume = match Volume::new(&volume_path) {
        Ok(v) => v,
        Err(e) => {
            phase.log(&format!("failed to open volume (are we elevated?): {e}"));
            return ExitCode::FAILURE;
        }
    };
    phase.log("loading MFT index…");
    let mft = match Mft::new(volume) {
        Ok(m) => m,
        Err(e) => {
            phase.log(&format!("failed to read MFT: {e}"));
            return ExitCode::FAILURE;
        }
    };
    phase.log("enumerating FileName edges…");

    let mut edges: Vec<Edge> = Vec::with_capacity(1_000_000);
    for file in mft.files() {
        let is_dir = file.is_directory();
        let record_no = file.number();

        let mut best_per_parent: HashMap<u64, (u8, String)> = HashMap::new();
        let mut size: u64 = 0;
        let mut mtime_ms: i64 = 0;

        file.attributes(|att| {
            if att.header.type_id == NtfsAttributeType::StandardInformation as u32 {
                if let Some(info) = att.as_standard_info() {
                    mtime_ms = ntfs_to_unix_time(info.modification_time).unix_timestamp() * 1000;
                }
            }
            if att.header.type_id == NtfsAttributeType::Data as u32 {
                if att.header.is_non_resident == 0 {
                    if let Some(h) = att.resident_header() {
                        size = h.value_length as u64;
                    }
                } else if let Some(h) = att.nonresident_header() {
                    size = h.data_size;
                }
            }
            if let Some(fname) = att.as_name() {
                let ns = fname.header.namespace;
                if ns == NtfsFileNamespace::Dos as u8 {
                    return; // 8.3 alias, not a real second link
                }
                let parent = fname.parent();
                let rank = namespace_rank(ns);
                let entry = best_per_parent
                    .entry(parent)
                    .or_insert((rank, fname.to_string()));
                if rank > entry.0 {
                    *entry = (rank, fname.to_string());
                }
            }
        });

        for (parent_record_no, (_, name)) in best_per_parent {
            edges.push(Edge {
                record_no,
                parent_record_no,
                name,
                size,
                is_dir,
                mtime_ms,
            });
        }
    }
    phase.log(&format!("indexed {} edges", edges.len()));

    let mut edges_by_parent: HashMap<u64, Vec<usize>> = HashMap::new();
    for (i, e) in edges.iter().enumerate() {
        edges_by_parent
            .entry(e.parent_record_no)
            .or_default()
            .push(i);
    }

    let target = if let Some(ref root) = args.root {
        match resolve_target(&edges_by_parent, &edges, root) {
            Some(t) => t,
            None => {
                phase.log(&format!("could not resolve --root {root}"));
                return ExitCode::FAILURE;
            }
        }
    } else {
        ROOT_RECORD_NO
    };

    let emit_indices: Vec<usize> = if args.root.is_some() {
        let idxs = subtree_edge_indices(&edges_by_parent, &edges, target);
        phase.log(&format!(
            "subtree filter: {} / {} edges (target record {target})",
            idxs.len(),
            edges.len()
        ));
        idxs
    } else {
        (0..edges.len()).collect()
    };

    if writeln!(writer, "{{\"_meta\":true,\"targetRecordNo\":{target}}}").is_err() {
        phase.log("failed writing meta");
        return ExitCode::FAILURE;
    }

    let mut edges_written: u64 = 0;
    for idx in emit_indices {
        if write_edge(&mut writer, &edges[idx]).is_err() {
            phase.log("failed writing output");
            return ExitCode::FAILURE;
        }
        edges_written += 1;
        if edges_written % 250_000 == 0 {
            let _ = writer.flush();
            phase.log(&format!("wrote {edges_written} edges…"));
        }
    }

    if writer.flush().is_err() {
        phase.log("failed flushing output");
        return ExitCode::FAILURE;
    }
    phase.log(&format!("done — {edges_written} edges"));
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::{fixup_record, write_json_string};

    #[test]
    fn json_string_escapes_controls_not_rust_debug() {
        let mut buf = Vec::new();
        // Controls must be \uXXXX; non-ASCII may stay as raw UTF-8 (valid JSON).
        // Never emit Rust Debug's `\u{…}` form — that is what broke Node's parser.
        write_json_string(&mut buf, "a\"b\\c\n\u{0001}\u{202e}").unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert_eq!(s, "\"a\\\"b\\\\c\\n\\u0001\u{202e}\"");
        assert!(!s.contains("\\u{"));
        assert!(s.contains("\\u0001"));
    }

    #[test]
    fn fixup_record_restores_sector_end_bytes_from_the_usa() {
        // A minimal synthetic record: header + a 2-sector (1024-byte) body.
        // update_sequence_offset points past the header; update_sequence_length
        // is 3 (1 USN + 2 sector-fixup entries, matching a 1024-byte/2-sector
        // record) per the real NTFS on-disk format.
        let mut data = vec![0u8; 1024];
        let usn_offset: u16 = 48; // arbitrary, past a real header's fixed fields
        let usn_length: u16 = 3;
        data[4..6].copy_from_slice(&usn_offset.to_le_bytes()); // update_sequence_offset
        data[6..8].copy_from_slice(&usn_length.to_le_bytes()); // update_sequence_length

        let usa_start = usn_offset as usize + 2;
        // The USN marker value at usa_start-2..usa_start (index 0 of the USA)
        let marker: [u8; 2] = [0xAB, 0xCD];
        data[usn_offset as usize..usa_start].copy_from_slice(&marker);
        // Two real sector-end bytes, saved in the USA, and the sector ends
        // themselves overwritten with the marker (as NTFS does on disk).
        let real_sector0: [u8; 2] = [0x11, 0x22];
        let real_sector1: [u8; 2] = [0x33, 0x44];
        data[usa_start..usa_start + 2].copy_from_slice(&real_sector0);
        data[usa_start + 2..usa_start + 4].copy_from_slice(&real_sector1);
        data[510..512].copy_from_slice(&marker); // sector 0 end, corrupted on-disk
        data[1022..1024].copy_from_slice(&marker); // sector 1 end, corrupted on-disk

        fixup_record(0, &mut data).expect("valid USA should fix up cleanly");

        assert_eq!(&data[510..512], &real_sector0, "sector 0 end must be restored");
        assert_eq!(&data[1022..1024], &real_sector1, "sector 1 end must be restored");
    }

    #[test]
    fn fixup_record_rejects_a_sector_end_that_does_not_match_the_marker() {
        let mut data = vec![0u8; 1024];
        let usn_offset: u16 = 48;
        let usn_length: u16 = 3;
        data[4..6].copy_from_slice(&usn_offset.to_le_bytes());
        data[6..8].copy_from_slice(&usn_length.to_le_bytes());
        let usa_start = usn_offset as usize + 2;
        data[usn_offset as usize..usa_start].copy_from_slice(&[0xAB, 0xCD]);
        data[usa_start..usa_start + 4].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
        // Sector 0's last 2 bytes DON'T match the marker — corrupt/torn write.
        data[510..512].copy_from_slice(&[0x00, 0x00]);

        let result = fixup_record(0, &mut data);
        assert!(result.is_err(), "a mismatched sector-end marker must be rejected, not silently accepted");
    }
}
