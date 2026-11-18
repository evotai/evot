//! [`MaskingProvider`]: the LLM boundary. It wraps any provider, masks the
//! request before the inner provider sees it, and restores the reply (and
//! every streamed delta) before the agent does. The provider, and so the
//! vendor, only ever has placeholders.
use std::sync::Arc;

use evot_engine::provider::ProviderError;
use evot_engine::provider::StreamConfig;
use evot_engine::provider::StreamEvent;
use evot_engine::provider::StreamOutcome;
use evot_engine::provider::StreamProvider;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::masker::Masker;
use super::notice::blocked_message;
use super::notice::unavailable_message;
use super::record::Target;
use super::service;
use crate::base::blocking::blocking_io;
use crate::base::error::EvotError;

/// Wrap `inner` with masking under the user's current settings.
pub fn wrap(inner: Arc<dyn StreamProvider>) -> Arc<dyn StreamProvider> {
    Arc::new(MaskingProvider {
        inner,
        masker: None,
        diagnostics: false,
    })
}

pub(crate) fn wrap_for_run(inner: Arc<dyn StreamProvider>) -> Arc<dyn StreamProvider> {
    Arc::new(MaskingProvider {
        inner,
        masker: None,
        diagnostics: true,
    })
}

pub struct MaskingProvider {
    inner: Arc<dyn StreamProvider>,
    /// Fixed masker; `None` follows the settings file.
    masker: Option<Arc<Masker>>,
    diagnostics: bool,
}

impl MaskingProvider {
    pub fn with_masker(inner: Arc<dyn StreamProvider>, masker: Arc<Masker>) -> Self {
        Self {
            inner,
            masker: Some(masker),
            diagnostics: false,
        }
    }

    async fn run(
        &self,
        config: StreamConfig,
        out: Out,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        let masker = match &self.masker {
            Some(masker) => masker.clone(),
            None => service::current_masker().await.map_err(unavailable)?,
        };
        if !masker.enabled() {
            return match out {
                Out::Bounded(tx) => self.inner.stream_bounded(config, tx, cancel).await,
                Out::Unbounded(tx) => self.inner.stream(config, tx, cancel).await,
            };
        }
        let worker = masker.clone();
        let (config, report) = blocking_io("privacy mask", move |_| {
            let mut config = config;
            let report = worker.mask_request(&mut config)?;
            Ok((config, report))
        })
        .await
        .map_err(unavailable)?;
        if !report.is_empty() {
            let mut record = report.record(Target::Llm);
            record.session = config.prompt_cache_key.clone();
            record.provider = config
                .model_config
                .as_ref()
                .map(|model| model.provider().to_string());
            record.model = Some(config.model.clone());
            let kinds = record.blocked_kinds();
            let findings = report.live_findings();
            if self.diagnostics && !report.blocked() {
                service::keep_audit(&masker, record).await;
                if !findings.is_empty() {
                    if let Ok(data) = serde_json::to_value(findings) {
                        let _ = out
                            .send(StreamEvent::Diagnostic {
                                kind: super::record::CARD_KIND.into(),
                                data,
                            })
                            .await;
                    }
                }
            } else {
                service::keep(&masker, record, findings).await;
            }
            if report.blocked() {
                return Err(ProviderError::InvalidRequest(blocked_message(
                    Target::Llm,
                    &kinds,
                )));
            }
        }

        let (inner_tx, mut inner_rx) = mpsc::channel(64);
        let produce = self.inner.stream_bounded(config, inner_tx, cancel);
        let restoring = masker.clone();
        let forward = async move {
            let mut restorer = restoring.restorer();
            while let Some(event) = inner_rx.recv().await {
                for event in restorer.push(event) {
                    if !out.send(event).await {
                        return;
                    }
                }
            }
            for event in restorer.flush() {
                if !out.send(event).await {
                    return;
                }
            }
        };
        let (result, ()) = tokio::join!(produce, forward);
        let outcome = result?;
        let served = outcome.served_model().map(str::to_string);
        let mut message = outcome.into_message();
        masker.restore_message(&mut message);
        Ok(StreamOutcome::complete(message).served_by(served))
    }
}

fn unavailable(error: EvotError) -> ProviderError {
    ProviderError::InvalidRequest(unavailable_message(error))
}

enum Out {
    Bounded(mpsc::Sender<StreamEvent>),
    Unbounded(mpsc::UnboundedSender<StreamEvent>),
}

impl Out {
    async fn send(&self, event: StreamEvent) -> bool {
        match self {
            Self::Bounded(tx) => tx.send(event).await.is_ok(),
            Self::Unbounded(tx) => tx.send(event).is_ok(),
        }
    }
}

#[async_trait::async_trait]
impl StreamProvider for MaskingProvider {
    async fn stream_bounded(
        &self,
        config: StreamConfig,
        tx: mpsc::Sender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.run(config, Out::Bounded(tx), cancel).await
    }

    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<StreamOutcome, ProviderError> {
        self.run(config, Out::Unbounded(tx), cancel).await
    }
}
