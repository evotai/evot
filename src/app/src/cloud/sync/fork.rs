//! A fork continues a transcript recorded somewhere else. Its history names
//! paths, tools and accounts of that environment; the model needs to be told
//! once that they may not apply here, or it keeps reusing them.

use evot_engine::InputProvenance;

use crate::types::TranscriptItem;
use crate::types::TranscriptUserContent;

/// Runtime input kind of the note appended to a forked transcript.
pub const FORK_NOTICE_KIND: &str = "session_import";

/// Where a fork's transcript came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForkSource {
    /// Someone's `/share` page: always recorded in another environment.
    Shared,
    /// The user's own cloud copy: foreign only if it ran in another workspace.
    Cloud,
}

impl ForkSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Shared => "shared copy",
            Self::Cloud => "cloud copy",
        }
    }
}

/// The model-facing note for a fork that now runs in `cwd`, or `None` when
/// nothing about the environment changed.
pub fn fork_notice(source: ForkSource, origin_cwd: &str, cwd: &str) -> Option<TranscriptItem> {
    let (origin, origin_short) = if origin_cwd.trim().is_empty() {
        ("another workspace".to_string(), "another workspace")
    } else {
        (format!("the workspace {origin_cwd}"), origin_cwd)
    };
    let (opening, display) = match source {
        ForkSource::Shared => (
            format!(
                "This conversation was imported from a shared session. It was recorded in \
                 another environment, in {origin}, and now continues on this machine in {cwd}."
            ),
            format!("Imported shared session · now working in {cwd}"),
        ),
        ForkSource::Cloud if origin_cwd == cwd => return None,
        ForkSource::Cloud => (
            format!(
                "This conversation is a copy of a session that ran in {origin}. It now \
                 continues in {cwd}."
            ),
            format!("Copied from {origin_short} · now working in {cwd}"),
        ),
    };
    let text = format!(
        "<system-reminder>\n\
         {opening}\n\
         The earlier messages describe that environment. Its paths, files, command output, \
         installed tools, logins and credentials may not exist here or may differ. \
         Work in {cwd}. Before reusing a path, tool, skill or account from the earlier \
         messages, check that it exists here. Take the next task from the user's next \
         message, and do not repeat earlier tool calls on your own.\n\
         </system-reminder>"
    );
    Some(TranscriptItem::User {
        content: vec![TranscriptUserContent::Text { text: text.clone() }],
        text,
        provenance: Some(InputProvenance::runtime(1, FORK_NOTICE_KIND, Some(display))),
    })
}
