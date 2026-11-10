use std::process::Command;

use evot::agent::models::cycle_thinking_level;
use evot::agent::models::set_thinking_level;
use evot::agent::Agent;
use evot::conf::Config;
use evot_engine::ThinkingLevel;

type TestResult = Result<(), Box<dyn std::error::Error>>;

// Config loading also consults HOME/auth. Use a child process so neither the
// developer's configuration nor parallel tests can affect this scenario.
#[test]
fn model_settings_preserve_live_and_persisted_selection_policy() -> TestResult {
    const CHILD: &str = "EVOT_MODEL_SETTINGS_TEST_HOME";
    if std::env::var_os(CHILD).is_none() {
        let home = tempfile::tempdir()?;
        let output = Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "model_settings_test::model_settings_preserve_live_and_persisted_selection_policy",
                "--nocapture",
            ])
            .env_clear()
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env(CHILD, home.path())
            .output()?;
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return Ok(());
    }

    let home = std::path::PathBuf::from(std::env::var(CHILD)?);
    let path = home.join("evot.env");
    std::fs::write(
        &path,
        concat!(
            "# personal preamble\nUNRELATED=keep\n",
            "EVOT_LLM_PROVIDER=anthropic\n",
            "EVOT_LLM_ANTHROPIC_PROTOCOL=anthropic\n",
            "EVOT_LLM_ANTHROPIC_API_KEY=fixture-key\n",
            "EVOT_LLM_ANTHROPIC_BASE_URL=https://example.invalid\n",
            "EVOT_LLM_ANTHROPIC_MODEL=claude-opus-4-6\n",
            "EVOT_LLM_ANTHROPIC_THINKING_LEVEL=high\n",
        ),
    )?;
    let env_file = path.to_str().ok_or("non-UTF8 fixture path")?;
    let config = Config::load_with_env_file(Some(env_file))?;
    let agent = Agent::new(&config, home.to_string_lossy())?;

    assert_eq!(
        set_thinking_level(&agent, env_file, "low"),
        Some("low".into())
    );
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Low);
    let saved = Config::load_with_env_file(Some(env_file))?;
    assert_eq!(saved.llm.thinking_level, Some(ThinkingLevel::Low));
    assert_eq!(saved.active_llm()?.thinking_level, ThinkingLevel::Low);
    let profile = saved.providers.get("anthropic").ok_or("missing provider")?;
    assert_eq!(profile.thinking_level, Some(ThinkingLevel::Low));
    assert_eq!(profile.api_key, "fixture-key");
    assert_eq!(profile.base_url, "https://example.invalid");
    assert_eq!(profile.models, vec!["claude-opus-4-6"]);
    assert!(std::fs::read_to_string(&path)?.contains("# personal preamble\nUNRELATED=keep"));

    let before = std::fs::read(&path)?;
    for invalid in ["unknown", "minimal"] {
        assert_eq!(set_thinking_level(&agent, env_file, invalid), None);
        assert_eq!(agent.llm().thinking_level, ThinkingLevel::Low);
        assert_eq!(std::fs::read(&path)?, before);
    }
    assert_eq!(
        cycle_thinking_level(&agent, env_file),
        Some("medium".into())
    );
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Medium);
    assert_eq!(
        Config::load_with_env_file(Some(env_file))?
            .active_llm()?
            .thinking_level,
        ThinkingLevel::Medium
    );

    // Deterministically fail the write without relying on filesystem permissions:
    // the transaction's sidecar cannot be opened as a file when it is a directory.
    let lock_path = home.join("evot.env.lock");
    std::fs::remove_file(&lock_path)?;
    std::fs::create_dir(&lock_path)?;
    let before = std::fs::read(&path)?;
    assert_eq!(
        set_thinking_level(&agent, env_file, "high"),
        Some("high".into())
    );
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::High);
    assert_eq!(cycle_thinking_level(&agent, env_file), Some("max".into()));
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Max);
    assert_eq!(std::fs::read(&path)?, before);

    // Loading the default fails too; the live change still succeeds.
    std::fs::write(&path, "EVOT_LLM_ANTHROPIC_PROTOCOL=invalid\n")?;
    assert!(Config::load_with_env_file(Some(env_file)).is_err());
    assert_eq!(
        set_thinking_level(&agent, env_file, "low"),
        Some("low".into())
    );
    assert_eq!(agent.llm().thinking_level, ThinkingLevel::Low);

    let mut unsupported = agent.llm();
    unsupported.protocol = evot::conf::Protocol::OpenAi;
    unsupported.model = "deepseek-chat".into();
    unsupported.model_config = evot::conf::LlmConfig::unconfigured().model_config;
    agent.set_llm(unsupported);
    assert!(agent.supported_thinking_levels().is_empty());
    let before_level = agent.llm().thinking_level;
    let before_file = std::fs::read(&path)?;
    assert_eq!(cycle_thinking_level(&agent, env_file), None);
    assert_eq!(set_thinking_level(&agent, env_file, "low"), None);
    assert_eq!(agent.llm().thinking_level, before_level);
    assert_eq!(std::fs::read(&path)?, before_file);
    Ok(())
}
