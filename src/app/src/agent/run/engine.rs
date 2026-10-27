use std::sync::Arc;

use crate::conf::Protocol;

/// Fully resolved engine construction input. No transport or session I/O is
/// performed here; the application prepares this snapshot before execution.
pub struct EngineOptions {
    pub provider: String,
    pub protocol: Protocol,
    pub model: String,
    pub api_key: String,
    pub model_config: evot_engine::provider::ModelConfig,
    pub system_prompt: String,
    pub system_prompt_sections: Vec<crate::agent::prompt::Section>,
    pub limits: Option<crate::agent::ExecutionLimits>,
    pub tools: Vec<Box<dyn evot_engine::AgentTool>>,
    pub thinking_level: evot_engine::ThinkingLevel,
    pub cwd: std::path::PathBuf,
    pub path_guard: Arc<evot_engine::PathGuard>,
    pub spill_dir: Option<std::path::PathBuf>,
    pub process_manager: Option<Arc<evot_engine::tools::ProcessManager>>,
    pub prompt_cache_key: Option<String>,
    pub provider_override: Option<Arc<dyn evot_engine::provider::StreamProvider>>,
    /// The model that produced the current history, when it differs from the
    /// active one. Local compaction summaries go to it first so the history is
    /// condensed by the model that fits it; the active model is the fallback.
    pub compaction_llm: Option<crate::conf::LlmConfig>,
    pub compaction_state: Option<evot_engine::CompactionState>,
    /// Judge for the prune branch of auto-compaction; `None` = summaries only.
    pub judge: Option<Arc<dyn evot_engine::judge::Judge>>,
    /// The session's prune ledger, shared across its runs.
    pub prune_ledger: Arc<tokio::sync::Mutex<evot_engine::context::compaction::PruneLedger>>,
}

pub(super) fn build_engine(
    options: EngineOptions,
    prior_messages: Vec<evot_engine::AgentMessage>,
) -> evot_engine::Agent {
    let model_config = options.model_config;
    let context_config =
        evot_engine::context::ContextConfig::from_model(&model_config, options.thinking_level);
    // Every transport, injected or built, goes through the privacy boundary.
    let transport = |protocol: &Protocol| match &options.provider_override {
        Some(provider) => crate::models::transport::overridden(provider.clone()),
        None => crate::models::transport::for_protocol(protocol),
    };
    let provider = transport(&options.protocol);
    let compaction_context = options.compaction_llm.map(|previous| {
        let provider = transport(&previous.protocol);
        evot_engine::context::SummarizerContext {
            provider: crate::auth::recovery::with_recovery(
                provider,
                &previous.provider,
                &previous.model_config,
            ),
            model: previous.model,
            api_key: previous.api_key,
            thinking_level: previous.thinking_level,
            system_prompt: options.system_prompt.clone(),
            tools: vec![],
            max_tokens: None,
            cache_config: evot_engine::types::CacheConfig::default(),
            prompt_cache_key: options.prompt_cache_key.clone(),
            model_config: Some(previous.model_config),
        }
    });
    let provider_agent = evot_engine::Agent::new(crate::auth::recovery::with_recovery(
        provider,
        &options.provider,
        &model_config,
    ));
    let limits = options
        .limits
        .map(|limits| evot_engine::context::ExecutionLimits {
            max_turns: limits.max_turns as usize,
            max_total_tokens: limits.max_total_tokens as usize,
            max_duration: std::time::Duration::from_secs(limits.max_duration_secs),
        });
    let agent = provider_agent
        .with_model(&options.model)
        .with_api_key(&options.api_key)
        .with_model_config(model_config)
        .with_context_config(context_config)
        .with_system_prompt(&options.system_prompt)
        .with_messages(prior_messages)
        .with_execution_limits_opt(limits)
        .with_tools(options.tools)
        .with_cwd(options.cwd)
        .with_path_guard(options.path_guard)
        .with_thinking(options.thinking_level)
        .with_compaction_state_opt(options.compaction_state)
        .with_compaction_contexts(compaction_context, None)
        .with_judge(options.judge)
        .with_prune_ledger(Some(options.prune_ledger))
        .with_prompt_cache_key_opt(options.prompt_cache_key)
        .with_spill_opt(
            options
                .spill_dir
                .map(|dir| Arc::new(evot_engine::spill::FsSpill::new(dir))),
        );
    match options.process_manager {
        Some(process_manager) => agent.with_process_manager(process_manager),
        None => agent,
    }
}
