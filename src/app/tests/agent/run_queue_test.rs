//! App run-level queue tests.

use evot::agent::RunControl;

fn text(entry: &evot_engine::PromptQueueEntry) -> String {
    match &entry.message {
        evot_engine::AgentMessage::Llm(evot_engine::Message::User { content, .. }) => content
            .iter()
            .filter_map(|content| match content {
                evot_engine::Content::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[test]
fn run_control_queues_without_an_installed_engine() {
    let control = RunControl::new();
    let entry = control.steer(evot_engine::AgentMessage::Llm(evot_engine::Message::user(
        "between turns",
    )));

    let queued = control.queued_steering();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].id, entry.id);
    assert_eq!(text(&queued[0]), "between turns");
}

#[test]
fn run_control_can_edit_remove_and_promote_entries() {
    let control = RunControl::new();
    let follow_up = control.follow_up(evot_engine::AgentMessage::Llm(evot_engine::Message::user(
        "later",
    )));
    let updated = control.update_follow_up(
        &follow_up.id,
        follow_up.version,
        evot_engine::AgentMessage::Llm(evot_engine::Message::user("now")),
    );
    let updated = match updated {
        Ok(entry) => entry,
        Err(error) => panic!("update failed: {error}"),
    };
    let promoted = control.send_follow_up_now(&updated.id, Some(updated.version));
    match promoted {
        Ok(entry) => {
            assert_eq!(entry.version, 2);
            assert_eq!(text(&entry), "now");
        }
        Err(error) => panic!("promotion failed: {error}"),
    }
    assert!(control.queued_follow_ups().is_empty());
    assert_eq!(control.queued_steering().len(), 1);
}

#[test]
fn run_control_can_reorder_and_clear_entries() {
    let control = RunControl::new();
    let first = control.follow_up(evot_engine::AgentMessage::Llm(evot_engine::Message::user(
        "first",
    )));
    let second = control.follow_up(evot_engine::AgentMessage::Llm(evot_engine::Message::user(
        "second",
    )));

    let moved = control.move_queued_prompt("follow_up", &second.id, second.version, "up");
    match moved {
        Ok(entry) => assert_eq!(entry.version, 1),
        Err(error) => panic!("move failed: {error}"),
    }
    let queued = control.queued_follow_ups();
    assert_eq!(queued.iter().map(text).collect::<Vec<_>>(), [
        "second", "first"
    ]);

    control.clear_follow_up();
    assert!(control.queued_follow_ups().is_empty());
    control.clear_steering();
    assert!(control.queued_steering().is_empty());
    assert!(!first.id.is_empty());
}
