use serde_json::Value;

use crate::types::AliasMap;

// ── parameter alias normalization ────────────────────────────────────────

/// Resolve known parameter aliases to their canonical names.
///
/// For each entry in `aliases`, if the canonical key is absent from `input`
/// but one of its aliases is present, the alias is renamed to the canonical key.
/// This runs before schema validation so the model can use either name.
pub fn normalize_aliases(input: &Value, aliases: AliasMap) -> Value {
    let obj = match input.as_object() {
        Some(o) => o,
        None => return input.clone(),
    };
    let mut normalized = obj.clone();
    for (canonical, alt_names) in aliases {
        if normalized.contains_key(*canonical) {
            continue;
        }
        for alt in *alt_names {
            if let Some(val) = normalized.remove(*alt) {
                normalized.insert((*canonical).to_string(), val);
                break;
            }
        }
    }
    Value::Object(normalized)
}

/// Coerce the `edits` field for the Edit tool.
///
/// Handles two common model mistakes:
/// 1. `edits` is a JSON string containing an array — parse it.
/// 2. No `edits` array but top-level old/new text fields — wrap one edit.
///
/// The public and canonical shape stays camelCase. Unrecognized malformed input
/// is preserved so recursive schema validation can report the original value.
pub fn coerce_edits(input: &Value) -> Value {
    let obj = match input.as_object() {
        Some(o) => o,
        None => return input.clone(),
    };
    let mut result = obj.clone();

    if let Some(s) = result.get("edits").and_then(|v| v.as_str()) {
        if let Ok(parsed) = serde_json::from_str::<Value>(s) {
            if parsed.is_array() {
                result.insert("edits".to_string(), parsed);
            }
        }
    }

    let old = result
        .get("oldText")
        .or_else(|| result.get("old_text"))
        .or_else(|| result.get("old_string"))
        .cloned();
    let new = result
        .get("newText")
        .or_else(|| result.get("new_text"))
        .or_else(|| result.get("new_string"))
        .cloned();
    if let (Some(old_text), Some(new_text)) = (old, new) {
        let mut entries = result
            .get("edits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        entries.push(serde_json::json!({
            "oldText": old_text,
            "newText": new_text
        }));
        result.insert("edits".to_string(), Value::Array(entries));
        for key in [
            "oldText",
            "old_text",
            "old_string",
            "newText",
            "new_text",
            "new_string",
        ] {
            result.remove(key);
        }
    }

    if let Some(entries) = result.get("edits").and_then(Value::as_array).cloned() {
        let normalized = entries
            .into_iter()
            .map(|entry| normalize_edit_entry(&entry))
            .collect();
        result.insert("edits".to_string(), Value::Array(normalized));
    }

    Value::Object(result)
}

fn normalize_edit_entry(entry: &Value) -> Value {
    let obj = match entry.as_object() {
        Some(o) => o,
        None => return entry.clone(),
    };
    let mut out = obj.clone();

    if !out.contains_key("oldText") {
        for alias in ["old_text", "old_string"] {
            if let Some(value) = out.remove(alias) {
                out.insert("oldText".to_string(), value);
                break;
            }
        }
    }
    if !out.contains_key("newText") {
        for alias in ["new_text", "new_string"] {
            if let Some(value) = out.remove(alias) {
                out.insert("newText".to_string(), value);
                break;
            }
        }
    }
    Value::Object(out)
}

/// Lightweight tool-input validation and type coercion.
///
/// Validation follows nested object properties and array items, including
/// nested `required` fields. Trivial string-to-primitive coercions are applied
/// before validation. Unknown schema keywords remain permissive.
use crate::types::Content;

// ── public API ──────────────────────────────────────────────────────────

/// Validate `input` against `schema` and coerce trivial type mismatches.
///
/// Returns `Ok(coerced_input)` on success, or `Err(structured_error)` with a
/// human-/LLM-readable message listing every problem found.
pub fn validate_and_coerce(
    tool_name: &str,
    schema: &Value,
    input: &Value,
) -> Result<Value, String> {
    validate_and_coerce_with_received(tool_name, schema, input, input)
}

/// Validate prepared arguments while retaining the raw model arguments in any
/// error. This keeps compatibility normalization separate from diagnostics.
pub fn validate_and_coerce_with_received(
    tool_name: &str,
    schema: &Value,
    input: &Value,
    received: &Value,
) -> Result<Value, String> {
    if schema.get("properties").is_some() && !input.is_object() {
        return Err(format_error(
            tool_name,
            &[
                "Tool input must be a JSON object".to_string(),
                "To run this tool multiple times in parallel, emit multiple separate tool calls in the same assistant response; do not wrap their argument objects in an array".to_string(),
            ],
            received,
        ));
    }

    let mut normalized = input.clone();
    strip_optional_nulls(schema, &mut normalized);

    let mut errors = Vec::new();
    let coerced = validate_node(schema, &normalized, "", &mut errors);
    if errors.is_empty() {
        Ok(coerced)
    } else {
        Err(format_error(tool_name, &errors, received))
    }
}

/// Truncate an error string that exceeds 10 000 characters, keeping the first
/// and last 5 000 characters with a note in the middle.  Uses `char_indices`
/// so the cut points always land on valid UTF-8 boundaries.
pub fn truncate_error(text: &str) -> String {
    const MAX: usize = 10_000;
    const HALF: usize = 5_000;
    if text.len() <= MAX {
        return text.to_string();
    }
    let start_end = text.floor_char_boundary(HALF);
    let tail_start = text.ceil_char_boundary(text.len() - HALF);
    let truncated = tail_start - start_end;
    format!(
        "{}\n\n... [{truncated} characters truncated] ...\n\n{}",
        &text[..start_end],
        &text[tail_start..]
    )
}

// ── internals ───────────────────────────────────────────────────────────

fn strip_optional_nulls(schema: &Value, input: &mut Value) {
    if let (Some(properties), Some(object)) = (
        schema.get("properties").and_then(Value::as_object),
        input.as_object_mut(),
    ) {
        let required = schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<std::collections::HashSet<_>>();

        let removable = properties
            .iter()
            .filter_map(|(name, property_schema)| {
                let is_optional_null = object.get(name).is_some_and(Value::is_null)
                    && !required.contains(name.as_str())
                    && schema_rejects_null(property_schema);
                is_optional_null.then_some(name.clone())
            })
            .collect::<Vec<_>>();
        for name in removable {
            object.remove(&name);
        }

        for (name, property_schema) in properties {
            if let Some(value) = object.get_mut(name) {
                strip_optional_nulls(property_schema, value);
            }
        }
        return;
    }

    if let (Some(item_schema), Some(items)) = (schema.get("items"), input.as_array_mut()) {
        for item in items {
            strip_optional_nulls(item_schema, item);
        }
    }
}

fn schema_rejects_null(schema: &Value) -> bool {
    match schema.get("type") {
        Some(Value::String(expected)) => expected != "null",
        Some(Value::Array(types)) => !types.iter().any(|value| value.as_str() == Some("null")),
        _ => schema
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|values| !values.iter().any(Value::is_null)),
    }
}

fn validate_node(schema: &Value, input: &Value, path: &str, errors: &mut Vec<String>) -> Value {
    let value = match schema.get("type").and_then(Value::as_str) {
        Some(expected_type) => match try_coerce(input, expected_type, schema) {
            CoerceResult::Ok(value) => value,
            CoerceResult::AlreadyCorrect => input.clone(),
            CoerceResult::Mismatch => {
                errors.push(format!(
                    "The parameter `{}` type is expected as `{expected_type}` but provided as `{}`",
                    display_path(path),
                    json_type_name(input)
                ));
                return input.clone();
            }
        },
        None => input.clone(),
    };

    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.contains(&value) {
            let options = allowed.iter().map(Value::to_string).collect::<Vec<_>>();
            errors.push(format!(
                "The parameter `{}` value {value} is not one of the allowed values: [{}]",
                display_path(path),
                options.join(", ")
            ));
        }
    }

    if let (Some(actual), Some(minimum)) = (
        value.as_f64(),
        schema.get("minimum").and_then(Value::as_f64),
    ) {
        if actual < minimum {
            errors.push(format!(
                "The parameter `{}` value {value} is below the minimum {}",
                display_path(path),
                schema["minimum"]
            ));
        }
    }

    if let (Some(properties), Some(object)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object(),
    ) {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    errors.push(format!(
                        "The required parameter `{}` is missing",
                        child_path(path, name)
                    ));
                }
            }
        }

        let mut coerced = object.clone();
        for (name, property_schema) in properties {
            if let Some(property_value) = object.get(name) {
                let property_path = child_path(path, name);
                let normalized =
                    validate_node(property_schema, property_value, &property_path, errors);
                coerced.insert(name.clone(), normalized);
            }
        }
        return Value::Object(coerced);
    }

    if let (Some(item_schema), Some(items)) = (schema.get("items"), value.as_array()) {
        return Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    validate_node(
                        item_schema,
                        item,
                        &format!("{}[{index}]", display_path(path)),
                        errors,
                    )
                })
                .collect(),
        );
    }

    value
}

fn child_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}.{child}")
    }
}

fn display_path(path: &str) -> &str {
    if path.is_empty() {
        "root"
    } else {
        path
    }
}

enum CoerceResult {
    /// Value was coerced to a new value.
    Ok(Value),
    /// Value already matches the expected type.
    AlreadyCorrect,
    /// Value cannot be coerced.
    Mismatch,
}

fn try_coerce(val: &Value, expected: &str, schema: &Value) -> CoerceResult {
    // Already the right type?
    if type_matches(val, expected) {
        return CoerceResult::AlreadyCorrect;
    }

    // JavaScript-based providers can serialize an integer tool argument as
    // `2000.0`. Preserve that cross-provider behavior without accepting a
    // fractional value. Restrict float conversion to JavaScript's safe integer
    // range so the normalization cannot silently lose precision.
    if expected == "integer" {
        const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
        if let Some(number) = val.as_f64() {
            let is_integral = number.to_bits() == number.trunc().to_bits();
            if number.is_finite() && is_integral && number.abs() <= MAX_SAFE_INTEGER {
                let normalized = if number.is_sign_negative() {
                    Value::Number((number as i64).into())
                } else {
                    Value::Number((number as u64).into())
                };
                return CoerceResult::Ok(normalized);
            }
        }
    }

    // Only attempt coercion from strings after numeric normalization.
    let s = match val.as_str() {
        Some(s) => s,
        None => return CoerceResult::Mismatch,
    };

    match expected {
        "integer" => {
            if let Ok(n) = s.parse::<i64>() {
                return CoerceResult::Ok(Value::Number(n.into()));
            }
            if let Ok(n) = s.parse::<u64>() {
                return CoerceResult::Ok(Value::Number(n.into()));
            }
            CoerceResult::Mismatch
        }
        "number" => {
            if let Ok(n) = s.parse::<i64>() {
                return CoerceResult::Ok(Value::Number(n.into()));
            }
            if let Ok(n) = s.parse::<f64>() {
                if let Some(num) = serde_json::Number::from_f64(n) {
                    return CoerceResult::Ok(Value::Number(num));
                }
            }
            CoerceResult::Mismatch
        }
        "boolean" => match s.trim().to_lowercase().as_str() {
            "true" => CoerceResult::Ok(Value::Bool(true)),
            "false" => CoerceResult::Ok(Value::Bool(false)),
            _ => CoerceResult::Mismatch,
        },
        "array" => {
            // A JSON-array string (`["a","b"]`) parses straight through.
            if let Ok(v) = serde_json::from_str::<Value>(s) {
                if v.is_array() {
                    return CoerceResult::Ok(v);
                }
            }
            // Only array<string> accepts a bare scalar as one item. In
            // particular, never turn malformed edit array<object> input into a
            // string element: preserving that mismatch produces a useful error.
            if schema
                .get("items")
                .and_then(|items| items.get("type"))
                .and_then(Value::as_str)
                == Some("string")
            {
                return CoerceResult::Ok(Value::Array(vec![Value::String(s.to_string())]));
            }
            CoerceResult::Mismatch
        }
        "object" => {
            if let Ok(v) = serde_json::from_str::<Value>(s) {
                if v.is_object() {
                    return CoerceResult::Ok(v);
                }
            }
            CoerceResult::Mismatch
        }
        _ => CoerceResult::Mismatch,
    }
}

fn type_matches(val: &Value, expected: &str) -> bool {
    match expected {
        "string" => val.is_string(),
        "integer" => val.is_i64() || val.is_u64(),
        "number" => val.is_number(),
        "boolean" => val.is_boolean(),
        "array" => val.is_array(),
        "object" => val.is_object(),
        "null" => val.is_null(),
        _ => true, // unknown type — don't block
    }
}

fn json_type_name(val: &Value) -> &'static str {
    match val {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn format_error(tool_name: &str, issues: &[String], input: &Value) -> String {
    let label = if issues.len() == 1 { "issue" } else { "issues" };
    let body = issues.join("\n");
    let received = match serde_json::to_string_pretty(input) {
        Ok(value) => value,
        Err(_) => input.to_string(),
    };
    format!(
        "InputValidationError: {tool_name} failed due to the following {label}:\n{body}\n\nReceived arguments:\n{received}"
    )
}

// ── tool result size limiting ───────────────────────────────────────────

/// Truncate a tool result text to `max_bytes`, keeping head + tail with a
/// note in the middle.  UTF-8 safe.  Returns the original string unchanged
/// if it fits.
pub fn truncate_tool_text(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let half = max_bytes / 2;
    let head_end = text.floor_char_boundary(half);
    let tail_start = text.ceil_char_boundary(text.len() - half);
    let omitted = tail_start - head_end;
    format!(
        "{}\n\n... [{omitted} bytes truncated] ...\n\n{}",
        &text[..head_end],
        &text[tail_start..]
    )
}

/// Cap the total text size of a tool result's content blocks.
///
/// If the combined byte length of all `Content::Text` blocks exceeds
/// `max_bytes`, all text blocks are merged into a single truncated block
/// placed at the position of the first original text block.  The text
/// block structure is lost (multiple blocks become one), but non-text
/// blocks (e.g. images) are preserved in their original relative order.
pub fn cap_tool_result_content(content: Vec<Content>, max_bytes: usize) -> Vec<Content> {
    let total_bytes: usize = content
        .iter()
        .map(|c| match c {
            Content::Text { text } => text.len(),
            _ => 0,
        })
        .sum();

    if total_bytes <= max_bytes {
        return content;
    }

    if max_bytes == 0 {
        return content
            .into_iter()
            .filter(|c| !matches!(c, Content::Text { .. }))
            .collect();
    }

    // Merge all text, truncate, then splice back at the first text position.
    let mut merged = String::with_capacity(total_bytes);
    let mut first_text_idx: Option<usize> = None;
    for (i, c) in content.iter().enumerate() {
        if let Content::Text { text } = c {
            if first_text_idx.is_none() {
                first_text_idx = Some(i);
            }
            if !merged.is_empty() {
                merged.push('\n');
            }
            merged.push_str(text);
        }
    }
    let truncated = truncate_tool_text(&merged, max_bytes);

    // Rebuild: replace all text blocks with a single truncated block at the
    // position of the first text block; keep non-text blocks in place.
    let mut result = Vec::with_capacity(content.len());
    let mut text_emitted = false;
    for (i, c) in content.into_iter().enumerate() {
        match c {
            Content::Text { .. } => {
                if Some(i) == first_text_idx && !text_emitted {
                    result.push(Content::Text {
                        text: truncated.clone(),
                    });
                    text_emitted = true;
                }
                // Skip other text blocks — already merged.
            }
            other => result.push(other),
        }
    }
    result
}
