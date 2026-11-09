use evot::share::export_session;
use evot::types::SessionMeta;
use evot::types::TranscriptEntry;
use evot::types::TranscriptItem;
use serde_json::json;
use serde_json::Value;

fn row(seq: u64, item: Value) -> Result<TranscriptEntry, Box<dyn std::error::Error>> {
    Ok(TranscriptEntry {
        session_id: "session".into(),
        run_id: None,
        seq,
        turn: 1,
        item: serde_json::from_value(item)?,
        created_at: "2026-01-01T00:00:00Z".into(),
    })
}

#[test]
fn share_export_preserves_errors_tools_notices_and_order() -> Result<(), Box<dyn std::error::Error>>
{
    let meta = SessionMeta::new("session".into(), "/project".into(), "test-model".into());
    let rows = vec![
        row(1, json!({"type":"user", "text":"hello"}))?,
        row(
            2,
            json!({"type":"stats", "kind":"llm_call_started", "data":{"system_prompt":"instructions", "tool_definitions":[]}}),
        )?,
        row(
            3,
            json!({"type":"assistant", "content":[{"type":"thinking", "text":"reason"}, {"type":"tool_call", "id":"call", "name":"edit", "input":{"path":"file"}}], "stop_reason":"tool_use"}),
        )?,
        row(
            4,
            json!({"type":"tool_result", "tool_call_id":"call", "tool_name":"edit", "content":"ok", "is_error":false, "details":{"diff":"-old\n+new"}}),
        )?,
        row(
            5,
            json!({"type":"assistant", "content":[], "stop_reason":"error", "error_message":"Cannot resolve provider credential"}),
        )?,
        row(
            6,
            json!({"type":"stats", "kind":"ui_notice", "data":{"schema_version":1, "level":"error", "text":"Cannot reach server", "timestamp":123}}),
        )?,
    ];
    let share = export_session(&meta, &rows, "test");
    assert_eq!(share.schema_version, 1);
    assert_eq!(share.data["systemPrompt"], "instructions");
    // The viewer labels the project; the absolute path stays local.
    assert_eq!(share.data["header"]["cwd"], "project");
    let entries = share.data["entries"].as_array().ok_or("entries missing")?;
    assert_eq!(entries.len(), 5);
    assert_eq!(entries[1]["parentId"], "e1");
    assert_eq!(entries[1]["message"]["content"][1]["type"], "toolCall");
    assert_eq!(entries[2]["message"]["details"]["diff"], "-old\n+new");
    assert_eq!(
        entries[3]["message"]["errorMessage"],
        "Cannot resolve provider credential"
    );
    assert_eq!(entries[4]["customType"], "evot.error");
    assert_eq!(share.data["leafId"], "e6");
    Ok(())
}

#[test]
fn share_notice_uses_legacy_stats_envelope_and_never_enters_context(
) -> Result<(), Box<dyn std::error::Error>> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LegacyStats {
        r#type: String,
        kind: String,
        data: Value,
    }
    let item = TranscriptItem::Stats {
        kind: "ui_notice".into(),
        data: json!({"schema_version":1, "level":"system", "text":"notice", "timestamp":42}),
    };
    assert!(!item.is_context_item());
    let legacy: LegacyStats = serde_json::from_value(serde_json::to_value(&item)?)?;
    assert_eq!(legacy.r#type, "stats");
    assert_eq!(legacy.kind, "ui_notice");
    assert_eq!(legacy.data["text"], "notice");
    let notice: evot::share::ShareNotice =
        serde_json::from_str(include_str!("fixtures/schema/share-notice-v0.json"))?;
    assert_eq!(notice.schema_version, 0);
    Ok(())
}

#[test]
fn all_persisted_stats_have_a_safe_viewer_projection() -> Result<(), Box<dyn std::error::Error>> {
    let items: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/schema/share-stats-v1.json"))?;
    let rows = items
        .into_iter()
        .enumerate()
        .map(|(i, item)| row(i as u64 + 1, item))
        .collect::<Result<Vec<_>, _>>()?;
    let mut meta = SessionMeta::new("session".into(), "/project".into(), "latest".into());
    meta.thinking_level = Some("max".into());
    let share = export_session(&meta, &rows, "test");
    let entries = share.data["entries"].as_array().ok_or("missing entries")?;
    let levels: Vec<_> = entries
        .iter()
        .filter(|entry| entry["type"] == "thinking_level_change")
        .map(|entry| entry["thinkingLevel"].clone())
        .collect();
    assert_eq!(levels, vec![json!("low"), json!("high")]);
    assert_eq!(
        entries
            .iter()
            .filter(|e| e["customType"] == "evot.llm_retry")
            .count(),
        1
    );
    assert_eq!(
        entries
            .iter()
            .filter(|e| e["message"]["stopReason"] == "error")
            .count(),
        1
    );
    assert_eq!(
        entries
            .iter()
            .filter(|e| e["customType"] == "evot.warning")
            .count(),
        1
    );
    assert!(entries.iter().any(|e| e["customType"] == "evot.tool"
        && e["content"].as_str().is_some_and(|s| s.contains("123ms"))));
    assert_eq!(
        entries.iter().filter(|e| e["type"] == "compaction").count(),
        1
    );
    assert!(entries.iter().any(|e| e["summary"]
        .as_str()
        .is_some_and(|s| s.contains("10000 → 2000 tokens") && s.contains("remote timeout"))));
    assert!(entries
        .iter()
        .any(|e| e["content"] == "✳ Ran for 1m 1s · 2 turns"));
    assert!(!serde_json::to_string(&share)?.contains("DO_NOT_EXPORT"));
    let mut previous = Value::Null;
    for entry in entries {
        assert_eq!(entry["parentId"], previous);
        previous = entry["id"].clone();
    }
    assert_eq!(share.data["leafId"], previous);
    Ok(())
}

#[test]
fn legacy_settings_and_current_stats_contracts_remain_readable(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut meta = SessionMeta::new("session".into(), "/project".into(), "latest".into());
    meta.thinking_level = Some("high".into());
    let legacy = vec![row(1, json!({"type":"user","text":"hello"}))?];
    assert_eq!(
        export_session(&meta, &legacy, "test").data["entries"][0]["thinkingLevel"],
        "high"
    );
    let old: evot::observability::LlmCallStartedStats = serde_json::from_value(json!({
        "turn":0,"attempt":0,"model":"m","message_count":1,"message_bytes":10,"system_prompt_tokens":1
    }))?;
    assert!(old.thinking_level.is_empty());
    // Strict legacy envelope still accepts today's stats; its payload is opaque.
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Legacy {
        r#type: String,
        kind: String,
        data: Value,
    }
    let current = evot::observability::TranscriptStats::LlmCallStarted(
        evot::observability::LlmCallStartedStats {
            thinking_level: "high".into(),
            ..old
        },
    )
    .to_item();
    let decoded: Legacy = serde_json::from_value(serde_json::to_value(current)?)?;
    assert_eq!(decoded.r#type, "stats");
    assert_eq!(decoded.kind, "llm_call_started");
    assert_eq!(decoded.data["thinking_level"], "high");
    Ok(())
}

#[test]
fn final_settings_never_rewrite_initial_history() -> Result<(), Box<dyn std::error::Error>> {
    let mut meta = SessionMeta::new("session".into(), "/p".into(), "latest".into());
    meta.provider = "new-provider".into();
    meta.thinking_level = Some("max".into());
    let rows = vec![
        row(
            1,
            json!({"type":"stats","kind":"model_change","data":{
                "from_provider":"old-provider","from_model":"earliest","to_provider":"new-provider","to_model":"latest"
            }}),
        )?,
        row(
            2,
            json!({"type":"stats","kind":"thinking_level_change","data":{"thinking_level":"high"}}),
        )?,
    ];
    let share = export_session(&meta, &rows, "test");
    assert_eq!(share.data["entries"][0]["modelId"], "earliest");
    assert_eq!(share.data["entries"][1]["modelId"], "latest");
    assert_eq!(share.data["entries"][2]["thinkingLevel"], "high");
    Ok(())
}

#[tokio::test]
async fn structured_settings_persist_without_entering_context(
) -> Result<(), Box<dyn std::error::Error>> {
    let storage: std::sync::Arc<dyn evot::storage::Storage> =
        std::sync::Arc::new(evot::storage::MemoryStorage::new());
    let session = evot::sessions::Session::new(
        "structured".into(),
        "/p".into(),
        "m".into(),
        storage.clone(),
    )
    .await?;
    let events = serde_json::from_value(json!([
        {"schema_version":1,"level":"system","text":"任意文案","timestamp":1,"kind":"thinking_level_change","data":{"thinking_level":"high"}},
        {"schema_version":1,"level":"system","text":"arbitrary","timestamp":2,"kind":"model_change","data":{"provider":"p","model":"m2"}},
        {"schema_version":1,"level":"system","text":"invalid","timestamp":3,"kind":"thinking_level_change","data":{"thinking_level":"invalid"}}
    ]))?;
    evot::share::record_notices(storage, "structured", events).await?;
    let rows = session.load_all_entries().await?;
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| !row.item.is_context_item()));
    let share = export_session(&session.meta().await, &rows, "test");
    assert_eq!(share.data["entries"][0]["thinkingLevel"], "high");
    assert_eq!(share.data["entries"][1]["modelId"], "m2");
    Ok(())
}

fn notice(schema_version: u32, level: &str, text: &str) -> evot::share::ShareNotice {
    evot::share::ShareNotice {
        schema_version,
        level: level.into(),
        text: text.into(),
        timestamp: 1,
        kind: None,
        data: Value::Null,
    }
}

/// A batch is all-or-nothing to its caller: `/share` refuses to upload when
/// notices fail to persist. So an unrepresentable notice must be dropped, never
/// escalated into a failure that blocks the share.
#[tokio::test]
async fn unsupported_notices_are_skipped_without_failing_the_batch(
) -> Result<(), Box<dyn std::error::Error>> {
    let storage: std::sync::Arc<dyn evot::storage::Storage> =
        std::sync::Arc::new(evot::storage::MemoryStorage::new());
    let session = evot::sessions::Session::new(
        "notice-session".into(),
        "/project".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    evot::share::record_notices(storage.clone(), "notice-session", vec![
        notice(1, "error", "kept"),
        notice(1, "debug", "unknown level"),
        notice(9, "system", "newer schema"),
        notice(0, "cancelled", "legacy version kept"),
    ])
    .await?;

    let stored: Vec<String> = session
        .load_all_entries()
        .await?
        .into_iter()
        .filter_map(|entry| match entry.item {
            TranscriptItem::Stats { kind, data } if kind == "ui_notice" => {
                Some(data["text"].as_str().unwrap_or_default().to_owned())
            }
            _ => None,
        })
        .collect();
    assert_eq!(stored, vec!["kept", "legacy version kept"]);

    // Nothing representable left: no session write, and still not an error.
    evot::share::record_notices(storage, "notice-session", vec![notice(
        1, "debug", "dropped",
    )])
    .await?;
    assert_eq!(session.load_all_entries().await?.len(), 2);
    Ok(())
}

#[test]
fn share_export_ignores_retired_pruning_diagnostics() -> Result<(), Box<dyn std::error::Error>> {
    let meta = SessionMeta::new("session".into(), "/project".into(), "test-model".into());
    let rows = vec![
        row(1, json!({"type":"user", "text":"hello"}))?,
        // Verdicts only: bookkeeping, not shown.
        row(
            2,
            json!({"type":"stats", "kind":"context_pruned", "data":{
                "decided":{"verdicts":[], "context_tokens":100, "pending_tokens":50, "requests":1, "elapsed_ms":3},
                "applied":null, "context_window":200000}}),
        )?,
        row(
            3,
            json!({"type":"stats", "kind":"context_pruned", "data":{
                "decided":{"verdicts":[], "context_tokens":26000, "pending_tokens":0, "requests":2, "elapsed_ms":900,
                    "user_requests":[
                        {"message_index":0, "text":"hi", "probability":0.05, "in_play":false},
                        {"message_index":6, "text":"analyse   whether jev\nscores persist", "probability":0.9, "in_play":true},
                        {"message_index":10, "text":"what triggers a prune?", "probability":null, "in_play":true}
                    ]},
                "applied":{"removed":1, "truncated":11, "skipped":0, "before_tokens":26000, "after_tokens":11000,
                    "before_messages":40, "after_messages":39, "trigger":"savings"},
                "context_window":200000}}),
        )?,
        // Legacy shape without user_requests still renders.
        row(
            4,
            json!({"type":"stats", "kind":"context_pruned", "data":{
                "applied":{"removed":2, "truncated":0, "skipped":0, "before_tokens":900, "after_tokens":400,
                    "before_messages":10, "after_messages":8, "trigger":"cold_cache"}}}),
        )?,
    ];
    let share = export_session(&meta, &rows, "test");
    let entries = share.data["entries"].as_array().ok_or("entries missing")?;
    assert_eq!(entries.len(), 1, "only conversation content is exported");
    Ok(())
}
