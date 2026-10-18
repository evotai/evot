use std::sync::Arc;
use std::time::Duration;

use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamProvider;
use evot_engine::Content;
use evot_engine::Message;
use evot_engine::StopReason;
use tokio_util::sync::CancellationToken;

use super::candidates::validated;
use super::prompt::prompt_config;
use super::stream::CandidateStream;
use super::stream::SuggestionListener;
use super::SuggestionEndpoint;
use super::SuggestionHints;
use super::SuggestionMessage;
use super::SuggestionOutcome;
use super::SuggestionStatus;

// Allow cold connections and slow gateways up to 30 seconds. This is a hard
// ceiling, not a display delay: results appear immediately and input cancels
// instantly. Foreground interaction never waits for this request. Transport
// failures can still return earlier; they are not this local deadline.
pub const SUGGESTION_TIMEOUT: Duration = Duration::from_secs(30);

/// Single bounded request; deliberately not an agent run. No retries, tools,
/// compaction, transcript writes, main-model fallback or auth-refresh traffic.
pub async fn generate(
    messages: Vec<SuggestionMessage>,
    hints: SuggestionHints,
    cancel: CancellationToken,
) -> SuggestionOutcome {
    generate_with_updates(messages, hints, cancel, None).await
}

pub async fn generate_with_updates(
    messages: Vec<SuggestionMessage>,
    hints: SuggestionHints,
    cancel: CancellationToken,
    listener: Option<SuggestionListener>,
) -> SuggestionOutcome {
    let started = std::time::Instant::now();
    let work = async {
        let Some(endpoint) = super::endpoint::current().await else {
            tracing::debug!(target: "evot::suggestion", outcome = "not_published");
            return SuggestionOutcome::status(SuggestionStatus::Unavailable);
        };
        let Some(protocol) = endpoint.parsed_protocol() else {
            return SuggestionOutcome::status(SuggestionStatus::Unavailable);
        };
        let provider: Arc<dyn StreamProvider> = match protocol {
            crate::conf::Protocol::Anthropic => Arc::new(evot_engine::provider::AnthropicProvider),
            crate::conf::Protocol::OpenAi => Arc::new(evot_engine::provider::OpenAiCompatProvider),
            crate::conf::Protocol::OpenAiResponses => {
                Arc::new(evot_engine::provider::OpenAiResponsesProvider)
            }
        };
        sample_with_updates(
            &endpoint,
            &messages,
            &hints,
            provider,
            cancel.clone(),
            listener,
        )
        .await
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => SuggestionOutcome::default(),
        result = tokio::time::timeout(SUGGESTION_TIMEOUT, work) => match result {
            Ok(result) => result,
            Err(_) => {
                tracing::info!(target: "evot::suggestion", outcome = "timeout", elapsed_ms = started.elapsed().as_millis());
                SuggestionOutcome::status(SuggestionStatus::TimedOut)
            }
        },
    }
}

/// Candidate-only convenience API; interactive callers use sample_outcome to
/// distinguish an empty prediction from a failed transport.
pub async fn sample(
    endpoint: &SuggestionEndpoint,
    messages: &[SuggestionMessage],
    hints: &SuggestionHints,
    provider: Arc<dyn StreamProvider>,
    cancel: CancellationToken,
) -> Vec<String> {
    sample_outcome(endpoint, messages, hints, provider, cancel)
        .await
        .candidates
}

pub async fn sample_outcome(
    endpoint: &SuggestionEndpoint,
    messages: &[SuggestionMessage],
    hints: &SuggestionHints,
    provider: Arc<dyn StreamProvider>,
    cancel: CancellationToken,
) -> SuggestionOutcome {
    sample_with_updates(endpoint, messages, hints, provider, cancel, None).await
}

pub async fn sample_with_updates(
    endpoint: &SuggestionEndpoint,
    messages: &[SuggestionMessage],
    hints: &SuggestionHints,
    provider: Arc<dyn StreamProvider>,
    cancel: CancellationToken,
    listener: Option<SuggestionListener>,
) -> SuggestionOutcome {
    let started = std::time::Instant::now();
    let deadline = tokio::time::sleep(SUGGESTION_TIMEOUT);
    tokio::pin!(deadline);
    let mut prepared = None;
    if !hints.images.is_empty() {
        if !super::images::valid(hints) {
            return SuggestionOutcome::status(SuggestionStatus::Failed);
        }
        let mut owned = hints.clone();
        let images = std::mem::take(&mut owned.images);
        owned.images = tokio::select! {
            biased;
            _ = cancel.cancelled() => return SuggestionOutcome::default(),
            _ = &mut deadline => return SuggestionOutcome::status(SuggestionStatus::TimedOut),
            result = super::images::prepare(images) => match result {
                Ok(images) => images,
                Err(_) => return SuggestionOutcome::status(SuggestionStatus::Failed),
            },
        };
        prepared = Some(owned);
    }
    let hints = prepared.as_ref().unwrap_or(hints);
    let Some(config) = prompt_config(endpoint, messages, hints) else {
        tracing::debug!(target: "evot::suggestion", outcome = "insufficient_context");
        return if hints.images.is_empty() {
            SuggestionOutcome::default()
        } else {
            SuggestionOutcome::status(SuggestionStatus::Failed)
        };
    };
    let draft = hints.draft();
    let mut progress = CandidateStream::new(messages, hints, listener);
    // Counts only: never log conversation text, draft contents or secrets.
    tracing::debug!(target: "evot::suggestion", stage = "request", messages = config.messages.len() - 1,
        draft_chars = draft.map_or(0, |text| text.chars().count()));
    let child = cancel.child_token();
    let _guard = child.clone().drop_guard();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let call = provider.stream(config, tx, child);
    tokio::pin!(call);
    let mut first_text_ms = None;
    let mut first_candidate_ms = None;
    let outcome = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return SuggestionOutcome::default(),
            _ = &mut deadline => {
                tracing::info!(target: "evot::suggestion", outcome = "timeout", elapsed_ms = started.elapsed().as_millis());
                return SuggestionOutcome::status(SuggestionStatus::TimedOut);
            },
            result = &mut call => match result {
                Ok(outcome) => break outcome,
                Err(error) => {
                    // Error bodies can echo credentials or conversation text.
                    tracing::info!(target: "evot::suggestion", outcome = "provider_error", error_kind = error_kind(&error), elapsed_ms = started.elapsed().as_millis());
                    return SuggestionOutcome::status(SuggestionStatus::Failed);
                }
            },
            Some(event) = rx.recv() => match event {
                StreamEvent::TextDelta { delta, .. } => {
                    if !delta.is_empty() { first_text_ms.get_or_insert(started.elapsed().as_millis()); }
                    if progress.push(&delta) && first_candidate_ms.is_none() {
                        let elapsed = started.elapsed().as_millis();
                        first_candidate_ms = Some(elapsed);
                        tracing::info!(target: "evot::suggestion", stage = "first_candidate", elapsed_ms = elapsed);
                    }
                }
                StreamEvent::ToolCallStart { .. } | StreamEvent::Error { .. } => {
                    return SuggestionOutcome::status(SuggestionStatus::Failed);
                }
                _ => {},
            },
        }
    };
    let Message::Assistant {
        content,
        stop_reason: StopReason::Stop,
        ..
    } = outcome.into_message()
    else {
        tracing::info!(target: "evot::suggestion", outcome = "incomplete", elapsed_ms = started.elapsed().as_millis());
        return SuggestionOutcome::status(SuggestionStatus::Failed);
    };
    let mut text = String::new();
    for block in content {
        match block {
            Content::Text { text: part } => text.push_str(&part),
            Content::ToolCall { .. } => return SuggestionOutcome::status(SuggestionStatus::Failed),
            _ => {}
        }
    }
    let candidates = validated(&text, messages, hints);
    if !candidates.is_empty() {
        first_candidate_ms.get_or_insert(started.elapsed().as_millis());
    }
    progress.finish(&candidates);
    let outcome = if !candidates.is_empty() {
        "suggested"
    } else if text.trim().is_empty() || text.trim().eq_ignore_ascii_case("NONE") {
        "no_obvious_next_step"
    } else {
        "filtered"
    };
    tracing::info!(target: "evot::suggestion", outcome, count = candidates.len(),
        first_text_ms = ?first_text_ms, first_candidate_ms = ?first_candidate_ms,
        elapsed_ms = started.elapsed().as_millis());
    let status = if candidates.is_empty() {
        SuggestionStatus::Empty
    } else {
        SuggestionStatus::Ready
    };
    SuggestionOutcome { candidates, status }
}

/// Only classification, never the upstream error body.
fn error_kind(error: &ProviderError) -> &'static str {
    match error {
        ProviderError::Api(_) => "api",
        ProviderError::Transient { .. } => "transient",
        ProviderError::Overloaded(_) => "overloaded",
        ProviderError::Network(_) => "network",
        ProviderError::ProtocolIncomplete(_) => "protocol_incomplete",
        ProviderError::Auth(_) => "auth",
        ProviderError::ModelNotFound(_) => "model_not_found",
        ProviderError::InvalidRequest(_) => "invalid_request",
        ProviderError::RateLimited { .. } => "rate_limited",
        ProviderError::QuotaLimited { .. } => "quota_limited",
        ProviderError::ContextOverflow { .. } => "context_overflow",
        ProviderError::Cancelled => "cancelled",
        ProviderError::Other(_) => "other",
    }
}
