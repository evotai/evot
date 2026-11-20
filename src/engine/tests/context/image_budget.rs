use evotengine::context::inline_image_bytes;
use evotengine::context::limit_inline_images;
use evotengine::context::DEFAULT_INLINE_IMAGE_MAX_BYTES;
use evotengine::types::*;

fn image(path: &str) -> Content {
    Content::Image {
        mime_type: "image/jpeg".into(),
        source: ImageSource::Path { path: path.into() },
    }
}

fn read_result(id: &str, path: &str) -> Message {
    Message::ToolResult {
        tool_call_id: id.into(),
        tool_name: "read".into(),
        content: vec![image(path)],
        is_error: false,
        timestamp: 0,
        retention: Retention::Normal,
    }
}

/// Paths of images still inline, oldest first.
fn kept_paths(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .flat_map(|message| match message {
            Message::User { content, .. } | Message::ToolResult { content, .. } => content.clone(),
            Message::Assistant { .. } => Vec::new(),
        })
        .filter_map(|block| match block {
            Content::Image {
                source: ImageSource::Path { path },
                ..
            } => Some(path),
            _ => None,
        })
        .collect()
}

fn notes(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .flat_map(|message| match message {
            Message::User { content, .. } | Message::ToolResult { content, .. } => content.clone(),
            Message::Assistant { .. } => Vec::new(),
        })
        .filter_map(|block| match block {
            Content::Text { text } if text.starts_with("[Image omitted") => Some(text),
            _ => None,
        })
        .collect()
}

#[test]
fn images_within_budget_are_unchanged() {
    let messages = vec![read_result("a", "1.jpg"), read_result("b", "2.jpg")];
    let limited = limit_inline_images(messages.clone(), 1_000, |_| 400);
    assert_eq!(limited, messages);
}

#[test]
fn oldest_images_are_replaced_once_the_budget_is_full() {
    // The failing session: 21 contact sheets of ~260 KB base64 each, 5.4 MB
    // in total, sent behind a gateway that rejects bodies above ~4-5 MB.
    let messages: Vec<Message> = (0..21)
        .map(|i| read_result(&format!("t{i}"), &format!("{i}.jpg")))
        .collect();
    let limited = limit_inline_images(messages, DEFAULT_INLINE_IMAGE_MAX_BYTES, |_| 260 * 1024);

    let kept = kept_paths(&limited);
    assert_eq!(kept.len(), 13);
    assert_eq!(kept.first().map(String::as_str), Some("8.jpg"));
    assert_eq!(kept.last().map(String::as_str), Some("20.jpg"));
    let notes = notes(&limited);
    assert_eq!(notes.len(), 8);
    assert!(notes[0].contains("0.jpg"), "{}", notes[0]);
    assert_eq!(limited.len(), 21, "messages and tool pairing stay intact");
}

#[test]
fn newest_image_is_kept_even_when_it_alone_exceeds_the_budget() {
    let messages = vec![read_result("a", "old.jpg"), read_result("b", "big.jpg")];
    let limited = limit_inline_images(messages, 1_000, |block| match block {
        Content::Image {
            source: ImageSource::Path { path },
            ..
        } if path == "big.jpg" => 5_000,
        _ => 100,
    });
    assert_eq!(kept_paths(&limited), vec!["big.jpg".to_string()]);
}

#[test]
fn a_large_image_ends_the_kept_suffix() {
    // Selection keeps a contiguous newest suffix: once an image does not fit,
    // smaller older images are dropped too, so the cut only moves forward.
    let messages = vec![
        read_result("a", "small-old.jpg"),
        read_result("b", "large.jpg"),
        read_result("c", "new.jpg"),
    ];
    let limited = limit_inline_images(messages, 1_000, |block| match block {
        Content::Image {
            source: ImageSource::Path { path },
            ..
        } if path == "large.jpg" => 950,
        _ => 100,
    });
    assert_eq!(kept_paths(&limited), vec!["new.jpg".to_string()]);
}

#[test]
fn user_attachments_count_and_text_is_preserved() {
    let messages = vec![
        Message::User {
            content: vec![
                Content::Text {
                    text: "look at these".into(),
                },
                Content::Image {
                    mime_type: "image/png".into(),
                    source: ImageSource::Base64 {
                        data: "A".repeat(800),
                    },
                },
            ],
            timestamp: 0,
            provenance: None,
        },
        read_result("a", "new.jpg"),
    ];
    let limited = limit_inline_images(messages, 1_000, |block| match block {
        Content::Image {
            source: ImageSource::Base64 { data },
            ..
        } => data.len(),
        _ => 400,
    });
    let Message::User { content, .. } = &limited[0] else {
        panic!("first message must stay a user message");
    };
    assert!(matches!(&content[0], Content::Text { text } if text == "look at these"));
    assert!(matches!(&content[1], Content::Text { text } if text.starts_with("[Image omitted")));
    assert_eq!(kept_paths(&limited), vec!["new.jpg".to_string()]);
}

#[test]
fn inline_image_bytes_measures_base64_size() -> Result<(), Box<dyn std::error::Error>> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("sheet.jpg");
    std::fs::write(&path, vec![0u8; 300])?;
    let path = path.to_string_lossy().to_string();

    assert_eq!(inline_image_bytes(&image(&path)), 400);
    assert_eq!(inline_image_bytes(&image("/definitely/missing.jpg")), 0);
    let base64 = Content::Image {
        mime_type: "image/png".into(),
        source: ImageSource::Base64 {
            data: "A".repeat(123),
        },
    };
    assert_eq!(inline_image_bytes(&base64), 123);
    assert_eq!(inline_image_bytes(&Content::Text { text: "x".into() }), 0);
    Ok(())
}
