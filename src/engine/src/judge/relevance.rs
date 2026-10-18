//! Relevance — does a proposed tool call serve the user's current task?
//!
//! Scored the moment the model proposes the call, concurrently with its
//! execution: the judge request is separate from the main model (no cache
//! interaction) and tool execution usually outlasts it, so the score is
//! typically ready before the tool card is committed. A late or failed score
//! is dropped — nothing ever waits for it.
//!
//! This is a different question from pruning. Prune asks *afterwards* whether
//! a result's contents are still needed (the answer decays with age);
//! relevance asks *now* whether the action itself is on-task (the answer is
//! fixed at proposal time). A run of low scores is the live signal that the
//! agent has drifted.

use std::collections::HashMap;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::judge::Answer;
use crate::judge::Judge;
use crate::judge::Question;
use crate::types::AgentMessage;
use crate::types::Content;
use crate::types::Message;

/// A proposed call to score: `(call_id, tool_name, arguments)`.
pub type ProposedCall = (String, String, serde_json::Value);

/// Calls per review. Small enough that a drift shows within a few turns,
/// large enough that one stray call is not a verdict on the run.
pub const REVIEW_WINDOW: usize = 6;

/// Score one window of calls and shape the answer for the event. `None` when
/// the judge did not answer.
pub async fn review_window(
    judge: Arc<dyn Judge>,
    state: String,
    calls: Vec<ProposedCall>,
    cancel: CancellationToken,
) -> Option<Vec<crate::types::ReviewedCall>> {
    let scores = score_calls(judge, state, &calls, cancel).await;
    if scores.is_empty() {
        return None;
    }
    Some(
        calls
            .into_iter()
            .filter_map(|(id, name, arguments)| {
                let relevance = *scores.get(&id)?;
                Some(crate::types::ReviewedCall {
                    tool_call_id: id,
                    tool_name: name,
                    arguments: abridge(&arguments.to_string(), 160),
                    relevance,
                })
            })
            .collect(),
    )
}

/// Characters of the task and trail the judge reads. Small on purpose: the
/// question is about the action, not the history.
const TASK_CHARS: usize = 4_000;
const TRAIL_LINES: usize = 12;
const ARGUMENT_CHARS: usize = 600;

/// Score every call of one turn in a single judge request.
/// Returns `call_id -> probability that the call serves the task`.
pub async fn score_calls(
    judge: Arc<dyn Judge>,
    state: String,
    calls: &[ProposedCall],
    cancel: CancellationToken,
) -> HashMap<String, f64> {
    let questions: Vec<Question> = calls
        .iter()
        .enumerate()
        .map(|(index, (_, name, arguments))| {
            let arguments = abridge(&arguments.to_string(), ARGUMENT_CHARS);
            Question::noul(
                format!("call_{index}"),
                format!("Is calling `{name}` with {arguments} a step that serves the user's current task?"),
            )
            .with_criteria(
                "directly advances the task or gathers information the task needs",
                "unrelated to the task, repeats an action that already failed, or explores an unrelated direction",
            )
        })
        .collect();
    let answers = match judge.ask(&state, &questions, cancel).await {
        Ok(answers) => answers,
        Err(error) => {
            tracing::debug!(error = %error, "relevance: judge unavailable");
            return HashMap::new();
        }
    };
    calls
        .iter()
        .enumerate()
        .filter_map(|(index, (id, _, _))| {
            let answer = answers.get(&format!("call_{index}"))?;
            Some((id.clone(), Answer::probability(answer)?))
        })
        .collect()
}

/// The state the judge reads: the user's task and a short trail of what the
/// agent has been doing, newest last.
pub fn relevance_state(messages: &[AgentMessage]) -> String {
    let task = messages
        .iter()
        .rev()
        .find_map(|message| match message {
            AgentMessage::Llm(Message::User { content, .. }) => {
                let text: String = content
                    .iter()
                    .filter_map(|block| match block {
                        Content::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                (!text.trim().is_empty()).then_some(text)
            }
            _ => None,
        })
        .unwrap_or_default();

    let mut trail: Vec<String> = messages
        .iter()
        .rev()
        .filter_map(|message| match message {
            AgentMessage::Llm(Message::Assistant { content, .. }) => {
                let line: Vec<String> = content
                    .iter()
                    .filter_map(|block| match block {
                        Content::ToolCall {
                            name, arguments, ..
                        } => Some(format!(
                            "called {name} {}",
                            abridge(&arguments.to_string(), 120)
                        )),
                        Content::Text { text } if !text.trim().is_empty() => {
                            Some(format!("said: {}", abridge(text.trim(), 160)))
                        }
                        _ => None,
                    })
                    .collect();
                (!line.is_empty()).then(|| line.join("; "))
            }
            _ => None,
        })
        .take(TRAIL_LINES)
        .collect();
    trail.reverse();

    format!(
        "The user's task:\n{}\n\nWhat the agent has done so far (oldest first):\n{}",
        abridge(&task, TASK_CHARS),
        trail.join("\n"),
    )
}

fn abridge(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let head: String = text.chars().take(cap).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::judge::JudgeError;
    use crate::types::Usage;

    struct Scripted(HashMap<String, f64>);

    #[async_trait::async_trait]
    impl Judge for Scripted {
        async fn ask(
            &self,
            _state: &str,
            questions: &[Question],
            _cancel: CancellationToken,
        ) -> Result<HashMap<String, Answer>, JudgeError> {
            Ok(questions
                .iter()
                .filter_map(|q| {
                    self.0
                        .get(&q.id)
                        .map(|p| (q.id.clone(), Answer::Noul { probability: *p }))
                })
                .collect())
        }
    }

    fn call(id: &str, name: &str) -> ProposedCall {
        (
            id.into(),
            name.into(),
            serde_json::json!({"path": "src/a.rs"}),
        )
    }

    fn user(text: &str) -> AgentMessage {
        AgentMessage::Llm(Message::User {
            provenance: None,
            content: vec![Content::Text { text: text.into() }],
            timestamp: 0,
        })
    }

    fn assistant_call(name: &str) -> AgentMessage {
        AgentMessage::Llm(Message::Assistant {
            content: vec![Content::ToolCall {
                id: "x".into(),
                name: name.into(),
                arguments: serde_json::json!({}),
                metadata: None,
            }],
            stop_reason: crate::types::StopReason::ToolUse,
            model: String::new(),
            provider: String::new(),
            usage: Usage::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        })
    }

    #[tokio::test]
    async fn scores_map_back_to_call_ids() {
        let judge = Scripted(HashMap::from([
            ("call_0".into(), 0.92),
            ("call_1".into(), 0.15),
        ]));
        let calls = vec![call("a", "Read"), call("b", "Bash")];
        let scores = score_calls(
            Arc::new(judge),
            "state".into(),
            &calls,
            CancellationToken::new(),
        )
        .await;
        assert_eq!(scores.get("a"), Some(&0.92));
        assert_eq!(scores.get("b"), Some(&0.15));
    }

    #[tokio::test]
    async fn a_failed_judge_scores_nothing() {
        struct Broken;
        #[async_trait::async_trait]
        impl Judge for Broken {
            async fn ask(
                &self,
                _s: &str,
                _q: &[Question],
                _c: CancellationToken,
            ) -> Result<HashMap<String, Answer>, JudgeError> {
                Err(JudgeError::Transport("down".into()))
            }
        }
        let scores = score_calls(
            Arc::new(Broken),
            "state".into(),
            &[call("a", "Read")],
            CancellationToken::new(),
        )
        .await;
        assert!(scores.is_empty());
    }

    #[test]
    fn state_carries_the_latest_task_and_the_trail() {
        let messages = vec![
            user("Fix the failing test."),
            assistant_call("Read"),
            user("Actually, add a feature instead."),
            assistant_call("Bash"),
        ];
        let state = relevance_state(&messages);
        assert!(state.contains("add a feature instead"));
        assert!(
            !state.contains("Fix the failing test"),
            "only the latest task"
        );
        assert!(state.contains("called Read"));
        assert!(state.contains("called Bash"));
    }
}
