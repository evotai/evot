//! Resolving a `provider:model` spec that was written by an earlier run.
//!
//! Sessions and scheduled tasks persist the model they run on. The catalog
//! underneath changes over time: a model moves between tiers, or the server
//! renames how it groups its providers. The stable identity is the model
//! id; the provider part is only where that id was served at save time.
//!
//! [`Config::resolve_model_spec`] stays strict so an interactive `--model`
//! still reports a typo. Anything read back from storage comes through here.

use super::Config;
use crate::base::error::EvotError;
use crate::base::error::Result;

impl Config {
    /// Resolve a persisted spec into a `(provider, model)` pair this config
    /// serves right now.
    ///
    /// The spec is honoured as written when it still resolves. Otherwise the
    /// model id is followed to whichever configured provider explicitly lists
    /// it; a BYOK provider that accepts arbitrary ids is never picked that way.
    pub fn resolve_persisted_model_spec(&self, spec: &str) -> Result<(String, String)> {
        let (saved, model) = spec.split_once(':').unwrap_or(("", spec));
        if self.serves(saved, model) {
            return Ok((saved.to_string(), model.to_string()));
        }
        if let Some(provider) = self.provider_listing_model(model, saved) {
            tracing::info!(%spec, %provider, "persisted model now served elsewhere");
            return Ok((provider, model.to_string()));
        }
        Err(EvotError::Conf(format!(
            "model '{model}' is not served by any configured provider (saved as '{spec}')"
        )))
    }
}
