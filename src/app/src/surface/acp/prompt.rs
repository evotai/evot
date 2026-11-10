//! ACP prompt content → evot input.

use agent_client_protocol_schema::v1 as acp;

/// Convert a `session/prompt` content array into evot input.
///
/// Text and resource links are baseline ACP content. Text resources are
/// accepted as quoted context even though `embeddedContext` is not advertised.
/// Media and binary resources are refused instead of being dropped silently.
pub(super) fn prompt_input(
    blocks: &[acp::ContentBlock],
) -> Result<Vec<evot_engine::Content>, acp::Error> {
    let mut input = Vec::with_capacity(blocks.len());
    for block in blocks {
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
            acp::ContentBlock::Image(_) => return Err(unsupported("image content")),
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

fn resource_link_text(link: &acp::ResourceLink) -> String {
    let title = link.title.as_deref().unwrap_or(&link.name);
    format!("[Resource: {title}]({})", link.uri)
}

fn unsupported(what: &str) -> acp::Error {
    acp::Error::invalid_params().data(serde_json::Value::from(format!(
        "evot ACP does not accept {what} in prompts"
    )))
}
