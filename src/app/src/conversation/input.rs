//! Authored input and runtime context share a provider role, not a UI identity.
//! Producers record provenance here before appending any host context. Readers
//! project it structurally; they never infer source from reminder wording.
use evot_engine::Content;
use evot_engine::InputProvenance;
use evot_engine::InputSource;

use crate::types::TranscriptItem;
use crate::types::TranscriptUserContent;

pub struct PreparedInput {
    content: Vec<Content>,
    sources: Vec<InputSource>,
}

impl PreparedInput {
    pub fn user(content: Vec<Content>) -> Self {
        Self {
            sources: vec![InputSource::User; content.len()],
            content,
        }
    }

    pub fn runtime(&mut self, text: String, kind: &str, display: Option<String>) {
        self.content.push(Content::Text { text });
        self.sources.push(InputSource::Runtime {
            kind: kind.into(),
            display,
        });
    }

    pub fn finish(self) -> (Vec<Content>, Option<InputProvenance>) {
        let (content, sources): (Vec<_>, Vec<_>) = self
            .content
            .into_iter()
            .zip(self.sources)
            .filter(
                |(content, _)| !matches!(content, Content::Text { text } if text.trim().is_empty()),
            )
            .unzip();
        let provenance = Some(InputProvenance::new(sources));
        (content, provenance)
    }
}

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DisplayInputPart {
    User { text: String },
    Legacy { text: String },
    Notice { text: String },
}

/// Additive transport view: legacy text/content stay byte-for-byte intact.
#[derive(serde::Serialize)]
pub struct TranscriptView<'a> {
    #[serde(flatten)]
    item: &'a TranscriptItem,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_parts: Option<Vec<DisplayInputPart>>,
}

pub fn transcript_views(items: &[TranscriptItem]) -> Vec<TranscriptView<'_>> {
    items
        .iter()
        .map(|item| TranscriptView {
            item,
            display_parts: matches!(item, TranscriptItem::User { .. }).then(|| display_parts(item)),
        })
        .collect()
}

pub fn display_parts(item: &TranscriptItem) -> Vec<DisplayInputPart> {
    let explicit_source = matches!(item, TranscriptItem::User { provenance: Some(provenance), .. }
        if provenance.schema_version == evot_engine::types::INPUT_SCHEMA_VERSION);
    let parts = input_parts(item)
        .into_iter()
        .filter_map(|part| match part.source {
            InputSource::Runtime { display, .. } => {
                display.map(|text| DisplayInputPart::Notice { text })
            }
            InputSource::User if !explicit_source => {
                Some(DisplayInputPart::Legacy { text: part.text })
            }
            InputSource::User => {
                if crate::command::parse_command_prompt(&part.text).is_some() {
                    return crate::command::user_facing_text(&part.text).map(|text| {
                        DisplayInputPart::User {
                            text: text.into_owned(),
                        }
                    });
                }
                Some(DisplayInputPart::User { text: part.text })
            }
        });
    let mut result: Vec<DisplayInputPart> = Vec::new();
    for part in parts {
        match (result.last_mut(), &part) {
            (Some(DisplayInputPart::User { text: previous }), DisplayInputPart::User { text })
            | (
                Some(DisplayInputPart::Legacy { text: previous }),
                DisplayInputPart::Legacy { text },
            ) => {
                previous.push('\n');
                previous.push_str(text);
            }
            _ => result.push(part),
        }
    }
    result
}

pub struct InputPart {
    pub source: InputSource,
    pub text: String,
}

/// No changes to stored text/content: projection metadata is independent of
/// model context. Missing provenance uses the isolated legacy protocol adapter.
pub fn input_parts(item: &TranscriptItem) -> Vec<InputPart> {
    let TranscriptItem::User {
        text,
        content,
        provenance,
    } = item
    else {
        return Vec::new();
    };
    let Some(provenance) = provenance
        .as_ref()
        .filter(|provenance| provenance.schema_version == evot_engine::types::INPUT_SCHEMA_VERSION)
    else {
        return super::legacy_input::parts(text);
    };
    if provenance.sources.len() != content.len() {
        return vec![InputPart {
            source: InputSource::User,
            text: text.clone(),
        }];
    }
    content
        .iter()
        .zip(&provenance.sources)
        .filter_map(|(block, source)| {
            let TranscriptUserContent::Text { text } = block else {
                return None;
            };
            Some(InputPart {
                source: source.clone(),
                text: text.clone(),
            })
        })
        .collect()
}

pub fn authored_text(item: &TranscriptItem) -> Option<String> {
    let text = display_parts(item)
        .into_iter()
        .filter_map(|part| match part {
            DisplayInputPart::User { text } => Some(text),
            DisplayInputPart::Legacy { text } => {
                crate::command::user_facing_text(&text).map(|text| text.into_owned())
            }
            DisplayInputPart::Notice { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then_some(text)
}
