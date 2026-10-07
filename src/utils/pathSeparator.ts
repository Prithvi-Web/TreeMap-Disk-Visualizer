/**
 * The separator of a path, read off the path itself: "\" in a Windows path — a drive's (`C:…`) or a
 * share's or device's (`\\…`) — and "/" in every other, a cloud identifier's included.
 *
 * Never guessed from a backslash anywhere in the path: on macOS and Linux "\" is a character a name
 * may hold, so `/data/a\b` is the folder `a\b` in `/data`, and a scan rooted under it joined every
 * child with "\" — the journal named folders that do not exist, snapshot trees inflated under them,
 * and a lookup by path missed nodes that were there (POL item 7 review, F2.2). Nor is either
 * character taken as a boundary everywhere: a file genuinely named `a\b` inside `/x` would be
 * reported as living under `/x/a`. And never `path.sep`: a pure function's answer would depend on the
 * machine asking, and a `cloud://` path has forward slashes whatever the OS is (missingGigabytes,
 * where this rule was first written down — it broke every macOS-shaped fixture on a Windows runner).
 */
export function separatorOf(p: string): '\\' | '/' {
  return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') ? '\\' : '/';
}
