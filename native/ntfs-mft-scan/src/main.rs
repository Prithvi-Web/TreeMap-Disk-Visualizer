//! Dumps every surviving NTFS FileName-attribute edge on a volume as NDJSON.
//!
//! "Surviving" = namespace is not pure DOS (an 8.3 short-name alias, not a
//! real second hardlink — see docs/superpowers/specs/2026-07-24-ntfs-mft-
//! engine-design.md §3.1), and at most one edge per (record, parent) pair
//! (a Posix + Win32 name for the SAME link collapses to one, preferring
//! Win32AndDos > Win32 > Posix). Everything else — path resolution, subtree
//! selection, hardlink dedup across distinct parents — is the TypeScript
//! mapper's job (src/services/ntfsMftMapper.ts), not this binary's.
//!
//! Usage: ntfs-mft-scan --volume C --out <path>
//! Requires an elevated process token (enforced by ntfs_reader::Volume::new).
//!
//! Import note (verified against docs.rs/ntfs-reader/0.4.5): NtfsAttributeType,
//! NtfsFileNamespace, and ntfs_to_unix_time live in `ntfs_reader::api`, not
//! `ntfs_reader::attribute` (the plan's draft import path was wrong).

use ntfs_reader::api::{ntfs_to_unix_time, NtfsAttributeType, NtfsFileNamespace};
use ntfs_reader::mft::Mft;
use ntfs_reader::volume::Volume;
use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::process::ExitCode;

struct Args {
    volume: String,
    out: String,
}

fn parse_args() -> Option<Args> {
    let mut volume = None;
    let mut out = None;
    let mut it = env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--volume" => volume = it.next(),
            "--out" => out = it.next(),
            _ => {}
        }
    }
    Some(Args { volume: volume?, out: out? })
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

fn main() -> ExitCode {
    let args = match parse_args() {
        Some(a) => a,
        None => {
            eprintln!("usage: ntfs-mft-scan --volume C --out <path>");
            return ExitCode::FAILURE;
        }
    };

    let volume_path = format!("\\\\.\\{}:", args.volume);
    let volume = match Volume::new(&volume_path) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("failed to open volume (are we elevated?): {e}");
            return ExitCode::FAILURE;
        }
    };
    let mft = match Mft::new(volume) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("failed to read MFT: {e}");
            return ExitCode::FAILURE;
        }
    };

    let out_file = match File::create(&args.out) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("failed to create output file: {e}");
            return ExitCode::FAILURE;
        }
    };
    let mut writer = BufWriter::new(out_file);

    for file in mft.files() {
        let is_dir = file.is_directory();
        let record_no = file.number();

        // Collect (parent, name, namespace), then keep only the best
        // namespace per distinct parent — see namespace_rank above.
        let mut best_per_parent: HashMap<u64, (u8, String)> = HashMap::new();
        let mut size: u64 = 0;
        let mut mtime_ms: i64 = 0;

        file.attributes(|att| {
            if att.header.type_id == NtfsAttributeType::StandardInformation as u32 {
                if let Some(info) = att.as_standard_info() {
                    mtime_ms = ntfs_to_unix_time(info.modification_time)
                        .unix_timestamp()
                        * 1000;
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
                let entry = best_per_parent.entry(parent).or_insert((rank, fname.to_string()));
                if rank > entry.0 {
                    *entry = (rank, fname.to_string());
                }
            }
        });

        for (parent_record_no, (_, name)) in best_per_parent {
            let line = format!(
                "{{\"recordNo\":{record_no},\"parentRecordNo\":{parent_record_no},\"name\":{name:?},\"size\":{size},\"isDir\":{is_dir},\"mtimeMs\":{mtime_ms}}}\n"
            );
            if writer.write_all(line.as_bytes()).is_err() {
                eprintln!("failed writing output");
                return ExitCode::FAILURE;
            }
        }
    }

    ExitCode::SUCCESS
}
