use evot::suggestion::parse_request;
use serde_json::json;
use serde_json::Value;

type TestResult = Result<(), Box<dyn std::error::Error>>;

// Admission checks encoded byte budgets; actual PNG decoding is exercised by
// the native transport tests and image preparation tests.
fn image_request(count: usize, bytes: usize) -> Value {
    json!({
        "messages": [], "explicit": true, "suffix": "",
        "draft": (1..=count).map(|id| format!("[Image #{id}]")).collect::<Vec<_>>().join(" "),
        "images": (1..=count).map(|id| json!({
            "id": id, "media_type": "image/png", "data": "A".repeat(bytes)
        })).collect::<Vec<_>>()
    })
}

#[test]
fn suggestion_request_reads_historical_shapes_without_contract_changes() -> TestResult {
    for source in [
        r#"[{"role":"user","text":"Run tests"},{"role":"assistant","text":"Which suite?"}]"#,
        include_str!("fixtures/schema/suggestion-request-explicit.json"),
        include_str!("fixtures/schema/suggestion-request-images.json"),
        include_str!("fixtures/schema/suggestion-request-workflow.json"),
    ] {
        let current = parse_request(source)?;
        let written = serde_json::to_string(&current)?;
        let reread = parse_request(&written)?;
        assert_eq!(
            serde_json::to_value(current)?,
            serde_json::to_value(reread)?
        );
    }
    Ok(())
}

#[test]
fn suggestion_request_exempts_only_inline_image_data_from_text_budget() -> TestResult {
    for count in [1, 2] {
        let encoded = serde_json::to_string(&image_request(count, 375_000))?;
        assert!(encoded.len() > 100_000);
        let (messages, hints) = parse_request(&encoded)?.into_parts();
        assert!(messages.is_empty());
        assert_eq!(hints.images.len(), count);
        assert!(hints.images.iter().all(|image| image.data.len() == 375_000));
    }
    Ok(())
}

#[test]
fn suggestion_request_keeps_exact_legacy_text_boundary() -> TestResult {
    let at_limit = format!("[]{}", " ".repeat(99_998));
    assert_eq!(at_limit.len(), 100_000);
    assert!(parse_request(&at_limit).is_ok());
    assert_eq!(
        parse_request(&format!("{at_limit} ")).err(),
        Some("suggestion context too large")
    );
    assert_eq!(
        parse_request("not JSON").err(),
        Some("invalid suggestion context")
    );
    Ok(())
}

#[test]
fn suggestion_request_images_do_not_exempt_large_prose_or_metadata() -> TestResult {
    for mut request in [json!({"messages": []}), image_request(1, 375_000)] {
        request["messages"] = json!([{"role": "user", "text": "x".repeat(100_001)}]);
        assert_eq!(
            parse_request(&serde_json::to_string(&request)?).err(),
            Some("suggestion context too large")
        );
    }
    for field in ["draft", "suffix", "unknown"] {
        let mut request = image_request(1, 375_000);
        request[field] = json!("x".repeat(100_001));
        assert_eq!(
            parse_request(&serde_json::to_string(&request)?).err(),
            Some("suggestion context too large")
        );
    }
    let mut request = image_request(1, 375_000);
    request["images"][0]["media_type"] = json!("x".repeat(100_001));
    assert_eq!(
        parse_request(&serde_json::to_string(&request)?).err(),
        Some("suggestion context too large")
    );
    Ok(())
}

#[test]
fn suggestion_request_preserves_attachment_count_and_per_image_limits() -> TestResult {
    assert!(parse_request(&serde_json::to_string(&image_request(16, 4))?).is_ok());
    for request in [image_request(17, 4), image_request(1, 28 * 1024 * 1024)] {
        assert_eq!(
            parse_request(&serde_json::to_string(&request)?).err(),
            Some("suggestion context too large")
        );
    }
    Ok(())
}
