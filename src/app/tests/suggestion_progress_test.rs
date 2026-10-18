use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use evot::suggestion::sample_with_updates;
use evot::suggestion::SuggestionEndpoint;
use evot::suggestion::SuggestionHints;
use evot::suggestion::SuggestionListener;
use evot::suggestion::SuggestionMessage;
use evot::suggestion::SuggestionOutcome;
use evot::suggestion::SuggestionStatus;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use evot_engine::Content;
use evot_engine::Message;
use evot_engine::StopReason;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct TimedStream {
    chunks: Vec<String>,
    fail: bool,
}

#[async_trait]
impl StreamProvider for TimedStream {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        _: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        for delta in &self.chunks {
            tokio::time::sleep(Duration::from_millis(400)).await;
            tx.send(StreamEvent::TextDelta {
                content_index: 0,
                delta: delta.clone(),
            })
            .map_err(|_| ProviderError::Other("receiver closed".into()))?;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        if self.fail {
            return Err(ProviderError::Network("fixture failure".into()));
        }
        Ok(StreamOutcome::complete(Message::Assistant {
            content: vec![Content::Text {
                text: self.chunks.concat(),
            }],
            stop_reason: StopReason::Stop,
            model: config.model,
            provider: "fixture".into(),
            usage: Default::default(),
            timestamp: 0,
            error_message: None,
            response_id: None,
        }))
    }
}

fn spawn(
    chunks: &[&str],
    hints: SuggestionHints,
    fail: bool,
    cancel: CancellationToken,
) -> (
    tokio::task::JoinHandle<SuggestionOutcome>,
    mpsc::UnboundedReceiver<Vec<String>>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let listener: SuggestionListener = Arc::new(move |candidates| {
        let _ = tx.send(candidates);
    });
    let provider = Arc::new(TimedStream {
        chunks: chunks.iter().map(|text| (*text).into()).collect(),
        fail,
    });
    let task = tokio::spawn(async move {
        let endpoint = SuggestionEndpoint {
            model: "fixture".into(),
            protocol: "openai".into(),
            base_url: "https://invalid.example/v1".into(),
            api_key: "fixture".into(),
            context_window: 8192,
        };
        let messages = vec![
            SuggestionMessage {
                role: "user".into(),
                text: "Run the tests".into(),
            },
            SuggestionMessage {
                role: "assistant".into(),
                text: "Which suite?".into(),
            },
        ];
        sample_with_updates(
            &endpoint,
            &messages,
            &hints,
            provider,
            cancel,
            Some(listener),
        )
        .await
    });
    (task, rx)
}

fn rewrite() -> SuggestionHints {
    SuggestionHints {
        explicit: true,
        draft: Some("Run ".into()),
        suffix: Some("old suite".into()),
        ..Default::default()
    }
}

#[tokio::test(start_paused = true)]
async fn suggestion_progress_delivers_the_first_complete_candidate_before_the_batch_finishes(
) -> TestResult {
    let start = tokio::time::Instant::now();
    let (task, mut updates) = spawn(
        &["[\"first\",", "\"second\",", "\"third\"]"],
        rewrite(),
        false,
        CancellationToken::new(),
    );
    assert_eq!(updates.recv().await.ok_or("no first candidate")?, vec![
        "first"
    ]);
    assert_eq!(start.elapsed(), Duration::from_millis(400));
    assert!(!task.is_finished());
    assert_eq!(updates.recv().await.ok_or("no second candidate")?, vec![
        "first", "second"
    ]);
    assert_eq!(updates.recv().await.ok_or("no third candidate")?, vec![
        "first", "second", "third"
    ]);
    let result = task.await?;
    assert_eq!(result.status, SuggestionStatus::Ready);
    assert_eq!(start.elapsed(), Duration::from_millis(1600));
    assert_eq!(updates.recv().await, None);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn suggestion_progress_uses_json_decoding_not_partial_tokens_or_surrogate_halves(
) -> TestResult {
    let start = tokio::time::Instant::now();
    let (task, mut updates) = spawn(
        &[r#"["first\uD83D"#, r#"\uDE00","second"#, r#"\nline"]"#],
        rewrite(),
        false,
        CancellationToken::new(),
    );
    assert_eq!(updates.recv().await.ok_or("no complete string")?, vec![
        "first\u{1f600}"
    ]);
    assert_eq!(start.elapsed(), Duration::from_millis(800));
    assert_eq!(
        updates.recv().await.ok_or("no complete second string")?,
        vec!["first\u{1f600}", "second\nline"]
    );
    assert_eq!(task.await?.candidates, vec![
        "first\u{1f600}",
        "second\nline"
    ]);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn suggestion_progress_withdraws_candidates_after_failure_or_cancellation() -> TestResult {
    for failure in [true, false] {
        let cancel = CancellationToken::new();
        let (task, mut updates) = spawn(&["[\"first\","], rewrite(), failure, cancel.clone());
        assert_eq!(updates.recv().await.ok_or("no first candidate")?, vec![
            "first"
        ]);
        if !failure {
            cancel.cancel();
        }
        let result = task.await?;
        assert!(result.candidates.is_empty());
        assert_eq!(
            updates.recv().await.ok_or("missing withdrawal")?,
            Vec::<String>::new()
        );
        assert_eq!(updates.recv().await, None);
    }
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn suggestion_progress_filters_each_complete_candidate_before_publishing() -> TestResult {
    let (task, mut updates) = spawn(
        &[r#"["old suite","#, r#""good","bad\u001b"]"#],
        rewrite(),
        false,
        CancellationToken::new(),
    );
    assert_eq!(updates.recv().await.ok_or("no valid candidate")?, vec![
        "good"
    ]);
    assert_eq!(task.await?.candidates, vec!["good"]);
    assert_eq!(updates.recv().await, None);
    Ok(())
}

#[tokio::test(start_paused = true)]
async fn suggestion_progress_requires_whole_lines_for_legacy_output() -> TestResult {
    let (task, mut updates) = spawn(
        &["Run the", " tests\nReview", " the diff"],
        SuggestionHints::default(),
        false,
        CancellationToken::new(),
    );
    assert_eq!(updates.recv().await.ok_or("no full line")?, vec![
        "Run the tests"
    ]);
    assert!(!task.is_finished());
    assert_eq!(task.await?.candidates, vec![
        "Run the tests",
        "Review the diff"
    ]);
    assert_eq!(updates.recv().await.ok_or("no final line")?, vec![
        "Run the tests",
        "Review the diff"
    ]);
    Ok(())
}
