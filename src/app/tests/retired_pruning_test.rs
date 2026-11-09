//! Retirement must not invalidate historical addon payloads or saved stats.
use evot::observability::TranscriptStats;
use evot::types::TranscriptItem;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LegacyPrunedStats {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    decided: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    applied: Option<LegacyApplyReport>,
    context_window: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LegacyApplyReport {
    removed: usize,
    truncated: usize,
    skipped: usize,
    before_tokens: usize,
    after_tokens: usize,
    before_messages: usize,
    after_messages: usize,
    trigger: LegacyTrigger,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum LegacyTrigger {
    RunEnd,
    Threshold,
    BeforeCompaction,
    Manual,
    Savings,
    ColdCache,
}

#[test]
fn historical_pruning_events_and_stats_round_trip_without_runtime_support() -> TestResult {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../../cli/tests/fixtures/contracts/run-payloads-rich.json"
    ))?;
    let mut covered = 0;
    for fixture in fixtures
        .iter()
        .filter(|value| value["kind"] == "context_pruned")
    {
        let event: evot::agent::RunEvent = serde_json::from_value(serde_json::json!({
            "event_id":"legacy", "run_id":"run", "session_id":"session", "turn":1,
            "created_at":"2026-01-01T00:00:00Z", "kind":"context_pruned",
            "payload":fixture["payload"]
        }))?;
        let written = serde_json::to_value(event)?;
        let legacy: LegacyPrunedStats = serde_json::from_value(written["payload"].clone())?;
        assert_eq!(serde_json::to_value(legacy)?, written["payload"]);

        // The same historical payload is valid in a transcript. Its stats stay
        // readable and writable even though no runtime can produce new ones.
        let item = TranscriptItem::Stats {
            kind: "context_pruned".into(),
            data: fixture["payload"].clone(),
        };
        let stats = TranscriptStats::try_from_item(&item).ok_or("historical stats rejected")?;
        let TranscriptItem::Stats { kind, data } = stats.to_item() else {
            return Err("expected stats".into());
        };
        assert_eq!(kind, "context_pruned");
        let legacy: LegacyPrunedStats = serde_json::from_value(data.clone())?;
        assert_eq!(serde_json::to_value(legacy)?, data);
        if let Some(original) = fixture["payload"].get("applied") {
            assert_eq!(data["applied"], *original);
        }
        covered += 1;
    }
    assert_eq!(covered, 3, "cover threshold and both legacy trigger shapes");
    Ok(())
}

#[test]
fn historical_prune_methods_and_phases_keep_their_wire_spelling() -> TestResult {
    #[derive(Deserialize, Serialize)]
    #[serde(rename_all = "snake_case")]
    enum LegacyMethod {
        Prune,
        Remote,
        Local,
        RemoteFailedLocal,
    }
    let method: evot_engine::CompactionMethod = serde_json::from_str("\"prune\"")?;
    let wire = serde_json::to_value(method)?;
    let legacy: LegacyMethod = serde_json::from_value(wire.clone())?;
    assert_eq!(serde_json::to_value(legacy)?, wire);
    let phase: evot_engine::CompactionPhase = serde_json::from_str("\"pruning\"")?;
    assert_eq!(serde_json::to_value(phase)?, "pruning");
    Ok(())
}
