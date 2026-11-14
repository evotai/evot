//! The Compute prompt section, and how shares and cloud sync drop it.

use evot::cloud::compute::prompt;
use evot::cloud::compute::ComputeMachine;
use evot::privacy::local_prompt;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn machine(name: &str) -> ComputeMachine {
    ComputeMachine {
        id: "m1".into(),
        name: name.into(),
        ssh_target: "ubuntu@10.0.0.9".into(),
        description: "Rust builds and tests".into(),
        enabled: true,
        profile: None,
        last_check: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

#[test]
fn prompt_section_lists_enabled_machines_with_their_ssh_targets() -> Result {
    let mut paused = machine("old");
    paused.enabled = false;
    let section = prompt::prompt_section(&[machine("big-1"), paused]).ok_or("no section")?;
    assert!(section.starts_with(local_prompt::COMPUTE_OPEN));
    assert!(section.ends_with(local_prompt::COMPUTE_CLOSE));
    assert!(section.contains("- big-1 (ssh ubuntu@10.0.0.9): Rust builds and tests"));
    let mut aliased = machine("box");
    aliased.ssh_target = "box".into();
    let section = prompt::prompt_section(&[aliased]).ok_or("no section")?;
    assert!(
        section.contains("- box: Rust builds and tests"),
        "{section}"
    );
    assert!(!section.contains("old"));
    assert!(section.contains("tmux session named evot-"));
    assert!(
        !section.contains("rsync"),
        "how to copy is the model's call"
    );
    assert!(section.contains("bash -s <<'EOF'"));
    let mut with_tmux = machine("big-2");
    with_tmux.profile = Some(evot::cloud::compute::MachineProfile {
        tools: vec!["tmux".into(), "rsync".into()],
        ..Default::default()
    });
    let section = prompt::prompt_section(&[with_tmux]).ok_or("no section")?;
    assert!(section.contains("(tools: tmux, rsync)"), "{section}");
    assert!(!section.contains("compute_run"));
    assert!(prompt::prompt_section(&[]).is_none());
    Ok(())
}

#[test]
fn redaction_drops_the_section() -> Result {
    let section = prompt::prompt_section(&[machine("big-1")]).ok_or("none")?;
    let system = format!("You are evot.\n\n{section}\n\nAvailable variables: X");
    assert_eq!(
        local_prompt::redact_prompt(&system),
        "You are evot.\n\nAvailable variables: X"
    );
    assert_eq!(local_prompt::redact_prompt(&format!("A\n\n{section}")), "A");
    assert_eq!(local_prompt::redact_prompt("no section"), "no section");

    let mut data = serde_json::json!({ "system_prompt": system });
    assert!(local_prompt::redact_llm_call(&mut data));
    assert!(!data.to_string().contains("big-1"));
    assert!(!local_prompt::redact_llm_call(&mut data));
    Ok(())
}

#[test]
fn shared_sessions_never_carry_compute_details() -> Result {
    let section = prompt::prompt_section(&[machine("big-1")]).ok_or("none")?;
    let meta = evot::types::SessionMeta::new("s1".into(), "/work/evot".into(), "m".into());
    let entries = vec![evot::types::TranscriptEntry {
        session_id: "s1".into(),
        run_id: None,
        seq: 1,
        turn: 1,
        item: serde_json::from_value(serde_json::json!({
        "type": "stats", "kind": "llm_call_started", "data": {
            "system_prompt": format!("Base.\n\n{section}"),
            "tool_definitions": [{"name": "bash"}],
        }}))?,
        created_at: "2026-01-01T00:00:00Z".into(),
    }];
    let share = evot::cloud::share::export_session(&meta, &entries, "test");
    let text = share.data.to_string();
    assert!(!text.contains("big-1"), "{text}");
    assert!(!text.contains("10.0.0.9"), "{text}");
    assert_eq!(share.data["systemPrompt"], "Base.");
    Ok(())
}
