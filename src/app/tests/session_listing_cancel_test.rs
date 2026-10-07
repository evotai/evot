// Exercise the private synchronous worker without exposing a new public API.
#[path = "../src/storage/fs/session_listing.rs"]
mod listing;

use evot::error;
use evot::types;
use tokio_util::sync::CancellationToken;

#[test]
fn cancelled_session_listing_stops_before_filesystem_access(
) -> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::TempDir::new()?;
    let cancel = CancellationToken::new();
    cancel.cancel();
    // This path does not exist: an uncancelled scan would return an empty list.
    let result = listing::scan(
        &root.path().join("missing"),
        types::ListSessions::default(),
        &cancel,
    );
    match result {
        Err(error::EvotError::Store(message)) => assert_eq!(message, "session listing cancelled"),
        other => return Err(format!("expected cancellation, got {other:?}").into()),
    }
    Ok(())
}
