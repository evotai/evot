use evot::agent::run::policy::ExecutionBudget;
use evot::agent::run::policy::ToolAccess;
use evot::agent::ToolMode;

#[test]
fn interactive_preset_is_unbounded_and_can_background() {
    let policy = ToolMode::Interactive.policy();
    assert_eq!(policy.budget, ExecutionBudget::Unbounded);
    assert!(policy.background_processes);
    assert!(policy.host_tools);
    assert!(policy.web_fetch);
    assert_eq!(policy.tools, ToolAccess::Full);
}

#[test]
fn autonomous_presets_keep_budget_and_no_background_processes() {
    for mode in [ToolMode::Headless, ToolMode::Readonly] {
        let policy = mode.policy();
        assert_eq!(policy.budget, ExecutionBudget::Configured);
        assert!(!policy.background_processes);
        assert!(!policy.web_fetch);
    }
    assert_eq!(ToolMode::Headless.policy().tools, ToolAccess::Full);
    assert!(ToolMode::Headless.policy().host_tools);
    assert_eq!(ToolMode::Readonly.policy().tools, ToolAccess::Readonly);
    assert!(!ToolMode::Readonly.policy().host_tools);
}

#[test]
fn tool_builder_consumes_resolved_policy_not_transport_presets() {
    let source = include_str!("../src/agent/tools/build.rs");
    assert!(!source.contains("mode: ToolMode"));
    assert!(!source.contains("matches!(mode"));
    assert!(source.contains("policy: RunPolicy"));
}

#[test]
fn chat_preset_offers_no_tools_of_any_kind() {
    let policy = ToolMode::Chat.policy();
    assert_eq!(policy.tools, ToolAccess::None);
    assert_eq!(policy.budget, ExecutionBudget::Configured);
    assert!(!policy.host_tools);
    assert!(!policy.background_processes);
    assert!(!policy.web_fetch);
}
