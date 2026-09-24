//! The per-node rules against the answers Node gives: `Math.round` as Node 24.16 computed
//! it, and `statToInput` / `detectContainerKind` as they answered for each name (both run
//! on 24 September 2026 and pasted here).

use tm_store::derive::{
    ContainerRule, container_kind, decided_here, extension, is_hidden, js_round, rule_problem,
    store_atime, store_mtime,
};

/// Exactly the same float, −0 told from +0; any NaN is NaN.
fn same(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

#[test]
fn js_round_is_math_round_where_rusts_rounding_and_floor_x_plus_a_half_are_not() {
    let node_says: [(f64, f64); 17] = [
        (-1.5, -1.0),
        (-0.5, -0.0),
        (2.5, 3.0),
        (0.499_999_999_999_999_94, 0.0),
        (-2.5, -2.0),
        (1.5, 2.0),
        (1e21, 1e21),
        (4_503_599_627_370_497.0, 4_503_599_627_370_497.0),
        (1_695_000_000_000.5, 1_695_000_000_001.0),
        (-1.499_999_999_999_999_8, -1.0),
        (-0.499_999_999_999_999_94, -0.0),
        (-1_695_000_000_000.5, -1_695_000_000_000.0),
        (9_007_199_254_740_991.0, 9_007_199_254_740_991.0),
        (0.5, 1.0),
        (-1e-7, -0.0),
        (0.0, 0.0),
        (-0.0, -0.0),
    ];
    for (x, expected) in node_says {
        let got = js_round(x);
        assert!(
            same(got, expected),
            "Math.round({x:?}) is {expected:?}, not {got:?}"
        );
    }
    assert!(js_round(f64::NAN).is_nan());
    assert!(same(js_round(f64::INFINITY), f64::INFINITY));
    assert!(same(js_round(f64::NEG_INFINITY), f64::NEG_INFINITY));
}

#[test]
fn times_are_rounded_a_withheld_mtime_is_zero_and_an_atime_not_above_zero_is_none() {
    assert!(same(store_mtime(1_695_000_000_000.5), 1_695_000_000_001.0));
    assert!(
        same(store_mtime(-0.5), -0.0),
        "before 1970, as Node rounds it"
    );
    assert!(
        same(store_mtime(f64::NAN), 0.0),
        "Number.isFinite(mtime) ? mtime : 0"
    );
    assert!(same(store_mtime(f64::INFINITY), 0.0));
    assert_eq!(store_atime(1.5), Some(2.0));
    assert_eq!(store_atime(0.0), None, "zero means never recorded");
    assert_eq!(store_atime(-5.0), None);
    assert_eq!(store_atime(f64::NAN), None, "not recorded");
}

/// `(name, statToInput's extension for a file, detectContainerKind for a file, for a
/// folder, hidden)`, as the TypeScript answered.
const TYPESCRIPT_SAYS: [(&str, Option<&str>, u8, u8, bool); 30] = [
    ("a.zip", Some("zip"), 1, 0, false),
    ("A.JAR", Some("jar"), 1, 0, false),
    ("b.tar.gz", Some("gz"), 3, 0, false),
    ("c.TGZ", Some("tgz"), 3, 0, false),
    ("d.tar", Some("tar"), 2, 0, false),
    ("e.iso", Some("iso"), 4, 0, false),
    ("f.dmg", Some("dmg"), 5, 0, false),
    ("Docker.raw", Some("raw"), 7, 0, false),
    ("docker.QCOW2", Some("qcow2"), 7, 0, false),
    ("ext4.vhdx", Some("vhdx"), 7, 0, false),
    ("Docker_Data.VHDX", Some("vhdx"), 7, 0, false),
    ("x.vhdx", Some("vhdx"), 0, 0, false),
    ("my-docker.raw", Some("raw"), 0, 0, false),
    ("Lib.photoslibrary", Some("photoslibrary"), 0, 6, false),
    (".zip", None, 1, 0, true),
    ("zip", None, 0, 0, false),
    ("archive.zip.part", Some("part"), 0, 0, false),
    ("a.b.c", Some("c"), 0, 0, false),
    (".bashrc", None, 0, 0, true),
    ("a.", None, 0, 0, false),
    ("..", None, 0, 0, true),
    ("...", None, 0, 0, true),
    ("index.HTML", Some("html"), 0, 0, false),
    ("noext", None, 0, 0, false),
    (".a.B", Some("b"), 0, 0, true),
    ("a..", None, 0, 0, false),
    (".", None, 0, 0, true),
    ("x.TAR.GZ", Some("gz"), 3, 0, false),
    ("raw", None, 0, 0, false),
    ("docker.raw.bak", Some("bak"), 0, 0, false),
];

/// `detectContainerKind`'s rules in its order, with `CONTAINER_ID`'s numbers.
fn typescript_rules() -> Vec<ContainerRule> {
    let rule = |text: &str, whole_name: bool, folders: bool, kind: u8| ContainerRule {
        text: text.to_owned(),
        whole_name,
        folders,
        kind,
    };
    vec![
        rule(".photoslibrary", false, true, 6),
        rule("docker.raw", true, false, 7),
        rule("docker.qcow2", true, false, 7),
        rule("ext4.vhdx", true, false, 7),
        rule("docker_data.vhdx", true, false, 7),
        rule(".tar.gz", false, false, 3),
        rule(".tgz", false, false, 3),
        rule(".zip", false, false, 1),
        rule(".jar", false, false, 1),
        rule(".tar", false, false, 2),
        rule(".iso", false, false, 4),
        rule(".dmg", false, false, 5),
    ]
}

#[test]
fn extension_container_and_hidden_answer_as_the_typescript_does() {
    let rules = typescript_rules();
    for (name, ext, file_kind, folder_kind, hidden) in TYPESCRIPT_SAYS {
        let bytes = name.as_bytes();
        assert!(decided_here(bytes), "{name} is ASCII");
        let lowered = extension(bytes).map(|raw| String::from_utf8_lossy(raw).to_ascii_lowercase());
        assert_eq!(lowered.as_deref(), ext, "the extension of {name}");
        assert_eq!(
            container_kind(bytes, false, &rules),
            file_kind,
            "{name} as a file"
        );
        assert_eq!(
            container_kind(bytes, true, &rules),
            folder_kind,
            "{name} as a folder"
        );
        assert_eq!(is_hidden(bytes), hidden, "whether {name} is hidden");
    }
}

#[test]
fn the_extension_is_not_lower_cased_here_and_a_rule_matches_whatever_the_ascii_case() {
    assert_eq!(extension(b"index.HTML"), Some(&b"HTML"[..]));
    assert_eq!(container_kind(b"X.ZiP", false, &typescript_rules()), 1);
}

#[test]
fn a_name_outside_ascii_with_a_dot_is_javascripts_to_decide() {
    // JavaScript lower-cases these by Unicode rules its engine's tables decide: Final_Sigma
    // (`FILE.ΑΣ` → `ας`), `İ` → `i` + U+0307, and a KELVIN SIGN that lower-cases to `k`
    // would make `doc\u{212A}er.raw` a Docker image.
    for name in ["FILE.ΑΣ", "x.İ", "café.txt", "doc\u{212A}er.raw", "y.ẞ"] {
        assert!(!decided_here(name.as_bytes()), "{name}");
    }
    for name in ["naïve", "日本語", "plain.txt", ".hidden"] {
        assert!(
            decided_here(name.as_bytes()),
            "{name}: ASCII, or no dot and so no extension"
        );
    }
}

#[test]
fn a_container_rule_must_be_lower_case_ascii_with_a_dot_and_a_kind() {
    let rule = |text: &str, kind: u8| ContainerRule {
        text: text.to_owned(),
        whole_name: false,
        folders: false,
        kind,
    };
    assert_eq!(rule_problem(&rule(".zip", 1)), None);
    assert!(
        rule_problem(&rule(".zip", 0)).is_some(),
        "0 is no container"
    );
    assert!(rule_problem(&rule("", 1)).is_some());
    assert!(rule_problem(&rule(".ZIP", 1)).is_some(), "upper case");
    assert!(rule_problem(&rule(".zïp", 1)).is_some(), "not ASCII");
    assert!(rule_problem(&rule("zip", 1)).is_some(), "no dot");
}

/// Every line of `tests/fixtures/derive-oracle.tsv`: 12,535 ASCII names with the extension,
/// container kinds and hidden flag `statToInput` gives them, written from the TypeScript by
/// `tests/fixtures/storeDeriveOracle.ts` and held current by `tests/storeDeriveOracle.test.ts`.
#[test]
fn every_name_in_the_typescript_oracle_answers_as_the_typescript_does() -> Result<(), String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/derive-oracle.tsv"
    );
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let rules = typescript_rules();
    let number = |field: &str| field.parse::<u8>().map_err(|e| format!("{field:?}: {e}"));
    let mut checked = 0usize;
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        let [name, ext, file_kind, folder_kind, hidden] = fields.as_slice() else {
            return Err(format!("a line without five fields: {line:?}"));
        };
        let bytes = name.as_bytes();
        assert!(decided_here(bytes), "{name:?} is ASCII");
        let lowered = extension(bytes)
            .map(|raw| String::from_utf8_lossy(raw).to_ascii_lowercase())
            .unwrap_or_default();
        assert_eq!(lowered, *ext, "the extension of {name:?}");
        assert_eq!(
            container_kind(bytes, false, &rules),
            number(file_kind)?,
            "{name:?} as a file"
        );
        assert_eq!(
            container_kind(bytes, true, &rules),
            number(folder_kind)?,
            "{name:?} as a folder"
        );
        assert_eq!(
            u8::from(is_hidden(bytes)),
            number(hidden)?,
            "whether {name:?} is hidden"
        );
        checked += 1;
    }
    assert_eq!(checked, 12_535, "every name in the oracle");
    Ok(())
}
