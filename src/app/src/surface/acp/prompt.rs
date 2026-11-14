//! ACP prompt content → evot input.

use agent_client_protocol_schema::v1 as acp;
use evot_engine::Content;
use evot_engine::ImageSource;
use tokio_util::sync::CancellationToken;

use crate::base::blocking::blocking_io;
use crate::base::blocking::cancelled;

const IMAGE_WORKER: &str = "acp images";

/// Convert a `session/prompt` content array into evot input.
///
/// Text and resource links are baseline ACP content. Text resources are
/// accepted as quoted context even though `embeddedContext` is not advertised.
/// Images are advertised (`promptCapabilities.image`) and become user image
/// input, as pasted images do in the terminal UI. Audio and binary resources
/// are refused instead of being dropped silently. Image bytes are prepared
/// separately, after synchronous admission reserves the session in wire order.
pub(super) fn prompt_input(
    blocks: &[acp::ContentBlock],
) -> Result<Vec<evot_engine::Content>, acp::Error> {
    let mut input = Vec::with_capacity(blocks.len());
    for block in blocks {
        if let acp::ContentBlock::Image(image) = block {
            input.push(Content::Image {
                mime_type: image.mime_type.clone(),
                source: ImageSource::Base64 {
                    data: image.data.clone(),
                },
            });
            continue;
        }
        let text = match block {
            acp::ContentBlock::Text(text) => text.text.clone(),
            acp::ContentBlock::ResourceLink(link) => resource_link_text(link),
            acp::ContentBlock::Resource(resource) => match &resource.resource {
                acp::EmbeddedResourceResource::TextResourceContents(contents) => format!(
                    "<resource uri=\"{}\">\n{}\n</resource>",
                    contents.uri, contents.text
                ),
                _ => return Err(unsupported("binary embedded resources")),
            },
            acp::ContentBlock::Audio(_) => return Err(unsupported("audio content")),
            _ => return Err(unsupported("this content type")),
        };
        input.push(evot_engine::Content::Text { text });
    }
    if input.is_empty() {
        return Err(
            acp::Error::invalid_params().data(serde_json::Value::from("prompt must not be empty"))
        );
    }
    Ok(input)
}

/// Image decoding/resizing must not stall the connection's read loop. Dropping
/// this future (cancel/close/disconnect) cancels the worker between images.
pub(super) async fn prepare_input(input: Vec<Content>) -> Result<Vec<Content>, acp::Error> {
    if !input
        .iter()
        .any(|content| matches!(content, Content::Image { .. }))
    {
        return Ok(input);
    }
    blocking_io(IMAGE_WORKER, move |cancel| prepare_images(input, cancel))
        .await
        .map_err(acp::Error::into_internal_error)?
}

fn prepare_images(
    mut input: Vec<Content>,
    cancel: &CancellationToken,
) -> crate::base::error::Result<Result<Vec<Content>, acp::Error>> {
    for content in &mut input {
        if cancel.is_cancelled() {
            return Err(cancelled(IMAGE_WORKER));
        }
        if let Content::Image {
            source: ImageSource::Base64 { data },
            ..
        } = content
        {
            match image_input(data) {
                Ok(image) => *content = image,
                Err(error) => return Ok(Err(error)),
            }
        }
    }
    if cancel.is_cancelled() {
        return Err(cancelled(IMAGE_WORKER));
    }
    Ok(Ok(input))
}

/// Validate and bound image data like terminal attachments. The media type
/// comes from the bytes, never the client's declaration.
fn image_input(data: &str) -> Result<Content, acp::Error> {
    use base64::Engine;
    let data = data.trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| invalid("image data must be base64"))?;
    let mime_type = evot_engine::detect_image_mime_type(&bytes).ok_or_else(|| {
        invalid("image data is not a supported image (PNG, JPEG, GIF, WebP, BMP)")
    })?;
    let (data, mime_type) = evot_engine::resize_image(data, mime_type)
        .map_err(|_| invalid("image data could not be decoded or normalized"))?;
    Ok(evot_engine::Content::Image {
        mime_type,
        source: evot_engine::ImageSource::Base64 { data },
    })
}

fn resource_link_text(link: &acp::ResourceLink) -> String {
    let title = link.title.as_deref().unwrap_or(&link.name);
    format!("[Resource: {title}]({})", link.uri)
}

fn invalid(message: &str) -> acp::Error {
    acp::Error::invalid_params().data(serde_json::Value::from(message))
}

fn unsupported(what: &str) -> acp::Error {
    acp::Error::invalid_params().data(serde_json::Value::from(format!(
        "evot ACP does not accept {what} in prompts"
    )))
}
