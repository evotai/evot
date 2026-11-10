use std::time::Duration;

use tokio::time::Instant;

use super::traits::MessageSink;
use crate::agent::Run;
use crate::base::error::Result;
use crate::session::conversation::RunEventPayload;

pub struct StreamDeliveryConfig {
    /// Minimum chars before sending the first message.
    pub min_initial_chars: usize,
    /// Minimum interval between edits.
    pub throttle: Duration,
    /// Show tool execution progress in the message.
    pub show_tool_progress: bool,
}

impl Default for StreamDeliveryConfig {
    fn default() -> Self {
        Self {
            min_initial_chars: 80,
            throttle: Duration::from_millis(1000),
            show_tool_progress: true,
        }
    }
}

/// Deliver a Run progressively through a MessageSink.
///
/// If the sink supports editing, sends an initial message then edits it
/// as new content arrives. Otherwise, waits for the stream to finish
/// and sends the final text in one shot.
pub async fn deliver(
    sink: &dyn MessageSink,
    chat_id: &str,
    run: &mut Run,
    config: &StreamDeliveryConfig,
) -> Result<String> {
    let caps = sink.capabilities();

    if caps.can_edit {
        deliver_progressive(
            sink,
            chat_id,
            run,
            config,
            caps.max_message_len,
            caps.max_edits_per_message,
        )
        .await
    } else {
        deliver_final(sink, chat_id, run, caps.max_message_len).await
    }
}

/// Progressive delivery: send first, then edit in-place.
async fn deliver_progressive(
    sink: &dyn MessageSink,
    chat_id: &str,
    run: &mut Run,
    config: &StreamDeliveryConfig,
    max_len: usize,
    max_edits: usize,
) -> Result<String> {
    let mut text_buf = String::new();
    let mut tool_status = String::new();
    let mut msg_id: Option<String> = None;
    let mut last_edit = Instant::now();
    let mut edit_count: usize = 0;
    // Byte offset into text_buf: content before this was finalized in a previous message.
    // When we hit the edit limit, we advance this so the next message only shows
    // the continuation, not a repeat of everything.
    let mut text_offset: usize = 0;
    // Tracks text_buf.len() at the time of the last successful edit/send.
    // When edit limit is reached, we use this as the new text_offset so the
    // next message doesn't repeat content already shown in the previous message.
    let mut last_sent_end: usize = 0;
    // After an edit-limit reset, use a lower threshold to send the next message
    // so the user isn't left staring at silence during long tool runs.
    let mut continuation = false;

    while let Some(event) = run.next().await {
        match &event.payload {
            RunEventPayload::AssistantDelta {
                content_type,
                delta,
                ..
            } if matches!(
                content_type,
                crate::session::conversation::AssistantContentType::Text
            ) && !delta.is_empty() =>
            {
                text_buf.push_str(delta);
                let visible = &text_buf[text_offset..];
                let threshold = if continuation {
                    1
                } else {
                    config.min_initial_chars
                };

                if msg_id.is_none() && visible.len() >= threshold {
                    let display = compose_display(visible, &tool_status, max_len);
                    match sink.send_text(chat_id, &display).await {
                        Ok(id) => {
                            msg_id = Some(id);
                            edit_count = 0;
                            continuation = false;
                            last_edit = Instant::now();
                            last_sent_end = text_buf.len();
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "delivery: send initial failed");
                        }
                    }
                } else if msg_id.is_some()
                    && last_edit.elapsed() >= config.throttle
                    && !try_edit_counted(
                        sink,
                        chat_id,
                        msg_id.as_deref(),
                        visible,
                        &tool_status,
                        max_len,
                        max_edits,
                        &mut edit_count,
                        &mut last_edit,
                        &mut last_sent_end,
                        text_buf.len(),
                    )
                    .await
                {
                    text_offset = last_sent_end;
                    msg_id = None;
                    continuation = true;
                }
            }

            RunEventPayload::ToolStarted { tool_name, .. } if config.show_tool_progress => {
                tool_status = format!("\u{1f527} {tool_name}...");
                if msg_id.is_some() {
                    let visible = &text_buf[text_offset..];
                    if !try_edit_counted(
                        sink,
                        chat_id,
                        msg_id.as_deref(),
                        visible,
                        &tool_status,
                        max_len,
                        max_edits,
                        &mut edit_count,
                        &mut last_edit,
                        &mut last_sent_end,
                        text_buf.len(),
                    )
                    .await
                    {
                        text_offset = last_sent_end;
                        msg_id = None;
                        continuation = true;
                    }
                }
            }

            RunEventPayload::ToolFinished {
                tool_name,
                is_error,
                ..
            } if config.show_tool_progress => {
                let icon = if *is_error { "\u{274c}" } else { "\u{2705}" };
                tool_status = format!("{icon} {tool_name}");
                if msg_id.is_some() {
                    let visible = &text_buf[text_offset..];
                    if !try_edit_counted(
                        sink,
                        chat_id,
                        msg_id.as_deref(),
                        visible,
                        &tool_status,
                        max_len,
                        max_edits,
                        &mut edit_count,
                        &mut last_edit,
                        &mut last_sent_end,
                        text_buf.len(),
                    )
                    .await
                    {
                        text_offset = last_sent_end;
                        msg_id = None;
                        continuation = true;
                    }
                }
            }

            RunEventPayload::ToolProgress { text, .. } if config.show_tool_progress => {
                tool_status = format!("\u{23f3} {text}");
                if msg_id.is_some() {
                    let visible = &text_buf[text_offset..];
                    if !try_edit_counted(
                        sink,
                        chat_id,
                        msg_id.as_deref(),
                        visible,
                        &tool_status,
                        max_len,
                        max_edits,
                        &mut edit_count,
                        &mut last_edit,
                        &mut last_sent_end,
                        text_buf.len(),
                    )
                    .await
                    {
                        text_offset = last_sent_end;
                        msg_id = None;
                        continuation = true;
                    }
                }
            }

            _ => {}
        }
    }

    // Final delivery — only the visible portion for the current message
    let visible = &text_buf[text_offset..];
    let final_text = truncate_safe(visible, max_len);
    if final_text.is_empty() {
        return Ok(text_buf);
    }

    match msg_id {
        Some(ref id) if max_edits == 0 || edit_count < max_edits => {
            if let Err(e) = sink.edit_text(chat_id, id, &final_text).await {
                tracing::warn!(error = %e, "delivery: final edit failed, sending new message");
                let _ = sink.send_text(chat_id, &final_text).await;
            }
        }
        _ => {
            let _ = sink.send_text(chat_id, &final_text).await;
        }
    }

    Ok(text_buf)
}

/// Non-edit delivery: collect everything, send once.
async fn deliver_final(
    sink: &dyn MessageSink,
    chat_id: &str,
    run: &mut Run,
    max_len: usize,
) -> Result<String> {
    let mut text_buf = String::new();
    while let Some(event) = run.next().await {
        if let RunEventPayload::AssistantDelta {
            content_type,
            delta,
            ..
        } = &event.payload
        {
            if matches!(
                content_type,
                crate::session::conversation::AssistantContentType::Text
            ) && !delta.is_empty()
            {
                text_buf.push_str(delta);
            }
        }
    }

    if !text_buf.is_empty() {
        let final_text = truncate_safe(&text_buf, max_len);
        let _ = sink.send_text(chat_id, &final_text).await;
    }

    Ok(text_buf)
}

// ── Helpers ──

/// Try to edit the current message. Returns `true` if the edit succeeded or was skipped,
/// `false` if the edit limit has been reached (caller should reset to a new message).
#[allow(clippy::too_many_arguments)]
async fn try_edit_counted(
    sink: &dyn MessageSink,
    chat_id: &str,
    msg_id: Option<&str>,
    text_buf: &str,
    tool_status: &str,
    max_len: usize,
    max_edits: usize,
    edit_count: &mut usize,
    last_edit: &mut Instant,
    last_sent_end: &mut usize,
    current_buf_len: usize,
) -> bool {
    let Some(id) = msg_id else { return true };

    // Reserve the last edit slot to finalize the message (clean ending, no "…").
    if max_edits > 0 && *edit_count >= max_edits.saturating_sub(1) {
        // Finalize: edit one last time with clean text (no tool status, no ellipsis)
        let final_text = truncate_safe(text_buf, max_len);
        let _ = sink.edit_text(chat_id, id, &final_text).await;
        *last_sent_end = current_buf_len;
        return false;
    }

    let display = compose_display(text_buf, tool_status, max_len);
    if let Err(e) = sink.edit_text(chat_id, id, &display).await {
        tracing::warn!(error = %e, "delivery: edit failed");
        // On unexpected failure, last_sent_end stays at previous value
        return false;
    }

    *edit_count += 1;
    *last_edit = Instant::now();
    // Record how far into text_buf we've shown (absolute position)
    *last_sent_end = current_buf_len;
    true
}

fn compose_display(text: &str, tool_status: &str, max_len: usize) -> String {
    let reserve = 80;
    let max = max_len.saturating_sub(reserve);
    let mut display = truncate_safe(text, max);
    if !tool_status.is_empty() {
        display.push_str(&format!("\n\n_{tool_status}_"));
    }
    display.push_str(" \u{2026}");
    display
}

fn truncate_safe(text: &str, max_len: usize) -> String {
    if text.len() <= max_len {
        return text.to_string();
    }
    let boundary = text
        .char_indices()
        .take_while(|(i, _)| *i <= max_len)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    text[..boundary].to_string()
}
