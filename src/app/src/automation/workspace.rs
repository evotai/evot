//! Local directories for one scheduled run. No paths are added to the cloud DTO.

use std::path::Path;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use super::model::Task;
use crate::agent::QueryRequest;
use crate::agent::ToolMode;
use crate::blocking::blocking_io;
use crate::error::EvotError;
use crate::error::Result;
use crate::sessions::SessionLocator;

/// Freeze the run's workspace and scratch before session creation. Run identity,
/// not the polling CLI's cwd or task name, owns these local directories.
pub async fn prepare_request(state_root: &Path, task: &Task, run_id: &str) -> Result<QueryRequest> {
    let session_id = SessionLocator::new("automation", &format!("run:{run_id}")).session_id();
    let session_dir = state_root.join("sessions").join(&session_id);
    let workspace_ref = task.workspace_ref.clone();
    let (cwd, scratch) = blocking_io("task workspace", move |cancel| {
        prepare_directories(&session_dir, &workspace_ref, cancel)
    })
    .await?;
    Ok(QueryRequest::text(&task.instruction)
        .session_id(Some(session_id))
        .mode(ToolMode::Headless)
        .source("automation")
        .cwd(cwd.to_string_lossy())
        .scratch_dir(scratch))
}

fn prepare_directories(
    session_dir: &Path,
    workspace_ref: &str,
    cancel: &CancellationToken,
) -> Result<(PathBuf, PathBuf)> {
    let check_cancel = || {
        if cancel.is_cancelled() {
            Err(crate::blocking::cancelled("task workspace"))
        } else {
            Ok(())
        }
    };
    check_cancel()?;
    let cwd = if workspace_ref.trim().is_empty() {
        let path = session_dir.join("workspace");
        std::fs::create_dir_all(&path)?;
        path
    } else {
        crate::conf::paths::expand_home_path(workspace_ref.trim())?
    };
    check_cancel()?;
    let cwd = std::fs::canonicalize(&cwd).map_err(|error| {
        EvotError::Conf(format!(
            "task workspace '{}' is not accessible: {error}",
            cwd.display()
        ))
    })?;
    if !cwd.is_dir() {
        return Err(EvotError::Conf(format!(
            "task workspace '{}' is not a directory",
            cwd.display()
        )));
    }
    check_cancel()?;
    let scratch = session_dir.join("scratch");
    std::fs::create_dir_all(&scratch)?;
    check_cancel()?;
    let scratch = std::fs::canonicalize(scratch)?;
    Ok((cwd, scratch))
}
