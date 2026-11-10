use evotengine::tools::validation::coerce_edits;
use evotengine::tools::validation::normalize_aliases;
use evotengine::tools::validation::truncate_error;
use evotengine::tools::validation::validate_and_coerce;
use evotengine::tools::validation::validate_and_coerce_with_received;
use serde_json::json;

// ── helper: a typical tool schema ───────────────────────────────────────

fn read_file_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "File path" },
            "offset": { "type": "integer", "minimum": 1, "description": "Start line" },
            "limit": { "type": "integer", "minimum": 1, "description": "Max lines" }
        },
        "required": ["path"]
    })
}

fn memory_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["add", "replace", "remove", "read"]
            },
            "scope": {
                "type": "string",
                "enum": ["global", "project"]
            },
            "name": { "type": "string" },
            "content": { "type": "string" }
        },
        "required": ["action", "scope"]
    })
}

fn edit_schema() -> serde_json::Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "oldText": { "type": "string" },
                        "newText": { "type": "string" }
                    },
                    "required": ["oldText", "newText"]
                }
            }
        },
        "required": ["path", "edits"]
    })
}

// ── required fields ─────────────────────────────────────────────────────

#[test]
fn missing_required_param() {
    let input = json!({});
    let err = validate_and_coerce("read", &read_file_schema(), &input).unwrap_err();
    assert!(
        err.contains("The required parameter `path` is missing"),
        "got: {err}"
    );
    assert!(err.contains("InputValidationError:"));
    assert!(err.contains("read failed"));
}

#[test]
fn missing_multiple_required_params() {
    let input = json!({ "name": "foo" });
    let err = validate_and_coerce("Memory", &memory_schema(), &input).unwrap_err();
    assert!(err.contains("`action` is missing"), "got: {err}");
    assert!(err.contains("`scope` is missing"), "got: {err}");
    assert!(err.contains("issues"), "should say 'issues' (plural)");
}

// ── type coercion ───────────────────────────────────────────────────────

#[test]
fn coerce_string_to_integer() {
    let input = json!({ "path": "foo.rs", "offset": "10", "limit": "20" });
    let result = validate_and_coerce("read", &read_file_schema(), &input).unwrap();
    assert_eq!(result["offset"], json!(10));
    assert_eq!(result["limit"], json!(20));
    assert_eq!(result["path"], json!("foo.rs"));
}

#[test]
fn coerce_integral_float_to_integer() {
    let input = json!({ "path": "foo.rs", "offset": 2000.0, "limit": 250.0 });
    let result = validate_and_coerce("read", &read_file_schema(), &input).unwrap();
    assert_eq!(result["offset"], json!(2000));
    assert_eq!(result["limit"], json!(250));
}

#[test]
fn reject_fractional_float_for_integer() {
    let input = json!({ "path": "foo.rs", "limit": 1.5 });
    let err = validate_and_coerce("read", &read_file_schema(), &input).unwrap_err();
    assert!(
        err.contains("expected as `integer` but provided as `number`"),
        "got: {err}"
    );
}

#[test]
fn enforce_numeric_minimum_after_coercion() {
    for input in [
        json!({ "path": "foo.rs", "offset": 0 }),
        json!({ "path": "foo.rs", "limit": "0" }),
        json!({ "path": "foo.rs", "limit": -1.0 }),
    ] {
        let err = validate_and_coerce("read", &read_file_schema(), &input).unwrap_err();
        assert!(err.contains("below the minimum 1"), "got: {err}");
    }
}

#[test]
fn coerce_string_to_boolean() {
    let schema = json!({
        "type": "object",
        "properties": {
            "replace_all": { "type": "boolean" }
        },
        "required": ["replace_all"]
    });
    let input = json!({ "replace_all": "true" });
    let result = validate_and_coerce("edit", &schema, &input).unwrap();
    assert_eq!(result["replace_all"], json!(true));
}

#[test]
fn coerce_string_to_boolean_case_insensitive() {
    let schema = json!({
        "type": "object",
        "properties": { "flag": { "type": "boolean" } },
        "required": ["flag"]
    });
    for (input_str, expected) in [("TRUE", true), ("False", false), ("TRUE", true)] {
        let input = json!({ "flag": input_str });
        let result = validate_and_coerce("test", &schema, &input).unwrap();
        assert_eq!(result["flag"], json!(expected));
    }
}

#[test]
fn coerce_string_to_array() {
    let schema = json!({
        "type": "object",
        "properties": {
            "items": { "type": "array" }
        },
        "required": ["items"]
    });
    let input = json!({ "items": "[1, 2, 3]" });
    let result = validate_and_coerce("test", &schema, &input).unwrap();
    assert_eq!(result["items"], json!([1, 2, 3]));
}

#[test]
fn coerce_bare_string_to_single_element_array() {
    // A bare scalar string (not JSON-array syntax) is wrapped as a one-element
    // array, matching how glob/grep normalize a single pattern/path. This is
    // the path the model hits when it calls glob with `pattern: "**/*.rs"`
    // instead of `["**/*.rs"]`.
    let schema = json!({
        "type": "object",
        "properties": { "pattern": { "type": "array", "items": { "type": "string" } } },
        "required": ["pattern"]
    });
    let input = json!({ "pattern": "**/*recluster*" });
    let result = validate_and_coerce("glob", &schema, &input).unwrap();
    assert_eq!(result["pattern"], json!(["**/*recluster*"]));
}

#[test]
fn coerce_string_to_number() {
    let schema = json!({
        "type": "object",
        "properties": { "score": { "type": "number" } },
        "required": ["score"]
    });
    let input = json!({ "score": "2.5" });
    let result = validate_and_coerce("test", &schema, &input).unwrap();
    assert!((result["score"].as_f64().unwrap() - 2.5).abs() < f64::EPSILON);
}

// ── type mismatch (cannot coerce) ───────────────────────────────────────

#[test]
fn type_mismatch_object_for_string() {
    let input = json!({ "path": { "nested": true } });
    let err = validate_and_coerce("read", &read_file_schema(), &input).unwrap_err();
    assert!(
        err.contains("expected as `string` but provided as `object`"),
        "got: {err}"
    );
}

#[test]
fn type_mismatch_string_cannot_parse_as_integer() {
    let input = json!({ "path": "foo.rs", "offset": "not_a_number" });
    let err = validate_and_coerce("read", &read_file_schema(), &input).unwrap_err();
    assert!(
        err.contains("expected as `integer` but provided as `string`"),
        "got: {err}"
    );
}

#[test]
fn nested_array_items_are_validated() {
    let input = json!({
        "path": "foo.rs",
        "edits": ["oldText", ":", "before", "\"newText\":", "after"]
    });
    let err = match validate_and_coerce("edit", &edit_schema(), &input) {
        Ok(_) => panic!("token array must be rejected"),
        Err(error) => error,
    };
    assert!(
        err.contains("`edits[0]` type is expected as `object` but provided as `string`"),
        "got: {err}"
    );
    assert!(err.contains("Received arguments:"), "got: {err}");
    assert!(err.contains("\"oldText\""), "got: {err}");
}

#[test]
fn invalid_stringified_edit_is_not_wrapped_as_array_item() {
    let input = json!({
        "path": "foo.rs",
        "edits": "not valid json"
    });
    let prepared = coerce_edits(&input);
    let err = match validate_and_coerce("edit", &edit_schema(), &prepared) {
        Ok(_) => panic!("invalid stringified edits must be rejected"),
        Err(error) => error,
    };
    assert!(
        err.contains("`edits` type is expected as `array` but provided as `string`"),
        "got: {err}"
    );
    assert!(err.contains("not valid json"), "got: {err}");
}

#[test]
fn nested_required_field_reports_full_path() {
    let input = json!({
        "path": "foo.rs",
        "edits": [{ "oldText": "before" }]
    });
    let err = match validate_and_coerce("edit", &edit_schema(), &input) {
        Ok(_) => panic!("missing nested field must be rejected"),
        Err(error) => error,
    };
    assert!(
        err.contains("required parameter `edits[0].newText` is missing"),
        "got: {err}"
    );
}

#[test]
fn validation_error_preserves_raw_arguments_after_preparation() {
    let raw = json!({
        "path": "foo.rs",
        "old_text": "before"
    });
    let prepared = json!({
        "path": "foo.rs",
        "edits": [{ "oldText": "before" }]
    });
    let err = match validate_and_coerce_with_received("edit", &edit_schema(), &prepared, &raw) {
        Ok(_) => panic!("missing nested field must be rejected"),
        Err(error) => error,
    };
    assert!(err.contains("edits[0].newText"), "got: {err}");
    assert!(err.contains("\"old_text\": \"before\""), "got: {err}");
    assert!(!err.contains("\"edits\":"), "got: {err}");
}

#[test]
fn nested_values_are_coerced_recursively() {
    let schema = json!({
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": { "count": { "type": "integer" } },
                    "required": ["count"]
                }
            }
        },
        "required": ["items"]
    });
    let input = json!({ "items": [{ "count": "7" }] });
    let result = match validate_and_coerce("test", &schema, &input) {
        Ok(value) => value,
        Err(error) => panic!("unexpected validation error: {error}"),
    };
    assert_eq!(result["items"][0]["count"], json!(7));
}

// ── enum validation ─────────────────────────────────────────────────────

#[test]
fn enum_valid_value() {
    let input = json!({ "action": "add", "scope": "global" });
    let result = validate_and_coerce("Memory", &memory_schema(), &input).unwrap();
    assert_eq!(result["action"], json!("add"));
}

#[test]
fn enum_invalid_value() {
    let input = json!({ "action": "append", "scope": "global" });
    let err = validate_and_coerce("Memory", &memory_schema(), &input).unwrap_err();
    assert!(err.contains("not one of the allowed values"), "got: {err}");
    assert!(err.contains("append"), "got: {err}");
}

#[test]
fn enum_checked_after_coercion() {
    // "1" as string should be coerced to integer 1, then pass enum check.
    let schema = json!({
        "type": "object",
        "properties": {
            "level": { "type": "integer", "enum": [1, 2, 3] }
        },
        "required": ["level"]
    });
    let input = json!({ "level": "1" });
    let result = validate_and_coerce("test", &schema, &input).unwrap();
    assert_eq!(result["level"], json!(1));
}

// ── root input not an object ────────────────────────────────────────────

#[test]
fn root_input_is_string() {
    let input = json!("just a string");
    let err = validate_and_coerce("read", &read_file_schema(), &input).unwrap_err();
    assert!(err.contains("must be a JSON object"), "got: {err}");
}

#[test]
fn root_input_is_array() {
    let input = json!([1, 2, 3]);
    let err = validate_and_coerce("read", &read_file_schema(), &input).unwrap_err();
    assert!(err.contains("must be a JSON object"), "got: {err}");
    assert!(
        err.contains("emit multiple separate tool calls"),
        "array mistakes should tell the model how to retry: {err}"
    );
}

#[test]
fn root_input_is_null() {
    let input = json!(null);
    let err = validate_and_coerce("read", &read_file_schema(), &input).unwrap_err();
    assert!(err.contains("must be a JSON object"), "got: {err}");
}

// ── valid input passes through ──────────────────────────────────────────

#[test]
fn valid_input_passes() {
    let input = json!({ "path": "/tmp/foo.rs", "offset": 10, "limit": 50 });
    let result = validate_and_coerce("read", &read_file_schema(), &input).unwrap();
    assert_eq!(result, input);
}

#[test]
fn valid_input_optional_fields_omitted() {
    let input = json!({ "path": "/tmp/foo.rs" });
    let result = validate_and_coerce("read", &read_file_schema(), &input).unwrap();
    assert_eq!(result, input);
}

#[test]
fn optional_null_field_is_removed() {
    let input = json!({ "path": "/tmp/foo.rs", "offset": null });
    let result = match validate_and_coerce("read", &read_file_schema(), &input) {
        Ok(value) => value,
        Err(error) => panic!("optional null should be omitted: {error}"),
    };
    assert_eq!(result, json!({ "path": "/tmp/foo.rs" }));
}

#[test]
fn required_null_field_is_not_removed() {
    let input = json!({ "path": null });
    let error = match validate_and_coerce("read", &read_file_schema(), &input) {
        Ok(value) => panic!("required null unexpectedly passed: {value}"),
        Err(error) => error,
    };
    assert!(error.contains("path"), "got: {error}");
    assert!(error.contains("null"), "got: {error}");
}

#[test]
fn nullable_optional_field_is_preserved() {
    let schema = json!({
        "type": "object",
        "properties": {
            "note": { "type": ["string", "null"] }
        }
    });
    let input = json!({ "note": null });
    let result = match validate_and_coerce("test", &schema, &input) {
        Ok(value) => value,
        Err(error) => panic!("nullable field should pass: {error}"),
    };
    assert_eq!(result, input);
}

#[test]
fn nested_optional_null_field_is_removed() {
    let schema = json!({
        "type": "object",
        "properties": {
            "options": {
                "type": "object",
                "properties": {
                    "limit": { "type": "integer" }
                }
            }
        }
    });
    let input = json!({ "options": { "limit": null } });
    let result = match validate_and_coerce("test", &schema, &input) {
        Ok(value) => value,
        Err(error) => panic!("nested optional null should be omitted: {error}"),
    };
    assert_eq!(result, json!({ "options": {} }));
}

#[test]
fn required_null_inside_array_item_is_not_removed() {
    // Edit-shaped schema: null must survive inside array items so validation
    // reports the missing replacement rather than silently dropping it.
    let schema = json!({
        "type": "object",
        "properties": {
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "oldText": { "type": "string" },
                        "newText": { "type": "string" }
                    },
                    "required": ["oldText", "newText"]
                }
            }
        },
        "required": ["edits"]
    });
    let input = json!({ "edits": [{ "oldText": null, "newText": "x" }] });
    let error = match validate_and_coerce("edit", &schema, &input) {
        Ok(value) => panic!("required null inside an array item must fail: {value}"),
        Err(error) => error,
    };
    assert!(error.contains("oldText"), "got: {error}");
    assert!(error.contains("null"), "got: {error}");
}

// ── schema without properties (degenerate) ──────────────────────────────

#[test]
fn schema_without_properties_passes() {
    let schema = json!({ "type": "object" });
    let input = json!({ "anything": "goes" });
    let result = validate_and_coerce("test", &schema, &input).unwrap();
    assert_eq!(result, input);
}

// ── truncation ──────────────────────────────────────────────────────────

#[test]
fn truncate_short_error() {
    let short = "short error";
    assert_eq!(truncate_error(short), short);
}

#[test]
fn truncate_long_error() {
    let long = "x".repeat(20_000);
    let result = truncate_error(&long);
    assert!(result.len() < long.len());
    assert!(result.contains("characters truncated"));
    assert!(result.starts_with(&"x".repeat(5_000)));
    assert!(result.ends_with(&"x".repeat(5_000)));
}

#[test]
fn truncate_utf8_safe() {
    // Each '中' is 3 bytes. Build a string that exceeds 10_000 bytes.
    let ch = "中";
    let count = 5_000; // 5000 * 3 = 15_000 bytes
    let long: String = ch.repeat(count);
    let result = truncate_error(&long);
    assert!(result.contains("characters truncated"));
    // Must not panic — the cut landed on a valid char boundary.
    assert!(result.starts_with(ch));
    assert!(result.ends_with(ch));
}

// ── extra fields are preserved (not rejected) ───────────────────────────

#[test]
fn extra_fields_preserved() {
    let input = json!({ "path": "foo.rs", "unknown_field": 42 });
    let result = validate_and_coerce("read", &read_file_schema(), &input).unwrap();
    assert_eq!(result["unknown_field"], json!(42));
}

// ── tool result truncation ──────────────────────────────────────────────

use evotengine::spill::MAX_TOOL_RESULT_BYTES;
use evotengine::tools::validation::truncate_tool_text;

#[test]
fn tool_text_within_limit_unchanged() {
    let text = "short output";
    assert_eq!(truncate_tool_text(text, MAX_TOOL_RESULT_BYTES), text);
}

#[test]
fn tool_text_exceeding_limit_truncated() {
    let big = "x".repeat(200_000);
    let result = truncate_tool_text(&big, MAX_TOOL_RESULT_BYTES);
    assert!(result.len() < big.len());
    assert!(result.contains("bytes truncated"));
}

#[test]
fn tool_text_truncation_utf8_safe() {
    let big: String = "中".repeat(50_000); // 150_000 bytes
    let result = truncate_tool_text(&big, MAX_TOOL_RESULT_BYTES);
    assert!(result.contains("bytes truncated"));
    assert!(result.starts_with("中"));
    assert!(result.ends_with("中"));
}

// ── multi-block tool result capping ─────────────────────────────────────

use evotengine::tools::validation::cap_tool_result_content;
use evotengine::types::Content;

#[test]
fn cap_single_block_within_limit_unchanged() {
    let content = vec![Content::Text {
        text: "short".into(),
    }];
    let result = cap_tool_result_content(content.clone(), MAX_TOOL_RESULT_BYTES);
    assert_eq!(result.len(), 1);
    if let Content::Text { text } = &result[0] {
        assert_eq!(text, "short");
    }
}

#[test]
fn cap_multi_block_within_limit_unchanged() {
    let content = vec![
        Content::Text {
            text: "block1".into(),
        },
        Content::Text {
            text: "block2".into(),
        },
    ];
    let result = cap_tool_result_content(content.clone(), MAX_TOOL_RESULT_BYTES);
    // Under limit — blocks preserved as-is
    assert_eq!(result.len(), 2);
}

#[test]
fn cap_multi_block_exceeding_limit_merged_and_truncated() {
    // 10 blocks × 29KB each = 290KB total, well over 30KB limit
    let block = "x".repeat(29_000);
    let content: Vec<Content> = (0..10)
        .map(|_| Content::Text {
            text: block.clone(),
        })
        .collect();
    let result = cap_tool_result_content(content, MAX_TOOL_RESULT_BYTES);

    // Should be merged into a single text block + truncated
    let text_blocks: Vec<&str> = result
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text_blocks.len(), 1, "should merge into one text block");
    assert!(
        text_blocks[0].len() <= MAX_TOOL_RESULT_BYTES + 200, // allow for truncation note
        "merged block should be capped near MAX_TOOL_RESULT_BYTES"
    );
    assert!(text_blocks[0].contains("bytes truncated"));
}

#[test]
fn cap_preserves_non_text_content() {
    // Mix of text (oversized) and non-text — order must be preserved.
    // Original: [Text(big), Image, Text(big)]
    let big_text = Content::Text {
        text: "x".repeat(60_000),
    };
    let image = Content::Image {
        mime_type: "image/png".into(),
        source: evotengine::ImageSource::Base64 {
            data: "base64data".into(),
        },
    };
    let big_text2 = Content::Text {
        text: "y".repeat(60_000),
    };
    let content = vec![big_text, image, big_text2];
    let result = cap_tool_result_content(content, MAX_TOOL_RESULT_BYTES);

    // Merged text block should appear first (position of first text block),
    // then image stays in its original relative position.
    assert!(
        matches!(&result[0], Content::Text { .. }),
        "first element should be the merged text block"
    );
    assert!(
        matches!(&result[1], Content::Image { .. }),
        "image should stay in its original position after the first text"
    );
    // Only 2 elements: merged text + image (second text block was merged in)
    assert_eq!(result.len(), 2, "should have merged text + image");

    // Text should be truncated
    if let Content::Text { text } = &result[0] {
        assert!(text.contains("bytes truncated"));
    }
}

// ── parameter alias normalization ───────────────────────────────────────

#[test]
fn alias_file_path_to_path() {
    let aliases: &[(&str, &[&str])] = &[("path", &["file_path", "filePath", "file"])];
    let input = json!({ "file_path": "/tmp/foo.rs", "offset": 10 });
    let result = normalize_aliases(&input, aliases);
    assert_eq!(result["path"], json!("/tmp/foo.rs"));
    assert_eq!(result["offset"], json!(10));
    assert!(result.get("file_path").is_none());
}

#[test]
fn alias_file_path_camel_case() {
    let aliases: &[(&str, &[&str])] = &[("path", &["file_path", "filePath", "file"])];
    let input = json!({ "filePath": "/tmp/bar.rs" });
    let result = normalize_aliases(&input, aliases);
    assert_eq!(result["path"], json!("/tmp/bar.rs"));
}

#[test]
fn alias_skipped_when_canonical_present() {
    let aliases: &[(&str, &[&str])] = &[("path", &["file_path", "filePath"])];
    let input = json!({ "path": "/correct.rs", "file_path": "/wrong.rs" });
    let result = normalize_aliases(&input, aliases);
    assert_eq!(result["path"], json!("/correct.rs"));
}

#[test]
fn alias_non_object_input_passthrough() {
    let aliases: &[(&str, &[&str])] = &[("path", &["file_path"])];
    let input = json!("just a string");
    let result = normalize_aliases(&input, aliases);
    assert_eq!(result, input);
}

// ── edits coercion ──────────────────────────────────────────────────────

#[test]
fn coerce_edits_string_to_array() {
    let input = json!({
        "path": "foo.rs",
        "edits": "[{\"old_text\": \"a\", \"new_text\": \"b\"}]"
    });
    let result = coerce_edits(&input);
    let edits = match result["edits"].as_array() {
        Some(edits) => edits,
        None => panic!("edits must be an array"),
    };
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0]["oldText"], json!("a"));
    assert_eq!(edits[0]["newText"], json!("b"));
}

#[test]
fn coerce_edits_top_level_old_new() {
    let input = json!({
        "path": "foo.rs",
        "old_text": "hello",
        "new_text": "world"
    });
    let result = coerce_edits(&input);
    let edits = match result["edits"].as_array() {
        Some(edits) => edits,
        None => panic!("edits must be an array"),
    };
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0]["oldText"], json!("hello"));
    assert_eq!(edits[0]["newText"], json!("world"));
    assert!(result.get("old_text").is_none());
}

#[test]
fn coerce_edits_top_level_old_text_camel() {
    let input = json!({
        "path": "foo.rs",
        "oldText": "hello",
        "newText": "world"
    });
    let result = coerce_edits(&input);
    let edits = match result["edits"].as_array() {
        Some(edits) => edits,
        None => panic!("edits must be an array"),
    };
    assert_eq!(edits[0]["oldText"], json!("hello"));
    assert_eq!(edits[0]["newText"], json!("world"));
}

#[test]
fn coerce_edits_appends_top_level_replacement() {
    let input = json!({
        "path": "foo.rs",
        "edits": [{ "oldText": "a", "newText": "b" }],
        "oldText": "c",
        "newText": "d"
    });
    let result = coerce_edits(&input);
    assert_eq!(
        result["edits"],
        json!([
            { "oldText": "a", "newText": "b" },
            { "oldText": "c", "newText": "d" }
        ])
    );
    assert!(result.get("oldText").is_none());
    assert!(result.get("newText").is_none());
}

#[test]
fn coerce_edits_normalize_entry_field_names() {
    let input = json!({
        "path": "foo.rs",
        "edits": [{
            "oldText": "aaa",
            "newText": "bbb"
        }, {
            "old_string": "ccc",
            "new_string": "ddd"
        }]
    });
    let result = coerce_edits(&input);
    let edits = match result["edits"].as_array() {
        Some(edits) => edits,
        None => panic!("edits must be an array"),
    };
    assert_eq!(edits[0]["oldText"], json!("aaa"));
    assert_eq!(edits[0]["newText"], json!("bbb"));
    assert_eq!(edits[1]["oldText"], json!("ccc"));
    assert_eq!(edits[1]["newText"], json!("ddd"));
}

#[test]
fn coerce_edits_invalid_string_is_preserved_for_validation() {
    let input = json!({
        "path": "foo.rs",
        "edits": "not valid json"
    });
    let result = coerce_edits(&input);
    assert_eq!(result["edits"], json!("not valid json"));
}

#[test]
fn coerce_edits_already_correct_unchanged() {
    let input = json!({
        "path": "foo.rs",
        "edits": [{ "oldText": "x", "newText": "y" }]
    });
    let result = coerce_edits(&input);
    assert_eq!(result, input);
}
