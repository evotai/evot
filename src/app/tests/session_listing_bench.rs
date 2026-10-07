//! Opt-in, warm-cache benchmark. Fixture creation and validation are not timed.
//! Run: cargo test -p evot --release --test integration session_listing_bench -- --ignored --nocapture

use std::path::Path;
use std::time::Duration;
use std::time::Instant;

use evot::conf::StorageConfig;
use evot::storage::open_storage;
use evot::types::ListSessions;
use evot::types::SessionMeta;
use tempfile::TempDir;

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn apply_activity(session: &mut SessionMeta, metadata: std::fs::Metadata) {
    if let Ok(modified) = metadata.modified() {
        let modified = chrono::DateTime::<chrono::Utc>::from(modified);
        let saved = chrono::DateTime::parse_from_rfc3339(&session.updated_at)
            .ok()
            .map(|value| value.with_timezone(&chrono::Utc));
        if saved.is_none_or(|value| modified > value) {
            session.updated_at = modified.to_rfc3339();
        }
    }
}

fn finish(mut sessions: Vec<SessionMeta>, limit: usize) -> Vec<SessionMeta> {
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions.truncate(if limit == 0 { sessions.len() } else { limit });
    sessions
}

// Equivalent to the original per-operation async scan; retained as a baseline.
async fn per_operation_scan(
    root: &Path,
    limit: usize,
) -> Result<Vec<SessionMeta>, evot::error::EvotError> {
    let mut entries = tokio::fs::read_dir(root.join("sessions")).await?;
    let mut sessions = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        let dir = entry.path();
        let mut session: SessionMeta =
            serde_json::from_str(&tokio::fs::read_to_string(dir.join("session.json")).await?)?;
        if let Ok(metadata) = tokio::fs::metadata(dir.join("transcript.jsonl")).await {
            apply_activity(&mut session, metadata);
        }
        sessions.push(session);
    }
    Ok(finish(sessions, limit))
}

fn fixture(count: usize) -> Result<TempDir, Box<dyn std::error::Error>> {
    let root = TempDir::new()?;
    for index in 0..count {
        let id = format!("sess-{index:05}");
        let dir = root.path().join("sessions").join(&id);
        std::fs::create_dir_all(&dir)?;
        let mut session = SessionMeta::new(id, "/work".into(), "model".into());
        // Unique future timestamps make ordering deterministic regardless of directory order/mtime.
        session.updated_at = format!(
            "2099-01-01T{:02}:{:02}:{:02}Z",
            index / 3600,
            (index / 60) % 60,
            index % 60
        );
        std::fs::write(dir.join("session.json"), serde_json::to_vec(&session)?)?;
        // Half of the fixtures exercise metadata success, half NotFound.
        if index % 2 == 0 {
            std::fs::write(dir.join("transcript.jsonl"), b"[]\n")?;
        }
    }
    Ok(root)
}

fn percentiles(samples: &mut [Duration]) -> (f64, f64) {
    samples.sort();
    let millis = |index: usize| samples[index].as_secs_f64() * 1000.0;
    (
        millis(samples.len() / 2),
        millis((samples.len() * 95).div_ceil(100) - 1),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "manual release-mode filesystem benchmark"]
async fn session_listing_bench() -> TestResult {
    println!("warm-cache; 2 runtime workers; 3 warmups; 21 alternating samples; milliseconds");
    println!("count,limit,async_p50,async_p95,batch_p50,batch_p95,reduction_pct");
    for count in [100, 1_000, 10_000] {
        let root = fixture(count)?;
        let storage = open_storage(&StorageConfig::fs(root.path().to_path_buf()))?;
        for limit in [20, 0] {
            let expected = storage
                .list_sessions(ListSessions { limit, offset: 0 })
                .await?;
            assert_eq!(
                serde_json::to_value(&expected)?,
                serde_json::to_value(per_operation_scan(root.path(), limit).await?)?
            );
            for _ in 0..3 {
                per_operation_scan(root.path(), limit).await?;
                storage
                    .list_sessions(ListSessions { limit, offset: 0 })
                    .await?;
            }
            let mut old = Vec::new();
            let mut batch = Vec::new();
            for sample in 0..21 {
                for run_batch in [sample % 2 == 0, sample % 2 != 0] {
                    let start = Instant::now();
                    let sessions = if run_batch {
                        storage
                            .list_sessions(ListSessions { limit, offset: 0 })
                            .await?
                    } else {
                        per_operation_scan(root.path(), limit).await?
                    };
                    let elapsed = start.elapsed();
                    assert_eq!(sessions.len(), if limit == 0 { count } else { limit });
                    if run_batch {
                        batch.push(elapsed);
                    } else {
                        old.push(elapsed);
                    }
                }
            }
            let (old50, old95) = percentiles(&mut old);
            let (batch50, batch95) = percentiles(&mut batch);
            println!(
                "{count},{limit},{old50:.3},{old95:.3},{batch50:.3},{batch95:.3},{:.1}",
                (1.0 - batch50 / old50) * 100.0
            );
        }
    }
    Ok(())
}
