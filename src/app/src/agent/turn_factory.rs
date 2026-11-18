use std::sync::Arc;

use super::model_handoff::ModelHandoff;
use super::models::ModelSelection;
use super::run::runtime;
use super::run::runtime::TurnFactory;
use super::tools::HostTools;
use super::tools::ToolApprover;
use super::tools::ToolMode;
use super::turn_assembler::TurnAssembler;
use super::turn_assembler::TurnBuildRequest;
use crate::base::error::Result;
use crate::conf::Config;
use crate::conf::LlmConfig;
use crate::session::Session;

pub(super) struct AgentTurnFactory {
    pub assembler: Arc<TurnAssembler>,
    pub session: Arc<Session>,
    pub mode: ToolMode,
    pub session_id: String,
    pub llm: LlmConfig,
    pub selection: Arc<ModelSelection>,
    /// Selection replaced by the latest model switch, for compaction.
    pub previous_llm: Option<LlmConfig>,
    pub model_catalog: Option<Arc<Config>>,
    pub host_tools: Option<HostTools>,
    /// Run-scoped tools attached by a prepared command.
    pub extra_tools: Vec<Arc<dyn evot_engine::AgentTool>>,
    pub approver: Option<Arc<dyn ToolApprover>>,
    pub scratch_dir: Option<std::path::PathBuf>,
}

#[async_trait::async_trait]
impl TurnFactory for AgentTurnFactory {
    async fn build(
        &self,
        start: runtime::SegmentStart,
        allow_handoff: bool,
    ) -> Result<runtime::Segment> {
        let (llm, previous_llm, input, resume) = match start {
            runtime::SegmentStart::Prompt(input) => {
                (self.llm.clone(), self.previous_llm.clone(), input, false)
            }
            runtime::SegmentStart::Resume(transition) => (
                transition.llm,
                Some(transition.previous_llm),
                Vec::new(),
                true,
            ),
        };
        let handoff = self
            .model_catalog
            .as_ref()
            .filter(|_| allow_handoff)
            .map(|config| Arc::new(ModelHandoff::new(config.clone(), &llm)));
        let mut extra_tools = self.extra_tools.clone();
        if let Some(tool) = &handoff {
            extra_tools.push(tool.clone());
        }
        let turn = self
            .assembler
            .build_segment(
                &llm,
                self.mode,
                Arc::clone(&self.session),
                &self.session_id,
                TurnBuildRequest {
                    input,
                    host_tools: self.host_tools.clone(),
                    extra_tools,
                    approver: self.approver.clone(),
                    scratch_dir: self.scratch_dir.clone(),
                    previous_llm,
                },
                resume,
            )
            .await?;
        Ok(runtime::Segment { turn, llm, handoff })
    }

    async fn activate_handoff(&self, llm: &LlmConfig) -> Result<()> {
        self.session
            .set_run_model_selection(
                llm.provider.clone(),
                llm.model.clone(),
                ModelSelection::persisted_thinking_level_for(llm),
            )
            .await?;
        self.selection.replace(llm.clone());
        Ok(())
    }
}
