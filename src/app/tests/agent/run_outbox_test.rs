use evot::agent::run::outbox::event_channel;
use evot::agent::RunControl;
use evot::session::conversation::AssistantContentType;
use evot::session::conversation::RunEventContext;
use evot::session::conversation::RunEventPayload;
use evot::session::conversation::ToolCallStreamPhase;

fn text_delta(
    context: &RunEventContext,
    index: usize,
    text: &str,
) -> evot::session::conversation::RunEvent {
    context.event(RunEventPayload::AssistantDelta {
        content_index: index,
        content_type: AssistantContentType::Text,
        delta: text.into(),
    })
}

fn tool_delta(
    context: &RunEventContext,
    id: &str,
    text: &str,
) -> evot::session::conversation::RunEvent {
    context.event(RunEventPayload::AssistantToolCall {
        content_index: 0,
        tool_call_id: id.into(),
        tool_name: "edit".into(),
        phase: ToolCallStreamPhase::Delta,
        delta: Some(text.into()),
        args: None,
    })
}

#[tokio::test]
async fn a_slow_consumer_never_cancels_the_run_and_loses_no_content() {
    let control = RunControl::new();
    let (tx, mut rx) = event_channel(control.clone());
    let context = RunEventContext::new("run", "session", 1);
    for index in 0..5000 {
        assert!(tx
            .send(tool_delta(&context, "call-1", &format!("{index},")))
            .is_ok());
    }
    assert!(!control.is_cancelled());
    assert!(!tx.over_budget());
    drop(tx);
    let mut joined = String::new();
    let mut count = 0;
    while let Some(event) = rx.recv().await {
        count += 1;
        match event.payload {
            RunEventPayload::AssistantToolCall {
                tool_call_id,
                phase: ToolCallStreamPhase::Delta,
                delta: Some(delta),
                ..
            } => {
                assert_eq!(tool_call_id, "call-1");
                joined.push_str(&delta);
            }
            other => panic!("unexpected payload: {other:?}"),
        }
    }
    let expected: String = (0..5000).map(|index| format!("{index},")).collect();
    assert_eq!(joined, expected);
    assert!(count < 5000, "bursty deltas should coalesce");
}

#[tokio::test]
async fn coalescing_preserves_boundaries_between_unrelated_events() {
    let (tx, mut rx) = event_channel(RunControl::new());
    let context = RunEventContext::new("run", "session", 1);
    for index in 0..64 {
        assert!(tx
            .send(text_delta(&context, 0, &format!("a{index}")))
            .is_ok());
    }
    assert!(tx.send(text_delta(&context, 0, "-tail")).is_ok());
    assert!(tx.send(text_delta(&context, 1, "other-index")).is_ok());
    assert!(tx.send(tool_delta(&context, "call-a", "{")).is_ok());
    assert!(tx.send(tool_delta(&context, "call-b", "[")).is_ok());
    assert!(tx.send(context.started()).is_ok());
    drop(tx);
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event.payload);
    }
    assert_eq!(events.len(), 68);
    assert!(
        matches!(&events[63], RunEventPayload::AssistantDelta { delta, .. } if delta == "a63-tail")
    );
    assert!(matches!(&events[64], RunEventPayload::AssistantDelta {
        content_index: 1,
        ..
    }));
    assert!(
        matches!(&events[65], RunEventPayload::AssistantToolCall { tool_call_id, .. } if tool_call_id == "call-a")
    );
    assert!(
        matches!(&events[66], RunEventPayload::AssistantToolCall { tool_call_id, .. } if tool_call_id == "call-b")
    );
    assert!(matches!(events[67], RunEventPayload::RunStarted { .. }));
}

#[tokio::test]
async fn byte_pressure_waits_for_the_consumer_instead_of_cancelling() {
    let context = RunEventContext::new("r", "s", 1);
    let control = RunControl::new();
    let (tx, mut rx) = event_channel(control.clone());
    let large = || {
        context.event(RunEventPayload::Error {
            message: "x".repeat(5 * 1024 * 1024),
        })
    };
    assert!(tx.send(large()).is_ok());
    assert!(tx.send(large()).is_ok());
    assert!(tx.over_budget());
    assert!(!control.is_cancelled());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), tx.wait_for_capacity())
            .await
            .is_err()
    );
    assert!(rx.recv().await.is_some());
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), tx.wait_for_capacity())
            .await
            .is_ok()
    );
    assert!(!control.is_cancelled());
    drop(tx);
    assert!(rx.recv().await.is_some());
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn drained_capacity_is_reused_without_cancellation() {
    let control = RunControl::new();
    let (tx, mut rx) = event_channel(control.clone());
    let context = RunEventContext::new("run", "session", 1);
    for _ in 0..1000 {
        assert!(tx.send(context.started()).is_ok());
        assert!(rx.recv().await.is_some());
    }
    assert!(!control.is_cancelled());
    drop(tx);
    assert!(rx.recv().await.is_none());
}

#[tokio::test]
async fn receiver_drop_releases_sender_and_pending_read_wakes_on_sender_drop() {
    let (tx, rx) = event_channel(RunControl::new());
    drop(rx);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), tx.closed())
            .await
            .is_ok()
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), tx.wait_for_capacity())
            .await
            .is_ok()
    );
    assert!(tx
        .send(RunEventContext::new("r", "s", 1).started())
        .is_err());
    let (tx, mut rx) = event_channel(RunControl::new());
    let reader = tokio::spawn(async move { rx.recv().await });
    tokio::task::yield_now().await;
    drop(tx);
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), reader).await;
    assert!(matches!(result, Ok(Ok(None))));
}
