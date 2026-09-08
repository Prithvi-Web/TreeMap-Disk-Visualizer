# Changelog

All notable changes to TreeMap are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and TreeMap uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [5.0.1] — 2026-09-07

Every bug reported against 5.0.0 is fixed in this release; the four reports
are linked below. Numbers and dates now read the English way on every
machine, and the Windows pages say Windows things.

### Changed

- **The mouse pointer inside TreeMap is now TreeMap's own.** Instead of the
  system arrow, hand and I-beam you see one small dot, drawn eight ways:
  plain, over something clickable, in a text field, ready to grab, dragging,
  crosshair, resizing and disabled. It is pale on the dark theme and ink-dark
  on the light one, and each shape has a thin edge in the opposite shade so
  it stays visible on a treemap tile of its own colour.
- The dot is a true system cursor, so it moves exactly with your hand, never
  lags, and never disappears while TreeMap is busy. Every hover effect is
  unchanged: the dot tells you what kind of thing is under it, and the
  control's own highlight still tells you which one.

### Fixed

- **A release could lose its installers, with no way to get them back.** On
  GitHub the download files belong to the release page, not to the version
  number, so when the v5.0.0 page was deleted and made again it came back
  with nothing to download
  ([#32](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/issues/32)).
  Two things changed. A new release is
  published only after both installers are attached and checked, one by one,
  by name and size, so a release with an empty download list is no longer
  possible. And a release
  that has lost its files can have them rebuilt and put back (Actions →
  Build & Release → Run workflow → type the tag). What you will see: every
  release page lists the macOS and Windows installers.
- **Windows restore points are measured in every language, and without
  guessing.** The Missing GB receipt and the Dashboard now ask Windows for
  the space its restore points use as plain numbers. Before, TreeMap read the
  text Windows prints on screen (`vssadmin`) and looked for English labels in
  it; on a Portuguese Windows that text reads "Espaço de armazenamento de
  cópias de sombra usado: 7,98 GB", so nothing was found and the receipt
  showed nothing
  ([#33](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/issues/33)).
  The receipt for one drive no longer counts another drive's restore points;
  when Windows cannot say which drive a restore point belongs to, the receipt
  says the figure covers the whole PC. Windows normally shows that space only
  to an administrator. When it is withheld, the receipt says so and tells you
  how to see it: quit TreeMap from its icon in the system tray, then start it
  with Run as administrator. The tray step matters: if a copy is still
  running there, the administrator copy closes at once and you would think
  nothing happened.
- **Windows and Linux are no longer told about the Mac** in the Dashboard,
  the Missing GB receipt, the preview pane and the first-run card. On
  Windows, TreeMap used to talk about Time Machine, Full Disk Access and
  "This Mac". Every one of those sentences now names your own system:
  restore points and running as an administrator on Windows, "This PC", and
  plain words like "this computer" until TreeMap knows which system it is
  on. The receipt's example of a file that reserves more room than it fills
  is now a Windows one (WSL's ext4.vhdx) rather than Docker.raw, and the hint
  for installing the video re-encoder names the Windows tool (winget) instead
  of the Mac one (Homebrew). This is the other half of the #33 report.
- **Numbers and dates are written the English way on every machine.** On a
  Portuguese or German computer TreeMap printed "1.234 shapes" beside
  "1.2 GB", the same dot meaning thousands in one number and tenths in the
  other. On an Arabic computer it printed Arabic-Indic digits inside English
  sentences. Counts had followed the computer's regional settings while sizes
  always used an English decimal point
  ([#34](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/issues/34)).
  Every count TreeMap shows, on screen, in its messages and in exported
  reports, is now "1,234", and dates read "Sep 6, 2026" rather than
  "6 de set. de 2026". The clock stays your own, 10:31 PM or 22:31,
  whichever your computer uses, and so does the time zone. If your computer
  is not set to English you will notice this: TreeMap's numbers and dates
  now match the English words around them. TreeMap is now checked on a
  Portuguese-language computer so this cannot slip back.
- **Disk Topology on Windows now shows each drive letter under the drive it
  is stored on.** On a Windows PC with two or more drives, the Dashboard's
  Disk Topology card said "No volumes on this disk." under every drive. C:
  and D: were then listed on their own below, as if they belonged to no drive
  ([#35](https://github.com/Prithvi-Web/TreeMap-Disk-Visualizer/issues/35)).
  TreeMap now asks Windows which drive each letter is stored on. What you
  will see: C: under the first SSD and D: under the second, each with its own
  usage bar, and the stray cards gone. Two drives of the same model are told
  apart as "(Disk 0)" and "(Disk 1)", the same numbers Windows' Disk
  Management shows. If your PC uses Storage Spaces, Windows' way of pooling
  several drives into one, the pooled letter sits under one combined card
  that names only the drives in that pool. Each of those drives says "Part
  of the pool below.", and the drive Windows starts from is no longer shown
  as part of the pool. A locked BitLocker drive still appears under its
  drive, but its size and free space are shown as unknown rather than as 0.
  A drive letter that Windows does not tie to any drive keeps its own card
  instead of being guessed onto one, and if Windows does not say which drive
  any letter lives on, the card says so. Single-drive PCs look the same as
  before.

## [5.0.0] — 2026-09-02

The first public release since 3.2.1. Everything below landed in the seven
months of work between them — the whole 4.x line was developed in the open
repository but never published, so this is the release where all of it
arrives at once.

If you are upgrading from 3.2.1, the short version: TreeMap now tells you
what is *safe* to delete rather than only what is *big*, it can account for
every gigabyte on the volume rather than only the ones it walked, and the
numbers it prints have been audited against the code that produces them.

### Added

**Deciding what to delete**

- **Reclaim Score.** Every file and folder gets a score out of 100 for how
  safe *and* how worthwhile it is to remove, built from six signals: size
  against this scan's own spread, how long since it was last opened, whether
  a rule says it rebuilds itself, whether an identical copy is on this disk,
  whether it was downloaded, and whether a copy exists elsewhere.
- A badge beside each score opens a breakdown that says what every signal
  contributed and, in amber, what could not be measured. A signal TreeMap
  cannot read is named and left out — never counted as zero.
- A treemap colour mode and a sort that answer "what is safest to delete"
  instead of "what is biggest".
- The six weights are yours to change in Settings, with a reset. Setting one
  to zero removes that signal rather than scoring it worthless.
- A radar chart shows all six signals as one shape, so two files compare by
  silhouette. A signal that could not be measured keeps its spoke and the
  outline breaks around it.
- **Last-opened dates**, with the source that answered them named — and an
  honest "not available here" where the operating system does not record
  them, never a stand-in date.
- **"Does a copy of this exist elsewhere?"** — a recoverability verdict from
  Git, backups and cloud sync, with its reasons. It is never promoted to a
  definite yes by inference: a folder that is merely absent from a backup
  exclusion list is *unknown*, not *backed up*.

**Searching**

- A search grammar: `size>100mb ext:mp4`, `-in:node_modules`,
  `modified>90d`, `used>1y`, `git:pushed`, `score>70`.
- A live query box with autocomplete, and saved views you can pin as chips.
- **Ask in plain words.** The ✨ button turns "big videos I haven't opened in
  a year" into a real query, and always shows you the translation in an
  editable field before it runs. It works entirely offline, and words it
  ignored are listed rather than silently dropped.
- A saved view can become a Clean Up rule, and a Clean Up rule can become an
  Autopilot policy, pre-filled.

**The cleanup cart**

- An optional cleanup target in Settings ("free 50 GB") gives the cart a
  meter filling toward it. A meter and nothing else: no streaks, no badges,
  no confetti.
- Add to cart from every view that lists something reclaimable — Empty
  Folders, Clean Up rule matches, per-game shader caches, and "Stage N
  matches" from a treemap query.
- **Preview after.** The map re-lays itself with the staged items taken out,
  and the freed space stays on the map as a hatched block, so every rectangle
  still means the same number of bytes.
- Committing the cart runs through the Time Capsule as one undoable run — a
  dry run first, always, then one summary with a one-click undo that puts
  everything back at its original paths, even after the Trash has been
  emptied. Undo restores the original dates as well as the bytes.

**New views**

- **Missing GB.** One accounting statement for the volume, printed as a
  receipt that either adds up or names the gap. It shows what a files-only
  tool cannot: other volumes sharing the same storage pool (about 12 GB on a
  Mac), space held by programs still gripping a deleted file, and what the
  scan was refused. A line nobody can measure prints "unknown" with its
  reason — never 0.
- **Disk City.** The treemap's own tiling seen from a corner, encoding three
  things at once: footprint is bytes, height is staleness (or file count, or
  depth), colour is Reclaim score (or file kind, or age).
- Two more renderers on the same toolbar: **circle packing** and a **Voronoi
  treemap**, sharing the root, breadcrumbs, depth, colour mode and exports.
- A **lasso** (drag, or freehand with Alt) that stages what you draw around,
  with a live count inside the loop, and a **magnifier** (hold Z) that
  redraws the map at 4× so two-pixel tiles become readable names.
- **History**, holding **Calendar** (a year of writes, one cell per day —
  click or drag a range to filter the map), **Journal** (a plain-English
  record of significant changes, naming an app only when the path proves it
  and saying "an unidentified process" otherwise), and **Compare** with a
  photo-style split slider that wipes between two snapshots.
- **Media libraries** in the Libraries tab: Photos, Final Cut, iMovie,
  Lightroom and Capture One, split into originals / derivatives / database,
  with a cart button on derivatives only and the cost of regenerating each
  one stated.
- A **duplicate compare viewer** on every exact group and near-duplicate
  cluster — copies side by side with thumbnails, dimensions, the EXIF capture
  date or its honest absence, the differing blocks painted over
  near-duplicates, and the recommended keeper with the rule that picked it.
- A **drive dock** under the map listing attached external drives and their
  free space. Drag the cart onto one to offload. A drive whose statistics
  cannot be read is still listed, with the reason.

**Playing back and exporting**

- Transport controls on the time slider — play/pause, ½× to 4×, loop — that
  play a folder's history as a film.
- Export that history as an animated **GIF** (written by hand, no dependency,
  encoded off the main thread) or a **WebM** where the runtime can record a
  canvas. The menu says which you are getting.

**Getting around**

- A **command palette** on ⌘K covering every view, every action, your saved
  views, recent scan roots, eleven Settings sections, and "search files for…"
  for anything else.
- A **guided first run** that walks you through picking a folder, watching
  the scan land, reading the map, and up to three real quick wins from your
  own disk. Skippable at every step.
- **Folder notes.** Right-click any folder to pin words to it. A note pauses
  suggestions and automation for that whole subtree by default, and Autopilot
  reports the skip rather than quietly matching less.
- **Human-scale sizes.** Beside a large folder the tooltip can add "≈ 3,100
  photos or 42 videos like the ones here" — always averaged from that
  folder's own media, never from a made-up constant. A folder with nothing
  comparable says nothing.
- **Budget gauges** on the Dashboard: "at this pace, over in ~23 days (Sep
  22)", or the forecast's own refusal when the history is too short, too
  erratic or shrinking.

**The desktop app**

- TreeMap remembers its window — size, position, display, maximised and
  full-screen — and comes back where you left it.
- A real application menu: Settings ⌘, Scan Folder ⌘O, Rescan ⌘R, a Help
  menu, and an About panel with the version.
- Dock progress during a scan, and a bounce plus a notification when a long
  scan finishes while the window is not focused.
- Dropping several folders queues them instead of losing all but one.

**For agents and scripts**

- Two new MCP tools, `reclaim_ranked` and `missing_gigabytes`, bringing the
  total to ten.
- Eighteen new API routes, all described in the published OpenAPI document.

### Changed

- The **Games** tab became **Libraries** and now holds media libraries
  alongside game libraries.
- Calendar, Journal and Compare became one **History** tab with an internal
  segment that remembers where you were. The sidebar went from seventeen tabs
  to fifteen.
- **⌘K now opens the command palette.** `/` still summons global search.
- **The Duplicates tab opens instantly.** It used to freeze for about 400 ms
  on every visit; it is now about 15 ms.
- **The cart list is paged** at 200 with "N more staged, not listed here" and
  a Show all button. Every total still counts the whole cart.
- **The app is faster to use.** The sidebar, all thirteen sheets and the
  tooltip keep their frost but lose the displacement lens; the full-screen
  dim behind a dialog no longer blurs; the hover beam on cards is gone.
- **Hovering the treemap repaints only the two tiles that changed**, not the
  whole map.
- **Near-duplicate clusters wrap** instead of scrolling sideways, and their
  thumbnails are prepared when the hunt finishes — the first look at a
  cluster went from about 46 ms a picture to 5 ms.
- **TreeMap no longer burns CPU when you are not using it.** With the window
  closed it had been sitting at 20–60% eighteen minutes after a scan, because
  it was watching its own data folder and re-counting the whole index every
  400 ms.
- **One dialect and one date format** throughout.
- **The welcome screen explains what a treemap is** instead of comparing
  itself to another product.
- **Every dialog takes, traps and returns focus**, the page underneath is
  inert, and the thirteen segmented controls are real tab lists you can drive
  with arrow keys.
- The macOS first-launch instructions were rewritten (see Known limitations).

### Fixed

- **A folder macOS refused to open was reported as an empty folder.**
  Scanning Desktop or Documents without Full Disk Access showed "Scanned 0
  files — 0 B", toasted "Scan complete", and the first-run card congratulated
  you on a clean folder. TreeMap now counts what it was refused, names those
  folders, and offers the Privacy settings button.
- **Sparse files claimed space the disk does not hold.** A virtual machine
  disk such as Docker.raw reserves its full size and fills only part of it —
  64 GB claimed, perhaps 12 GB on the disk — and TreeMap counted the claim,
  then blamed the difference on copy-on-write clones in the Missing GB
  receipt. There is a line for it now, and it is the difference *both* ways:
  small files hold slightly more than they claim, because a disk hands out
  room in fixed-size pieces.
- **"Used" meant two different things.** The Dashboard tile excluded the
  blocks the system reserves for itself while the Missing GB receipt did not,
  so on Linux the two disagreed by about 5% of the disk. Six places now read
  one published figure, and the receipt shows the reserve as its own band.
- **Offload said "need 0.0 GB, only 0.0 GB free"** about a 30 MB transfer.
- **The Trends forecast line and the "disk full ~date" printed beside it were
  two different predictions.** They are one claim now.
- **Duplicates promised bytes that trashing would not free.** On a Mac a
  Finder-duplicated file shares its storage, so removing the copy frees
  nothing. There is a line saying so, and after a duplicates trash TreeMap
  reports the *measured* change rather than the promise.
- **Two hard-link counts wore near-identical labels** — one counted extra
  names, the other counted files — so two screens disagreed. Relabelled, not
  recounted.
- **The time scrubber jumped under your finger.** Its label grew from 23 px
  to 174 px on the first pixel of a drag, shrinking the track by a quarter.
- **Sizes never read "1024.0 KB"** any more.
- **A sparse file is no longer mistaken for an online-only cloud file** — a
  virtual machine image or database file is not offered as safe to remove.
- **A folder whose name ended in a slash or a space could not be opened**
  through any part of the app, while the treemap drew it perfectly.
- **Ordinary filenames broke the search box.** `Screenshot (1).png` was read
  as a three-way query, and `-hidden.txt` highlighted every file except the
  one you typed.
- **The Live toggle could read "Live" while nothing was being watched.**
- **Instant open showed the whole indexed folder's file counts against a
  subfolder's tree** — a byte total describing one tree and an item count
  describing another.
- **Empty Folders printed its 1,000-item cap as the real number**, and ticked
  only what it had.
- **A read that failed was being treated as a fact.** A momentary error
  reading a file made the live index believe it had been deleted and shrink.
  The same shape was found and fixed in a dozen more places, including one
  that could have removed every protected copy the Time Capsule was holding.
- **A check that could not run must not answer "nothing is open".** The guard
  that looks for files in use returned a clean bill of health when it had not
  actually looked.
- **Tidying up after an undo could undo the undo** — a failed housekeeping
  step deleted the file that had just been restored.
- **A cart with more than 500 items could not be committed at all.**
- **The circle-pack layout could block the app for a second**, and the
  Voronoi layout for nearly three, on an awkward folder. Both are bounded
  now, refine across frames, and say what they could not draw.
- **Drive Health named no drive on any machine**, and the scan counters
  beside it were invented rather than fetched.
- **A media library TreeMap could not read into was reported as "no media
  libraries"** — on exactly the Mac the feature was built for.
- A confirmation opened from Settings painted *behind* Settings, and Escape
  closed the sheet underneath instead of the one on top.
- Dozens of smaller corrections to counts, captions and empty states, each
  one a number or a sentence that did not match what the code did.

### Security

- **Fleet pairing could be brute-forced.** The six-digit code had no rate
  limit on the peer server; an audit made 33,966 guesses in three seconds. It
  is now five wrong guesses per machine and fifty in total, checked before
  the code is even looked up, and the offer withdraws itself and tells you
  which machine was trying.
- **A blocked system folder was reachable by another spelling.** On macOS
  `/System/Volumes/Data/private/var/db` — the local account database — was
  scannable while `/private/var/db` was blocked, because a firmlink is not a
  symlink and both halves of the guard compared text. The block list judges
  where a path really lives now.
- **A folder symlink could walk the "inside the scanned folder" guard out to
  any file on the disk** — for trash, open, terminal and preview alike. The
  gate judges location rather than spelling, while a symlink itself stays
  removable.
- **The desktop app's local API was open to any program or web page on the
  machine that found the port.** It starts with a per-launch token now, and
  the app's own window is handed a session of its own. A Host-header check
  and a Content-Security-Policy were added, and binding to anything other
  than the loopback address refuses to start without a token.
- **A note that pauses automation now fails closed** — a corrupt notes file
  pauses Autopilot with a message instead of silently switching every pause
  off.
- A query that does not parse, or that has no conditions, cannot be saved as
  an unattended policy, and a query policy never removes a folder.
- The cart button was removed from an application's own bundle and its user
  data, which had quietly widened "clear caches safely" into a one-click
  staging of the app itself.

### Removed

- **The optional Ollama local-model integration**, end to end. The built-in
  phrase table is the whole plain-words feature, and a test proves that path
  contains no network code at all.
- The spinning border beam on card hover, the displacement lens on every
  glass surface, and the blur behind an open dialog — all removed for speed.

### Known limitations

These are deliberate, and they are the things a first-time downloader meets.

- **The macOS build is not notarized.** TreeMap is signed, but not by an
  Apple-paid certificate — notarizing requires a paid Apple Developer Program
  membership that this free, open-source project does not have. macOS will
  block it the first time. Open it once, then go to **System Settings ›
  Privacy & Security** and press **Open Anyway**. That button only appears
  for about an hour after macOS blocked the app; if it is not there,
  double-click TreeMap again and go straight back to System Settings.
- **The macOS build is Apple Silicon only.** There is no Intel build.
- **The Windows installer is unsigned**, so SmartScreen shows a blue box
  once — More info, then Run anyway.
- **There is no Linux desktop download.** The test suite runs on Linux in
  CI and web mode works there; only the packaged build is unpublished. You
  can build an AppImage locally with `npm run dist:linux`.
- **Sizes are measured in 1024s and labelled KB/MB/GB.** That is about 7%
  smaller than the Finder, which counts in 1000s. Every number in TreeMap is
  measured the same way, so they always agree with each other.
- **A fast rescan under-counts the claimed-versus-held line.** Folders that
  have not changed are read from the previous scan and not measured again, so
  that figure is a floor rather than a total. The receipt says so.

## [3.2.1] — 2026-08-26

The last release before this one. See the repository history for its
contents; releases before 5.0.0 are not itemised here.
