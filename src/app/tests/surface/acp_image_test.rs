//! ACP clients such as T3 send pasted images only when the agent advertises
//! `promptCapabilities.image`; otherwise the turn fails before reaching evot.

use std::sync::Arc;

use agent_client_protocol_schema::v1 as acp;
use base64::Engine;
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
use serde_json::Value;
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::acp_test::config;
use super::acp_test::Client;
use super::acp_test::TestResult;

/// 1×1 PNG.
pub(super) const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

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

pub(super) async fn start(
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

pub(super) async fn new_session(
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
    assert_eq!(data, PNG);
    client.close().await
}

#[tokio::test]
async fn malformed_images_are_refused_without_calling_the_model() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, calls) = start(&tmp).await?;
    let session_id = new_session(&mut client, &tmp).await?;
    // Valid base64 and a recognizable header do not make a valid image.
    for data in [
        "not base64!",
        "AA==",
        "",
        "/9j/",
        "R0lGODlh",
        "iVBORw0KGgoAAAANSUhEUg==",
    ] {
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
    // Every rejected prompt releases admission; a valid image can follow.
    let (response, _) = client
        .request("session/prompt", image_prompt(&session_id, PNG))
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(calls.lock().len(), 1);
    client.close().await
}

pub(super) fn image_prompt(session: &str, data: &str) -> Value {
    json!({"sessionId": session, "prompt": [{"type": "image", "mimeType": "image/png", "data": data}]})
}

fn last_input(
    calls: &Arc<Mutex<Vec<Vec<Message>>>>,
) -> Result<Vec<Content>, Box<dyn std::error::Error>> {
    calls
        .lock()
        .last()
        .and_then(|messages| {
            messages.iter().rev().find_map(|message| match message {
                Message::User { content, .. } => Some(content.clone()),
                _ => None,
            })
        })
        .ok_or_else(|| "no user message reached the model".into())
}

#[tokio::test]
async fn mixed_text_and_multiple_images_keep_their_order() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, calls) = start(&tmp).await?;
    let session = new_session(&mut client, &tmp).await?;
    let red =
        base64::engine::general_purpose::STANDARD.encode(include_bytes!("../fixtures/acp/red.png"));
    let (response, _) = client
        .request(
            "session/prompt",
            json!({"sessionId": session, "prompt": [
                {"type": "text", "text": "first"},
                {"type": "image", "mimeType": "image/jpeg", "data": format!("  {red}\n")},
                {"type": "text", "text": "second"},
                {"type": "image", "mimeType": "image/png", "data": PNG},
                {"type": "text", "text": "compare"},
            ]}),
        )
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    assert_eq!(last_input(&calls)?, vec![
        Content::Text {
            text: "first".into()
        },
        Content::Image {
            mime_type: "image/png".into(),
            source: ImageSource::Base64 { data: red }
        },
        Content::Text {
            text: "second".into()
        },
        Content::Image {
            mime_type: "image/png".into(),
            source: ImageSource::Base64 { data: PNG.into() }
        },
        Content::Text {
            text: "compare".into()
        },
    ]);
    client.close().await
}

#[tokio::test]
async fn invalid_second_image_rejects_the_entire_prompt() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, calls) = start(&tmp).await?;
    let session = new_session(&mut client, &tmp).await?;
    let (response, _) = client
        .request(
            "session/prompt",
            json!({"sessionId": session, "prompt": [
                {"type": "text", "text": "must not be submitted separately"},
                {"type": "image", "mimeType": "image/png", "data": PNG},
                {"type": "image", "mimeType": "image/jpeg", "data": "/9j/"},
            ]}),
        )
        .await?;
    assert_eq!(response["error"]["code"], -32602, "{response}");
    assert!(calls.lock().is_empty());
    client.close().await
}

#[tokio::test]
async fn oversized_image_is_resized_before_reaching_the_model() -> TestResult {
    let tmp = TempDir::new()?;
    let (mut client, calls) = start(&tmp).await?;
    let session = new_session(&mut client, &tmp).await?;
    let wide = base64::engine::general_purpose::STANDARD
        .encode(include_bytes!("../fixtures/acp/wide.png"));
    let (response, _) = client
        .request("session/prompt", image_prompt(&session, &wide))
        .await?;
    assert_eq!(response["result"]["stopReason"], "end_turn", "{response}");
    let input = last_input(&calls)?;
    let Content::Image {
        mime_type,
        source: ImageSource::Base64 { data },
    } = &input[0]
    else {
        return Err("image was not forwarded".into());
    };
    assert_eq!(mime_type, "image/jpeg");
    assert_ne!(data, &wide);
    assert!(data.len() <= 5 * 1024 * 1024);
    let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
    assert_eq!(jpeg_dimensions(&bytes)?, (2000, 1000));
    client.close().await
}

/// Read the output JPEG's SOF marker independently of the resize helper.
fn jpeg_dimensions(bytes: &[u8]) -> Result<(u16, u16), Box<dyn std::error::Error>> {
    if bytes.get(..2) != Some(&[0xff, 0xd8]) {
        return Err("not a JPEG".into());
    }
    let mut offset = 2;
    while let Some(header) = bytes.get(offset..offset + 4) {
        if header[0] != 0xff {
            break;
        }
        let length = u16::from_be_bytes([header[2], header[3]]) as usize;
        if length < 2 {
            break;
        }
        if matches!(header[1], 0xc0..=0xc2) {
            let dimensions = bytes.get(offset + 5..offset + 9).ok_or("truncated JPEG")?;
            return Ok((
                u16::from_be_bytes([dimensions[2], dimensions[3]]),
                u16::from_be_bytes([dimensions[0], dimensions[1]]),
            ));
        }
        offset += 2 + length;
    }
    Err("missing JPEG frame dimensions".into())
}
