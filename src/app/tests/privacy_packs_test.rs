//! The rule packs as data: they compile, carry their attribution, and every
//! example a rule lists does what it says.
use evot::privacy::Masker;
use evot::privacy::Pack;
use evot::privacy::PrivacySettings;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn masker() -> Result<Masker, evot::error::EvotError> {
    Masker::new(&PrivacySettings::default(), [3; 32])
}

#[test]
fn every_pack_example_holds() -> TestResult {
    let failures = masker()?.self_test();
    assert!(
        failures.is_empty(),
        "{} failing examples:\n{}",
        failures.len(),
        failures.join("\n")
    );
    Ok(())
}

#[derive(serde::Deserialize)]
struct Row {
    text: String,
    #[serde(default)]
    field: Option<String>,
    finds: Vec<String>,
    #[serde(default)]
    network: bool,
}

/// One regression batch: every row finds exactly the kinds it lists.
fn batch(file: &str) -> TestResult {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/privacy")
        .join(file);
    let plain = masker()?;
    let network = Masker::new(
        &PrivacySettings {
            network: true,
            ..PrivacySettings::default()
        },
        [3; 32],
    )?;
    let mut failures = Vec::new();
    // Fixture values look exactly like real keys; `<cut>` inside one keeps
    // secret scanners from flagging the file (see rules::CUT).
    let text = std::fs::read_to_string(&path)?.replace(evot::privacy::CUT, "");
    for (n, line) in text.lines().enumerate() {
        let row: Row = serde_json::from_str(line)?;
        let masker = if row.network { &network } else { &plain };
        let mut want = row.finds.clone();
        want.sort();
        want.dedup();
        let got = masker.inspect(&row.text, row.field.as_deref()).kinds();
        if got != want {
            failures.push(format!("{file}:{}: want {want:?}, got {got:?}", n + 1));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    Ok(())
}

#[test]
fn batch_1_vendor_keys() -> TestResult {
    batch("1-vendors.jsonl")
}

#[test]
fn batch_2_false_positives_stay_as_written() -> TestResult {
    batch("2-false-positives.jsonl")
}

#[test]
fn batch_3_checksums_decide() -> TestResult {
    batch("3-checksums.jsonl")
}

#[test]
fn batch_4_values_found_by_field_name() -> TestResult {
    batch("4-fields.jsonl")
}

#[test]
fn batch_5_encoded_values_are_looked_through() -> TestResult {
    batch("5-decoded.jsonl")
}

#[test]
fn batch_6_personal_and_network_data() -> TestResult {
    batch("6-personal.jsonl")
}

/// A token whose last six characters are the base62 CRC32 of its random
/// part, built here so no checksum-valid token is ever committed.
fn checksummed(prefix: &str, random: &str) -> String {
    const B62: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in random.as_bytes() {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    let mut n = !crc;
    let mut check = [b'0'; 6];
    for slot in check.iter_mut().rev() {
        *slot = B62[(n % 62) as usize];
        n /= 62;
    }
    format!("{prefix}{random}{}", String::from_utf8_lossy(&check))
}

#[test]
fn a_held_checksum_raises_confidence() -> TestResult {
    let masker = masker()?;
    let random = "Zq81Ff0DkTn4Wb6Xa9Lm2Hc7Ry5Vp3Ej1Q";
    let random = &random[..30];
    for prefix in ["ghp_", "npm_"] {
        let valid = checksummed(prefix, random);
        let forged = format!(
            "{}{}",
            &valid[..valid.len() - 1],
            if valid.ends_with('A') { 'B' } else { 'A' }
        );
        let record = |text: &str| {
            masker
                .inspect(text, None)
                .record(evot::privacy::Target::Llm)
        };
        let ours = record(&valid);
        let theirs = record(&forged);
        let confidence = |r: &evot::privacy::Record| r.values.iter().map(|v| v.confidence).max();
        assert_eq!(
            confidence(&ours),
            Some(evot::privacy::Confidence::High),
            "{prefix}"
        );
        // A failed checksum is still masked: a typo'd real token is a token.
        assert!(!theirs.values.is_empty(), "{prefix}");
    }
    Ok(())
}

#[test]
fn user_packs_add_rules_and_must_be_valid() -> TestResult {
    let pack: Pack = serde_json::from_value(serde_json::json!({
        "schema_version": 1,
        "id": "acme",
        "kinds": [{"name": "EMPLOYEE_ID", "category": "personal"}],
        "rules": [{
            "id": "acme.employee", "kind": "EMPLOYEE_ID", "regex": "\\bACME-[0-9]{6}\\b",
            "keywords": ["acme-"], "examples": {"matches": ["badge ACME-123456"], "ignores": ["ACME-12"]}
        }]
    }))?;
    let masker = Masker::with_packs(
        &PrivacySettings::default(),
        [3; 32],
        std::slice::from_ref(&pack),
    )?;
    assert!(masker.self_test().is_empty());
    assert_eq!(masker.inspect("badge ACME-123456", None).kinds(), vec![
        "EMPLOYEE_ID".to_string()
    ]);
    assert!(masker.packs().iter().any(|p| p.id == "acme"));

    let reject = |pack: serde_json::Value| -> Result<String, Box<dyn std::error::Error>> {
        let pack: Pack = serde_json::from_value(pack)?;
        match Masker::with_packs(&PrivacySettings::default(), [3; 32], &[pack]) {
            Ok(_) => Err("accepted".into()),
            Err(e) => Ok(e.to_string()),
        }
    };
    let copyleft = reject(serde_json::json!({
        "id": "copied", "source": {"name": "x", "url": "https://x", "license": "AGPL-3.0", "copyright": "x"}
    }))?;
    assert!(copyleft.contains("AGPL-3.0"), "{copyleft}");
    let unknown_kind = reject(serde_json::json!({
        "id": "typo", "rules": [{"id": "typo.r", "kind": "NOPE", "regex": "x"}]
    }))?;
    assert!(unknown_kind.contains("NOPE"), "{unknown_kind}");
    let duplicate = reject(serde_json::json!({
        "id": "dup", "rules": [{"id": "secrets.jwt", "kind": "TOKEN", "regex": "x"}]
    }))?;
    assert!(duplicate.contains("twice"), "{duplicate}");
    let future = reject(serde_json::json!({"schema_version": 99, "id": "future"}))?;
    assert!(future.contains("newer"), "{future}");
    // A misspelt field is an error, not a rule that silently does less.
    assert!(serde_json::from_value::<Pack>(serde_json::json!({"id": "x", "rulez": []})).is_err());
    Ok(())
}

#[test]
fn imported_packs_carry_their_attribution() -> TestResult {
    let masker = masker()?;
    let packs = masker.packs();
    let imported: Vec<_> = packs.iter().filter(|p| p.source.is_some()).collect();
    assert!(imported
        .iter()
        .any(|p| p.id == "betterleaks" && p.rules > 400));
    assert!(imported.iter().all(|p| p.license.as_deref() == Some("MIT")));
    // Every imported source is named, with its license text, in NOTICE.
    let notice = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/privacy/rules/data/NOTICE"),
    )?;
    for pack in imported {
        let url = pack.source.as_deref().unwrap_or_default();
        assert!(notice.contains(url), "NOTICE lacks {url}");
    }
    assert!(notice.contains("Permission is hereby granted"));
    Ok(())
}

#[test]
fn scanning_a_large_history_stays_fast() -> TestResult {
    // ~1 MB of mixed code, prose and logs: the whole history is scanned on
    // every request, so this bounds the engine's per-request cost.
    let masker = masker()?;
    let chunk = "fn main() { let token_count = 42; println!(\"{}\", token_count); }\n\
                 The deploy at 2026-01-02 10:11:12 used 8 workers and 3.5 GB.\n\
                 GET /api/v1/items?page=2 200 12ms user=svc-reader\n";
    let text = chunk.repeat(1_000_000 / chunk.len());
    let started = std::time::Instant::now();
    let report = masker.inspect(&text, None);
    let elapsed = started.elapsed();
    assert!(report.is_empty(), "found {:?}", report.kinds());
    // Generous for debug builds on CI; release is far below.
    assert!(
        elapsed < std::time::Duration::from_secs(20),
        "took {elapsed:?}"
    );
    eprintln!("scanned {} KB in {elapsed:?}", text.len() / 1024);
    Ok(())
}
