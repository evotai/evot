use evot::conversation::convert::agent_message_from_transcript;
use evot::conversation::convert::transcript_from_agent_message;
use evot::conversation::input::authored_text;
use evot::conversation::input::display_parts;
use evot::conversation::input::transcript_views;
use evot::conversation::input::PreparedInput;
use evot::types::TranscriptItem;
use evot_engine::AgentMessage;
use evot_engine::Content;
use evot_engine::InputProvenance;
use evot_engine::InputSource;
use evot_engine::Message;

type TestResult = Result<(), Box<dyn std::error::Error>>;
const LEGACY: &str = include_str!("fixtures/schema/user-input-v0.json");
const CURRENT: &str = include_str!("fixtures/schema/user-input-v1.json");

#[test]
fn input_provenance_is_recorded_before_runtime_attachments_without_text_matching() -> TestResult {
    let authored = "Explain <system-reminder> literally";
    let mut input = PreparedInput::user(vec![
        Content::Text {
            text: authored.into(),
        },
        Content::Text { text: " ".into() },
    ]);
    input.runtime(
        "Any text, in any language, not an XML envelope.".into(),
        "arbitrary_context",
        Some("Context added".into()),
    );
    let (content, provenance) = input.finish();
    let provenance = provenance.ok_or("missing provenance")?;
    assert_eq!(provenance.sources.len(), 2);
    assert_eq!(provenance.sources[0], InputSource::User);
    let engine = AgentMessage::Llm(Message::User {
        content: content.clone(),
        provenance: Some(provenance),
        timestamp: 0,
    });
    let item = transcript_from_agent_message(&engine);
    assert_eq!(authored_text(&item).as_deref(), Some(authored));
    let projected = serde_json::to_value(display_parts(&item))?;
    assert_eq!(projected[0]["text"], authored);
    assert_eq!(projected[1]["kind"], "notice");
    let replay = agent_message_from_transcript(&item);
    assert_eq!(replay, engine);
    assert!(
        matches!(&replay, AgentMessage::Llm(Message::User { content: restored, .. }) if restored == &content)
    );
    Ok(())
}

#[test]
fn current_and_legacy_input_contracts_keep_the_original_model_content() -> TestResult {
    #[derive(serde::Deserialize)]
    struct LegacyUser {
        #[serde(rename = "type")]
        kind: String,
        text: String,
        content: Vec<evot::types::TranscriptUserContent>,
    }
    for (fixture, expected) in [
        (
            LEGACY,
            include_str!("fixtures/schema/user-input-view-v0.json"),
        ),
        (
            CURRENT,
            include_str!("fixtures/schema/user-input-view-v1.json"),
        ),
    ] {
        let item: TranscriptItem = serde_json::from_str(fixture)?;
        assert_eq!(authored_text(&item).as_deref(), Some("Commit"));
        let serialized = serde_json::to_string(&item)?;
        let legacy: LegacyUser = serde_json::from_str(&serialized)?;
        assert_eq!(legacy.kind, "user");
        assert!(legacy.text.contains("Commit\n"));
        let original: serde_json::Value = serde_json::from_str(fixture)?;
        assert_eq!(
            Some(legacy.content.len()),
            original["content"].as_array().map(Vec::len)
        );
        let view = serde_json::to_value(transcript_views(std::slice::from_ref(&item)))?;
        assert_eq!(
            view[0],
            serde_json::from_str::<serde_json::Value>(expected)?
        );
        assert_eq!(view[0]["text"], legacy.text);
        assert_eq!(view[0]["display_parts"][0]["text"], "Commit");
        let old_addon_reader: TranscriptItem = serde_json::from_value(view[0].clone())?;
        assert_eq!(
            serde_json::to_value(old_addon_reader)?,
            serde_json::to_value(item)?
        );
    }
    Ok(())
}

#[test]
fn legacy_migration_uses_trailing_protocol_boundaries_not_english_wording_or_inline_xml(
) -> TestResult {
    for tag in ["system-reminder", "task-notification"] {
        let body = format!("<{tag}>\nDifferent runtime payload.\n</{tag}>");
        let item: TranscriptItem = serde_json::from_value(serde_json::json!({
            "type":"user", "text":format!("Commit\n{body}"),
            "content":[{"type":"text","text":"Commit"},{"type":"text","text":body}],
        }))?;
        assert_eq!(authored_text(&item).as_deref(), Some("Commit"));
        let mut literal = PreparedInput::user(vec![
            Content::Text {
                text: "Commit".into(),
            },
            Content::Text { text: body.clone() },
        ]);
        literal.runtime("Attached internal context".into(), "context", None);
        let (content, provenance) = literal.finish();
        let item = transcript_from_agent_message(&AgentMessage::Llm(Message::User {
            content,
            provenance,
            timestamp: 0,
        }));
        assert_eq!(authored_text(&item), Some(format!("Commit\n{body}")));
        // A legacy single text block is ambiguous and must stay intact.
        let single: TranscriptItem = serde_json::from_value(
            serde_json::json!({"type":"user","text":body,"content":[{"type":"text","text":body}]}),
        )?;
        assert_eq!(authored_text(&single), Some(body.clone()));
        // Older compaction flattened adjacent text blocks into one carrier.
        let flattened: TranscriptItem = serde_json::from_value(serde_json::json!({
            "type":"user", "text":format!("Commit\n{body}"),
            "content":[{"type":"text","text":format!("Commit\n{body}")}],
        }))?;
        assert_eq!(authored_text(&flattened).as_deref(), Some("Commit"));
        let quoted: TranscriptItem = serde_json::from_value(serde_json::json!({
            "type":"user", "text":format!("Explain this code:\n```xml\n{body}"),
        }))?;
        assert_eq!(authored_text(&quoted), quoted.as_user_text());
    }
    Ok(())
}

#[test]
fn explicit_user_sources_preserve_xml_code_examples_and_unknown_runtime_sources_are_not_user_intent(
) -> TestResult {
    let text = "```xml\n<system-reminder>\nUser example\n</system-reminder>\n```";
    let mut input = PreparedInput::user(vec![Content::Text { text: text.into() }]);
    input.runtime(
        "A future producer's payload".into(),
        "new_future_kind",
        None,
    );
    let (content, provenance) = input.finish();
    let item = transcript_from_agent_message(&AgentMessage::Llm(Message::User {
        content,
        provenance,
        timestamp: 0,
    }));
    assert_eq!(authored_text(&item).as_deref(), Some(text));
    let serialized = serde_json::to_value(display_parts(&item))?;
    assert_eq!(serialized.as_array().map(Vec::len), Some(1));
    let nodes = evot::conversation::chat_projection::replay_nodes(&[item]);
    assert_eq!(nodes[0].text.as_deref(), Some(text));
    Ok(())
}

#[test]
fn input_provenance_has_an_independent_version_and_rejects_future_schemas() -> TestResult {
    let v0: InputProvenance = serde_json::from_str(r#"{"sources":[{"source":"user"}]}"#)?;
    assert_eq!(v0.schema_version, 0);
    let v1: InputProvenance = serde_json::from_str(
        r#"{"schema_version":1,"sources":[{"source":"runtime","kind":"context"}]}"#,
    )?;
    assert_eq!(v1.schema_version, 1);
    let future = serde_json::from_str::<InputProvenance>(r#"{"schema_version":2,"sources":[]}"#);
    assert!(
        matches!(future, Err(error) if error.to_string().contains("unsupported input provenance schema version 2"))
    );
    Ok(())
}
