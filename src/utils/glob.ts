import os from 'os';

/**
 * Tiny glob matcher for the ignore list — zero dependencies.
 *
 * Pattern forms:
 *  - bare name (no separator), e.g. "node_modules" or "*.iso"
 *      → matched against the *basename* of every entry
 *  - absolute path or path glob, e.g. "/Users/me/Library" or "~/projects/** /dist"
 *      → matched against the full path; a match also covers everything beneath
 *
 * `*` never crosses a path separator, `**` does, `?` is one character.
 * Matching is case-insensitive except on Linux.
 */

export interface CompiledIgnore {
  raw: string;
  test: (fullPath: string, name: string) => boolean;
}

function globToRegExp(glob: string, caseInsensitive: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/\\\\]*';
      }
    } else if (ch === '?') {
      re += '[^/\\\\]';
    } else if (ch === '/' || ch === '\\') {
      re += '[/\\\\]'; // tolerate either separator in stored patterns
    } else if ('.+^$()[]{}|'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$', caseInsensitive ? 'i' : '');
}

export function compileIgnore(pattern: string): CompiledIgnore {
  const ci = process.platform !== 'linux';
  let p = pattern.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = os.homedir() + p.slice(1);
  }

  if (/[/\\]/.test(p)) {
    const trimmed = p.replace(/[/\\]+$/, '');
    const self = globToRegExp(trimmed, ci);
    const beneath = globToRegExp(trimmed + '/**', ci);
    return { raw: pattern, test: (fullPath) => self.test(fullPath) || beneath.test(fullPath) };
  }

  const nameRe = globToRegExp(p, ci);
  return { raw: pattern, test: (_fullPath, name) => nameRe.test(name) };
}

export function compileIgnoreList(patterns: string[]): CompiledIgnore[] {
  const out: CompiledIgnore[] = [];
  for (const p of patterns) {
    if (typeof p !== 'string' || !p.trim()) continue;
    try {
      out.push(compileIgnore(p));
    } catch {
      /* a malformed pattern must never break scanning */
    }
  }
  return out;
}

export function matchesAny(matchers: CompiledIgnore[], fullPath: string, name: string): boolean {
  for (const m of matchers) {
    if (m.test(fullPath, name)) return true;
  }
  return false;
}
