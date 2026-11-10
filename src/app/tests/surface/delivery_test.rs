//! Integration tests for gateway/delivery — progressive stream delivery.
//!
//! Uses a `MockSink` that records all send/edit calls, and a `DeliveryHarness`
//! that feeds `RunEvent`s through `stream_delivery::deliver()` to verify
//! end-to-end delivery behavior without hitting any real platform API.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use evot::agent::Run;
use evot::base::error::Result;
use evot::session::conversation::AssistantContentType;
use evot::session::conversation::RunEvent;
use evot::session::conversation::RunEventPayload;
use evot::surface::delivery::stream as stream_delivery;
use evot::surface::delivery::stream::StreamDeliveryConfig;
use evot::surface::delivery::traits::DeliveryCapabilities;
use evot::surface::delivery::traits::MessageSink;
use tokio::sync::mpsc;
use tokio::sync::Mutex;

// ── MockSink ──

#[derive(Debug, Clone)]
#[allow(dead_code)]
enum SinkCall {
    Send {
        chat_id: String,
        text: String,
    },
    Edit {
        chat_id: String,
        msg_id: String,
        text: String,
    },
}

#[derive(Clone)]
struct MockSink {
    caps: DeliveryCapabilities,
    calls: Arc<Mutex<Vec<SinkCall>>>,
    msg_counter: Arc<Mutex<u32>>,
}

impl MockSink {
    fn editable() -> Self {
        Self {
            caps: DeliveryCapabilities {
                can_edit: true,
                max_message_len: 4096,
                max_edits_per_message: 0,
            },
            calls: Arc::new(Mutex::new(Vec::new())),
            msg_counter: Arc::new(Mutex::new(0)),
        }
    }

    fn non_editable() -> Self {
        Self {
            caps: DeliveryCapabilities {
                can_edit: false,
                max_message_len: 4096,
                max_edits_per_message: 0,
            },
            calls: Arc::new(Mutex::new(Vec::new())),
            msg_counter: Arc::new(Mutex::new(0)),
        }
    }

    fn with_max_len(mut self, max_len: usize) -> Self {
        self.caps.max_message_len = max_len;
        self
    }

    fn with_max_edits(mut self, n: u32) -> Self {
        self.caps.max_edits_per_message = n as usize;
        self
    }

    async fn calls(&self) -> Vec<SinkCall> {
        self.calls.lock().await.clone()
    }

    async fn send_count(&self) -> usize {
        self.calls
            .lock()
            .await
            .iter()
            .filter(|c| matches!(c, SinkCall::Send { .. }))
            .count()
    }

    async fn edit_count(&self) -> usize {
        self.calls
            .lock()
            .await
            .iter()
            .filter(|c| matches!(c, SinkCall::Edit { .. }))
            .count()
    }

    async fn last_text(&self) -> String {
        let calls = self.calls.lock().await;
        calls
            .last()
            .map(|c| match c {
                SinkCall::Send { text, .. } => text.clone(),
                SinkCall::Edit { text, .. } => text.clone(),
            })
            .unwrap_or_default()
    }
}

#[async_trait]
impl MessageSink for MockSink {
    fn capabilities(&self) -> DeliveryCapabilities {
        self.caps
    }

    async fn send_text(&self, chat_id: &str, text: &str) -> Result<String> {
        let mut counter = self.msg_counter.lock().await;
        *counter += 1;
        let msg_id = format!("msg_{}", *counter);
        self.calls.lock().await.push(SinkCall::Send {
            chat_id: chat_id.to_string(),
            text: text.to_string(),
        });
        Ok(msg_id)
    }

    async fn edit_text(&self, chat_id: &str, message_id: &str, text: &str) -> Result<()> {
        self.calls.lock().await.push(SinkCall::Edit {
            chat_id: chat_id.to_string(),
            msg_id: message_id.to_string(),
            text: text.to_string(),
        });
        Ok(())
    }
}

// ── Event DSL ──

fn event(payload: RunEventPayload) -> RunEvent {
    RunEvent::new("run-1".into(), "sess-1".into(), 1, payload)
}

fn delta(text: &str) -> RunEvent {
    event(RunEventPayload::AssistantDelta {
        content_index: 0,
        content_type: AssistantContentType::Text,
        delta: text.to_string(),
    })
}

fn tool_started(name: &str) -> RunEvent {
    event(RunEventPayload::ToolStarted {
        tool_call_id: "tc-1".into(),
        tool_name: name.to_string(),
        args: serde_json::json!({}),
        preview_command: None,
    })
}

fn tool_finished(name: &str, success: bool) -> RunEvent {
    event(RunEventPayload::ToolFinished {
        tool_call_id: "tc-1".into(),
        tool_name: name.to_string(),
        content: "done".into(),
        is_error: !success,
        details: serde_json::Value::Null,
        result_tokens: 0,
        duration_ms: 100,
    })
}

fn tool_progress(text: &str) -> RunEvent {
    event(RunEventPayload::ToolProgress {
        tool_call_id: "tc-1".into(),
        tool_name: "bash".into(),
        text: text.to_string(),
        details: serde_json::Value::Null,
    })
}

// ── DeliveryHarness ──

struct DeliveryHarness {
    events: Vec<RunEvent>,
    config: StreamDeliveryConfig,
}

impl DeliveryHarness {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            config: StreamDeliveryConfig {
                min_initial_chars: 10,
                throttle: Duration::from_millis(0), // no throttle in tests
                show_tool_progress: true,
            },
        }
    }

    fn events(mut self, events: Vec<RunEvent>) -> Self {
        self.events = events;
        self
    }

    fn min_initial_chars(mut self, n: usize) -> Self {
        self.config.min_initial_chars = n;
        self
    }

    fn no_tool_progress(mut self) -> Self {
        self.config.show_tool_progress = false;
        self
    }

    async fn deliver(self, sink: &MockSink) -> String {
        let (tx, rx) = mpsc::unbounded_channel();
        for e in self.events {
            let _ = tx.send(e);
        }
        drop(tx);

        let mut run = Run::from_receiver(rx, "sess-1".into(), "run-1".into());
        stream_delivery::deliver(sink, "chat-1", &mut run, &self.config)
            .await
            .unwrap_or_default()
    }
}

// ── Tests ──

#[tokio::test]
async fn editable_sink_sends_initial_then_edits() {
    let sink = MockSink::editable();
    let text = DeliveryHarness::new()
        .events(vec![
            delta("Hello, "),
            delta("world! "),
            delta("How are you?"),
        ])
        .deliver(&sink)
        .await;

    assert_eq!(text, "Hello, world! How are you?");
    assert_eq!(sink.send_count().await, 1);
    // At least one edit for the final text
    assert!(sink.edit_count().await >= 1);
}

#[tokio::test]
async fn non_editable_sink_sends_once_at_end() {
    let sink = MockSink::non_editable();
    let text = DeliveryHarness::new()
        .events(vec![delta("Hello, "), delta("world!")])
        .deliver(&sink)
        .await;

    assert_eq!(text, "Hello, world!");
    assert_eq!(sink.send_count().await, 1);
    assert_eq!(sink.edit_count().await, 0);
}

#[tokio::test]
async fn empty_stream_sends_nothing() {
    let sink = MockSink::editable();
    let text = DeliveryHarness::new().events(vec![]).deliver(&sink).await;

    assert!(text.is_empty());
    assert_eq!(sink.send_count().await, 0);
    assert_eq!(sink.edit_count().await, 0);
}

#[tokio::test]
async fn tool_progress_shown_in_edits() {
    let sink = MockSink::editable();
    DeliveryHarness::new()
        .events(vec![
            delta("Let me check. "),
            tool_started("bash"),
            delta("Running command..."),
            tool_finished("bash", true),
            delta(" Done!"),
        ])
        .deliver(&sink)
        .await;

    let calls = sink.calls().await;
    let has_tool_icon = calls.iter().any(|c| match c {
        SinkCall::Edit { text, .. } | SinkCall::Send { text, .. } => {
            text.contains('\u{1f527}') || text.contains('\u{2705}')
        }
    });
    assert!(has_tool_icon, "Expected tool progress icons in calls");
}

#[tokio::test]
async fn tool_progress_hidden_when_disabled() {
    let sink = MockSink::editable();
    DeliveryHarness::new()
        .no_tool_progress()
        .events(vec![
            delta("Let me check. "),
            tool_started("bash"),
            delta("Running..."),
            tool_finished("bash", true),
        ])
        .deliver(&sink)
        .await;

    let calls = sink.calls().await;
    let has_tool_icon = calls.iter().any(|c| match c {
        SinkCall::Edit { text, .. } | SinkCall::Send { text, .. } => {
            text.contains('\u{1f527}') || text.contains('\u{2705}')
        }
    });
    assert!(!has_tool_icon, "Tool icons should not appear when disabled");
}

#[tokio::test]
async fn failed_tool_shows_error_icon() {
    let sink = MockSink::editable();
    DeliveryHarness::new()
        .events(vec![
            delta("Trying... "),
            tool_started("bash"),
            tool_finished("bash", false),
            delta("Failed."),
        ])
        .deliver(&sink)
        .await;

    let calls = sink.calls().await;
    let has_error_icon = calls.iter().any(|c| match c {
        SinkCall::Edit { text, .. } | SinkCall::Send { text, .. } => text.contains('\u{274c}'),
    });
    assert!(has_error_icon, "Expected error icon for failed tool");
}

#[tokio::test]
async fn respects_min_initial_chars() {
    let sink = MockSink::editable();
    DeliveryHarness::new()
        .min_initial_chars(100)
        .events(vec![delta("short")])
        .deliver(&sink)
        .await;

    // "short" is < 100 chars, so no initial send_text — only final send
    assert_eq!(sink.send_count().await, 1);
    assert_eq!(sink.edit_count().await, 0);
}

#[tokio::test]
async fn truncates_long_text() {
    let sink = MockSink::editable().with_max_len(50);
    let long_text = "a".repeat(200);
    let text = DeliveryHarness::new()
        .min_initial_chars(1)
        .events(vec![delta(&long_text)])
        .deliver(&sink)
        .await;

    // Full text is returned
    assert_eq!(text.len(), 200);
    // But the last call to the sink should be truncated
    let last = sink.last_text().await;
    assert!(
        last.len() <= 50,
        "Expected truncated output, got {} chars",
        last.len()
    );
}

#[tokio::test]
async fn non_editable_truncates_final_text() {
    let sink = MockSink::non_editable().with_max_len(20);
    let text = DeliveryHarness::new()
        .events(vec![delta(&"x".repeat(100))])
        .deliver(&sink)
        .await;

    assert_eq!(text.len(), 100);
    let last = sink.last_text().await;
    assert!(last.len() <= 20);
}

#[tokio::test]
async fn tool_progress_text_in_edit() {
    let sink = MockSink::editable();
    DeliveryHarness::new()
        .events(vec![
            delta("Working on it... "),
            tool_progress("compiling 3/10"),
            delta("Almost done."),
        ])
        .deliver(&sink)
        .await;

    let calls = sink.calls().await;
    let has_progress = calls.iter().any(|c| match c {
        SinkCall::Edit { text, .. } | SinkCall::Send { text, .. } => text.contains('\u{23f3}'),
    });
    assert!(has_progress, "Expected hourglass progress icon");
}

#[tokio::test]
async fn multiple_tool_rounds() {
    let sink = MockSink::editable();
    let text = DeliveryHarness::new()
        .events(vec![
            delta("Step 1. "),
            tool_started("read"),
            tool_finished("read", true),
            delta("Step 2. "),
            tool_started("bash"),
            tool_finished("bash", true),
            delta("All done."),
        ])
        .deliver(&sink)
        .await;

    assert_eq!(text, "Step 1. Step 2. All done.");
    assert!(sink.send_count().await >= 1);
}

#[tokio::test]
async fn unicode_text_not_corrupted() {
    let sink = MockSink::editable().with_max_len(30);
    let text = DeliveryHarness::new()
        .min_initial_chars(1)
        .events(vec![delta(
            "你好世界！这是一个很长的中文消息，需要被截断处理。",
        )])
        .deliver(&sink)
        .await;

    assert_eq!(text, "你好世界！这是一个很长的中文消息，需要被截断处理。");
    // Verify the truncated text is valid UTF-8 (would panic if not)
    let last = sink.last_text().await;
    assert!(last.len() <= 30);
    // Ensure it's valid UTF-8 by iterating chars
    let _ = last.chars().count();
}

#[tokio::test]
async fn edit_limit_new_message_does_not_repeat_old_content() {
    // Allow only 1 edit per message, so the 2nd edit triggers edit_broken.
    let sink = MockSink::editable().with_max_edits(1);
    let text = DeliveryHarness::new()
        .min_initial_chars(1)
        .events(vec![
            delta("AAAA "),      // triggers initial send
            delta("BBBB "),      // 1st edit succeeds
            delta("CCCC "),      // 2nd edit fails → edit_broken, offset advances
            delta("DDDD "), // not enough for new send yet (< min_initial_chars=1… but we set 1)
            delta("EEEE done."), // accumulates, triggers new send
        ])
        .deliver(&sink)
        .await;

    // Full text is always returned
    assert_eq!(text, "AAAA BBBB CCCC DDDD EEEE done.");

    let calls = sink.calls().await;

    // There should be at least 2 Send calls (initial + after edit limit)
    let sends: Vec<_> = calls
        .iter()
        .filter_map(|c| match c {
            SinkCall::Send { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert!(
        sends.len() >= 2,
        "Expected at least 2 sends, got {}",
        sends.len()
    );

    // The second send (after edit limit) must NOT contain "AAAA" from the first message
    let second_send = &sends[1];
    assert!(
        !second_send.contains("AAAA"),
        "New message after edit limit should not repeat old content, got: {second_send}"
    );
}

#[tokio::test]
async fn edit_limit_does_not_send_empty_message() {
    // Edit limit hit during tool events — should NOT immediately send a near-empty message.
    let sink = MockSink::editable().with_max_edits(1);
    DeliveryHarness::new()
        .min_initial_chars(1)
        .events(vec![
            delta("Hello "),
            delta("World "),          // 1st edit ok
            tool_started("bash"),     // 2nd edit fails → edit_broken
            tool_progress("running"), // no send (edit_broken, no msg_id)
            tool_finished("bash", true),
            delta("Result here."), // enough text → new send
        ])
        .deliver(&sink)
        .await;

    let calls = sink.calls().await;
    let sends: Vec<_> = calls
        .iter()
        .filter_map(|c| match c {
            SinkCall::Send { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();

    // Every send should have meaningful content (not just a tool status line)
    for (i, s) in sends.iter().enumerate() {
        // Strip the trailing ellipsis and tool status to check real content
        let stripped = s.split("\n\n_").next().unwrap_or(s).trim();
        // At least some alphabetic content beyond just "…"
        let has_content = stripped.chars().any(|c| c.is_alphabetic());
        assert!(has_content, "Send #{i} has no meaningful content: {s:?}");
    }
}
