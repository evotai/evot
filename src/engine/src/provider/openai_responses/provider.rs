//! OpenAI Responses API provider.

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::debug;

use super::request;
use super::sse_decode;
use crate::provider::error::ProviderError;
use crate::provider::model::ModelConfig;
use crate::provider::stream::http;
use crate::provider::traits::*;

pub struct OpenAiResponsesProvider;

#[async_trait]
impl StreamProvider for OpenAiResponsesProvider {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.stream_sink(
            config,
            crate::provider::stream::sink::StreamSink::Legacy(tx),
            cancel,
        )
        .await
    }

    async fn stream_bounded(
        &self,
        config: StreamConfig,
        tx: mpsc::Sender<StreamEvent>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.stream_sink(
            config,
            crate::provider::stream::sink::StreamSink::Bounded {
                tx,
                cancel: cancel.clone(),
            },
            cancel,
        )
        .await
    }
}

impl OpenAiResponsesProvider {
    async fn stream_sink(
        &self,
        config: StreamConfig,
        tx: crate::provider::stream::sink::StreamSink,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        let model_config = config.model_config.as_ref().ok_or_else(|| {
            ProviderError::Other("ModelConfig required for OpenAI Responses provider".into())
        })?;
        let url = format!(
            "{}/responses",
            model_config.base_url().trim_end_matches('/')
        );
        let body = request::build_request_body(&config);
        debug!(
            "OpenAI Responses request: model={} url={}",
            config.model, url
        );

        let mut response = send(&url, model_config, &config, body).await?;

        // A native compaction blob can become invalid after an upstream account
        // or compatibility boundary. On semantic client rejection, retry once
        // with the readable fallback carried beside the blob. Auth/routing
        // errors are not replay failures and are left to normal retry handling.
        if matches!(response.status().as_u16(), 400 | 422) {
            let (messages, found) = super::replay::downgrade_replay_messages(&config.messages);
            if found {
                tracing::warn!(
                    status = response.status().as_u16(),
                    "Responses rejected remote compaction replay; retrying with local summary"
                );
                let mut fallback = config.clone();
                fallback.messages = messages;
                let fallback_body = request::build_request_body(&fallback);
                response = send(&url, model_config, &fallback, fallback_body).await?;
            }
        }

        let response = http::check_error_status(response).await?;
        match http::classify_response(&response) {
            http::StreamResponseKind::Streaming => {
                sse_decode::decode_sse_stream(response, tx, cancel, &config).await
            }
            http::StreamResponseKind::Json => Err(ProviderError::Api(
                "OpenAI Responses returned JSON for a streaming request".into(),
            )),
            http::StreamResponseKind::Other(content_type) => Err(ProviderError::Api(format!(
                "Unexpected content type from OpenAI Responses endpoint: {content_type}"
            ))),
        }
    }
}

async fn send(
    url: &str,
    model_config: &ModelConfig,
    config: &StreamConfig,
    body: serde_json::Value,
) -> Result<reqwest::Response, ProviderError> {
    let client = config.http_client()?;
    let mut builder = client
        .post(url)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", config.api_key));
    // Preserve session identity even when the body omits prompt_cache_key.
    if let Some(session_id) = config.prompt_cache_key.as_deref() {
        if !session_id.is_empty() {
            builder = builder.header("session-id", session_id);
        }
    }
    for (key, value) in model_config.headers() {
        builder = builder.header(key, value);
    }
    http::send_json_stream_request(builder, url, body).await
}
