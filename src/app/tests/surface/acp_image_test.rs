//! ACP clients such as T3 send pasted images only when the agent advertises
//! `promptCapabilities.image`; otherwise the turn fails before reaching evot.

use std::sync::Arc;

use agent_client_protocol_schema::v1 as acp;
use evot::agent::ToolMode;
use evot_engine::provider::MockProvider;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use evot_engine::Content;
use evot_engine::ImageSource;
use evot_engine::Message;
use parking_lot::Mutex;
use serde_json::json;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::acp_test::config;
use super::acp_test::Client;
use super::acp_test::TestResult;

/// 1×1 PNG.
const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/// Records the messages each model call receives, then answers like `MockProvider`.
struct Recording {
    calls: Arc<Mutex<Vec<Vec<Message>>>>,
    inner: MockProvider,
}

#[async_trait::async_trait]
impl StreamProvider for Recording {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.calls.lock().push(config.messages.clone());
        self.inner.stream(config, tx, cancel).await
    }
}

async fn start(
    tmp: &TempDir,
) -> Result<(Client, Arc<Mutex<Vec<Vec<Message>>>>), Box<dyn std::error::Error>> {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let provider = Recording {
        calls: calls.clone(),
        inner: MockProvider::text("seen"),
    };
    let (client, _) = Client::start_config(tmp, config(tmp), ToolMode::Chat, false, provider)?;
    Ok((client, calls))
}

async fn new_session(
    client: &mut Client,
    tmp: &TempDir,
) -> Result<String, Box<dyn std::error::Error>> {
    let (response, _) = client
        .request("session/new", json!({"cwd": tmp.path(), "mcpServers": []}))
        .await?;
    Ok(response["result"]["sessionId"]
        .as_str()
        .ok_or("sessionId")?
        .to_string())
}

#[tokio::test]
async fn initialize_advertises_image_prompts() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, _) = start(&tmp).await?;
    let (response, _) = client
        .request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": {}, "clientInfo": {"name": "t3", "version": "1"}}),
        )
        .await?;
    let result: acp::InitializeResponse = serde_json::from_value(response["result"].clone())?;
    let prompt = &result.agent_capabilities.prompt_capabilities;
    assert!(prompt.image, "{response}");
    // Only images are added; audio and embedded binaries stay unadvertised.
    assert!(!prompt.audio && !prompt.embedded_context, "{response}");
    client.close().await
}

#[tokio::test]
async fn pasted_image_reaches_the_model_as_an_image() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, calls) = start(&tmp).await?;
    let session_id = new_session(&mut client, &tmp).await?;
    // T3 declares the type from the file name; the bytes are a PNG.
    let (response, _) = client
        .request(
            "session/prompt",
            json!({"sessionId": session_id, "prompt": [
                {"type": "text", "text": "what is in this picture?"},
                {"type": "image", "mimeType": "image/jpeg", "data": PNG},
            ]}),
        )
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");

    let messages = calls
        .lock()
        .first()
        .cloned()
        .ok_or("model was not called")?;
    let content = messages
        .iter()
        .rev()
        .find_map(|message| match message {
            Message::User { content, .. } => Some(content.clone()),
            _ => None,
        })
        .ok_or("no user message")?;
    assert!(content.iter().any(
        |block| matches!(block, Content::Text { text } if text == "what is in this picture?")
    ));
    let (mime_type, data) = content
        .iter()
        .find_map(|block| match block {
            Content::Image {
                mime_type,
                source: ImageSource::Base64 { data },
            } => Some((mime_type.clone(), data.clone())),
            _ => None,
        })
        .ok_or("image was not forwarded")?;
    assert_eq!(mime_type, "image/png");
    assert!(!data.is_empty());
    client.close().await
}

#[tokio::test]
async fn malformed_images_are_refused_without_calling_the_model() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, calls) = start(&tmp).await?;
    let session_id = new_session(&mut client, &tmp).await?;
    for data in ["not base64!", "AA==", ""] {
        let (response, _) = client
            .request(
                "session/prompt",
                json!({"sessionId": session_id, "prompt": [
                    {"type": "image", "mimeType": "image/png", "data": data},
                ]}),
            )
            .await?;
        assert_eq!(response["error"]["code"], -32602, "{data:?}: {response}");
    }
    // Audio stays refused.
    let (response, _) = client
        .request(
            "session/prompt",
            json!({"sessionId": session_id, "prompt": [
                {"type": "audio", "mimeType": "audio/wav", "data": "AA=="},
            ]}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32602, "{response}");
    assert!(calls.lock().is_empty());
    client.close().await
}
