//! Transcript → trace span projection.
//!
//! Mission control's session detail page shows a per-LLM-call trace: each
//! assistant response is one "span" carrying its tool calls and the tool
//! results they produced. This mirrors the eval trace viewer's span model
//! (evot-eval `web/public/js/span-renderer.js`) but is grounded entirely in
//! evot's own persisted transcript, so no placeholder data is involved.

use serde::Serialize;

use crate::observability::TranscriptStats;
use crate::types::AssistantBlock;
use crate::types::SessionMeta;
use crate::types::TranscriptEntry;
use crate::types::TranscriptItem;

/// One row in the trace list: a single assistant LLM call.
#[derive(Debug, Clone, Serialize)]
pub struct SpanSummary {
    pub seq: u64,
    pub model: String,
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Wall-clock duration of the LLM call (ms); 0 when not recorded.
    pub duration_ms: u64,
    /// Number of messages sent to the model for this call.
    pub n_messages: usize,
    /// Number of tool calls the assistant requested in this span.
    pub n_tool_use: usize,
    /// Short preview of the assistant text (first line, trimmed).
    pub preview: String,
    /// Tool names requested, in order (for the collapsed summary line).
    pub tool_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// A content block within a span (assistant output, or an input-context block).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SpanBlock {
    Thinking {
        text: String,
    },
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// Only appears in reconstructed input context, never in assistant output.
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

/// The tool result paired with a tool call from this span.
#[derive(Debug, Clone, Serialize)]
pub struct SpanToolResult {
    pub tool_use_id: String,
    pub content: String,
    pub is_error: bool,
    /// Tool execution time (ms); 0 when not recorded.
    pub duration_ms: u64,
    /// Tokens the tool result contributed to context.
    pub result_tokens: usize,
}

/// Full detail for one span: assistant output blocks plus the tool results
/// produced before the next assistant call.
#[derive(Debug, Clone, Serialize)]
pub struct SpanDetail {
    pub seq: u64,
    pub model: String,
    pub stop_reason: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Wall-clock duration of the LLM call (ms).
    pub duration_ms: u64,
    /// Time to first token (ms).
    pub ttft_ms: u64,
    /// Context window size at the time of the call (tokens).
    pub context_window: usize,
    /// Number of messages sent to the model.
    pub n_messages: usize,
    /// System prompt size (tokens).
    pub system_prompt_tokens: usize,
    /// Full system prompt text sent to the model.
    pub system_prompt: String,
    /// Tool schemas sent to the model.
    pub tool_definitions: Vec<ToolDefView>,
    /// The user/tool input the assistant was reacting to (preview text).
    pub reacting_to: String,
    pub blocks: Vec<SpanBlock>,
    pub tool_results: Vec<SpanToolResult>,
    /// The cumulative conversation context sent to the model for this call,
    /// reconstructed from the transcript (respects compaction/markers). Used by
    /// the diff view to show how context grew between two requests.
    pub input_messages: Vec<InputBlock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

/// One content block of an input message, flattened with its message index and
/// role so the diff can show position + provenance.
#[derive(Debug, Clone, Serialize)]
pub struct InputBlock {
    /// Index of the source message within the input context.
    pub mi: usize,
    /// Message role: user / assistant / tool.
    pub role: String,
    #[serde(flatten)]
    pub block: SpanBlock,
}

/// A tool schema for the messages view (name + description + JSON Schema).
#[derive(Debug, Clone, Serialize)]
pub struct ToolDefView {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

fn first_line_preview(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.chars().count() > max {
        let truncated: String = line.chars().take(max).collect();
        format!("{truncated}\u{2026}")
    } else {
        line.to_string()
    }
}

/// LLM-call timing/sizing stats correlated to an assistant span. Lightweight:
/// no large payloads, so the span list can call this per row cheaply.
struct SpanStats {
    duration_ms: u64,
    ttft_ms: u64,
    context_window: usize,
    n_messages: usize,
    system_prompt_tokens: usize,
}

/// Correlate the persisted observability stats with the assistant entry at
/// `idx`. `LlmCallStarted` precedes the assistant message; `LlmCallCompleted`
/// follows it. Both sit adjacent to the assistant entry in the transcript, so
/// we scan a small window on each side and stop at the neighbouring assistant.
fn span_stats_for(entries: &[TranscriptEntry], idx: u64) -> SpanStats {
    let idx = idx as usize;
    let mut stats = SpanStats {
        duration_ms: 0,
        ttft_ms: 0,
        context_window: 0,
        n_messages: 0,
        system_prompt_tokens: 0,
    };

    // LlmCallStarted: nearest preceding stats before this assistant entry.
    for prev in entries[..idx].iter().rev() {
        match &prev.item {
            TranscriptItem::Assistant { .. } => break,
            item => {
                if let Some(TranscriptStats::LlmCallStarted(s)) =
                    TranscriptStats::try_from_item(item)
                {
                    stats.n_messages = s.message_count;
                    stats.system_prompt_tokens = s.system_prompt_tokens;
                    break;
                }
            }
        }
    }

    // LlmCallCompleted: nearest following stats before the next assistant entry.
    for next in &entries[idx + 1..] {
        match &next.item {
            TranscriptItem::Assistant { .. } => break,
            item => {
                if let Some(TranscriptStats::LlmCallCompleted(s)) =
                    TranscriptStats::try_from_item(item)
                {
                    if let Some(m) = s.metrics {
                        stats.duration_ms = m.duration_ms;
                        stats.ttft_ms = m.ttft_ms;
                    }
                    stats.context_window = s.context_window;
                    break;
                }
            }
        }
    }

    stats
}

/// Resolve the system prompt + tool schemas in effect for the span at `idx`.
/// Payloads are delta-persisted (written only when they change), so scan back
/// to the nearest `LlmCallStarted` that carries a non-empty payload.
/// Detail-only (the list never needs these large payloads), so it's kept out
/// of `span_stats_for`.
fn span_request_payload(entries: &[TranscriptEntry], idx: usize) -> (String, Vec<ToolDefView>) {
    for prev in entries[..idx].iter().rev() {
        let Some(TranscriptStats::LlmCallStarted(s)) = TranscriptStats::try_from_item(&prev.item)
        else {
            continue;
        };
        if s.system_prompt.is_empty() && s.tool_definitions.is_empty() {
            continue;
        }
        let tools = s
            .tool_definitions
            .into_iter()
            .map(|t| ToolDefView {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })
            .collect();
        return (s.system_prompt, tools);
    }
    (String::new(), Vec::new())
}

/// Look up the persisted `ToolFinished` stats for a tool call id within this
/// span's window (between the assistant entry and the next assistant entry).
fn tool_finished_for(
    entries: &[TranscriptEntry],
    start_idx: usize,
    tool_call_id: &str,
) -> (u64, usize) {
    for next in &entries[start_idx + 1..] {
        if matches!(next.item, TranscriptItem::Assistant { .. }) {
            break;
        }
        if let Some(TranscriptStats::ToolFinished(s)) = TranscriptStats::try_from_item(&next.item) {
            if s.tool_call_id == tool_call_id {
                return (s.duration_ms, s.result_tokens);
            }
        }
    }
    (0, 0)
}

/// Project a session's transcript into a list of span summaries (one per
/// assistant LLM call), in chronological order.
pub fn project_spans(entries: &[TranscriptEntry]) -> Vec<SpanSummary> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(idx, entry)| match &entry.item {
            TranscriptItem::Assistant {
                content,
                stop_reason,
                usage,
                model,
                error_message,
                ..
            } => {
                let stats = span_stats_for(entries, idx as u64);
                let text = crate::types::assistant_text(content);
                let tool_names = content
                    .iter()
                    .filter_map(|block| match block {
                        AssistantBlock::ToolCall { name, .. } => Some(name.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                Some(SpanSummary {
                    seq: entry.seq,
                    model: model.clone(),
                    stop_reason: stop_reason.clone(),
                    input_tokens: usage.input,
                    output_tokens: usage.output,
                    duration_ms: stats.duration_ms,
                    n_messages: stats.n_messages,
                    n_tool_use: tool_names.len(),
                    preview: first_line_preview(&text, 120),
                    tool_names,
                    error_message: error_message.clone(),
                })
            }
            _ => None,
        })
        .collect()
}

/// Reconstruct the input context sent to the model for the call at `seq`,
/// flattened into per-block entries for the diff view. Uses the same context
/// resolution as the live engine (honoring compaction/marker baselines), then
/// takes the snapshot *just before* this assistant turn — i.e. everything the
/// model saw as input, excluding this span's own response.
fn build_input_blocks(entries: &[TranscriptEntry], seq: u64) -> Vec<InputBlock> {
    let idx = match entries.iter().position(|e| e.seq == seq) {
        Some(i) => i,
        None => return Vec::new(),
    };
    let prior_seq = if idx == 0 { 0 } else { entries[idx - 1].seq };
    let items = crate::session::conversation::context_view::resolve_snapshot_at(entries, prior_seq);

    let mut out = Vec::new();
    for (mi, item) in items.iter().enumerate() {
        match item {
            TranscriptItem::User { text, .. } => {
                if !text.trim().is_empty() {
                    out.push(InputBlock {
                        mi,
                        role: "user".into(),
                        block: SpanBlock::Text { text: text.clone() },
                    });
                }
            }
            TranscriptItem::Assistant { content, .. } => {
                for block in content {
                    let block = match block {
                        AssistantBlock::Text { text } if !text.trim().is_empty() => {
                            Some(SpanBlock::Text { text: text.clone() })
                        }
                        AssistantBlock::Thinking { text, .. } if !text.trim().is_empty() => {
                            Some(SpanBlock::Thinking { text: text.clone() })
                        }
                        AssistantBlock::ToolCall {
                            id, name, input, ..
                        } => Some(SpanBlock::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        }),
                        _ => None,
                    };
                    if let Some(block) = block {
                        out.push(InputBlock {
                            mi,
                            role: "assistant".into(),
                            block,
                        });
                    }
                }
            }
            TranscriptItem::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => {
                out.push(InputBlock {
                    mi,
                    role: "tool".into(),
                    block: SpanBlock::ToolResult {
                        tool_use_id: tool_call_id.clone(),
                        content: content.clone(),
                        is_error: *is_error,
                    },
                });
            }
            _ => {}
        }
    }
    out
}

/// Build the full detail for the assistant span at `seq`, pairing it with the
/// tool results and the user/tool input that immediately precede/follow it.
pub fn project_span_detail(entries: &[TranscriptEntry], seq: u64) -> Option<SpanDetail> {
    let idx = entries.iter().position(|e| e.seq == seq)?;
    let entry = &entries[idx];
    let TranscriptItem::Assistant {
        content,
        stop_reason,
        usage,
        model,
        error_message,
        ..
    } = &entry.item
    else {
        return None;
    };

    // Preserve provider content order in the trace detail.
    let blocks = content
        .iter()
        .filter_map(|block| match block {
            AssistantBlock::Text { text } if !text.trim().is_empty() => {
                Some(SpanBlock::Text { text: text.clone() })
            }
            AssistantBlock::Thinking { text, .. } if !text.trim().is_empty() => {
                Some(SpanBlock::Thinking { text: text.clone() })
            }
            AssistantBlock::ToolCall {
                id, name, input, ..
            } => Some(SpanBlock::ToolUse {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect();

    // Tool results that follow this span, up to the next assistant call.
    let mut tool_results = Vec::new();
    for next in &entries[idx + 1..] {
        match &next.item {
            TranscriptItem::Assistant { .. } => break,
            TranscriptItem::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => {
                let (duration_ms, result_tokens) = tool_finished_for(entries, idx, tool_call_id);
                tool_results.push(SpanToolResult {
                    tool_use_id: tool_call_id.clone(),
                    content: content.clone(),
                    is_error: *is_error,
                    duration_ms,
                    result_tokens,
                });
            }
            _ => {}
        }
    }

    // What the assistant was reacting to: the most recent user/tool input
    // before this span.
    let mut reacting_to = String::new();
    for prev in entries[..idx].iter().rev() {
        match &prev.item {
            TranscriptItem::User { text, .. } => {
                reacting_to = first_line_preview(text, 160);
                break;
            }
            TranscriptItem::ToolResult { tool_name, .. } => {
                reacting_to = format!("\u{2192} {tool_name} result");
                break;
            }
            TranscriptItem::Assistant { .. } => break,
            _ => {}
        }
    }

    let stats = span_stats_for(entries, idx as u64);
    let (system_prompt, tool_definitions) = span_request_payload(entries, idx);
    Some(SpanDetail {
        seq: entry.seq,
        model: model.clone(),
        stop_reason: stop_reason.clone(),
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write,
        duration_ms: stats.duration_ms,
        ttft_ms: stats.ttft_ms,
        context_window: stats.context_window,
        n_messages: stats.n_messages,
        system_prompt_tokens: stats.system_prompt_tokens,
        system_prompt,
        tool_definitions,
        reacting_to,
        blocks,
        tool_results,
        input_messages: build_input_blocks(entries, seq),
        error_message: error_message.clone(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivitySummary {
    pub started_at: String,
    pub last_message_at: String,
    pub model: String,
    pub session_input_tokens: u64,
    pub session_output_tokens: u64,
    pub context_tokens: u64,
    pub context_window: u64,
    pub llm_calls: usize,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_reads: u64,
    pub cache_writes: u64,
    pub total_tokens: u64,
    pub peak_context: u64,
    pub tools: usize,
    pub turns: u32,
    pub searches: usize,
    pub compact: usize,
    pub cache_hit_percent: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityRow {
    pub seq: u64,
    pub elapsed_ms: u64,
    pub kind: String,
    pub badge: String,
    pub title: String,
    pub subtitle: String,
    pub detail: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityProjection {
    pub summary: ActivitySummary,
    pub rows: Vec<ActivityRow>,
}

fn entry_elapsed_ms(entries: &[TranscriptEntry], idx: usize) -> u64 {
    let first = entries
        .first()
        .and_then(|e| chrono::DateTime::parse_from_rfc3339(&e.created_at).ok())
        .map(|dt| dt.timestamp_millis());
    let current = entries
        .get(idx)
        .and_then(|e| chrono::DateTime::parse_from_rfc3339(&e.created_at).ok())
        .map(|dt| dt.timestamp_millis());
    match (first, current) {
        (Some(a), Some(b)) if b >= a => (b - a) as u64,
        _ => 0,
    }
}

fn json_value<T: Serialize>(value: &T) -> serde_json::Value {
    match serde_json::to_value(value) {
        Ok(v) => v,
        Err(_) => serde_json::Value::Null,
    }
}

fn compact_json_text(value: &serde_json::Value, max: usize) -> String {
    let raw = match value {
        serde_json::Value::String(s) => s.clone(),
        _ => value.to_string(),
    };
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() > max {
        let truncated: String = text.chars().take(max).collect();
        format!("{truncated}\u{2026}")
    } else {
        text
    }
}

pub fn project_activity(
    entries: &[TranscriptEntry],
    meta: Option<&SessionMeta>,
) -> ActivityProjection {
    let spans = project_spans(entries);
    let tools = spans.iter().map(|s| s.n_tool_use).sum::<usize>();
    let searches = spans
        .iter()
        .flat_map(|s| s.tool_names.iter())
        .filter(|name| name.to_ascii_lowercase().contains("search"))
        .count();
    let turns = entries.iter().map(|e| e.turn).max().unwrap_or_default();
    let compact_items = entries
        .iter()
        .filter(|e| matches!(e.item, TranscriptItem::Compact { .. }))
        .count();
    let compact_started = entries
        .iter()
        .filter(|e| {
            matches!(
                TranscriptStats::try_from_item(&e.item),
                Some(TranscriptStats::ContextCompactionStarted(_))
            )
        })
        .count();
    let compact_completed = entries
        .iter()
        .filter(|e| {
            matches!(
                TranscriptStats::try_from_item(&e.item),
                Some(TranscriptStats::ContextCompactionCompleted(_))
            )
        })
        .count();
    let compact = compact_items.max(compact_started).max(compact_completed);

    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache_read = 0u64;
    let mut total_cache_write = 0u64;
    let mut context_tokens = 0u64;
    let mut context_window = 0u64;
    let mut peak_context = 0u64;
    let mut elapsed_ms = 0u64;

    for (idx, entry) in entries.iter().enumerate() {
        elapsed_ms = elapsed_ms.max(entry_elapsed_ms(entries, idx));
        match &entry.item {
            TranscriptItem::Assistant { usage, .. } => {
                total_input += usage.input;
                total_output += usage.output;
                total_cache_read += usage.cache_read;
                total_cache_write += usage.cache_write;
                context_tokens = usage.input.saturating_add(usage.cache_read);
                peak_context = peak_context.max(context_tokens);
            }
            item => {
                if let Some(TranscriptStats::LlmCallCompleted(s)) =
                    TranscriptStats::try_from_item(item)
                {
                    context_window = context_window.max(s.context_window as u64);
                    if s.context_window > 0 && context_tokens == 0 {
                        context_tokens = s.usage.input.saturating_add(s.usage.cache_read);
                        peak_context = peak_context.max(context_tokens);
                    }
                }
            }
        }
    }

    let cache_denominator = total_input
        .saturating_add(total_cache_read)
        .saturating_add(total_cache_write);
    let cache_hit_percent = if cache_denominator == 0 {
        0
    } else {
        total_cache_read.saturating_mul(100) / cache_denominator
    };

    let mut rows = Vec::new();
    for (idx, entry) in entries.iter().enumerate() {
        let elapsed = entry_elapsed_ms(entries, idx);
        match &entry.item {
            TranscriptItem::User { text, .. } => rows.push(ActivityRow {
                seq: entry.seq,
                elapsed_ms: elapsed,
                kind: "user".into(),
                badge: "USER".into(),
                title: first_line_preview(text, 120),
                subtitle: String::new(),
                detail: json_value(&entry.item),
            }),
            TranscriptItem::Assistant {
                content,
                stop_reason,
                usage,
                error_message,
                ..
            } => {
                let text = crate::types::assistant_text(content);
                for (id, name, input) in content.iter().filter_map(|block| match block {
                    AssistantBlock::ToolCall {
                        id, name, input, ..
                    } => Some((id, name, input)),
                    _ => None,
                }) {
                    rows.push(ActivityRow {
                        seq: entry.seq,
                        elapsed_ms: elapsed,
                        kind: "tool".into(),
                        badge: "TOOL".into(),
                        title: name.clone(),
                        subtitle: compact_json_text(input, 110),
                        detail: serde_json::json!({
                            "id": id,
                            "name": name,
                            "input": input,
                        }),
                    });
                }
                let badge = if error_message.is_some() {
                    "ERROR"
                } else {
                    "COMPLETE"
                };
                rows.push(ActivityRow {
                    seq: entry.seq,
                    elapsed_ms: elapsed,
                    kind: if error_message.is_some() {
                        "error"
                    } else {
                        "complete"
                    }
                    .into(),
                    badge: badge.into(),
                    title: if text.trim().is_empty() {
                        format!("assistant \u{2192} {stop_reason}")
                    } else {
                        first_line_preview(&text, 120)
                    },
                    subtitle: format!(
                        "{} in / {} out{}",
                        usage.input,
                        usage.output,
                        if usage.cache_read > 0 {
                            " · cache hit"
                        } else {
                            ""
                        }
                    ),
                    detail: json_value(&entry.item),
                });
            }
            TranscriptItem::ToolResult {
                tool_name,
                content,
                is_error,
                ..
            } => rows.push(ActivityRow {
                seq: entry.seq,
                elapsed_ms: elapsed,
                kind: if *is_error { "error" } else { "tool_result" }.into(),
                badge: if *is_error { "ERROR" } else { "RESULT" }.into(),
                title: tool_name.clone(),
                subtitle: first_line_preview(content, 120),
                detail: json_value(&entry.item),
            }),
            TranscriptItem::Compact {
                summary,
                tokens_before,
                tokens_after,
                ..
            } => rows.push(ActivityRow {
                seq: entry.seq,
                elapsed_ms: elapsed,
                kind: "compact".into(),
                badge: "COMPACT".into(),
                title: format!("{tokens_before} \u{2192} {tokens_after} tokens"),
                subtitle: first_line_preview(summary, 120),
                detail: json_value(&entry.item),
            }),
            item => {
                if let Some(stats) = TranscriptStats::try_from_item(item) {
                    match stats {
                        TranscriptStats::LlmCallCompleted(s) => {
                            if s.usage.cache_read > 0 {
                                rows.push(ActivityRow {
                                    seq: entry.seq,
                                    elapsed_ms: elapsed,
                                    kind: "cache".into(),
                                    badge: "CACHE".into(),
                                    title: format!(
                                        "cache hit: {} tokens served from prompt cache",
                                        s.usage.cache_read
                                    ),
                                    subtitle: String::new(),
                                    detail: json_value(item),
                                });
                            }
                        }
                        TranscriptStats::RunFinished(s) => rows.push(ActivityRow {
                            seq: entry.seq,
                            elapsed_ms: elapsed,
                            kind: "done".into(),
                            badge: "DONE".into(),
                            title: format!("run complete · {} turns", s.turn_count),
                            subtitle: format!("{} transcript entries", s.transcript_count),
                            detail: json_value(item),
                        }),
                        TranscriptStats::ContextCompactionCompleted(_) => rows.push(ActivityRow {
                            seq: entry.seq,
                            elapsed_ms: elapsed,
                            kind: "compact".into(),
                            badge: "COMPACT".into(),
                            title: "context compacted".into(),
                            subtitle: String::new(),
                            detail: json_value(item),
                        }),
                        _ => {}
                    }
                }
            }
        }
    }

    let meta_input_tokens = meta.map(|m| m.total_input_tokens).unwrap_or_default();
    let meta_output_tokens = meta.map(|m| m.total_output_tokens).unwrap_or_default();
    let session_input_tokens = if meta_input_tokens > 0 {
        meta_input_tokens
    } else {
        total_input
            .saturating_add(total_cache_read)
            .saturating_add(total_cache_write)
    };
    let session_output_tokens = if meta_output_tokens > 0 {
        meta_output_tokens
    } else {
        total_output
    };

    ActivityProjection {
        summary: ActivitySummary {
            started_at: meta.map(|m| m.created_at.clone()).unwrap_or_default(),
            last_message_at: meta.map(|m| m.updated_at.clone()).unwrap_or_default(),
            model: meta.map(|m| m.model.clone()).unwrap_or_default(),
            session_input_tokens,
            session_output_tokens,
            context_tokens,
            context_window,
            llm_calls: spans.len(),
            input_tokens: total_input,
            output_tokens: total_output,
            cache_reads: total_cache_read,
            cache_writes: total_cache_write,
            total_tokens: session_input_tokens
                .saturating_add(session_output_tokens)
                .saturating_add(total_cache_read)
                .saturating_add(total_cache_write),
            peak_context,
            tools,
            turns,
            searches,
            compact,
            cache_hit_percent,
            elapsed_ms,
        },
        rows,
    }
}
