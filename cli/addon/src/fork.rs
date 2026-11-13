use std::collections::HashMap;
use std::sync::Arc;

use evot::api::ForkedAgent;
use evot::api::QueryRequest;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::convert::parse_content_blocks;
use crate::run::NapiRun;

// ---------------------------------------------------------------------------
// NapiForkedAgent — ephemeral readonly side conversation
// ---------------------------------------------------------------------------

#[napi]
pub struct NapiForkedAgent {
    inner: Arc<Mutex<ForkedAgent>>,
}

#[napi]
impl NapiForkedAgent {
    pub fn new(forked: ForkedAgent) -> Self {
        Self {
            inner: Arc::new(Mutex::new(forked)),
        }
    }

    /// Send a prompt to the forked agent. Returns a NapiRun.
    #[napi]
    pub async fn query(&self, prompt: String, content_json: Option<String>) -> Result<NapiRun> {
        let request = match content_json {
            Some(json) => {
                let input = parse_content_blocks(&json).map_err(Error::from_reason)?;
                if input.is_empty() {
                    return Err(Error::from_reason("empty content"));
                }
                QueryRequest::with_input(input)
            }
            None => QueryRequest::text(prompt),
        };
        let mut forked = self.inner.lock().await;
        let run = forked
            .query_input(request)
            .await
            .map_err(|e| Error::from_reason(format!("fork query: {e}")))?;
        let sid = run.session_id.clone();
        let handle = run.handle();
        // Forked agents are readonly — no host tools, use dummy channels.
        let (_host_tx, host_rx) = tokio_mpsc::channel::<String>(32);
        Ok(NapiRun {
            inner: Mutex::new(run),
            handle,
            cached_session_id: sid,
            abort_signal: CancellationToken::new(),
            host_event_rx: Mutex::new(Some(host_rx)),
            host_responders: Arc::new(std::sync::Mutex::new(HashMap::new())),
        })
    }
}
