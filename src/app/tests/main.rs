use evot::base;
use evot::types;

#[path = "surface/acp_config_reload_test.rs"]
mod acp_config_reload_test;
#[path = "surface/acp_image_test.rs"]
mod acp_image_test;
#[path = "surface/acp_models_test.rs"]
mod acp_models_test;
#[path = "surface/acp_test.rs"]
mod acp_test;
#[path = "agent/agent_prompt_test.rs"]
mod agent_prompt_test;
#[path = "agent/agent_thinking_test.rs"]
mod agent_thinking_test;
#[path = "agent/agent_variable_test.rs"]
mod agent_variable_test;
#[path = "base/architecture_test.rs"]
mod architecture_test;
#[path = "session/assistant_content_preservation_test.rs"]
mod assistant_content_preservation_test;
#[path = "auth/auth_recovery_test.rs"]
mod auth_recovery_test;
#[path = "auth/auth_test.rs"]
mod auth_test;
#[path = "agent/auto_compact_test.rs"]
mod auto_compact_test;
#[path = "surface/automation_delivery_test.rs"]
mod automation_delivery_test;
#[path = "surface/automation_lease_test.rs"]
mod automation_lease_test;
#[path = "surface/automation_share_test.rs"]
mod automation_share_test;
#[path = "surface/automation_workspace_test.rs"]
mod automation_workspace_test;
#[path = "agent/background_reclaim_test.rs"]
mod background_reclaim_test;
#[path = "base/blocking_test.rs"]
mod blocking_test;
#[path = "agent/bootstrap_test.rs"]
mod bootstrap_test;
#[path = "surface/channel_supervisor_test.rs"]
mod channel_supervisor_test;
#[path = "surface/channel_tasks_test.rs"]
mod channel_tasks_test;
#[path = "auth/cloud_capabilities_test.rs"]
mod cloud_capabilities_test;
#[path = "cloud/cloud_http_test.rs"]
mod cloud_http_test;
#[path = "agent/command_test.rs"]
mod command_test;
#[path = "session/compact_describe_test.rs"]
mod compact_describe_test;
#[path = "session/compact_service_test.rs"]
mod compact_service_test;
#[path = "session/compact_test.rs"]
mod compact_test;
#[path = "cloud/compute_prompt_test.rs"]
mod compute_prompt_test;
#[path = "cloud/compute_test.rs"]
mod compute_test;
#[path = "conf/conf_load_test.rs"]
mod conf_load_test;
#[path = "surface/config_info_contract_test.rs"]
mod config_info_contract_test;
#[path = "conf/config_transaction_test.rs"]
mod config_transaction_test;
#[path = "surface/console_routes_test.rs"]
mod console_routes_test;
#[path = "session/conversation_projection_test.rs"]
mod conversation_projection_test;
#[path = "surface/dashboard_search_test.rs"]
mod dashboard_search_test;
#[path = "surface/delivery_test.rs"]
mod delivery_test;
#[path = "surface/feishu_message_test.rs"]
mod feishu_message_test;
#[path = "surface/feishu_sink_test.rs"]
mod feishu_sink_test;
#[path = "surface/feishu_state_test.rs"]
mod feishu_state_test;
#[path = "agent/fork_prompt_test.rs"]
mod fork_prompt_test;
#[path = "types/id_validation_test.rs"]
mod id_validation_test;
#[path = "session/input_provenance_test.rs"]
mod input_provenance_test;
#[path = "session/manual_compact_llm_test.rs"]
mod manual_compact_llm_test;
#[path = "agent/model_catalog_test.rs"]
mod model_catalog_test;
#[path = "conf/model_metadata_test.rs"]
mod model_metadata_test;
#[path = "agent/model_selection_test.rs"]
mod model_selection_test;
#[path = "agent/model_settings_test.rs"]
mod model_settings_test;
#[path = "conf/model_spec_test.rs"]
mod model_spec_test;
#[path = "session/orchestrator_compact_test.rs"]
mod orchestrator_compact_test;
#[path = "agent/orphaned_tasks_test.rs"]
mod orphaned_tasks_test;
#[path = "privacy/privacy_leaks_test.rs"]
mod privacy_leaks_test;
#[path = "privacy/privacy_packs_test.rs"]
mod privacy_packs_test;
#[path = "privacy/privacy_runtime_test.rs"]
mod privacy_runtime_test;
#[path = "privacy/privacy_test.rs"]
mod privacy_test;
#[path = "agent/process_registry_test.rs"]
mod process_registry_test;
#[path = "session/resume_context_anchor_test.rs"]
mod resume_context_anchor_test;
#[path = "observability/retired_pruning_test.rs"]
mod retired_pruning_test;
#[path = "agent/run_ask_channel_test.rs"]
mod run_ask_channel_test;
#[path = "agent/run_manager_test.rs"]
mod run_manager_test;
#[path = "agent/run_outbox_test.rs"]
mod run_outbox_test;
#[path = "agent/run_projection_test.rs"]
mod run_projection_test;
#[path = "agent/run_queue_test.rs"]
mod run_queue_test;
#[path = "agent/run_registry_test.rs"]
mod run_registry_test;
#[path = "agent/run_user_persistence_test.rs"]
mod run_user_persistence_test;
#[path = "conf/schema_compat_test.rs"]
mod schema_compat_test;
#[path = "surface/server_protocol_test.rs"]
mod server_protocol_test;
#[path = "session/session_fork_test.rs"]
mod session_fork_test;
#[path = "session/session_gates_test.rs"]
mod session_gates_test;
#[path = "session/session_listing_bench.rs"]
mod session_listing_bench;
#[path = "session/session_listing_cancel_test.rs"]
mod session_listing_cancel_test;
#[path = "session/session_locator_test.rs"]
mod session_locator_test;
#[path = "observability/session_observability_test.rs"]
mod session_observability_test;
#[path = "session/session_queries_test.rs"]
mod session_queries_test;
#[path = "session/session_rename_test.rs"]
mod session_rename_test;
#[path = "session/session_search_test.rs"]
mod session_search_test;
#[path = "session/session_service_test.rs"]
mod session_service_test;
#[path = "agent/session_task_test.rs"]
mod session_task_test;
#[path = "session/session_test.rs"]
mod session_test;
#[path = "conf/settings_test.rs"]
mod settings_test;
#[path = "cloud/share_client.rs"]
mod share_client;
#[path = "cloud/share_export.rs"]
mod share_export;
#[path = "cloud/share_import_test.rs"]
mod share_import_test;
#[path = "agent/skill_loader_test.rs"]
mod skill_loader_test;
#[path = "agent/skill_prompt_test.rs"]
mod skill_prompt_test;
#[path = "session/storage_memory_test.rs"]
mod storage_memory_test;
#[path = "session/storage_test.rs"]
mod storage_test;
#[path = "suggestion/suggestion_model_test.rs"]
mod suggestion_model_test;
#[path = "suggestion/suggestion_progress_test.rs"]
mod suggestion_progress_test;
#[path = "suggestion/suggestion_request_test.rs"]
mod suggestion_request_test;
#[path = "suggestion/suggestion_test.rs"]
mod suggestion_test;
#[path = "suggestion/suggestion_workflow_test.rs"]
mod suggestion_workflow_test;
#[path = "cloud/sync_test.rs"]
mod sync_test;
#[path = "agent/tool_approval_test.rs"]
mod tool_approval_test;
#[path = "agent/tool_mode_test.rs"]
mod tool_mode_test;
#[path = "agent/turn_assembler_test.rs"]
mod turn_assembler_test;
#[path = "observability/types_transcript_stats_test.rs"]
mod types_transcript_stats_test;

/// Ensure every `*_test.rs` file under a group directory is listed as a module
/// above. Fails at test-time (not compile-time) but catches forgotten
/// additions in CI. `unit/` holds tests the library compiles in through
/// `#[path]` because they reach private items.
#[test]
fn all_test_files_included() {
    let test_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut missing = Vec::new();
    let main_src = include_str!("main.rs");
    for group in std::fs::read_dir(&test_dir).unwrap() {
        let group = group.unwrap();
        if !group.file_type().unwrap().is_dir() {
            continue;
        }
        let group_name = group.file_name().to_string_lossy().to_string();
        if group_name == "unit" {
            continue;
        }
        for entry in std::fs::read_dir(group.path()).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().to_string();
            if name.ends_with("_test.rs") && !main_src.contains(&format!("\"{group_name}/{name}\""))
            {
                missing.push(format!("{group_name}/{name}"));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "Test files not included in tests/main.rs: {:?}\nAdd them as modules.",
        missing
    );
}
