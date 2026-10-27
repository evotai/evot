use std::sync::Arc;
use std::sync::Mutex;

use evot::suggestion::SuggestionOutcome;
use evot::suggestion::SuggestionStatus;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::watch;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Additive API: legacy callers can still consume `result()` as one string.
#[napi(object)]
pub struct NapiSuggestionOutcome {
    pub candidates: Vec<String>,
    pub status: String,
}

/// A disposable side request, independent of the foreground Run event stream.
#[napi]
pub struct NapiSuggestion {
    handle: Mutex<Option<JoinHandle<SuggestionOutcome>>>,
    cancel: CancellationToken,
    progress: AsyncMutex<watch::Receiver<Vec<String>>>,
}

impl NapiSuggestion {
    pub fn start(
        request: evot::suggestion::SuggestionRequest,
        current: evot::conf::LlmConfig,
    ) -> Self {
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let (messages, hints) = request.into_parts();
        let (updates, progress) = watch::channel(Vec::new());
        let listener = Arc::new(move |candidates| {
            updates.send_replace(candidates);
        });
        let handle = tokio::spawn(evot::suggestion::generate(
            current,
            messages,
            hints,
            task_cancel,
            Some(listener),
        ));
        Self {
            handle: Mutex::new(Some(handle)),
            cancel,
            progress: AsyncMutex::new(progress),
        }
    }

    async fn take_outcome(&self) -> Result<SuggestionOutcome> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| Error::from_reason("suggestion task lock poisoned"))?
            .take();
        match handle {
            Some(handle) => match handle.await {
                Ok(outcome) => Ok(outcome),
                Err(_) => Ok(SuggestionOutcome::status(SuggestionStatus::Failed)),
            },
            None => Ok(SuggestionOutcome::default()),
        }
    }
}

impl Drop for NapiSuggestion {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

#[napi]
impl NapiSuggestion {
    /// Published legacy contract: the first candidate, or null.
    #[napi]
    pub async fn result(&self) -> Result<Option<String>> {
        Ok(self.take_outcome().await?.candidates.into_iter().next())
    }

    /// Consume all candidates and distinguish transport failure from silence.
    #[napi]
    pub async fn outcome(&self) -> Result<NapiSuggestionOutcome> {
        let outcome = self.take_outcome().await?;
        let status = match outcome.status {
            SuggestionStatus::Ready => "ready",
            SuggestionStatus::Empty => "empty",
            SuggestionStatus::Failed => "failed",
            SuggestionStatus::Unavailable => "unavailable",
            SuggestionStatus::TimedOut => "timed_out",
            SuggestionStatus::Unauthorized => "unauthorized",
        };
        Ok(NapiSuggestionOutcome {
            candidates: outcome.candidates,
            status: status.into(),
        })
    }

    /// Complete, validated candidates from the same request; never raw tokens.
    /// Optional for older clients, which can still await outcome()/result().
    #[napi]
    pub async fn next_candidates(&self) -> Result<Option<Vec<String>>> {
        let mut updates = self.progress.lock().await;
        if updates.changed().await.is_err() {
            return Ok(None);
        }
        let candidates = updates.borrow_and_update().clone();
        Ok(Some(candidates))
    }

    #[napi]
    pub fn abort(&self) {
        self.cancel.cancel();
    }
}
