# Changelog

All notable changes to TreeMap are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and TreeMap uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [5.2.0] — 2026-10-25

TreeMap now has a scan engine of its own. It is written in Rust, asks the
operating system for a whole folder's list in one request instead of one file
at a time, and on a Mac, on a folder the computer has read recently, it is
about three times as fast as TreeMap's built-in walker. A new setting decides
how much of the computer a scan may use, and a scan you start yourself runs
at full speed when the computer is plugged in. The biggest cause of slow,
stuttering whole-disk scans is gone: TreeMap no longer reads the whole disk a
second time after every scan. A scan now stays on the drive it starts on
unless you ask it not to. Opening TreeMap never starts a scan by itself: a
start screen lets you pick what to scan, your last folder first. Deleting
through the Clean Up cart and Autopilot is safer: nothing goes to the Trash
without a whole, checked copy in the Undo Vault, and the Autopilot policy
editor, which could not be used in 5.0.1, now works. On a Mac, TreeMap knows
whether it has Full Disk Access and says what that does and does not open.
And every size is now written the way Finder writes it. Some whole-disk
problems remain; they are listed under Known limitations.

There is no 5.1.0 release: that number was carried by a local test build that
was never published, and 5.2.0 is newer than both it and 5.0.1.

### Added

**A new scan engine**

- **TreeMap has its own scan engine, written in Rust.** It lists a whole
  folder in one request and works on several processor cores at once, and the
  test suite checks that it counts exactly what the built-in walker counts, on
  a Mac and, in the automated tests run on every change, on Windows and Linux.
  On a 200,000-item folder the computer had read recently, it went through
  412,291 items a second, where the built-in walker managed 131,203. On a
  1,000,000-item folder too big for the computer's file cache (a "mixed"
  cache), the disk sets the pace: 91,308 items a second, about 11% faster than
  the walker's 82,497 and slower than the gdu helper 5.0.1 used on a
  Mac.
- **It is chosen for you, and it says so.** It scans a whole folder on macOS,
  Windows and Linux. A scan of a single file, and any scan while a "Don't
  scan" pattern is set, go to the built-in walker instead, so one such
  pattern makes every scan slower. If the engine is missing, fails, or shows
  no progress for 30 seconds while the computer has time to spare, the older
  engines take over (below 5,000,000 items; see Changed), and a scan stuck on
  a dead network drive can still be stopped. What you will see: the
  Dashboard's engine line reads "Native engine — scanned N items (files and
  folders) in S s", **Engine details** under it gives the speed and how the
  engine reads the disk, and hovering the line says why that engine ran, or
  why a faster one could not, naming each reason once. **Settings › Scan
  engine** lets you pick one yourself.

**How much of your computer a scan may use**

- **A Scanning budget in Settings.** Eco holds a scan to about a quarter of
  the computer, Balanced to about half and Turbo to nine-tenths; in TreeMap's
  own test, work held under each one used 24.1%, 49.9% and 90.0% of the
  machine. Automatic, the default, is Balanced for scans that run on their
  own, and Eco on battery power or, on a Mac or Linux, when the computer runs
  hot. Scheduled scans ask for Eco, which the built-in walker and gdu keep to;
  the native engine runs them at the budget the whole app is under, at most
  Balanced on Automatic. A scan pauses while the computer sleeps. What you will
  see: **Engine details**, under the Dashboard's engine line, names the budget
  the scan ran under, for example "scanning budget: Balanced".
- **A scan you start runs at Turbo when the computer is plugged in.** On
  Automatic, a scan started from the window uses Turbo on mains power,
  Balanced on battery and Eco when the computer runs hot. Scheduled scans,
  Autopilot, other computers' requests and the rescans TreeMap starts by
  itself once an offload, an undo or a video re-encode finishes keep the
  gentler budget, and while one of them runs, yours steps down to Balanced.

**Drives mounted inside a folder**

- **A scan stays on the drive it starts on.** A drive mounted inside the
  folder you scan, such as a backup disk, a disk image or the iOS simulators
  Xcode installs under `/Library`, is a separate disk, and on a Mac or Linux a
  scan does not go into it unless you ask, whichever engine runs. **Settings ›
  Drives mounted inside a folder** offers **Stay on this drive**, the default,
  and **Include drives mounted inside it**. The folder's search index leaves
  out the same drives, and changing the setting marks every saved index out of
  date, saying why, so the next scan rebuilds it under the new rule. What you
  will see: the drive's folder is shown without its contents, a line on the
  Dashboard names the drives the scan did not enter, and the Missing GB
  receipt gives them a line of their own. Two scans that left out different
  drives are never compared, so the first whole-disk scan after updating
  starts a new baseline for Trends, Compare and the forecast, and the What's
  new banner stays quiet, instead of reporting the drives it left out as space
  freed; a drive unplugged between two scans that went into it is not read as
  space freed either. On Windows, a drive mounted in a folder was never
  entered.

**On a Mac**

- **TreeMap knows whether it has Full Disk Access, and says what that
  means.** It checks for itself, reading nothing and never touching your
  Desktop, Documents or Downloads folders, and every "could not be read"
  message follows what it found. Without access, it says what to give access
  to: TreeMap, or, when TreeMap runs in a browser, the app that started its
  server. Where a folder may be closed by its own permissions or by another
  account, it says Full Disk Access will not open it. With access, it no
  longer tells you to give it. What you will see: while a scan of the whole
  disk or your home folder runs without access, the Dashboard says that
  macOS keeps TreeMap out of the folders it protects
  (Mail, Messages, Safari, the Trash); **What's missing?** opens the Missing
  GB receipt; **Open Privacy settings** is hidden once access is on; and when
  you come back from System Settings, TreeMap checks again and says so once
  access is on.

**On Windows**

- **An opt-in NTFS turbo mode reads a drive's file table directly.**
  **Settings › Scan engine › NTFS turbo.** For a scan you start in the
  window, TreeMap asks in plain words, Windows asks for administrator
  permission, and a small helper reads the drive, read-only, for that one
  scan; TreeMap then checks up to 1,000 of its entries against the disk and
  throws the result away at the first disagreement. It needs TreeMap installed
  for **Anyone who uses this computer**, which the installer does not suggest
  (it suggests **Only for me**), and kept in the folder the installer offers;
  other copies, a scheduled scan, and a no to either question scan the normal
  way.
  It has not yet been tried end to end on a real Windows PC, and every scan
  that uses it says so.

**Look and feel**

- **The theme can follow your computer.** **System**, the default, switches
  between light and dark when your computer does; Light and Dark stay as you
  set them. The sidebar button still flips what you see, and **Settings ›
  Theme** is the way back to System.

**For agents and scripts**

- New routes `GET`/`PUT /api/engine/budget` (including an exact CPU
  percentage), `GET /api/engine/capabilities`, `POST /api/scan/{id}/pause` and
  `/resume`, `GET /api/scan/{id}/boundary`, which says which drives a scan did
  not enter, `GET /api/scan/{id}/refused`, which lists every folder a scan
  could not read, and `POST /api/files/installed-programs`, which says which
  paths are part of an installed program. The dry runs of `DELETE /api/files`,
  `trash_paths`, the cart commit and an offload mark such paths, and Autopilot
  never selects one. `POST /api/facts` gains an `onDisk` fact: what a file
  takes on its disk now. A scan's stats name the engine's reason
  (`engineReason`, `fallbackReason`) and its budget, `GET /api/index/status`
  carries `autoBuild.maxEntries`, `GET /api/platform/capabilities` says whether
  TreeMap has Full Disk Access, and the settings take `scanBoundary`. Approving
  an Autopilot run now names that run (`runId`), and a request without one, or
  for a run already approved, is refused. With no minimum given, the
  largest-files and largest-folders lists and the MCP tools `get_largest` and
  `reclaim_ranked` start at 1,000,000 bytes, and the duplicate finder and
  `find_duplicates` at 1,000 bytes, where they used 1,048,576 and 1,024. The
  audit log records a failed Trash empty, snapshot purge or cloud trash as an
  error, and a snapshot restore that failed after replacing a file as an error
  naming that file. `GET /api/scans` no longer lists the scan an Autopilot
  Preview, or a policy run that can only preview, makes. `trash_paths` says
  "moved to the Trash" only of what moved, and that it can be restored from
  there until the Trash is emptied; the text written for agents says when each
  way back ends. An offload onto the drive its files are on is refused, dry run
  included (`DEST_SAME_VOLUME`), and so is one into a folder TreeMap cannot
  write to (`DEST_NOT_WRITABLE`); Windows is not checked that way, and there
  the first copy finds it and the offload rolls back. `GET /api/volumes` leaves
  out the volumes that share space with the startup disk, or with the folders
  named in `from=`, and `GET /api/security/findings` takes `offset=` to reach
  every finding and says, for each move it suggests, why that move would be
  refused, if it would. `GET /api/policy` takes `scanRoot=`, up to 64 folders,
  and says of each whether a scan may start there. No scheduled scan or
  Autopilot run starts in the first 10 minutes after the server starts; a scan
  asked for over HTTP or MCP starts at once. An Autopilot suggestion policy
  that names a kind no rule here has is refused when it is saved
  (`POLICY_MATCH_UNKNOWN`). `trash_paths`, in a real run as in its dry run,
  says beside `inUse` whether its check for open files saw every program
  (`complete`), with the reason when it did not. In a suggestion's
  `regenerateCmd`, `<folder>` stands for each item's own folder name, and the
  value may be a sentence rather than a command. Only a finished scan grants
  leave to act on what it listed, and with a byte limit set in the agent
  policy, a path no finished scan has sized is refused
  (`POLICY_BYTES_UNKNOWN`). An `Idempotency-Key` also covers a retry sent while
  the first request is still running: the retry waits for that answer and
  replays it. A request body that is too large, or in an encoding TreeMap does
  not read, is refused with its own code instead of a server error, and with
  CORS on, a browser may send `Idempotency-Key` and read `Idempotency-Replayed`
  and `Retry-After`. When its client ends the session, the MCP server waits for
  a running offload to roll back and for a `trash_paths` call to answer before
  it exits. Several answers gain fields and refusal codes. All are in the
  OpenAPI document; the MCP server keeps its ten tools.

### Changed

- **Sizes are written the way Finder writes them.** Every size TreeMap shows,
  on screen, in its reports and in what it tells agents, now counts in
  thousands: 1 KB is 1,000 bytes, 1 MB is 1,000,000 bytes and 1 GB is
  1,000,000,000 bytes, so a 3,200,000,000-byte file reads 3.2 GB here and in
  Finder. Until now TreeMap divided by 1,024 under the same labels, which put
  every figure about 7% under Finder's and out of step with searches such as
  `size>3gb`, which always counted in thousands. A size you type, such as a
  folder budget, an Autopilot limit or the Clean Up target, is read in the
  same units; one an earlier version saved opens as its exact figure and
  keeps every byte until you type a new one. Every threshold a sentence
  names, such as the map's 4 KB floor, is that decimal size, and chart axes
  step in round decimal units too. **Settings › How TreeMap measures space**
  says which units TreeMap counts in, and that Windows Explorer, which
  divides by 1,024, shows the same files about 7% smaller at gigabyte sizes.
  This lifts a limitation listed since 5.0.0. Nothing about your files has
  changed, only how their sizes are written; figures quoted in these notes
  from earlier screens are as TreeMap printed them then.
- **TreeMap no longer reads a whole disk a second time after every scan.** In
  5.0.1 every finished scan rebuilt the folder's search index, which for a
  whole disk meant walking all of it again: on one busy test Mac with 9.46
  million items that took about half an hour, with TreeMap unresponsive for up
  to 111 seconds at a time. Now TreeMap indexes a folder by itself only up to
  1,000,000 items. What you will see: for a bigger folder, "Not indexed
  automatically — N items is more than TreeMap indexes on its own (up to
  1,000,000)." An index you already have is kept rather than rebuilt; there is
  no button yet to index a bigger folder anyway, so it opens by scanning
  rather than instantly.
- **Building an index lets the app breathe.** A build no longer adds up every
  folder's size in one long step at the end, the step that held TreeMap for
  those 111 seconds, and it gives the window a turn between writes. Replacing
  an index no longer deletes its old rows in one go, which in TreeMap's own
  test took 17.2 seconds for a million rows.
- **The end of a long scan arrives once.** When the progress stream went quiet
  near the end of a long scan, 5.0.1's window asked for the whole result every
  three seconds, with nothing to stop overlapping requests; on a whole-disk
  scan TreeMap built the same very large result up to eight times. Now the
  window asks one question at a time and gives the result time to arrive, and
  the server repeats its last progress message about every two seconds, so a
  quiet stream is not taken for a dead one, and a busy server's slow answers
  are not taken for a scan that died.
- **A big scan no longer drops back to zero part-way through.** In 5.0.1,
  when the gdu helper's list for one top-level folder grew too big (the
  system's `/private` folder can), the scan threw away what it had counted and
  started again with the slower walker. The native engine has no such limit.
  It sizes its memory from the last scan of the same folder, or for a whole
  disk from the system's own count of files, so a disk with more than about
  6.2 million items is read once, not twice. And if it fails part-way through
  a scan of more than 5,000,000 items, the scan stops and says why instead of
  starting again from zero in the slower walker: a walk that stopped answering
  names the folder where it was last seen, and **Settings › Scan engine ›
  Built-in walker** scans the folder anyway.
- **Finishing a very large scan takes far less memory.** The map sent to the
  window used to be built in memory in one piece; it is now written from the
  scan in small pieces as the window reads it. In TreeMap's memory test of a
  5-million-item scan, that step went from about 680 MB of extra memory to
  about 49 MB.
- **After a big scan the window keeps responding.** Worked out in one go, the
  cleanup suggestions took about 10 seconds of a 13.4-second freeze after one
  whole-disk scan, and the file-type and largest-folder lists 1.8 and 1.1
  seconds more. They are now worked out in small steps, with the same answers,
  and the suggestions once per scan.
- **The first map of a big scan keeps to its size.** TreeMap sends the window
  at most 250,000 items for the first picture, more only when the scanned
  folder itself holds more, and fetches deeper folders when you open them; a
  folder with a huge number of files used to be sent whole anyway, 671,545
  items on one whole-disk scan.
- **Opening TreeMap is quicker.** Opening the app ran one system command per
  program holding on to deleted files, a pause of 0.7 to 1.9 seconds, and
  loaded the PDF, Excel and AI-tool libraries up front, another 0.6 to 1.7
  seconds. It now asks about all of those programs at once and loads each
  library the first time it is needed.
- **A click on the map opens one folder at a time.** A click used to open the
  deepest folder under the pointer, several levels at once, while Esc climbed
  back only one. Now it opens the next folder down that holds what you
  clicked; a file or an archive directly in the folder on screen still
  previews or expands, and the first-run tour says so. Disk City, and the
  table below it, now open one level per click too.
- **Fast rescan is never ticked for you, and no longer misses a deletion.**
  In 5.0.1 the box was ticked for every folder scanned before. It is now
  offered only where the next scan would not use the native engine: the
  built-in walker or gdu chosen in Settings, no native engine, or a "Don't
  scan" pattern. A fast rescan always runs on the built-in walker. It reuses
  the last scan's list of a folder's contents only when the folder's modified
  time is as it was then and was already more than 5 seconds old when that
  scan began, and the box now says so. A change made moments after a folder
  was listed can leave its modified time as it was, so in 5.0.1 a file
  deleted then could stay in every fast rescan until the folder changed
  again. Where the native engine can scan, a fast rescan asked for anyway
  lists the whole folder, which is faster and sees changes inside files that
  the saved listings cannot. Saving the scan engine or the "Don't scan" list
  updates the box at once.
- **Opening TreeMap never starts a scan by itself: you pick what to scan.**
  The welcome screen is now a start screen. It offers your last folder
  first, as **Scan Documents again** with its size and the date it was
  scanned, then Desktop, Documents, Downloads, your home folder and the whole
  drive, under the name the folder picker gives it, such as "Macintosh HD".
  **Choose a folder…** stays the one blue button, rather than a scan of your
  last folder, which may be the whole disk. A folder is offered only where
  it is on this computer and TreeMap may scan it, by the same rules a scan
  is held to, an agent policy's allowed folders included; a last folder that
  cannot be opened now is named, with the reason, instead. When the agent
  policy refuses a folder, or its file cannot be read, the start screen says
  so in plain words, and asks again when you come back to TreeMap's window,
  so a repaired policy is seen without reloading. Reloading the
  window reopens the scan TreeMap still holds, says "Reopened the scan from"
  and the time it ran, and the Scan card's path box names that folder; once
  that scan has expired, or after TreeMap is quit and opened again, the
  start screen names the folder rather than scanning it. In 5.0.1 a reload
  scanned the folder again, and a relaunch showed the welcome screen with
  only **Choose a folder to get started**. A scheduled scan or an Autopilot
  run that came due while TreeMap was closed, or comes due in its first 10
  minutes, now runs about 10 minutes after TreeMap opens, where 5.0.1
  started one that came due while it was closed the moment it opened.
- **After a Stop, the same scan is one click away.** When you stop a scan, or
  one fails, before anything is on screen, the start screen names the folder
  ("You stopped the scan of …", "The scan of … failed: …") and offers **Scan
  … again** first, with keyboard focus on it, and the last folder in your
  history after it; in 5.0.1 a Stop put the welcome screen back, without a
  word about the folder. Until the server confirms a Stop, TreeMap says it
  is stopping the scan. A Stop that reaches the server after the scan has
  finished shows the finished scan and says so, where 5.0.1 said it had
  stopped a scan the server had finished and kept. A folder TreeMap refused
  to scan is named with the reason and not offered again. If TreeMap cannot
  stop a scan, a notice says so, and that the scan may still be running, and
  the start screen does not offer a second scan of that folder. A Stop is
  announced to screen readers.
- **Notices sit at the bottom of the window**, clear of the view's toolbar and
  of the panels on the right, and at the top of the window, clear of the
  dialog, while one is open. On the map they rise clear of its footer and
  match bar where there is room, so a long notice no longer covers the map's
  hints. Dialogs, the first-run card, the search panel and the plain-words
  panel are no longer see-through, and the reclaim-score breakdown keeps its
  solid background when it scrolls. A long notice stays up longer, about
  60 ms a character, where every notice without a set time left after 4.2
  seconds, however long it was.
- **TreeMap says what a move to the Trash frees, and how long it can be
  undone.** Clean Up, the Clean Up cart and its Preview after no longer say
  "Reclaims X" or "X recovered": nothing is freed until the Trash is emptied,
  and then at most the size the files report. Clean Up says "up to X, freed
  when you empty the Trash", and Custom rules measures what the files it finds
  take on the disk, so two sparse files that claim 3.9 GB and take no space are
  said to free none of it. The cart says, before you commit as well as after,
  that the space comes back only when you empty the Trash and that the Undo
  Vault's copy takes up space until the Undo Vault removes it. The sheets
  before a video re-encode or a shader-cache clear, and Shrink video's own
  line, say the same of the originals they send to the Trash. No message
  promises a way back that TreeMap does not keep: the Clean Up sheet called
  everything "recoverable any time" and the Trash sheet said "You can restore
  it from the Trash at any time", but what Clean Up and the other views move is
  not copied to the Undo Vault, so it comes back only until the Trash is
  emptied, and they now say so. Every offer of an undo through the Undo Vault
  says it lasts only until the copy is removed, by default after 30 days, or
  sooner to stay under the Undo Vault's size cap. On a cloud account's scan,
  Clean Up says its removals go to that service's own trash. An item in the
  cart that the scan on screen does not hold is "size unknown", not 0 B.
- **Before the first scan, every view says where you are.** In 5.0.1 a view
  that needs a scan showed the Dashboard's welcome under no name of its own,
  so clicking Grid, Apps or Security seemed to do nothing. Each view now
  shows its name and what it will show once a folder is scanned, above the
  start screen's choices; Trends and History say they have nothing yet
  instead of drawing an empty chart. The first-run tour no
  longer puts a blue **Scan my home folder** button, holding keyboard focus,
  beside the welcome's own, so pressing Enter no longer scans your home
  folder at once. **Skip the tour** sits in the card's header. Each quick win
  names up to three of the items it found, with their folders and sizes, in
  place of the rule's matching wording, and the tour's last step follows
  what you add to the cart or take out of it.
- **The map's colours are at full strength, and every label can be read.**
  Tiles faded the deeper they sat, so a big file a few folders down looked
  washed out. Every tile is now solid in its own colour at any depth, and
  every line the map draws, between two files or around a folder, stands
  out against the tiles on both sides of it, at a contrast of 3:1 or better
  in both themes, where 5.0.1 framed a folder with a faint white line. Files
  side by side share one thin line, the smallest files carry a faint
  texture instead of lines, small and nested folders have thinner frames
  than large top-level ones, and the lines stop at each top-level folder's
  name tag. Lines and frames cover whole pixels of the screen, so they stay
  sharp on a display scaled to 125, 150 or 175 %, and the map hardly
  turns darker where the texture gives way to lines. The part of a folder
  that no rectangle covers, such as a folder whose files are all too small
  to draw, is filled with the folder's own colour, lightly textured, where
  it showed the map's background. Names and sizes were always written in
  the same dark ink, hard to read on dark and strong colours; each line is
  now black or white, whichever reads better on its tile, at a contrast of
  4.5:1 or better in every colouring and both themes.
  The hover magnifier draws tiles, lines and name tags the same way. A key
  under the map now names the markings on screen, such as "archive you can
  open", "staged for the Trash", "in the cloud, not on this disk" and "git
  repository"; it used to explain only the colours.
- **Highlight, search and Missing GB answer sooner.** A query in the map's
  Highlight box waits 90 ms after you stop typing, where it waited 150, and
  is asked once instead of being checked first and then run; the sidebar
  search waits 90 ms instead of 140; and each keystroke stops the request
  the one before it made. Missing GB opens at once on the last statement it
  gave for the scan, marked "Updating…", while it asks again, where every
  visit started from placeholder rows, and it reads held-up space at the
  same time as the disk layout instead of after it.
- **The Time Capsule is now called the Undo Vault**, on screen and in what
  TreeMap tells agents. Its API routes (`/api/timecapsule…`), its settings
  keys (`timeCapsuleRetentionDays`, `timeCapsuleMaxPercent`), its error
  codes and the folder that holds its copies keep their names. The command
  palette still finds the view and its Settings section by the old name,
  and sentences saved before the update, in the Undo Vault's events and in
  Autopilot's run records, are shown in the new words.
- **Smaller changes.**
  - A deep folder trail folds the folders above into a "…" menu instead of
    cutting their names, and every menu works from the keyboard.
  - **Shift+F10**, or the Menu key, opens the focused item's right-click menu
    in every view that has one, and on the map the menu of the tile selected
    from the keyboard. The shortcuts sheet lists it.
  - When the map reaches its 20,000-item limit, a note under it says how much
    has no rectangle there and that the Grid view lists the rest.
  - Drive health and Cost to keep moved to the Dashboard's right-hand column,
    so the two columns end near each other.
  - Every sidebar entry has its own icon, and the command palette lists the
    views in the sidebar's order.
  - **Choose a folder** offers the whole drive at its top when you are
    picking a folder to scan: the startup disk on a Mac, under its own name
    such as "Macintosh HD", each lettered drive on Windows, and / on Linux.
    Folders whose names start with a dot stay out of the list until you tick
    **Show hidden folders**, which counts them; shown, they come after the
    ordinary ones. You can type a path into it. It no longer lists folders
    TreeMap will not open, such as /dev, which in 5.0.1 led only to an
    error, and one typed there is refused in words that say TreeMap stays
    out of it, where 5.0.1 said "Scanning … is not allowed" even while you
    were choosing an offload destination. A folder with more than 500
    subfolders lists the first 500 and says the list was cut. Its button
    says what it will do: **Scan this folder**, **Use this folder** for an
    Autopilot policy, or **Offload to this folder**; it used to say Scan this
    folder for all three. A typed path that names no folder is never swapped
    for a similar one: TreeMap asks "Did you mean …?" instead, says what the
    typed path ends with, such as a space, and lets you answer from the
    keyboard.
  - In Settings the footer button reads **Close without saving**, and Save
    closes the sheet once your settings are saved. A note beside them says
    which choices are saved the moment you pick one and what Save keeps.
  - Everyday words on everyday screens: the index badge says "Up to date —
    updates itself as files change", the Sunburst's footer counts the files
    and folders it shows and how many levels deep, the map's footer says how
    many items it drew and from what size ("9,421 items of 4.0 KB or more
    drawn · 8.8 GB in this folder") where it counted "nodes", the Voronoi
    button no longer names the algorithm behind its cells, a duplicate
    group's size no longer carries a "+" that read as growth, and each Apps
    row prints its size once, under a scatter chart with titled axes that
    says what a dot is.
  - Card and view headings are in sentence case, as the rest of TreeMap's words
    are: "Quick stats", "Largest files", "Drive health", "Cost to keep" and the
    rest, in the PDF report too.
  - The Apps scatter chart can be used from the keyboard: Tab to it, and the
    arrow keys step through its dots, each read out with its name, file
    count and size.
  - Plain-words search understands sizes ("over 500 MB"), and says when it
    cannot turn a request into a search instead of offering one that lists
    every file or matches nothing. A kind of file named in words, such as
    "videos", "documents" or "archives", now covers every type the rest of
    TreeMap counts as that kind: "videos" used to miss .m4v, .wmv and .flv
    files, and "archives" .bz2, .xz and .tgz.
  - Save view is offered only with a query in the box, and deleting a saved
    view says so, with an Undo.
  - Disk City opens coloured by Size, as the map is, where it opened in
    Reclaim, which read as one grey or amber block, and labels its Height and
    Color buttons. Its Type colouring has a key: one swatch per colour drawn,
    biggest first.
  - The Dashboard's Largest folders lists distinct places: a folder that
    holds nearly all of a listed folder it lies in, such as an app's
    Contents, is folded into that row, which says so, instead of taking a
    row of its own. Its heading says that each row's percentage is a share
    of the largest folder listed, and each row's screen-reader name gives its
    size, file count and share, where it said only "Open … in the treemap".
  - The bar a search adds under the Highlight box floats over the bottom of
    the map instead of standing above it, so typing a query no longer pushes
    the map down, and with only saved views to show it is just their
    buttons.
  - Red is kept for real trouble. Disk topology draws a disk red only when
    it is more than 85% full and holds your home folder or the folder you
    scanned, where every disk past 85% was red, a full disk image included;
    Fleet's "What they can never see" is drawn like the list beside it
    rather than as a warning; and Missing GB's reason a line is unknown is
    grey, not warning yellow.
  - The Clean Up and Duplicates meters show each stage's track, so an empty
    stage reads as empty, and the start screen's three feature lines no
    longer look like buttons.
  - Sizes and reclaim scores printed in colour read at a contrast of 4.5:1 or
    better in both themes, and a reclaim score of medium confidence shows a
    quieter ring rather than a dimmer number. The white label on a blue
    button reads at 4.5:1 or better too, at rest and under the pointer, and
    the Security panel's "Minor" badge and Drive health's note on a drive it
    cannot read are in a stronger grey.
  - The Missing GB receipt's note about copy-on-write clones is in plain
    English.
- **Building TreeMap yourself builds the native engine too.** The `dist`
  scripts now build and check the engine for the computer they package for and
  stop without it, so they need Rust; the downloads on the Releases page
  always had it.

### Fixed

- **Clean Up's Move to Trash no longer deletes on one click.** Custom rules
  and Empty folders open with their rows ticked, and in 5.0.1 the button
  moved them all to the Trash at once, with no question and no check for
  files open in another program, while the pane said nothing is removed
  until you confirm. On the Shrink video tab and the tab of online-only files
  it acted on the rows ticked under Smart suggestions, which those tabs do not
  show. It now opens the same "Move to Trash?" dialog as every other view and
  acts only on the list on screen, and those two tabs, whose own actions are a
  re-encode and the cart, no longer offer it.
- **Online-only files and local snapshots are no longer called safe to
  remove.** Clean Up's Cloud-safe tab said "The cloud keeps the original, so
  removing the local copy is safe", and the Dashboard that local copies are
  safe to remove, but such a file has no copy on this disk: moving it to the
  Trash makes iCloud Drive, OneDrive or Dropbox delete it from the cloud too,
  and the Clean Up cart downloads it first to keep a copy in the Undo Vault.
  The tab is now called **Online-only files**, and both it and the Dashboard
  say what moving such a file to the Trash does. The Dashboard also said
  purging local snapshots "is safe" because Time Machine recreates them, and
  Missing GB that a purge frees space only for now. A purge deletes them for
  good, with any older or deleted files only they still hold; the Dashboard now
  says so, and Missing GB and the "Purge local snapshots?" sheet add that it
  cannot be undone. The "Run git gc?" sheet called git gc safe, saying it
  changed no commits; it now says it deletes for good what no branch, tag or
  recent reflog entry points to and is more than two weeks old.
- **The Grid's selection stays in the Grid.** Its selection bar stayed on
  screen over every other view, and ⌘⌫ pressed in another view asked to move
  the Grid's selection, which that view did not show, to the Trash. The bar
  now leaves with the Grid and comes back with it, ⌘⌫ acts only in the Grid,
  and the shortcuts sheet lists it there.
- **The Autopilot policy editor can be used.** In 5.0.1 it opened, from **Add
  a policy** or from Clean Up's **Make this an Autopilot policy**, with
  nothing in it that could be clicked, typed into or reached from the
  keyboard. It now works like every other sheet.
- **Every confirmation opens on a safe control and names what it will do.**
  The Trash sheet opened on **Empty Trash…** and a "Move to Trash?" dialog on
  **Move to Trash**, so Enter confirmed at once; every sheet now opens on its
  first field, on Cancel or on itself, and Settings on **Close without
  saving**. Sheets that do something else, such as "Empty the Trash?",
  "Purge local snapshots?" and "Run git gc?", offered a button reading Move
  to Trash; each button now names its own action. When something is open in
  another program, the warning says what is open (this folder, something
  inside it, this file), where it called a folder held open "This file". It
  speaks of space that may not come back only where an open file may hold
  some, and then only of the programs holding such a file, and its button
  reads **Move to Trash anyway**, not Delete anyway. Closing a sheet takes
  that warning down: in 5.0.1 it, and its button, could stay up on the next
  sheet, such as "Empty the Trash?".
- **An Autopilot Preview is no longer taken for a scan of yours.** A preview
  scans the policy's folder, and that scan was kept like any other: saved to
  the history, so Trends, Compare and the forecast counted a scan nobody
  made, and listed as the newest scan, so reloading the window scanned that
  folder again as if you had. The scan a preview makes, or a policy run that
  can only preview, is now kept out of both.
- **The Grid scrolls by itself.** In a big folder the whole page scrolled,
  carrying the Grid's toolbar away, and the Grid built a tile for every file,
  25,600 of them in one test folder. It now builds only the tiles near what
  you see, keeps its toolbar on screen, and opens a folder, a filter or a new
  order at the top. Its last row scrolls clear of the selection bar and the
  Clean Up cart's tab, and a tile you click or reach with Tab stops above
  them.
- **The Clean Up cart and Autopilot never trash an item without a whole
  copy.** In 5.0.1 a cart commit or an Autopilot run bigger than the Undo
  Vault made room for its later items by dropping the copies of its earlier
  ones, and still called them protected: ten 2 GB items against a 15 GB
  Undo Vault went to the Trash with the first three uncopied. Two deletions at
  once could also erase each other's records. Now a run never drops its own
  copies, a copy being put back, or one kept because its item's trip to the
  Trash could not be confirmed; an item that cannot fit is left undeleted and
  named. Right before each item goes to the Trash, TreeMap checks that its
  copy is still whole and that the item has not changed since it was copied,
  and leaves it in place if either is not so. A folder holding a file TreeMap
  cannot read is left undeleted instead of being copied without that file.
  Room is made only once a new copy is whole and checked, and a copy that
  makes no progress for 60 seconds is stopped and its item left in place.
- **Undo gets back everything that was deleted.** When the Trash was slow to
  answer, TreeMap could decide an item was untouched and discard its Undo
  Vault copy although the item had gone to the Trash; a video re-encode could
  delete its new copy the same way. A folder and something inside it in one
  cart could stop Undo part-way, and a problem tidying up after the Trash step
  lost a cart's Undo. Now TreeMap checks the disk instead of trusting the
  Trash's answer, keeps the copy when it cannot tell, treats a folder and its
  contents as one item, and always hands back the Undo. An undo also puts back
  each file's permissions as well as its dates, never leaves a half-copied
  file under your file's own name if it is stopped part-way, and names each
  item it could not put back, with the reason, instead of saying everything is
  back. One that stops part-way says how many items it had already put back,
  and the folder is scanned again.
- **Autopilot no longer deletes when it cannot be sure.** When the check for
  files open in another program could not finish, which can happen on a busy
  computer, an unattended run trashed them anyway; now it moves nothing and
  checks again next time. A run stopped by an Undo Vault that could not be
  read or saved is now recorded as failed instead of being retried every
  minute with a full rescan. The next minute's check never starts a policy
  that is still running, and a run counts as undone only once its undo has
  finished. And "Make this an Autopilot policy" no longer drops a "Duplicates
  only" rule ticked beside another rule, which made the draft match every file
  of that age or size.
- **Approving an Autopilot run approves what that run showed.** In 5.0.1 the
  button approved the policy as it then stood, so once a policy's folder or
  rule had changed, an older preview's Approve let the next run delete what no
  preview had shown. Approve is now offered only on the newest run, made for
  the policy as it is. A run held because it matched more than **Ask me first
  above** now goes ahead once you approve it, up to what it matched; before, it
  was held again every time. An approved run now says it was approved and is
  not offered for approval again, and Approve says what it lets the policy do
  as the policy is set, where a policy set to **Only ever preview**, or
  switched off, was told approving it would let it start deleting. A policy can
  no longer name a group TreeMap only gives advice about, such as a virtual
  machine's disk or a photo library's previews, and a run never picks one. And
  an age rule that is not a whole number of days, such as 36 hours, keeps its
  exact figure when the policy is opened and saved, and the policy card and the
  reason given for each item it picks state it exactly instead of rounding it
  to two days.
- **Every kind the Autopilot editor offers now matches something.** Three of
  its boxes, **Web build output**, **Application caches** and **Junk
  files**, named kinds no rule had, so a policy made from them matched
  nothing on any run and said only "Nothing matched this time." The editor
  now offers Web build output, Browser caches, Developer caches, Tool caches
  and Junk files, each a kind TreeMap has. A policy that names a kind
  TreeMap does not have is refused when you save it, and one an earlier
  version saved says so on its card, in its editor, in its Preview and in
  every run; TreeMap never swaps in another kind for it. While TreeMap cannot
  read its rules, the card and the editor say that it cannot tell which
  kinds it has.
- **Agents were told a virtual machine's disk could go to the Trash.** In 5.0.1
  the MCP tool `cleanup_suggestions` listed the groups TreeMap only gives
  advice about, such as Docker's or WSL's disk image, Windows.old and a photo
  library's previews, beside the caches it may clear, counted them as
  reclaimable space and said its paths could be passed straight to
  `trash_paths`, which took them; `GET /api/agent/summary` counted them as
  reclaimable too. Both now mark those groups as advice only and count them
  apart (`advisoryBytes`), `trash_paths` refuses such a path, however it is
  spelled, and a folder that a finished scan shows holding one
  (`ADVISORY_PATH`), and while it cannot read its rules it refuses
  every path. Both also count every match, where they stopped counting at 200.
- **Folder notes keep their pauses.** A note can pause Smart suggestions and
  Autopilot inside its folder. In 5.0.1, if the file that holds the notes was
  damaged, TreeMap showed no notes, and saving any note then replaced the file
  with that one note, so every other pause was lifted and Autopilot could act
  in those folders again. Now TreeMap never writes over a notes file it cannot
  read, and the pauses in it still hold: TreeMap says why the notes cannot be
  shown, the lists a note can pause stay off, and the note sheet does not open
  until the file can be read. A pause now also keeps its folder out of Package
  leftovers, the Git repositories and browser caches that Smart suggestions
  lists, Empty folders and Shrink video, all of which offered what was inside
  it, and the note sheet names the lists it pauses and the views that still
  show what the folder holds.
- **Offload keeps its record of what it moved, and never trashes what it did
  not copy.** In 5.0.1 an offload restore that ran while another offload
  finished could erase that offload's record, TreeMap and its MCP server saving
  at the same moment could tear the record file, and quitting the desktop app
  while an offload ran did not wait for it to roll back or save its record. Any
  of these could leave copies on the drive with no record of them, and
  originals in the Trash with nothing in the Offloaded tab to restore them
  from. Records are now written one at a time and whole, quitting waits up to a
  minute for a running offload to roll back or record what it moved, and once
  the record passes 10,000 files it no longer drops the oldest that are still
  offloaded. A folder offloaded whole could also hold what the scan never
  listed, such as a "Don't scan" match, a folder TreeMap could not read or a
  file made since, and that went to the Trash with no copy; such a folder is
  now refused before anything is copied, and one that gains a file before its
  own turn to go to the Trash is left in place. A link in the selection is
  refused instead of being copied through, a folder and something staged inside
  it are offloaded once, and a destination inside the folder being offloaded is
  refused however it is spelled. A cancelled offload that cannot remove what it
  copied names what it left instead of saying everything was rolled back, and a
  destination drive that stops answering is shown as not connected instead of
  holding up every other offload. The Offloaded tab counts as freed only the
  originals that went to the Trash, and shows each drive's newest 200 files,
  its search reaching the rest.
- **Offload copies each file as it is, and leaves in place one that changes.**
  In 5.0.1 a second name of a hard-linked file, such as a file in a local
  `git clone`, was left out of the copy and the record when its folder was
  offloaded, though the folder went to the Trash whole, and one offloaded by
  itself was planned at 0 B, past the check for free space. Copies, and the
  files Restore put back, lost their permissions and dates: a private file came
  back readable by every account on the computer, a script lost its execute
  bit, and every date became the time of the offload. And an original changed
  after its copy was made, as by an app still saving it, went to the Trash all
  the same, while Restore would bring back the older copy. Now every name is
  copied at its real size, copies and restored files keep their permissions and
  their modified and last-opened times, and an original that changed after or
  while its copy was made stays where it is, named in a warning. The
  confirmation said "Any failure rolls back completely"; it now says that a
  failure rolls back completely only until every copy has verified, and that
  after that an original that cannot go to the Trash stays beside its copy. A
  cancelled Restore says how many files it had already put back, where it said
  everything was rolled back and nothing deleted, and the file it was writing
  is no longer left half-written under the original's name.
- **Every offload shows what it will move and asks first, and one that would
  free nothing is refused.** In 5.0.1, **Offload…** in the Grid's selection
  bar, a right-click menu or the Duplicates page started copying the moment
  a folder was picked, with no list of what would move and no question; only
  a drop on the drive dock asked first. Now every offload names what it will
  move, lists the files and bytes it will copy, and waits for **Copy,
  verify, then trash**. An offload onto the drive the files are already on
  frees nothing, since the copies take as much space again and the
  originals keep theirs in the Trash. It is now refused before anything is
  copied, and so is one onto a volume that shares that drive's space, such
  as a second APFS volume on the same Mac disk. A folder TreeMap cannot
  write to, such as one on a read-only drive, is refused before anything is
  copied too, with the reason; on Windows, where TreeMap cannot ask in
  advance, the first copy finds it and the offload rolls back. The folder
  picker opens on another connected drive, or with none connected on the
  folder where drives appear (`/Volumes` on a Mac, `/mnt` on Linux), and
  offers the connected drives in place of Desktop, Documents and Downloads;
  a folder that is refused leaves the picker open for another choice. The
  drive dock no longer offers a volume that shares the files' space. Where
  TreeMap cannot list drives, as on Windows, the picker says so and asks for
  the path of a folder on another drive.
- **TreeMap warns before you trash part of an installed app.** After a scan
  of `/Applications` the biggest files are apps' own insides, such as
  Chrome's framework, and 5.0.1 offered them for the Trash like any other
  file, which stops that app working. Now every Trash sheet, the cleanup
  cart's, and the offload and video re-encode sheets say before you confirm
  when a file is part of an installed program: a Mac app, a program in
  Windows' Program Files, or software installed under `/usr` on Linux. They
  name it, say it will stop working, and say how to remove it whole, and
  when TreeMap cannot check, the sheet says so. Autopilot never selects such
  a file, and its run names the program it left alone.
- **Finding duplicates could download your online-only files.** 5.0.1's
  duplicate finder opened every file of a matching size, including files kept
  only online in iCloud Drive or OneDrive, and opening one makes the sync app
  download it onto the disk you were clearing. Now the duplicate finder and the
  near-duplicate search never open such files or links, the Compare viewer
  reads no photo details from them, and the Duplicates page says how many were
  left unchecked. The near-duplicate search also says how many images it
  could not read and of which types, such as .heic photos on a Mac, which it
  cannot read yet, and calls a library tidy only when it compared its images.
- **A search could match every file when TreeMap could not tell.** A minus
  sign in front of something TreeMap cannot know turned "unknown" into "yes":
  `-dupe:yes`, `-git:dirty` or `-cloud:local-only` matched every file, and so
  did `used:never` and `-used<90d` on a disk that does not record when files
  are opened. As an Autopilot policy such a search could select every file in
  its folder, up to 2,000 a run, although a new policy's first run is always a
  preview and everything Autopilot deletes goes through the Undo Vault. Now
  an unknown never matches, the results count the files that could not be
  decided, and Autopilot refuses a policy whose query TreeMap cannot answer. A
  search's total also counts every match: it used to stop at 20,000 and show
  that limit as the total, and an Autopilot policy built from such a search
  picked its 2,000 from the first 20,000 the scan met. A search that needs
  facts looked up file by file still stops at 20,000, and now says so.
- **On a Mac, TreeMap reads when an app last opened a file.** Spotlight records
  it, but 5.0.1 could read none of the dates Spotlight keeps, so it went by
  each file's access time, which backups, indexing and antivirus move too. Now,
  where Spotlight recorded an app opening a file, the reclaim score says how
  long the file has gone unopened, and how many times it was opened, instead of
  how long it had gone unread, and searches such as `used>1y` go by that date;
  other files still go by their access time. A date Spotlight gives that is
  only the file's own modified or created date, as it gives for a file it does
  not index, is not taken for an opening. The same fault could lose the site a
  download came from, which the preview pane now names where it said only
  "Downloaded from the web".
- **"Stage matches" no longer puts whole folders in the cart.** `size>1gb`
  matches the scanned folder and every big folder on the way down as well as
  the big files in them, and Stage put all of it in the cart: on one test scan
  the cart claimed 22.5 GB from an 8.8 GB scan. Stage now takes files only,
  unless the search asks for folders, never the scanned folder. The cart
  counts an item inside a staged folder once, and a commit no longer reports
  such an item as left on your disk once its folder has gone to the Trash.
- **Clean Up counts what it offers and what it moved.** A saved view run as a
  Custom rule counted folders among its matches and then listed files only, so
  it could list a few files, or say "No files match these rules — nice and
  tidy.", where many matched; it now asks for files only. Ticking a browser's
  cache folder together with the profile caches inside it counted those bytes
  twice, and afterwards said the inner folders could not be trashed, though
  they had gone to the Trash inside it. A Smart suggestions group's badge
  showed how many it listed, at most 200, beside the size of every match; it
  now counts every match and says how many are listed and that Select all picks
  only those. "N could not be trashed" now gives the reason. Elsewhere, the
  notice after a move to the Trash added up every item asked for, including
  ones that failed or were held back for an open file, and now adds up only
  what moved; the Trash sheet, which lists the 500 largest items, says how many
  more there are; and when one video was open in another program, Shrink video
  stopped part-way yet reported the run as done, where now that video keeps its
  original, the rest go on, and the pane says which were kept and why.
- **The Clean Up cart counts each item once, and truly.** After a commit, an
  item the Trash refused, often a file open in another program, was counted
  both as left in place and as not moved; the confirmation could say "3 of
  these are open in another program right now" of a cart holding one item; and
  an item deleted since the scan was said to be left in place, still on your
  disk, and stayed in the cart. Now each refused item is named once, and a
  reason several items share is said once for all of them; open files are
  counted by item and by program; and an item already gone is said to be gone
  and leaves the cart. In a portable session, the reason TreeMap keeps no Undo
  Vault copy is said once, where every row of the sheet repeated it.
- **Clean Up's Empty folders never offers a folder the scan could not see
  into.** Folders macOS refused the scan, folders the scan never entered and
  folders whose listing was cut short all looked empty, and Empty folders
  offered them for the Trash. Now they are never offered. Each folder
  offered is looked at again on disk first, and again right before it goes
  to the Trash, and one that is no longer empty, cannot be read or does not
  answer is left where it is, with the reason; a folder holding a link to a
  folder, or on Windows a junction, is never counted as empty. A folder or
  drive that does not answer is not asked again until it does, and TreeMap
  spends no more than 10 seconds of a request looking. After a gdu scan,
  which shows an unreadable folder as an empty one, the view offers nothing
  and says why. The search term `empty:` follows the same rule.
- **On Windows and Linux, the Trash's count covers what emptying it deletes.**
  On Windows TreeMap read the Recycle Bin on drives C:, D: and E: only, and
  counted each account's folder in it as one item, named by a long account
  number; on Linux it read only the Trash in your home folder, never a drive's
  own. "Empty the Trash?" still gave that count and size as what would be
  deleted for good. Now on Windows TreeMap reads the Recycle Bin of each local
  drive, file by file, and on Linux each drive's Trash folder that is really
  yours, and where it cannot read every place that emptying clears, the sheet
  says so instead of giving a figure. On Linux without gio, emptying the Trash
  says it worked when it did, and says when a Trash folder could not be read,
  where in either case it said the system's own Trash emptier had not run.
- **Held-up space is counted once, and Quit and Restart say what they do.**
  A deleted file that several programs hold open was counted once per
  program, in the held-up space card and in Missing GB: one test Mac showed
  2.37 GB held where the files came to 687 MB. It is now counted once.
  Restart was offered for programs that are part of the operating system
  while the page said it refuses them; a button is now offered only for your
  own programs, and the rest say why. Every program was offered **Restart**,
  though TreeMap reopens only a Mac app: a helper inside an app, such as
  Chrome's renderer, was promised a reopen and then reported as "quit and
  was reopened" when nothing had been reopened. Now only an app TreeMap
  reopens is offered **Restart**, and any other program **Quit**; for a
  helper, the sheet says which app it runs inside and that its unsaved work
  could be lost. An app TreeMap could not reopen as it was started, such as
  a background app, one another program started or one started with options
  of its own, is offered **Quit** too, with the reason. Each button is named
  with its program, so a screen reader tells them apart. The card no longer
  says nothing is stuck when some open files went unchecked: an open file
  TreeMap may not look at, which 5.0.1 on a Mac listed as a deleted file
  still holding space, is counted as not checked, and so, on Linux, is a
  program of yours whose open files TreeMap may not read, such as
  ssh-agent. The card says how many, its total reads "At least", and Missing
  GB's line becomes a floor, not a total. Both cover only your own programs,
  which are all TreeMap can see unless it runs as root, and say so whether
  or not they list any. On Windows, where TreeMap cannot see held files,
  Missing GB's line is unknown, with the reason, where it said nothing was
  held.
- **The Security panel no longer raises false alarms, and reaches every
  finding.** A Keynote document (`.key`) was listed as a serious private key
  and offered a move into `~/.ssh`, and Apple's own certificate files inside
  system frameworks were 12 "serious" findings on a stock Mac. Both are now
  minor and never moved, and the headline no longer counts such files as
  sitting outside the folder they belong in: it says how many sit in folders
  that installed software or the operating system keeps for itself, such as
  Program Files, AppData and ProgramData on Windows, and each of their rows
  says what that folder is. A `.pem` file is described by what
  its name suggests, public certificates or a private key, or else as one
  that may hold either, where every one, public certificate bundles
  included, was a serious finding said to usually hold a private key or a
  certificate with one. One whose name suggests public certificates, such
  as cacert.pem, is now minor, and a folder named certs or ca-certificates
  counts as a proper place for a `.pem` unless it syncs to the cloud or is
  easy to share. Keys in iCloud Drive, in Box and in Google Drive's My Drive
  are known to be in folders that sync to the cloud, which makes a finding
  more serious, and no folder inside one counts as a key's proper place,
  `.ssh` included. 5.0.1 showed the first 500 findings it came across, and
  the rest could not be reached; the panel now lists the most serious
  first, 500 at a time, and **Show more** brings in the next 500. **Move to
  .ssh** is offered only where TreeMap will make the move: when `~/.ssh` is
  outside every folder you scanned, something there already has the file's
  name, or the finding is a link or has gone since the scan, the finding
  says so in place of the button, where the move used to fail once you had
  confirmed it. A Google Cloud or Azure credentials file is offered its own
  tool's folder, where 5.0.1 offered **Move to .aws**. A hard link's second
  name shows the file's size rather than 0 B.
- **On a Mac, folders macOS will not open are counted and named.** gdu, the
  engine 5.0.1 normally used on a Mac, reports a refused folder as an empty
  one, so such folders fell out of the total and the "could not be read" row
  never appeared. The native engine counts them: the Dashboard names them,
  says how many it does not name, and **Show all** lists every one; and the
  Missing GB receipt counts them instead of saying "unknown".
- **Changing the "Don't scan" list is no longer read as files removed or
  added.** A pattern added between two scans leaves out files that are still on
  disk, and one taken away counts them again, but in 5.0.1 every view that
  compares scans took that for a change on disk: What's new reported space
  freed and offered to look for the files in local snapshots, Trends, Compare
  and `compare_scans` called them removed or new, the journal said "an
  unidentified process" had removed them, a scheduled scan could warn that a
  folder had grown, the time slider's Diff painted the difference as growth or
  shrinkage, and the forecast and the folder budget gauges drew a line through
  the jump and gave a date the disk would fill or a folder would pass its
  budget. A fast rescan also went on counting what a new pattern matched, in
  every folder it did not list again. Now What's new says your "Don't scan"
  rules changed, each scan records the list it ran under, and a fast rescan
  applies the current list to the folders it reuses. Scheduled scans' journal
  entries and growth warnings, the time slider, the forecast and the budget
  gauges no longer compare a scan with one made under another list; Compare and
  `compare_scans` leave out what a pattern hid from only one of the two scans,
  and say in how many folders; and where Trends or Compare cannot tell whether
  two scans ran under the same list, an item in only one of them reads
  "removed, or no longer scanned" or "new, or scanned again". Scans made before
  this update record no list, so the forecast and the budget gauges start their
  history again, and say why while it is too short.
- **The "Open Privacy settings" button opens System Settings.** In the
  desktop app it did nothing, because the window's own link guard dropped the
  link; it now opens **Privacy & Security › Full Disk Access**, or says where
  to go when it cannot.
- **Scanning a link to a folder scans the folder.** A scan of `/tmp`, `/var`,
  `/etc` or a project folder that is a link showed a single tile, the link.
  It now scans the folder the link points to, and says so, and the picture
  TreeMap paints first from its index shows that folder too.
- **In the desktop app, Save view and fleet pairing did nothing.** They asked
  their question in a kind of browser prompt the desktop app never shows; they
  now ask in TreeMap's own dialog.
- **In the desktop app, every folder you hand TreeMap is scanned, and the menus
  work.** In 5.0.1 only the first folder handed to the app was scanned until
  its window was closed and opened again: after it, **Scan folder…** and **Scan
  home folder** in the File menu or the tray, a folder dropped on the Dock,
  Open With, "Scan with TreeMap" and a second launch only brought the window
  forward. The Dock's progress bar, and the bounce and notice when a long scan
  ends while TreeMap is in the background, never appeared. Now each folder is
  scanned in turn. One asked for while a scan runs is said to be queued, with
  how many are before it, and is scanned when its turn comes without taking
  focus from the app you are in; a folder already being scanned, or already
  waiting, is not scanned a second time, however its path is written, and
  several files dropped from one folder scan it once. The Dock or
  taskbar icon shows a scan's progress, and a scan that ends while TreeMap is
  in the background bounces or flashes the icon and says in a notice how many
  files it found, their size, and how many folders it could not read. On a Mac,
  with the window closed, a folder dropped on the Dock or opened with TreeMap
  opens the window. Five menu items did nothing: **Settings…**, **Rescan**,
  **Command palette…**, **Toggle sidebar** and **Keyboard shortcuts**; they now
  work, also when chosen while the window is closed. A Stop says how many
  waiting folders it will not scan, where it dropped them without a word, and
  the window's own queue no longer tells every folder after the first that it
  scans next. On Windows, "Scan with TreeMap" on a drive scans that drive,
  where it scanned nothing. The menus, the tray and the update dialogs are in
  sentence case, as the window is.
- **Exports.** A CSV of a large scan could come back empty: all 303,478 files
  of one test folder gave an empty reply. It now streams, about 40 MB for that
  folder. Long paths in the PDF report wrap inside their column, so the Size
  column stays on the page, and "CSV — all files" and "CSV — all folders" are
  saved under different names. A CSV, Excel or PDF report is named after the
  scanned folder it holds, not the folder the map is drilled into. The SVG
  export draws the map in the colouring on screen, where it always used the
  size colours, with the same tiles, outlines, name tags and labels as the
  window, at the map's exact size.
- **On Windows, deleting an item whose name ends in a dot or a space could
  send a different file to the Recycle Bin.** Windows trims such a name, so it
  took the neighbouring item with the shorter name, if there was one. TreeMap
  now leaves such an item alone and says why.
- **A file whose name begins with an invisible byte-order mark was taken for
  another file.** TreeMap read such a name, one that begins with the
  character U+FEFF, without the mark, so the file was listed under the path
  the plain name would have, and a move to the Trash, the cart, Autopilot or
  an offload acting on it reached the file of that plain name beside it,
  where there was one; a file named only the mark was given its folder's
  path. Such a name now keeps its mark.
- **Clean Up no longer calls a folder rebuildable on its name alone.** In
  5.0.1 any folder named `.venv`, `coverage` or `.gradle` was offered, at
  high confidence, as a tool cache "rebuilt automatically when needed": a
  `.venv` that nothing makes again by itself, a folder of your own called
  coverage, or the `.gradle` in your home folder, where Gradle keeps its
  settings, which can hold passwords. A folder named `env` or `venv` beside
  a Python project's files was offered as a virtualenv whatever it held, and
  Clean Up went into virtualenvs and installed Python packages, offering
  pip's own `build` folder as build output. Now a virtualenv must hold
  `pyvenv.cfg`; coverage reports must hold a report a test tool writes,
  beside a JavaScript, Ruby or Flutter project; a `.gradle` must hold what a
  Gradle build writes there and none of Gradle's own settings; and installed
  Python packages are left alone. On Windows the Temp folder is listed with
  advice and never offered for the Recycle Bin, where it was offered whole
  as a developer cache.
- **The app now carries the licences of what it bundles.** The macOS app
  shipped Electron and Chromium without their licence files, and the notices
  of the libraries built into gdu were missing on every platform. Both now ship
  inside the app, beside the native engine's own, and **About** names them.
- **Screen readers hear what each view is working on, and the notes that
  appear.** In 5.0.1 a card or view that was loading put its words where a
  screen reader does not read them, or had none, and a note or warning that
  appeared on screen was seldom read out. Now the Disk topology, held-up space,
  Drive health and Cost to keep cards, Apps, Security, Libraries, Fleet,
  History, the Undo Vault, Missing GB and each Clean Up pane say what they are
  working on, and these are read out as they appear: the open-file warning in a
  "Move to Trash?" dialog, the Preview after banner, the Highlight box's
  messages, what plain-words search says while it works or when it cannot help,
  the index badge, Missing GB's statement, in a sentence where 5.0.1 read out
  the whole receipt, and the notes on the map, under the Circles and Voronoi
  layouts, in Disk City, the Calendar and the journal. Coming back to a view
  reads its notes again. A scan's progress is announced whichever view is open,
  where 5.0.1 counted it aloud only on the Dashboard, and a notice, or a scan's
  progress, end or Stop, that comes while a dialog is open is read out once.
- **Smaller fixes.**
  - On a Mac, a change made while TreeMap started or stopped watching another
    folder could go unnoticed while that folder's index still said it was live;
    watches are now shared, and a folder that may have missed a change is
    marked out of date, with the reason.
  - Pressing Stop in a scan's last moment no longer lets it finish as
    "complete" and save what you stopped, and pressing it while TreeMap is
    still checking the folder's index no longer lets the scan start anyway.
    A scan stopped before the server answered, which then fails, no longer
    reports that failure over the scan you started next, taking that scan's
    Stop away. After a rescan fails over an older map, that map's unopened
    folders still open.
  - Finishing a scan no longer pauses the app while it saves the copy a Fast
    rescan reuses.
  - A scan the window had to recover keeps its expiry warning and its count of
    folders that could not be read.
  - The warning that a scan's results will soon expire comes when they are
    about to, counting from the last time you used them, as TreeMap's own
    expiry does; it used to come about 28 minutes after the scan finished,
    however much you had used it since. A scan TreeMap stops at its six-hour
    limit says so, and one its server no longer has says the server may have
    restarted, where both were said to have expired.
  - A folder tree nested more than about 950 levels deep is no longer refused
    as too large to show.
  - Windows no longer tries the gdu helper first, which failed there on every
    scan.
  - On Linux, a disk formatted without partitions, common on cloud machines,
    now appears in Missing GB and on the Disk topology card, and a drive
    mounted under /run/media, where Fedora, Arch and openSUSE put USB and
    backup drives, can be scanned, opened and offloaded to; 5.0.1 refused
    everything under /run.
  - Checking local snapshots for a deleted file no longer says none of them
    hold it when some could not be opened, and a copy found in an older
    snapshot because a newer one could not be read says it may not be the
    newest. A folder recovered from a snapshot reports the size of its files,
    not the few bytes of the folder entry itself.
  - Scripts that poll a scan's status no longer use up the allowance their
    next delete needs.
  - Search and the allocation panel never read an index that is still being
    built, and the panel says "Not measured for this index." rather than
    showing the size files claim as the space they occupy. When two indexed
    folders, one inside the other, both hold a file, search lists it once,
    from the index that is up to date, and says results may be out of date
    only when a result it shows came from an index that may be.
  - When the scan that refreshes a folder opened from its saved index fails,
    the index badge says the index may be out of date, where it went on
    saying the index was current.
  - A clean scan no longer repeats the previous scan's "N folders could not be
    read". And while a new scan runs, the Dashboard no longer shows the last
    folder's figures: its file-type ring, largest file, forecast and index
    badge wait for the new one.
  - When the Trash could not be read, the System card's Trash row reads
    "Unknown", with "Couldn't read all of it" under it and the reason on
    hover, instead of "at least 0 B", and the card reads the disk's figures
    again after every scan.
    The Trash sheet then says plainly what it could not read and what that
    leaves unknown, instead of calling a total it does not show "a minimum".
    "Empty the Trash?" is asked over the Trash sheet, so Cancel goes back to
    it instead of closing both, and a yes hands keyboard focus back to where
    the sheet was opened from instead of losing it.
  - The Dashboard's engine line counts its items as files and folders and
    says in plain words why the built-in walker ran; how that engine reads
    the disk is under **Engine details**, where the line spoke of "parallel
    I/O threads" and "Node's default 4". When a faster engine failed, **Why
    the faster engine could not run** gives the details, and a scan too
    short to measure gives no speed. A scan over in less than a twentieth of
    a second takes "under 0.1 s" there and on the scan's status line, not
    "0.0 s".
  - One is counted as one: a scan of one file says "1 file", a scan that has
    found one item "1 item", and an undo of one item "puts it back where it
    was", not "puts all 1 back where they were". An index TreeMap is not
    watching says so instead of claiming TreeMap was closed.
  - Missing GB's line for what files claim against what they hold gives both
    of its parts, and counts the same files the Dashboard names, instead of
    a different-looking figure over "N items". Its Purgeable line no longer
    calls purgeable space one of the largest things on this Mac, a size it
    cannot measure; it says whatever that space holds is counted in
    Unaccounted. The bar's first segment, drawn shorter by the corrections
    below it, is named for what it shows ("Files TreeMap scanned, after the
    corrections below it"), with how its figure was made, where it gave the
    line's own name beside a smaller figure than the line states.
  - Disk topology shows each APFS volume's own free space; it showed the
    container's ceiling less the volume's use, 450 GB free on a disk with
    208 GB free.
  - Paths shown by their end keep their leading "/" at the start.
  - On a Mac or Linux, where a backslash can be part of a folder's name,
    TreeMap no longer reads it as a separator: such a folder is one folder on
    the map, in its trail and Up, in Live mode, in the journal, and in Trends
    and Compare.
  - A folder whose name ends in a space is no longer mistaken for the folder
    without it: a folder sent from the VS Code extension, a scheduled scan's
    folder and a folder budget used to act on the other one.
  - In the Grid, Up is disabled at the scanned folder, every tile shows its
    name and size, and the filter clears when you open another folder. A folder
    it cannot load says why, such as the scan's results having expired, where
    it told you to check your connection, and an archive's hover card no longer
    offers a click to look inside, which previews it there.
  - On the map, the Reclaim colouring asks for the scores of whatever is drawn
    after every drill, layout switch or Up, and never asks again for scores it
    could not get. The hover magnifier uses the map's own colours, the
    keyboard selection's card no longer floats over the cart, the Preview after
    banner no longer covers the top tiles and keeps "Exit preview" on one
    line, the time-lapse bar steps aside while that preview is on, and that
    bar no longer pushes the map's footer out of the window. While the
    preview is on, an archive's hover card says you can look inside it after
    the preview, where it invited a click that does nothing then, and with
    the cart open beside it, the map, its key and its status line keep clear
    of the cart. With a drive connected, the map and Disk City leave room for
    the drive dock under them instead of running past the bottom of the
    window. A disk image (`.dmg`) previews like any other file instead of
    showing an error.
  - On the map, j and k step only through what is drawn in the folder on
    screen: in a big scan they did nothing in some folders, or picked the
    scanned folder's own top folders, which were not on screen, for Enter, the
    cart and Delete. A selection the map stops drawing, as when Hide cloud
    hides it or Live mode sees it deleted, is let go, and a screen reader is
    told, where those keys still acted on it. Over the sunburst, which
    highlights nothing, a search in the Highlight box says how many matched and
    where they can be seen, where it counted another folder's rectangles, and
    back on the map from another view, a search's total, explanation and Stage
    button come back with its highlights. The Highlight box's count of matches
    shown follows the map as you raise Depth, open a folder, go up or turn on
    Hide cloud, where it kept the figure it first gave, and matches Hide cloud
    hides are said to be hidden by it, not deeper than the view draws. With
    Live on, the Preview after keeps its picture, which Live, the time slider
    and Play used to replace under its banner, and a folder you open while the
    map is still moving to a new layout stays on screen, where the end of that
    movement could put the older picture back. An archive still being listed no
    longer opens over a folder you clicked in the meantime. Circles and Voronoi
    no longer count the folder on screen as a match of its own, and their
    status line counts the folders drawn without their contents apart from the
    shapes that have none. In Sunburst the hint line no longer offers the lasso
    and the magnifier, which do not work there, and with Hide cloud on over a
    folder of online-only files, the map says they are hidden, not too small to
    draw.
  - A folder opened from its saved index is drawn on the map at once, and
    stays drawn for the whole of the scan behind it; in 5.0.1 the map stayed
    blank, or kept the previous folder's drawing, until that scan finished,
    and for good if you stopped it. While it runs, every view asks the scan
    the map on screen came from, or, over the saved index, says it fills in
    once that scan finishes. Stopping it puts back the map you had before,
    with its scan, or says that the map on screen is the saved index, and
    the views then say to scan the folder rather than that they are loading.
  - A search in the map's highlight box is cleared when a scan of another
    folder opens, instead of dimming the new map with "0 matches"; a rescan
    of the same folder keeps it.
  - Disk City never draws the previous scan's folder under the new folder's
    name, and its hover card leaves with the folder Esc climbs out of. Its
    key says a building's footprint is the size each file claims, as the map
    counts, where it said "size on disk", and its size reads as the total
    ("9.5 GB total") rather than as the top of the colour scale. Its Trash
    building opens the Trash sheet, as the map's does, where it offered to go
    inside, failed with an error, and kept the other buildings' file counts
    from arriving, and a folder or archive the map was still loading when Disk
    City opened no longer lands in it.
  - History › Compare names each scan's folder in its Before and After lists,
    tells apart two scans made in the same minute, and no longer leaves an
    older comparison under lists that have moved on. When nothing changed,
    Trends and Compare say so, instead of "grew by 0 B" in the growth colour.
    Trends' Folder list leads each folder with its own name rather than the
    start of a long path, and its Since previous scan card tells two scans of
    one day apart by their times. After a folder's first scan, Compare says
    there is only one record of it so far, where it offered that scan and
    its own snapshot as a pair and then refused to compare them. Compare said
    "biggest 1,000 shown" over 200 rows; it now says how many differences there
    are and that it lists the biggest 200. When the scanned folder holds more
    than 100 items, as Downloads often does, Trends, Compare and the What's new
    banner called an item removed or new when it had only moved past the 100
    largest that a snapshot keeps; such an item is now left out and counted, or
    shown as grown or shrunk by at least what is known. Compare,
    `compare_scans` and the journal no longer call the files in a folder one
    scan could not read removed, as they did between a scan made with Full Disk
    Access and one made without it. Trends no longer draws one folder's history
    under another's name when you switch quickly, and the forecast no longer
    says "1 days" or calls 70 minutes "less than an hour".
  - In Live mode, a change in a scan of a whole disk grows the disk's own
    total, and the "Writing now" list no longer drops the first letter of each
    path.
  - Pausing the time-lapse shows the snapshot its label names instead of a
    blend of two, and a past snapshot's map says how much of it has no
    rectangle, since a snapshot keeps only each folder's biggest items a few
    levels deep. With Diff on, an item is no longer painted as new because the
    earlier snapshot did not keep it or could not read its folder, and a folder
    that a later scan could read more of, as after Full Disk Access is given,
    is no longer drawn as grown.
  - A day picked in the Calendar, or a journal entry opened on the map, finds
    that day's files rather than every folder touched that day. The journal's
    **Show on treemap** works after a scan of a whole disk, where it answered
    "Scan / first", and a search result in a folder whose name only begins
    like the scanned folder's no longer opens inside it.
  - In the charts, sunburst labels are shortened with "…" instead of squeezed,
    the Reclaim radar's labels are no longer cut, Trends with one snapshot
    draws its point whole, an empty chart says "No data yet." without made-up
    axis numbers, legends say "1 file", the file-type list's tail reads
    "Other", and the Apps chart's top label no longer crowds the one below.
  - In Duplicates, the hashing progress counts every file of each pass and
    names the pass instead of sitting at 0 until done, and Compare copies tags
    "largest" and "newest" only when the copies differ. On the Near-duplicate
    images tab, **Auto-select (keep newest)** is disabled, and says why, when
    it has nothing to select; a press used to do nothing. And with no
    finished scan, or on a cloud account's scan, neither tab still offers to
    move to the Trash what it had selected for an earlier scan.
  - Shrink video counts the videos it could not read instead of calling
    everything "already in an efficient format".
  - Right-click › **Why this reclaim score?** opens the breakdown and leaves it
    open; the same click used to close it at once.
  - A folder already over the budget you set is said to be over it, in the
    notice and on the Dashboard's gauge, which counts past 100%. A folder
    growing slowly toward a budget it will reach, by less than about 1 MB a
    day, gets the date it will pass it, where the gauge said "flat — no breach
    in sight".
  - The "≈ N photos like the ones here" hint no longer counts icons as
    photos: a file joins the sample from 100 KB for a photo and from 1 MB for
    a video or a song.
  - The Apps view calls zoom.us "zoom.us", not "Us", and a folder named
    "Python 3.11" keeps its name instead of "11".
  - An Autopilot policy whose folder is a link is refused when you save it,
    naming where the link leads, instead of being saved to match nothing.
  - An Autopilot run card, and the policy editor's Preview, list up to five
    reasons the run left something alone, each with how many items it covers,
    and count the reasons past those, instead of the first reason and "and N
    more", and a run that left everything it matched alone no longer says
    "Nothing matched this time." A failed run no longer says "Nothing matched."
    either, and an item bigger than the policy's own limit says that no run of
    it will remove it, where every run promised it to a later one.
  - Paired computers now see which version an installed TreeMap is; they saw
    none. The Fleet panel names the one address TreeMap listens on, where it
    listed every address the computer has.
  - The search index no longer takes a file on one drive for a second name of
    a file on another drive that shares its number, which showed it as 0
    bytes.
  - A dialog that only reports shows one Close button, and no dialog keeps
    another's button labels.
  - A query field typed with a typo gets a hint naming the nearest field
    instead of a bare "0 matches".
  - Drive health no longer says a drive "reports no wear indicator" when
    TreeMap could not ask it, and no longer suggests Homebrew.
  - On a Mac, the held-up space card and the warning about open files name
    each program in full, or end a name they cannot complete with "…", where
    they showed the first 31 characters lsof gives ("Google Chrome Helper
    (Aperitif "). Names and paths that lsof writes in escape codes, such as
    accented letters when TreeMap is opened from the Dock, or a backslash,
    are read back as written, so such a file is found in use before it goes
    to the Trash, and is no longer listed as a deleted file still holding
    space. Nor is a file whose own name ends in "(deleted)", on a Mac or on
    Linux. On Linux, when a program of yours keeps TreeMap from reading its
    open files, as ssh-agent does, the check before a move to the Trash says
    it could not see every program, where it gave no warning at all.
  - The Cost to keep card says nothing about staying on the same plan to
    someone on a free plan.
  - Settings and the Undo Vault view say exactly which deletions are copied,
    those from the Clean Up cart and Autopilot, instead of "only automatic
    ones", and "How TreeMap measures space" says the totals count the size each
    file claims. The Undo Vault's size cap in Settings now says it is a share
    of the disk's free space, counting what the Undo Vault holds, where it read
    as a share of the whole disk.
  - Settings cannot be saved until your settings have loaded, and says why when
    they cannot be read: in 5.0.1 a Save after a failed load wrote empty
    scheduled scans, an empty "Don't scan" list and no cloud client IDs over
    yours. A figure outside its field's range is refused with a sentence naming
    the field, where it was quietly changed: a 0 in **Keep copies for** was
    saved as 30 days. If the saved folder budgets cannot be read, setting or
    removing one saves nothing, where it deleted every budget outside the
    folder on screen. And Settings offers the first-run tour as up to three
    quick wins, not three.
  - TreeMap keeps one copy of a settings or record file it cannot read, beside
    it, for each way the file has gone bad. In 5.0.1, once a file had gone bad
    a second, different way, every later read of it made another copy.
  - A 12-hour clock reads "5:19 PM", not "05:19 PM".
  - Smart suggestions name the folders a rule matched as the files spell
    them ("Cargo.toml"), send you to "the Media libraries card in the Libraries
    view", as the window names them, and no longer mention an API
    route. The Python virtualenv suggestion no longer says
    `pip install -r requirements.txt` puts it back, which makes no
    virtualenv and fails where there is no requirements.txt; it names the
    command for its own folder, such as `python3 -m venv .venv`, and says to
    reinstall the packages it held. The "Old downloads" rule says its files
    were not changed in 90 days or more, where it called them untouched: it
    reads only when a file last changed.
  - In Clean Up, a package folder whose project is still there, such as a
    project's `node_modules`, is no longer a dimmed "in use" row above the
    suggestions while a suggestion below offers the same folder: such
    folders are listed last, in a closed section, **Folders whose project is
    still here**. Package leftovers now holds only what you can tick,
    orphaned folders and shared caches, and no package folder's row names a
    command as the way to put it back, where 5.0.1 offered `npm install` "to
    restore" a folder whose project was gone. Its header says "N orphaned —
    each row says why", where it said nothing would rebuild them, and a
    folder with no project file beside it says TreeMap finds no project that
    owns it, not that its project is gone: a `.venv` beside the scripts that
    still use it can be such a folder.
  - In Clean Up, a Smart suggestion's description, and the command that puts
    it back or the way to reclaim it, each take a line of their own and wrap.
    They shared one line, where one group's advice ran far past the edge of
    the sheet and squeezed the descriptions beside it to nothing. Only a
    command is set as code, not a menu path or a sentence.
  - In Clean Up, **Select all** in Custom rules and Empty folders follows its
    rows: ticked only when every row is, and part-ticked when some are. It
    stayed ticked when a row was unticked.
  - In Smart suggestions, **Biggest first** and **Safest to reclaim first**
    keep the rows you ticked, the type of suggestion shown, any "Why is this
    suggested?" panels you opened and keyboard focus; changing the order
    cleared all of them, and cleared them again when the reclaim scores
    arrived.
  - In the desktop app's smallest window, the map's Highlight field no longer
    covers the Voronoi tab or cuts its hint off mid-word, the time-lapse bar's
    **Diff** no longer wraps onto a row of its own, and the History calendar
    shows all four quarters of a year. Largest files keeps its names readable
    in Reclaim order, the Offloaded and Undo Vault search boxes fill their
    field, the Dashboard no longer scrolls sideways under the sidebar, the
    Clean Up cart's tab no longer covers the Grid's selection bar or the map's
    hint line, and a toolbar label such as Sort, Before or After stays with
    its menu.
  - The preview pane makes room instead of covering the page: it lay over the
    right of the window, hiding "Exit preview", the Grid's Sort and Filter
    and, in a small window, the selected tile itself.
  - The preview pane says that when a file was last opened is not known, and
    why, where it said "Never opened since it was saved" on a drive or a
    computer that does not record openings.
  - The first-run tour's card stands to the left of the open Clean Up cart
    instead of over its buttons, and moves clear of the view's own controls,
    the map's match bar and its footer where there is room, such as the Scan
    card's **Browse…** and **Scan** in a small window.
  - Clear in the Grid's selection bar and in the Clean Up cart, Escape in the
    Grid and in the sidebar search, and closing the duplicate viewer, a preview
    opened from a Grid tile or the summary of a cart commit hand keyboard focus
    back instead of dropping it to the top of the page. A click into a text
    field while the reclaim-score breakdown is open leaves focus in that field.
    A cart button on a staged item tells a screen reader that it removes the
    item, and the cart's tab is named by the words it shows, so a voice user
    can open it by saying "Review", and tells a screen reader whether the cart
    is open. **Scan**, Clean Up's **Find**, Autopilot's **Save** and the folder
    picker's button keep keyboard focus while they wait for an answer. With
    the first-run tour waiting for a scan, a Stop pressed as a folder's saved
    index is drawn no longer moves focus to the tour's card. In Safari and
    Firefox on a Mac, which do not focus a button you click, closing a dialog
    opened by a click puts focus back on that button. Pressing Up until it
    reaches the scanned folder, or a part of the folder trail, moves focus to
    the map, the Grid or Disk City instead of dropping it, and removing an
    Autopilot policy or approving a run keeps focus in its list, as does **Try
    again** when the policies could not be loaded. Disk City's list of
    buildings keeps focus on a building's row as it is redrawn.
  - Drop-down lists keep their arrow in the light theme and while focused, a
    Duplicates group's header shows its focus ring when reached with Tab,
    and Quick stats always shows the largest file's size, shortening a long
    name with "…" instead.
  - On Windows and Linux, the shortcuts sheet and hints say Ctrl and Alt
    instead of ⌘ and ⌥. On Linux, "Reveal in file manager" shows the item's
    folder instead of opening the item.

### Security

These are described briefly on purpose. Each is fixed only in 5.2.0, so
please update.

- **On Windows, a file or folder name could be run as a command.** Open and
  Open Terminal Here handed a name to a part of Windows that reads it as a
  command line, so some punctuation broke Open and a specially made name could
  start a program; a drive's free-space check had the same flaw for a network
  path sent through TreeMap's API. Every name now goes to Windows as plain
  data.
- **A project folder prepared by someone else could make git run a
  program.** To say whether a project is safely pushed, TreeMap runs git in the
  projects inside the folders you scan, and git followed each project's own
  settings, so a project from a download or a second-hand drive could make it
  start a program; "Run git gc" could also be pointed at another repository and
  prune it at once. Git now runs with everything it could start by itself
  switched off, a project that asks for more shows as unknown with the reason,
  and git gc runs only on a real `.git` folder and keeps two weeks of dropped
  work. Expect more "unknown" answers about copies elsewhere.
- **A planted link could redirect a file TreeMap wrote.** Whoever prepared an
  offload drive, a portable copy's data folder, or a folder another account can
  change could leave a link where TreeMap was about to save its offload record,
  a re-encoded video, the portable copy's settings or, on a Mac, a file
  restored from a local snapshot with your administrator password. These are
  now written under a fresh name and then moved into place, a restore into a
  folder other accounts can change is refused before the password is asked
  for, and a portable data folder that is or holds a link is not used. On a
  Mac, a local snapshot mounted for a restore could also be read by any
  account while it was mounted; it is now mounted read-only, inside a folder
  only root can enter.
- **A program using TreeMap's API could get past some of its safety
  rules.** A specially formed request could make Open, Open Terminal Here and
  "Move to a safer location" act outside your scanned folders, or put a file
  into TreeMap's own data folder, whose records TreeMap trusted enough to
  remove a folder or run Autopilot where you never chose. After a scan of the
  whole disk, a request could also reach files on other drives the scan never
  listed, and a scan of macOS's Data volume counted as permission over every
  file on the Mac. A scan still running, or one that failed or was stopped,
  counted as that permission too. And a path could be spelled through a second
  name the system gives every file, on a Mac `/.nofollow`, `/.resolve` or
  `/.vol`, on Windows a device path, the computer's own administrative shares
  or a stream name, to slip past these rules. This needed a program using the
  API or the MCP server: the window never sends such requests, and the desktop
  app's API key changes at every launch and is no longer handed out by its page
  (below). Every path in a request is now checked where it really leads, an
  action reaches only what a finished scan listed, nothing can be written into
  TreeMap's data folder, and a record not in the shape TreeMap writes is
  refused.
- **In the desktop app, other programs on the computer could use TreeMap's
  API.** 5.0.0 gave the API a key that changes at every launch, but the
  window's page handed that key to anything that loaded it, so a program run by
  any account on the computer could read it and then act as TreeMap: preview
  your files, scan with its Full Disk Access and move files to the Trash. The
  window now gets a session of its own before its page loads, and loading the
  page hands out nothing.
- **Limits set for agents, and requests from paired computers, now hold
  everywhere.** The folders an agent policy allows (`agent-policy.json`) did
  not cover scheduled scans, and a link inside an allowed folder let a scan,
  an index build, and then a delete, reach outside them. A protected path
  could be reached through a link, in another letter case, or by the Data
  volume's longer spelling. After a scan of your home folder, the policy file
  and the audit log could themselves be moved to the Trash, and with the
  policy gone nothing was limited. A snapshot restore told to replace a file
  sent that file to the Trash without checking either the policy or your
  scanned folders. A delete under a scan that had not finished went past the
  policy's byte limit, counted as 0 bytes, and neither Autopilot nor a video
  re-encode kept to that limit at all. A paired computer allowed to start scans
  here could start one on any folder, system folders included; on Windows it
  could make this computer sign in to a network share it named, and on a Mac
  mount one by naming a folder under `/net`, `/Network` or `/home`. Every scan
  now passes the same path rules and allowed folders whoever asks for it, each
  path is judged where it really is, the byte limit binds Autopilot and the
  re-encode too and refuses a path no finished scan has sized, the policy file
  and the audit log are never moved or deleted through TreeMap, and on Windows
  a paired computer may only scan a folder on one of this computer's own
  drives. Pairing, and letting a paired computer start scans, are both off
  unless you turn them on.
- **A right-click entry added while TreeMap ran in a browser could run a
  folder's own code.** "Scan with TreeMap" started whatever program was running
  TreeMap, so added from Settings while TreeMap ran from `npm start`, it
  started Node on the folder it was used on, which runs that folder's own
  program instead of opening TreeMap; from a Linux AppImage or the Windows
  portable build, it pointed at a copy deleted when TreeMap quits. Only the
  installed app now offers the entry. Settings says what an entry already in
  place starts and offers to remove one that starts anything else, and if
  adding the entry fails it says so, with the reason, where it said "Removed."
  The Finder, Dolphin and Thunar entries quote the program they start, so a
  space or a quote in that program's path no longer breaks them, and `$(…)`
  there runs nothing.

### Known limitations

- **A scan still counts copy-on-write clones at full size.** On a Mac with
  many cloned files, a scan of `/` can count more than the disk holds, and the
  Missing GB receipt then ends with a negative Unaccounted line.
- **The first scan of a folder with more than about 6.2 million items is still
  read twice** unless the folder is a whole disk, and the count stands still
  while it is read the second time. The next scan of that folder is read once.
- **Right after a very large scan, TreeMap can still pause briefly:** a few
  steps of finishing a scan still run in one piece.
- **When gdu scans, a folder macOS refuses still looks empty.** gdu, which you
  can choose in Settings and which stands in where the native engine is
  missing, does not count such folders, and Missing GB says that part is
  unknown.
- **A preview or thumbnail of an online-only file can still download it.**
  The duplicate finder leaves such files alone, but the preview pane and the
  thumbnails in Compare still read an online-only image or text file you
  point them at.
- **While any "Don't scan" pattern is set, every scan uses the slower built-in
  walker.**
- **The NTFS turbo mode has not been tried end to end on a real Windows PC.**
- **Shrink video re-encodes only on a Mac.** On Windows and Linux TreeMap
  cannot yet confirm a hardware HEVC encoder, so the panel there says why it
  offers nothing.
- **Every scan is still held in memory.** The mode that keeps a very large
  scan, tens of millions of items, in files on disk is being built and is not
  in this release. TreeMap also still runs on Electron; a lighter desktop
  shell is planned for a later release.

Unchanged from 5.0.0: the macOS build is not notarized (open it once, then
**System Settings › Privacy & Security › Open Anyway**), it is for Apple
Silicon only, the Windows installer is unsigned, and there is no Linux
download.

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
