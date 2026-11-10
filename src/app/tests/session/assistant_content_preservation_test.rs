use evot::conf::StorageConfig;
use evot::session::conversation::convert::agent_message_from_transcript;
use evot::session::conversation::convert::transcript_from_agent_message;
use evot::session::storage::open_storage;
use evot::types::ListTranscriptEntries;
use evot::types::SessionMeta;
use evot::types::TranscriptEntry;
use evot_engine::AgentMessage;
use evot_engine::Content;
use evot_engine::Message;
use evot_engine::StopReason;
use evot_engine::Usage;
use tempfile::TempDir;

#[tokio::test]
async fn assistant_content_preservation_through_conversion_and_storage(
) -> Result<(), Box<dyn std::error::Error>> {
    let root = TempDir::new()?;
    let config = StorageConfig::fs(root.path().to_path_buf());
    let storage = open_storage(&config)?;
    let session_id = "assistant-content-preservation";
    storage
        .save_session(SessionMeta::new(
            session_id.into(),
            "/tmp".into(),
            "test-model".into(),
        ))
        .await?;

    let cases = [
        "1. `<system-reminder>` is a tag name.\nThe rest of the answer.",
        "| # | content |\n|---|---|\n| 0 | `<system>` |\nThe rest of the answer.",
        "```xml\n<system>example</system>\n<system-reminder>literal</system-reminder>\n```\nConclusion.",
        "  Continue: preserve whitespace and this prefix.\n  ",
    ];
    let mut originals = Vec::new();
    for (index, text) in cases.iter().enumerate() {
        let message = AgentMessage::Llm(Message::Assistant {
            content: vec![Content::Text {
                text: (*text).into(),
            }],
            stop_reason: StopReason::Stop,
            model: "test-model".into(),
            provider: "test-provider".into(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        });
        let item = transcript_from_agent_message(&message);
        assert_eq!(agent_message_from_transcript(&item), message);
        storage
            .append_entry(TranscriptEntry::new(
                session_id.into(),
                None,
                (index + 1) as u64,
                1,
                item,
            ))
            .await?;
        originals.push(message);
    }
    drop(storage);

    let reopened = open_storage(&config)?;
    let entries = reopened
        .list_entries(ListTranscriptEntries {
            session_id: session_id.into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(entries.len(), originals.len());
    for (entry, original) in entries.iter().zip(&originals) {
        assert_eq!(&agent_message_from_transcript(&entry.item), original);
    }
    Ok(())
}
