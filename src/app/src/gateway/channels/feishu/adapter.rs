use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::delivery::FeishuMessageSink;
use super::token::TokenCache;
use crate::agent::run_manager::RunManager;
use crate::agent::run_manager::SendOutcome;
use crate::agent::Agent;
use crate::agent::QueryRequest;
use crate::agent::ToolMode;
use crate::conf::channels::FeishuChannelConfig;
use crate::delivery::stream as stream_delivery;
use crate::delivery::stream::StreamDeliveryConfig;
use crate::error::Result;
use crate::gateway::Channel;
use crate::sessions::SessionLocator;

pub struct FeishuChannel {
    config: FeishuChannelConfig,
    run_manager: Arc<RunManager>,
    client: reqwest::Client,
    token_cache: TokenCache,
    bot_open_id: tokio::sync::OnceCell<String>,
}

impl FeishuChannel {
    pub fn new(config: FeishuChannelConfig, run_manager: Arc<RunManager>) -> Self {
        Self {
            config,
            run_manager,
            client: reqwest::Client::new(),
            token_cache: TokenCache::new(),
            bot_open_id: tokio::sync::OnceCell::new(),
        }
    }

    pub fn spawn(
        conf: FeishuChannelConfig,
        run_manager: Arc<RunManager>,
        cancel: CancellationToken,
    ) -> JoinHandle<()> {
        let agent = run_manager.agent().clone();
        let ch = Arc::new(Self::new(conf, run_manager));
        tokio::spawn(async move {
            use crate::gateway::health::ConnectionState;
            use crate::gateway::health::{self};
            let key = health::credential_key(&ch.config.app_id, &ch.config.app_secret);
            health::set(&key, ConnectionState::Connecting, "Connecting to Feishu");
            tokio::select! {
                _ = cancel.cancelled() => {},
                result = ch.run(agent, cancel.clone()) => {
                    if result.is_err() {
                        health::set(&key, ConnectionState::Failed, "Connection failed. Check credentials, app permissions, and network.");
                        return;
                    }
                }
            }
            health::set(&key, ConnectionState::Stopped, "Connection stopped");
        })
    }

    /// The sink a reply goes out through: behind the privacy boundary, and
    /// threaded under the message in a group.
    fn reply_sink(
        &self,
        msg: &super::message::ParsedMessage,
    ) -> crate::privacy::ScrubbingSink<FeishuMessageSink> {
        let sink = FeishuMessageSink::new(
            self.client.clone(),
            self.token_cache.clone(),
            self.config.app_id.clone(),
            self.config.app_secret.clone(),
        );
        let sink = if msg.chat_type == "group" {
            sink.with_reply_to(msg.message_id.clone())
        } else {
            sink
        };
        crate::privacy::ScrubbingSink::new(sink)
    }

    async fn handle_message(
        self: &Arc<Self>,
        msg: super::message::ParsedMessage,
        bot_open_id: &str,
    ) {
        if msg.chat_type == "p2p" {
            if let Err(error) = super::state::remember_direct_chat(
                &self.config.app_id,
                &msg.sender_id,
                &msg.chat_id,
            ) {
                tracing::warn!(
                    channel = "feishu",
                    error = %error,
                    "failed to remember direct conversation"
                );
            }
        }

        // Resolve thread_id for topic messages.
        // The websocket event may not include thread_id on the first reply,
        // but the GET message API always has it. Fetch it if missing.
        let thread_id = if msg.thread_id.is_some() {
            msg.thread_id.clone()
        } else if msg.parent_id.is_some() {
            // This is a topic reply but ws didn't include thread_id yet.
            // Query the API to get the stable thread_id.
            match super::delivery::fetch_message_thread_id(
                &self.client,
                &self.token_cache,
                &self.config.app_id,
                &self.config.app_secret,
                &msg.message_id,
            )
            .await
            {
                Ok(Some(tid)) => Some(tid),
                Ok(None) => None,
                Err(e) => {
                    tracing::warn!(
                        channel = "feishu",
                        message_id = %msg.message_id,
                        error = %e,
                        "failed to fetch thread_id for message"
                    );
                    None
                }
            }
        } else {
            None
        };

        // Build locator: topic messages get their own session,
        // non-topic messages share a session per chat+user.
        let scope = if let Some(ref tid) = thread_id {
            format!("chat:{}:topic:{}", msg.chat_id, tid)
        } else {
            format!("chat:{}:user:{}", msg.chat_id, msg.sender_id)
        };
        let locator = SessionLocator::new("feishu", &scope);
        tracing::info!(
            channel = "feishu",
            scope = %scope,
            session_id = %locator.session_id(),
            "received message"
        );

        // Spawn so we don't block the websocket receive loop
        let this = Arc::clone(self);
        let bot_open_id = bot_open_id.to_string();
        tokio::spawn(async move {
            let mut input: Vec<evot_engine::Content> = Vec::new();

            // Determine if this message is in a topic (thread)
            let parent_id = msg.parent_id.as_deref();

            if thread_id.is_some() || msg.root_id.is_some() || parent_id.is_some() {
                // ── Topic context: root message + thread replies ──

                // Fetch root message content if we have parent_id
                if let Some(pid) = parent_id {
                    match super::delivery::fetch_message_content(
                        &this.client,
                        &this.token_cache,
                        &this.config.app_id,
                        &this.config.app_secret,
                        pid,
                    )
                    .await
                    {
                        Ok(Some(parent)) => {
                            if let Some(quoted) = parent.text {
                                input.push(evot_engine::Content::Text {
                                    text: format!("[Topic root]: {quoted}"),
                                });
                            }
                            // Only download images from root (text already added above)
                            for part in &parent.parts {
                                if let super::message::MessagePart::ImageKey(image_key) = part {
                                    match super::delivery::download_image(
                                        &this.client,
                                        &this.token_cache,
                                        &this.config.app_id,
                                        &this.config.app_secret,
                                        &parent.message_id,
                                        image_key,
                                    )
                                    .await
                                    {
                                        Ok(img) => {
                                            input.push(evot_engine::Content::Image {
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
                                                "failed to download root image"
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(e) => {
                            tracing::warn!(
                                channel = "feishu",
                                parent_id = pid,
                                error = %e,
                                "failed to fetch topic root message"
                            );
                        }
                    }
                }

                // Fetch thread replies.
                // Primary: use thread_id (omt_xxx) with container_id_type=thread.
                // Fallback: if no thread_id, use chat history filtered by root_id.
                let topic_replies = if let Some(ref tid) = thread_id {
                    super::delivery::fetch_thread_messages(
                        &this.client,
                        &this.token_cache,
                        &this.config.app_id,
                        &this.config.app_secret,
                        tid,
                    )
                    .await
                } else {
                    // Fallback: fetch chat history and filter by root_id/parent_id
                    let topic_root = msg.root_id.as_deref().or(parent_id);
                    match topic_root {
                        Some(rid) => super::delivery::fetch_chat_history(
                            &this.client,
                            &this.token_cache,
                            &this.config.app_id,
                            &this.config.app_secret,
                            &msg.chat_id,
                            msg.create_time,
                            50,
                        )
                        .await
                        .map(|msgs| {
                            msgs.into_iter()
                                .filter(|m| {
                                    m.root_id.as_deref() == Some(rid) || m.message_id == rid
                                })
                                .collect()
                        }),
                        None => Ok(Vec::new()),
                    }
                };

                match topic_replies {
                    Ok(replies) => {
                        // Filter: exclude current message and messages after it
                        let mut filtered: Vec<_> = replies
                            .into_iter()
                            .filter(|r| {
                                r.message_id != msg.message_id
                                    && (msg.create_time == 0 || r.create_time <= msg.create_time)
                            })
                            .collect();

                        // Keep only the most recent 50
                        if filtered.len() > 50 {
                            filtered = filtered.split_off(filtered.len() - 50);
                        }

                        // Count images across replies; limit to 10 (prefer most recent)
                        let total_images: usize = filtered
                            .iter()
                            .flat_map(|r| &r.parts)
                            .filter(|p| matches!(p, super::message::MessagePart::ImageKey(_)))
                            .count();
                        let mut images_to_skip = total_images.saturating_sub(10);

                        for reply in &filtered {
                            if let Some(ref text) = reply.text {
                                input.push(evot_engine::Content::Text {
                                    text: format!("[Topic reply]: {text}"),
                                });
                            }
                            // Resolve parts, skipping oldest images beyond limit
                            for part in &reply.parts {
                                match part {
                                    super::message::MessagePart::Text(_) => {
                                        // Text already added via reply.text label above
                                    }
                                    super::message::MessagePart::ImageKey(image_key) => {
                                        if images_to_skip > 0 {
                                            images_to_skip -= 1;
                                            continue;
                                        }
                                        match super::delivery::download_image(
                                            &this.client,
                                            &this.token_cache,
                                            &this.config.app_id,
                                            &this.config.app_secret,
                                            &reply.message_id,
                                            image_key,
                                        )
                                        .await
                                        {
                                            Ok(img) => {
                                                input.push(evot_engine::Content::Image {
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
                                                    "failed to download thread image"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            channel = "feishu",
                            error = %e,
                            "failed to fetch thread replies"
                        );
                    }
                }
            } else if msg.chat_type == "group" {
                // ── Chat history context: recent messages before current ──
                match super::delivery::fetch_chat_history(
                    &this.client,
                    &this.token_cache,
                    &this.config.app_id,
                    &this.config.app_secret,
                    &msg.chat_id,
                    msg.create_time,
                    30,
                )
                .await
                {
                    Ok(history) => {
                        let filtered: Vec<_> = history
                            .into_iter()
                            .filter(|m| {
                                m.message_id != msg.message_id
                                    && m.sender_id.as_deref() != Some(&bot_open_id)
                            })
                            .collect();

                        if !filtered.is_empty() {
                            input.push(evot_engine::Content::Text {
                                text: "[Chat history]".to_string(),
                            });
                            for m in &filtered {
                                if let Some(ref text) = m.text {
                                    input.push(evot_engine::Content::Text {
                                        text: format!("[Chat message]: {text}"),
                                    });
                                }
                                // No image download for chat history — text only
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            channel = "feishu",
                            chat_id = %msg.chat_id,
                            error = %e,
                            "failed to fetch chat history, degrading to current message only"
                        );
                    }
                }
            }

            input.extend(
                super::delivery::resolve_message_parts(
                    &this.client,
                    &this.token_cache,
                    &this.config.app_id,
                    &this.config.app_secret,
                    &msg.message_id,
                    &msg.parts,
                )
                .await,
            );

            if input.is_empty() {
                return;
            }

            let request = QueryRequest::with_input(input).mode(ToolMode::Headless);
            match this.run_manager.send(&locator, request).await {
                Ok(SendOutcome::Command(text)) => {
                    let sink = this.reply_sink(&msg);
                    let _ =
                        crate::delivery::MessageSink::send_text(&sink, &msg.chat_id, &text).await;
                }
                Ok(SendOutcome::Started(mut run)) => {
                    let sink = this.reply_sink(&msg);
                    let config = StreamDeliveryConfig::default();
                    if let Err(e) =
                        stream_delivery::deliver(&sink, &msg.chat_id, &mut run, &config).await
                    {
                        tracing::error!(channel = "feishu", error = %e, "delivery failed");
                    }
                }
                Ok(SendOutcome::Steered) => {
                    // Message routed to active run — nothing to deliver
                }
                Err(e) => {
                    tracing::error!(channel = "feishu", error = %e, "agent query failed");
                    let sink = this.reply_sink(&msg);
                    let _ = crate::delivery::MessageSink::send_text(
                        &sink,
                        &msg.chat_id,
                        &format!("Error: {e}"),
                    )
                    .await;
                }
            }
        });
    }
}

#[async_trait]
impl Channel for FeishuChannel {
    fn name(&self) -> &'static str {
        "feishu"
    }

    // NOTE: `_agent` is unused — FeishuChannel holds a RunManager (injected at
    // construction) which owns the Agent reference. The parameter is kept to
    // satisfy the generic Channel trait; this is a known trait-reuse trade-off.
    async fn run(self: Arc<Self>, _agent: Arc<Agent>, cancel: CancellationToken) -> Result<()> {
        let mut initialization_attempt = 0u32;
        let bot_open_id = loop {
            let result = self
                .bot_open_id
                .get_or_try_init(|| async {
                    super::token::fetch_bot_open_id(
                        &self.client,
                        &self.config.app_id,
                        &self.config.app_secret,
                        &self.token_cache,
                    )
                    .await
                })
                .await;
            match result {
                Ok(id) => break id,
                Err(_) => {
                    // Initialization can fail due to temporary transport errors,
                    // not only bad credentials. Keep retry ownership in the
                    // adapter so an unchanged config recovers without restart.
                    initialization_attempt = initialization_attempt.saturating_add(1);
                    let key = crate::gateway::health::credential_key(
                        &self.config.app_id,
                        &self.config.app_secret,
                    );
                    crate::gateway::health::set(&key, crate::gateway::health::ConnectionState::Retrying,
                        "Could not initialize Feishu. Check credentials, permissions and network; retrying.");
                    let delay = Duration::from_secs(
                        2u64.saturating_pow(initialization_attempt.min(6)).min(60),
                    );
                    tokio::select! {
                        _ = cancel.cancelled() => return Ok(()),
                        _ = tokio::time::sleep(delay) => {},
                    }
                }
            }
        };

        let mut attempt: u32 = 0;
        loop {
            if cancel.is_cancelled() {
                break;
            }

            let self_ref = self.clone();
            let ctx = super::ws::WsContext {
                client: &self.client,
                app_id: &self.config.app_id,
                app_secret: &self.config.app_secret,
                token_cache: &self.token_cache,
                config: &self.config,
                bot_open_id,
            };
            let result = super::ws::ws_receive_loop(&ctx, &cancel, |msg| {
                let self_inner = self_ref.clone();
                let bot_id = bot_open_id.to_string();
                async move {
                    self_inner.handle_message(msg, &bot_id).await;
                }
            })
            .await;

            if cancel.is_cancelled() {
                break;
            }

            match result {
                Ok(()) => {
                    tracing::info!(channel = "feishu", "websocket closed cleanly, reconnecting");
                    attempt = 0;
                }
                Err(e) => {
                    let key = crate::gateway::health::credential_key(
                        &self.config.app_id,
                        &self.config.app_secret,
                    );
                    crate::gateway::health::set(&key, crate::gateway::health::ConnectionState::Retrying, "Reconnecting. Check persistent-connection event subscriptions and network.");
                    tracing::warn!(channel = "feishu", error = %e, attempt, "websocket error");
                    attempt = attempt.saturating_add(1);
                }
            }

            // Exponential backoff: 1s, 2s, 4s, 8s, ... max 60s
            let backoff = Duration::from_secs(
                1u64.saturating_mul(2u64.saturating_pow(attempt.min(6)))
                    .min(60),
            );

            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(backoff) => {}
            }
        }

        Ok(())
    }
}
