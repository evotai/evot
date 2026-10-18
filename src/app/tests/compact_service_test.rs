use std::sync::Arc;

use evot::compact::orchestrator::CompactSettings;
use evot::compact::orchestrator::ManualCompactRequest;
use evot::compact::orchestrator::ManualCompactionOutcome;
use evot::compact::service::compact;
use evot::sessions::Session;
use evot::storage::MemoryStorage;
use evot::types::AssistantBlock;
use evot::types::CompactReason;
use evot::types::TranscriptItem;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn request() -> ManualCompactRequest {
    ManualCompactRequest {
        reason: CompactReason::Manual,
        custom_instructions: None,
        summary_override: Some("deterministic service fixture".into()),
        summarizer: None,
        settings: CompactSettings {
            keep_recent_tokens: 16,
            context_window: 8192,
        },
        observer: None,
    }
}

#[tokio::test]
async fn compact_service_noop_still_saves_session_metadata() -> TestResult {
    let storage = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "service-noop".into(),
        "/tmp".into(),
        "fixture".into(),
        storage.clone(),
    )
    .await?;
    session.set_thinking_level(Some("low".into())).await;
    let outcome = compact(&session, request(), CancellationToken::new()).await?;
    assert!(matches!(outcome, ManualCompactionOutcome::NothingToCompact));
    let reopened = Session::open("service-noop", storage)
        .await?
        .ok_or("missing session")?;
    assert_eq!(reopened.meta().await.thinking_level.as_deref(), Some("low"));
    assert!(reopened.load_all_entries().await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn compact_service_cancelled_does_not_save_or_mutate_context() -> TestResult {
    let storage = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "service-cancel".into(),
        "/tmp".into(),
        "fixture".into(),
        storage.clone(),
    )
    .await?;
    let before = session.context_snapshot().await;
    session.set_thinking_level(Some("low".into())).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let outcome = compact(&session, request(), cancel).await?;
    assert!(matches!(outcome, ManualCompactionOutcome::Cancelled));
    assert_eq!(session.context_snapshot().await.2, before.2);
    let reopened = Session::open("service-cancel", storage)
        .await?
        .ok_or("missing session")?;
    assert!(reopened.meta().await.thinking_level.is_none());
    assert!(reopened.load_all_entries().await?.is_empty());
    Ok(())
}

#[tokio::test]
async fn compact_service_outcome_matches_persisted_marker() -> TestResult {
    let storage = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "service-compact".into(),
        "/tmp".into(),
        "fixture".into(),
        storage.clone(),
    )
    .await?;
    let mut items = Vec::new();
    for index in 0..6 {
        items.push(TranscriptItem::User {
            provenance: None,
            text: format!("request {index} {}", "fixture context ".repeat(100)),
            content: vec![],
        });
        items.push(TranscriptItem::Assistant {
            content: vec![AssistantBlock::Text {
                text: format!("answer {index}"),
            }],
            stop_reason: "stop".into(),
            usage: Default::default(),
            model: "fixture".into(),
            provider: "fixture".into(),
            timestamp: 0,
            error_message: None,
        });
    }
    session.write_items(items).await?;
    let outcome = compact(&session, request(), CancellationToken::new()).await?;
    let written = serde_json::to_value(&outcome)?;
    let reopened = Session::open("service-compact", storage)
        .await?
        .ok_or("missing session")?;
    let entries = reopened.load_all_entries().await?;
    let marker = entries
        .iter()
        .find_map(|entry| match &entry.item {
            TranscriptItem::Compact {
                summary,
                tokens_before,
                tokens_after,
                messages_before,
                messages_after,
                details,
                ..
            } => Some((
                summary,
                tokens_before,
                tokens_after,
                messages_before,
                messages_after,
                details,
            )),
            _ => None,
        })
        .ok_or("missing compact marker")?;
    assert_eq!(written["status"], "compacted");
    assert_eq!(written["summary"], marker.0.as_str());
    assert_eq!(written["tokens_before"], *marker.1);
    assert_eq!(written["tokens_after"], *marker.2);
    assert_eq!(written["messages_before"], *marker.3);
    assert_eq!(written["messages_after"], *marker.4);
    assert_eq!(
        written["messages_evicted"],
        marker.3.saturating_sub(*marker.4).saturating_add(1)
    );
    assert_eq!(written["context_window"], 8192);
    assert_eq!(written["current_run_reclaimed"], 0);
    assert_eq!(written["compaction_level"], 3);
    assert_eq!(written["method"], serde_json::to_value(marker.5.method)?);
    assert_eq!(
        written["remote_blob_bytes"],
        serde_json::to_value(marker.5.remote_blob_bytes)?
    );
    assert_eq!(
        written["fallback_reason"],
        serde_json::to_value(&marker.5.fallback_reason)?
    );
    Ok(())
}
