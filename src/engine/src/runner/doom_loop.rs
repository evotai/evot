//! Doom-loop detection: detect when the agent repeats the same tool-call
//! batch across consecutive turns and inject a steering message to break
//! the cycle.

use std::collections::VecDeque;

use crate::context::now_ms;
use crate::types::*;

/// A canonical representation of one tool call (name + sorted JSON args).
#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolCallSignature {
    name: String,
    args_canonical: String,
}

/// A batch of tool calls from a single assistant turn.
type ToolBatch = Vec<ToolCallSignature>;

/// Returned when a doom loop is detected.
pub struct DoomLoopIntervention {
    /// A steering message to inject before the next LLM turn.
    pub steering_message: AgentMessage,
}

/// Tracks recent tool-call batches and detects repetitive loops.
pub struct DoomLoopDetector {
    threshold: usize,
    recent: VecDeque<ToolBatch>,
}

impl DoomLoopDetector {
    /// Create a detector with the given repetition threshold.
    pub fn new(threshold: usize) -> Self {
        Self {
            threshold,
            recent: VecDeque::new(),
        }
    }

    /// Check a tool-call batch for doom-loop repetition.
    ///
    /// If the same batch has appeared `threshold` consecutive times, returns
    /// a [`DoomLoopIntervention`] with a steering message.
    /// The batch is NOT recorded so the detector stays at the trigger edge.
    ///
    /// Otherwise records the batch and returns `None`.
    pub fn check(
        &mut self,
        tool_calls: &[(String, String, serde_json::Value)],
    ) -> Option<DoomLoopIntervention> {
        let batch = Self::to_batch(tool_calls);

        let consecutive = self
            .recent
            .iter()
            .rev()
            .take_while(|prev| *prev == &batch)
            .count();

        let total = consecutive + 1;

        if total >= self.threshold {
            tracing::warn!(
                count = total,
                "doom loop detected — skipping tool execution"
            );
            Some(Self::build_intervention(total))
        } else {
            self.recent.push_back(batch);
            while self.recent.len() > self.threshold {
                self.recent.pop_front();
            }
            None
        }
    }

    fn build_intervention(count: usize) -> DoomLoopIntervention {
        let warning = format!(
            "You have repeated the exact same tool calls with the same arguments {count} times \
             without making progress. Do not repeat the same calls again. Either:\n\
             1. Try a different tool\n\
             2. Use different arguments\n\
             3. Explain what is blocking you and ask the user for help"
        );

        DoomLoopIntervention {
            steering_message: AgentMessage::Llm(Message::User {
                provenance: Some(crate::InputProvenance::runtime(1, "doom_loop_guard", None)),
                content: vec![Content::Text { text: warning }],
                timestamp: now_ms(),
            }),
        }
    }

    fn to_batch(tool_calls: &[(String, String, serde_json::Value)]) -> ToolBatch {
        tool_calls
            .iter()
            .map(|(_id, name, args)| ToolCallSignature {
                name: name.to_lowercase(),
                args_canonical: canonical_json(args),
            })
            .collect()
    }
}

/// Produce a deterministic JSON string (keys sorted recursively).
fn canonical_json(value: &serde_json::Value) -> String {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let entries: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical_json(&map[*k])
                    )
                })
                .collect();
            format!("{{{}}}", entries.join(","))
        }
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", items.join(","))
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}
