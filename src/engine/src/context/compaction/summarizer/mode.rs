//! SummarizerMode — LLM summarization dispatch.

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use super::llm;
use super::types::SummarizerError;
use super::types::SummarizerInput;
use super::types::SummarizerOutput;
use crate::context::compaction::types::CompactionObserver;
use crate::provider::StreamProvider;
use crate::types::ThinkingLevel;

/// Output budget for one summary. The prompt targets ~600 words; 4k tokens is
/// ample headroom and bounds the slow generation phase of compaction.
pub const DEFAULT_SUMMARY_RESERVE_TOKENS: u32 = 4_000;

/// LLM-generated structured summary configuration.
#[derive(Debug, Clone)]
pub enum SummarizerMode {
    Llm { reserve_tokens: u32 },
}

impl Default for SummarizerMode {
    fn default() -> Self {
        Self::Llm {
            reserve_tokens: DEFAULT_SUMMARY_RESERVE_TOKENS,
        }
    }
}

/// Context needed for an LLM summary.
#[derive(Clone)]
pub struct SummarizerContext {
    pub provider: Arc<dyn StreamProvider>,
    pub model: String,
    pub api_key: String,
    pub thinking_level: ThinkingLevel,
    /// Normal-turn request shape, used to size the fixed request overhead.
    pub system_prompt: String,
    pub tools: Vec<crate::provider::ToolDefinition>,
    pub max_tokens: Option<u32>,
    pub cache_config: crate::types::CacheConfig,
    pub prompt_cache_key: Option<String>,
    /// Full transport/provider metadata for the summarization request. Without
    /// this, custom Anthropic-compatible channels silently fall back to the
    /// default Anthropic base URL and compaction fails before the main request.
    pub model_config: Option<crate::provider::ModelConfig>,
}

impl SummarizerMode {
    pub fn reserve_tokens(&self) -> u32 {
        match self {
            Self::Llm { reserve_tokens } => *reserve_tokens,
        }
    }

    /// Generate a summary with the mode's configured output budget.
    pub async fn summarize(
        &self,
        input: SummarizerInput,
        ctx: Option<&SummarizerContext>,
        cancel: CancellationToken,
    ) -> Result<SummarizerOutput, SummarizerError> {
        self.summarize_with_reserve(input, ctx, self.reserve_tokens(), cancel)
            .await
    }

    /// Generate a summary with a context-adjusted output budget.
    pub async fn summarize_with_reserve(
        &self,
        input: SummarizerInput,
        ctx: Option<&SummarizerContext>,
        reserve_tokens: u32,
        cancel: CancellationToken,
    ) -> Result<SummarizerOutput, SummarizerError> {
        self.summarize_with_observer(input, ctx, reserve_tokens, cancel, None)
            .await
    }

    pub async fn summarize_with_observer(
        &self,
        input: SummarizerInput,
        ctx: Option<&SummarizerContext>,
        reserve_tokens: u32,
        cancel: CancellationToken,
        observer: Option<CompactionObserver>,
    ) -> Result<SummarizerOutput, SummarizerError> {
        let ctx = ctx
            .ok_or_else(|| SummarizerError::Failed("LLM mode requires SummarizerContext".into()))?;
        match self {
            Self::Llm { .. } => {
                llm::summarize_with_observer(input, ctx, reserve_tokens, cancel, observer).await
            }
        }
    }
}
