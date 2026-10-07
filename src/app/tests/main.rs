use evot::error;
use evot::types;

#[path = "agent_prompt_test.rs"]
mod agent_prompt_test;
#[path = "agent_thinking_test.rs"]
mod agent_thinking_test;
#[path = "agent_variable_test.rs"]
mod agent_variable_test;
mod assistant_content_preservation_test;
mod auth_recovery_test;
#[path = "auth_test.rs"]
mod auth_test;
#[path = "auto_compact_test.rs"]
mod auto_compact_test;
#[path = "automation_delivery_test.rs"]
mod automation_delivery_test;
mod automation_lease_test;
mod automation_share_test;
#[path = "background_reclaim_test.rs"]
mod background_reclaim_test;
#[path = "bootstrap_test.rs"]
mod bootstrap_test;
mod channel_supervisor_test;
#[path = "channel_tasks_test.rs"]
mod channel_tasks_test;
#[path = "command_test.rs"]
mod command_test;
#[path = "compact_describe_test.rs"]
mod compact_describe_test;
mod compact_service_test;
#[path = "compact_test.rs"]
mod compact_test;
#[path = "conf_load_test.rs"]
mod conf_load_test;
#[path = "config_info_contract_test.rs"]
mod config_info_contract_test;
#[path = "config_transaction_test.rs"]
mod config_transaction_test;
#[path = "console_routes_test.rs"]
mod console_routes_test;
#[path = "conversation_projection_test.rs"]
mod conversation_projection_test;
#[path = "dashboard_search_test.rs"]
mod dashboard_search_test;
#[path = "delivery_test.rs"]
mod delivery_test;
#[path = "feishu_message_test.rs"]
mod feishu_message_test;
#[path = "feishu_sink_test.rs"]
mod feishu_sink_test;
#[path = "feishu_state_test.rs"]
mod feishu_state_test;
#[path = "id_validation_test.rs"]
mod id_validation_test;
#[path = "judge_trace_test.rs"]
mod judge_trace_test;
#[path = "manual_compact_llm_test.rs"]
mod manual_compact_llm_test;
mod model_catalog_test;
#[path = "model_metadata_test.rs"]
mod model_metadata_test;
#[path = "model_selection_test.rs"]
mod model_selection_test;
mod model_settings_test;
mod model_spec_test;
#[path = "orchestrator_compact_test.rs"]
mod orchestrator_compact_test;
mod process_registry_test;
mod resume_context_anchor_test;
#[path = "run_ask_channel_test.rs"]
mod run_ask_channel_test;
#[path = "run_manager_test.rs"]
mod run_manager_test;
mod run_outbox_test;
mod run_projection_test;
#[path = "run_queue_test.rs"]
mod run_queue_test;
#[path = "run_registry_test.rs"]
mod run_registry_test;
mod run_user_persistence_test;
#[path = "schema_compat_test.rs"]
mod schema_compat_test;
#[path = "server_protocol_test.rs"]
mod server_protocol_test;
mod session_fork_test;
#[path = "session_gates_test.rs"]
mod session_gates_test;
mod session_listing_bench;
mod session_listing_cancel_test;
#[path = "session_locator_test.rs"]
mod session_locator_test;
#[path = "session_observability_test.rs"]
mod session_observability_test;
#[path = "session_queries_test.rs"]
mod session_queries_test;
mod session_rename_test;
mod session_search_test;
mod session_service_test;
#[path = "session_task_test.rs"]
mod session_task_test;
#[path = "session_test.rs"]
mod session_test;
#[path = "settings_test.rs"]
mod settings_test;
mod share_client;
mod share_export;
#[path = "share_import_test.rs"]
mod share_import_test;
#[path = "skill_loader_test.rs"]
mod skill_loader_test;
#[path = "skill_prompt_test.rs"]
mod skill_prompt_test;
#[path = "storage_memory_test.rs"]
mod storage_memory_test;
#[path = "storage_test.rs"]
mod storage_test;
mod sync_test;
#[path = "tool_mode_test.rs"]
mod tool_mode_test;
mod turn_assembler_test;
#[path = "types_transcript_stats_test.rs"]
mod types_transcript_stats_test;

/// Ensure every `*_test.rs` file in this directory is listed as a module above.
/// Fails at test-time (not compile-time) but catches forgotten additions in CI.
#[test]
fn all_test_files_included() {
    let test_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    let mut missing = Vec::new();
    let main_src = include_str!("main.rs");
    for entry in std::fs::read_dir(&test_dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with("_test.rs") {
            let mod_name = name.trim_end_matches(".rs");
            if !main_src.contains(mod_name) {
                missing.push(name);
            }
        }
    }
    assert!(
        missing.is_empty(),
        "Test files not included in tests/main.rs: {:?}\nAdd them as modules.",
        missing
    );
}
