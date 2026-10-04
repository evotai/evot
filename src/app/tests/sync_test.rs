//! Cloud session sync: contract of `SessionMeta.cloud`, incremental push with
//! compare-and-append, conflict surfacing, pull into an empty machine, and the
//! cheap state classification used by the `/sessions` list.

use std::sync::Arc;

use evot::auth::AuthState;
use evot::conf::StorageConfig;
use evot::storage::open_storage;
use evot::storage::Storage;
use evot::sync;
use evot::types::*;
use serde::Deserialize;
use serde_json::json;
use tempfile::TempDir;
use wiremock::matchers::body_partial_json;
use wiremock::matchers::header;
use wiremock::matchers::method;
use wiremock::matchers::path;
use wiremock::matchers::query_param;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::ResponseTemplate;

type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

const META_V1_WITHOUT_CLOUD: &str = include_str!("fixtures/schema/session-meta-v1-no-cloud.json");
const META_V1_WITH_CLOUD: &str = include_str!("fixtures/schema/session-meta-v1-cloud.json");
const META_V1_WITH_TEAM: &str = include_str!("fixtures/schema/session-meta-v1-cloud-team.json");

/// `cloud` as the release before team pages read it: visibility limited to
/// the two original values, unknown keys ignored like the real struct.
#[derive(Deserialize)]
#[allow(dead_code)]
struct LegacyCloudSync {
    visibility: LegacyVisibility,
    #[serde(default)]
    synced_seq: u64,
    #[serde(default)]
    synced_at: String,
    #[serde(default)]
    origin_host: String,
    #[serde(default)]
    public_url: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
enum LegacyVisibility {
    Private,
    Public,
}

#[derive(Deserialize)]
struct LegacyMetaWithCloud {
    cloud: LegacyCloudSync,
}

/// Shape a reader released before `cloud` existed requires. Strict, so a
/// current writer that renames or drops a published field fails here.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct LegacySessionMeta {
    #[serde(default)]
    schema_version: u32,
    session_id: String,
    cwd: String,
    model: String,
    #[serde(default)]
    provider: String,
    #[serde(default)]
    thinking_level: Option<String>,
    title: Option<String>,
    #[serde(default)]
    custom_title: Option<String>,
    #[serde(default)]
    source: String,
    turns: u32,
    #[serde(default)]
    message_count: u32,
    #[serde(default)]
    context_tokens: usize,
    #[serde(default)]
    context_budget: usize,
    #[serde(default)]
    total_input_tokens: u64,
    #[serde(default)]
    total_output_tokens: u64,
    #[serde(default)]
    span_count: Option<u32>,
    #[serde(default)]
    parent_session_id: Option<String>,
    #[serde(default)]
    fork_seq: Option<u64>,
    created_at: String,
    updated_at: String,
}

fn state(server: &MockServer) -> Result<AuthState, serde_json::Error> {
    serde_json::from_value(json!({
        "version":1, "server_base_url":server.uri(),
        "user":{"id":"user", "name":"User", "email":"user@test.dev"},
        "cli_token":"test-token", "refresh_token":"", "models_synced_at":0
    }))
}

fn user(session: &str, seq: u64, text: &str) -> TranscriptEntry {
    TranscriptEntry::new(session.into(), None, seq, 0, TranscriptItem::User {
        text: text.into(),
        content: vec![],
    })
}

fn fs_storage(root: &TempDir) -> Result<Arc<dyn Storage>, evot::error::EvotError> {
    open_storage(&StorageConfig::fs(root.path().to_path_buf()))
}

#[test]
fn session_meta_cloud_is_backward_and_forward_compatible() -> TestResult {
    let old: SessionMeta = serde_json::from_str(META_V1_WITHOUT_CLOUD)?;
    assert!(old.cloud.is_none());

    let shared: SessionMeta = serde_json::from_str(META_V1_WITH_CLOUD)?;
    let cloud = shared.cloud.as_ref().ok_or("fixture must carry cloud")?;
    assert_eq!(cloud.visibility, CloudVisibility::Public);
    assert_eq!(cloud.synced_seq, 12);
    assert_eq!(
        cloud.public_url.as_deref(),
        Some("https://auto.evot.ai/s/abc")
    );

    // Current writer, legacy strict reader: a local-only session must not
    // even mention `cloud`, so pre-sync readers see exactly what they wrote.
    let written = serde_json::to_string(&old)?;
    let legacy: LegacySessionMeta = serde_json::from_str(&written)?;
    assert_eq!(legacy.session_id, old.session_id);
    assert_eq!(legacy.schema_version, old.schema_version);
    assert!(!written.contains("\"cloud\""));
    Ok(())
}

#[tokio::test]
async fn ordinary_saves_preserve_cloud_state() -> TestResult {
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let mut meta = SessionMeta::new("s1".into(), "/tmp".into(), "m".into());
    storage.save_session(meta.clone()).await?;
    storage
        .set_session_cloud(
            "s1",
            Some(CloudSync::new(CloudVisibility::Private, "laptop")),
        )
        .await?;

    // A run holding a stale snapshot without `cloud` saves afterwards.
    meta.turns = 3;
    storage.save_session(meta).await?;
    let loaded = storage.get_session("s1").await?.ok_or("missing")?;
    assert_eq!(loaded.turns, 3);
    assert_eq!(
        loaded.cloud.map(|c| c.origin_host),
        Some("laptop".to_string())
    );
    Ok(())
}

#[tokio::test]
async fn share_pushes_full_then_incremental_and_tracks_seq() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    storage.append_entry(user("s1", 1, "a")).await?;
    storage.append_entry(user("s1", 2, "b")).await?;

    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .and(header("authorization", "Bearer test-token"))
        .and(body_partial_json(
            json!({"expected_seq": 0, "visibility": "private"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "seq": 2, "visibility": "private", "updated_at": "t1"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let outcome = sync::share_session(&state, &storage, "s1", None, "test").await?;
    let sync::PushOutcome::Synced { cloud, pushed } = outcome else {
        return Err(format!("expected Synced, got {outcome:?}").into());
    };
    assert_eq!(pushed, 2);
    assert_eq!(cloud.synced_seq, 2);
    // The wire meta never carries per-machine sync state.
    let requests = server.received_requests().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body)?;
    assert!(body["meta"].get("cloud").is_none());
    assert_eq!(body["schema_version"], sync::SYNC_SCHEMA_VERSION);

    // Next run appends one entry: only it goes up, at expected_seq 2.
    storage.append_entry(user("s1", 3, "c")).await?;
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .and(body_partial_json(json!({"expected_seq": 2})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "seq": 3, "visibility": "private"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let outcome = sync::push_session(&state, &storage, "s1", "test", false).await?;
    let sync::PushOutcome::Synced { cloud, pushed } = outcome else {
        return Err(format!("expected Synced, got {outcome:?}").into());
    };
    assert_eq!(pushed, 1);
    assert_eq!(cloud.synced_seq, 3);
    let requests = server.received_requests().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_slice(&requests[1].body)?;
    assert_eq!(body["entries"].as_array().map(Vec::len), Some(1));
    assert_eq!(body["entries"][0]["seq"], 3);
    server.verify().await;
    Ok(())
}

#[tokio::test]
async fn share_embeds_path_images_in_viewer_and_raw_transcript() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let image = root.path().join("photo.png");
    std::fs::write(&image, b"image bytes")?;
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    let entry = TranscriptEntry::new("s1".into(), None, 1, 1, TranscriptItem::User {
        text: "look at this".into(),
        content: vec![
            TranscriptUserContent::Text {
                text: "look at this".into(),
            },
            TranscriptUserContent::Image {
                mime_type: "image/png".into(),
                source: TranscriptImageSource::Path {
                    path: image.to_string_lossy().into_owned(),
                },
            },
        ],
    });
    storage.append_entry(entry.clone()).await?;
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "seq": 1, "visibility": "public", "public_url": "https://evot.ai/share/token"
        })))
        .expect(1)
        .mount(&server)
        .await;
    sync::share_session(&state, &storage, "s1", Some(CloudAccess::Public), "test").await?;
    let requests = server.received_requests().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body)?;
    assert_eq!(
        body["entries"][0]["item"]["content"][1]["source"],
        json!({"type": "base64", "data": "aW1hZ2UgYnl0ZXM="})
    );
    assert!(body["viewer"].to_string().contains("aW1hZ2UgYnl0ZXM="));
    // Sharing only changes the wire copy, not the local conversation.
    let saved = storage
        .list_entries(ListTranscriptEntries {
            session_id: "s1".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(
        serde_json::to_value(&saved[0])?,
        serde_json::to_value(&entry)?
    );
    Ok(())
}

#[tokio::test]
async fn share_push_preserves_thinking_metadata_and_tool_sequence() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    let assistant = TranscriptEntry::new(
        "s1".into(),
        Some("run-1".into()),
        1,
        1,
        TranscriptItem::Assistant {
            content: vec![
                AssistantBlock::Thinking {
                    text: "private reasoning".into(),
                    metadata: Some(evot_engine::ThinkingMetadata::Anthropic {
                        signature: "sig".into(),
                    }),
                },
                AssistantBlock::Text {
                    text: "reading".into(),
                },
                AssistantBlock::ToolCall {
                    id: "call-1".into(),
                    name: "read".into(),
                    input: json!({"path":"file"}),
                    metadata: None,
                },
            ],
            stop_reason: "tool_use".into(),
            usage: Default::default(),
            model: "m".into(),
            provider: "p".into(),
            timestamp: 42,
            error_message: None,
        },
    );
    storage.append_entry(assistant.clone()).await?;
    storage
        .append_entry(TranscriptEntry::new(
            "s1".into(),
            Some("run-1".into()),
            2,
            1,
            TranscriptItem::ToolResult {
                tool_call_id: "call-1".into(),
                tool_name: "read".into(),
                content: "file contents".into(),
                is_error: false,
                details: json!({"rows": 2}),
            },
        ))
        .await?;
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "seq": 2, "visibility": "public", "public_url": "https://evot.ai/share/token"
        })))
        .mount(&server)
        .await;
    sync::share_session(&state, &storage, "s1", Some(CloudAccess::Public), "test").await?;
    let requests = server.received_requests().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body)?;
    assert_eq!(body["entries"][0], serde_json::to_value(&assistant)?);
    assert_eq!(body["entries"][1]["item"]["details"], json!({"rows": 2}));
    assert!(body["viewer"].to_string().contains("private reasoning"));
    Ok(())
}

#[tokio::test]
async fn share_replaces_missing_path_image_with_placeholder_text() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let kept = root.path().join("kept.png");
    std::fs::write(&kept, b"image bytes")?;
    let gone = root.path().join("gone.png");
    let gone_path = gone.to_string_lossy().into_owned();
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    storage
        .append_entry(TranscriptEntry::new(
            "s1".into(),
            None,
            1,
            1,
            TranscriptItem::User {
                text: "photos".into(),
                content: vec![
                    TranscriptUserContent::Image {
                        mime_type: "image/png".into(),
                        source: TranscriptImageSource::Path {
                            path: kept.to_string_lossy().into_owned(),
                        },
                    },
                    TranscriptUserContent::Image {
                        mime_type: "image/png".into(),
                        source: TranscriptImageSource::Path {
                            path: gone_path.clone(),
                        },
                    },
                ],
            },
        ))
        .await?;
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "seq": 1, "visibility": "public", "public_url": "https://evot.ai/share/token"
        })))
        .mount(&server)
        .await;
    sync::share_session(&state, &storage, "s1", Some(CloudAccess::Public), "test").await?;
    let requests = server.received_requests().await.unwrap_or_default();
    assert_eq!(requests.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body)?;
    let content = &body["entries"][0]["item"]["content"];
    assert_eq!(
        content[0]["source"],
        json!({"type":"base64","data":"aW1hZ2UgYnl0ZXM="})
    );
    assert_eq!(
        content[1],
        json!({"type":"text","text":"[image unavailable: gone.png]"})
    );
    // The local directory of the missing file is never published.
    assert!(!body.to_string().contains(&gone_path));
    // The local transcript keeps the original path reference.
    let entries = storage
        .list_entries(evot::types::ListTranscriptEntries {
            session_id: "s1".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert!(serde_json::to_string(&entries)?.contains(&gone_path));
    Ok(())
}

#[tokio::test]
async fn share_embeds_images_in_compacted_engine_context_without_changing_tool_inputs() -> TestResult
{
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let image = root.path().join("compacted.png");
    std::fs::write(&image, b"snapshot bytes")?;
    let image_path = image.to_string_lossy().into_owned();
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    let compact = TranscriptEntry::new("s1".into(), None, 1, 1, TranscriptItem::Compact {
        id: "compact-1".into(),
        created_at: 1,
        reason: CompactReason::Manual,
        summary: "history".into(),
        tokens_before: 1,
        tokens_after: 1,
        messages_before: 2,
        messages_after: 2,
        messages: vec![TranscriptItem::User {
            text: "image".into(),
            content: vec![TranscriptUserContent::Image {
                mime_type: "image/png".into(),
                source: TranscriptImageSource::Path {
                    path: image_path.clone(),
                },
            }],
        }],
        engine_messages: vec![
            evot_engine::AgentMessage::Llm(evot_engine::Message::User {
                content: vec![evot_engine::Content::Image {
                    mime_type: "image/png".into(),
                    source: evot_engine::ImageSource::Path {
                        path: image_path.clone(),
                    },
                }],
                timestamp: 1,
            }),
            evot_engine::AgentMessage::Llm(evot_engine::Message::Assistant {
                content: vec![evot_engine::Content::ToolCall {
                    id: "tool-1".into(),
                    name: "read".into(),
                    arguments: json!({"type":"image", "source":{"type":"path", "path":image_path}}),
                    metadata: None,
                }],
                stop_reason: evot_engine::StopReason::ToolUse,
                model: "m".into(),
                provider: "p".into(),
                usage: Default::default(),
                timestamp: 2,
                error_message: None,
                response_id: None,
            }),
        ],
        state: Box::default(),
        details: Default::default(),
    });
    storage.append_entry(compact.clone()).await?;
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "seq": 1, "visibility": "public", "public_url": "https://evot.ai/share/token"
        })))
        .mount(&server)
        .await;
    sync::share_session(&state, &storage, "s1", Some(CloudAccess::Public), "test").await?;
    let requests = server.received_requests().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body)?;
    let item = &body["entries"][0]["item"];
    let encoded = "c25hcHNob3QgYnl0ZXM=";
    assert_eq!(
        item["messages"][0]["content"][0]["source"],
        json!({"type":"base64","data":encoded})
    );
    assert_eq!(
        item["engine_messages"][0]["content"][0]["source"],
        json!({"type":"base64","data":encoded})
    );
    assert_eq!(
        item["engine_messages"][1]["content"][0]["arguments"],
        serde_json::to_value(&compact)?["item"]["engine_messages"][1]["content"][0]["arguments"]
    );
    Ok(())
}

#[tokio::test]
async fn previously_synced_path_image_cannot_create_a_mismatched_share() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let image = root.path().join("photo.png");
    std::fs::write(&image, b"image bytes")?;
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    storage
        .append_entry(TranscriptEntry::new(
            "s1".into(),
            None,
            1,
            1,
            TranscriptItem::User {
                text: "photo".into(),
                content: vec![TranscriptUserContent::Image {
                    mime_type: "image/png".into(),
                    source: TranscriptImageSource::Path {
                        path: image.to_string_lossy().into_owned(),
                    },
                }],
            },
        ))
        .await?;
    let mut synced = CloudSync::new(CloudVisibility::Private, "host");
    synced.synced_seq = 1;
    storage.set_session_cloud("s1", Some(synced)).await?;
    let error = sync::share_session(&state, &storage, "s1", Some(CloudAccess::Public), "test")
        .await
        .err()
        .ok_or("expected path-image error")?;
    assert!(error.to_string().contains("earlier cloud entries"));
    assert!(server
        .received_requests()
        .await
        .unwrap_or_default()
        .is_empty());
    let saved = storage.get_session("s1").await?.ok_or("missing")?;
    assert_eq!(
        saved.cloud.ok_or("missing cloud")?.visibility,
        CloudVisibility::Private
    );
    Ok(())
}

#[tokio::test]
async fn push_conflict_is_reported_not_raised_and_leaves_state_untouched() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    let mut cloud = CloudSync::new(CloudVisibility::Private, "laptop");
    cloud.synced_seq = 2;
    cloud.synced_at = "2020-01-01T00:00:00Z".into();
    storage.set_session_cloud("s1", Some(cloud)).await?;
    for seq in 1..=3 {
        storage.append_entry(user("s1", seq, "x")).await?;
    }
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({"seq": 5})))
        .mount(&server)
        .await;
    let outcome = sync::push_session(&state, &storage, "s1", "test", false).await?;
    let sync::PushOutcome::Diverged {
        local_seq,
        remote_seq,
    } = outcome
    else {
        return Err(format!("expected Diverged, got {outcome:?}").into());
    };
    assert_eq!((local_seq, remote_seq), (3, 5));
    let loaded = storage.get_session("s1").await?.ok_or("missing")?;
    assert_eq!(loaded.cloud.map(|c| c.synced_seq), Some(2));
    Ok(())
}

#[tokio::test]
async fn pull_materialises_remote_session_on_a_fresh_machine() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let mut remote_meta = SessionMeta::new("s9".into(), "/elsewhere".into(), "m".into());
    remote_meta.title = Some("db migration plan".into());
    remote_meta.turns = 2;
    Mock::given(method("GET"))
        .and(path("/v1/sessions/s9"))
        .and(query_param("after_seq", "0"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "schema_version": 1,
            "meta": remote_meta,
            "seq": 2,
            "visibility": "private",
            "origin_host": "macbook",
            "entries": [user("s9", 1, "hi"), user("s9", 2, "there")],
        })))
        .expect(1)
        .mount(&server)
        .await;

    let outcome = sync::pull_session(&state, &storage, "s9").await?;
    let sync::PullOutcome::Pulled { meta, appended } = outcome else {
        return Err(format!("expected Pulled, got {outcome:?}").into());
    };
    assert_eq!(appended, 2);
    assert_eq!(meta.title.as_deref(), Some("db migration plan"));
    let cloud = meta.cloud.ok_or("pulled session must be shared")?;
    assert_eq!(cloud.synced_seq, 2);
    assert_eq!(cloud.origin_host, "macbook");
    let entries = storage
        .list_entries(ListTranscriptEntries {
            session_id: "s9".into(),
            run_id: None,
            after_seq: None,
            limit: None,
        })
        .await?;
    assert_eq!(entries.len(), 2);

    // Pulled copy reads as in step: nothing pending on either side.
    let loaded = storage.get_session("s9").await?.ok_or("missing")?;
    let remote = sync::RemoteSession {
        session_id: "s9".into(),
        meta: remote_meta,
        seq: 2,
        visibility: CloudVisibility::Private,
        origin_host: "macbook".into(),
        updated_at: String::new(),
        public_url: None,
        team: false,
        team_url: None,
        team_name: None,
    };
    assert_eq!(
        sync::cloud_state(Some(&loaded), Some(&remote)),
        sync::CloudState::Synced
    );
    server.verify().await;
    Ok(())
}

#[tokio::test]
async fn pull_with_local_unpushed_entries_distinguishes_ahead_from_diverged() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    let mut cloud = CloudSync::new(CloudVisibility::Private, "laptop");
    cloud.synced_seq = 1;
    storage.set_session_cloud("s1", Some(cloud)).await?;
    storage.append_entry(user("s1", 1, "a")).await?;
    storage.append_entry(user("s1", 2, "b")).await?;
    let meta = SessionMeta::new("s1".into(), "/w".into(), "m".into());

    // Server still at 1: local is simply ahead.
    Mock::given(method("GET"))
        .and(path("/v1/sessions/s1"))
        .and(query_param("after_seq", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "schema_version": 1, "meta": meta, "seq": 1, "visibility": "private", "entries": []
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    let outcome = sync::pull_session(&state, &storage, "s1").await?;
    assert!(matches!(outcome, sync::PullOutcome::LocalAhead {
        local_seq: 2,
        remote_seq: 1
    }));

    // Server moved to 4 meanwhile: both sides appended.
    server.reset().await;
    Mock::given(method("GET"))
        .and(path("/v1/sessions/s1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "schema_version": 1, "meta": meta, "seq": 4, "visibility": "private", "entries": []
        })))
        .mount(&server)
        .await;
    let outcome = sync::pull_session(&state, &storage, "s1").await?;
    assert!(matches!(outcome, sync::PullOutcome::Diverged {
        local_seq: 2,
        remote_seq: 4
    }));
    Ok(())
}

#[test]
fn cloud_state_classifies_from_metadata_alone() {
    let mut local = SessionMeta::new("s".into(), "/w".into(), "m".into());
    let remote = sync::RemoteSession {
        session_id: "s".into(),
        meta: local.clone(),
        seq: 5,
        visibility: CloudVisibility::Private,
        origin_host: String::new(),
        updated_at: String::new(),
        public_url: None,
        team: false,
        team_url: None,
        team_name: None,
    };
    assert_eq!(sync::cloud_state(None, None), sync::CloudState::Local);
    assert_eq!(
        sync::cloud_state(None, Some(&remote)),
        sync::CloudState::RemoteOnly
    );
    assert_eq!(
        sync::cloud_state(Some(&local), Some(&remote)),
        sync::CloudState::Local
    );

    local.updated_at = "2024-01-01T00:00:00Z".into();
    let mut cloud = CloudSync::new(CloudVisibility::Private, "h");
    cloud.synced_seq = 5;
    cloud.synced_at = "2024-01-02T00:00:00Z".into();
    local.cloud = Some(cloud.clone());
    assert_eq!(
        sync::cloud_state(Some(&local), Some(&remote)),
        sync::CloudState::Synced
    );
    assert_eq!(
        sync::cloud_state(Some(&local), None),
        sync::CloudState::Synced
    );

    local.updated_at = "2024-01-03T00:00:00Z".into();
    assert_eq!(
        sync::cloud_state(Some(&local), Some(&remote)),
        sync::CloudState::PushPending
    );

    let mut ahead = remote.clone();
    ahead.seq = 7;
    assert_eq!(
        sync::cloud_state(Some(&local), Some(&ahead)),
        sync::CloudState::Diverged
    );
    local.updated_at = "2024-01-01T00:00:00Z".into();
    assert_eq!(
        sync::cloud_state(Some(&local), Some(&ahead)),
        sync::CloudState::PullPending
    );
}

#[test]
fn team_cloud_state_reads_old_data_and_stays_readable_by_old_builds() -> TestResult {
    // Old data, current reader: no team keys means no team page.
    let public: SessionMeta = serde_json::from_str(META_V1_WITH_CLOUD)?;
    let cloud = public.cloud.ok_or("fixture must carry cloud")?;
    assert!(!cloud.team);
    assert_eq!(cloud.access(), CloudAccess::Public);

    let team: SessionMeta = serde_json::from_str(META_V1_WITH_TEAM)?;
    let cloud = team.cloud.clone().ok_or("fixture must carry cloud")?;
    assert_eq!(cloud.access(), CloudAccess::Team);
    assert_eq!(cloud.team_name.as_deref(), Some("Databend"));

    // Current writer, legacy reader: a team session reads as plain private,
    // so an old build narrows access rather than failing or widening it.
    let written = serde_json::to_string(&team)?;
    let legacy: LegacyMetaWithCloud = serde_json::from_str(&written)?;
    assert_eq!(legacy.cloud.visibility, LegacyVisibility::Private);
    assert_eq!(legacy.cloud.synced_seq, 4);

    // Sessions without a team page write exactly what they did before.
    let mut plain = CloudSync::new(CloudVisibility::Private, "h");
    plain.set_access(CloudAccess::Private);
    let written = serde_json::to_string(&plain)?;
    assert!(!written.contains("team"));
    Ok(())
}

#[test]
fn cloud_access_round_trips_through_visibility_and_team() {
    let mut cloud = CloudSync::new(CloudVisibility::Private, "h");
    for access in [CloudAccess::Team, CloudAccess::Public, CloudAccess::Private] {
        cloud.set_access(access);
        assert_eq!(cloud.access(), access);
    }
    cloud.set_access(CloudAccess::Team);
    assert_eq!(cloud.visibility, CloudVisibility::Private);
    // Public wins over a stale flag.
    cloud.visibility = CloudVisibility::Public;
    assert_eq!(cloud.access(), CloudAccess::Public);
}

async fn one_entry_session(root: &TempDir) -> Result<Arc<dyn Storage>, Box<dyn std::error::Error>> {
    let storage = fs_storage(root)?;
    storage
        .save_session(SessionMeta::new("s1".into(), "/w".into(), "m".into()))
        .await?;
    storage.append_entry(user("s1", 1, "a")).await?;
    Ok(storage)
}

#[tokio::test]
async fn share_team_pushes_the_page_and_records_the_link() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = one_entry_session(&root).await?;
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .and(body_partial_json(
            json!({"visibility": "private", "team": true}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "seq": 1, "visibility": "private", "team": true,
            "team_url": "https://auto.evot.ai/team/abcdefghijklmnopqrstuv",
            "team_name": "Databend"
        })))
        .expect(2)
        .mount(&server)
        .await;
    let outcome =
        sync::share_session(&state, &storage, "s1", Some(CloudAccess::Team), "test").await?;
    let sync::PushOutcome::Synced { cloud, .. } = outcome else {
        return Err(format!("expected Synced, got {outcome:?}").into());
    };
    assert_eq!(cloud.access(), CloudAccess::Team);
    assert_eq!(cloud.team_name.as_deref(), Some("Databend"));
    let requests = server.received_requests().await.unwrap_or_default();
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body)?;
    // The team page is rendered from the same viewer document as public.
    assert!(body.get("viewer").is_some_and(|v| v.is_object()));

    // Background pushes keep asking for the team page.
    storage.append_entry(user("s1", 2, "b")).await?;
    sync::push_session(&state, &storage, "s1", "test", false).await?;
    let loaded = storage.get_session("s1").await?.ok_or("missing")?;
    let cloud = loaded.cloud.ok_or("missing cloud")?;
    assert_eq!(
        cloud.team_url.as_deref(),
        Some("https://auto.evot.ai/team/abcdefghijklmnopqrstuv")
    );
    server.verify().await;
    Ok(())
}

#[tokio::test]
async fn share_team_on_a_server_without_team_pages_is_an_error() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = one_entry_session(&root).await?;
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"seq": 1, "visibility": "private"})),
        )
        .mount(&server)
        .await;
    let error = sync::share_session(&state, &storage, "s1", Some(CloudAccess::Team), "test")
        .await
        .err()
        .ok_or("an old server must not look like success")?;
    assert!(error.to_string().contains("does not support team sharing"));
    // What the server acknowledged is what is recorded: private, no team.
    let loaded = storage.get_session("s1").await?.ok_or("missing")?;
    assert_eq!(loaded.cloud.map(|c| c.access()), Some(CloudAccess::Private));
    Ok(())
}

#[tokio::test]
async fn team_refusal_carries_the_server_reason() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = one_entry_session(&root).await?;
    Mock::given(method("PUT"))
        .and(path("/v1/sessions/s1"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({
            "error": "team sharing needs a team: this account is not in any group"
        })))
        .mount(&server)
        .await;
    let error = sync::share_session(&state, &storage, "s1", Some(CloudAccess::Team), "test")
        .await
        .err()
        .ok_or("expected a refusal")?;
    assert!(error.to_string().contains("not in any group"));
    Ok(())
}

#[tokio::test]
async fn pull_records_the_team_page() -> TestResult {
    let server = MockServer::start().await;
    let state = state(&server)?;
    let root = TempDir::new()?;
    let storage = fs_storage(&root)?;
    let remote_meta = SessionMeta::new("s9".into(), "/elsewhere".into(), "m".into());
    Mock::given(method("GET"))
        .and(path("/v1/sessions/s9"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "schema_version": 1, "meta": remote_meta, "seq": 1, "visibility": "private",
            "team": true, "team_url": "https://auto.evot.ai/team/t", "team_name": "Databend",
            "entries": [user("s9", 1, "hi")],
        })))
        .mount(&server)
        .await;
    let sync::PullOutcome::Pulled { meta, .. } = sync::pull_session(&state, &storage, "s9").await?
    else {
        return Err("expected Pulled".into());
    };
    let cloud = meta.cloud.ok_or("missing cloud")?;
    assert_eq!(cloud.access(), CloudAccess::Team);
    assert_eq!(
        cloud.team_url.as_deref(),
        Some("https://auto.evot.ai/team/t")
    );
    Ok(())
}
