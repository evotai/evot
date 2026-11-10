//! Tests for ReadFileTool.

use base64::Engine;
use evotengine::tools::*;
use evotengine::types::*;

use super::super::ctx;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn rejects_directories_before_reading_the_header() -> TestResult {
    let directory = tempfile::tempdir()?;
    let result = ReadFileTool::new()
        .execute(serde_json::json!({"path": directory.path()}), ctx("read"))
        .await;
    assert!(matches!(result, Err(ToolError::Failed(message))
        if message.contains("regular files only")));
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn reads_symlinks_to_regular_files() -> TestResult {
    let directory = tempfile::tempdir()?;
    let file = directory.path().join("actual.txt");
    let link = directory.path().join("linked.txt");
    std::fs::write(&file, "first\nsecond\nthird\n")?;
    std::os::unix::fs::symlink(&file, &link)?;
    let result = ReadFileTool::new()
        .execute(
            serde_json::json!({"path": link, "offset": 2, "limit": 1}),
            ctx("read"),
        )
        .await?;
    assert!(
        matches!(result.content.first(), Some(Content::Text { text })
        if text.starts_with("second") && !text.contains("first"))
    );
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn rejects_special_files_without_consuming_stdin() -> TestResult {
    use std::io::Read;
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;
    use std::process::Stdio;
    use std::time::Duration;

    const CHILD: &str = "EVOT_READ_SPECIAL_FILES_CHILD";
    const INPUT: &[u8] = b"keyboard input belongs to the TUI";
    if std::env::var_os(CHILD).is_none() {
        use tokio::io::AsyncWriteExt;
        // Never open the test runner's own stdin/TTY. A subprocess owns a
        // controlled pipe, and can be killed if a regression strands a
        // tokio blocking read (a future timeout alone cannot stop that read).
        let mut child = tokio::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "file::read::rejects_special_files_without_consuming_stdin",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdin = child.stdin.take().ok_or("missing child stdin")?;
        stdin.write_all(INPUT).await?;
        // Keep the write end open: accidental stdin reads must not see EOF
        // and appear harmless just because this is an automated test.
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(status) => {
                let status = status?;
                let output = child.wait_with_output().await?;
                assert!(
                    status.success(),
                    "{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Err(_) => {
                child.kill().await?;
                return Err("special-file read blocked instead of returning an error".into());
            }
        }
        return Ok(());
    }

    let directory = tempfile::tempdir()?;
    let fifo = directory.path().join("unconnected.fifo");
    let created = std::process::Command::new("mkfifo").arg(&fifo).output()?;
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );
    let fifo_link = directory.path().join("fifo-link");
    let stdin_link = directory.path().join("stdin-link");
    let device_link = directory.path().join("device-link");
    let directory_link = directory.path().join("directory-link");
    symlink(&fifo, &fifo_link)?;
    symlink("/dev/stdin", &stdin_link)?;
    symlink("/dev/zero", &device_link)?;
    symlink(directory.path(), &directory_link)?;
    let socket = directory.path().join("socket");
    let _listener = UnixListener::bind(&socket)?;
    let tool = ReadFileTool::new();
    for path in [
        std::path::Path::new("/dev/stdin"),
        std::path::Path::new("/dev/null"),
        std::path::Path::new("/dev/zero"),
        &fifo,
        &fifo_link,
        &stdin_link,
        &device_link,
        &directory_link,
        &socket,
    ] {
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            tool.execute(serde_json::json!({"path": path}), ctx("read")),
        )
        .await?;
        assert!(
            matches!(result, Err(ToolError::Failed(ref message))
            if message.contains("regular files only")),
            "{}: {result:?}",
            path.display()
        );
    }
    let mut untouched = vec![0u8; INPUT.len()];
    std::io::stdin().read_exact(&mut untouched)?;
    assert_eq!(
        untouched, INPUT,
        "Read must not steal the terminal's keystrokes"
    );
    Ok(())
}

#[tokio::test]
async fn test_read_file_with_offset_limit() {
    let tmp = std::env::temp_dir().join("yoagent-test-lines.txt");
    let path = tmp.to_str().unwrap();

    let content = (1..=20)
        .map(|i| format!("line {}", i))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&tmp, &content).unwrap();

    let tool = ReadFileTool::new();
    let result = tool
        .execute(
            serde_json::json!({"path": path, "offset": 5, "limit": 3}),
            ctx("read"),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("line 5"));
    assert!(text.contains("line 7"));
    assert!(!text.contains("line 8"));

    let _ = std::fs::remove_file(tmp);
}

#[tokio::test]
async fn test_read_file_with_integral_float_offset_limit() {
    let tmp = std::env::temp_dir().join("evot-test-float-read-range.txt");
    let path = tmp.to_str().unwrap();
    let content = (1..=2704)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&tmp, content).unwrap();

    let tool = ReadFileTool::new();
    let result = tool
        .execute(
            serde_json::json!({"path": path, "offset": 2000.0, "limit": 250.0}),
            ctx("read"),
        )
        .await
        .unwrap();
    let Content::Text { text } = &result.content[0] else {
        panic!("expected text");
    };

    assert!(text.contains("line 2000"));
    assert!(text.contains("line 2249"));
    assert!(!text.contains("line 1999"));
    assert!(!text.contains("line 2250"));
    assert!(text.contains("455 more lines in file. Use offset=2250 to continue."));

    let _ = std::fs::remove_file(tmp);
}

#[tokio::test]
async fn test_read_file_rejects_invalid_ranges() {
    let tmp = std::env::temp_dir().join("evot-test-invalid-read-range.txt");
    let path = tmp.to_str().unwrap();
    std::fs::write(&tmp, "one\ntwo\nthree").unwrap();
    let tool = ReadFileTool::new();

    for (label, params) in [
        (
            "zero offset",
            serde_json::json!({"path": path, "offset": 0}),
        ),
        (
            "negative offset",
            serde_json::json!({"path": path, "offset": -1}),
        ),
        ("zero limit", serde_json::json!({"path": path, "limit": 0})),
        (
            "fractional limit",
            serde_json::json!({"path": path, "limit": 1.5}),
        ),
    ] {
        let result = tool.execute(params, ctx("read")).await;
        assert!(
            matches!(result, Err(ToolError::InvalidArgs(_))),
            "{label} should be rejected, got {result:?}"
        );
    }

    let _ = std::fs::remove_file(tmp);
}

#[tokio::test]
async fn test_read_file_not_found() {
    let tool = ReadFileTool::new();
    let result = tool
        .execute(
            serde_json::json!({"path": "/nonexistent/file.txt"}),
            ctx("read"),
        )
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_read_file_line_numbers() {
    let tmp = std::env::temp_dir().join("yoagent-test-lineno2.txt");
    let path = tmp.to_str().unwrap();
    std::fs::write(&tmp, "first\nsecond\nthird\n").unwrap();
    let tool = ReadFileTool::new();
    let result = tool
        .execute(serde_json::json!({"path": path}), ctx("read"))
        .await
        .unwrap();
    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("first"));
    assert!(text.contains("second"));
    assert!(!text.contains("   1 |"));
    let _ = std::fs::remove_file(tmp);
}

// --- Image support tests ---

#[tokio::test]
async fn test_read_image_file() {
    // Minimal valid PNG (1x1 pixel, transparent)
    let png_bytes: Vec<u8> = vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, // 8-bit RGB
        0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, // IDAT chunk
        0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
        0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND chunk
        0xAE, 0x42, 0x60, 0x82,
    ];

    let tmp = std::env::temp_dir().join("yoagent-test-image.png");
    std::fs::write(&tmp, &png_bytes).unwrap();

    let tool = ReadFileTool::new();
    let result = tool
        .execute(
            serde_json::json!({"path": tmp.to_str().unwrap()}),
            ctx("read"),
        )
        .await
        .unwrap();

    match &result.content[0] {
        Content::Image { mime_type, source } => {
            assert_eq!(mime_type, "image/png");
            assert!(
                matches!(source, evotengine::ImageSource::Path { path } if path == tmp.to_string_lossy().as_ref()),
                "source path should be set"
            );
            // Verify resolve_image_data loads from disk
            let (resolved_data, resolved_mime) = result.content[0]
                .resolve_image_data()
                .expect("resolve should succeed");
            assert_eq!(resolved_mime, "image/png");
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(&resolved_data)
                .unwrap();
            assert_eq!(decoded, png_bytes);
        }
        _ => panic!("expected Content::Image"),
    }

    let _ = std::fs::remove_file(tmp);
}

/// What a file is comes from its bytes, never from its name. A `.png` that
/// holds a JPEG (what chat downloads often are) is sent as image/jpeg, since
/// Anthropic rejects a request whose media type disagrees with the data; a
/// `.jpg` holding text is text, not a broken picture.
#[tokio::test]
async fn test_read_image_media_type_follows_bytes_not_extension() {
    async fn read(name: &str, bytes: &[u8]) -> Vec<Content> {
        let tmp = std::env::temp_dir().join(name);
        std::fs::write(&tmp, bytes).unwrap();
        let result = ReadFileTool::new()
            .execute(
                serde_json::json!({"path": tmp.to_str().unwrap()}),
                ctx("read"),
            )
            .await
            .unwrap();
        let _ = std::fs::remove_file(tmp);
        result.content
    }
    fn mime(content: &[Content]) -> Option<&str> {
        match &content[0] {
            Content::Image { mime_type, .. } => Some(mime_type),
            _ => None,
        }
    }

    let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    jpeg.extend_from_slice(b"JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00");
    assert_eq!(
        mime(&read("yoagent-really-jpeg.png", &jpeg).await),
        Some("image/jpeg")
    );
    assert_eq!(
        mime(
            &read(
                "yoagent-really-png.jpg",
                b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01"
            )
            .await
        ),
        Some("image/png")
    );
    assert_eq!(
        mime(&read("yoagent-unnamed-image", &jpeg).await),
        Some("image/jpeg")
    );
    match &read("yoagent-text.jpg", b"fake-jpeg-data").await[0] {
        Content::Text { text } => assert!(text.contains("fake-jpeg-data"), "{text}"),
        other => panic!("a .jpg holding text is text, got {other:?}"),
    }
}

#[tokio::test]
async fn test_read_text_file_unchanged() {
    // Non-image files should still return Content::Text
    let tmp = std::env::temp_dir().join("yoagent-test-notimage.txt");
    std::fs::write(&tmp, "just text").unwrap();

    let tool = ReadFileTool::new();
    let result = tool
        .execute(
            serde_json::json!({"path": tmp.to_str().unwrap()}),
            ctx("read"),
        )
        .await
        .unwrap();

    match &result.content[0] {
        Content::Text { text } => {
            assert!(text.contains("just text"));
        }
        _ => panic!("expected Content::Text for .txt file"),
    }

    let _ = std::fs::remove_file(tmp);
}

#[tokio::test]
async fn test_repeat_read_of_unchanged_file_returns_stub() {
    let tmp = std::env::temp_dir().join("yoagent-test-unchanged-stub.txt");
    let path = tmp.to_str().unwrap();
    std::fs::write(&tmp, "alpha\nbeta\n").unwrap();

    let tool = ReadFileTool::new();
    let first = tool
        .execute(serde_json::json!({"path": path}), ctx("read"))
        .await
        .unwrap();
    let Content::Text { text } = &first.content[0] else {
        panic!("expected text");
    };
    assert!(text.contains("alpha"));

    // Same read again, file untouched: stub instead of content.
    let second = tool
        .execute(serde_json::json!({"path": path}), ctx("read"))
        .await
        .unwrap();
    let Content::Text { text } = &second.content[0] else {
        panic!("expected text");
    };
    assert_eq!(text, FILE_UNCHANGED_STUB);
    assert_eq!(second.details["unchanged"], true);

    let _ = std::fs::remove_file(tmp);
}

#[tokio::test]
async fn test_repeat_read_after_modification_returns_content() {
    let tmp = std::env::temp_dir().join("yoagent-test-unchanged-modified.txt");
    let path = tmp.to_str().unwrap();
    std::fs::write(&tmp, "before\n").unwrap();

    let tool = ReadFileTool::new();
    tool.execute(serde_json::json!({"path": path}), ctx("read"))
        .await
        .unwrap();

    std::fs::write(&tmp, "after\n").unwrap();
    let result = tool
        .execute(serde_json::json!({"path": path}), ctx("read"))
        .await
        .unwrap();
    let Content::Text { text } = &result.content[0] else {
        panic!("expected text");
    };
    assert!(text.contains("after"));
    assert_ne!(text, FILE_UNCHANGED_STUB);

    let _ = std::fs::remove_file(tmp);
}

#[tokio::test]
async fn test_repeat_read_with_different_range_returns_content() {
    let tmp = std::env::temp_dir().join("yoagent-test-unchanged-range.txt");
    let path = tmp.to_str().unwrap();
    let content = (1..=10)
        .map(|i| format!("line {}", i))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&tmp, &content).unwrap();

    let tool = ReadFileTool::new();
    tool.execute(serde_json::json!({"path": path}), ctx("read"))
        .await
        .unwrap();

    // Different offset/limit is a different request: full content, no stub.
    let ranged = tool
        .execute(
            serde_json::json!({"path": path, "offset": 2, "limit": 3}),
            ctx("read"),
        )
        .await
        .unwrap();
    let Content::Text { text } = &ranged.content[0] else {
        panic!("expected text");
    };
    assert!(text.contains("line 2"));
    assert_ne!(text, FILE_UNCHANGED_STUB);

    let _ = std::fs::remove_file(tmp);
}
