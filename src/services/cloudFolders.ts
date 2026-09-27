/**
 * The one gate for "is this file a cloud placeholder?" that every engine
 * shares.
 *
 * A placeholder reports a logical size but occupies ~no disk blocks — and so
 * does any sparse file: a VM disk, Docker.raw, a Core Data store. The two are
 * told apart by WHERE the file lives, not by its blocks: only a file under a
 * known cloud-sync folder is a placeholder. The walker and the gdu mapper both
 * apply this gate; the live index must apply the same one, or the same folder
 * paints a cloud badge on its second open that its first open did not.
 */
export type CloudProvider = 'icloud' | 'onedrive' | 'dropbox';

/**
 * Where a rule's text must sit in a path: anywhere in it, or at its very end
 * (a regex's `$` without the `m` flag, which never matches before a final
 * newline).
 */
export type CloudRuleAt = 'anywhere' | 'end';

/** One rule of the gate, as data. */
export interface CloudRule<P = CloudProvider> {
  /** The provider of a path the rule matches. */
  readonly provider: P;
  /**
   * Printable ASCII the path must hold, compared ignoring the case of A–Z and
   * nothing else. That is the regexes' own rule: their `i` flag comes without
   * `u`, and without `u` no character outside ASCII matches one inside it —
   * U+212A KELVIN SIGN is not `k`, U+0130 is not `i`, U+017F is not `s` — so
   * a matcher over the path's bytes that folds A–Z alone (tm-store's) answers
   * exactly as they do.
   */
  readonly text: string;
  readonly at: CloudRuleAt;
}

const rule = (provider: CloudProvider, text: string, at: CloudRuleAt): CloudRule => Object.freeze({ provider, text, at });

/**
 * The gate as one table (decision P4-3a), in priority order: the first rule a
 * path matches names its provider. `cloudProviderFor` asks the regexes built
 * from it; tm-store's matcher (`derive::cloud_provider`) answers the same rows
 * as they do (tests/fixtures/cloudRulesOracle.ts writes the oracle both are held to),
 * for the storage modes that are to decide the rule during the walk. Each row
 * is a regex's alternative, unchanged: the `/` in `Library/Mobile Documents`
 * is a slash, so that rule never matches a path spelled with backslashes.
 */
export const CLOUD_RULES: readonly CloudRule[] = Object.freeze([
  rule('icloud', 'Library/Mobile Documents', 'anywhere'),
  rule('icloud', 'com~apple~CloudDocs', 'anywhere'),
  rule('icloud', '.icloud', 'end'),
  rule('onedrive', 'OneDrive', 'anywhere'),
  rule('dropbox', 'Dropbox', 'anywhere'),
]);

/** One regex of the gate and the provider it names. */
export interface CloudMatcher<P = CloudProvider> {
  readonly provider: P;
  readonly regex: RegExp;
}

/** Text a rule may hold: printable ASCII, one character at least. */
const RULE_TEXT = /^[\x20-\x7e]+$/;
/** Every character a regex pattern gives a meaning to, and `/`, which a regex's source escapes. */
const PATTERN_SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

/**
 * A table as regexes: one per run of consecutive rules naming the same
 * provider, in the table's order, each rule an alternative with its text
 * escaped and `$` after it for an end rule. The `i` flag and no other: `u`
 * would fold by Unicode (U+017F would match `s`, U+212A `k`), and `g` or `y`
 * would make `test` depend on the call before. A rule whose text the Rust
 * matcher could not follow — outside printable ASCII, or empty — is refused.
 */
export function cloudMatchers<P>(rules: readonly CloudRule<P>[]): ReadonlyArray<CloudMatcher<P>> {
  const runs: Array<{ provider: P; alternatives: string[] }> = [];
  rules.forEach(({ provider, text, at }, index) => {
    if (!RULE_TEXT.test(text)) {
      throw new Error(`cloud rule ${index} (${JSON.stringify(text)}): the text must be printable ASCII, one character at least`);
    }
    if (at !== 'anywhere' && at !== 'end') {
      throw new Error(`cloud rule ${index} (${JSON.stringify(text)}): it must sit anywhere or end, not ${JSON.stringify(at)}`);
    }
    const alternative = text.replace(PATTERN_SYNTAX, '\\$&') + (at === 'end' ? '$' : '');
    const last = runs[runs.length - 1];
    if (last && last.provider === provider) last.alternatives.push(alternative);
    else runs.push({ provider, alternatives: [alternative] });
  });
  return Object.freeze(runs.map(({ provider, alternatives }) => Object.freeze({ provider, regex: new RegExp(alternatives.join('|'), 'i') })));
}

/** The provider of the first matcher whose regex the path matches. */
export function firstMatchingProvider<P>(matchers: ReadonlyArray<CloudMatcher<P>>, p: string): P | undefined {
  for (const { provider, regex } of matchers) {
    if (regex.test(p)) return provider;
  }
  return undefined;
}

const CLOUD_MATCHERS = cloudMatchers(CLOUD_RULES);

/** Infer a cloud provider for a placeholder file from its path. */
export function cloudProviderFor(p: string): CloudProvider | undefined {
  return firstMatchingProvider(CLOUD_MATCHERS, p);
}
