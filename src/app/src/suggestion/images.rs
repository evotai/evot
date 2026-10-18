use std::collections::HashSet;

use evot_engine::Content;
use evot_engine::ImageSource;

use super::SuggestionHints;
use super::SuggestionImage;

const MAX_IMAGE_DATA: usize = 20 * 1024 * 1024 / 3 * 4 + 4;

pub(super) fn valid(hints: &SuggestionHints) -> bool {
    let draft = format!(
        "{}{}",
        hints.draft.as_deref().unwrap_or_default(),
        hints.suffix.as_deref().unwrap_or_default()
    );
    let mut ids = HashSet::new();
    hints.images.len() <= 16
        && hints.images.iter().all(|image| {
            !image.data.is_empty()
                && image.data.len() <= MAX_IMAGE_DATA
                && image.media_type.starts_with("image/")
                && draft.contains(&format!("[Image #{}]", image.id))
                && ids.insert(image.id)
        })
}

/// Decode/resize on the application's cancellable worker, not an async runtime
/// thread. Reuse the same size/format normalization as ordinary image input.
pub(super) async fn prepare(
    images: Vec<SuggestionImage>,
) -> crate::error::Result<Vec<SuggestionImage>> {
    crate::blocking::blocking_io("suggestion_images", move |cancel| {
        images
            .into_iter()
            .map(|image| {
                if cancel.is_cancelled() {
                    return Err(crate::blocking::cancelled("suggestion_images"));
                }
                let (data, media_type) = evot_engine::resize_image(&image.data, &image.media_type)
                    .map_err(|_| {
                        crate::error::EvotError::Run("Unable to decode suggestion image".into())
                    })?;
                Ok(SuggestionImage {
                    data,
                    media_type,
                    ..image
                })
            })
            .collect()
    })
    .await
}

pub(super) fn content(hints: &SuggestionHints) -> Option<Vec<Content>> {
    if !valid(hints) {
        return None;
    }
    Some(
        hints
            .images
            .iter()
            .flat_map(|image| {
                [
                    Content::Text {
                        text: format!("[Image #{}]", image.id),
                    },
                    Content::Image {
                        mime_type: image.media_type.clone(),
                        source: ImageSource::Base64 {
                            data: image.data.clone(),
                        },
                    },
                ]
            })
            .collect(),
    )
}
