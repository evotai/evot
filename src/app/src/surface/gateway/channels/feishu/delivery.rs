use async_trait::async_trait;

use super::config::FEISHU_API;
use super::config::FEISHU_MAX_MESSAGE_LEN;
use super::token::get_token;
use super::token::is_token_error;
use super::token::TokenCache;
use crate::base::error::EvotError;
use crate::base::error::Result;
use crate::surface::delivery::DeliveryCapabilities;
use crate::surface::delivery::MessageSink;

/// Send a text message to a Feishu chat, with automatic token retry.
pub async fn send_text(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    chat_id: &str,
    text: &str,
) -> Result<String> {
    let url = format!("{FEISHU_API}/im/v1/messages?receive_id_type=chat_id");
    let content = serde_json::json!({ "text": text }).to_string();
    let body = serde_json::json!({
        "receive_id": chat_id,
        "msg_type": "text",
        "content": content,
    });

    let token = get_token(client, app_id, app_secret, token_cache).await?;
    let resp = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| EvotError::Run(format!("feishu send: {e}")))?;

    let status = resp.status().as_u16();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| EvotError::Run(format!("feishu send response: {e}")))?;

    // Retry once on token error
    if is_token_error(status, &json) {
        token_cache.invalidate().await;
        let token2 = get_token(client, app_id, app_secret, token_cache).await?;
        let resp2 = client
            .post(&url)
            .bearer_auth(&token2)
            .json(&body)
            .send()
            .await
            .map_err(|e| EvotError::Run(format!("feishu send retry: {e}")))?;
        let status2 = resp2.status().as_u16();
        let json2: serde_json::Value = resp2
            .json()
            .await
            .map_err(|e| EvotError::Run(format!("feishu send retry response: {e}")))?;
        if is_token_error(status2, &json2) {
            return Err(EvotError::Run(format!(
                "feishu token retry failed: HTTP {status2}"
            )));
        }
        check_api_error(&json2)?;
        return Ok(extract_message_id(&json2));
    }

    check_api_error(&json)?;
    Ok(extract_message_id(&json))
}

/// Reply to a message as a thread (topic), with automatic token retry.
pub async fn reply_text(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    message_id: &str,
    text: &str,
) -> Result<String> {
    let url = format!("{FEISHU_API}/im/v1/messages/{message_id}/reply");
    let content = serde_json::json!({ "text": text }).to_string();
    let body = serde_json::json!({
        "msg_type": "text",
        "content": content,
        "reply_in_thread": "true",
    });

    let token = get_token(client, app_id, app_secret, token_cache).await?;
    let resp = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| EvotError::Run(format!("feishu reply: {e}")))?;

    let status = resp.status().as_u16();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| EvotError::Run(format!("feishu reply response: {e}")))?;

    if is_token_error(status, &json) {
        token_cache.invalidate().await;
        let token2 = get_token(client, app_id, app_secret, token_cache).await?;
        let resp2 = client
            .post(&url)
            .bearer_auth(&token2)
            .json(&body)
            .send()
            .await
            .map_err(|e| EvotError::Run(format!("feishu reply retry: {e}")))?;
        let status2 = resp2.status().as_u16();
        let json2: serde_json::Value = resp2
            .json()
            .await
            .map_err(|e| EvotError::Run(format!("feishu reply retry response: {e}")))?;
        if is_token_error(status2, &json2) {
            return Err(EvotError::Run(format!(
                "feishu reply token retry failed: HTTP {status2}"
            )));
        }
        check_api_error(&json2)?;
        return Ok(extract_message_id(&json2));
    }

    check_api_error(&json)?;
    Ok(extract_message_id(&json))
}
pub async fn add_reaction(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    message_id: &str,
    emoji_type: &str,
) {
    let token = match get_token(client, app_id, app_secret, token_cache).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(channel = "feishu", error = %e, "failed to get token for reaction");
            return;
        }
    };
    let url = format!("{FEISHU_API}/im/v1/messages/{message_id}/reactions");
    let body = serde_json::json!({
        "reaction_type": { "emoji_type": emoji_type }
    });
    match client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => {
            if !resp.status().is_success() {
                let body = resp.text().await.unwrap_or_default();
                tracing::warn!(
                    channel = "feishu",
                    message_id,
                    emoji_type,
                    body,
                    "reaction failed"
                );
            }
        }
        Err(e) => {
            tracing::warn!(channel = "feishu", error = %e, message_id, "reaction request failed");
        }
    }
}

fn check_api_error(body: &serde_json::Value) -> Result<()> {
    let code = body["code"].as_i64().unwrap_or(0);
    if code != 0 {
        let msg = body["msg"].as_str().unwrap_or("unknown");
        return Err(EvotError::Run(format!(
            "feishu API error: code={code}, msg={msg}"
        )));
    }
    Ok(())
}

fn extract_message_id(json: &serde_json::Value) -> String {
    json["data"]["message_id"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

// ── Fetch message text (for reply context) ──

// ── Thread / chat history context ──

/// A single message extracted from a thread or chat history.
pub struct ThreadMessage {
    pub message_id: String,
    pub sender_id: Option<String>,
    pub root_id: Option<String>,
    pub create_time: i64,
    pub text: Option<String>,
    pub parts: Vec<super::message::MessagePart>,
}

/// Extract a `ThreadMessage` from a single message JSON object
/// (as returned by the Feishu messages API).
pub fn extract_thread_message(item: &serde_json::Value) -> Option<ThreadMessage> {
    let message_id = item.get("message_id").and_then(|v| v.as_str())?;
    let msg_type = item.get("msg_type").and_then(|v| v.as_str())?;
    let sender_id = item
        .pointer("/sender/id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let root_id = item
        .get("root_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let create_time = item
        .get("create_time")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

    let raw_content = item.pointer("/body/content").and_then(|v| v.as_str())?;
    let content: serde_json::Value = serde_json::from_str(raw_content).ok()?;

    let (text, parts) = match msg_type {
        "text" => {
            let t = content
                .get("text")
                .and_then(|v| v.as_str())
                .map(super::message::strip_at_placeholders)
                .filter(|s| !s.is_empty());
            let parts = t
                .as_ref()
                .map(|s| vec![super::message::MessagePart::Text(s.clone())])
                .unwrap_or_default();
            (t, parts)
        }
        "post" => {
            let parsed = super::message::parse_post(&content)?;
            let text = if parsed.text.is_empty() {
                None
            } else {
                Some(parsed.text)
            };
            (text, parsed.parts)
        }
        "image" => {
            let key = content
                .get("image_key")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())?;
            (None, vec![super::message::MessagePart::ImageKey(
                key.to_string(),
            )])
        }
        _ => return None,
    };

    // Skip empty messages
    if text.is_none() && parts.is_empty() {
        return None;
    }

    Some(ThreadMessage {
        message_id: message_id.to_string(),
        sender_id,
        root_id,
        create_time,
        text,
        parts,
    })
}

/// Fetch reply messages under a topic (thread).
/// Uses `container_id_type=thread` with the thread_id to get all messages.
/// Returns all messages in chronological order (oldest first).
pub async fn fetch_thread_messages(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    thread_id: &str,
) -> Result<Vec<ThreadMessage>> {
    let mut result = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let mut url = format!(
            "{FEISHU_API}/im/v1/messages?container_id_type=thread&container_id={thread_id}&page_size=50"
        );
        if let Some(ref pt) = page_token {
            url.push_str(&format!("&page_token={pt}"));
        }

        let token = get_token(client, app_id, app_secret, token_cache).await?;
        let resp = client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| EvotError::Run(format!("feishu fetch thread: {e}")))?;

        let status = resp.status().as_u16();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| EvotError::Run(format!("feishu fetch thread response: {e}")))?;

        let json = if is_token_error(status, &json) {
            token_cache.invalidate().await;
            let token2 = get_token(client, app_id, app_secret, token_cache).await?;
            let resp2 = client
                .get(&url)
                .bearer_auth(&token2)
                .send()
                .await
                .map_err(|e| EvotError::Run(format!("feishu fetch thread retry: {e}")))?;
            let json2: serde_json::Value = resp2
                .json()
                .await
                .map_err(|e| EvotError::Run(format!("feishu fetch thread retry response: {e}")))?;
            check_api_error(&json2)?;
            json2
        } else {
            check_api_error(&json)?;
            json
        };

        if let Some(items) = json.pointer("/data/items").and_then(|v| v.as_array()) {
            for item in items {
                if let Some(msg) = extract_thread_message(item) {
                    result.push(msg);
                }
            }
        }

        let has_more = json
            .pointer("/data/has_more")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !has_more {
            break;
        }
        page_token = json
            .pointer("/data/page_token")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if page_token.is_none() {
            break;
        }
    }

    result.sort_by_key(|m| m.create_time);
    Ok(result)
}

/// Fetch recent chat history messages before `end_time`.
/// Returns up to `count` messages in chronological order (oldest first).
pub async fn fetch_chat_history(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    chat_id: &str,
    end_time: i64,
    count: usize,
) -> Result<Vec<ThreadMessage>> {
    let url = format!(
        "{FEISHU_API}/im/v1/messages?container_id_type=chat&container_id={chat_id}&end_time={end_time}&page_size={count}&sort_type=ByCreateTimeDesc"
    );

    let token = get_token(client, app_id, app_secret, token_cache).await?;
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| EvotError::Run(format!("feishu fetch chat history: {e}")))?;

    let status = resp.status().as_u16();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| EvotError::Run(format!("feishu fetch chat history response: {e}")))?;

    let json = if is_token_error(status, &json) {
        token_cache.invalidate().await;
        let token2 = get_token(client, app_id, app_secret, token_cache).await?;
        let resp2 = client
            .get(&url)
            .bearer_auth(&token2)
            .send()
            .await
            .map_err(|e| EvotError::Run(format!("feishu fetch chat history retry: {e}")))?;
        let json2: serde_json::Value = resp2.json().await.map_err(|e| {
            EvotError::Run(format!("feishu fetch chat history retry response: {e}"))
        })?;
        check_api_error(&json2)?;
        json2
    } else {
        check_api_error(&json)?;
        json
    };

    let mut messages = Vec::new();
    if let Some(items) = json.pointer("/data/items").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(msg) = extract_thread_message(item) {
                messages.push(msg);
            }
        }
    }

    // API returns newest first; sort by create_time for chronological order
    messages.sort_by_key(|m| m.create_time);
    Ok(messages)
}

// ── Fetch parent message content (for reply context) ──

/// Content extracted from a parent message.
pub struct ParentMessageContent {
    pub text: Option<String>,
    pub parts: Vec<super::message::MessagePart>,
    pub message_id: String,
}

/// Fetch the content of a message by ID, for reply context.
/// Returns text and/or image keys depending on message type.
pub async fn fetch_message_content(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    message_id: &str,
) -> Result<Option<ParentMessageContent>> {
    let url = format!("{FEISHU_API}/im/v1/messages/{message_id}");

    let token = get_token(client, app_id, app_secret, token_cache).await?;
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| EvotError::Run(format!("feishu fetch message: {e}")))?;

    let status = resp.status().as_u16();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| EvotError::Run(format!("feishu fetch message response: {e}")))?;

    // Retry once on token error
    if is_token_error(status, &json) {
        token_cache.invalidate().await;
        let token2 = get_token(client, app_id, app_secret, token_cache).await?;
        let resp2 = client
            .get(&url)
            .bearer_auth(&token2)
            .send()
            .await
            .map_err(|e| EvotError::Run(format!("feishu fetch message retry: {e}")))?;
        let json2: serde_json::Value = resp2
            .json()
            .await
            .map_err(|e| EvotError::Run(format!("feishu fetch message retry response: {e}")))?;
        check_api_error(&json2)?;
        return Ok(extract_content_from_message_response(&json2, message_id));
    }

    check_api_error(&json)?;
    Ok(extract_content_from_message_response(&json, message_id))
}

/// Fetch the `thread_id` for a message via GET /im/v1/messages/{id}.
/// The websocket event may omit `thread_id` on the first topic reply,
/// but the REST API always includes it once the thread is created.
pub async fn fetch_message_thread_id(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    message_id: &str,
) -> Result<Option<String>> {
    let url = format!("{FEISHU_API}/im/v1/messages/{message_id}");

    let token = get_token(client, app_id, app_secret, token_cache).await?;
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| EvotError::Run(format!("feishu fetch thread_id: {e}")))?;

    let status = resp.status().as_u16();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| EvotError::Run(format!("feishu fetch thread_id response: {e}")))?;

    if is_token_error(status, &json) {
        token_cache.invalidate().await;
        let token2 = get_token(client, app_id, app_secret, token_cache).await?;
        let resp2 = client
            .get(&url)
            .bearer_auth(&token2)
            .send()
            .await
            .map_err(|e| EvotError::Run(format!("feishu fetch thread_id retry: {e}")))?;
        let json2: serde_json::Value = resp2
            .json()
            .await
            .map_err(|e| EvotError::Run(format!("feishu fetch thread_id retry response: {e}")))?;
        check_api_error(&json2)?;
        return Ok(extract_thread_id(&json2));
    }

    check_api_error(&json)?;
    Ok(extract_thread_id(&json))
}

fn extract_thread_id(json: &serde_json::Value) -> Option<String> {
    json.pointer("/data/items/0/thread_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}
fn extract_content_from_message_response(
    json: &serde_json::Value,
    message_id: &str,
) -> Option<ParentMessageContent> {
    let item = json
        .pointer("/data/items")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())?;

    let msg_type = item.get("msg_type").and_then(|v| v.as_str())?;
    let raw_content = item.pointer("/body/content").and_then(|v| v.as_str())?;
    let content: serde_json::Value = serde_json::from_str(raw_content).ok()?;

    match msg_type {
        "text" => {
            let text = content
                .get("text")
                .and_then(|v| v.as_str())
                .map(super::message::strip_at_placeholders)
                .filter(|s| !s.is_empty());
            text.map(|t| ParentMessageContent {
                text: Some(t.clone()),
                parts: vec![super::message::MessagePart::Text(t)],
                message_id: message_id.to_string(),
            })
        }
        "post" => {
            let parsed = super::message::parse_post(&content)?;
            Some(ParentMessageContent {
                text: if parsed.text.is_empty() {
                    None
                } else {
                    Some(parsed.text)
                },
                parts: parsed.parts,
                message_id: message_id.to_string(),
            })
        }
        "image" => {
            let key = content
                .get("image_key")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())?;
            Some(ParentMessageContent {
                text: None,
                parts: vec![super::message::MessagePart::ImageKey(key.to_string())],
                message_id: message_id.to_string(),
            })
        }
        _ => None,
    }
}

// ── Download image ──

pub struct DownloadedImage {
    pub data_base64: String,
    pub mime_type: String,
}

pub async fn resolve_message_parts(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    message_id: &str,
    parts: &[super::message::MessagePart],
) -> Vec<evot_engine::Content> {
    let mut content = Vec::new();

    for part in parts {
        match part {
            super::message::MessagePart::Text(text) => {
                if !text.is_empty() {
                    content.push(evot_engine::Content::Text { text: text.clone() });
                }
            }
            super::message::MessagePart::ImageKey(image_key) => match download_image(
                client,
                token_cache,
                app_id,
                app_secret,
                message_id,
                image_key,
            )
            .await
            {
                Ok(img) => {
                    content.push(evot_engine::Content::Image {
                        mime_type: img.mime_type,
                        source: evot_engine::ImageSource::Base64 {
                            data: img.data_base64,
                        },
                    });
                }
                Err(e) => {
                    tracing::warn!(
                        channel = "feishu",
                        image_key,
                        error = %e,
                        "failed to download image"
                    );
                }
            },
        }
    }

    content
}

/// Download an image resource from a Feishu message.
pub async fn download_image(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    message_id: &str,
    image_key: &str,
) -> Result<DownloadedImage> {
    use base64::Engine;

    let url = format!("{FEISHU_API}/im/v1/messages/{message_id}/resources/{image_key}?type=image");

    let token = get_token(client, app_id, app_secret, token_cache).await?;
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| EvotError::Run(format!("feishu download image: {e}")))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        // Retry once on token error
        token_cache.invalidate().await;
        let token2 = get_token(client, app_id, app_secret, token_cache).await?;
        let resp2 = client
            .get(&url)
            .bearer_auth(&token2)
            .send()
            .await
            .map_err(|e| EvotError::Run(format!("feishu download image retry: {e}")))?;
        if !resp2.status().is_success() {
            return Err(EvotError::Run(format!(
                "feishu download image failed after retry: HTTP {}",
                resp2.status()
            )));
        }
        let mime_type = resp2
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .to_string();
        let bytes = resp2
            .bytes()
            .await
            .map_err(|e| EvotError::Run(format!("feishu download image body: {e}")))?;
        return Ok(DownloadedImage {
            data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            mime_type,
        });
    }

    if !status.is_success() {
        return Err(EvotError::Run(format!(
            "feishu download image failed: HTTP {status}"
        )));
    }

    let mime_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| EvotError::Run(format!("feishu download image body: {e}")))?;

    Ok(DownloadedImage {
        data_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime_type,
    })
}

// ── Edit message ──

async fn edit_text(
    client: &reqwest::Client,
    token_cache: &TokenCache,
    app_id: &str,
    app_secret: &str,
    message_id: &str,
    text: &str,
) -> Result<()> {
    let url = format!("{FEISHU_API}/im/v1/messages/{message_id}");
    let content = serde_json::json!({ "text": text }).to_string();
    let body = serde_json::json!({
        "msg_type": "text",
        "content": content,
    });

    let token = get_token(client, app_id, app_secret, token_cache).await?;
    let resp = client
        .put(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| EvotError::Run(format!("feishu edit: {e}")))?;

    let status = resp.status().as_u16();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| EvotError::Run(format!("feishu edit response: {e}")))?;

    if is_token_error(status, &json) {
        token_cache.invalidate().await;
        let token2 = get_token(client, app_id, app_secret, token_cache).await?;
        let resp2 = client
            .put(&url)
            .bearer_auth(&token2)
            .json(&body)
            .send()
            .await
            .map_err(|e| EvotError::Run(format!("feishu edit retry: {e}")))?;
        let json2: serde_json::Value = resp2
            .json()
            .await
            .map_err(|e| EvotError::Run(format!("feishu edit retry response: {e}")))?;
        check_api_error(&json2)?;
        return Ok(());
    }

    check_api_error(&json)?;
    Ok(())
}

// ── MessageSink ──

pub struct FeishuMessageSink {
    client: reqwest::Client,
    token_cache: TokenCache,
    app_id: String,
    app_secret: String,
    /// If set, the first `send_text` call will use the reply API (thread/topic)
    /// instead of sending a new message. Consumed after first use.
    reply_to: std::sync::Mutex<Option<String>>,
}

impl FeishuMessageSink {
    pub fn new(
        client: reqwest::Client,
        token_cache: TokenCache,
        app_id: String,
        app_secret: String,
    ) -> Self {
        Self {
            client,
            token_cache,
            app_id,
            app_secret,
            reply_to: std::sync::Mutex::new(None),
        }
    }

    /// Set the message ID to reply to as a thread (topic).
    /// Only affects the first `send_text` call.
    pub fn with_reply_to(self, message_id: String) -> Self {
        *self.reply_to.lock().unwrap_or_else(|e| e.into_inner()) = Some(message_id);
        self
    }

    /// Returns whether a reply target is still pending (not yet consumed).
    pub fn has_reply_to(&self) -> bool {
        self.reply_to
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}

#[async_trait]
impl MessageSink for FeishuMessageSink {
    fn capabilities(&self) -> DeliveryCapabilities {
        DeliveryCapabilities {
            can_edit: true,
            max_message_len: FEISHU_MAX_MESSAGE_LEN,
            max_edits_per_message: 20,
        }
    }

    async fn send_text(&self, chat_id: &str, text: &str) -> Result<String> {
        let target = self
            .reply_to
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();

        if let Some(ref message_id) = target {
            let result = reply_text(
                &self.client,
                &self.token_cache,
                &self.app_id,
                &self.app_secret,
                message_id,
                text,
            )
            .await;

            // Update reply_to to the new message ID so subsequent sends
            // stay inside the same thread/topic.
            match result {
                Ok(ref new_id) if !new_id.is_empty() => {
                    *self.reply_to.lock().unwrap_or_else(|e| e.into_inner()) = Some(new_id.clone());
                }
                Ok(_) => {
                    // Empty message ID — clear to avoid infinite retry on same target
                    self.reply_to
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take();
                }
                Err(_) => {
                    // Keep reply_to so next attempt retries into the thread
                }
            }

            return result;
        }

        send_text(
            &self.client,
            &self.token_cache,
            &self.app_id,
            &self.app_secret,
            chat_id,
            text,
        )
        .await
    }

    async fn edit_text(&self, _chat_id: &str, message_id: &str, text: &str) -> Result<()> {
        edit_text(
            &self.client,
            &self.token_cache,
            &self.app_id,
            &self.app_secret,
            message_id,
            text,
        )
        .await
    }
}
