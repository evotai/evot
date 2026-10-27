use std::sync::Arc;

use evot::agent::tools::ToolMode;
use evot::agent::turn_assembler::TurnAssembler;
use evot::agent::turn_assembler::TurnBuildRequest;
use evot::conf::Config;
use evot::conf::Protocol;
use evot::conf::ProviderProfile;
use evot::sessions::Session;
use evot::sessions::SessionLocator;
use evot::storage::MemoryStorage;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn assembles_a_turn_without_an_agent() -> TestResult {
    // Assembly ensures the memory vault exists; never write into the runner's HOME.
    const CHILD: &str = "EVOT_TURN_ASSEMBLER_TEST_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir()?;
        let output = std::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "turn_assembler_test::assembles_a_turn_without_an_agent",
                "--nocapture",
            ])
            .env_clear()
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env(CHILD, "1")
            .output()?;
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return Ok(());
    }
    let workspace = tempfile::tempdir()?;
    let cwd = workspace.path().to_str().ok_or("non-UTF8 workspace")?;
    let mut config = Config::new(workspace.path().to_path_buf());
    config.providers.insert("fixture".into(), ProviderProfile {
        protocol: Protocol::OpenAi,
        api_key: "fixture-key".into(),
        base_url: "https://example.invalid/v1".into(),
        models: vec!["fixture-model".into()],
        compat_caps: Default::default(),
        route_capabilities: Default::default(),
        thinking_level: None,
        context_window: None,
        max_tokens: None,
        supports_image: None,
    });
    let llm = config.build_llm("fixture", Some("fixture-model".into()))?;
    let locator = SessionLocator::new("test", "standalone-assembly");
    let session = Session::open_or_create_with_provider(
        &locator,
        cwd,
        &llm.provider,
        &llm.model,
        Arc::new(MemoryStorage::new()),
    )
    .await?;
    let assembler = TurnAssembler::new(&config);
    let turn = assembler
        .build_turn(
            &llm,
            ToolMode::Readonly,
            session.clone(),
            &locator.session_id(),
            TurnBuildRequest {
                input: vec![evot_engine::Content::Text {
                    text: "hello".into(),
                }],
                host_tools: None,
                extra_tools: Vec::new(),
                approver: None,
                consume_process_notifications: false,
                previous_llm: None,
            },
        )
        .await?;
    assert!(Arc::ptr_eq(&turn.session, &session));
    assert!(turn.history.is_empty());
    assert!(!turn.options.tools.is_empty());
    assert_eq!(turn.options.model, "fixture-model");
    assert_eq!(turn.options.cwd, workspace.path());
    assert!(turn.options.process_manager.is_none());
    assert!(turn.options.limits.is_some());
    assert!(
        matches!(turn.input.as_slice(), [evot_engine::Content::Text { text }] if text == "hello")
    );
    for mode in [
        ToolMode::Headless,
        ToolMode::Interactive,
        ToolMode::Planning,
    ] {
        let prepared = assembler
            .build_turn(
                &llm,
                mode,
                session.clone(),
                &locator.session_id(),
                TurnBuildRequest {
                    input: vec![evot_engine::Content::Text {
                        text: "继续任务".into(),
                    }],
                    host_tools: None,
                    extra_tools: Vec::new(),
                    approver: None,
                    consume_process_notifications: true,
                    previous_llm: None,
                },
            )
            .await?;
        let interactive = matches!(mode, ToolMode::Interactive | ToolMode::Planning);
        assert_eq!(prepared.options.process_manager.is_some(), interactive);
        assert_eq!(prepared.options.limits.is_none(), interactive);
        assert!(
            matches!(prepared.input.as_slice(), [evot_engine::Content::Text { text }]
            if text == "继续任务")
        );
        assert_eq!(
            prepared.options.system_prompt,
            prepared
                .options
                .system_prompt_sections
                .iter()
                .map(|section| section.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        );
    }
    for input in [Vec::new(), vec![evot_engine::Content::Text {
        text: " \n\t".into(),
    }]] {
        let skipped = assembler
            .build_turn(
                &llm,
                ToolMode::Interactive,
                session.clone(),
                &locator.session_id(),
                TurnBuildRequest {
                    input,
                    host_tools: None,
                    extra_tools: Vec::new(),
                    approver: None,
                    consume_process_notifications: true,
                    previous_llm: None,
                },
            )
            .await?;
        assert!(
            skipped.input.is_empty(),
            "empty wake must not create a synthetic prompt"
        );
    }
    // A real notification is still delivered, including when a newer user
    // request arrives in the same turn. Its purpose is captured at launch.
    let prepared = assembler
        .build_turn(
            &llm,
            ToolMode::Interactive,
            session.clone(),
            &locator.session_id(),
            TurnBuildRequest {
                input: vec![evot_engine::Content::Text {
                    text: "original task".into(),
                }],
                host_tools: None,
                extra_tools: Vec::new(),
                approver: None,
                consume_process_notifications: true,
                previous_llm: None,
            },
        )
        .await?;
    let manager = prepared.options.process_manager.ok_or("missing manager")?;
    for user_text in [None, Some("new user task")] {
        let mut command = tokio::process::Command::new("bash");
        command.args(["-c", "printf done"]);
        let id = manager
            .start(evot_engine::tools::process::StartProcess {
                command,
                command_text: "printf done".into(),
                description: Some("original task: collect benchmark results".into()),
                tool_call_id: "fixture".into(),
                cwd: workspace.path().to_path_buf(),
                timeout: std::time::Duration::from_secs(3),
                output_dir: workspace.path().join("output"),
                tail_bytes: 4096,
                background_reason: Some(evot_engine::tools::BackgroundReason::Explicit),
                background_on_timeout: true,
            })
            .await?;
        let completed = manager
            .wait(&id, std::time::Duration::from_secs(3))
            .await
            .ok_or("missing process")?;
        assert!(completed.status.is_terminal());
        let input = user_text
            .into_iter()
            .map(|text| evot_engine::Content::Text { text: text.into() })
            .collect();
        let notified = assembler
            .build_turn(
                &llm,
                ToolMode::Interactive,
                session.clone(),
                &locator.session_id(),
                TurnBuildRequest {
                    input,
                    host_tools: None,
                    extra_tools: Vec::new(),
                    approver: None,
                    consume_process_notifications: true,
                    previous_llm: None,
                },
            )
            .await?;
        assert_eq!(
            notified.input.len(),
            if user_text.is_some() { 2 } else { 1 }
        );
        if let Some(user_text) = user_text {
            assert!(
                matches!(&notified.input[0], evot_engine::Content::Text { text } if text == user_text)
            );
        }
        assert!(
            matches!(notified.input.last(), Some(evot_engine::Content::Text { text })
            if text.contains(&id) && text.contains("original task: collect benchmark results")
            && text.contains("<task-notification>"))
        );
        assert!(manager.take_notifications().is_empty());
        assert!(notified
            .options
            .tools
            .iter()
            .flat_map(|tool| tool.prompt_guidelines())
            .any(|guideline| guideline.contains("events report results, not new user requests")));
    }
    let image_turn = assembler
        .build_turn(
            &llm,
            ToolMode::Interactive,
            session.clone(),
            &locator.session_id(),
            TurnBuildRequest {
                input: vec![evot_engine::Content::Image {
                    source: evot_engine::ImageSource::Base64 {
                        data: "fixture".into(),
                    },
                    mime_type: "image/png".into(),
                }],
                host_tools: None,
                extra_tools: Vec::new(),
                approver: None,
                consume_process_notifications: true,
                previous_llm: None,
            },
        )
        .await?;
    assert!(
        !image_turn.input.is_empty(),
        "image-only user input must not be skipped"
    );
    for missing_provider in [true, false] {
        let mut invalid = llm.clone();
        if missing_provider {
            invalid.provider.clear();
        } else {
            invalid.api_key = "  ".into();
        }
        let result = assembler
            .build_turn(
                &invalid,
                ToolMode::Readonly,
                session.clone(),
                &locator.session_id(),
                TurnBuildRequest {
                    input: Vec::new(),
                    host_tools: None,
                    extra_tools: Vec::new(),
                    approver: None,
                    consume_process_notifications: false,
                    previous_llm: None,
                },
            )
            .await;
        let error = match result {
            Ok(_) => return Err("invalid model accepted".into()),
            Err(error) => error,
        };
        assert!(error.to_string().contains(if missing_provider {
            "No model available"
        } else {
            "No API key set"
        }));
    }

    // A transcript resumed from an earlier evot process still announces a
    // watcher that process was running. This process never saw it, so the
    // model is told once; later turns and this process's own finished task
    // (`id` above) do not trigger it again.
    let old_watcher = "96e7d776-111d-49b0-a11f-8e112f3759ce";
    session
        .write_items(vec![
            evot::types::TranscriptItem::Assistant {
                content: vec![evot::types::AssistantBlock::ToolCall {
                    id: "old-call".into(),
                    name: "Bash".into(),
                    input: serde_json::json!({ "command": "gh pr checks --watch" }),
                    metadata: None,
                }],
                stop_reason: "tool_use".into(),
                usage: Default::default(),
                model: String::new(),
                provider: String::new(),
                timestamp: 0,
                error_message: None,
            },
            evot::types::TranscriptItem::ToolResult {
                tool_call_id: "old-call".into(),
                tool_name: "Bash".into(),
                content: format!(
                    "Command is running in the background.\nTask: PR watcher\nTask ID: {old_watcher}\nOutput: /tmp/{old_watcher}.log\nYou will be notified when it completes."
                ),
                is_error: false,
                details: serde_json::Value::Null,
            },
        ])
        .await?;
    let resumed = assembler
        .build_turn(
            &llm,
            ToolMode::Interactive,
            session.clone(),
            &locator.session_id(),
            TurnBuildRequest {
                input: vec![evot_engine::Content::Text {
                    text: "status?".into(),
                }],
                host_tools: None,
                extra_tools: Vec::new(),
                approver: None,
                consume_process_notifications: true,
                previous_llm: None,
            },
        )
        .await?;
    assert_eq!(resumed.input.len(), 2);
    let provenance = resumed.provenance.as_ref().ok_or("missing input sources")?;
    assert!(
        matches!(provenance.sources.as_slice(), [evot_engine::InputSource::User, evot_engine::InputSource::Runtime { kind, .. }] if kind == "previous_process_tasks")
    );
    let model_input = evot_engine::AgentMessage::Llm(evot_engine::Message::User {
        content: resumed.input.clone(),
        provenance: resumed.provenance.clone(),
        timestamp: 0,
    });
    let item = evot::conversation::convert::transcript_from_agent_message(&model_input);
    assert_eq!(
        evot::conversation::input::authored_text(&item).as_deref(),
        Some("status?")
    );
    let replay = evot::conversation::convert::agent_message_from_transcript(&item);
    assert_eq!(replay, model_input);
    assert!(
        matches!(&resumed.input[1], evot_engine::Content::Text { text }
        if text.contains("Background task from a previous evot process: 96e7d776 (PR watcher).")
        && text.contains("Do not report it as a running watcher."))
    );
    let again = assembler
        .build_turn(
            &llm,
            ToolMode::Interactive,
            session.clone(),
            &locator.session_id(),
            TurnBuildRequest {
                input: vec![evot_engine::Content::Text {
                    text: "and now?".into(),
                }],
                host_tools: None,
                extra_tools: Vec::new(),
                approver: None,
                consume_process_notifications: true,
                previous_llm: None,
            },
        )
        .await?;
    assert_eq!(
        again.input.len(),
        1,
        "the orphan notice is delivered once per session"
    );
    // Dump/inspection turns never drain notices, and never announce orphans.
    let inspected = assembler
        .build_turn(
            &llm,
            ToolMode::Interactive,
            session.clone(),
            &locator.session_id(),
            TurnBuildRequest {
                input: Vec::new(),
                host_tools: None,
                extra_tools: Vec::new(),
                approver: None,
                consume_process_notifications: false,
                previous_llm: None,
            },
        )
        .await?;
    assert!(inspected.input.is_empty());
    Ok(())
}
