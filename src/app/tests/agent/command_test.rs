use evot::agent::command::parse_command;
use evot::agent::command::Command;

#[test]
fn queue_command_shapes_match_cli_and_web_contract() -> Result<(), Box<dyn std::error::Error>> {
    #[derive(serde::Deserialize)]
    struct Case {
        text: String,
        command: bool,
    }
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../../../cli/tests/fixtures/contracts/command-shapes.json"
    ))?;
    for case in cases {
        assert_eq!(
            evot::agent::command::is_queued_command(&case.text),
            case.command,
            "{}",
            case.text
        );
    }
    Ok(())
}

#[test]
fn parse_clear() {
    assert!(matches!(parse_command("/clear"), Some(Command::Clear)));
    assert!(matches!(parse_command("/CLEAR"), Some(Command::Clear)));
    assert!(matches!(parse_command("  /clear  "), Some(Command::Clear)));
}

#[test]
fn parse_compact_with_optional_instructions() {
    assert!(matches!(
        parse_command("/compact"),
        Some(Command::Compact {
            custom_instructions: None
        })
    ));
    assert!(matches!(
        parse_command("/COMPACT preserve implementation details"),
        Some(Command::Compact { custom_instructions: Some(ref value) })
            if value == "preserve implementation details"
    ));
}

#[test]
fn parse_clip_all_is_clip_session() {
    assert!(matches!(
        parse_command("/clip all"),
        Some(Command::ClipSession)
    ));
    assert!(matches!(
        parse_command("  /clip all  "),
        Some(Command::ClipSession)
    ));
    assert!(matches!(
        parse_command("/CLIP ALL"),
        Some(Command::ClipSession)
    ));
}

#[test]
fn parse_bare_or_invalid_clip_is_usage_error() {
    assert!(matches!(
        parse_command("/clip"),
        Some(Command::UsageError(_))
    ));
    assert!(matches!(
        parse_command("/clip custom-name"),
        Some(Command::UsageError(_))
    ));
}

#[test]
fn clip_session_prompt_pre_activates_memory_workflow() {
    use evot::agent::command::clip_session_prompt;
    let prompt = clip_session_prompt("MEMORY WORKFLOW SENTINEL");
    assert!(prompt.contains("already loaded"));
    assert!(prompt.contains("MEMORY WORKFLOW SENTINEL"));
    assert!(!prompt.contains("skill tool"));
    assert!(!prompt.starts_with("Activate the `memory` skill"));
}

#[tokio::test]
async fn clip_all_persists_pre_activated_memory_workflow() -> Result<(), Box<dyn std::error::Error>>
{
    use std::sync::Arc;

    use evot::agent::Agent;
    use evot::agent::QueryRequest;
    use evot::agent::SubmitOutcome;
    use evot::conf::Config;
    use evot::conf::Protocol;
    use evot::conf::ProviderProfile;
    use evot::session::storage::MemoryStorage;
    use evot::types::TranscriptItem;
    use evot_engine::provider::MockProvider;

    let tmp = tempfile::TempDir::new()?;
    let mut config = Config::new(tmp.path().to_path_buf());
    config.providers.insert("test".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "test-key".into(),
        base_url: "http://localhost".into(),
        models: vec!["test-model".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    config.llm.provider = "test".into();

    let agent = Agent::new_with_provider_for_test(
        &config,
        tmp.path().to_string_lossy(),
        Arc::new(MemoryStorage::new()),
        MockProvider::text("Archived."),
    )?;
    let meta = agent.create_session("test").await?;
    let session = agent
        .load_session(&meta.session_id)
        .await?
        .ok_or_else(|| std::io::Error::other("missing session"))?;
    let outcome = agent
        .submit_to_session(QueryRequest::text("/clip all"), session)
        .await?;
    let mut run = match outcome {
        SubmitOutcome::Run(run) => run,
        SubmitOutcome::Command(message) => {
            return Err(std::io::Error::other(format!("unexpected command: {message}")).into());
        }
    };
    while run.next().await.is_some() {}

    let transcript = agent.sessions().transcript(&meta.session_id).await?;
    let prompt = transcript
        .iter()
        .find_map(|item| match item {
            TranscriptItem::User { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .ok_or_else(|| std::io::Error::other("missing rewritten user prompt"))?;
    assert!(prompt.contains("already loaded"));
    assert!(prompt.contains("# Memory"));
    assert!(prompt.contains("Archive — `/clip all`"));
    assert!(!prompt.starts_with("Activate the `memory` skill"));
    Ok(())
}

#[test]
fn parse_non_command_returns_none() {
    assert!(parse_command("hello").is_none());
    assert!(parse_command("").is_none());
    assert!(parse_command("/unknown").is_none());
    assert!(parse_command("/goto").is_none());
    assert!(parse_command("/goto 10").is_none());
    assert!(parse_command("/history").is_none());
    assert!(parse_command("/history 10").is_none());
    assert!(parse_command("clear").is_none());
}

#[test]
fn command_prompt_round_trips_user_input_and_hides_instructions() {
    use evot::session::conversation::command_envelope::command_prompt;
    use evot::session::conversation::command_envelope::parse_command_prompt;
    use evot::session::conversation::command_envelope::user_facing_text;

    let prompt = command_prompt(
        "sessions",
        "/sessions \"auth\" <bug> & more\nline2",
        "Follow the skill.",
    );
    assert!(prompt.starts_with(
        "<command name=\"sessions\" input=\"/sessions &quot;auth&quot; &lt;bug&gt; &amp; more&#10;line2\">\n"
    ));
    assert!(prompt.ends_with("\nFollow the skill.\n</command>"));

    let Some(parsed) = parse_command_prompt(&prompt) else {
        panic!("envelope parses");
    };
    assert_eq!(parsed.name, "sessions");
    assert_eq!(parsed.input, "/sessions \"auth\" <bug> & more\nline2");
    assert_eq!(parsed.instructions, "Follow the skill.");
    assert!(parsed.text.is_none());

    assert_eq!(
        user_facing_text(&prompt).as_deref(),
        Some("/sessions \"auth\" <bug> & more\nline2")
    );
    assert_eq!(
        user_facing_text("plain text").as_deref(),
        Some("plain text")
    );
    assert!(
        user_facing_text(&command_prompt("loop-wakeup", "loop wakeup #2", "Continue")).is_none()
    );

    // A background-task completion is a host notice, not something the user said.
    let notification =
        "<task-notification>\n<task-id>31c7af32-57aa-4b47-b503-9e05d35a42d5</task-id>\n\
        <status>completed</status>\n<exit-code>0</exit-code>\n<summary>done</summary>\n\
        <output-file>/tmp/o.txt</output-file>\n</task-notification>";
    assert!(user_facing_text(notification).is_none());
    let quoted = format!("the format is\n{notification}");
    assert_eq!(user_facing_text(&quoted).as_deref(), Some(quoted.as_str()));
}

#[test]
fn command_prompt_parser_ignores_mentions_and_bad_names() {
    use evot::session::conversation::command_envelope::parse_command_prompt;
    assert!(parse_command_prompt("explain <command name=\"x\" input=\"y\">").is_none());
    assert!(parse_command_prompt("<command name=\"Loop\" input=\"y\">\nz\n</command>").is_none());
    assert!(
        parse_command_prompt("hi\n<command name=\"loop\" input=\"y\">\nz\n</command>").is_none()
    );
    assert!(parse_command_prompt(
        "<command name=\"loop\" input=\"y\">\nz\n</command>\nno blank line"
    )
    .is_none());
    let tail =
        parse_command_prompt("<command name=\"task\" input=\"\">\nz\n</command>\n\nmake it daily");
    assert_eq!(
        tail.map(|envelope| envelope.text),
        Some(Some("make it daily"))
    );
}
