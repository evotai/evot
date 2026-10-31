use std::sync::Arc;

use evot::privacy::summarize_records;
use evot::privacy::Action;
use evot::privacy::Masker;
use evot::privacy::MaskingProvider;
use evot::privacy::PrivacySettings;
use evot::privacy::Target;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use evot_engine::types::Content;
use evot_engine::types::Message;
use evot_engine::types::StopReason;
use evot_engine::types::ThinkingMetadata;
use parking_lot::Mutex;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

// Shaped like real values so the rules take them; none is a live credential.
const API_KEY: &str = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const AWS_KEY: &str = "AKIAIOSFODNN7EXAMPLE";
const EMAIL: &str = "alice@acme-corp.cn";
const PHONE: &str = "13800138000";
const ID_CARD: &str = "11010519491231002X";
const CARD: &str = "4111 1111 1111 1111";
const PASSWORD: &str = "Hunter2pass9";

fn masker_with(settings: PrivacySettings) -> Result<Masker, evot::error::EvotError> {
    Masker::new(&settings, [7; 32])
}

fn masker() -> Result<Masker, evot::error::EvotError> {
    masker_with(PrivacySettings::default())
}

fn user(text: &str) -> Message {
    Message::User {
        content: vec![Content::Text { text: text.into() }],
        timestamp: 0,
        provenance: None,
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

fn tool_result(id: &str, text: &str) -> Message {
    Message::ToolResult {
        tool_call_id: id.into(),
        tool_name: "read".into(),
        content: vec![Content::Text { text: text.into() }],
        is_error: false,
        timestamp: 0,
        retention: Default::default(),
    }
}

fn config(messages: Vec<Message>) -> StreamConfig {
    StreamConfig {
        model: "m".into(),
        system_prompt: String::new(),
        messages,
        tools: vec![],
        thinking_level: Default::default(),
        api_key: "provider-key".into(),
        max_tokens: None,
        model_config: None,
        cache_config: Default::default(),
        prompt_cache_key: Some("session-1".into()),
        client: None,
    }
}

fn sent(config: &StreamConfig) -> Result<String, serde_json::Error> {
    Ok(format!(
        "{}{}",
        config.system_prompt,
        serde_json::to_string(&config.messages)?
    ))
}

fn first_text(message: &Message) -> &str {
    let content = match message {
        Message::User { content, .. }
        | Message::Assistant { content, .. }
        | Message::ToolResult { content, .. } => content,
    };
    content
        .iter()
        .find_map(|block| match block {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .unwrap_or_default()
}

fn placeholder_in(text: &str) -> Option<&str> {
    let start = text.find("{{")?;
    let end = text[start..].find("}}")? + start + 2;
    Some(&text[start..end])
}

#[test]
fn masks_secrets_and_personal_data() -> TestResult {
    let masker = masker()?;
    let text = format!(
        "key {API_KEY}, aws {AWS_KEY}, mail {EMAIL}, call {PHONE}, id {ID_CARD}, card {CARD}, \
         DB_PASSWORD={PASSWORD}, 密码：786kih, postgres://app:s3cretpw@db.internal:5432/x"
    );
    let mut request = config(vec![user(&text)]);
    let report = masker.mask_request(&mut request)?;
    let wire = sent(&request)?;
    for value in [
        API_KEY, AWS_KEY, EMAIL, PHONE, ID_CARD, CARD, PASSWORD, "786kih", "s3cretpw",
    ] {
        assert!(!wire.contains(value), "{value} was sent: {wire}");
    }
    assert!(wire.contains("{{API_KEY_"));
    assert!(wire.contains("{{EMAIL_"));
    assert!(wire.contains("{{ID_CARD_"));
    assert!(
        wire.contains("db.internal"),
        "the host is no secret: {wire}"
    );
    for kind in [
        "API_KEY",
        "BANK_CARD",
        "EMAIL",
        "ID_CARD",
        "PASSWORD",
        "PHONE",
    ] {
        assert!(report.kinds().contains(&kind.to_string()), "missing {kind}");
    }
    assert!(!report.blocked());
    Ok(())
}

#[test]
fn placeholders_are_stable_across_requests_and_restorable() -> TestResult {
    let masker = masker()?;
    let mut first = config(vec![user(&format!("use {API_KEY}"))]);
    let mut second = config(vec![user(&format!("again {API_KEY}"))]);
    masker.mask_request(&mut first)?;
    masker.mask_request(&mut second)?;
    let a = placeholder_in(first_text(&first.messages[0])).ok_or("no placeholder")?;
    let b = placeholder_in(first_text(&second.messages[0])).ok_or("no placeholder")?;
    assert_eq!(a, b);
    // The model rewrites placeholders; each form still comes back.
    let body = a.trim_matches(['{', '}']);
    for written in [
        a.to_string(),
        format!("{{{{ {body} }}}}"),
        body.to_lowercase(),
        format!("{{{body}}}"),
    ] {
        assert_eq!(
            masker.restore_text(&format!("x {written} y"), false),
            format!("x {API_KEY} y")
        );
    }
    Ok(())
}

#[test]
fn leaves_code_and_lookalikes_alone() -> TestResult {
    let masker = masker()?;
    for text in [
        "secretKey: Uint8Array;",
        "max_tokens: 12345678",
        "密钥为 2048 位",
        "see icon@2x.png and @AGENTS.md",
        "git clone git@github.com:o/r.git",
        r#"{"ts": 17929036837, "ids": [13800138000, 1]}"#,
        "price 5.13800138000",
        "token = process.env.TOKEN_42",
        "mail bob@example.com",
    ] {
        let mut request = config(vec![user(text)]);
        let report = masker.mask_request(&mut request)?;
        assert_eq!(first_text(&request.messages[0]), text, "changed: {text}");
        assert!(report.is_empty(), "found something in {text}");
    }
    Ok(())
}

#[test]
fn a_value_found_once_is_masked_everywhere() -> TestResult {
    let masker = masker()?;
    let mut request = config(vec![
        user(&format!("password={PASSWORD}")),
        user(&format!("try {PASSWORD} again")),
    ]);
    masker.mask_request(&mut request)?;
    assert!(!sent(&request)?.contains(PASSWORD));
    // And in a later request with no context at all.
    let mut later = config(vec![user(&format!("it was {PASSWORD}"))]);
    masker.mask_request(&mut later)?;
    assert!(!sent(&later)?.contains(PASSWORD));
    masker.remember_secret("var-value-0001");
    let mut env = config(vec![user("output: var-value-0001")]);
    masker.mask_request(&mut env)?;
    assert!(!sent(&env)?.contains("var-value-0001"));
    Ok(())
}

#[test]
fn assignments_in_secret_files_are_masked() -> TestResult {
    let masker = masker()?;
    let file = "PORT=3000\nSTRIPE=abcd1234efgh\nDEBUG=true\n";
    let call = |id: &str, path: &str| Content::ToolCall {
        id: id.into(),
        name: "read".into(),
        arguments: json!({ "path": path }),
        metadata: None,
    };
    let mut request = config(vec![
        assistant(vec![call("c1", "/app/.env"), call("c2", "/app/notes.txt")]),
        tool_result("c1", file),
        tool_result("c2", file),
    ]);
    masker.mask_request(&mut request)?;
    let env = first_text(&request.messages[1]);
    assert!(!env.contains("abcd1234efgh"), "{env}");
    assert!(
        env.contains("PORT=3000") && env.contains("DEBUG=true"),
        "{env}"
    );
    // Context alone is no reason: the same text elsewhere names no secret,
    // but the value is known now, so it goes there too.
    assert!(!first_text(&request.messages[2]).contains("abcd1234efgh"));
    Ok(())
}

#[test]
fn signed_thinking_keeps_its_signature_unless_it_must_be_masked() -> TestResult {
    let masker = masker()?;
    let thinking = |text: &str| Content::Thinking {
        thinking: text.into(),
        metadata: Some(ThinkingMetadata::Anthropic {
            signature: "sig".into(),
        }),
    };
    // Thinking signed before masking was on still holds the user's key: it
    // goes masked, unsigned. A value the model made up is no user data, so
    // that thinking keeps its signature.
    let mut request = config(vec![
        user(&format!("deploy with {API_KEY}")),
        assistant(vec![thinking("plain reasoning")]),
        assistant(vec![thinking(&format!("the key is {API_KEY}"))]),
        assistant(vec![thinking("a test user: carol@fixture-co.cn")]),
    ]);
    masker.mask_request(&mut request)?;
    let blocks: Vec<&Content> = request
        .messages
        .iter()
        .filter_map(|m| match m {
            Message::Assistant { content, .. } => content.first(),
            _ => None,
        })
        .collect();
    assert!(
        matches!(blocks[0], Content::Thinking { metadata: Some(_), thinking } if thinking == "plain reasoning")
    );
    assert!(
        matches!(blocks[1], Content::Thinking { metadata: None, thinking } if !thinking.contains(API_KEY))
    );
    assert!(
        matches!(blocks[2], Content::Thinking { metadata: Some(_), thinking } if thinking.contains("carol@"))
    );

    // A reply's signed thinking stays as signed, placeholders included.
    let placeholder = placeholder_in(match blocks[1] {
        Content::Thinking { thinking, .. } => thinking,
        _ => "",
    })
    .ok_or("no placeholder")?
    .to_string();
    let mut reply = assistant(vec![
        thinking(&format!("using {placeholder}")),
        Content::Text {
            text: format!("done with {placeholder}"),
        },
    ]);
    masker.restore_message(&mut reply);
    let Message::Assistant { content, .. } = &reply else {
        return Err("not an assistant".into());
    };
    assert!(
        matches!(&content[0], Content::Thinking { thinking, .. } if thinking.contains(&placeholder))
    );
    assert!(
        matches!(&content[1], Content::Text { text } if text == &format!("done with {API_KEY}"))
    );
    Ok(())
}

#[test]
fn actions_terms_and_allow_list() -> TestResult {
    let mut settings = PrivacySettings::default();
    settings.actions.insert("EMAIL".into(), Action::Warn);
    settings.actions.insert("API_KEY".into(), Action::Block);
    settings.terms = vec!["Nightjar".into()];
    settings.allow = vec![PHONE.into()];
    let masker = masker_with(settings)?;

    let mut request = config(vec![user(&format!("{EMAIL} {PHONE} project NIGHTJAR"))]);
    let report = masker.mask_request(&mut request)?;
    let text = first_text(&request.messages[0]);
    assert!(text.contains(EMAIL), "warn sends as written");
    assert!(text.contains(PHONE), "allowed");
    assert!(
        !text.contains("NIGHTJAR") && text.contains("{{TERM_"),
        "{text}"
    );
    assert!(!report.blocked());
    assert!(
        report.kinds().contains(&"EMAIL".to_string()),
        "warned values are reported"
    );

    let mut blocked = config(vec![user(API_KEY)]);
    assert!(masker.mask_request(&mut blocked)?.blocked());

    let off = masker_with(PrivacySettings {
        enabled: false,
        ..PrivacySettings::default()
    })?;
    let mut request = config(vec![user(API_KEY)]);
    assert!(off.mask_request(&mut request)?.is_empty());
    assert_eq!(first_text(&request.messages[0]), API_KEY);
    Ok(())
}

#[test]
fn streamed_placeholders_are_restored_across_deltas() -> TestResult {
    let masker = masker()?;
    let mut request = config(vec![user(&format!("pw: \"{PASSWORD}\" {API_KEY}"))]);
    masker.mask_request(&mut request)?;
    let text = first_text(&request.messages[0]).to_string();
    let placeholder = placeholder_in(&text[text.rfind("{{").ok_or("none")?..])
        .ok_or("none")?
        .to_string();
    let reply = format!("key is {placeholder} ok");
    let mut restorer = masker.restorer();
    let mut out = String::new();
    // Every split point, including inside the placeholder.
    for cut in [8, 12, 14, 20] {
        let (a, b) = reply.split_at(cut);
        out.clear();
        let mut events = Vec::new();
        for delta in [a, b] {
            events.extend(restorer.push(StreamEvent::TextDelta {
                content_index: 0,
                delta: delta.into(),
            }));
        }
        events.extend(restorer.flush());
        for event in events {
            if let StreamEvent::TextDelta { delta, .. } = event {
                out.push_str(&delta);
            }
        }
        assert_eq!(out, format!("key is {API_KEY} ok"), "cut at {cut}");
    }

    // Tool-call arguments are raw JSON: a value goes back escaped.
    masker.remember_secret("pa\"ss\\word-123");
    let mut request = config(vec![user("pa\"ss\\word-123")]);
    masker.mask_request(&mut request)?;
    let tag = placeholder_in(first_text(&request.messages[0]))
        .ok_or("none")?
        .to_string();
    let mut events = restorer.push(StreamEvent::ToolCallDelta {
        content_index: 1,
        id: "t".into(),
        name: "bash".into(),
        delta: format!("{{\"command\": \"echo {tag}\"}}"),
    });
    events.extend(restorer.flush());
    let mut raw = String::new();
    for event in events {
        if let StreamEvent::ToolCallDelta { delta, .. } = event {
            raw.push_str(&delta);
        }
    }
    let parsed: serde_json::Value = serde_json::from_str(&raw)?;
    assert_eq!(parsed["command"], "echo pa\"ss\\word-123");
    Ok(())
}

/// A provider that answers with the first placeholder it was sent.
struct Echo {
    seen: Mutex<Option<StreamConfig>>,
}

#[async_trait::async_trait]
impl StreamProvider for Echo {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        _cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        let tag = config
            .messages
            .first()
            .and_then(|m| placeholder_in(first_text(m)))
            .unwrap_or_default()
            .to_string();
        *self.seen.lock() = Some(config);
        let text = format!("key is {tag}");
        let (a, b) = text.split_at(10);
        for delta in [a, b] {
            let _ = tx.send(StreamEvent::TextDelta {
                content_index: 0,
                delta: delta.into(),
            });
        }
        Ok(StreamOutcome::complete(assistant(vec![
            Content::Text { text },
            Content::ToolCall {
                id: "t1".into(),
                name: "bash".into(),
                arguments: json!({ "command": format!("curl -H 'x-api-key: {tag}'") }),
                metadata: None,
            },
        ])))
    }
}

#[tokio::test]
async fn masking_provider_sends_placeholders_and_restores_the_reply() -> TestResult {
    let dir = tempfile::tempdir()?;
    let masker = Arc::new(masker()?.with_records(dir.path().to_path_buf()));
    let echo = Arc::new(Echo {
        seen: Mutex::new(None),
    });
    let provider = MaskingProvider::with_masker(echo.clone(), masker);
    let (tx, mut rx) = mpsc::channel(16);
    let outcome = provider
        .stream_bounded(
            config(vec![user(&format!("deploy with {API_KEY}"))]),
            tx,
            CancellationToken::new(),
        )
        .await?;

    let seen = echo.seen.lock().take().ok_or("provider not called")?;
    assert!(!sent(&seen)?.contains(API_KEY));
    let Message::Assistant { content, .. } = outcome.message() else {
        return Err("not an assistant".into());
    };
    assert!(matches!(&content[0], Content::Text { text } if text == &format!("key is {API_KEY}")));
    assert!(matches!(&content[1], Content::ToolCall { arguments, .. }
        if arguments["command"] == format!("curl -H 'x-api-key: {API_KEY}'")));
    let mut streamed = String::new();
    while let Ok(event) = rx.try_recv() {
        if let StreamEvent::TextDelta { delta, .. } = event {
            streamed.push_str(&delta);
        }
    }
    assert_eq!(streamed, format!("key is {API_KEY}"));

    let summary = summarize_records(dir.path(), 1)?;
    assert_eq!(summary.requests, 1);
    assert_eq!(summary.blocked, 0);
    assert_eq!(summary.kinds[0].kind, "API_KEY");
    assert_eq!(summary.kinds[0].values, 1);
    let text = std::fs::read_to_string(
        std::fs::read_dir(dir.path())?
            .next()
            .ok_or("no file")??
            .path(),
    )?;
    assert!(!text.contains(API_KEY), "records never hold values");
    Ok(())
}

#[tokio::test]
async fn blocked_requests_never_reach_the_provider() -> TestResult {
    let dir = tempfile::tempdir()?;
    let mut settings = PrivacySettings::default();
    settings.actions.insert("PRIVATE_KEY".into(), Action::Block);
    let masker = Arc::new(masker_with(settings)?.with_records(dir.path().to_path_buf()));
    let echo = Arc::new(Echo {
        seen: Mutex::new(None),
    });
    let provider = MaskingProvider::with_masker(echo.clone(), masker);
    let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
    let (tx, _rx) = mpsc::channel(16);
    let error = provider
        .stream_bounded(config(vec![user(key)]), tx, CancellationToken::new())
        .await
        .err()
        .ok_or("a blocked request was sent")?;
    assert!(matches!(&error, ProviderError::InvalidRequest(m) if m.contains("PRIVATE_KEY")));
    assert!(!evot_engine::retry::should_retry(&error));
    assert!(echo.seen.lock().is_none());
    let summary = summarize_records(dir.path(), 1)?;
    assert_eq!((summary.requests, summary.blocked), (1, 1));
    assert_eq!(summary.by_target[&Target::Llm].blocked, 1);
    assert_eq!(summary.recent[0].kinds, vec!["PRIVATE_KEY".to_string()]);
    Ok(())
}

#[test]
fn uploads_are_scrubbed_for_good_and_keep_their_structure() -> TestResult {
    let masker = masker()?;
    let mut payload = json!({
        "session_id": "s-1",
        "entries": [
            {"id": "e1", "type": "message", "timestamp": "2026-01-01T00:00:00Z",
             "message": {"role": "user", "content": [{"type": "text", "text": format!("mail {EMAIL} key {API_KEY}")}]}},
            {"type": "toolCall", "id": "c1", "name": "read", "arguments": {"path": ".env"}},
            {"role": "toolResult", "toolCallId": "c1", "content": [{"type": "text", "text": "SERVICE=abcd1234efgh"}]},
            {"type": "image", "mimeType": "image/png", "data": "c2stYW50LWFwaTAz"},
            {"headers": {"Authorization": "Basic dXNlcjpwYXNz"}}
        ]
    });
    let report = masker.scrub(&mut payload)?;
    let text = payload.to_string();
    for value in [EMAIL, API_KEY, "abcd1234efgh", "dXNlcjpwYXNz"] {
        assert!(!text.contains(value), "{value} uploaded: {text}");
    }
    assert!(text.contains("[REDACTED:API_KEY]") && text.contains("[REDACTED:EMAIL]"));
    assert!(!text.contains("{{"), "uploads never carry placeholders");
    assert_eq!(payload["entries"][0]["id"], "e1");
    assert_eq!(payload["entries"][2]["toolCallId"], "c1");
    assert_eq!(payload["entries"][3]["data"], "c2stYW50LWFwaTAz");
    assert!(!report.is_empty());
    let record = report.record(Target::Share);
    assert!(record.values.iter().all(|v| !v.tag.contains(API_KEY)));
    Ok(())
}

#[test]
fn every_llm_transport_is_built_behind_the_privacy_boundary() -> TestResult {
    // A provider built anywhere else would send requests unmasked.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut stack = vec![root.join("src"), root.join("../../cli/addon/src")];
    let raw = [
        "AnthropicProvider)",
        "OpenAiCompatProvider)",
        "OpenAiResponsesProvider)",
        "BedrockProvider)",
    ];
    let mut offenders = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let path = entry?.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs")
                && !path.ends_with("models/transport.rs")
            {
                let text = std::fs::read_to_string(&path)?;
                if raw.iter().any(|name| text.contains(name)) {
                    offenders.push(path.display().to_string());
                }
            }
        }
    }
    assert!(offenders.is_empty(), "raw providers built in {offenders:?}");
    Ok(())
}

#[test]
fn notice_wording_is_the_cli_contract() {
    // cli/tests/privacy-card.test.ts parses these exact strings.
    assert_eq!(
        evot::privacy::blocked_message(Target::Llm, &["API_KEY".into(), "PRIVATE_KEY".into()]),
        "privacy blocked this request: it contains API_KEY, PRIVATE_KEY. Nothing was sent; run /privacy to review the rule."
    );
    assert_eq!(
        evot::privacy::blocked_message(Target::Sync, &["EMAIL".into()]),
        "privacy blocked this sync: it contains EMAIL. Nothing was sent; run /privacy to review the rule."
    );
    for (target, noun) in [
        (Target::Task, "task"),
        (Target::TaskReport, "task report"),
        (Target::Delivery, "delivery"),
    ] {
        assert_eq!(
            evot::privacy::blocked_message(target, &["API_KEY".into()]),
            format!("privacy blocked this {noun}: it contains API_KEY. Nothing was sent; run /privacy to review the rule.")
        );
    }
    assert_eq!(
        evot::privacy::unavailable_message("privacy settings are invalid: x"),
        "privacy masking is unavailable, so nothing was sent: privacy settings are invalid: x. Fix the settings or rule packs with /privacy (/privacy off disables request masking only after settings and packs load; uploads stay protected)"
    );
}

#[test]
fn settings_contract() -> TestResult {
    // Legacy v0: no version, fields from before any were added.
    let legacy = PrivacySettings::parse(r#"{"enabled": false}"#)?;
    assert!(!legacy.enabled && legacy.secrets && legacy.personal && legacy.terms_any_case);
    assert_eq!(
        legacy.schema_version,
        evot::privacy::SETTINGS_SCHEMA_VERSION
    );

    let mut current = PrivacySettings::default();
    current.actions.insert("EMAIL".into(), Action::Block);
    current.terms.push("Nightjar".into());
    let written = serde_json::to_value(&current)?;
    // A strict reader of the same version sees every field it expects.
    for field in [
        "schema_version",
        "enabled",
        "secrets",
        "personal",
        "actions",
        "terms",
        "terms_any_case",
        "allow",
    ] {
        assert!(written.get(field).is_some(), "missing {field}");
    }
    assert_eq!(written["actions"]["EMAIL"], "block");
    assert_eq!(PrivacySettings::parse(&written.to_string())?, current);

    let future = PrivacySettings::parse(r#"{"schema_version": 99}"#);
    assert!(future.is_err_and(|e| e.to_string().contains("newer")));
    Ok(())
}

#[test]
fn historical_settings_readers_and_current_writer_agree() -> TestResult {
    // Frozen historical field types, not the current PrivacySettings reader.
    // Like that reader, additive fields are tolerated; known fields are
    // required and enum/type changes are rejected.
    #[derive(Debug, serde::Deserialize)]
    #[serde(rename_all = "snake_case")]
    enum HistoricalAction {
        Mask,
        Warn,
        Block,
    }
    #[derive(Debug, serde::Deserialize)]
    struct HistoricalSettings {
        schema_version: u32,
        enabled: bool,
        secrets: bool,
        personal: bool,
        actions: std::collections::BTreeMap<String, HistoricalAction>,
        terms: Vec<String>,
        terms_any_case: bool,
        allow: Vec<String>,
    }
    for fixture in [
        include_str!("fixtures/privacy/settings-v0.json"),
        include_str!("fixtures/privacy/settings-v1.json"),
    ] {
        let current = PrivacySettings::parse(fixture)?;
        let written = serde_json::to_value(&current)?;
        let old: HistoricalSettings = serde_json::from_value(written.clone())?;
        assert_eq!(old.schema_version, current.schema_version);
        assert_eq!(
            (old.enabled, old.secrets, old.personal),
            (current.enabled, current.secrets, current.personal)
        );
        assert_eq!(
            (old.terms, old.terms_any_case, old.allow),
            (
                current.terms.clone(),
                current.terms_any_case,
                current.allow.clone()
            )
        );
        assert_eq!(old.actions.len(), current.actions.len());
        assert!(matches!(
            old.actions.get("EMAIL"),
            Some(HistoricalAction::Warn | HistoricalAction::Block)
        ));
        assert_eq!(PrivacySettings::parse(&written.to_string())?, current);
        let mut invalid = written;
        invalid["enabled"] = json!("true");
        assert!(serde_json::from_value::<HistoricalSettings>(invalid).is_err());
    }
    Ok(())
}

#[test]
fn colliding_historical_tokens_fail_without_rebinding() -> TestResult {
    // Precomputed HMAC collision using only the public synthetic test key.
    // No brute-force search, live credentials, or format changes in the test.
    let a = "collision-fixture-627830";
    let b = "collision-fixture-1222919";
    let masker = masker_with(PrivacySettings {
        terms: vec![a.into(), b.into()],
        ..PrivacySettings::default()
    })?;
    let tag_a = masker.inspect(a, None).record(Target::Llm).values[0]
        .tag
        .clone();
    let tag_b = masker.inspect(b, None).record(Target::Llm).values[0]
        .tag
        .clone();
    assert_eq!(tag_a, tag_b);
    let mut first = config(vec![user(a)]);
    masker.mask_request(&mut first)?;
    let mut second = config(vec![user(b)]);
    let error = masker
        .mask_request(&mut second)
        .err()
        .ok_or("accepted a colliding binding")?
        .to_string();
    assert!(error.contains("placeholder collision"));
    assert!(!error.contains(a) && !error.contains(b));
    assert_eq!(masker.restore_text(&tag_a, false), a);
    // The original mapping and normal noncolliding requests still work.
    masker.mask_request(&mut config(vec![user(a)]))?;
    Ok(())
}

#[test]
fn record_contract() -> TestResult {
    let dir = tempfile::tempdir()?;
    let today = chrono::Local::now().format("%Y-%m-%d");
    let lines = [
        // v0: no version, only required fields.
        r#"{"time":"2026-01-01T00:00:00Z","target":"sync","values":[{"kind":"EMAIL","by":"rule","action":"mask","tag":"{{EMAIL_aaaaaaaa}}","len":10,"n":2}]}"#,
        r#"{"v":1,"time":"2026-01-01T00:00:01Z","target":"llm","blocked":true,"values":[{"kind":"API_KEY","by":"known","action":"block","tag":"{{API_KEY_bbbbbbbb}}","head":"sk-","len":40,"n":1}]}"#,
        r#"{"v":99,"time":"x","target":"llm","future":true}"#,
        "torn line",
    ];
    std::fs::write(dir.path().join(format!("{today}.jsonl")), lines.join("\n"))?;
    let summary = summarize_records(dir.path(), 7)?;
    assert_eq!((summary.requests, summary.blocked), (2, 1));
    assert_eq!(summary.by_target[&Target::Sync].requests, 1);
    // Newest first; masked ones too, each saying what was found.
    let written = serde_json::to_value(&summary.recent[0])?;
    assert_eq!(written["kinds"], json!(["API_KEY"]));
    assert_eq!(written["blocked"], json!(true));
    assert_eq!(written["reason"], json!("contains API_KEY ×1"));
    let masked = serde_json::to_value(&summary.recent[1])?;
    assert_eq!(masked["blocked"], json!(false));
    assert_eq!(masked["reason"], json!("masked EMAIL ×2"));
    // Old lines have no origins; events built from them say so, not `null`.
    assert!(written.get("origins").is_none() && written.get("model").is_none());

    // A record written now still reads as the v1 shape a strict older reader
    // knows, with `origins` an extra it ignores.
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LegacyRecord {
        v: u32,
        time: String,
        target: Target,
        session: Option<String>,
        provider: Option<String>,
        model: Option<String>,
        blocked: bool,
        values: Vec<evot::privacy::ValueRecord>,
        #[serde(default)]
        origins: serde_json::Value,
    }
    let masker = masker()?;
    let mut config = self::config(vec![user(&format!("mail {EMAIL}"))]);
    let record = masker.mask_request(&mut config)?.record(Target::Llm);
    let line = serde_json::to_string(&record)?;
    let legacy: LegacyRecord = serde_json::from_str(&line)?;
    assert_eq!(
        (legacy.v, legacy.target, legacy.blocked),
        (1, Target::Llm, false)
    );
    assert_eq!(legacy.values.len(), 1);
    assert!(legacy.session.is_none() && legacy.provider.is_none() && legacy.model.is_none());
    assert_eq!(legacy.time, record.time);
    assert_eq!(legacy.origins[0]["at"], json!("user"));
    Ok(())
}

#[tokio::test]
async fn live_notices_report_each_record_as_it_is_made_without_values() -> TestResult {
    // No records directory: the live feed does not depend on the day files.
    let masker = Arc::new(masker()?);
    let echo = Arc::new(Echo {
        seen: Mutex::new(None),
    });
    let provider = MaskingProvider::with_masker(echo, masker);
    let (before, _) = evot::privacy::live_notices(0);
    let (tx, _rx) = mpsc::channel(16);
    provider
        .stream_bounded(
            config(vec![user(&format!("deploy with {API_KEY} for {EMAIL}"))]),
            tx,
            CancellationToken::new(),
        )
        .await?;
    let (cursor, notices) = evot::privacy::live_notices(before);
    assert!(cursor > before);
    // Other tests record concurrently; find ours.
    let notice = notices
        .iter()
        .find(|n| n.event.target == Target::Llm && n.event.kinds == ["API_KEY", "EMAIL"])
        .ok_or("no live notice for the masked request")?;
    assert!(!notice.event.blocked);
    assert_eq!(notice.event.reason, "masked API_KEY ×1 · EMAIL ×1");
    assert_eq!(notice.tags.len(), 2, "one placeholder tag per value");
    let text = serde_json::to_string(notice)?;
    assert!(
        !text.contains(API_KEY) && !text.contains(EMAIL),
        "notices never hold values"
    );
    assert!(
        text.contains("\"seq\"") && text.contains("\"target\":\"llm\""),
        "flattened event: {text}"
    );
    // Asking from the newest cursor yields nothing new.
    assert!(evot::privacy::live_notices(cursor).1.is_empty());
    Ok(())
}

#[test]
fn records_say_where_values_sat_and_which_rules_found_them_without_values() -> TestResult {
    let masker = masker()?;
    let call = Content::ToolCall {
        id: "call-1".into(),
        name: "Bash".into(),
        arguments: json!({
            "command": format!("ssh db0 'cat ~/.env'  # {API_KEY}\nsecond line"),
            "description": "Read the env file"
        }),
        metadata: None,
    };
    let mut config = config(vec![
        user(&format!("my key is {API_KEY}")),
        assistant(vec![call]),
        Message::ToolResult {
            tool_call_id: "call-1".into(),
            tool_name: "Bash".into(),
            content: vec![Content::Text {
                text: format!("TOKEN={API_KEY}\nMAIL={EMAIL}\n"),
            }],
            is_error: false,
            timestamp: 0,
            retention: Default::default(),
        },
    ]);
    config.system_prompt = format!("never print {EMAIL}");
    let report = masker.mask_request(&mut config)?;
    let mut record = report.record(Target::Llm);
    record.provider = Some("p".into());
    record.model = Some("m".into());

    // Every place, most first; the tool call's label names the call, by its
    // description rather than its command, and holds no value.
    let origins: Vec<(&str, Option<&str>, usize)> = record
        .origins
        .iter()
        .map(|o| (o.at.as_str(), o.label.as_deref(), o.n))
        .collect();
    assert_eq!(origins, vec![
        ("Bash result", Some("Read the env file"), 2),
        ("Bash call", Some("Read the env file"), 1),
        ("system prompt", None, 1),
        ("user", None, 1),
    ]);
    // Rules: distinct values per rule, most first. The `NAME=value` lines
    // of the result are values of their own (kind SECRET), so the
    // assignment rule has two and the bare key and email one each.
    let counted = record.rules();
    let rules: Vec<(&str, usize)> = counted
        .iter()
        .map(|r| (r.rule.as_str(), r.values))
        .collect();
    assert_eq!(rules, vec![
        ("core.file-assignment", 2),
        ("personal.email", 1),
        ("secrets.sk-key", 1)
    ]);
    let written = serde_json::to_string(&record)?;
    assert!(!written.contains(API_KEY) && !written.contains(EMAIL));
    assert!(written.contains("\"origins\""));

    // The live event carries the same, and old events without it still read.
    let event = serde_json::to_value(evot::privacy::Event::of(&record))?;
    assert_eq!(event["model"], json!("m"));
    assert_eq!(event["origins"][0]["at"], json!("Bash result"));
    assert_eq!(event["rules"].as_array().map(Vec::len), Some(3));
    let legacy: evot::privacy::Event = serde_json::from_str(
        r#"{"time":"t","target":"llm","blocked":false,"kinds":["EMAIL"],"reason":"masked EMAIL ×1"}"#,
    )?;
    assert!(legacy.origins.is_empty() && legacy.rules.is_empty() && legacy.model.is_none());

    // A command with no description is labelled by its first line, bounded.
    let mut config = self::config(vec![
        assistant(vec![Content::ToolCall {
            id: "call-2".into(),
            name: "Bash".into(),
            arguments: json!({ "command": format!("{}\nmore", "x".repeat(80)) }),
            metadata: None,
        }]),
        Message::ToolResult {
            tool_call_id: "call-2".into(),
            tool_name: "Bash".into(),
            content: vec![Content::Text {
                text: EMAIL.to_string(),
            }],
            is_error: false,
            timestamp: 0,
            retention: Default::default(),
        },
    ]);
    let record = masker.mask_request(&mut config)?.record(Target::Llm);
    let label = record.origins[0].label.as_deref().unwrap_or_default();
    assert_eq!(label.chars().count(), 61, "{label}");
    assert!(label.ends_with('…'));

    // Shell env setup and `cd … &&` are skipped so the label is the command.
    for (command, head) in [
        (
            "S=\"-o BatchMode=yes -o IdentityAgent=none\"; ssh $S db0-aws 'date; cat x' < /dev/null",
            "ssh $S db0-aws 'date; cat x' < /dev/null",
        ),
        ("cd /some/dir && cargo test -p evot", "cargo test -p evot"),
        ("FOO=1 BAR='a; b' make check", "make check"),
        ("cat ~/.ssh/id_ed25519", "cat ~/.ssh/id_ed25519"),
        ("/Users/x/github/proj/src/query/cache/manager.rs", "cache/manager.rs"),
        ("~/notes.md", "~/notes.md"),
        ("X=\"unterminated; ssh host", "X=\"unterminated; ssh host"),
    ] {
        let mut config = self::config(vec![
            assistant(vec![Content::ToolCall {
                id: "c".into(),
                name: "Bash".into(),
                arguments: json!({ "command": command }),
                metadata: None,
            }]),
            Message::ToolResult {
                tool_call_id: "c".into(),
                tool_name: "Bash".into(),
                content: vec![Content::Text {
                    text: EMAIL.to_string(),
                }],
                is_error: false,
                timestamp: 0,
                retention: Default::default(),
            },
        ]);
        let record = masker.mask_request(&mut config)?.record(Target::Llm);
        assert_eq!(record.origins[0].label.as_deref(), Some(head), "{command}");
    }

    // Uploads have no request shape, so no origins.
    let mut upload = json!({ "note": EMAIL });
    assert!(masker
        .scrub(&mut upload)?
        .record(Target::Share)
        .origins
        .is_empty());
    Ok(())
}

#[test]
fn session_tags_collect_a_sessions_placeholders_from_its_records() -> TestResult {
    let dir = tempfile::tempdir()?;
    let today = chrono::Local::now().format("%Y-%m-%d");
    let lines = [
        r#"{"v":1,"time":"t","target":"llm","session":"s1","values":[{"kind":"EMAIL","by":"rule","action":"mask","tag":"{{EMAIL_aaaaaaaa}}","len":10,"n":2}]}"#,
        r#"{"v":1,"time":"t","target":"llm","session":"s1","values":[{"kind":"EMAIL","by":"known","action":"mask","tag":"{{EMAIL_aaaaaaaa}}","len":10,"n":1},{"kind":"API_KEY","by":"rule","action":"mask","tag":"{{API_KEY_bbbbbbbb}}","len":40,"n":1}]}"#,
        r#"{"v":1,"time":"t","target":"llm","session":"s2","values":[{"kind":"PHONE","by":"rule","action":"mask","tag":"{{PHONE_cccccccc}}","len":11,"n":1}]}"#,
    ];
    std::fs::write(dir.path().join(format!("{today}.jsonl")), lines.join("\n"))?;
    let tags = evot::privacy::session_record_tags(dir.path(), "s1", 7)?;
    assert_eq!(tags, vec!["{{API_KEY_bbbbbbbb}}", "{{EMAIL_aaaaaaaa}}"]);
    assert!(evot::privacy::session_record_tags(dir.path(), "s3", 7)?.is_empty());
    Ok(())
}
