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
use super::SuggestionHints;
use super::SuggestionMessage;
use super::SuggestionModel;
use super::SuggestionOutcome;
use super::SuggestionStatus;

// Allow cold connections and slow gateways up to 30 seconds. This is a hard
// ceiling, not a display delay: results appear immediately and input cancels
// instantly. Foreground interaction never waits for this request. Transport
// failures can still return earlier; they are not this local deadline.
pub const SUGGESTION_TIMEOUT: Duration = Duration::from_secs(30);

/// Candidate-only convenience API; interactive callers use sample_outcome to
/// distinguish an empty prediction from a failed transport.
pub async fn sample(
    model: &SuggestionModel,
    messages: &[SuggestionMessage],
    hints: &SuggestionHints,
    provider: Arc<dyn StreamProvider>,
    cancel: CancellationToken,
) -> Vec<String> {
    sample_outcome(model, messages, hints, provider, cancel)
        .await
        .candidates
}

pub async fn sample_outcome(
    model: &SuggestionModel,
    messages: &[SuggestionMessage],
    hints: &SuggestionHints,
    provider: Arc<dyn StreamProvider>,
    cancel: CancellationToken,
) -> SuggestionOutcome {
    sample_with_updates(model, messages, hints, provider, cancel, None).await
}

pub async fn sample_with_updates(
    model: &SuggestionModel,
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
    let Some(config) = prompt_config(model, messages, hints) else {
        tracing::info!(target: "evot::suggestion", outcome = "insufficient_context");
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
    // Lengths only: distinguish model abstention from otherwise useful text
    // rejected by the output contract without logging user content or secrets.
    let returned_candidate_chars = serde_json::from_str::<Vec<String>>(&text)
        .ok()
        .map(|items| {
            items
                .iter()
                .map(|item| item.chars().count())
                .collect::<Vec<_>>()
        });
    tracing::debug!(target: "evot::suggestion", stage = "response_shape", returned_candidate_chars = ?returned_candidate_chars);
    let candidates = validated(&text, messages, hints);
    if !candidates.is_empty() {
        first_candidate_ms.get_or_insert(started.elapsed().as_millis());
    }
    progress.finish(&candidates);
    let outcome = if !candidates.is_empty() {
        "suggested"
    } else if text.trim().is_empty()
        || text.trim() == "[]"
        || text.trim().eq_ignore_ascii_case("NONE")
    {
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
