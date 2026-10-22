use tokio_util::sync::CancellationToken;

use super::sample::sample_with_updates;
use super::SuggestionHints;
use super::SuggestionListener;
use super::SuggestionMessage;
use super::SuggestionModel;
use super::SuggestionOutcome;
use super::SuggestionStatus;
use super::SUGGESTION_TIMEOUT;
use crate::conf::LlmConfig;

/// One disposable side request. Resolve the route once, then sample without
/// retries, tools, compaction, transcript writes or auth-refresh traffic.
/// A transport failure never falls through to another model.
pub async fn generate(
    current: LlmConfig,
    messages: Vec<SuggestionMessage>,
    hints: SuggestionHints,
    cancel: CancellationToken,
    listener: Option<SuggestionListener>,
) -> SuggestionOutcome {
    let work = async {
        let model = match SuggestionModel::resolve(current).await {
            Ok(Some(model)) => model,
            Ok(None) | Err(_) => return SuggestionOutcome::status(SuggestionStatus::Unavailable),
        };
        sample_with_updates(
            &model,
            &messages,
            &hints,
            model.provider(),
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
            Err(_) => SuggestionOutcome::status(SuggestionStatus::TimedOut),
        },
    }
}
