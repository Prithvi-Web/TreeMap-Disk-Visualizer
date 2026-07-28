# Rule packs

The known-offenders catalog behind **Smart Suggestions** (Clean Up ▸ Smart
Suggestions). Adding an offender is a JSON edit — no code change, no rebuild of
the matching logic. The loader and schema live in `../rulePacks.ts`; the matcher
that walks a scan lives in `../cleanupRules.ts`.

- `common.json` — rules that apply on every OS.
- `macos.json`, `windows.json`, `linux.json` — that OS's known locations.

Exactly two packs load on any machine: `common` plus the one for the current
platform. A malformed pack fails the whole catalog with a reason — Smart
Suggestions then reports itself unavailable and says why, while the rest of the
app boots normally. Half a catalog would silently stop suggesting things people
rely on, which is the worse failure.

## Rule shape

Every rule carries `id`, `kind`, `title`, `description`, `category`,
`confidence`, and the fields its kind requires. Unknown keys are rejected, so a
typo fails loudly instead of silently doing nothing.

| Field | Values |
| --- | --- |
| `category` | `regenerable`, `cache`, `junk` |
| `confidence` | `high`, `medium`, `low` |
| `action` | `trash` (default) or `advice` |
| `os` | optional subset of `darwin`, `win32`, `linux` |

### Kinds

| Kind | Matches | Extra fields |
| --- | --- | --- |
| `project-directory` | a folder by name, optionally only when a manifest sits beside it | `names`, `requiresSibling?`, `restoreCommand` |
| `directory` | a folder by name, with nothing to confirm it | `names` |
| `file` | a file by name | `names` |
| `location` | absolute known paths | `paths` |
| `stale-files` | files under a path, over a size, past an age | `withinPath`, `olderThanDays`, `minSizeBytes` |

Names and sibling patterns are matched case-insensitively. A sibling pattern
ending in `.*` matches any extension (`vite.config.*`).

Paths use `/` separators and these tokens: `{home}`, `{localAppData}`,
`{windir}`, `{systemDrive}`. A path whose token cannot be resolved on this
machine is dropped rather than matched half-expanded.

### Evaluation order

For a directory: `project-directory` → `directory` → `location`. For a file:
`file` → `stale-files`. Within each kind, pack order wins — which is how
`target` resolves to Rust or Maven by the manifest beside it. A directory
claimed by any rule is reported once and never descended into.

Several rules may share an `id` to merge into one suggestion group (the two
`regen-web-build` entries do). They must agree on title, description, category,
action and restore command, or the load fails: the group's own text cannot
depend on which rule happened to match first.

## `action: "advice"`

TreeMap's only destructive action is *move to Trash*. Some of the biggest
things on a disk must not be moved to the Trash — the file **is** the data, or
the OS owns it. Those get `action: "advice"`: the group is listed with its size
so the space is visible, but with no checkboxes, and with `adviceCommand`
showing the supported way to reclaim it.

## Deliberately absent

- **WinSxS** (`C:\Windows\WinSxS`). §C8 lists it, and it is genuinely huge, but
  it is the component store — most of it is hard links into the live system, the
  size Explorer reports is not the space it occupies, and deleting from it
  breaks Windows unrecoverably. `DISM /Online /Cleanup-Image
  /StartComponentCleanup` is the only correct tool, and it is not something
  TreeMap should run on a user's behalf. Listing it at all, even as advice,
  invites someone to try.
- **Anything under a live database or VM disk** beyond the Docker/WSL entries
  above, which are advice-only for the same reason.
