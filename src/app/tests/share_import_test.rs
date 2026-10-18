//! `/share <url>`: a public page becomes a local session to continue.
use std::sync::Arc;

use evot::auth::AuthState;
use evot::conf::StorageConfig;
use evot::share::import_shared_session;
use evot::share::parse_session_share_link;
use evot::share::SessionShareLink;
use evot::storage::open_storage;
use evot::storage::Storage;
use evot::types::*;
use serde_json::json;
use tempfile::TempDir;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

const TOKEN: &str = "Xk3f9a2bQwErTyUiOpAs12";

#[test]
fn session_share_links_are_recognised_by_path_only() {
    for input in [
        "https://evot.ai/share/Xk3f9a2bQwErTyUiOpAs12",
        "http://localhost:8787/share/Xk3f9a2bQwErTyUiOpAs12/",
        "evot.ai/share/Xk3f9a2bQwErTyUiOpAs12?x=1#frag",
        "https://anything.example/share/Xk3f9a2bQwErTyUiOpAs12/session.json",
        "https://evot.ai/share/Xk3f9a2bQwErTyUiOpAs12/content",
    ] {
        assert_eq!(
            parse_session_share_link(input),
            Some(SessionShareLink::Public(TOKEN.to_string())),
            "{input}"
        );
    }
}

#[test]
fn team_share_links_preserve_access_policy_and_ignore_viewer_target() {
    for input in [
        "https://auto.evot.ai/team/Xk3f9a2bQwErTyUiOpAs12?leafId=e135&targetId=e134",
        "https://other.example/team/Xk3f9a2bQwErTyUiOpAs12/session.json#entry",
    ] {
        assert_eq!(
            parse_session_share_link(input),
            Some(SessionShareLink::Team(TOKEN.to_string())),
            "{input}"
        );
    }
}

#[test]
fn ids_words_and_task_links_are_not_session_share_links() {
    for input in [
        "",
        // A bare token would be ambiguous with `/share <local-id>`.
        "Xk3f9a2bQwErTyUiOpAs12",
        "public",
        "019ecf98-a948-7ee1-b28a-e352da2aee40",
        "https://evot.ai/share/t/Xk3f9a2bQwErTyUiOpAs12",
        "https://evot.ai/share/short",
        "https://evot.ai/share/Xk3f9a2bQwErTyUiOpAs12/extra",
        "ftp://evot.ai/share/Xk3f9a2bQwErTyUiOpAs12",
        "look at https://evot.ai/share/Xk3f9a2bQwErTyUiOpAs12",
    ] {
        assert_eq!(parse_session_share_link(input), None, "{input:?}");
    }
}

fn auth(server: &MockServer) -> Result<AuthState, serde_json::Error> {
    serde_json::from_value(json!({
        "version":1, "server_base_url":server.uri(),
        "user":{"id":"user", "name":"User", "email":"user@test.dev"},
        "cli_token":"test-token", "refresh_token":"", "models_synced_at":0
    }))
}

fn user(session: &str, seq: u64, text: &str) -> TranscriptEntry {
    TranscriptEntry::new(session.into(), None, seq, 0, TranscriptItem::User {
        provenance: None,
        text: text.into(),
        content: vec![],
    })
}

fn fs_storage(root: &TempDir) -> Result<Arc<dyn Storage>, evot::error::EvotError> {
    open_storage(&StorageConfig::fs(root.path().to_path_buf()))
}

#[tokio::test]
async fn import_forks_the_public_transcript_into_a_local_only_session() -> TestResult {
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let mut remote_meta = SessionMeta::new("owner-sid".into(), "/theirs".into(), "m".into());
    remote_meta.title = Some("db migration plan".into());
    remote_meta.cloud = Some(CloudSync::new(CloudVisibility::Public, "their-host"));
    Mock::given(method("GET"))
        .and(path(format!("/share/{TOKEN}/session.json")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "schema_version": 1,
            "session_id": "owner-sid",
            "meta": remote_meta,
            "seq": 2,
            "visibility": "public",
            "origin_host": "their-host",
            "public_url": format!("https://evot.ai/share/{TOKEN}"),
            "entries": [user("owner-sid", 1, "hi"), user("owner-sid", 2, "there")],
        })))
        .expect(1)
        .mount(&server)
        .await;

    // The pasted host is ignored: the fetch goes to this client's server.
    let link = format!("https://pasted.example/share/{TOKEN}");
    let meta = import_shared_session(&state, &storage, &link).await?;

    assert_ne!(meta.session_id, "owner-sid");
    assert_eq!(
        meta.title.as_deref(),
        Some("db migration plan (shared copy)")
    );
    assert!(
        meta.cloud.is_none(),
        "an import never writes back to the owner"
    );
    let entries = storage
        .list_entries(ListTranscriptEntries {
            session_id: meta.session_id.clone(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(entries.len(), 2);
    assert!(entries
        .iter()
        .all(|entry| entry.session_id == meta.session_id));
    Ok(())
}

#[tokio::test]
async fn team_import_uses_the_cli_token_and_keeps_a_local_copy() -> TestResult {
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let mut remote_meta = SessionMeta::new("owner-sid".into(), "/theirs".into(), "m".into());
    remote_meta.title = Some("team discussion".into());
    Mock::given(method("GET"))
        .and(path(format!("/team/{TOKEN}/session.json")))
        .and(wiremock::matchers::header(
            "authorization",
            "Bearer test-token",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "schema_version": 1,
            "session_id": "owner-sid",
            "meta": remote_meta,
            "seq": 1,
            "visibility": "private",
            "team": true,
            "entries": [user("owner-sid", 1, "team notes")],
        })))
        .expect(1)
        .mount(&server)
        .await;

    let link = format!("https://pasted.example/team/{TOKEN}?leafId=e135&targetId=e134");
    let meta = import_shared_session(&state, &storage, &link).await?;
    assert_ne!(meta.session_id, "owner-sid");
    assert_eq!(meta.title.as_deref(), Some("team discussion (shared copy)"));
    assert!(meta.cloud.is_none());
    assert_eq!(
        storage
            .list_entries(ListTranscriptEntries {
                session_id: meta.session_id,
                run_id: None,
                after_seq: None,
                limit: None,
            })
            .await?
            .len(),
        1
    );
    Ok(())
}

#[tokio::test]
async fn import_preserves_every_content_block_including_thinking_and_tool_calls() -> TestResult {
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let source_id = "owner-sid";
    let mut meta = SessionMeta::new(source_id.into(), "/theirs".into(), "model".into());
    meta.custom_title = Some("owner's title".into());
    let original = vec![
        TranscriptEntry::new(
            source_id.into(),
            Some("run-1".into()),
            1,
            1,
            TranscriptItem::User {
                provenance: None,
                text: "explain the screenshot".into(),
                content: vec![
                    TranscriptUserContent::Text {
                        text: "explain the screenshot".into(),
                    },
                    TranscriptUserContent::Image {
                        mime_type: "image/png".into(),
                        source: TranscriptImageSource::Base64 {
                            data: "aW1hZ2U=".into(),
                        },
                    },
                ],
            },
        ),
        TranscriptEntry::new(
            source_id.into(),
            Some("run-1".into()),
            2,
            1,
            TranscriptItem::Assistant {
                content: vec![
                    AssistantBlock::Thinking {
                        text: "reasoning to preserve".into(),
                        metadata: Some(evot_engine::ThinkingMetadata::Anthropic {
                            signature: "signed".into(),
                        }),
                    },
                    AssistantBlock::Text {
                        text: "I will read the file".into(),
                    },
                    AssistantBlock::ToolCall {
                        id: "tool-1".into(),
                        name: "read".into(),
                        input: json!({"path":"/theirs/file"}),
                        metadata: None,
                    },
                ],
                stop_reason: "tool_use".into(),
                usage: Default::default(),
                model: "model".into(),
                provider: "provider".into(),
                timestamp: 123,
                error_message: None,
            },
        ),
        TranscriptEntry::new(
            source_id.into(),
            Some("run-1".into()),
            3,
            1,
            TranscriptItem::ToolResult {
                tool_call_id: "tool-1".into(),
                tool_name: "read".into(),
                content: "file contents".into(),
                is_error: false,
                details: json!({"artifact":"kept"}),
            },
        ),
        TranscriptEntry::new(
            source_id.into(),
            Some("run-1".into()),
            4,
            1,
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::Text {
                    text: "done".into(),
                }],
                stop_reason: "end_turn".into(),
                usage: Default::default(),
                model: "model".into(),
                provider: "provider".into(),
                timestamp: 124,
                error_message: None,
            },
        ),
    ];
    Mock::given(method("GET"))
        .and(path(format!("/share/{TOKEN}/session.json")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "schema_version": 1, "session_id": source_id, "meta": meta,
            "seq": original.len(), "visibility": "public", "entries": original,
        })))
        .mount(&server)
        .await;
    let imported =
        import_shared_session(&state, &storage, &format!("https://evot.ai/share/{TOKEN}")).await?;
    assert_eq!(
        imported.display_title(),
        Some("owner's title (shared copy)")
    );
    let saved = storage
        .list_entries(ListTranscriptEntries {
            session_id: imported.session_id.clone(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(saved.len(), original.len());
    for (before, after) in original.iter().zip(&saved) {
        let mut expected = serde_json::to_value(before)?;
        expected["session_id"] = json!(imported.session_id);
        assert_eq!(serde_json::to_value(after)?, expected);
    }
    let context = evot::conversation::convert::into_agent_messages(
        &saved.iter().map(|e| e.item.clone()).collect::<Vec<_>>(),
    );
    let rendered = serde_json::to_value(context)?;
    assert!(rendered.to_string().contains("reasoning to preserve"));
    assert!(rendered.to_string().contains("signed"));
    Ok(())
}

#[tokio::test]
async fn import_refuses_incomplete_or_nonportable_transcripts_without_writing() -> TestResult {
    for (seq, entries) in [
        (2, vec![user("owner-sid", 1, "first")]),
        (1, vec![user("someone-else", 1, "first")]),
        (1, vec![TranscriptEntry::new(
            "owner-sid".into(),
            None,
            1,
            0,
            TranscriptItem::User {
                provenance: None,
                text: "image".into(),
                content: vec![TranscriptUserContent::Image {
                    mime_type: "image/png".into(),
                    source: TranscriptImageSource::Path {
                        path: "/missing/image.png".into(),
                    },
                }],
            },
        )]),
    ] {
        let server = MockServer::start().await;
        let state = auth(&server)?;
        let root = TempDir::new()?;
        let storage = fs_storage(&root)?;
        Mock::given(method("GET"))
            .and(path(format!("/share/{TOKEN}/session.json")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "schema_version": 1,
                "meta": SessionMeta::new("owner-sid".into(), "/theirs".into(), "m".into()),
                "seq": seq, "visibility": "public", "entries": entries,
            })))
            .mount(&server)
            .await;
        assert!(
            import_shared_session(&state, &storage, &format!("https://evot.ai/share/{TOKEN}"))
                .await
                .is_err()
        );
        assert!(storage
            .list_sessions(ListSessions::default())
            .await?
            .is_empty());
    }
    Ok(())
}

#[tokio::test]
async fn team_import_reports_lost_membership() -> TestResult {
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    Mock::given(method("GET"))
        .and(path(format!("/team/{TOKEN}/session.json")))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let link = format!("https://auto.evot.ai/team/{TOKEN}");
    let error = import_shared_session(&state, &storage, &link)
        .await
        .err()
        .ok_or("expected an error")?;
    assert!(
        error.to_string().contains("not a current member"),
        "{error}"
    );
    Ok(())
}

#[tokio::test]
async fn import_explains_a_missing_or_snapshot_share() -> TestResult {
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    Mock::given(method("GET"))
        .and(path(format!("/share/{TOKEN}/session.json")))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": "not found"})))
        .mount(&server)
        .await;

    let link = format!("https://evot.ai/share/{TOKEN}");
    let error = import_shared_session(&state, &storage, &link)
        .await
        .err()
        .ok_or("expected an error")?;
    assert!(error.to_string().contains("ask the owner"), "{error}");

    let error = import_shared_session(&state, &storage, "public")
        .await
        .err()
        .ok_or("expected an error")?;
    assert!(
        error.to_string().contains("not a shared session link"),
        "{error}"
    );
    Ok(())
}
