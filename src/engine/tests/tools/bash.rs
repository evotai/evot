//! Tests for BashTool.

use std::sync::Arc;

use evotengine::tools::*;
use evotengine::types::*;
use tokio_util::sync::CancellationToken;

use super::ctx;
use super::ctx_with_cancel;

#[tokio::test]
async fn sandboxed_bash_preserves_workspace_and_scratch_environment(
) -> Result<(), Box<dyn std::error::Error>> {
    if let evotengine::SandboxSupport::Unavailable(reason) = evotengine::check_sandbox_available() {
        eprintln!("sandbox unavailable: {reason}");
        return Ok(());
    }
    let workspace = tempfile::tempdir()?;
    let scratch = tempfile::tempdir()?;
    let cwd = workspace.path().canonicalize()?;
    let scratch = scratch.path().canonicalize()?;
    let tool = BashTool::new()
        .with_envs([
            (
                "EVOT_SCRATCH_DIR".into(),
                scratch.to_string_lossy().into_owned(),
            ),
            ("TMPDIR".into(), scratch.to_string_lossy().into_owned()),
        ])
        .with_sandbox_dirs(vec![cwd.clone(), scratch.clone()]);
    let mut context = ctx("bash");
    context.cwd = cwd.clone();
    let result = tool.execute(serde_json::json!({
        "command": "set -eu; test \"$TMPDIR\" = \"$EVOT_SCRATCH_DIR\"; pwd -P; printf ok > \"$TMPDIR/result.txt\""
    }), context).await?;
    let text = result
        .content
        .iter()
        .filter_map(|content| match content {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains(cwd.to_string_lossy().as_ref()), "{text}");
    assert!(!text.contains("Exit code:"), "{text}");
    assert_eq!(std::fs::read_to_string(scratch.join("result.txt"))?, "ok");
    assert!(!cwd.join("result.txt").exists());
    Ok(())
}

#[tokio::test]
async fn test_bash_echo() {
    let tool = BashTool::new();
    let result = tool
        .execute(serde_json::json!({"command": "echo hello"}), ctx("bash"))
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("hello"));
    // Exit code: 0 is no longer emitted for successful commands
    assert!(!text.contains("Exit code:"));
}

#[tokio::test]
async fn test_bash_failure() {
    // Non-zero exit codes return Ok with exit code in output (for LLM self-correction)
    let tool = BashTool::new();
    let result = tool
        .execute(serde_json::json!({"command": "false"}), ctx("bash"))
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("Exit code: 1"));
}

#[tokio::test]
async fn test_bash_deny_pattern() {
    let tool = BashTool::new();
    let result = tool
        .execute(serde_json::json!({"command": "rm -rf /"}), ctx("bash"))
        .await;

    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("blocked"));
}

#[tokio::test]
async fn test_bash_timeout() {
    let tool = BashTool::new().with_timeout(std::time::Duration::from_millis(100));
    let result = tool
        .execute(serde_json::json!({"command": "sleep 10"}), ctx("bash"))
        .await;

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("timed out"));
}

#[tokio::test]
async fn test_bash_timeout_param_raises_ceiling() {
    // Default 200ms would kill a 1s command, but a requested 10s timeout
    // raises the ceiling so the command completes.
    let tool = BashTool::new().with_timeout(std::time::Duration::from_millis(200));
    let result = tool
        .execute(
            serde_json::json!({"command": "sleep 1; echo done", "timeout": 10}),
            ctx("bash"),
        )
        .await
        .expect("should succeed with raised timeout");
    let text = result
        .content
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<String>();
    assert!(text.contains("done"), "got: {text}");
}

#[tokio::test]
async fn test_bash_timeout_param_clamped_to_max() {
    // A huge requested timeout is clamped to max_timeout, so a never-ending
    // command still times out promptly rather than running for the requested
    // duration.
    let tool = BashTool::new()
        .with_timeout(std::time::Duration::from_millis(100))
        .with_max_timeout(std::time::Duration::from_millis(300));
    let start = std::time::Instant::now();
    let result = tool
        .execute(
            serde_json::json!({"command": "sleep 30", "timeout": 9999}),
            ctx("bash"),
        )
        .await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("timed out"));
    assert!(
        start.elapsed() < std::time::Duration::from_secs(5),
        "clamp ignored: ran {:?}",
        start.elapsed()
    );
}

#[tokio::test]
async fn test_bash_cancel() {
    let tool = BashTool::new();
    let cancel = CancellationToken::new();
    cancel.cancel();

    let result = tool
        .execute(
            serde_json::json!({"command": "echo should not run"}),
            ctx_with_cancel("bash", cancel),
        )
        .await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_bash_blocked_command() {
    let tool = BashTool::new();
    let result = tool
        .execute(serde_json::json!({"command": "rm -rf /"}), ctx("bash"))
        .await;
    assert!(result.is_err());
    assert!(result.unwrap_err().to_string().contains("blocked"));
}

// --- Bash streaming / cleanup tests ---

#[tokio::test]
async fn test_bash_timeout_includes_partial_output() {
    let tool = BashTool::new().with_timeout(std::time::Duration::from_millis(500));
    let result = tool
        .execute(
            serde_json::json!({"command": "echo before_timeout; sleep 10"}),
            ctx("bash"),
        )
        .await;

    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("timed out"));
    assert!(err.contains("before_timeout"));
}

#[tokio::test]
async fn test_bash_progress_emitted() {
    let progress_count = Arc::new(parking_lot::Mutex::new(0u32));
    let count_ref = progress_count.clone();

    let on_progress: Option<ProgressFn> = Some(Arc::new(move |_text: String| {
        *count_ref.lock() += 1;
    }));

    let cancel = CancellationToken::new();
    let tool_ctx = ToolContext {
        tool_call_id: "t1".into(),
        tool_name: "bash".into(),
        cancel,
        on_update: None,
        on_progress,
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        spill: None,
        supports_image: true,
    };

    // Command runs ~4s, progress fires every 3s, so we should get at least 1
    let tool = BashTool::new();
    let _result = tool
        .execute(
            serde_json::json!({"command": "for i in 1 2 3 4; do echo $i; sleep 1; done"}),
            tool_ctx,
        )
        .await;

    let count = *progress_count.lock();
    assert!(
        count >= 1,
        "Expected at least 1 progress callback, got {count}"
    );
}

#[tokio::test]
async fn test_bash_update_emitted() {
    let updates = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let updates_ref = updates.clone();

    let on_update: Option<ToolUpdateFn> = Some(Arc::new(move |partial: ToolResult| {
        if let Some(Content::Text { text }) = partial.content.first() {
            updates_ref.lock().push(text.clone());
        }
    }));

    let cancel = CancellationToken::new();
    let tool_ctx = ToolContext {
        tool_call_id: "t1".into(),
        tool_name: "bash".into(),
        cancel,
        on_update,
        on_progress: None,
        cwd: std::path::PathBuf::new(),
        path_guard: std::sync::Arc::new(evotengine::PathGuard::open()),
        spill: None,
        supports_image: true,
    };

    // Command runs ~4s with output, update fires every 2s.
    // Partial updates carry cumulative output so consumers can expand the
    // latest progress event into all output seen so far.
    let tool = BashTool::new();
    let _result = tool
        .execute(
            serde_json::json!({"command": "for i in 1 2 3 4; do echo line_$i; sleep 1; done"}),
            tool_ctx,
        )
        .await;

    let collected = updates.lock();
    assert!(
        !collected.is_empty(),
        "Expected at least 1 update callback with partial output"
    );
    assert!(
        collected.iter().any(|s| s.contains("line_1")),
        "Expected cumulative partial output to contain first line, got: {collected:?}"
    );
    assert!(
        collected.iter().any(|s| s.contains("line_2")),
        "Expected cumulative partial output to contain later lines, got: {collected:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn test_bash_timeout_no_hang() {
    // Verify that timeout + kill completes promptly, not hanging on zombie/pipe
    let start = std::time::Instant::now();
    let tool = BashTool::new().with_timeout(std::time::Duration::from_millis(200));
    let result = tool
        .execute(serde_json::json!({"command": "sleep 999"}), ctx("bash"))
        .await;

    assert!(result.is_err());
    let elapsed = start.elapsed();
    // Should complete well within 5 seconds (200ms timeout + kill + drain)
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "Bash timeout took too long: {elapsed:?}, expected < 5s"
    );
}

// --- Long line truncation tests ---

#[tokio::test]
async fn test_bash_long_line_truncated() {
    // A single line longer than 4096 bytes should be truncated
    let tool = BashTool::new();
    let long = "x".repeat(8000);
    let cmd = format!("printf '{long}'");
    let result = tool
        .execute(serde_json::json!({"command": cmd}), ctx("bash"))
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("bytes truncated"));
    // Should keep head and tail
    assert!(text.starts_with("xx"));
    assert!(text.ends_with("xx"));
    // Total output should be much smaller than 8000
    assert!(text.len() < 6000);
}

#[tokio::test]
async fn test_bash_short_line_not_truncated() {
    let tool = BashTool::new();
    let short = "y".repeat(100);
    let cmd = format!("printf '{short}'");
    let result = tool
        .execute(serde_json::json!({"command": cmd}), ctx("bash"))
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(!text.contains("bytes truncated"));
    assert!(text.contains(&short));
}

#[tokio::test]
async fn test_bash_multiline_only_long_lines_truncated() {
    // Mix of short and long lines — only the long one gets truncated
    let tool = BashTool::new();
    let long = "z".repeat(8000);
    let cmd = format!("echo short_line; printf '{long}'; echo; echo another_short");
    let result = tool
        .execute(serde_json::json!({"command": cmd}), ctx("bash"))
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("short_line"));
    assert!(text.contains("another_short"));
    assert!(text.contains("bytes truncated"));
}

#[tokio::test]
async fn test_bash_with_envs_injects_variables() {
    let tool = BashTool::new().with_envs(vec![
        ("MY_VAR".to_string(), "hello_from_env".to_string()),
        ("OTHER_VAR".to_string(), "other_value".to_string()),
    ]);
    let result = tool
        .execute(
            serde_json::json!({"command": "printf '%s %s' \"$MY_VAR\" \"$OTHER_VAR\""}),
            ctx("bash"),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("hello_from_env other_value"));
}

#[tokio::test]
async fn test_bash_empty_envs_works() {
    let tool = BashTool::new().with_envs(Vec::<(String, String)>::new());
    let result = tool
        .execute(serde_json::json!({"command": "echo ok"}), ctx("bash"))
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("ok"));
}

#[tokio::test]
async fn test_bash_timeout_multibyte_no_panic() {
    // Regression: tail_lines used to panic when the byte offset landed in the
    // middle of a multi-byte UTF-8 character (e.g. emoji / CJK).
    // We trigger the timeout path which calls tail_lines on the captured output.
    let tool = BashTool::new().with_timeout(std::time::Duration::from_millis(300));
    // Emit a large block of multi-byte chars so the tail_lines truncation offset
    // is likely to land inside a multi-byte sequence.
    let result = tool
        .execute(
            serde_json::json!({
                "command": "python3 -c \"print('🚀' * 2000)\"; sleep 10"
            }),
            ctx("bash"),
        )
        .await;

    // Should be a timeout error, NOT a panic
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("timed out"));
}

#[tokio::test]
async fn test_bash_without_envs_variable_is_empty() {
    let tool = BashTool::new();
    let result = tool
        .execute(
            serde_json::json!({"command": "printf '%s' \"$NONEXISTENT_VAR_12345\""}),
            ctx("bash"),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    // Variable not set, printf outputs empty string
    assert!(!text.contains("hello"));
}

fn ctx_with_spill(name: &str, dir: std::path::PathBuf) -> ToolContext {
    ToolContext {
        tool_call_id: "bash-cap".into(),
        tool_name: name.into(),
        cancel: CancellationToken::new(),
        on_update: None,
        on_progress: None,
        cwd: std::path::PathBuf::new(),
        path_guard: Arc::new(evotengine::PathGuard::open()),
        spill: Some(Arc::new(evotengine::spill::FsSpill::new(dir))),
        supports_image: true,
    }
}

#[tokio::test]
async fn test_bash_truncated_output_saved_to_file() {
    let dir = std::env::temp_dir().join(format!("evot-bash-cap-{}", std::process::id()));
    let tool = BashTool::new();
    // Emit > 2000 lines so the displayed output is tail-truncated.
    let result = tool
        .execute(
            serde_json::json!({"command": "seq 1 5000"}),
            ctx_with_spill("bash", dir.clone()),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("[Showing lines 3001-5000 of 5000. Full output:"));

    let path = result.details["full_output_path"]
        .as_str()
        .expect("full_output_path present");
    // Distinct key from the engine-level spill so the two can't collide.
    assert!(path.ends_with("-bash-output.txt"));
    let saved = std::fs::read_to_string(path).unwrap();
    // The full file must contain early output the tail-truncation dropped.
    assert!(saved.starts_with("1\n2\n3\n"));
    assert!(saved.contains("5000"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_bash_small_output_no_file() {
    let dir = std::env::temp_dir().join(format!("evot-bash-nocap-{}", std::process::id()));
    let tool = BashTool::new();
    let result = tool
        .execute(
            serde_json::json!({"command": "echo hello"}),
            ctx_with_spill("bash", dir.clone()),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(!text.contains("Full output"));
    assert!(result.details["full_output_path"].is_null());

    let _ = std::fs::remove_dir_all(&dir);
}

// The spill file must hold the complete output even when it far exceeds the
// in-memory tail cap.
#[tokio::test]
async fn test_bash_spill_complete_beyond_tail_cap() {
    let dir = std::env::temp_dir().join(format!("evot-bash-fullcap-{}", std::process::id()));
    let mut tool = BashTool::new();
    tool.max_output_bytes = 2048;
    let result = tool
        .execute(
            serde_json::json!({"command": "seq 1 5000"}),
            ctx_with_spill("bash", dir.clone()),
        )
        .await
        .unwrap();

    let path = result.details["full_output_path"]
        .as_str()
        .expect("spilled when truncated");
    let saved = std::fs::read_to_string(path).unwrap();
    assert!(
        saved.starts_with("1\n2\n3\n"),
        "spill lost head: {} bytes",
        saved.len()
    );
    assert!(saved.contains("4999\n5000"));

    let _ = std::fs::remove_dir_all(&dir);
}

// stdout and stderr are merged in arrival order in the spill file.
#[tokio::test]
async fn test_bash_stderr_merged_into_spill() {
    let dir = std::env::temp_dir().join(format!("evot-bash-merge-{}", std::process::id()));
    let tool = BashTool::new();
    let result = tool
        .execute(
            serde_json::json!({"command": "seq 1 2500; echo 'boom on stderr' >&2"}),
            ctx_with_spill("bash", dir.clone()),
        )
        .await
        .unwrap();

    let text = match &result.content[0] {
        Content::Text { text } => text,
        _ => panic!("expected text"),
    };
    assert!(text.contains("boom on stderr"));

    let path = result.details["full_output_path"]
        .as_str()
        .expect("spilled when truncated");
    let saved = std::fs::read_to_string(path).unwrap();
    assert!(saved.starts_with("1\n2\n3\n"));
    assert!(saved.contains("boom on stderr\n"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_preview_command_single_line_short() {
    let tool = BashTool::new();
    let params = serde_json::json!({"command": "echo hello"});
    assert_eq!(tool.preview_command(&params), Some("echo hello".into()));
}

#[test]
fn test_preview_command_multiline_shows_full() {
    let tool = BashTool::new();
    let params = serde_json::json!({"command": "echo hello\necho world\necho done"});
    let preview = tool.preview_command(&params).unwrap();
    assert_eq!(preview, "echo hello\necho world\necho done");
}

#[test]
fn test_preview_command_long_line_shows_full() {
    let tool = BashTool::new();
    let long = "x".repeat(200);
    let params = serde_json::json!({"command": long});
    let preview = tool.preview_command(&params).unwrap();
    assert_eq!(preview.len(), 200);
}

#[test]
fn test_preview_command_missing_command() {
    let tool = BashTool::new();
    let params = serde_json::json!({});
    assert_eq!(tool.preview_command(&params), None);
}
