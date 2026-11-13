//! ACP prompt content → evot input.

use agent_client_protocol_schema::v1 as acp;

/// Convert a `session/prompt` content array into evot input.
///
/// Text and resource links are baseline ACP content. Text resources are
/// accepted as quoted context even though `embeddedContext` is not advertised.
/// Images are advertised (`promptCapabilities.image`) and become user image
/// input, as pasted images do in the terminal UI. Audio and binary resources
/// are refused instead of being dropped silently.
pub(super) fn prompt_input(
    blocks: &[acp::ContentBlock],
) -> Result<Vec<evot_engine::Content>, acp::Error> {
    let mut input = Vec::with_capacity(blocks.len());
    for block in blocks {
        if let acp::ContentBlock::Image(image) = block {
            input.push(image_input(image)?);
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

/// Validate an ACP image block and bound it like terminal attachments. The
/// media type comes from the bytes, not the client's declaration: a pasted
/// `.png` is often a JPEG, and providers reject a mismatched declaration.
fn image_input(image: &acp::ImageContent) -> Result<evot_engine::Content, acp::Error> {
    use base64::Engine;
    let data = image.data.trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| invalid("image data must be base64"))?;
    let mime_type = evot_engine::detect_image_mime_type(&bytes).ok_or_else(|| {
        invalid("image data is not a supported image (PNG, JPEG, GIF, WebP, BMP)")
    })?;
    let (data, mime_type) = match evot_engine::resize_image(data, mime_type) {
        Ok(resized) => resized,
        Err(error) => {
            tracing::warn!("acp: image resize failed, sending original: {error}");
            (data.to_string(), mime_type.to_string())
        }
    };
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
