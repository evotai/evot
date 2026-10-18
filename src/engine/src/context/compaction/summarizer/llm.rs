//! LLM-based summarization — calls the provider to generate structured summaries.

use std::time::Instant;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::mode::SummarizerContext;
use super::prompt;
use super::types::SummarizerError;
use super::types::SummarizerInput;
use super::types::SummarizerOutput;
use crate::context::compaction::config::truncate_summary;
use crate::context::compaction::types::notify_compaction_activity;
use crate::context::compaction::types::CompactionActivity;
use crate::context::compaction::types::CompactionObserver;
use crate::context::compaction::types::FileOps;
use crate::provider::StreamConfig;
use crate::provider::StreamEvent;
use crate::types::*;

/// Previous summaries above this size get explicit convergence guidance so
/// repeated incremental compactions do not grow without bound.
pub const DEFAULT_SUMMARY_SOFT_CAP_TOKENS: usize = 2_000;

/// Generate a summary using the LLM provider.
pub async fn summarize(
    input: SummarizerInput,
    ctx: &SummarizerContext,
    reserve_tokens: u32,
    cancel: CancellationToken,
) -> Result<SummarizerOutput, SummarizerError> {
    summarize_with_observer(input, ctx, reserve_tokens, cancel, None).await
}

pub async fn summarize_with_observer(
    input: SummarizerInput,
    ctx: &SummarizerContext,
    reserve_tokens: u32,
    cancel: CancellationToken,
    observer: Option<CompactionObserver>,
) -> Result<SummarizerOutput, SummarizerError> {
    let main_max_tokens = output_budget(ctx, reserve_tokens);
    let prefix_max_tokens = output_budget(ctx, reserve_tokens / 2);

    // A split can begin at the current turn, leaving no prior history. Match
    // pi by avoiding a useless first model request in that case.
    let mut summary = if input.conversation.trim().is_empty() && input.turn_prefix.is_some() {
        "No prior history.".to_string()
    } else {
        let user_prompt = match &input.previous_summary {
            Some(previous) => prompt::format_update(
                &input.conversation,
                previous,
                input.custom_instructions.as_deref(),
                crate::context::estimate_tokens(previous) > DEFAULT_SUMMARY_SOFT_CAP_TOKENS,
            ),
            None => {
                prompt::format_initial(&input.conversation, input.custom_instructions.as_deref())
            }
        };
        let user_prompt = truncate_summary(&user_prompt, input.request_max_bytes);
        call_provider(
            ctx,
            &user_prompt,
            main_max_tokens,
            cancel.clone(),
            &observer,
            "history",
        )
        .await?
    };

    if let Some(prefix_text) = &input.turn_prefix {
        let prefix_prompt = prompt::format_turn_prefix(prefix_text);
        let prefix_prompt = truncate_summary(&prefix_prompt, input.request_max_bytes);
        let prefix_summary = call_provider(
            ctx,
            &prefix_prompt,
            prefix_max_tokens,
            cancel,
            &observer,
            "turn_prefix",
        )
        .await?;
        summary.push_str("\n\n---\n\n**Turn Context (split turn):**\n\n");
        summary.push_str(&prefix_summary);
    }

    // Append file operations (rule-based, not LLM-generated)
    summary.push_str(&format_file_ops_xml(&input.file_ops));

    Ok(SummarizerOutput { summary })
}

fn output_budget(ctx: &SummarizerContext, requested: u32) -> u32 {
    let model_max = ctx
        .model_config
        .as_ref()
        .map(|model| model.max_tokens())
        .unwrap_or(u32::MAX);
    requested.min(model_max).max(1)
}

/// Call the provider for a single summarization request.
async fn call_provider(
    ctx: &SummarizerContext,
    user_prompt: &str,
    max_tokens: u32,
    cancel: CancellationToken,
    observer: &Option<CompactionObserver>,
    stage: &'static str,
) -> Result<String, SummarizerError> {
    let messages = vec![Message::User {
        provenance: None,
        content: vec![Content::Text {
            text: user_prompt.to_string(),
        }],
        timestamp: now_ms(),
    }];

    let config = StreamConfig {
        model: ctx.model.clone(),
        system_prompt: prompt::SYSTEM_PROMPT.to_string(),
        messages,
        tools: vec![],
        // Summarization is extraction, not the normal turn's reasoning task.
        // Never raise an explicitly lower setting; model metadata handles
        // providers that do not support the requested tier.
        thinking_level: match ctx.thinking_level {
            ThinkingLevel::Off | ThinkingLevel::Minimal => ctx.thinking_level,
            _ => ThinkingLevel::Low,
        },
        api_key: ctx.api_key.clone(),
        max_tokens: Some(max_tokens),
        model_config: ctx.model_config.clone(),
        cache_config: CacheConfig::default(),
        prompt_cache_key: None,
        client: None,
    };

    let thinking_level = crate::provider::effective_thinking_level(
        config.thinking_level,
        config.model_config.as_ref(),
    );
    tracing::info!(
        stage,
        model = %ctx.model,
        thinking_level = thinking_level.as_str(),
        input_bytes = user_prompt.len() + prompt::SYSTEM_PROMPT.len(),
        estimated_input_tokens = crate::context::estimate_tokens(user_prompt)
            + crate::context::estimate_tokens(prompt::SYSTEM_PROMPT),
        max_tokens,
        "compaction summary request started"
    );
    notify_compaction_activity(observer, CompactionActivity::Waiting);
    let mut progress = RequestProgress::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let stream = ctx.provider.stream(config, tx, cancel.clone());
    tokio::pin!(stream);
    let mut events_open = true;
    let result = loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // One poll lets a cooperative provider observe cancellation and
                // clean up; a provider that ignores its token is dropped here.
                let _ = futures::poll!(&mut stream);
                progress.finish(stage, &ctx.model, "cancelled");
                return Err(SummarizerError::Cancelled);
            }
            result = &mut stream => break result,
            event = rx.recv(), if events_open => {
                match event {
                    Some(event) => progress.observe(&event, observer),
                    None => events_open = false,
                }
            }
        }
    };

    // Drain already-buffered events for accurate timings, without waiting for
    // sender clones a provider may retain after returning. The final message
    // remains authoritative; deltas are used only for activity and metrics.
    rx.close();
    while let Ok(event) = rx.try_recv() {
        progress.observe(&event, observer);
    }
    let result = match result {
        Ok(outcome) => {
            progress.finish(stage, &ctx.model, "returned");
            outcome
        }
        Err(error) => {
            progress.finish(stage, &ctx.model, "failed");
            tracing::warn!(stage, model = %ctx.model, %error, "compaction summary request failed");
            return Err(SummarizerError::Failed(error.to_string()));
        }
    };

    if cancel.is_cancelled() {
        return Err(SummarizerError::Cancelled);
    }

    let message = result.into_message();
    match message {
        Message::Assistant {
            content,
            stop_reason,
            error_message,
            ..
        } => {
            if stop_reason == StopReason::Error {
                return Err(SummarizerError::Failed(
                    error_message.unwrap_or_else(|| "Unknown error".into()),
                ));
            }
            let text = content
                .iter()
                .filter_map(|c| match c {
                    Content::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            Ok(prompt::extract_summary(&text))
        }
        _ => Err(SummarizerError::Failed("Unexpected response type".into())),
    }
}

/// Track timings only; never retain or log streamed summary/thinking text.
struct RequestProgress {
    started: Instant,
    first_event_ms: Option<u64>,
    first_content_ms: Option<u64>,
    first_text_ms: Option<u64>,
    text_bytes: usize,
}

impl RequestProgress {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            first_event_ms: None,
            first_content_ms: None,
            first_text_ms: None,
            text_bytes: 0,
        }
    }

    fn observe(&mut self, event: &StreamEvent, observer: &Option<CompactionObserver>) {
        let elapsed_ms = self.started.elapsed().as_millis() as u64;
        self.first_event_ms.get_or_insert(elapsed_ms);
        let has_content = match event {
            StreamEvent::TextDelta { delta, .. } if !delta.is_empty() => {
                self.first_text_ms.get_or_insert(elapsed_ms);
                self.text_bytes += delta.len();
                true
            }
            StreamEvent::ThinkingDelta { delta, .. } => !delta.is_empty(),
            _ => false,
        };
        if has_content && self.first_content_ms.is_none() {
            self.first_content_ms = Some(elapsed_ms);
            notify_compaction_activity(observer, CompactionActivity::Generating);
        }
    }

    fn finish(&self, stage: &str, model: &str, status: &str) {
        tracing::info!(
            stage,
            model,
            status,
            elapsed_ms = self.started.elapsed().as_millis() as u64,
            first_event_ms = self.first_event_ms,
            first_content_ms = self.first_content_ms,
            first_text_ms = self.first_text_ms,
            streamed_text_bytes = self.text_bytes,
            "compaction summary request finished"
        );
    }
}

/// Format file operations as XML tags (appended to LLM summary).
fn format_file_ops_xml(file_ops: &FileOps) -> String {
    let mut sections: Vec<String> = Vec::new();

    let read_only = file_ops.read_only();
    if !read_only.is_empty() {
        let files: Vec<&str> = read_only.iter().map(|s| s.as_str()).collect();
        sections.push(format!("<read-files>\n{}\n</read-files>", files.join("\n")));
    }

    let modified = file_ops.modified();
    if !modified.is_empty() {
        let files: Vec<&str> = modified.iter().map(|s| s.as_str()).collect();
        sections.push(format!(
            "<modified-files>\n{}\n</modified-files>",
            files.join("\n")
        ));
    }

    if sections.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", sections.join("\n\n"))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
