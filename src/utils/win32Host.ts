import os from 'os';
import { withoutWin32Tail } from './win32Tail';

/**
 * Whether the host of a UNC path is this machine, read the way Windows reads a host — for
 * `aliasNamespaceOf`, which refuses this machine's own admin shares (`\\localhost\C$` is C:\ again).
 * Pure but for `ownHostNames`, which a caller may stand in for, so Windows' rules are tested on
 * every OS.
 *
 * Only exact spellings were known (the SEC-2b review, F1.4), while Windows also reads an IPv4
 * address in the short, decimal, hex and octal forms inet_aton does (`127.1`, `2130706433`,
 * `0x7f.1`, `0177.0.0.1`), and an IPv6 one under `.ipv6-literal.net` with `-` for `:` and `s` before
 * a zone (`fe80--1s4.ipv6-literal.net`). Each is parsed to its value: loopback (127.0.0.0/8, ::1,
 * ::ffff:127.x), the unspecified address, or one of this machine's own addresses (an IPv4 one also
 * mapped into IPv6, ::ffff:a.b.c.d) is this machine;
 * any other name is compared with this machine's names by its first label, so
 * `mypc.corp.example.com` is `MYPC`. A host's trailing dots and spaces go first, as Win32 drops them.
 */
export function isThisMachine(host: string, ownHosts: readonly string[] = ownHostNames()): boolean {
  const h = withoutWin32Tail(host.toLowerCase(), 1); // never shorter than one character: `.` itself is this machine
  if (h === '.' || h === 'localhost') return true;
  const v4 = ipv4Of(h);
  if (v4 !== null) return v4 >>> 24 === 127 || v4 === 0 || ownHosts.some((own) => ipv4Of(own.toLowerCase()) === v4);
  const v6 = ipv6Of(h);
  if (v6 !== null) {
    if (isLoopbackOrUnspecified(v6)) return true;
    // An IPv4 address mapped into IPv6 is that IPv4 address: one of this machine's own is this
    // machine, as its plain spelling is (the final review, F1.2).
    const mapped = mappedIpv4Of(v6);
    return ownHosts.some((own) => sameAddress(ipv6Of(own.toLowerCase()), v6) || (mapped !== null && ipv4Of(own.toLowerCase()) === mapped));
  }
  if (h.includes(':') || h.startsWith('[') || h.endsWith('.ipv6-literal.net')) return false; // an address that parses as none
  return ownHosts.some((own) => {
    const o = own.toLowerCase();
    return ipv4Of(o) === null && ipv6Of(o) === null && o.split('.')[0] === h.split('.')[0];
  });
}

/** This machine's own names and addresses, as a UNC path may name it: asked only of an admin share's host. */
function ownHostNames(): string[] {
  const addresses = Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address));
  return [os.hostname(), process.env.COMPUTERNAME ?? '', ...addresses].filter((n) => n.length > 0);
}

/** One part of an IPv4 address as inet_aton reads it: hex after `0x`, octal after a leading `0`, else decimal. */
function ipv4PartOf(part: string): number | null {
  if (/^0x[0-9a-f]*$/.test(part)) return part.length === 2 ? 0 : parseInt(part.slice(2), 16);
  if (/^0[0-7]*$/.test(part)) return parseInt(part, 8);
  if (/^[1-9][0-9]*$/.test(part)) return parseInt(part, 10);
  return null;
}

/** A host as an IPv4 address the way inet_aton reads it: one to four parts, the last filling the bytes left. Null when it is none. */
function ipv4Of(host: string): number | null {
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const values = parts.map(ipv4PartOf);
  if (values.some((v) => v === null)) return null;
  const leading = values.slice(0, -1) as number[];
  const last = values[values.length - 1] as number;
  if (leading.some((v) => v > 255) || last >= 2 ** (8 * (4 - leading.length))) return null;
  return leading.reduce((sum, v, i) => sum + v * 2 ** (8 * (3 - i)), 0) + last;
}

/** A host as an IPv6 address — bracketed, or under `.ipv6-literal.net` — as its eight groups; null when it is none. */
function ipv6Of(host: string): number[] | null {
  let h = host;
  const literal = /^(.*)\.ipv6-literal\.net$/.exec(h);
  if (literal) h = literal[1].replace(/-/g, ':').replace(/s.*$/, ''); // `s` starts a zone, and is no hex digit
  else if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/%.*$/, ''); // a zone
  if (!h.includes(':')) return null;
  const v4 = /:([0-9.]+)$/.exec(h);
  if (v4 && v4[1].includes('.')) {
    const n = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4[1]) ? ipv4Of(v4[1]) : null;
    if (n === null) return null;
    h = `${h.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (s: string): string[] => (s === '' ? [] : s.split(':'));
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** ::1, ::, or an IPv4 loopback or unspecified address mapped into IPv6 (::ffff:127.x.x.x). */
function isLoopbackOrUnspecified(groups: number[]): boolean {
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] <= 1) return true;
  const mapped = mappedIpv4Of(groups);
  return mapped !== null && (mapped >>> 24 === 127 || mapped === 0);
}

/** The IPv4 address an IPv4-mapped IPv6 address (::ffff:a.b.c.d) carries, as one number; null for any other. */
function mappedIpv4Of(groups: number[]): number | null {
  if (!groups.slice(0, 5).every((g) => g === 0) || groups[5] !== 0xffff) return null;
  return groups[6] * 0x10000 + groups[7];
}

function sameAddress(a: number[] | null, b: number[]): boolean {
  return a !== null && a.every((g, i) => g === b[i]);
}
