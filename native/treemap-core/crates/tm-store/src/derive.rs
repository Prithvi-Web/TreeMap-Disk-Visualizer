//! The facts the Node ingest derives for each node, as pure functions: the rules of
//! `statToInput` (`src/services/scan/nodeInput.ts`) and `detectContainerKind`
//! (`src/utils/containerKind.ts`), each pinned by a test against the values Node gives.

/// JavaScript's `Math.round`: NaN or ±∞ as it is; otherwise the floor, plus one when the
/// fraction is at least a half, and −0 when that is zero and `x` was negative (an integer,
/// having no fraction, is its own floor).
///
/// Neither Rust's `f64::round` (a half away from zero: −1.5 → −2) nor `(x + 0.5).floor()`
/// is that rule. Measured on Node 24.16: `(x + 0.5).floor()` gives 1 for
/// `0.49999999999999994` (JS: 0), `4503599627370498` for `4503599627370497` (JS: the
/// integer itself) and +0 for everything in [−0.5, 0) (JS: −0).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    // x − floor(x) is x's fraction exactly, except for x in (−0.5, 0): there the floor
    // is −1 and x + 1 can round (to 1.0 when |x| is tiny). The true fraction there is
    // above a half and 0.5 is representable, so the rounded one is at least a half too,
    // and the comparison comes out as it would with no rounding.
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x < 0.0 {
        -0.0
    } else {
        rounded
    }
}

/// The modification time the ingest stores: `Math.round` of the walk's, and 0 where the
/// walk withheld it (`Number.isFinite(mtime) ? mtime : 0`, then `statToInput`).
pub fn store_mtime(walk_ms: f64) -> f64 {
    if walk_ms.is_finite() {
        js_round(walk_ms)
    } else {
        0.0
    }
}

/// The access time the ingest stores: `Math.round` of one above zero; none otherwise
/// (zero means "never recorded" on several file systems, and NaN means not recorded).
pub fn store_atime(walk_ms: f64) -> Option<f64> {
    (walk_ms > 0.0).then(|| js_round(walk_ms))
}

/// Hidden: the dot prefix, on every platform.
pub fn is_hidden(name: &[u8]) -> bool {
    name.first() == Some(&b'.')
}

/// Whether the store decides a name's extension and container kind itself: when every
/// byte is ASCII, where JavaScript's `toLowerCase` only maps A–Z, or when there is no dot
/// (then there is neither). Anything else is JavaScript's to decide, because
/// `toLowerCase` is the rule and each JavaScript engine carries its own Unicode tables
/// (Node 24.16 has Unicode 17.0; the app's Electron 31 an older one): no Rust port could
/// agree with all of them.
pub fn decided_here(name: &[u8]) -> bool {
    name.is_ascii() || !name.contains(&b'.')
}

/// The raw extension `statToInput` gives a file: what follows the name's last dot, when
/// that dot is not the first byte (a dotfile has none) and something follows it (`a.`,
/// `..` and `...` have none). Not yet lower-cased.
pub fn extension(name: &[u8]) -> Option<&[u8]> {
    let dot = name.iter().rposition(|&b| b == b'.')?;
    if dot == 0 {
        return None;
    }
    let rest = name.get(dot + 1..)?;
    (!rest.is_empty()).then_some(rest)
}

/// One rule of `detectContainerKind`, as data (`src/utils/containerKind.ts`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ContainerRule {
    /// Lower-case ASCII text the name must equal (`whole_name`) or end with, ignoring ASCII case.
    pub text: String,
    /// Whether the whole name must equal `text` (the Docker disk images) or end with it.
    pub whole_name: bool,
    /// Whether the rule is for folders (`true`) or for everything else (`false`).
    pub folders: bool,
    /// The container column's number for the kind (`CONTAINER_ID` in `scanStore.ts`, 1–7).
    pub kind: u8,
}

/// Why a container rule cannot be used, or `None` when it can: its text must be
/// non-empty lower-case ASCII with a dot (what `detectContainerKind` checks first is
/// the suffix after the last dot), and its kind must not be 0 (0 is "none").
pub fn rule_problem(rule: &ContainerRule) -> Option<&'static str> {
    if rule.kind == 0 {
        Some("kind 0 means no container")
    } else if rule.text.is_empty() {
        Some("the text is empty")
    } else if !rule.text.is_ascii() || rule.text.bytes().any(|b| b.is_ascii_uppercase()) {
        Some("the text is not lower-case ASCII")
    } else if !rule.text.contains('.') {
        Some("the text has no dot")
    } else {
        None
    }
}

/// The container kind of a name the store decides ([`decided_here`]): the first rule it
/// matches, or 0. For such a name, matching while ignoring ASCII case is exactly
/// `detectContainerKind`'s `name.toLowerCase()` then `===` or `endsWith`; its check of
/// the last-dot suffix comes first only to go faster, because a name that ends with a
/// rule's text also ends with that text's last-dot suffix.
pub fn container_kind(name: &[u8], is_dir: bool, rules: &[ContainerRule]) -> u8 {
    rules
        .iter()
        .find(|rule| rule.folders == is_dir && matches_rule(name, rule))
        .map_or(0, |rule| rule.kind)
}

fn matches_rule(name: &[u8], rule: &ContainerRule) -> bool {
    let text = rule.text.as_bytes();
    if rule.whole_name {
        return name.eq_ignore_ascii_case(text);
    }
    name.len()
        .checked_sub(text.len())
        .and_then(|start| name.get(start..))
        .is_some_and(|tail| tail.eq_ignore_ascii_case(text))
}
