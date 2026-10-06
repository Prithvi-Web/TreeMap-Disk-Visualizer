/**
 * `name` without its trailing dots and spaces, as Win32 drops them from every name, never shorter than
 * `keep` characters (a host keeps one: `.` alone names this machine).
 *
 * A loop, not a regex anchored at the name's end: such a regex tries the run from each character in it
 * and fails at whatever follows, so a long run of spaces inside one name of a request's path made the
 * fold take time quadratic in its length — 20,000 spaces held the server for a fifth of a second,
 * 40,000 for a second (POL item 8; its review, F1.4 and F1.7). Nothing in the app may trim this way:
 * tests/spillLeafLink.test.ts reads every source file for that shape.
 */
export function withoutWin32Tail(name: string, keep = 0): string {
  let end = name.length;
  while (end > keep && (name[end - 1] === ' ' || name[end - 1] === '.')) end--;
  return name.slice(0, end);
}
