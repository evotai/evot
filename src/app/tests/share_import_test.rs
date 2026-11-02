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
    let meta = import_shared_session(&state, &storage, &link, "/mine").await?;

    assert_ne!(meta.session_id, "owner-sid");
    assert_eq!(
        meta.title.as_deref(),
        Some("db migration plan (shared copy)")
    );
    assert!(
        meta.cloud.is_none(),
        "an import never writes back to the owner"
    );
    assert_eq!(
        meta.cwd, "/mine",
        "the copy runs in the importer's workspace"
    );
    let entries = storage
        .list_entries(ListTranscriptEntries {
            session_id: meta.session_id.clone(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(entries.len(), 3, "two shared entries and the import note");
    assert!(entries
        .iter()
        .all(|entry| entry.session_id == meta.session_id));
    assert_eq!(
        storage.get_session(&meta.session_id).await?.map(|m| m.cwd),
        Some("/mine".to_string())
    );
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
    let meta = import_shared_session(&state, &storage, &link, "/mine").await?;
    assert_ne!(meta.session_id, "owner-sid");
    assert_eq!(meta.title.as_deref(), Some("team discussion (shared copy)"));
    assert!(meta.cloud.is_none());
    assert_eq!(meta.cwd, "/mine");
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
        2
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
    let imported = import_shared_session(
        &state,
        &storage,
        &format!("https://evot.ai/share/{TOKEN}"),
        "/mine",
    )
    .await?;
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
    assert_eq!(saved.len(), original.len() + 1);
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
        assert!(import_shared_session(
            &state,
            &storage,
            &format!("https://evot.ai/share/{TOKEN}"),
            "/mine",
        )
        .await
        .is_err());
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
    let error = import_shared_session(&state, &storage, &link, "/mine")
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
    let error = import_shared_session(&state, &storage, &link, "/mine")
        .await
        .err()
        .ok_or("expected an error")?;
    assert!(error.to_string().contains("ask the owner"), "{error}");

    let error = import_shared_session(&state, &storage, "public", "/mine")
        .await
        .err()
        .ok_or("expected an error")?;
    assert!(
        error.to_string().contains("not a shared session link"),
        "{error}"
    );
    Ok(())
}

fn tool_session(source_id: &str, cwd: &str) -> (SessionMeta, Vec<TranscriptEntry>) {
    let meta = SessionMeta::new(source_id.into(), cwd.into(), "model".into());
    let entries = vec![
        TranscriptEntry::new(
            source_id.into(),
            Some("run-1".into()),
            1,
            1,
            TranscriptItem::User {
                provenance: None,
                text: "what did winter and I discuss on feishu".into(),
                content: vec![],
            },
        ),
        TranscriptEntry::new(
            source_id.into(),
            Some("run-1".into()),
            2,
            1,
            TranscriptItem::Assistant {
                content: vec![AssistantBlock::ToolCall {
                    id: "tool-1".into(),
                    name: "bash".into(),
                    input: json!({"command": format!("ls {cwd}")}),
                    metadata: None,
                }],
                stop_reason: "tool_use".into(),
                usage: Default::default(),
                model: "model".into(),
                provider: "provider".into(),
                timestamp: 1,
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
                tool_name: "bash".into(),
                content: "src".into(),
                is_error: false,
                details: serde_json::Value::Null,
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
                timestamp: 2,
                error_message: None,
            },
        ),
    ];
    (meta, entries)
}

fn pull_body(meta: &SessionMeta, entries: &[TranscriptEntry]) -> serde_json::Value {
    json!({
        "schema_version": 1, "session_id": meta.session_id, "meta": meta,
        "seq": entries.len(), "visibility": "private", "origin_host": "their-host",
        "entries": entries,
    })
}

async fn saved_entries(
    storage: &Arc<dyn Storage>,
    session_id: &str,
) -> Result<Vec<TranscriptEntry>, evot::error::EvotError> {
    storage
        .list_entries(ListTranscriptEntries {
            session_id: session_id.into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await
}

/// The note is a runtime user message: the model reads it, the user sees only
/// its short display line, and it never counts as authored input.
fn assert_fork_notice(
    entry: &TranscriptEntry,
    origin: &str,
    cwd: &str,
    display: &str,
) -> TestResult {
    let TranscriptItem::User {
        text, provenance, ..
    } = &entry.item
    else {
        return Err(format!("expected a runtime user note, got {:?}", entry.item).into());
    };
    assert!(entry.run_id.is_none());
    assert!(text.contains(origin), "{text}");
    assert!(text.contains(&format!("Work in {cwd}")), "{text}");
    assert!(text.contains("do not repeat earlier tool calls"), "{text}");
    let sources = provenance
        .as_ref()
        .map(|provenance| provenance.sources.clone())
        .unwrap_or_default();
    assert_eq!(sources, vec![evot_engine::InputSource::Runtime {
        kind: evot::sync::FORK_NOTICE_KIND.into(),
        display: Some(display.into()),
    }]);
    assert!(entry.item.is_context_item());
    assert!(evot::conversation::input::authored_text(&entry.item).is_none());
    let parts = serde_json::to_value(evot::conversation::input::display_parts(&entry.item))?;
    assert_eq!(parts, json!([{"kind": "notice", "text": display}]));
    Ok(())
}

#[tokio::test]
async fn import_tells_the_model_the_earlier_environment_is_not_this_one() -> TestResult {
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let (meta, original) = tool_session("owner-sid", "/Users/owner/databend");
    Mock::given(method("GET"))
        .and(path(format!("/team/{TOKEN}/session.json")))
        .respond_with(ResponseTemplate::new(200).set_body_json(pull_body(&meta, &original)))
        .mount(&server)
        .await;

    let link = format!("https://auto.evot.ai/team/{TOKEN}");
    let imported = import_shared_session(&state, &storage, &link, "/Users/me/work").await?;
    assert_eq!(imported.cwd, "/Users/me/work");

    let saved = saved_entries(&storage, &imported.session_id).await?;
    assert_eq!(saved.len(), original.len() + 1);
    let notice = saved.last().ok_or("missing note")?;
    assert_eq!(notice.seq, original.len() as u64 + 1);
    assert_eq!(notice.turn, 1);
    assert_eq!(notice.session_id, imported.session_id);
    assert_fork_notice(
        notice,
        "/Users/owner/databend",
        "/Users/me/work",
        "Imported shared session · now working in /Users/me/work",
    )?;

    // The next run's history ends with the note as a model-visible user turn.
    let context = evot::conversation::convert::into_agent_messages(
        &saved
            .iter()
            .map(|entry| entry.item.clone())
            .filter(TranscriptItem::is_context_item)
            .collect::<Vec<_>>(),
    );
    match context.last() {
        Some(evot_engine::AgentMessage::Llm(evot_engine::Message::User { content, .. })) => {
            assert!(matches!(
                content.as_slice(),
                [evot_engine::Content::Text { text }] if text.contains("Work in /Users/me/work")
            ));
        }
        other => {
            return Err(format!("expected the note as the last user message, got {other:?}").into())
        }
    }
    Ok(())
}

#[tokio::test]
async fn import_notes_a_shared_session_even_in_the_same_path() -> TestResult {
    // Same path, different machine: logins and installed tools still differ.
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let (meta, original) = tool_session("owner-sid", "/srv/app");
    Mock::given(method("GET"))
        .and(path(format!("/share/{TOKEN}/session.json")))
        .respond_with(ResponseTemplate::new(200).set_body_json(pull_body(&meta, &original)))
        .mount(&server)
        .await;
    let link = format!("https://evot.ai/share/{TOKEN}");
    let imported = import_shared_session(&state, &storage, &link, "/srv/app").await?;
    let saved = saved_entries(&storage, &imported.session_id).await?;
    assert_eq!(saved.len(), original.len() + 1);
    Ok(())
}

#[tokio::test]
async fn cloud_fork_runs_here_and_notes_only_a_changed_workspace() -> TestResult {
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let mut owned = tool_session("own-sid", "/Users/me/laptop-repo");
    owned.0.cloud = Some(CloudSync::new(CloudVisibility::Private, "laptop"));
    Mock::given(method("GET"))
        .and(path("/v1/sessions/own-sid"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pull_body(&owned.0, &owned.1)))
        .mount(&server)
        .await;

    // Same workspace: the history still applies, nothing is added.
    let same =
        evot::sync::fork_remote_session(&state, &storage, "own-sid", "/Users/me/laptop-repo")
            .await?;
    assert_eq!(same.cwd, "/Users/me/laptop-repo");
    assert_eq!(same.title.as_deref(), Some("session (cloud copy)"));
    assert!(same.cloud.is_none());
    assert_eq!(
        saved_entries(&storage, &same.session_id).await?.len(),
        owned.1.len()
    );

    // Another workspace: the fork moves here and says where it came from.
    let moved =
        evot::sync::fork_remote_session(&state, &storage, "own-sid", "/home/me/desktop").await?;
    assert_eq!(moved.cwd, "/home/me/desktop");
    let saved = saved_entries(&storage, &moved.session_id).await?;
    assert_eq!(saved.len(), owned.1.len() + 1);
    let notice = saved.last().ok_or("missing note")?;
    assert_fork_notice(
        notice,
        "/Users/me/laptop-repo",
        "/home/me/desktop",
        "Copied from /Users/me/laptop-repo · now working in /home/me/desktop",
    )?;
    Ok(())
}

#[test]
fn fork_notice_without_an_origin_workspace_stays_readable() -> TestResult {
    let Some(TranscriptItem::User {
        text, provenance, ..
    }) = evot::sync::fork_notice(evot::sync::ForkSource::Cloud, "", "/mine")
    else {
        return Err("a legacy fork without a cwd still moves here".into());
    };
    assert!(text.contains("ran in another workspace"), "{text}");
    let display = provenance.and_then(|provenance| match provenance.sources.as_slice() {
        [evot_engine::InputSource::Runtime { display, .. }] => display.clone(),
        _ => None,
    });
    assert_eq!(
        display.as_deref(),
        Some("Copied from another workspace · now working in /mine")
    );
    assert!(evot::sync::fork_notice(evot::sync::ForkSource::Cloud, "/mine", "/mine").is_none());
    Ok(())
}

/// One provider call: the system prompt and the messages sent with it.
type ProviderCall = (String, Vec<evot_engine::Message>);

struct CapturingProvider {
    calls: Arc<tokio::sync::Mutex<Vec<ProviderCall>>>,
}

#[async_trait::async_trait]
impl evot_engine::provider::StreamProvider for CapturingProvider {
    async fn stream(
        &self,
        config: evot_engine::provider::StreamConfig,
        tx: tokio::sync::mpsc::UnboundedSender<evot_engine::provider::StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<evot_engine::provider::StreamOutcome, evot_engine::provider::ProviderError> {
        self.calls
            .lock()
            .await
            .push((config.system_prompt.clone(), config.messages.clone()));
        evot_engine::provider::MockProvider::text("checked the current directory")
            .stream(config, tx, cancel)
            .await
    }
}

#[tokio::test]
async fn the_first_run_after_an_import_works_here_and_sees_the_note() -> TestResult {
    let server = MockServer::start().await;
    let state = auth(&server)?;
    let home = TempDir::new()?;
    let here = TempDir::new()?;
    let cwd = here.path().to_string_lossy().to_string();
    let storage: Arc<dyn Storage> = Arc::new(evot::storage::MemoryStorage::new());
    let (meta, original) = tool_session("owner-sid", "/Users/owner/databend");
    Mock::given(method("GET"))
        .and(path(format!("/team/{TOKEN}/session.json")))
        .respond_with(ResponseTemplate::new(200).set_body_json(pull_body(&meta, &original)))
        .mount(&server)
        .await;
    let link = format!("https://auto.evot.ai/team/{TOKEN}");
    let imported = import_shared_session(&state, &storage, &link, &cwd).await?;

    let mut config = evot::conf::Config::new(home.path().to_path_buf());
    config
        .providers
        .insert("test".into(), evot::conf::ProviderProfile {
            protocol: evot::conf::Protocol::OpenAi,
            api_key: "test-key".into(),
            base_url: "http://localhost".into(),
            models: vec!["gpt-4o".into()],
            compat_caps: Default::default(),
            route_capabilities: Default::default(),
            thinking_level: None,
            context_window: None,
            max_tokens: None,
            supports_image: None,
        });
    config.llm.provider = "test".into();
    let calls = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let agent = evot::agent::Agent::new_with_provider_for_test(
        &config,
        &cwd,
        storage.clone(),
        CapturingProvider {
            calls: calls.clone(),
        },
    )?;
    let session = agent
        .load_session(&imported.session_id)
        .await?
        .ok_or("imported session did not load")?;
    let evot::agent::SubmitOutcome::Run(mut run) = agent
        .submit_to_session(
            evot::agent::QueryRequest::text("list the files here"),
            session,
        )
        .await?
    else {
        return Err("expected a run".into());
    };
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while run.next().await.is_some() {}
    })
    .await?;

    let calls = calls.lock().await;
    let (system_prompt, messages) = calls.first().ok_or("the provider was not called")?;
    assert!(
        system_prompt.contains(&format!("Current working directory: {cwd}")),
        "{system_prompt}"
    );
    assert!(!system_prompt.contains("/Users/owner/databend"));
    let users: Vec<String> = messages
        .iter()
        .filter_map(|message| match message {
            evot_engine::Message::User { content, .. } => Some(
                content
                    .iter()
                    .filter_map(|block| match block {
                        evot_engine::Content::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            _ => None,
        })
        .collect();
    assert_eq!(users.len(), 3, "{users:?}");
    assert!(users[1].contains("/Users/owner/databend") && users[1].contains(&cwd));
    assert_eq!(users[2], "list the files here");
    Ok(())
}
