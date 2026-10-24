import { spawn } from 'child_process';

/**
 * Property-list → JSON-shaped values, via macOS's own `plutil`.
 *
 * Why this exists: the macOS tools TreeMap needs (`diskutil`, `mdls`) have no
 * `--json`, but they do have `-plist`, which is a structured mode. §2.3 forbids
 * regex over *human-formatted* output where a structured mode exists. So the
 * pipeline is: tool → XML/binary plist → `plutil -convert xml1` → the reader
 * below. No regex touches any human-formatted text.
 *
 * Not `plutil -convert json`: JSON has no date, and plutil refuses any plist
 * that holds one ("Invalid object in plist for JSON format"). Every file
 * Spotlight has a last-opened date for is such a plist, so an mdls batch with
 * even one dated file failed whole, and Spotlight dropped out of the answer
 * (HC-L8). plutil still reads XML and binary plists alike and writes one XML
 * form, which `parseXmlPlist` reads: a <date> as its ISO 8601 text, <data> as
 * its base64 text, the rest as JSON would hold them.
 *
 * `spawn` rather than `execFile` because plutil reads the plist on stdin
 * (`-` as its input argument). Still an argv array, still no shell.
 */

export class PlistConversionError extends Error {}

/** The text of an XML element, its five named entities and character references read. */
function decodeXmlText(raw: string, fail: (what: string) => never): string {
  let out = '';
  let i = 0;
  for (;;) {
    const amp = raw.indexOf('&', i);
    if (amp < 0) return out + raw.slice(i);
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp);
    if (semi < 0) fail('an unterminated entity');
    const name = raw.slice(amp + 1, semi);
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    let ch: string | undefined = Object.prototype.hasOwnProperty.call(named, name) ? named[name] : undefined;
    if (ch === undefined && name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      const digits = name.slice(hex ? 2 : 1);
      const code = digits.length > 0 && [...digits].every((c) => (hex ? '0123456789abcdefABCDEF' : '0123456789').includes(c))
        ? parseInt(digits, hex ? 16 : 10) : NaN;
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) ch = String.fromCodePoint(code);
    }
    if (ch === undefined) fail(`an unknown entity &${name};`);
    out += ch;
    i = semi + 1;
  }
}

/**
 * Read an XML property list — as `plutil -convert xml1` writes it — into the values JSON would
 * hold: a dict as an object, an array, a string, a number, a boolean; a <date> as its ISO 8601
 * text and <data> as its base64 text. Anything that is not one whole property list is refused
 * with a PlistConversionError, never half-read.
 */
export function parseXmlPlist(xml: string): unknown {
  let i = 0;
  const fail = (what: string): never => {
    throw new PlistConversionError(`plutil produced a property list TreeMap cannot read: ${what} at offset ${i}`);
  };
  const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipMisc = (): void => {
    for (;;) {
      while (i < xml.length && isSpace(xml[i])) i++;
      const close = xml.startsWith('<?', i) ? '?>' : xml.startsWith('<!--', i) ? '-->' : xml.startsWith('<!DOCTYPE', i) ? '>' : null;
      if (!close) return;
      const end = xml.indexOf(close, i);
      if (end < 0) fail('an unclosed declaration');
      i = end + close.length;
    }
  };
  type Tag = { name: string; closing: boolean; selfClosing: boolean };
  const nextTag = (): Tag => {
    skipMisc();
    if (i >= xml.length) fail('the end of the document where a tag belongs');
    if (xml[i] !== '<') fail('text where a tag belongs');
    const end = xml.indexOf('>', i);
    if (end < 0) fail('an unclosed tag');
    let body = xml.slice(i + 1, end);
    i = end + 1;
    const closing = body.startsWith('/');
    const selfClosing = !closing && body.endsWith('/');
    if (closing) body = body.slice(1);
    if (selfClosing) body = body.slice(0, -1);
    const name = body.trim().split(/[ \t\r\n]/)[0];
    return { name, closing, selfClosing };
  };
  const textOf = (tag: Tag): string => {
    if (tag.selfClosing) return '';
    const close = `</${tag.name}>`;
    const end = xml.indexOf(close, i);
    if (end < 0) fail(`no ${close}`);
    const raw = xml.slice(i, end);
    if (raw.includes('<')) fail(`markup inside <${tag.name}>`);
    i = end + close.length;
    return decodeXmlText(raw, fail);
  };
  const valueOf = (tag: Tag): unknown => {
    if (tag.closing) fail(`</${tag.name}> where a value belongs`);
    switch (tag.name) {
      case 'dict': {
        const out: Record<string, unknown> = {};
        if (tag.selfClosing) return out;
        for (;;) {
          const key = nextTag();
          if (key.closing && key.name === 'dict') return out;
          if (key.closing || key.name !== 'key') fail('a dict entry without its key');
          const name = textOf(key);
          const next = nextTag();
          if (next.closing) fail(`the key "${name}" without its value`);
          // Defined, never assigned: a key named __proto__ is a key, as JSON.parse keeps it.
          Object.defineProperty(out, name, { value: valueOf(next), enumerable: true, writable: true, configurable: true });
        }
      }
      case 'array': {
        const out: unknown[] = [];
        if (tag.selfClosing) return out;
        for (;;) {
          const item = nextTag();
          if (item.closing && item.name === 'array') return out;
          out.push(valueOf(item));
        }
      }
      case 'string':
        return textOf(tag);
      case 'date': {
        const text = textOf(tag).trim();
        return text === '' ? fail('an empty date') : text;
      }
      case 'data':
        return [...textOf(tag)].filter((c) => !isSpace(c)).join('');
      case 'integer': {
        const text = textOf(tag).trim();
        const digits = text.startsWith('-') || text.startsWith('+') ? text.slice(1) : text;
        if (digits === '' || ![...digits].every((c) => c >= '0' && c <= '9')) fail('an integer that is not one');
        return Number(text);
      }
      case 'real': {
        const text = textOf(tag).trim();
        if (text === '') fail('an empty real');
        const n = Number(text);
        return Number.isFinite(n) ? n : null; // plutil writes nan and inf, which JSON cannot hold either
      }
      case 'true':
      case 'false':
        if (textOf(tag).trim() !== '') fail(`text inside <${tag.name}>`);
        return tag.name === 'true';
      default:
        return fail(`<${tag.name}>, which is no property-list value`);
    }
  };

  const root = nextTag();
  if (root.closing || root.name !== 'plist' || root.selfClosing) fail('no <plist>');
  const value = valueOf(nextTag());
  const end = nextTag();
  if (!end.closing || end.name !== 'plist') fail('more than one value in the plist');
  skipMisc();
  if (i !== xml.length) fail('text after </plist>');
  return value;
}

/** Convert a plist document (XML or binary) to JSON-shaped values (see parseXmlPlist). */
export function plistToJson<T>(plist: Buffer, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn('plutil', ['-convert', 'xml1', '-o', '-', '-'], { windowsHide: true });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new PlistConversionError('plutil timed out')));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => errOut.push(c));
    child.on('error', (err) => settle(() => reject(new PlistConversionError(err.message))));
    child.on('close', (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new PlistConversionError(Buffer.concat(errOut).toString().trim() || `plutil exited ${String(code)}`));
          return;
        }
        try {
          resolve(parseXmlPlist(Buffer.concat(out).toString('utf8')) as T);
        } catch (err) {
          reject(err instanceof PlistConversionError ? err : new PlistConversionError(String(err)));
        }
      });
    });

    // A plist arriving on stdin can outrun the pipe buffer; end() flushes it.
    child.stdin.on('error', () => {
      /* plutil died early; the close handler reports it */
    });
    child.stdin.end(plist);
  });
}

/** Run a tool that emits a plist on stdout, and hand back parsed JSON. */
export function runPlist<T>(cmd: string, args: string[], timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new PlistConversionError(`${cmd} timed out`)));
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => errOut.push(c));
    child.on('error', (err) => settle(() => reject(new PlistConversionError(err.message))));
    child.on('close', (code) => {
      settle(() => {
        const body = Buffer.concat(out);
        if (body.length === 0) {
          reject(
            new PlistConversionError(
              Buffer.concat(errOut).toString().trim() || `${cmd} exited ${String(code)} with no output`,
            ),
          );
          return;
        }
        plistToJson<T>(body, timeoutMs).then(resolve, reject);
      });
    });
  });
}
