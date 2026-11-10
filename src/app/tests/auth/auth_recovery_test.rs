use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;

use evot::auth::recovery::is_scoped_key_error;
use evot::auth::recovery::KeyRefresh;
use evot::auth::recovery::RecoveringProvider;
use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;
struct Provider {
    keys: Mutex<Vec<String>>,
    always_fail: bool,
    ordinary_key: bool,
}
#[async_trait::async_trait]
impl StreamProvider for Provider {
    async fn stream(
        &self,
        config: StreamConfig,
        _tx: mpsc::UnboundedSender<StreamEvent>,
        _cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.keys
            .lock()
            .map_err(|_| ProviderError::Other("lock".into()))?
            .push(config.api_key.clone());
        assert_eq!(config.model, "same-model");
        if self.ordinary_key {
            return Err(ProviderError::Auth("invalid API key".into()));
        }
        if self.always_fail || config.api_key == "old" {
            return Err(ProviderError::Auth(
                "HTTP 401: invalid_key: scoped key invalid or expired".into(),
            ));
        }
        Ok(StreamOutcome::complete(evot_engine::Message::user(
            "fixture",
        )))
    }
}
struct Refresh(AtomicUsize);
#[async_trait::async_trait]
impl KeyRefresh for Refresh {
    async fn refresh(
        &self,
        provider: &str,
        _config: &StreamConfig,
    ) -> Result<String, ProviderError> {
        assert_eq!(provider, "cloud");
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok("new".into())
    }
}
fn config() -> StreamConfig {
    StreamConfig {
        model: "same-model".into(),
        api_key: "old".into(),
        system_prompt: String::new(),
        messages: vec![],
        tools: vec![],
        thinking_level: evot_engine::ThinkingLevel::default(),
        max_tokens: None,
        model_config: None,
        cache_config: Default::default(),
        prompt_cache_key: None,
        client: None,
    }
}
#[tokio::test]
async fn refresh_retries_only_scoped_auth_once_and_keeps_selection() -> TestResult {
    for (always_fail, ordinary_key, expected) in
        [(false, false, 2), (true, false, 2), (false, true, 1)]
    {
        let inner = Arc::new(Provider {
            keys: Mutex::new(vec![]),
            always_fail,
            ordinary_key,
        });
        let refresh = Arc::new(Refresh(AtomicUsize::new(0)));
        let provider = RecoveringProvider::new(inner.clone(), "cloud".into(), refresh.clone());
        let (tx, _rx) = mpsc::unbounded_channel();
        let result = provider
            .stream(config(), tx, CancellationToken::new())
            .await;
        assert_eq!(result.is_ok(), !always_fail && !ordinary_key);
        assert_eq!(inner.keys.lock().map_err(|_| "lock")?.len(), expected);
        assert_eq!(refresh.0.load(Ordering::SeqCst), usize::from(!ordinary_key));
        if always_fail {
            assert!(!is_scoped_key_error(&result.err().ok_or("expected error")?));
        }
    }
    Ok(())
}
#[tokio::test]
async fn bounded_auth_recovery_uses_the_same_once_only_policy() -> TestResult {
    let inner = Arc::new(Provider {
        keys: Mutex::new(vec![]),
        always_fail: false,
        ordinary_key: false,
    });
    let refresh = Arc::new(Refresh(AtomicUsize::new(0)));
    let provider = RecoveringProvider::new(inner.clone(), "cloud".into(), refresh.clone());
    let (tx, _rx) = mpsc::channel(1);
    provider
        .stream_bounded(config(), tx, CancellationToken::new())
        .await?;
    assert_eq!(*inner.keys.lock().map_err(|_| "lock")?, vec!["old", "new"]);
    assert_eq!(refresh.0.load(Ordering::SeqCst), 1);
    Ok(())
}

struct WaitingRefresh(CancellationToken);
#[async_trait::async_trait]
impl KeyRefresh for WaitingRefresh {
    async fn refresh(
        &self,
        _provider: &str,
        _config: &StreamConfig,
    ) -> Result<String, ProviderError> {
        self.0.cancel();
        std::future::pending().await
    }
}
#[tokio::test]
async fn cancellation_during_refresh_does_not_start_retry() -> TestResult {
    let inner = Arc::new(Provider {
        keys: Mutex::new(vec![]),
        always_fail: false,
        ordinary_key: false,
    });
    let started = CancellationToken::new();
    let provider = RecoveringProvider::new(
        inner.clone(),
        "cloud".into(),
        Arc::new(WaitingRefresh(started.clone())),
    );
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let (tx, _rx) = mpsc::channel(1);
    let task = tokio::spawn(async move { provider.stream_bounded(config(), tx, cancel).await });
    tokio::time::timeout(std::time::Duration::from_secs(1), started.cancelled()).await?;
    trigger.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), task).await??;
    assert!(matches!(result, Err(ProviderError::Cancelled)));
    assert_eq!(inner.keys.lock().map_err(|_| "lock")?.len(), 1);
    Ok(())
}

#[test]
fn auth_classification_does_not_retry_generic_401_or_network_failure() {
    assert!(!is_scoped_key_error(&ProviderError::Auth(
        "HTTP 401: invalid_key".into()
    )));
    assert!(!is_scoped_key_error(&ProviderError::Network(
        "session_revoked".into()
    )));
    assert!(is_scoped_key_error(&ProviderError::Auth(
        "session_revoked".into()
    )));
}
