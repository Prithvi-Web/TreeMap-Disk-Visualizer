//! The cloud rule (`CLOUD_RULES` in `src/services/cloudFolders.ts`, decision P4-3a) against the
//! answers JavaScript's regexes give: every path of the oracle Node writes
//! (`tests/fixtures/cloud-oracle.tsv`, from `tests/fixtures/cloudRulesOracle.ts`, held current by
//! `tests/cloudRules.test.ts`), and every character outside ASCII against a rule for each ASCII
//! letter. The regexes' `i` flag comes without `u`, so it folds A–Z and nothing else: U+212A
//! KELVIN SIGN is not `k`, U+0130 is not `i`, U+017F is not `s` (pinned over every code point in
//! Node by `tests/cloudRules.test.ts`).

use tm_store::derive::{CloudAnchor, CloudRule, cloud_provider, cloud_rule_problem};

fn rule(text: &str, at: CloudAnchor, provider: u8) -> CloudRule {
    CloudRule {
        text: text.to_owned(),
        at,
        provider,
    }
}

/// A rule for each ASCII letter, `a` as provider 1 to `z` as 26: the oracle's `probe-letters`.
fn letter_rules(at: CloudAnchor) -> Vec<CloudRule> {
    (b'a'..=b'z')
        .zip(1u8..)
        .map(|(letter, provider)| rule(&char::from(letter).to_string(), at, provider))
        .collect()
}

/// One table of the oracle: its rules, and each path's bytes with the provider JavaScript gave.
struct Table {
    name: String,
    rules: Vec<CloudRule>,
    paths: Vec<(u8, Vec<u8>)>,
}

/// An oracle field's bytes: `%XX` is the byte XX (upper-case hex), anything else itself.
fn unescape(field: &str) -> Result<Vec<u8>, String> {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while let Some(&b) = bytes.get(at) {
        if b == b'%' {
            let hex = bytes
                .get(at + 1..at + 3)
                .filter(|h| {
                    h.iter()
                        .all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(c))
                })
                .and_then(|h| std::str::from_utf8(h).ok())
                .ok_or_else(|| format!("a bad escape at {at} in {field:?}"))?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| format!("{hex:?}: {e}"))?);
            at += 3;
        } else {
            out.push(b);
            at += 1;
        }
    }
    Ok(out)
}

fn read_oracle() -> Result<Vec<Table>, String> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/cloud-oracle.tsv"
    );
    let text = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    let mut tables: Vec<Table> = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["table", name] => tables.push(Table {
                name: (*name).to_owned(),
                rules: Vec::new(),
                paths: Vec::new(),
            }),
            ["rule", provider, at, text] => {
                let table = tables.last_mut().ok_or("a rule before any table")?;
                let at = match *at {
                    "anywhere" => CloudAnchor::Anywhere,
                    "end" => CloudAnchor::End,
                    other => return Err(format!("{other:?} is not an anchor")),
                };
                table.rules.push(CloudRule {
                    text: String::from_utf8(unescape(text)?).map_err(|e| e.to_string())?,
                    at,
                    provider: provider.parse().map_err(|e| format!("{provider:?}: {e}"))?,
                });
            }
            ["path", provider, bytes] => {
                let table = tables.last_mut().ok_or("a path before any table")?;
                let provider = provider.parse().map_err(|e| format!("{provider:?}: {e}"))?;
                table.paths.push((provider, unescape(bytes)?));
            }
            _ => return Err(format!("a line the oracle does not hold: {line:?}")),
        }
    }
    Ok(tables)
}

#[test]
fn every_path_in_the_javascript_oracle_answers_as_the_regexes_do() -> Result<(), String> {
    let tables = read_oracle()?;
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "cloudProviderFor",
            "probe-letters",
            "probe-ends",
            "probe-order",
            "probe-syntax",
            "probe-ligatures"
        ]
    );
    let mut misses = Vec::new();
    let mut checked = 0usize;
    for table in &tables {
        for (index, rule) in table.rules.iter().enumerate() {
            assert_eq!(
                cloud_rule_problem(rule),
                None,
                "{} rule {index} ({:?})",
                table.name,
                rule.text
            );
        }
        for (expected, path) in &table.paths {
            let got = cloud_provider(path, &table.rules);
            if got != *expected && misses.len() < 12 {
                misses.push(format!(
                    "{}: {:?} gives {got}, the regexes {expected}",
                    table.name,
                    String::from_utf8_lossy(path)
                ));
            }
            checked += 1;
        }
    }
    assert!(misses.is_empty(), "{misses:#?}");
    let production = tables.first().ok_or("no tables")?;
    assert_eq!(production.rules.len(), 5, "CLOUD_RULES has five rows");
    assert!(
        production.paths.len() >= 20_000,
        "{} paths under CLOUD_RULES",
        production.paths.len()
    );
    for provider in 0..=3 {
        let count = production
            .paths
            .iter()
            .filter(|(p, _)| *p == provider)
            .count();
        assert!(count >= 1_000, "provider {provider}: {count} paths");
    }
    let not_utf8 = production
        .paths
        .iter()
        .filter(|(_, bytes)| std::str::from_utf8(bytes).is_err())
        .count();
    assert!(not_utf8 >= 1_000, "{not_utf8} paths are not UTF-8");
    assert!(
        tables
            .iter()
            .all(|t| !t.rules.is_empty() && !t.paths.is_empty()),
        "no table is empty"
    );
    let letters = tables.get(1).map_or(0, |t| t.paths.len());
    assert!(letters >= 3_000, "{letters} paths try the letters");
    assert!(
        checked > production.paths.len() + letters,
        "{checked} paths"
    );
    Ok(())
}

#[test]
fn no_character_outside_ascii_matches_a_letter_of_a_rule() {
    let anywhere = letter_rules(CloudAnchor::Anywhere);
    let at_end = letter_rules(CloudAnchor::End);
    let mut buffer = [0u8; 4];
    let mut checked = 0u32;
    for c in (0x80..=0x10_FFFF).filter_map(char::from_u32) {
        let bytes = c.encode_utf8(&mut buffer).as_bytes();
        let code = u32::from(c);
        assert_eq!(cloud_provider(bytes, &anywhere), 0, "U+{code:04X}");
        assert_eq!(cloud_provider(bytes, &at_end), 0, "U+{code:04X} at the end");
        checked += 1;
    }
    assert_eq!(
        checked,
        0x11_0000 - 0x80 - 0x800,
        "every scalar value past ASCII"
    );
}

#[test]
fn every_ascii_letter_matches_its_rule_whatever_its_case_and_nothing_else_in_ascii_does() {
    for at in [CloudAnchor::Anywhere, CloudAnchor::End] {
        let rules = letter_rules(at);
        for b in 0u8..0x80 {
            let want = if b.is_ascii_alphabetic() {
                b.to_ascii_lowercase() - b'a' + 1
            } else {
                0
            };
            assert_eq!(cloud_provider(&[b], &rules), want, "{b:#04x} ({at:?})");
        }
    }
}

#[test]
fn the_named_lookalikes_are_not_the_letters_they_fold_to_elsewhere() {
    let rules = [
        rule("k", CloudAnchor::Anywhere, 1),
        rule("i", CloudAnchor::Anywhere, 2),
        rule("s", CloudAnchor::Anywhere, 3),
        rule("ss", CloudAnchor::Anywhere, 4),
    ];
    // KELVIN SIGN lower-cases to k and folds to k; U+0130 lower-cases to i and U+0307; U+0131
    // upper-cases to I; U+017F upper-cases to S and folds to s; ß upper-cases to SS.
    for c in [
        '\u{212A}', '\u{0130}', '\u{0131}', '\u{017F}', '\u{00DF}', '\u{1E9E}',
    ] {
        let path = format!("x{c}y");
        assert_eq!(
            cloud_provider(path.as_bytes(), &rules),
            0,
            "U+{:04X}",
            u32::from(c)
        );
    }
    assert_eq!(cloud_provider(b"xKy", &rules), 1);
    assert_eq!(cloud_provider(b"xIy", &rules), 2);
    assert_eq!(cloud_provider(b"xSy", &rules), 3);
}

#[test]
fn an_end_rule_holds_at_the_very_end_only() {
    let rules = [rule(".icloud", CloudAnchor::End, 1)];
    for hit in [
        &b"/x/a.icloud"[..],
        b"/x/a.ICLOUD",
        b".icloud",
        b"\xff.icloud",
    ] {
        assert_eq!(
            cloud_provider(hit, &rules),
            1,
            "{:?}",
            String::from_utf8_lossy(hit)
        );
    }
    for miss in [
        &b"/x/a.icloud\n"[..],
        b"/x/a.icloud\r\n",
        b"/x/a.icloud ",
        b"/x/a.icloud.pdf",
        b"/x/a.icloud/y",
        b"/x/a.icloud\xe2\x82",
        b"/x/aicloud",
        b"icloud",
        b".iclou",
        b"",
    ] {
        assert_eq!(
            cloud_provider(miss, &rules),
            0,
            "{:?}",
            String::from_utf8_lossy(miss)
        );
    }
}

#[test]
fn an_anywhere_rule_holds_wherever_its_text_sits_in_one_piece() {
    let rules = [rule("Library/Mobile Documents", CloudAnchor::Anywhere, 1)];
    for hit in [
        &b"/Users/me/Library/Mobile Documents/x"[..],
        b"library/mobile documents",
        b"xLIBRARY/MOBILE DOCUMENTSx",
    ] {
        assert_eq!(cloud_provider(hit, &rules), 1);
    }
    for miss in [
        &b"C:\\Users\\me\\Library\\Mobile Documents\\x"[..],
        b"/Users/me/Library\xc0\xafMobile Documents/x",
        b"/Users/me/Library//Mobile Documents/x",
        b"/Users/me/Library/Mobile\xc2\xa0Documents/x",
        b"Library/Mobile Document",
    ] {
        assert_eq!(
            cloud_provider(miss, &rules),
            0,
            "{:?}",
            String::from_utf8_lossy(miss)
        );
    }
}

#[test]
fn the_first_rule_a_path_matches_names_the_provider_whatever_its_number() {
    let rules = [
        rule("b", CloudAnchor::Anywhere, 2),
        rule("a", CloudAnchor::End, 1),
        rule("a", CloudAnchor::Anywhere, 3),
        rule("c", CloudAnchor::Anywhere, 1),
    ];
    assert_eq!(cloud_provider(b"ba", &rules), 2);
    assert_eq!(cloud_provider(b"xa", &rules), 1);
    assert_eq!(cloud_provider(b"axc", &rules), 3);
    assert_eq!(cloud_provider(b"ca", &rules), 1);
    assert_eq!(cloud_provider(b"x", &rules), 0);
    assert_eq!(cloud_provider(b"anything", &[]), 0, "no rules, no provider");
}

#[test]
fn a_cloud_rule_must_be_printable_ascii_with_a_provider() {
    assert_eq!(
        cloud_rule_problem(&rule("OneDrive", CloudAnchor::Anywhere, 2)),
        None
    );
    assert_eq!(
        cloud_rule_problem(&rule(
            " ~!\"#$%&'()*+,-./09:;<=>?@AZ[\\]^_`az{|}",
            CloudAnchor::End,
            255
        )),
        None
    );
    assert!(
        cloud_rule_problem(&rule("OneDrive", CloudAnchor::Anywhere, 0)).is_some(),
        "0 is no provider"
    );
    for text in ["", "Caf\u{e9}", "a\tb", "a\nb", "\u{212A}", "x\u{7f}"] {
        assert!(
            cloud_rule_problem(&rule(text, CloudAnchor::Anywhere, 1)).is_some(),
            "{text:?}"
        );
    }
}

#[test]
fn an_empty_text_matches_every_path_as_an_empty_regex_does() {
    // The build refuses such a rule (`cloud_rule_problem`); the matcher still answers as
    // `new RegExp('', 'i')` and `/$/i` do, and never panics on it.
    assert_eq!(
        cloud_provider(b"", &[rule("", CloudAnchor::Anywhere, 4)]),
        4
    );
    assert_eq!(cloud_provider(b"x", &[rule("", CloudAnchor::End, 5)]), 5);
}
