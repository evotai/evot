use evot::conf::StorageConfig;
use evot::observability::UsageSummary;
use evot::storage::open_storage;
use evot::types::*;
use tempfile::TempDir;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn open_storage_returns_working_backend() -> TestResult {
    let root = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;

    let session_meta = SessionMeta::new(
        "sess-backend".into(),
        "/tmp".into(),
        "claude-sonnet-4-20250514".into(),
    );
    storage.save_session(session_meta).await?;
    assert!(storage.get_session("sess-backend").await?.is_some());

    storage
        .append_entry(TranscriptEntry::new(
            "sess-backend".into(),
            None,
            1,
            0,
            TranscriptItem::User {
                text: "hello".into(),
                content: vec![],
            },
        ))
        .await?;
    storage
        .append_entry(TranscriptEntry::new(
            "sess-backend".into(),
            None,
            2,
            0,
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text { text: "hi".into() }],
                stop_reason: "stop".into(),
                usage: UsageSummary::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
        ))
        .await?;

    let loaded = storage
        .list_entries(ListTranscriptEntries {
            session_id: "sess-backend".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(loaded.len(), 2);
    Ok(())
}

#[tokio::test]
async fn list_sessions_uses_transcript_activity_for_running_sessions() -> TestResult {
    let root = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;

    let mut running = SessionMeta::new("sess-running".into(), "/work".into(), "model".into());
    running.created_at = "2026-01-01T00:00:00Z".into();
    running.updated_at = "2026-01-01T00:00:00Z".into();
    storage.save_session(running).await?;

    let mut idle = SessionMeta::new("sess-idle".into(), "/work".into(), "model".into());
    idle.created_at = "2026-01-02T00:00:00Z".into();
    idle.updated_at = "2026-01-02T00:00:00Z".into();
    storage.save_session(idle).await?;

    storage
        .append_entry(TranscriptEntry::new(
            "sess-running".into(),
            None,
            1,
            1,
            TranscriptItem::User {
                text: "still active".into(),
                content: vec![],
            },
        ))
        .await?;

    let sessions = storage
        .list_sessions(ListSessions {
            limit: 0,
            offset: 0,
        })
        .await?;
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].session_id, "sess-running");
    assert!(sessions[0].updated_at > sessions[1].updated_at);
    Ok(())
}

#[tokio::test]
async fn list_sessions_handles_missing_and_invalid_roots() -> TestResult {
    let root = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    assert!(storage
        .list_sessions(ListSessions::default())
        .await?
        .is_empty());
    std::fs::write(root.path().join("sessions"), b"not a directory")?;
    assert!(storage
        .list_sessions(ListSessions::default())
        .await
        .is_err());
    Ok(())
}

#[tokio::test]
async fn list_sessions_preserves_tolerance_ordering_and_pagination() -> TestResult {
    let root = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    for (id, updated_at) in [
        ("sess-old", "2020-01-01T00:00:00Z"),
        ("sess-middle", "2021-01-01T00:00:00Z"),
        ("sess-new", "2022-01-01T00:00:00Z"),
    ] {
        let mut session = SessionMeta::new(id.into(), "/work".into(), "model".into());
        session.updated_at = updated_at.into();
        storage.save_session(session).await?;
    }
    let sessions_dir = root.path().join("sessions");
    std::fs::write(sessions_dir.join(".DS_Store"), b"ignored")?;
    for id in ["sess-missing", "sess-malformed", "sess-unreadable"] {
        std::fs::create_dir(sessions_dir.join(id))?;
    }
    std::fs::write(sessions_dir.join("sess-malformed/session.json"), b"{broken")?;
    std::fs::create_dir(sessions_dir.join("sess-unreadable/session.json"))?;

    let all = storage.list_sessions(ListSessions::default()).await?;
    assert_eq!(
        all.iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        ["sess-new", "sess-middle", "sess-old"]
    );
    let page = storage
        .list_sessions(ListSessions {
            limit: 1,
            offset: 1,
        })
        .await?;
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].session_id, "sess-middle");
    let tail = storage
        .list_sessions(ListSessions {
            limit: 0,
            offset: 2,
        })
        .await?;
    assert_eq!(tail.len(), 1);
    assert_eq!(tail[0].session_id, "sess-old");
    assert!(storage
        .list_sessions(ListSessions {
            limit: 20,
            offset: 10
        })
        .await?
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn list_sessions_activity_does_not_override_newer_saved_time() -> TestResult {
    let root = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    for (id, updated_at) in [
        ("sess-future", "2099-01-01T00:00:00Z"),
        ("sess-invalid", "invalid timestamp"),
    ] {
        let mut session = SessionMeta::new(id.into(), "/work".into(), "model".into());
        session.updated_at = updated_at.into();
        storage.save_session(session).await?;
        std::fs::write(
            root.path()
                .join("sessions")
                .join(id)
                .join("transcript.jsonl"),
            b"[]\n",
        )?;
    }
    let all = storage.list_sessions(ListSessions::default()).await?;
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].session_id, "sess-future");
    assert_eq!(all[0].updated_at, "2099-01-01T00:00:00Z");
    assert_eq!(all[1].session_id, "sess-invalid");
    assert!(chrono::DateTime::parse_from_rfc3339(&all[1].updated_at).is_ok());
    // Listing adjusts only the returned metadata, not the stored contract.
    let saved = storage
        .get_session("sess-invalid")
        .await?
        .ok_or("missing session")?;
    assert_eq!(saved.updated_at, "invalid timestamp");
    Ok(())
}

#[tokio::test]
async fn unsupported_transcript_format_returns_clear_error() -> TestResult {
    let root = TempDir::new()?;
    let session_id = "sess-unsupported";
    let session_dir = root.path().join("sessions").join(session_id);
    std::fs::create_dir_all(&session_dir)?;
    let transcript_path = session_dir.join("transcript.jsonl");
    let original = br#"{"session_id":"sess-unsupported","seq":1}"#;
    std::fs::write(&transcript_path, original)?;

    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    let error = storage
        .list_entries(ListTranscriptEntries {
            session_id: session_id.into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await
        .expect_err("invalid legacy data must be rejected");
    assert!(error.to_string().contains("unsupported transcript"));
    assert_eq!(std::fs::read(&transcript_path)?, original);
    Ok(())
}

#[tokio::test]
async fn legacy_object_lines_are_migrated_before_append() -> TestResult {
    let root = TempDir::new()?;
    let session_id = "sess-legacy-append";
    let session_dir = root.path().join("sessions").join(session_id);
    std::fs::create_dir_all(&session_dir)?;
    let transcript_path = session_dir.join("transcript.jsonl");
    let legacy = serde_json::json!({
        "session_id": session_id,
        "run_id": null,
        "seq": 41,
        "turn": 0,
        "item": { "type": "user", "text": "old" },
        "created_at": "2026-04-23T07:10:18Z"
    })
    .to_string();
    std::fs::write(&transcript_path, legacy)?;

    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    let loaded = storage
        .list_entries(ListTranscriptEntries {
            session_id: session_id.into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].seq, 1);
    assert!(session_dir.join("transcript.jsonl.v1.bak").exists());

    storage
        .append_entry(TranscriptEntry::new(
            session_id.into(),
            None,
            2,
            0,
            TranscriptItem::User {
                text: "new".into(),
                content: vec![],
            },
        ))
        .await?;
    let loaded = storage
        .list_entries(ListTranscriptEntries {
            session_id: session_id.into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(
        loaded.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
        vec![1, 2]
    );
    Ok(())
}

#[tokio::test]
async fn load_active_entries_starts_at_latest_control_without_decoding_large_prefix() -> TestResult
{
    let root = TempDir::new()?;
    let session_id = "sess-active-tail";
    let session_dir = root.path().join("sessions").join(session_id);
    std::fs::create_dir_all(&session_dir)?;
    let transcript_path = session_dir.join("transcript.jsonl");

    let obsolete = TranscriptEntry::new(session_id.into(), None, 1, 0, TranscriptItem::User {
        text: "x".repeat(2 * 1024 * 1024),
        content: vec![],
    });
    let control = TranscriptEntry::new(session_id.into(), None, 2, 0, TranscriptItem::Marker {
        kind: MarkerKind::Clear,
        messages: vec![],
    });
    let tail = TranscriptEntry::new(session_id.into(), None, 3, 0, TranscriptItem::User {
        text: "active".into(),
        content: vec![],
    });
    let mut bytes = serde_json::to_vec(&vec![obsolete])?;
    bytes.push(b'\n');
    bytes.extend(serde_json::to_vec(&vec![control, tail])?);
    bytes.push(b'\n');
    std::fs::write(&transcript_path, bytes)?;

    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    let active = storage.load_active_entries(session_id).await?;

    assert_eq!(
        active.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
        vec![2, 3]
    );
    Ok(())
}

#[tokio::test]
async fn compare_and_append_rejects_non_contiguous_first_sequence() -> TestResult {
    let root = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    let accepted = storage
        .compare_and_append_entries(0, vec![TranscriptEntry::new(
            "sess-bad-first-seq".into(),
            None,
            2,
            0,
            TranscriptItem::User {
                text: "must not persist".into(),
                content: vec![],
            },
        )])
        .await?;
    assert!(!accepted);
    let entries = storage
        .list_entries(ListTranscriptEntries {
            session_id: "sess-bad-first-seq".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert!(entries.is_empty());
    Ok(())
}

#[tokio::test]
async fn append_to_large_current_transcript_uses_tail_sequence() -> TestResult {
    let root = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    let session_id = "sess-large-append";
    storage
        .save_session(SessionMeta::new(
            session_id.into(),
            "/tmp".into(),
            "model".into(),
        ))
        .await?;

    let session_dir = root.path().join("sessions").join(session_id);
    let transcript_path = session_dir.join("transcript.jsonl");
    let first = TranscriptEntry::new(session_id.into(), None, 1, 0, TranscriptItem::User {
        text: "x".repeat(2 * 1024 * 1024),
        content: vec![],
    });
    let mut bytes = serde_json::to_vec(&vec![first])?;
    bytes.push(b'\n');
    std::fs::write(&transcript_path, bytes)?;

    let accepted = storage
        .compare_and_append_entries(1, vec![TranscriptEntry::new(
            session_id.into(),
            None,
            2,
            0,
            TranscriptItem::User {
                text: "tail".into(),
                content: vec![],
            },
        )])
        .await?;

    assert!(accepted);
    let tail = std::fs::read_to_string(&transcript_path)?
        .lines()
        .next_back()
        .ok_or_else(|| std::io::Error::other("missing appended batch"))?
        .to_string();
    let batch: Vec<TranscriptEntry> = serde_json::from_str(&tail)?;
    assert_eq!(batch.last().map(|entry| entry.seq), Some(2));
    Ok(())
}

#[tokio::test]
async fn append_repairs_interrupted_tail_before_writing_next_batch() -> TestResult {
    let root = TempDir::new()?;
    let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
    let session_id = "sess-tail-repair";
    storage
        .save_session(SessionMeta::new(
            session_id.into(),
            "/tmp".into(),
            "model".into(),
        ))
        .await?;
    storage
        .append_entry(TranscriptEntry::new(
            session_id.into(),
            None,
            1,
            0,
            TranscriptItem::User {
                text: "before crash".into(),
                content: vec![],
            },
        ))
        .await?;

    let transcript_path = root
        .path()
        .join("sessions")
        .join(session_id)
        .join("transcript.jsonl");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&transcript_path)?;
    file.write_all(b"[{\"interrupted\":")?;
    drop(file);

    storage
        .append_entry(TranscriptEntry::new(
            session_id.into(),
            None,
            2,
            0,
            TranscriptItem::User {
                text: "after recovery".into(),
                content: vec![],
            },
        ))
        .await?;

    let entries = storage
        .list_entries(ListTranscriptEntries {
            session_id: session_id.into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].seq, 1);
    assert_eq!(entries[1].seq, 2);
    assert!(matches!(
        &entries[1].item,
        TranscriptItem::User { text, .. } if text == "after recovery"
    ));
    Ok(())
}
