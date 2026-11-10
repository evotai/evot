//! Tool execution: sequential, batch, and single-tool dispatch.

use std::sync::Arc;

use super::config::GetMessagesFn;
use super::event_sink::EventSink;
use crate::context;
use crate::event::AgentEvent;
use crate::provider::ToolDefinition;
use crate::spill::FsSpill;
use crate::time::now_ms;
use crate::types::PathGuard;
use crate::types::*;

/// Resolve per-model tool names and descriptions into provider definitions.
pub(super) fn build_tool_definitions(context: &AgentContext, model: &str) -> Vec<ToolDefinition> {
    context
        .tools
        .iter()
        .map(|tool| ToolDefinition {
            name: tool.resolve_name(model),
            description: crate::tools::resolve_tool_refs(tool.description(), &context.tools, model),
            parameters: tool.parameters_schema(),
        })
        .collect()
}

pub(super) struct ToolExecutionResult {
    pub tool_results: Vec<Message>,
    pub steering_messages: Option<Vec<AgentMessage>>,
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_tool_calls(
    tools: &[Box<dyn AgentTool>],
    tool_calls: &[(String, String, serde_json::Value)],
    tx: &EventSink,
    cancel: &tokio_util::sync::CancellationToken,
    get_steering: Option<&GetMessagesFn>,
    strategy: &ToolExecutionStrategy,
    cwd: &std::path::Path,
    path_guard: &Arc<PathGuard>,
    spill: &Option<Arc<FsSpill>>,
    idle_clock: Option<&crate::context::IdleClock>,
    supports_image: bool,
) -> ToolExecutionResult {
    match strategy {
        ToolExecutionStrategy::Sequential => {
            execute_sequential(
                tools,
                tool_calls,
                tx,
                cancel,
                get_steering,
                cwd,
                path_guard,
                spill,
                idle_clock,
                supports_image,
            )
            .await
        }
        ToolExecutionStrategy::Parallel => {
            execute_batch(
                tools,
                tool_calls,
                tx,
                cancel,
                get_steering,
                cwd,
                path_guard,
                spill,
                idle_clock,
                supports_image,
            )
            .await
        }
        ToolExecutionStrategy::Batched { size } => {
            let mut results: Vec<Message> = Vec::new();
            let mut steering_messages: Option<Vec<AgentMessage>> = None;

            for (batch_idx, batch) in tool_calls.chunks(*size).enumerate() {
                let batch_result = execute_batch(
                    tools,
                    batch,
                    tx,
                    cancel,
                    None,
                    cwd,
                    path_guard,
                    spill,
                    idle_clock,
                    supports_image,
                )
                .await;
                results.extend(batch_result.tool_results);

                // Check steering between batches
                if let Some(get_steering_fn) = get_steering {
                    let steering = get_steering_fn();
                    if !steering.is_empty() {
                        steering_messages = Some(steering);
                        // Skip remaining batches
                        let executed = (batch_idx + 1) * *size;
                        if executed < tool_calls.len() {
                            for (skip_id, skip_name, _) in &tool_calls[executed..] {
                                results.push(skip_tool_call(skip_id, skip_name, tx).await);
                            }
                        }
                        break;
                    }
                }
            }

            ToolExecutionResult {
                tool_results: results,
                steering_messages,
            }
        }
    }
}

/// Execute tool calls one at a time, checking steering between each.
#[allow(clippy::too_many_arguments)]
async fn execute_sequential(
    tools: &[Box<dyn AgentTool>],
    tool_calls: &[(String, String, serde_json::Value)],
    tx: &EventSink,
    cancel: &tokio_util::sync::CancellationToken,
    get_steering: Option<&GetMessagesFn>,
    cwd: &std::path::Path,
    path_guard: &Arc<PathGuard>,
    spill: &Option<Arc<FsSpill>>,
    idle_clock: Option<&crate::context::IdleClock>,
    supports_image: bool,
) -> ToolExecutionResult {
    let mut results: Vec<Message> = Vec::new();
    let mut steering_messages: Option<Vec<AgentMessage>> = None;

    for (index, (id, name, args)) in tool_calls.iter().enumerate() {
        let (msg, _is_error) = execute_single_tool(
            tools,
            id,
            name,
            args,
            tx,
            cancel,
            cwd,
            path_guard,
            spill,
            idle_clock,
            supports_image,
        )
        .await;
        results.push(msg);

        // Check for steering — skip remaining tools if user interrupted
        if let Some(get_steering_fn) = get_steering {
            let steering = get_steering_fn();
            if !steering.is_empty() {
                steering_messages = Some(steering);
                for (skip_id, skip_name, _) in &tool_calls[index + 1..] {
                    results.push(skip_tool_call(skip_id, skip_name, tx).await);
                }
                break;
            }
        }
    }

    ToolExecutionResult {
        tool_results: results,
        steering_messages,
    }
}

/// Execute a batch of tool calls concurrently using futures::join_all.
#[allow(clippy::too_many_arguments)]
async fn execute_batch(
    tools: &[Box<dyn AgentTool>],
    tool_calls: &[(String, String, serde_json::Value)],
    tx: &EventSink,
    cancel: &tokio_util::sync::CancellationToken,
    get_steering: Option<&GetMessagesFn>,
    cwd: &std::path::Path,
    path_guard: &Arc<PathGuard>,
    spill: &Option<Arc<FsSpill>>,
    idle_clock: Option<&crate::context::IdleClock>,
    supports_image: bool,
) -> ToolExecutionResult {
    use futures::future::join_all;

    let futures: Vec<_> = tool_calls
        .iter()
        .map(|(id, name, args)| {
            execute_single_tool(
                tools,
                id,
                name,
                args,
                tx,
                cancel,
                cwd,
                path_guard,
                spill,
                idle_clock,
                supports_image,
            )
        })
        .collect();

    let batch_results = join_all(futures).await;

    let results: Vec<Message> = batch_results.into_iter().map(|(msg, _)| msg).collect();

    // Check steering after batch completes
    let steering_messages = if let Some(get_steering_fn) = get_steering {
        let steering = get_steering_fn();
        if steering.is_empty() {
            None
        } else {
            Some(steering)
        }
    } else {
        None
    };

    ToolExecutionResult {
        tool_results: results,
        steering_messages,
    }
}

/// Execute a single tool call and emit events.
#[allow(clippy::too_many_arguments)]
async fn execute_single_tool(
    tools: &[Box<dyn AgentTool>],
    id: &str,
    name: &str,
    args: &serde_json::Value,
    tx: &EventSink,
    cancel: &tokio_util::sync::CancellationToken,
    cwd: &std::path::Path,
    path_guard: &Arc<PathGuard>,
    spill: &Option<Arc<FsSpill>>,
    idle_clock: Option<&crate::context::IdleClock>,
    supports_image: bool,
) -> (Message, bool) {
    let tool = tools.iter().find(|t| t.matches_call_name(name));

    let preview_command = tool.and_then(|t| t.preview_command(args));

    tx.send(AgentEvent::ToolExecutionStart {
        tool_call_id: id.to_string(),
        tool_name: name.to_string(),
        args: args.clone(),
        preview_command,
    })
    .await
    .ok();

    let tool_start = std::time::Instant::now();

    // --- File Read dedup removed: token-budget microcompact keeps content in context ---

    let on_update: Option<ToolUpdateFn> = {
        let tx = tx.clone();
        let id = id.to_string();
        let name = name.to_string();
        Some(Arc::new(move |partial: ToolResult| {
            tx.progress(AgentEvent::ToolExecutionUpdate {
                tool_call_id: id.clone(),
                tool_name: name.clone(),
                partial_result: partial,
            });
        }))
    };

    let on_progress: Option<ProgressFn> = {
        let tx = tx.clone();
        let id = id.to_string();
        let name = name.to_string();
        Some(Arc::new(move |text: String| {
            tx.progress(AgentEvent::ProgressMessage {
                tool_call_id: id.clone(),
                tool_name: name.clone(),
                text,
            });
        }))
    };

    let ctx = ToolContext {
        tool_call_id: id.to_string(),
        tool_name: name.to_string(),
        cancel: cancel.child_token(),
        on_update,
        on_progress,
        cwd: cwd.to_path_buf(),
        path_guard: path_guard.clone(),
        spill: spill.clone(),
        supports_image,
    };

    let (result, is_error) = match tool {
        Some(tool) => run_tool_once(tool.as_ref(), name, args, ctx, idle_clock).await,
        None => (
            ToolResult {
                content: vec![Content::Text {
                    text: format!("Tool {} not found", name),
                }],
                details: serde_json::Value::Null,
                retention: Retention::Normal,
            },
            true,
        ),
    };

    // System-level tool result size management.
    // If spill is configured, large results are written to disk with a preview.
    // Otherwise, fall back to truncation.
    let (result, spill_event) = process_result(spill, id, name, result, is_error).await;
    if let Some(event) = spill_event {
        tx.send(AgentEvent::ProgressMessage {
            tool_call_id: id.to_string(),
            tool_name: name.to_string(),
            text: event.to_progress_text(),
        })
        .await
        .ok();
    }

    let result_tokens = context::content_tokens(&result.content);
    let tool_duration_ms = tool_start.elapsed().as_millis() as u64;

    tx.send(AgentEvent::ToolExecutionEnd {
        tool_call_id: id.to_string(),
        tool_name: name.to_string(),
        result: result.clone(),
        is_error,
        result_tokens,
        duration_ms: tool_duration_ms,
    })
    .await
    .ok();

    let tool_result_msg = Message::ToolResult {
        tool_call_id: id.to_string(),
        tool_name: name.to_string(),
        content: result.content,
        is_error,
        timestamp: now_ms(),
        retention: result.retention,
    };

    tx.send(AgentEvent::MessageStart {
        message: tool_result_msg.clone().into(),
    })
    .await
    .ok();
    tx.send(AgentEvent::MessageEnd {
        message: tool_result_msg.clone().into(),
    })
    .await
    .ok();

    (tool_result_msg, is_error)
}

/// Validate `args` against the tool schema and execute it once.
async fn run_tool_once(
    tool: &dyn AgentTool,
    name: &str,
    args: &serde_json::Value,
    ctx: ToolContext,
    idle_clock: Option<&crate::context::IdleClock>,
) -> (ToolResult, bool) {
    // Step 1: Normalize parameter aliases (file_path → path, etc.)
    let mut normalized = match tool.parameter_aliases() {
        Some(aliases) => crate::tools::validation::normalize_aliases(args, aliases),
        None => args.clone(),
    };

    // Step 2: Run the tool's compatibility shim before validation.
    normalized = tool.prepare_arguments(&normalized);

    // Step 3: Schema pre-validation + type coercion
    let validated_args = crate::tools::validation::validate_and_coerce_with_received(
        name,
        &tool.parameters_schema(),
        &normalized,
        args,
    );
    match validated_args {
        Err(validation_error) => (
            ToolResult {
                content: vec![Content::Text {
                    text: crate::tools::validation::truncate_error(&validation_error),
                }],
                details: serde_json::Value::Null,
                retention: Retention::Normal,
            },
            true,
        ),
        Ok(coerced_args) => {
            // Exclude tool wall-time from the execution duration limit:
            // a legitimately long command (a build, a training run) or a
            // slow user response must not trip `max_duration`. The limit
            // bounds the agent's own work (LLM inference + loop
            // overhead), not how long a tool takes to run. The guard
            // records the elapsed span into the idle clock on drop, so
            // it counts on success, error, cancellation, and panic alike.
            let _idle = idle_clock.map(|c| c.pause());
            match tool.execute(coerced_args, ctx).await {
                Ok(r) => (r, false),
                Err(e) => (
                    ToolResult {
                        content: vec![Content::Text {
                            text: e.to_string(),
                        }],
                        details: serde_json::Value::Null,
                        retention: Retention::Normal,
                    },
                    true,
                ),
            }
        }
    }
}

pub(super) async fn fail_truncated_tool_calls(
    tool_calls: &[(String, String, serde_json::Value)],
    tx: &EventSink,
) -> Vec<Message> {
    let mut messages = Vec::with_capacity(tool_calls.len());
    for (tool_call_id, tool_name, args) in tool_calls {
        let result = ToolResult {
                content: vec![Content::Text {
                    text: format!(
                        "Tool call \"{tool_name}\" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments."
                    ),
                }],
                details: serde_json::Value::Null,
                retention: Retention::Normal,
            };

        tx.send(AgentEvent::ToolExecutionStart {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            args: args.clone(),
            preview_command: None,
        })
        .await
        .ok();

        let result_tokens = context::content_tokens(&result.content);
        tx.send(AgentEvent::ToolExecutionEnd {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            result: result.clone(),
            is_error: true,
            result_tokens,
            duration_ms: 0,
        })
        .await
        .ok();

        let message = Message::ToolResult {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.clone(),
            content: result.content,
            is_error: true,
            timestamp: now_ms(),
            retention: Retention::Normal,
        };
        tx.send(AgentEvent::MessageStart {
            message: message.clone().into(),
        })
        .await
        .ok();
        tx.send(AgentEvent::MessageEnd {
            message: message.clone().into(),
        })
        .await
        .ok();
        messages.push(message);
    }
    messages
}

pub(super) async fn skip_tool_call(tool_call_id: &str, tool_name: &str, tx: &EventSink) -> Message {
    let result = ToolResult {
        content: vec![Content::Text {
            text: "Skipped due to queued user message.".into(),
        }],
        details: serde_json::Value::Null,
        retention: Retention::Normal,
    };

    tx.send(AgentEvent::ToolExecutionStart {
        tool_call_id: tool_call_id.into(),
        tool_name: tool_name.into(),
        args: serde_json::Value::Null,
        preview_command: None,
    })
    .await
    .ok();

    let result_tokens = context::content_tokens(&result.content);

    tx.send(AgentEvent::ToolExecutionEnd {
        tool_call_id: tool_call_id.into(),
        tool_name: tool_name.into(),
        result: result.clone(),
        is_error: true,
        result_tokens,
        duration_ms: 0,
    })
    .await
    .ok();

    let msg = Message::ToolResult {
        tool_call_id: tool_call_id.into(),
        tool_name: tool_name.into(),
        content: result.content,
        is_error: true,
        timestamp: now_ms(),
        retention: Retention::Normal,
    };

    tx.send(AgentEvent::MessageStart {
        message: msg.clone().into(),
    })
    .await
    .ok();
    tx.send(AgentEvent::MessageEnd {
        message: msg.clone().into(),
    })
    .await
    .ok();

    msg
}

pub(super) async fn skip_tool_call_doom_loop(
    tool_call_id: &str,
    tool_name: &str,
    args: &serde_json::Value,
    tx: &EventSink,
) -> Message {
    let result = ToolResult {
        content: vec![Content::Text {
            text: "Skipped: doom loop detected — repeated identical tool call.".into(),
        }],
        details: serde_json::Value::Null,
        retention: Retention::Normal,
    };

    let preview = build_doom_loop_preview(tool_name, args);

    tx.send(AgentEvent::ToolExecutionStart {
        tool_call_id: tool_call_id.into(),
        tool_name: tool_name.into(),
        args: args.clone(),
        preview_command: Some(preview),
    })
    .await
    .ok();

    let result_tokens = context::content_tokens(&result.content);

    tx.send(AgentEvent::ToolExecutionEnd {
        tool_call_id: tool_call_id.into(),
        tool_name: tool_name.into(),
        result: result.clone(),
        is_error: true,
        result_tokens,
        duration_ms: 0,
    })
    .await
    .ok();

    let msg = Message::ToolResult {
        tool_call_id: tool_call_id.into(),
        tool_name: tool_name.into(),
        content: result.content,
        is_error: true,
        timestamp: now_ms(),
        retention: Retention::Normal,
    };

    tx.send(AgentEvent::MessageStart {
        message: msg.clone().into(),
    })
    .await
    .ok();
    tx.send(AgentEvent::MessageEnd {
        message: msg.clone().into(),
    })
    .await
    .ok();

    msg
}

/// Build a compact preview string for doom-loop skipped tool calls.
fn build_doom_loop_preview(tool_name: &str, args: &serde_json::Value) -> String {
    let mut parts = vec![tool_name.to_string()];
    if let serde_json::Value::Object(map) = args {
        for (k, v) in map {
            let val = match v {
                serde_json::Value::String(s) => {
                    if s.len() > 80 {
                        let end = s.floor_char_boundary(80);
                        format!("{}…", &s[..end])
                    } else {
                        s.clone()
                    }
                }
                other => {
                    let s = other.to_string();
                    if s.len() > 80 {
                        let end = s.floor_char_boundary(80);
                        format!("{}…", &s[..end])
                    } else {
                        s
                    }
                }
            };
            parts.push(format!("{k}={val}"));
        }
    }
    parts.join(" ")
}

// ── Spill / truncation helpers ──────────────────────────────────────────

const PREVIEW_CAP: usize = 4_000;

#[derive(Debug)]
struct SpillEvent(SpillProgress);

impl SpillEvent {
    fn to_progress_text(&self) -> String {
        self.0.to_progress_text()
    }
}

async fn process_result(
    spill: &Option<Arc<FsSpill>>,
    tool_call_id: &str,
    tool_name: &str,
    result: ToolResult,
    is_error: bool,
) -> (ToolResult, Option<SpillEvent>) {
    if is_error {
        return (truncate_result(result), None);
    }

    let spill = match spill {
        Some(s) => s,
        None => return (truncate_result(result), None),
    };

    let text = merge_text_blocks(&result.content);
    if text.is_empty() {
        return (result, None);
    }

    let req = crate::spill::SpillRequest {
        key: tool_call_id.to_string(),
        text,
    };

    match spill.spill(req).await {
        Ok(Some(spill_ref)) => {
            let mut details = result.details;
            merge_spill_details(&mut details, &spill_ref);
            let event = SpillEvent(SpillProgress::write(
                spill_ref.path.to_string_lossy(),
                spill_ref.size_bytes,
                spill_ref.preview.len(),
            ));
            (
                build_spilled_result(result.content, details, result.retention, spill_ref),
                Some(event),
            )
        }
        Ok(None) => (truncate_result(result), None),
        Err(e) => {
            tracing::warn!(
                tool_name = tool_name,
                tool_call_id = tool_call_id,
                "spill failed: {e}"
            );
            (truncate_result(result), None)
        }
    }
}

fn build_spilled_result(
    content: Vec<Content>,
    details: serde_json::Value,
    retention: Retention,
    spill_ref: crate::spill::SpillRef,
) -> ToolResult {
    let preview = if spill_ref.preview.len() > PREVIEW_CAP {
        let boundary = spill_ref.preview.floor_char_boundary(PREVIEW_CAP);
        &spill_ref.preview[..boundary]
    } else {
        &spill_ref.preview
    };

    let msg = format!(
        "Tool output was too large ({} bytes) and was saved to:\n{}\n\n\
         Only a preview is shown below. Use Read with offset/limit to read the full output.\n\n\
         Preview:\n{}",
        spill_ref.size_bytes,
        spill_ref.path.display(),
        preview,
    );

    let mut new_content: Vec<Content> = vec![Content::Text { text: msg }];
    for c in content {
        if !matches!(c, Content::Text { .. }) {
            new_content.push(c);
        }
    }

    ToolResult {
        content: new_content,
        details,
        retention,
    }
}

fn merge_spill_details(details: &mut serde_json::Value, spill_ref: &crate::spill::SpillRef) {
    let spill_details = serde_json::json!({
        "kind": "write",
        "path": spill_ref.path.to_string_lossy(),
        "size_bytes": spill_ref.size_bytes,
        "preview_bytes": spill_ref.preview.len(),
    });

    match details {
        serde_json::Value::Object(map) => {
            map.insert("spill".to_string(), spill_details);
        }
        _ => {
            *details = serde_json::json!({ "spill": spill_details });
        }
    }
}

fn truncate_result(result: ToolResult) -> ToolResult {
    let ToolResult {
        content,
        details,
        retention,
    } = result;
    ToolResult {
        content: crate::tools::validation::cap_tool_result_content(
            content,
            crate::spill::MAX_TOOL_RESULT_BYTES,
        ),
        details,
        retention,
    }
}

fn merge_text_blocks(content: &[Content]) -> String {
    let mut merged = String::new();
    for c in content {
        if let Content::Text { text } = c {
            if !merged.is_empty() {
                merged.push('\n');
            }
            merged.push_str(text);
        }
    }
    merged
}

// ── File Read dedup helpers ────────────────────────────────────────────────
