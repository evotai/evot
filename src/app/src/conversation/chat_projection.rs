//! Chat conversation projection.
//!
//! Live SSE and session replay share one node list. The browser never has to
//! invent a second shape for thinking, tools, compaction, or turn tails.

use serde::Serialize;

use crate::agent::AssistantContentType;
use crate::agent::RunEvent;
use crate::agent::RunEventPayload;
use crate::agent::ToolCallStreamPhase;
use crate::observability::LlmCallMetrics;
use crate::observability::UsageSummary;
use crate::types::AssistantBlock;
use crate::types::SessionMeta;
use crate::types::TranscriptItem;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatNodeKind {
    Session,
    User,
    Assistant,
    Tool,
    Compact,
    Retry,
    Error,
    MaxTokens,
    /// Context occupancy reading plus its system/tools/messages breakdown.
    Context,
    Done,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatBlockKind {
    Text,
    Thinking,
    ToolCall,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatBlock {
    pub kind: ChatBlockKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ChatUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ChatMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttft_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttfb_ms: Option<u64>,
    /// Decode throughput: output tokens over the streaming window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_per_second: Option<f64>,
}

/// Context occupancy reading for the composer meter. `used`/`window` come from
/// the same source compaction uses, so the ring and compaction agree.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChatContext {
    pub used: usize,
    pub window: usize,
    pub percent: u32,
    /// Heuristic split of `used`; the ring length stays the exact reading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatNode {
    #[serde(rename = "type")]
    pub kind: ChatNodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<ChatBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<ChatUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<ChatMetrics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_retries: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<usize>,
    /// Wall-clock time of the underlying transcript fact (epoch ms). Drives the
    /// message clock, so it must survive replay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ChatContext>,
    /// Messages injected at the start of this call (steering, follow-up, or the
    /// initial prompt). A live UI reads this as the admission signal for its
    /// queued messages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injected_count: Option<usize>,
}

impl ChatNode {
    fn new(kind: ChatNodeKind) -> Self {
        Self {
            kind,
            session_id: None,
            cwd: None,
            title: None,
            text: None,
            content_index: None,
            blocks: None,
            id: None,
            name: None,
            input: None,
            content: None,
            is_error: None,
            status: None,
            phase: None,
            delta: None,
            stop_reason: None,
            usage: None,
            metrics: None,
            turn: None,
            attempt: None,
            max_retries: None,
            delay_ms: None,
            error: None,
            reason: None,
            summary: None,
            tokens_before: None,
            tokens_after: None,
            time: None,
            model: None,
            provider: None,
            context: None,
            injected_count: None,
        }
    }

    pub fn to_sse_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

pub fn session_node(meta: &SessionMeta) -> ChatNode {
    let mut node = ChatNode::new(ChatNodeKind::Session);
    node.session_id = Some(meta.session_id.clone());
    node.cwd = Some(meta.cwd.clone());
    node.title = meta.title.clone();
    node
}

pub fn session_node_from_id(session_id: &str, cwd: Option<&str>) -> ChatNode {
    let mut node = ChatNode::new(ChatNodeKind::Session);
    node.session_id = Some(session_id.to_string());
    node.cwd = cwd.map(str::to_string);
    node
}

pub fn error_node(message: impl Into<String>) -> ChatNode {
    let mut node = ChatNode::new(ChatNodeKind::Error);
    node.text = Some(message.into());
    node
}

pub fn done_node() -> ChatNode {
    ChatNode::new(ChatNodeKind::Done)
}

pub fn command_node(text: impl Into<String>) -> ChatNode {
    let mut node = ChatNode::new(ChatNodeKind::Assistant);
    node.status = Some("settled".into());
    node.blocks = Some(vec![text_block(text.into())]);
    node
}

fn text_block(text: String) -> ChatBlock {
    ChatBlock {
        kind: ChatBlockKind::Text,
        text: Some(text),
        id: None,
        name: None,
        input: None,
    }
}

fn thinking_block(text: String) -> ChatBlock {
    ChatBlock {
        kind: ChatBlockKind::Thinking,
        text: Some(text),
        id: None,
        name: None,
        input: None,
    }
}

fn usage_from(usage: &UsageSummary) -> ChatUsage {
    ChatUsage {
        input: Some(usage.input),
        output: Some(usage.output),
        cache_read: Some(usage.cache_read),
        cache_write: Some(usage.cache_write),
    }
}

fn metrics_from(metrics: &LlmCallMetrics) -> ChatMetrics {
    ChatMetrics {
        duration_ms: Some(metrics.duration_ms),
        ttft_ms: Some(metrics.ttft_ms),
        ttfb_ms: Some(metrics.ttfb_ms),
        tokens_per_second: None,
    }
}

/// Decode throughput over the streaming window. `streaming_ms` excludes the
/// first-token wait, so this reads as decode speed rather than end-to-end rate.
fn tokens_per_second(metrics: &LlmCallMetrics, output: u64) -> Option<f64> {
    if metrics.streaming_ms == 0 || output == 0 {
        return None;
    }
    Some(output as f64 / (metrics.streaming_ms as f64 / 1000.0))
}

/// Context occupancy from the same estimate compaction uses.
fn context_reading(used: usize, window: usize) -> Option<ChatContext> {
    if window == 0 {
        return None;
    }
    Some(ChatContext {
        used,
        window,
        percent: ((used as f64 / window as f64) * 100.0).round().min(100.0) as u32,
        system: None,
        tools: None,
        messages: None,
    })
}

fn assistant_blocks(content: &[AssistantBlock]) -> Vec<ChatBlock> {
    content
        .iter()
        .map(|block| match block {
            AssistantBlock::Text { text } => text_block(text.clone()),
            AssistantBlock::Thinking { text, .. } => thinking_block(text.clone()),
            AssistantBlock::ToolCall {
                id, name, input, ..
            } => ChatBlock {
                kind: ChatBlockKind::ToolCall,
                text: None,
                id: Some(id.clone()),
                name: Some(name.clone()),
                input: Some(input.clone()),
            },
        })
        .collect()
}

/// Occupancy plus its heuristic split, from the pre-request estimate. The
/// system and tool shares are only known here, so the ring gets its segments
/// before the call rather than after.
fn context_node(
    estimated: usize,
    system: usize,
    tools: usize,
    window: usize,
    injected: usize,
) -> Option<ChatNode> {
    let mut reading = context_reading(estimated, window)?;
    reading.system = Some(system.min(estimated));
    reading.tools = Some(tools.min(estimated.saturating_sub(system)));
    reading.messages = Some(estimated.saturating_sub(system).saturating_sub(tools));
    let mut node = ChatNode::new(ChatNodeKind::Context);
    node.context = Some(reading);
    // Queued steering has no admission event of its own; this count is how a
    // live UI learns its pending messages entered the conversation.
    node.injected_count = Some(injected);
    Some(node)
}

pub fn map_run_event(event: &RunEvent) -> Vec<ChatNode> {
    match &event.payload {
        RunEventPayload::LlmCallStarted {
            estimated_context_tokens,
            system_prompt_tokens,
            tool_definition_tokens,
            context_window,
            injected_count,
            ..
        } => context_node(
            *estimated_context_tokens,
            *system_prompt_tokens,
            *tool_definition_tokens,
            *context_window,
            *injected_count,
        )
        .map(|node| vec![node])
        .unwrap_or_default(),
        RunEventPayload::AssistantDelta {
            content_index,
            content_type,
            delta,
        } if !delta.is_empty() => {
            let mut node = ChatNode::new(ChatNodeKind::Assistant);
            node.status = Some("delta".into());
            node.content_index = Some(*content_index);
            node.blocks = Some(vec![match content_type {
                AssistantContentType::Thinking => thinking_block(delta.clone()),
                AssistantContentType::Text => text_block(delta.clone()),
            }]);
            vec![node]
        }
        RunEventPayload::AssistantToolCall {
            content_index,
            tool_call_id,
            tool_name,
            phase,
            delta,
            args,
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Tool);
            node.id = Some(tool_call_id.clone());
            node.name = Some(tool_name.clone());
            node.content_index = Some(*content_index);
            node.phase = Some(
                match phase {
                    ToolCallStreamPhase::Start => "start",
                    ToolCallStreamPhase::Delta => "delta",
                    ToolCallStreamPhase::End => "end",
                }
                .into(),
            );
            node.delta = delta.clone();
            node.input = args.clone();
            node.status = Some(match phase {
                ToolCallStreamPhase::End => "ready".into(),
                _ => "running".into(),
            });
            vec![node]
        }
        RunEventPayload::AssistantCompleted {
            content,
            usage,
            stop_reason,
            error_message,
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Assistant);
            node.status = Some("settled".into());
            node.blocks = Some(assistant_blocks(content));
            node.stop_reason = Some(stop_reason.clone());
            if let Some(usage) = usage {
                node.usage = Some(usage_from(usage));
            }
            node.error = error_message.clone();
            vec![node]
        }
        RunEventPayload::ToolStarted {
            tool_call_id,
            tool_name,
            args,
            ..
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Tool);
            node.id = Some(tool_call_id.clone());
            node.name = Some(tool_name.clone());
            node.input = Some(args.clone());
            node.status = Some("running".into());
            vec![node]
        }
        RunEventPayload::ToolProgress {
            tool_call_id,
            tool_name,
            text,
            ..
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Tool);
            node.id = Some(tool_call_id.clone());
            node.name = Some(tool_name.clone());
            node.content = Some(text.clone());
            node.status = Some("running".into());
            vec![node]
        }
        RunEventPayload::ToolFinished {
            tool_call_id,
            tool_name,
            content,
            is_error,
            duration_ms,
            ..
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Tool);
            node.id = Some(tool_call_id.clone());
            node.name = Some(tool_name.clone());
            node.content = Some(content.clone());
            node.is_error = Some(*is_error);
            node.status = Some(if *is_error { "error" } else { "done" }.into());
            node.metrics = Some(ChatMetrics {
                duration_ms: Some(*duration_ms),
                ..ChatMetrics::default()
            });
            vec![node]
        }
        RunEventPayload::LlmCallRetry {
            turn,
            attempt,
            max_retries,
            delay_ms,
            error,
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Retry);
            node.turn = Some(*turn as u32);
            node.attempt = Some(*attempt);
            node.max_retries = Some(*max_retries);
            node.delay_ms = Some(*delay_ms);
            node.error = Some(error.clone());
            vec![node]
        }
        RunEventPayload::QuotaWaiting { delay_ms, error }
        | RunEventPayload::OutageWaiting { delay_ms, error } => {
            let mut node = ChatNode::new(ChatNodeKind::Retry);
            node.delay_ms = Some(*delay_ms);
            node.error = Some(error.clone());
            node.status = Some("waiting".into());
            vec![node]
        }
        RunEventPayload::LlmCallCompleted {
            turn,
            usage,
            metrics,
            stop_reason,
            error,
            context_window,
            response_model,
            ..
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Assistant);
            node.status = Some("tail".into());
            // The live stats line counts turns off this tail, so it has to
            // carry the turn it closes.
            node.turn = Some(*turn as u32);
            node.stop_reason = Some(stop_reason.clone());
            node.usage = Some(usage_from(usage));
            if let Some(metrics) = metrics {
                let mut reading = metrics_from(metrics);
                reading.tokens_per_second = tokens_per_second(metrics, usage.output);
                node.metrics = Some(reading);
            }
            // Occupancy after this call: prompt-side input is what the next
            // request has to carry, so the ring tracks the same number
            // compaction thresholds on.
            let used = (usage.input + usage.cache_read + usage.cache_write + usage.output) as usize;
            node.context = context_reading(used, *context_window);
            node.model = response_model.clone();
            node.error = error.clone();
            let mut nodes = vec![node];
            // The cap is a turn outcome, not an error: surface it as its own
            // notice so the tail keeps reporting timings.
            if stop_reason == "max_tokens" {
                nodes.push(ChatNode::new(ChatNodeKind::MaxTokens));
            }
            nodes
        }
        RunEventPayload::ContextCompactionCompleted {
            reason,
            summary,
            result,
            ..
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Compact);
            node.reason = Some(format!("{reason:?}").to_lowercase());
            node.summary = summary.clone();
            if let crate::observability::CompactionResult::Compacted {
                before_tokens,
                after_tokens,
                ..
            } = result
            {
                node.tokens_before = Some(*before_tokens);
                node.tokens_after = Some(*after_tokens);
            }
            vec![node]
        }
        RunEventPayload::RunFinished {
            usage,
            duration_ms,
            turn_count,
            ..
        } => {
            let mut node = ChatNode::new(ChatNodeKind::Assistant);
            node.status = Some("run".into());
            node.turn = Some(*turn_count);
            node.usage = Some(usage_from(usage));
            node.metrics = Some(ChatMetrics {
                duration_ms: Some(*duration_ms),
                ..ChatMetrics::default()
            });
            vec![node]
        }
        RunEventPayload::Error { message } => vec![error_node(message)],
        _ => Vec::new(),
    }
}

/// Whole-session readings for the composer stats line and context ring.
///
/// Replay drops `Stats` items (they never enter the model context), so the
/// browser cannot fold these out of the node list. Deriving them here keeps one
/// source for live and resumed sessions.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ChatStats {
    pub turns: u32,
    pub steps: u32,
    /// Summed request wall time.
    pub llm_ms: u64,
    /// Summed tool execution wall time.
    pub tool_ms: u64,
    /// Summed first-token latency over `ttft_steps`.
    pub ttft_ms: u64,
    pub ttft_steps: u32,
    /// Summed streaming window over steps that also reported output tokens.
    pub decode_ms: u64,
    pub decode_tokens: u64,
    pub usage: ChatUsage,
    /// Occupancy after the last completed call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ChatContext>,
}

pub fn session_stats(entries: &[crate::types::TranscriptEntry]) -> ChatStats {
    use crate::observability::TranscriptStats;

    let mut stats = ChatStats::default();
    let mut turns = std::collections::HashSet::new();
    let mut input = 0u64;
    let mut output = 0u64;
    let mut cache_read = 0u64;
    let mut cache_write = 0u64;
    // The system and tool shares are only reported before a request, so carry
    // the latest pair forward onto the reading the completed call produces.
    let mut system_tokens = 0usize;
    let mut tool_tokens = 0usize;
    for entry in entries {
        match TranscriptStats::try_from_item(&entry.item) {
            Some(TranscriptStats::LlmCallStarted(call)) => {
                system_tokens = call.system_prompt_tokens;
                tool_tokens = call.tool_definition_tokens;
            }
            Some(TranscriptStats::LlmCallCompleted(call)) => {
                turns.insert(call.turn);
                stats.steps = stats.steps.saturating_add(1);
                input += call.usage.input;
                output += call.usage.output;
                cache_read += call.usage.cache_read;
                cache_write += call.usage.cache_write;
                if let Some(metrics) = &call.metrics {
                    stats.llm_ms += metrics.duration_ms;
                    if metrics.ttft_ms > 0 {
                        stats.ttft_ms += metrics.ttft_ms;
                        stats.ttft_steps = stats.ttft_steps.saturating_add(1);
                    }
                    if metrics.streaming_ms > 0 && call.usage.output > 0 {
                        stats.decode_ms += metrics.streaming_ms;
                        stats.decode_tokens += call.usage.output;
                    }
                }
                let used = (call.usage.input
                    + call.usage.cache_read
                    + call.usage.cache_write
                    + call.usage.output) as usize;
                if let Some(mut context) = context_reading(used, call.context_window) {
                    context.system = Some(system_tokens.min(used));
                    context.tools = Some(tool_tokens.min(used.saturating_sub(system_tokens)));
                    context.messages = Some(
                        used.saturating_sub(system_tokens)
                            .saturating_sub(tool_tokens),
                    );
                    stats.context = Some(context);
                }
            }
            Some(TranscriptStats::ToolFinished(tool)) => {
                stats.tool_ms += tool.duration_ms;
            }
            _ => {}
        }
    }
    stats.turns = turns.len() as u32;
    stats.usage = ChatUsage {
        input: Some(input),
        output: Some(output),
        cache_read: Some(cache_read),
        cache_write: Some(cache_write),
    };
    stats
}

pub fn replay_nodes(items: &[TranscriptItem]) -> Vec<ChatNode> {
    let mut nodes = Vec::new();
    for item in items {
        match item {
            TranscriptItem::User { .. } => {
                use super::input::display_parts;
                use super::input::DisplayInputPart;
                for part in display_parts(item) {
                    match part {
                        DisplayInputPart::User { text } => {
                            let mut node = ChatNode::new(ChatNodeKind::User);
                            node.text = Some(text);
                            nodes.push(node);
                        }
                        DisplayInputPart::Legacy { text } => {
                            if let Some(text) = crate::command::user_facing_text(&text) {
                                let mut node = ChatNode::new(ChatNodeKind::User);
                                node.text = Some(text.into_owned());
                                nodes.push(node);
                            }
                        }
                        DisplayInputPart::Notice { text } => {
                            let mut node = ChatNode::new(ChatNodeKind::Assistant);
                            node.status = Some("settled".into());
                            node.blocks = Some(vec![text_block(text)]);
                            nodes.push(node);
                        }
                    }
                }
            }
            TranscriptItem::Assistant {
                content,
                stop_reason,
                usage,
                error_message,
                timestamp,
                model,
                provider,
                ..
            } => {
                let mut node = ChatNode::new(ChatNodeKind::Assistant);
                node.status = Some(if stop_reason == "aborted" {
                    "interrupted".into()
                } else {
                    "settled".into()
                });
                node.blocks = Some(assistant_blocks(content));
                node.stop_reason = Some(stop_reason.clone());
                node.usage = Some(usage_from(usage));
                node.error = error_message.clone();
                if *timestamp > 0 {
                    node.time = Some(*timestamp);
                }
                if !model.is_empty() {
                    node.model = Some(model.clone());
                }
                if !provider.is_empty() {
                    node.provider = Some(provider.clone());
                }
                nodes.push(node);
            }
            TranscriptItem::ToolResult {
                tool_call_id,
                tool_name,
                content,
                is_error,
                ..
            } => {
                let mut node = ChatNode::new(ChatNodeKind::Tool);
                node.id = Some(tool_call_id.clone());
                node.name = Some(tool_name.clone());
                node.content = Some(content.clone());
                node.is_error = Some(*is_error);
                node.status = Some(if *is_error { "error" } else { "done" }.into());
                nodes.push(node);
            }
            TranscriptItem::Compact {
                reason,
                summary,
                tokens_before,
                tokens_after,
                ..
            } => {
                let mut node = ChatNode::new(ChatNodeKind::Compact);
                node.reason = Some(format!("{reason:?}").to_lowercase());
                node.summary = Some(summary.clone());
                node.tokens_before = Some(*tokens_before);
                node.tokens_after = Some(*tokens_after);
                nodes.push(node);
            }
            TranscriptItem::System { text } => {
                let mut node = ChatNode::new(ChatNodeKind::Assistant);
                node.status = Some("settled".into());
                node.blocks = Some(vec![text_block(text.clone())]);
                nodes.push(node);
            }
            _ => {}
        }
    }
    nodes
}
