//! Tests for the dashboard session-search feature.
//!
//! The chat sidebar does client-side substring filtering and highlighting
//! over the `search_text` field returned by `list_sessions_with_text`.
//! These tests pin the backend contract that feeds it, plus a guard that the
//! chat page embeds the search markup that calls `/api/sessions`.

use std::sync::Arc;

use evot::observability::UsageSummary;
use evot::sessions::Session;
use evot::storage::MemoryStorage;
use evot::types::ListSessions;
use evot::types::*;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

fn assistant_with_blocks(content: Vec<AssistantBlock>) -> TranscriptItem {
    TranscriptItem::Assistant {
        content,
        stop_reason: "stop".into(),
        usage: UsageSummary::default(),
        model: String::new(),
        provider: String::new(),
        timestamp: 0,
        error_message: None,
    }
}

fn assistant(text: &str) -> TranscriptItem {
    assistant_with_blocks(vec![AssistantBlock::Text { text: text.into() }])
}

fn user(text: &str) -> TranscriptItem {
    TranscriptItem::User {
        provenance: None,
        text: text.into(),
        content: vec![],
    }
}

#[tokio::test]
async fn search_text_includes_transcript_content() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());

    let session = Session::new(
        "search-sess-001".into(),
        "/home/me/project".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::User {
                provenance: None,
                text: "how do I configure the retry budget".into(),
                content: vec![],
            },
            assistant("Set max_retries in the provider config block."),
        ])
        .await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|r| r.session.session_id == "search-sess-001")
        .ok_or("session not returned")?;

    // The flattened text the UI filters and highlights against must carry
    // metadata (cwd) and transcript content from both roles.
    assert!(row.search_text.contains("/home/me/project"));
    assert!(row.search_text.contains("retry budget"));
    assert!(row.search_text.contains("max_retries"));
    Ok(())
}

#[tokio::test]
async fn search_text_includes_content_past_first_line() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());

    let session = Session::new(
        "search-sess-multiline".into(),
        "/home/me/project".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    // A multi-line message whose keyword lives on a later line. The old
    // first-line-only truncation dropped this; the flat search_text must now
    // carry it so the UI can match and highlight it.
    session
        .write_items(vec![assistant(
            "Overview\nThis is the second line\nKeyword appears here: normalization pipeline\nDone",
        )])
        .await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|r| r.session.session_id == "search-sess-multiline")
        .ok_or("session not returned")?;

    assert!(row.search_text.contains("normalization pipeline"));
    // Newlines are flattened to spaces so the body is one searchable line.
    assert!(!row.search_text.contains('\n'));
    Ok(())
}

#[tokio::test]
async fn search_text_includes_assistant_thinking_after_large_tool_output() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "search-sess-thinking".into(),
        "/home/me/project".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            TranscriptItem::ToolResult {
                tool_call_id: "call-1".into(),
                tool_name: "bash".into(),
                content: "noise ".repeat(2_000),
                is_error: false,
                details: serde_json::Value::Null,
            },
            assistant_with_blocks(vec![AssistantBlock::Thinking {
                text: "Incident code is NEBULA-4729".into(),
                metadata: None,
            }]),
        ])
        .await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|row| row.session.session_id == "search-sess-thinking")
        .ok_or("session not returned")?;
    assert!(row.search_text.contains("NEBULA-4729"));
    assert!(row.search_text.chars().count() < 6_500);
    Ok(())
}

#[tokio::test]
async fn search_text_keeps_both_ends_of_long_conversations() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "search-sess-long".into(),
        "/home/me/project".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            assistant(&format!("early-marker {}", "a".repeat(7_000))),
            assistant("late-marker"),
        ])
        .await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|row| row.session.session_id == "search-sess-long")
        .ok_or("session not returned")?;
    assert!(row.search_text.contains("early-marker"));
    assert!(row.search_text.contains("late-marker"));
    Ok(())
}

#[tokio::test]
async fn list_sessions_with_text_respects_limit_after_draft_filtering() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());

    for i in 0..5 {
        let mut meta = SessionMeta::new(
            format!("limit-sess-{i:03}"),
            "/tmp".into(),
            "test-model".into(),
        );
        meta.created_at = format!("2026-01-01T00:00:0{i}Z");
        meta.updated_at = meta.created_at.clone();
        storage.save_session(meta).await?;
        storage
            .append_entry(TranscriptEntry::new(
                format!("limit-sess-{i:03}"),
                None,
                1,
                1,
                assistant("hello"),
            ))
            .await?;
    }

    // Newer metadata-only drafts sort ahead of every real session. They must
    // be filtered before the limit is applied, not consume the two slots.
    for i in 0..3 {
        let mut draft = SessionMeta::new(
            format!("draft-sess-{i:03}"),
            "/tmp".into(),
            "test-model".into(),
        );
        draft.created_at = format!("2026-01-02T00:00:0{i}Z");
        draft.updated_at = draft.created_at.clone();
        storage.save_session(draft).await?;
    }

    let total = storage
        .list_sessions(ListSessions {
            limit: 100,
            offset: 0,
        })
        .await?;
    assert_eq!(total.len(), 8);

    let limited = storage.list_sessions_with_text(2).await?;
    assert_eq!(limited.len(), 2);
    assert!(limited
        .iter()
        .all(|row| row.session.session_id.starts_with("limit-sess-")));
    Ok(())
}

#[tokio::test]
async fn delete_session_removes_only_target() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());

    for id in ["del-a", "del-b", "del-c"] {
        let s = Session::new(
            id.into(),
            "/tmp".into(),
            "test-model".into(),
            storage.clone(),
        )
        .await?;
        s.write_items(vec![assistant("hi")]).await?;
    }

    // Deleting an existing session reports true and removes just that one.
    assert!(storage.delete_session("del-b").await?);
    let remaining = storage
        .list_sessions(ListSessions {
            limit: 100,
            offset: 0,
        })
        .await?;
    let ids: Vec<&str> = remaining.iter().map(|s| s.session_id.as_str()).collect();
    assert_eq!(remaining.len(), 2);
    assert!(ids.contains(&"del-a"));
    assert!(ids.contains(&"del-c"));
    assert!(!ids.contains(&"del-b"));

    // Deleting an already-gone id reports false rather than erroring, which is
    // what lets the bulk endpoint treat a stale client list as a no-op.
    assert!(!storage.delete_session("del-b").await?);
    Ok(())
}

/// Chat owns the session sidebar and the full-text search dialog; the
/// standalone sessions page is gone, so its affordances live here: paged
/// recent list, armed delete, and highlighted match snippets.
#[test]
fn chat_page_embeds_session_navigation() {
    let html = include_str!("../assets/console/index.html");
    let js = include_str!("../assets/console/ui/chat.js");
    let rail = include_str!("../assets/console/ui/rail.js");
    assert!(rail.contains("id=\"recentSessions\""));
    assert!(html.contains("data-mode=\"chat\""));
    assert!(html.contains("id=\"searchOverlay\""));
    assert!(html.contains("id=\"modelSelect\""));
    assert!(html.contains("id=\"thinkingSelect\""));
    assert!(js.contains("/api/sessions"));
    assert!(js.contains("search_text"));
    assert!(js.contains("/api/sessions/delete"));
    assert!(js.contains("snippetAround"));
    assert!(js.contains("<mark>"));
    // Recent pages from the server; search pays for transcript text later.
    assert!(js.contains("loadRecentPage"));
    // Account row + notices refresh in place after login/logout.
    assert!(js.contains("/api/auth/session"));
    assert!(js.contains("/api/notices"));
    assert!(js.contains("/api/sessions?full=true"));
    assert!(js.contains("skeletonHtml"));
    // New never pre-creates a draft session: every New (cwd switch included)
    // lands on the welcome hero, and the first message carries the workspace.
    assert!(js.contains("returnToWelcome()"));
    assert!(!js.contains("/api/chat/new"));
    assert!(js.contains("payload.cwd = workspace.cwd"));
    // A trace deep-dive hands the reader back to the same conversation.
    assert!(js.contains("URLSearchParams"));
    assert!(js.contains("target = \"_blank\""));
}

// ---------------------------------------------------------------------------
// user_prompts — the resume selector's preview pane shows the user's own turns,
// which `search_text` cannot provide: it flattens every role into one blob.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn user_prompts_keep_only_user_turns_in_order() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "prompts-sess-001".into(),
        "/tmp/proj".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    session
        .write_items(vec![
            user("first ask"),
            assistant("an answer the pane must not show"),
            user("second ask"),
        ])
        .await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|r| r.session.session_id == "prompts-sess-001")
        .ok_or("session not returned")?;

    assert_eq!(row.user_prompts, vec!["first ask", "second ask"]);
    Ok(())
}

#[tokio::test]
async fn user_prompts_skip_compaction_boilerplate() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "prompts-sess-002".into(),
        "/tmp/proj".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    // Compaction injects a synthetic User item; the user never typed it.
    session
        .write_items(vec![
            evot::compact::context_view::compact_summary_item("earlier work on the parser"),
            user("carry on from there"),
        ])
        .await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|r| r.session.session_id == "prompts-sess-002")
        .ok_or("session not returned")?;

    assert_eq!(row.user_prompts, vec!["carry on from there"]);
    Ok(())
}

#[tokio::test]
async fn user_prompts_normalize_newlines_and_cap_long_turns() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "prompts-sess-003".into(),
        "/tmp/proj".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    let long = "x".repeat(1_000);
    session
        .write_items(vec![user("line one\n\nline two"), user(&long)])
        .await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|r| r.session.session_id == "prompts-sess-003")
        .ok_or("session not returned")?;

    // The pane renders one row per turn, so a turn is a single line.
    assert_eq!(row.user_prompts[0], "line one line two");
    let capped = &row.user_prompts[1];
    assert!(capped.chars().count() < 400, "not capped: {}", capped.len());
    assert!(capped.ends_with('…'));
    Ok(())
}

#[tokio::test]
async fn user_prompts_keep_the_latest_turns_of_a_long_session() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "prompts-sess-004".into(),
        "/tmp/proj".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    let items: Vec<TranscriptItem> = (0..80).map(|i| user(&format!("turn {i}"))).collect();
    session.write_items(items).await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|r| r.session.session_id == "prompts-sess-004")
        .ok_or("session not returned")?;

    // A resume pane shows a handful of lines, and the newest turns say where
    // the session left off — so the tail is what is kept.
    assert!(row.user_prompts.len() <= 24);
    assert_eq!(row.user_prompts.last().map(String::as_str), Some("turn 79"));
    assert!(!row.user_prompts.iter().any(|p| p == "turn 0"));
    // The opening ask survives the trim: it is what the session set out to do.
    assert_eq!(row.first_prompt.as_deref(), Some("turn 0"));
    Ok(())
}

#[tokio::test]
async fn changed_paths_come_from_edit_and_write_calls_in_first_seen_order() -> TestResult {
    let storage: Arc<dyn evot::storage::Storage> = Arc::new(MemoryStorage::new());
    let session = Session::new(
        "prompts-sess-005".into(),
        "/tmp/proj".into(),
        "test-model".into(),
        storage.clone(),
    )
    .await?;

    let call = |id: &str, name: &str, input: serde_json::Value| AssistantBlock::ToolCall {
        id: id.into(),
        name: name.into(),
        input,
        metadata: None,
    };
    session
        .write_items(vec![
            user("fix the parser"),
            assistant_with_blocks(vec![
                call("c1", "read", serde_json::json!({"path": "src/lib.rs"})),
                call(
                    "c2",
                    "edit",
                    serde_json::json!({"path": "src/parser.rs", "edits": []}),
                ),
                call("c3", "bash", serde_json::json!({"command": "cargo test"})),
            ]),
            assistant_with_blocks(vec![
                call(
                    "c4",
                    "write",
                    serde_json::json!({"file_path": "tests/parser.rs", "content": ""}),
                ),
                call("c5", "edit", serde_json::json!({"path": "src/parser.rs"})),
                call("c6", "edit", serde_json::json!({"path": "   "})),
            ]),
        ])
        .await?;

    let rows = storage.list_sessions_with_text(10).await?;
    let row = rows
        .iter()
        .find(|r| r.session.session_id == "prompts-sess-005")
        .ok_or("session not returned")?;

    // Reads and shell commands are not changes; repeats and blank paths drop out.
    assert_eq!(row.changed_paths, vec!["src/parser.rs", "tests/parser.rs"]);
    assert_eq!(row.first_prompt.as_deref(), Some("fix the parser"));
    Ok(())
}

#[tokio::test]
async fn focused_session_text_matches_catalog_for_both_backends() -> TestResult {
    let dir = tempfile::tempdir()?;
    let stores: Vec<Arc<dyn evot::storage::Storage>> = vec![
        Arc::new(MemoryStorage::new()),
        Arc::new(evot::storage::fs::FsStorage::new(dir.path().to_path_buf())),
    ];
    for storage in stores {
        let id = uuid::Uuid::now_v7().to_string();
        let session = Session::new(
            id.clone(),
            "/tmp/proj".into(),
            "model".into(),
            storage.clone(),
        )
        .await?;
        session
            .write_items(vec![
                user("first ask"),
                assistant("reply"),
                user("latest ask"),
            ])
            .await?;
        let focused = storage
            .session_with_text(&id)
            .await?
            .ok_or("missing focused row")?;
        let catalog = storage.list_sessions_with_text(0).await?;
        let listed = catalog
            .iter()
            .find(|row| row.session.session_id == id)
            .ok_or("missing listed row")?;
        // Fs listings derive recency from transcript mtime; direct reads keep
        // the saved timestamp. Extracted transcript fields must still match.
        assert_eq!(focused.search_text, listed.search_text);
        assert_eq!(focused.user_prompts, listed.user_prompts);
        assert_eq!(focused.first_prompt, listed.first_prompt);
        assert_eq!(focused.changed_paths, listed.changed_paths);
        assert_eq!(focused.first_prompt.as_deref(), Some("first ask"));
        assert_eq!(focused.user_prompts, vec!["first ask", "latest ask"]);
        assert!(storage
            .session_with_text(&uuid::Uuid::now_v7().to_string())
            .await?
            .is_none());
    }
    Ok(())
}
