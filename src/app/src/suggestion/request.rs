use super::images::data_bytes;
use super::images::MAX_IMAGES;
use super::images::MAX_IMAGE_DATA;
use super::SuggestionRequest;

const MAX_CONTEXT_BYTES: usize = 100_000;
const TOO_LARGE: &str = "suggestion context too large";

/// Keep the legacy text/metadata budget independent of bounded inline images.
/// Only parsed image data is exempt; oversized prose and unknown fields still
/// count even when the request also carries valid attachments.
pub fn parse_request(json: &str) -> Result<SuggestionRequest, &'static str> {
    // Bound allocation before decoding, using the runtime's attachment limits.
    if json.len() > MAX_CONTEXT_BYTES + MAX_IMAGES * MAX_IMAGE_DATA {
        return Err(TOO_LARGE);
    }
    let request = serde_json::from_str(json).map_err(|_| "invalid suggestion context")?;
    let images = match &request {
        SuggestionRequest::Messages(_) => 0,
        SuggestionRequest::Detailed { hints, .. } => data_bytes(&hints.images).ok_or(TOO_LARGE)?,
    };
    if json.len().saturating_sub(images) > MAX_CONTEXT_BYTES {
        return Err(TOO_LARGE);
    }
    Ok(request)
}
