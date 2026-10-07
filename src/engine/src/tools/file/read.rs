//! Read tool — read exact file contents.

use std::collections::HashMap;
use std::hash::Hash;
use std::hash::Hasher;
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use tokio::io::AsyncReadExt;

use crate::context::detect_image_mime_type;
use crate::context::IMAGE_SNIFF_BYTES;
use crate::types::*;

/// Max lines returned by a single Read call (matches industry standard).
const MAX_READ_LINES: usize = 2000;
/// Max bytes returned by a single Read call.
const MAX_READ_BYTES: usize = 50 * 1024; // 50KB
/// Label used in truncation notices; keep in sync with MAX_READ_BYTES.
const MAX_READ_BYTES_LABEL: &str = "50KB";
/// Largest integer that can be represented exactly by a JavaScript number.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// 20 MB limit for image files
const MAX_IMAGE_SIZE_BYTES: u64 = 20 * 1024 * 1024;

/// The first bytes of a file, enough to tell an image format from its header.
async fn read_header(path: &std::path::Path) -> Result<Vec<u8>, ToolError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| ToolError::Failed(format!("Cannot read {}: {}", path.display(), e)))?;
    let mut header = vec![0u8; IMAGE_SNIFF_BYTES];
    let mut filled = 0;
    while filled < header.len() {
        let n = file
            .read(&mut header[filled..])
            .await
            .map_err(|e| ToolError::Failed(format!("Cannot read {}: {}", path.display(), e)))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    header.truncate(filled);
    Ok(header)
}

fn optional_positive_usize(
    params: &serde_json::Value,
    name: &str,
) -> Result<Option<usize>, ToolError> {
    let Some(value) = params.get(name) else {
        return Ok(None);
    };

    let raw = if let Some(integer) = value.as_u64() {
        integer
    } else if let Some(number) = value.as_f64() {
        let is_integral = number.to_bits() == number.trunc().to_bits();
        if !number.is_finite() || !is_integral || !(1.0..=MAX_SAFE_INTEGER).contains(&number) {
            return Err(ToolError::InvalidArgs(format!(
                "'{name}' must be a positive integer"
            )));
        }
        number as u64
    } else {
        return Err(ToolError::InvalidArgs(format!(
            "'{name}' must be a positive integer"
        )));
    };

    if raw == 0 {
        return Err(ToolError::InvalidArgs(format!(
            "'{name}' must be a positive integer"
        )));
    }

    usize::try_from(raw)
        .map(Some)
        .map_err(|_| ToolError::InvalidArgs(format!("'{name}' is too large for this platform")))
}

/// Returned instead of file content when the same read would repeat an
/// earlier, still-current result. Saves re-sending large unchanged files.
pub const FILE_UNCHANGED_STUB: &str = "File unchanged since last read. The content from the \
     earlier read result in this conversation is still current — refer to that instead of \
     re-reading.";

/// Identity of one read request: canonical path plus the requested range.
type ReadKey = (PathBuf, Option<usize>, Option<usize>);

/// Read a file's contents. Supports line range for large files.
pub struct ReadFileTool {
    /// Max file size to read (prevents OOM)
    pub max_bytes: usize,
    /// Fingerprints of previously returned reads, keyed by [`ReadKey`]. A
    /// repeat read whose rendered output is byte-identical returns
    /// [`FILE_UNCHANGED_STUB`] instead of the full content.
    last_reads: Mutex<HashMap<ReadKey, u64>>,
}

impl Default for ReadFileTool {
    fn default() -> Self {
        Self {
            max_bytes: 1024 * 1024, // 1MB
            last_reads: Mutex::new(HashMap::new()),
        }
    }
}

impl ReadFileTool {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl AgentTool for ReadFileTool {
    fn name(&self) -> &str {
        "read"
    }

    fn name_aliases(&self) -> Vec<(String, String)> {
        vec![("claude".into(), "Read".into())]
    }

    fn label(&self) -> &str {
        "Read File"
    }

    fn description(&self) -> &str {
        "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). \
         Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB \
         (whichever is hit first). Use offset/limit for large files. When you need the full file, \
         continue with offset until complete."
    }

    fn prompt_snippet(&self) -> Option<&str> {
        Some("Read file contents")
    }

    fn prompt_guidelines(&self) -> Vec<&str> {
        vec!["Use read to examine files instead of cat or sed."]
    }

    fn prefer_over(&self) -> Option<(&str, &str)> {
        Some(("read or examine files", "cat, head, tail, or sed"))
    }

    fn parameter_aliases(&self) -> Option<crate::tools::validation::AliasMap> {
        Some(&[("path", &["file_path", "filePath", "file"] as &[&str])])
    }

    fn parameters_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to read (relative or absolute)"
                },
                "offset": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Line number to start reading from (1-indexed)"
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Maximum number of lines to read"
                }
            },
            "required": ["path"]
        })
    }

    fn preview_command(&self, params: &serde_json::Value) -> Option<String> {
        let path = params["path"].as_str()?;
        let offset = optional_positive_usize(params, "offset").ok()?;
        let limit = optional_positive_usize(params, "limit").ok()?;
        match (offset, limit) {
            (Some(off), Some(lim)) => {
                let end = off.saturating_add(lim).saturating_sub(1);
                Some(format!("sed -n '{},{}p' {}", off, end, path))
            }
            (Some(off), None) => Some(format!("sed -n '{},$p' {}", off, path)),
            (None, Some(lim)) => Some(format!("head -n {} {}", lim, path)),
            (None, None) => Some(format!("cat {}", path)),
        }
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: ToolContext,
    ) -> Result<ToolResult, ToolError> {
        let path_str = params["path"]
            .as_str()
            .ok_or_else(|| ToolError::InvalidArgs("missing 'path' parameter".into()))?;

        let path = ctx.path_guard.resolve_path(&ctx.cwd, path_str)?;

        if ctx.cancel.is_cancelled() {
            return Err(ToolError::Cancelled);
        }

        // Check file exists and size
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|e| ToolError::Failed(format!("Cannot access {}: {}", path.display(), e)))?;

        // An image is whatever the bytes say it is, never what the name says:
        // a `.png` that holds a JPEG must be sent as image/jpeg or the
        // provider rejects the request, and a `.txt` that holds a PNG is a
        // picture. Mirrors pi's read tool.
        let header = read_header(&path).await?;
        if let Some(mime_type) = detect_image_mime_type(&header) {
            if metadata.len() > MAX_IMAGE_SIZE_BYTES {
                return Err(ToolError::Failed(format!(
                    "Image too large ({}MB, max 20MB)",
                    metadata.len() / (1024 * 1024)
                )));
            }
            let meta = metadata;
            let mut content = vec![Content::Image {
                mime_type: mime_type.to_string(),
                source: ImageSource::Path {
                    path: path.to_string_lossy().to_string(),
                },
            }];
            // Text-only models never receive the image bytes (the request
            // builder drops them), so tell the model rather than letting it
            // assume it saw the picture. Mirrors pi's `getNonVisionImageNote`.
            if !ctx.supports_image {
                content.push(Content::Text {
                    text: "[Current model does not support image input. The image was omitted from this request.]"
                        .into(),
                });
            }
            return Ok(ToolResult {
                content,
                details: serde_json::json!({
                    "path": path_str,
                    "bytes": meta.len(),
                }),
                retention: Retention::Normal,
            });
        }

        // Text files: check size limit and apply line offset/limit. Parse
        // defensively here too because tools can be invoked directly without
        // passing through the agent loop's schema validation.
        let offset = optional_positive_usize(&params, "offset")?;
        let limit = optional_positive_usize(&params, "limit")?;

        if metadata.len() as usize > self.max_bytes {
            let Some(lim) = limit else {
                return Err(ToolError::Failed(format!(
                    "File too large ({} bytes, max {}). Use offset and limit for partial reads.",
                    metadata.len(),
                    self.max_bytes
                )));
            };
            let read_start = std::time::Instant::now();
            let result = self
                .read_lines_streaming(&path, path_str, offset.unwrap_or(1), lim)
                .await;
            if let Ok(ref res) = result {
                if ctx
                    .spill
                    .as_ref()
                    .is_some_and(|spill| spill.contains_path(&path))
                {
                    if let Some(progress) = &ctx.on_progress {
                        let actual_bytes = res
                            .content
                            .iter()
                            .map(|c| match c {
                                Content::Text { text } => text.len(),
                                _ => 0,
                            })
                            .sum::<usize>();
                        progress(
                            SpillProgress::read(
                                path.to_string_lossy(),
                                actual_bytes,
                                read_start.elapsed().as_millis() as u64,
                            )
                            .to_progress_text(),
                        );
                    }
                }
            }
            return result;
        }

        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| ToolError::Failed(format!("Cannot read {}: {}", path.display(), e)))?;

        let lines: Vec<&str> = content.lines().collect();
        let total = lines.len();
        let user_limited = limit.is_some();

        let (start, end) = match (offset, limit) {
            (Some(off), Some(lim)) => {
                let s = (off - 1).min(total);
                (s, (s + lim).min(total))
            }
            (Some(off), None) => {
                let s = (off - 1).min(total);
                (s, total)
            }
            (None, Some(lim)) => (0, lim.min(total)),
            (None, None) => (0, total),
        };

        let selected_lines = &lines[start..end];
        let (truncated_end, truncated_by) = truncate_selected(selected_lines, start, end, total);
        let shown = &lines[start..truncated_end];
        let mut output = shown.join("\n");

        let next_offset = truncated_end + 1;
        if let Some(reason_str) = truncated_by {
            output.push_str(&format!(
                "\n\n[Showing lines {}-{} of {} ({} limit). Use offset={} to continue.]",
                start + 1,
                truncated_end,
                total,
                reason_str,
                next_offset
            ));
        } else if user_limited && truncated_end < total {
            let remaining = total - truncated_end;
            output.push_str(&format!(
                "\n\n[{remaining} more lines in file. Use offset={next_offset} to continue.]"
            ));
        }

        // Unchanged repeat read: return a stub instead of re-sending content.
        let read_key = (path.clone(), offset, limit);
        let fingerprint = {
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            output.hash(&mut hasher);
            hasher.finish()
        };
        if let Ok(mut last_reads) = self.last_reads.lock() {
            if last_reads.get(&read_key) == Some(&fingerprint) {
                return Ok(ToolResult {
                    content: vec![Content::Text {
                        text: FILE_UNCHANGED_STUB.into(),
                    }],
                    details: serde_json::json!({
                        "path": path_str,
                        "unchanged": true,
                    }),
                    retention: Retention::Normal,
                });
            }
            last_reads.insert(read_key, fingerprint);
        }

        Ok(ToolResult {
            content: vec![Content::Text { text: output }],
            details: serde_json::json!({
                "path": path_str,
            }),
            retention: Retention::Normal,
        })
    }
}

impl ReadFileTool {
    /// Stream-read a large file by lines, only collecting the requested range.
    async fn read_lines_streaming(
        &self,
        path: &std::path::Path,
        path_str: &str,
        offset: usize,
        limit: usize,
    ) -> Result<ToolResult, ToolError> {
        use tokio::io::AsyncBufReadExt;
        use tokio::io::BufReader;

        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| ToolError::Failed(format!("Cannot read {}: {}", path.display(), e)))?;
        let reader = BufReader::new(file);
        let mut lines = reader.lines();

        let start = offset.saturating_sub(1);
        let end = start + limit;
        let mut collected: Vec<String> = Vec::with_capacity(limit);
        let mut line_num: usize = 0;

        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| ToolError::Failed(format!("Read error: {e}")))?
        {
            if line_num >= end {
                break;
            }
            if line_num >= start {
                collected.push(line);
            }
            line_num += 1;
        }

        let mut remaining = 0usize;
        if line_num >= end {
            while lines
                .next_line()
                .await
                .map_err(|e| ToolError::Failed(format!("Read error: {e}")))?
                .is_some()
            {
                remaining += 1;
            }
        }
        let mut output = collected.join("\n");
        if remaining > 0 {
            let next_offset = start + collected.len() + 1;
            output.push_str(&format!(
                "\n\n[{remaining} more lines in file. Use offset={next_offset} to continue.]"
            ));
        }

        Ok(ToolResult {
            content: vec![Content::Text { text: output }],
            details: serde_json::json!({ "path": path_str }),
            retention: Retention::Normal,
        })
    }
}

/// Determine how many lines to actually return, respecting MAX_READ_LINES and MAX_READ_BYTES.
/// Returns (actual_end_index, truncation_reason) where truncation_reason is None if not truncated.
fn truncate_selected(
    lines: &[&str],
    start: usize,
    _end: usize,
    _total: usize,
) -> (usize, Option<&'static str>) {
    let count = lines.len();

    // Check line limit first
    if count > MAX_READ_LINES {
        return (start + MAX_READ_LINES, Some("2000 line"));
    }

    // Check byte limit (use UTF-8 byte length for correct CJK handling)
    let mut byte_count = 0usize;
    for (i, line) in lines.iter().enumerate() {
        byte_count += line.len() + 1;
        if byte_count > MAX_READ_BYTES {
            let truncated_end = start + i;
            if truncated_end > start {
                return (truncated_end, Some(MAX_READ_BYTES_LABEL));
            }
            return (start + 1, Some(MAX_READ_BYTES_LABEL));
        }
    }

    (start + count, None)
}
